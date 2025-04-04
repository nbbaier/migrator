import type { Client } from "@libsql/client";
import type { Changeset } from "../types";

/**
 * Retrieves schema information for tables or indexes from the SQLite database.
 *
 * @param db - The database client to execute queries on
 * @param type - The type of schema to retrieve: either "table" or "index"
 * @returns A promise that resolves to a record mapping schema names to their SQL definitions
 *
 * @example
 * ```typescript
 * const tableSchema = await getSchema(client, "table");
 * console.log(tableSchema);
 * // { "users": "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)", ... }
 * ```
 */
export const getSchema = async (
	db: Client,
	type: "table" | "index",
): Promise<Record<string, string>> => {
	const res = await db.execute({
		sql: `SELECT name, sql FROM sqlite_schema WHERE type = ? AND name != 'sqlite_sequence'`,
		args: [type],
	});

	return Object.fromEntries(res.rows.map((row) => [row[0], row[1]]));
};

/**
 * Returns an array of items that exist in both of the provided arrays.
 *
 * @template T - The type of elements in the arrays.
 * @param arr1 - The first array to check for overlap.
 * @param arr2 - The second array to check for overlap.
 * @returns An array containing all elements that exist in both input arrays.
 *
 * @example
 * // Returns [2, 3]
 * getOverlap([1, 2, 3, 4], [2, 3, 5]);
 */
function getOverlap<T>(arr1: T[], arr2: T[]): T[] {
	return arr1.filter((item) => arr2.includes(item));
}

/**
 * Returns elements from the first array that are not present in the second array.
 *
 * @template T - The type of elements in the arrays.
 * @param arr1 - The first array.
 * @param arr2 - The second array.
 * @returns An array containing elements from arr1 that do not exist in arr2.
 *
 * @example
 * const result = getNonOverlap([1, 2, 3], [2, 3, 4]); // returns [1]
 */
function getNonOverlap<T>(arr1: T[], arr2: T[]): T[] {
	return arr1.filter((key) => !new Set(arr2).has(key));
}

/**
 * Identifies which items in the target record have been altered compared to the current record.
 * An item is considered altered if it exists in both records but has different SQL definitions.
 *
 * @param current - The current record of SQL definitions, where keys are names and values are SQL strings
 * @param target - The target record of SQL definitions to compare against the current record
 * @returns An array of names/keys that exist in both records but have different SQL definitions
 */
function getAltered(
	current: Record<string, string>,
	target: Record<string, string>,
): string[] {
	return Object.entries(target)
		.map(([targetName, targetSQL]) => {
			const currentNames = Object.keys(current);
			if (
				currentNames.includes(targetName) &&
				normaliseSql(targetSQL) !== normaliseSql(current[targetName])
			)
				return targetName;
		})
		.filter((item) => item !== undefined);
}

/**
 * Determines the changes between the current database tables and the desired tables.
 *
 * @param current - A record of table names to their schema definitions in the current database
 * @param target - A record of table names to their schema definitions in the desired state
 * @returns An object containing arrays of:
 *   - newTables: Tables that exist in desired but not in current
 *   - deletedTables: Tables that exist in current but not in desired
 *   - alteredTables: Tables that exist in both but have different schemas
 *   - unchangedTables: Tables that exist in both and have identical schemas
 */
export const determineChanges = (
	current: Record<string, string>,
	target: Record<string, string>,
): {
	created: string[];
	dropped: string[];
	altered: string[];
	// unchanged: string[];
} => {
	const currentNames = Object.keys(current);
	const targetNames = Object.keys(target);

	const created = getNonOverlap(targetNames, currentNames);
	const dropped = getNonOverlap(currentNames, targetNames);
	const altered = getAltered(current, target);
	// const unchanged = getNonOverlap(
	// 	getOverlap(currentNames, targetNames),
	// 	altered,
	// );

	return { created, dropped, altered };
};

/**
 * Normalizes SQL strings by removing comments, excess whitespace, and unnecessary quotes.
 *
 * This function performs the following transformations:
 * - Removes SQL comments (lines starting with --)
 * - Replaces multiple whitespace characters with a single space
 * - Removes spaces around parentheses and commas
 * - Removes double quotes around identifiers
 * - Trims leading and trailing whitespace
 *
 * @param sql - The SQL string to normalize
 * @returns The normalized SQL string
 */
export function normaliseSql(sql: string): string {
	return sql
		.replace(/--[^\n]*\n/g, "")
		.replace(/\s+/g, " ")
		.replace(/ *([(),]) */g, "$1")
		.replace(/"(\w+)"/g, "$1")
		.trim();
}

/**
 * Executes database changes for tables and indexes based on the provided changesets.
 *
 * @param db - Database client instance
 * @param changes - Object containing table and index changesets
 * @param targetSchema - Record mapping statement names to their SQL definitions
 * @param type - Type of database object to process ('table' or 'index')
 *
 * @remarks
 * The function processes three types of changes:
 * - created: Executes CREATE statements from the target schema
 * - dropped: Executes DROP statements
 * - altered: Currently logs unsupported operation message
 *
 * @throws Will throw if database execution fails
 */
export async function applySchemaChanges(
	db: Client,
	changes: { table: Changeset; index: Changeset },
	targetSchema: Record<string, string>,
	type: "table" | "index",
) {
	for (const key of Object.keys(changes[type]) as Array<keyof Changeset>) {
		for (const stmt of changes[type][key]) {
			if (key === "created") {
				await db.execute(targetSchema[stmt]);
				console.log(`Created ${type} ${stmt}`);
			}
			if (key === "dropped") {
				await db.execute(`DROP TABLE ${stmt}`);
				console.log(`Dropped ${type} ${stmt}`);
			}
			if (key === "altered") {
				console.log(
					`Can't alter ${stmt}: ${type} alterations aren't supported yet`,
				);
			}
		}
	}
}
