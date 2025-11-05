import {
	type Client,
	createClient,
	type InArgs,
	type Row,
	type Transaction,
} from "@libsql/client";
import logger from "./logger";

type SchemaType = "table" | "index";

const SQLITE_SEQUENCE = "sqlite_sequence";

export async function migrate(
	db: Client,
	schema: string,
	allowDeletions = false,
): Promise<boolean> {
	const migrator = new Migrator(db, schema, allowDeletions);
	await migrator.migrate();
	return migrator.nChanges > 0;
}

export class Migrator {
	public readonly db: Client;
	public readonly schema: string;
	public readonly allowDeletions: boolean;
	public nChanges = 0;

	private readonly pristine = createClient({ url: ":memory:" });
	private pristineInitialised = false;
	private transaction: Transaction | null = null;
	private origForeignKeys: number | null = null;

	constructor(db: Client, schema: string, allowDeletions = false) {
		this.db = db;
		this.schema = schema;
		this.allowDeletions = allowDeletions;
	}

	async migrate(): Promise<void> {
		await this.ensurePristine();
		await this.begin();

		let success = false;
		try {
			await this.performMigration();
			await this.commit();
			success = true;
		} catch (error) {
			await this.rollback();
			await this.onError();
			throw error;
		} finally {
			this.transaction?.close();
			this.transaction = null;
			if (success) {
				await this.afterCommit();
			}
			this.pristine.close();
		}
	}

	private async ensurePristine(): Promise<void> {
		if (this.pristineInitialised) return;
		if (!this.schema.trim()) {
			this.pristineInitialised = true;
			return;
		}
		await this.pristine.executeMultiple(this.schema);
		this.pristineInitialised = true;
	}

	private async begin(): Promise<void> {
		this.transaction = await this.db.transaction("write");
		const fkRes = await this.txExecute("PRAGMA foreign_keys");
		this.origForeignKeys = Number(fkRes.rows[0]?.[0] ?? 0);
		if (this.origForeignKeys) {
			await this.logExecute(
				"Disable foreign keys temporarily for migration",
				"PRAGMA foreign_keys = OFF",
			);
			this.nChanges = 0;
		}
		await this.txExecute("PRAGMA defer_foreign_keys = TRUE");
	}

	private async commit(): Promise<void> {
		await this.transaction?.commit();
	}

	private async rollback(): Promise<void> {
		await this.transaction?.rollback();
	}

	private async onError(): Promise<void> {
		if (this.origForeignKeys) {
			const message =
				"Database migration: Re-enable foreign keys after migration";
			logger.info(
				`${message} with SQL:\n${leftPad("PRAGMA foreign_keys = ON")}`,
			);
			await this.db.execute("PRAGMA foreign_keys = ON");
			this.nChanges += 1;
		}
	}

	private async afterCommit(): Promise<void> {
		const oldChanges = this.nChanges;
		const newVal = await this.migratePragma("foreign_keys");
		if (newVal === this.origForeignKeys) {
			this.nChanges = oldChanges;
		}
		if (this.nChanges) {
			await this.db.execute("VACUUM");
		}
	}

	private async performMigration(): Promise<void> {
		const pristineTables = await this.fetchPristineSchemas("table");
		const pristineIndices = await this.fetchPristineSchemas("index");
		const tables = await this.fetchCurrentSchemas("table");

		const newTables = difference(pristineTables, tables);
		const removedTables = difference(tables, pristineTables);

		if (removedTables.size && !this.allowDeletions) {
			throw new RuntimeError(
				`Database migration: Refusing to delete tables ${JSON.stringify(
					Array.from(removedTables),
				)}`,
			);
		}

		const modifiedTables = new Set<string>();

		for (const [name, sql] of pristineTables.entries()) {
			const base = normaliseSql(tables.get(name) ?? "");
			const pristine = normaliseSql(sql);
			const changedTable = Boolean(base) && base !== pristine;
			if (changedTable) modifiedTables.add(name);
		}

		for (const tblName of newTables) {
			const sql = pristineTables.get(tblName);
			if (sql) {
				await this.logExecute(`Create table ${tblName}`, sql);
			}
		}

		for (const tblName of removedTables) {
			await this.logExecute(`Drop table ${tblName}`, `DROP TABLE ${tblName}`);
		}

		for (const tblName of modifiedTables) {
			const sql = pristineTables.get(tblName);
			if (sql) {
				await this.recreateTable(tblName, sql);
			}
		}

		const indices = await this.fetchCurrentSchemas("index");
		for (const indexName of difference(indices, pristineIndices)) {
			await this.logExecute(
				`Dropping obsolete index ${indexName}`,
				`DROP INDEX ${indexName}`,
			);
		}
		for (const [indexName, sql] of pristineIndices.entries()) {
			if (!indices.has(indexName)) {
				await this.logExecute(`Creating new index ${indexName}`, sql);
			} else if (sql !== indices.get(indexName)) {
				await this.logExecute(
					`Index ${indexName} changed: Dropping old version`,
					`DROP INDEX ${indexName}`,
				);
				await this.logExecute(
					`Index ${indexName} changed: Creating updated version in its place`,
					sql,
				);
			}
		}

		await this.migratePragma("user_version");

		const pristineForeignKeys = Number(
			(await this.pristine.execute("PRAGMA foreign_keys")).rows[0]?.[0] ?? 0,
		);
		if (pristineForeignKeys) {
			const fkRows = await this.txExecute("PRAGMA foreign_key_check");
			if (fkRows.rows.length) {
				throw new RuntimeError(
					"Database migration: Would fail foreign_key_check",
				);
			}
		}
	}

	private async recreateTable(
		tblName: string,
		pristineSql: string,
	): Promise<void> {
		if (!this.transaction) {
			throw new Error("Transaction not started");
		}
		const createSql = pristineSql.replace(
			new RegExp(`\\b${escapeRegex(tblName)}\\b`, "gi"),
			`${tblName}_migration_new`,
		);
		await this.logExecute(
			`Columns change: Create table ${tblName} with updated schema`,
			createSql,
		);

		const cols = await this.collectColumns(this.transaction, tblName);
		const pristineCols = await this.collectColumns(this.pristine, tblName);

		const removedColumns = differenceFromSet(cols, pristineCols);
		if (removedColumns.size && !this.allowDeletions) {
			logger.warn(
				"Database migration: Refusing to remove columns %o from table %s. Current cols are %o attempting migration to %o",
				Array.from(removedColumns),
				tblName,
				Array.from(cols),
				Array.from(pristineCols),
			);
			throw new RuntimeError(
				`Database migration: Refusing to remove columns ${JSON.stringify(
					Array.from(removedColumns),
				)} from table ${tblName}`,
			);
		}

		const common = intersection(cols, pristineCols);
		logger.info(
			"cols: %o, pristine_cols: %o",
			Array.from(cols),
			Array.from(pristineCols),
		);
		await this.logExecute(
			`Migrate data for table ${tblName}`,
			`INSERT INTO ${tblName}_migration_new (${Array.from(common).join(
				", ",
			)}) SELECT ${Array.from(common).join(", ")} FROM ${tblName}`,
		);

		await this.logExecute(
			`Drop old table ${tblName} now data has been migrated`,
			`DROP TABLE ${tblName}`,
		);

		await this.logExecute(
			`Columns change: Move new table ${tblName} over old`,
			`ALTER TABLE ${tblName}_migration_new RENAME TO ${tblName}`,
		);
	}

	private async migratePragma(pragma: string): Promise<number> {
		const pristineVal = Number(
			(await this.pristine.execute(`PRAGMA ${pragma}`)).rows[0]?.[0] ?? 0,
		);
		const currentVal = Number(
			(await this.db.execute(`PRAGMA ${pragma}`)).rows[0]?.[0] ?? 0,
		);
		if (currentVal !== pristineVal) {
			await this.logExecute(
				`Set ${pragma} to ${pristineVal} from ${currentVal}`,
				`PRAGMA ${pragma} = ${pristineVal}`,
			);
		}
		return pristineVal;
	}

	private async fetchPristineSchemas(
		type: SchemaType,
	): Promise<Map<string, string>> {
		const stmt =
			type === "table"
				? `SELECT name, sql FROM sqlite_master WHERE type = ? AND name != '${SQLITE_SEQUENCE}'`
				: `SELECT name, sql FROM sqlite_master WHERE type = ?`;
		const res = await this.pristine.execute({ sql: stmt, args: [type] });
		return rowsToMap(res.rows);
	}

	private async fetchCurrentSchemas(
		type: SchemaType,
	): Promise<Map<string, string>> {
		const stmt =
			type === "table"
				? `SELECT name, sql FROM sqlite_master WHERE type = ? AND name != '${SQLITE_SEQUENCE}'`
				: `SELECT name, sql FROM sqlite_master WHERE type = ?`;
		const res = await this.txExecute(stmt, [type]);
		return rowsToMap(res.rows);
	}

	private async collectColumns(
		executor: Client | Transaction,
		table: string,
	): Promise<Set<string>> {
		const res = await executor.execute(`PRAGMA table_info(${table})`);
		return new Set(res.rows.map((row) => row[1] as string));
	}

	private async txExecute(sql: string, args?: InArgs) {
		if (!this.transaction) {
			throw new Error("Transaction not started");
		}
		if (args !== undefined) {
			return this.transaction.execute({ sql, args });
		}
		return this.transaction.execute(sql);
	}

	private async logExecute(
		msg: string,
		sql: string,
		args?: InArgs,
	): Promise<void> {
		const formatted = `Database migration: ${msg} with SQL:\n${leftPad(
			dedent(sql),
		)}`;
		if (args !== undefined) {
			logger.info(`${formatted} args = %o`, args);
		} else {
			logger.info(formatted);
		}
		if (this.transaction) {
			if (args !== undefined) {
				await this.transaction.execute({ sql, args });
			} else {
				await this.transaction.execute(sql);
			}
		} else if (args !== undefined) {
			await this.db.execute({ sql, args });
		} else {
			await this.db.execute(sql);
		}
		this.nChanges += 1;
	}
}

class RuntimeError extends Error {}

function difference(
	left: Map<string, string>,
	right: Map<string, string>,
): Set<string> {
	const result = new Set<string>();
	for (const key of left.keys()) {
		if (!right.has(key)) {
			result.add(key);
		}
	}
	return result;
}

function differenceFromSet(left: Set<string>, right: Set<string>): Set<string> {
	const result = new Set<string>();
	for (const item of left) {
		if (!right.has(item)) {
			result.add(item);
		}
	}
	return result;
}

function intersection(left: Set<string>, right: Set<string>): Set<string> {
	const result = new Set<string>();
	for (const item of left) {
		if (right.has(item)) {
			result.add(item);
		}
	}
	return result;
}

function rowsToMap(rows: Row[]): Map<string, string> {
	return new Map(
		rows.map((row) => [row[0] as string, (row[1] as string) ?? ""]),
	);
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function dedent(text: string): string {
	const lines = text.replace(/\t/g, "    ").split(/\r?\n/);
	let minIndent: number | null = null;
	for (const line of lines) {
		if (!line.trim()) continue;
		const match = line.match(/^\s*/);
		const indent = match ? match[0].length : 0;
		if (minIndent === null || indent < minIndent) {
			minIndent = indent;
		}
	}
	if (minIndent && minIndent > 0) {
		return lines.map((line) => line.slice(minIndent)).join("\n");
	}
	return lines.join("\n");
}

function leftPad(text: string, indent = "    "): string {
	return text
		.split("\n")
		.map((line) => indent + line)
		.join("\n");
}

function normaliseSql(sql: string): string {
	return sql
		.replace(/--[^\n]*\n/g, "")
		.replace(/\s+/g, " ")
		.replace(/ *([(),]) */g, "$1")
		.replace(/"(\w+)"/g, "$1")
		.trim();
}
