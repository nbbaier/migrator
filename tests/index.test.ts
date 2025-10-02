import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { migrate } from "../src/migrator";

const createTempDb = () => {
	const filePath = join(tmpdir(), `migrator-test-${randomUUID()}.db`);
	return {
		client: createClient({ url: `file:${filePath}` }),
		filePath,
	};
};

test("dumbMigrateDb adds tables and columns while preserving data", async () => {
	const { client: db, filePath } = createTempDb();
	try {
		await db.executeMultiple(`
			CREATE TABLE foo (
				id INTEGER PRIMARY KEY,
				name TEXT
			);
			INSERT INTO foo (name) VALUES ('Alice');
		`);

		const targetSchema = `
			CREATE TABLE foo (
				id INTEGER PRIMARY KEY,
				name TEXT,
				age INTEGER DEFAULT NULL
			);
			CREATE TABLE bar (
				id INTEGER PRIMARY KEY,
				foo_id INTEGER REFERENCES foo(id)
			);
			PRAGMA user_version = 1;
		`;

		const changed = await migrate(db, targetSchema);
		const result = await db.execute(
			"SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
		);
		expect(changed).toBe(true);
		expect(result.rows.map((row) => row[0])).toEqual(["bar", "foo"]);

		const columns = await db.execute("PRAGMA table_info(foo)");
		expect(columns.rows.map((row) => row[1])).toEqual(["id", "name", "age"]);

		const data = await db.execute("SELECT name, age FROM foo");
		expect(data.rows.map((row) => [row[0], row[1]])).toEqual([["Alice", null]]);

		const userVersion = await db.execute("PRAGMA user_version");
		expect(userVersion.rows[0][0]).toBe(1);
	} finally {
		db.close();
		await rm(filePath, { force: true });
	}
});

test("dumbMigrateDb refuses destructive changes when allowDeletions is false", async () => {
	const { client: db, filePath } = createTempDb();
	try {
		await db.executeMultiple(`
			CREATE TABLE to_remove (id INTEGER PRIMARY KEY);
		`);

		await expect(
			migrate(
				db,
				"PRAGMA user_version = 1; \n CREATE TABLE foo (id INTEGER PRIMARY KEY);",
			),
		).rejects.toThrow(/Refusing to delete tables/);
	} finally {
		db.close();
		await rm(filePath, { force: true });
	}
});
