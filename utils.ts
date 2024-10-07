import type { Client } from "@libsql/client";

export const getTables = async (
	db: Client,
): Promise<{ [key: string]: string }> => {
	return Object.fromEntries(
		(
			await db.execute(`SELECT name, sql FROM sqlite_schema
   WHERE type = 'table' AND name != 'sqlite_sequence'`)
		).rows
			.map((row) => {
				return [row[0], row[1]];
			})
			.map(([key, value]) => [key, value]),
	);
};

export const getIndices = async (
	db: Client,
): Promise<{ [key: string]: string }> => {
	return Object.fromEntries(
		(
			await db.execute(`SELECT name, sql FROM sqlite_schema
   WHERE type = 'index' AND name != 'sqlite_sequence'`)
		).rows
			.map((row) => {
				return [row[0], row[1]];
			})
			.map(([key, value]) => [key, value]),
	);
};

function getOverlap(arr1: string[], arr2: string[]): string[] {
	return arr1.filter((item) => arr2.includes(item));
}

function getNonOverlap(arr1: string[], arr2: string[]): string[] {
	return arr1.filter((key) => !new Set(arr2).has(key));
}

export const determineChanges = (
	currentTables: { [key: string]: string },
	desiredTables: { [key: string]: string },
) => {
	const currentTableNames = Object.keys(currentTables);
	const desiredTableNames = Object.keys(desiredTables);

	return {
		newTables: getNonOverlap(desiredTableNames, currentTableNames),
		deletedTables: getNonOverlap(currentTableNames, desiredTableNames),
		unchangedTables: getOverlap(currentTableNames, desiredTableNames),
	};
};

export function normaliseSql(sql: string): string {
	let normalisedSql = sql;
	// Remove comments:
	normalisedSql = normalisedSql.replace(/--[^\n]*\n/g, "");
	// Normalise whitespace:
	normalisedSql = normalisedSql.replace(/\s+/g, " ");
	normalisedSql = normalisedSql.replace(/ *([(),]) */g, "$1");
	// Remove unnecessary quotes
	normalisedSql = normalisedSql.replace(/"(\w+)"/g, "$1");
	return normalisedSql.trim();
}
