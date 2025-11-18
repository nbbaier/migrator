import {
	type Client,
	createClient,
	type InArgs,
	type Row,
	type Transaction,
} from "@libsql/client";
import logger from "./logger";

type SchemaType = "table" | "index" | "trigger" | "view";

const SQLITE_SEQUENCE = "sqlite_sequence";

/**
 * Migrates a SQLite database to match the provided target schema.
 *
 * This function implements a declarative schema migration approach following
 * David Rothlis's 12-step procedure for safely migrating SQLite databases.
 * It compares the current database state against a target schema and applies
 * the necessary changes in a transaction-safe manner.
 *
 * @param db - The SQLite/libSQL client connected to the database to migrate
 * @param schema - The target schema SQL (CREATE TABLE, CREATE INDEX, etc.)
 * @param allowDeletions - Whether to allow deletion of tables/columns (default: false)
 * @returns Promise<boolean> - true if changes were made, false if database already matches schema
 *
 * @throws {RuntimeError} If migration fails (schema invalid, foreign key violations, etc.)
 *
 * @example
 * ```typescript
 * import { createClient } from '@libsql/client';
 * import { migrate } from './migrator';
 *
 * const db = createClient({ url: 'file:./data.db' });
 * const schema = `
 *   CREATE TABLE users (
 *     id INTEGER PRIMARY KEY,
 *     email TEXT NOT NULL
 *   );
 *   PRAGMA user_version = 1;
 * `;
 *
 * try {
 *   const changed = await migrate(db, schema);
 *   console.log(changed ? 'Migration applied' : 'No changes needed');
 * } finally {
 *   db.close();
 * }
 * ```
 *
 * @remarks
 * Safety features:
 * - All changes wrapped in a transaction (rollback on error)
 * - Foreign key constraints validated before commit
 * - Deletion protection (tables/columns) unless allowDeletions=true
 * - Temporary foreign key disabling during migration
 * - Automatic VACUUM after successful migration
 *
 * Supported schema objects:
 * - Tables (CREATE TABLE)
 * - Indexes (CREATE INDEX)
 * - Triggers (CREATE TRIGGER)
 * - Views (CREATE VIEW)
 * - Pragmas (foreign_keys, user_version)
 */
export async function migrate(
	db: Client,
	schema: string,
	allowDeletions = false,
): Promise<boolean> {
	const migrator = new Migrator(db, schema, allowDeletions);
	await migrator.migrate();
	return migrator.nChanges > 0;
}

/**
 * The Migrator class handles the complete migration lifecycle for a SQLite database.
 *
 * This class implements the 12-step procedure for safely migrating SQLite schemas:
 * 1. Disable foreign keys (if enabled)
 * 2. Start transaction
 * 3. Remember indexes, triggers, and views for modified tables
 * 4. Create new table versions with updated schemas
 * 5. Transfer data from old to new tables
 * 6. Drop old tables
 * 7. Rename new tables
 * 8. Recreate indexes, triggers, and views
 * 9. Handle views that reference modified tables
 * 10. Validate foreign key constraints
 * 11. Commit transaction
 * 12. Re-enable foreign keys and VACUUM
 *
 * @example
 * ```typescript
 * const migrator = new Migrator(db, targetSchema, false);
 * await migrator.migrate();
 * console.log(`Made ${migrator.nChanges} changes`);
 * ```
 */
export class Migrator {
	/** The SQLite/libSQL client for the database being migrated */
	public readonly db: Client;
	/** The target schema SQL to migrate towards */
	public readonly schema: string;
	/** Whether to allow deletion of tables and columns */
	public readonly allowDeletions: boolean;
	/** The number of schema changes applied during migration */
	public nChanges = 0;

	private readonly pristine = createClient({ url: ":memory:" });
	private pristineInitialised = false;
	private transaction: Transaction | null = null;
	private origForeignKeys: number | null = null;

	/**
	 * Creates a new Migrator instance.
	 *
	 * @param db - The database client to migrate
	 * @param schema - The target schema SQL
	 * @param allowDeletions - Whether to allow destructive operations (default: false)
	 */
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

		// Basic validation: check for potentially dangerous SQL
		const dangerousPatterns = [
			{ pattern: /\battach\s+database\b/i, message: "ATTACH DATABASE" },
			{ pattern: /\bdetach\s+database\b/i, message: "DETACH DATABASE" },
			{ pattern: /\bpragma\s+(?!foreign_keys|user_version|defer_foreign_keys|foreign_key_check|table_info)\w+/i, message: "unsafe PRAGMA" },
		];

		for (const { pattern, message } of dangerousPatterns) {
			if (pattern.test(this.schema)) {
				throw new RuntimeError(
					`Schema contains potentially dangerous statement: ${message}. This is not allowed for security reasons.`,
				);
			}
		}

		try {
			await this.pristine.executeMultiple(this.schema);
		} catch (error) {
			throw new RuntimeError(
				`Invalid schema SQL: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
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
		const pristineTriggers = await this.fetchPristineSchemas("trigger");
		const pristineViews = await this.fetchPristineSchemas("view");
		const tables = await this.fetchCurrentSchemas("table");

		// Drop ALL views first, before any table migrations
		// Views will be recreated at the end of the migration
		// This is necessary because views can reference tables that will be recreated
		const currentViews = await this.fetchCurrentSchemas("view");
		for (const viewName of currentViews.keys()) {
			await this.logExecute(
				`Drop view ${viewName} before table migrations (will be recreated later)`,
				`DROP VIEW ${escapeIdentifier(viewName)}`,
			);
		}

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
			await this.logExecute(
				`Drop table ${tblName}`,
				`DROP TABLE ${escapeIdentifier(tblName)}`,
			);
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
				`DROP INDEX ${escapeIdentifier(indexName)}`,
			);
		}
		for (const [indexName, sql] of pristineIndices.entries()) {
			if (!indices.has(indexName)) {
				await this.logExecute(`Creating new index ${indexName}`, sql);
			} else if (sql !== indices.get(indexName)) {
				await this.logExecute(
					`Index ${indexName} changed: Dropping old version`,
					`DROP INDEX ${escapeIdentifier(indexName)}`,
				);
				await this.logExecute(
					`Index ${indexName} changed: Creating updated version in its place`,
					sql,
				);
			}
		}

		// Migrate triggers
		const triggers = await this.fetchCurrentSchemas("trigger");
		for (const triggerName of difference(triggers, pristineTriggers)) {
			await this.logExecute(
				`Dropping obsolete trigger ${triggerName}`,
				`DROP TRIGGER ${escapeIdentifier(triggerName)}`,
			);
		}
		for (const [triggerName, sql] of pristineTriggers.entries()) {
			if (!triggers.has(triggerName)) {
				await this.logExecute(`Creating new trigger ${triggerName}`, sql);
			} else if (sql !== triggers.get(triggerName)) {
				await this.logExecute(
					`Trigger ${triggerName} changed: Dropping old version`,
					`DROP TRIGGER ${escapeIdentifier(triggerName)}`,
				);
				await this.logExecute(
					`Trigger ${triggerName} changed: Creating updated version in its place`,
					sql,
				);
			}
		}

		// Migrate views (Step 9: handle views that reference modified tables)
		const views = await this.fetchCurrentSchemas("view");
		for (const viewName of difference(views, pristineViews)) {
			await this.logExecute(
				`Dropping obsolete view ${viewName}`,
				`DROP VIEW ${escapeIdentifier(viewName)}`,
			);
		}
		for (const [viewName, sql] of pristineViews.entries()) {
			if (!views.has(viewName)) {
				await this.logExecute(`Creating new view ${viewName}`, sql);
			} else if (sql !== views.get(viewName)) {
				await this.logExecute(
					`View ${viewName} changed: Dropping old version`,
					`DROP VIEW ${escapeIdentifier(viewName)}`,
				);
				await this.logExecute(
					`View ${viewName} changed: Creating updated version in its place`,
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

		// Step 3: Remember the format of indexes and triggers
		// Note: Views are handled globally in performMigration, not per-table
		const currentDependencies = await this.fetchTableDependencies(
			this.transaction,
			tblName,
		);
		const pristineDependencies = await this.fetchTableDependencies(
			this.pristine,
			tblName,
		);

		// Drop existing triggers before table recreation
		// (indices are automatically dropped when the table is dropped)
		// (views are already dropped globally at the start of performMigration)
		for (const [name, dep] of currentDependencies) {
			if (dep.type === "trigger") {
				await this.logExecute(
					`Drop trigger ${name} before table recreation`,
					`DROP TRIGGER ${escapeIdentifier(name)}`,
				);
			}
		}

		// Step 4: Create new table with updated schema
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
		// Escape column names to prevent SQL injection
		const escapedColumns = Array.from(common).map((col) =>
			escapeIdentifier(col),
		);
		const escapedTableName = escapeIdentifier(tblName);
		const escapedNewTableName = escapeIdentifier(`${tblName}_migration_new`);
		await this.logExecute(
			`Migrate data for table ${tblName}`,
			`INSERT INTO ${escapedNewTableName} (${escapedColumns.join(
				", ",
			)}) SELECT ${escapedColumns.join(", ")} FROM ${escapedTableName}`,
		);

		await this.logExecute(
			`Drop old table ${tblName} now data has been migrated`,
			`DROP TABLE ${escapedTableName}`,
		);

		await this.logExecute(
			`Columns change: Move new table ${tblName} over old`,
			`ALTER TABLE ${escapedNewTableName} RENAME TO ${escapedTableName}`,
		);

		// Step 8: Recreate indexes and triggers associated with this table
		// Views are handled globally in performMigration after all tables are migrated
		for (const [name, dep] of pristineDependencies) {
			if (dep.type === "index") {
				await this.logExecute(`Recreate index ${name}`, dep.sql);
			} else if (dep.type === "trigger") {
				await this.logExecute(`Recreate trigger ${name}`, dep.sql);
			}
		}
	}

	private async migratePragma(pragma: string): Promise<number> {
		validatePragma(pragma);
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
		// Table names come from sqlite_master so should be safe, but validate anyway
		const escapedTable = escapeIdentifier(table);
		const res = await executor.execute(`PRAGMA table_info(${escapedTable})`);
		return new Set(res.rows.map((row) => row[1] as string));
	}

	/**
	 * Fetches all triggers, indexes, and views associated with a specific table.
	 * This implements step 3 of the 12-step procedure.
	 */
	private async fetchTableDependencies(
		executor: Client | Transaction,
		tableName: string,
	): Promise<Map<string, { type: string; sql: string }>> {
		const res = await executor.execute({
			sql: "SELECT type, name, sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index', 'trigger', 'view')",
			args: [tableName],
		});
		const dependencies = new Map<string, { type: string; sql: string }>();
		for (const row of res.rows) {
			const name = row[1] as string;
			const sql = row[2] as string;
			if (sql) {
				// Exclude auto-created indices (PRIMARY KEY, UNIQUE constraints)
				dependencies.set(name, { type: row[0] as string, sql });
			}
		}
		return dependencies;
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

/**
 * Error thrown when a migration operation fails.
 *
 * This error is thrown for various migration failures including:
 * - Invalid schema SQL syntax
 * - Attempting to delete tables/columns when allowDeletions=false
 * - Foreign key constraint violations
 * - Unsafe SQL statements in schema (ATTACH DATABASE, etc.)
 * - Invalid SQL identifiers
 *
 * @example
 * ```typescript
 * import { migrate, RuntimeError } from './migrator';
 *
 * try {
 *   await migrate(db, schema);
 * } catch (error) {
 *   if (error instanceof RuntimeError) {
 *     console.error('Migration failed:', error.message);
 *   }
 * }
 * ```
 */
export class RuntimeError extends Error {}

/**
 * Escapes a SQL identifier by wrapping it in double quotes.
 * This allows special characters but prevents SQL injection.
 */
function escapeIdentifier(identifier: string): string {
	// Double quotes inside identifiers must be escaped by doubling them
	return `"${identifier.replace(/"/g, '""')}"`;
}

/**
 * Validates pragma names against a whitelist of known safe pragmas.
 */
const SAFE_PRAGMAS = new Set([
	"foreign_keys",
	"user_version",
	"defer_foreign_keys",
	"foreign_key_check",
	"table_info",
]);

function validatePragma(pragma: string): void {
	if (!SAFE_PRAGMAS.has(pragma)) {
		throw new RuntimeError(
			`Unsafe pragma name: "${pragma}". Only whitelisted pragmas are allowed.`,
		);
	}
}

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
