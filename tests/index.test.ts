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

test("migrate adds tables and columns while preserving data", async () => {
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

test("migrate refuses destructive changes when allowDeletions is false", async () => {
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

test("migrate creates and updates indices", async () => {
	const { client: db, filePath } = createTempDb();
	try {
		await db.executeMultiple(`
			CREATE TABLE users (
				id INTEGER PRIMARY KEY,
				email TEXT NOT NULL,
				name TEXT
			);
			CREATE INDEX idx_email ON users(email);
		`);

		const targetSchema = `
			CREATE TABLE users (
				id INTEGER PRIMARY KEY,
				email TEXT NOT NULL,
				name TEXT
			);
			CREATE INDEX idx_email_name ON users(email, name);
		`;

		const changed = await migrate(db, targetSchema);
		expect(changed).toBe(true);

		const indices = await db.execute(
			"SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
		);
		expect(indices.rows.map((row) => row[0])).toEqual(["idx_email_name"]);
	} finally {
		db.close();
		await rm(filePath, { force: true });
	}
});

test("migrate handles index modification", async () => {
	const { client: db, filePath } = createTempDb();
	try {
		await db.executeMultiple(`
			CREATE TABLE products (
				id INTEGER PRIMARY KEY,
				name TEXT,
				price REAL
			);
			CREATE INDEX idx_name ON products(name);
		`);

		const targetSchema = `
			CREATE TABLE products (
				id INTEGER PRIMARY KEY,
				name TEXT,
				price REAL
			);
			CREATE INDEX idx_name ON products(name, price);
		`;

		await migrate(db, targetSchema);

		const indexInfo = await db.execute(
			"SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_name'",
		);
		expect(indexInfo.rows[0]?.[0]).toContain("name, price");
	} finally {
		db.close();
		await rm(filePath, { force: true });
	}
});

test("migrate validates foreign key constraints", async () => {
	const { client: db, filePath } = createTempDb();
	try {
		await db.executeMultiple(`
			PRAGMA foreign_keys = ON;
			CREATE TABLE users (id INTEGER PRIMARY KEY);
			CREATE TABLE posts (
				id INTEGER PRIMARY KEY,
				user_id INTEGER REFERENCES users(id)
			);
			INSERT INTO users (id) VALUES (1);
			INSERT INTO posts (user_id) VALUES (1);
		`);

		// This should fail because we're trying to add a column with a foreign key
		// that references a non-existent value
		const targetSchema = `
			PRAGMA foreign_keys = ON;
			CREATE TABLE users (id INTEGER PRIMARY KEY);
			CREATE TABLE posts (
				id INTEGER PRIMARY KEY,
				user_id INTEGER REFERENCES users(id),
				category_id INTEGER REFERENCES categories(id)
			);
			CREATE TABLE categories (id INTEGER PRIMARY KEY);
		`;

		// This should succeed - the foreign key check passes
		await migrate(db, targetSchema);

		const columns = await db.execute("PRAGMA table_info(posts)");
		expect(columns.rows.map((row) => row[1])).toEqual([
			"id",
			"user_id",
			"category_id",
		]);
	} finally {
		db.close();
		await rm(filePath, { force: true });
	}
});

test("migrate creates and updates triggers", async () => {
	const { client: db, filePath } = createTempDb();
	try {
		await db.executeMultiple(`
			CREATE TABLE users (
				id INTEGER PRIMARY KEY,
				name TEXT,
				updated_at INTEGER
			);
			CREATE TRIGGER update_timestamp
			AFTER UPDATE ON users
			BEGIN
				UPDATE users SET updated_at = strftime('%s', 'now') WHERE id = NEW.id;
			END;
		`);

		const targetSchema = `
			CREATE TABLE users (
				id INTEGER PRIMARY KEY,
				name TEXT,
				email TEXT,
				updated_at INTEGER
			);
			CREATE TRIGGER update_timestamp
			AFTER UPDATE ON users
			BEGIN
				UPDATE users SET updated_at = strftime('%s', 'now') WHERE id = NEW.id;
			END;
			CREATE TRIGGER validate_email
			BEFORE INSERT ON users
			BEGIN
				SELECT CASE
					WHEN NEW.email NOT LIKE '%@%' THEN
						RAISE(ABORT, 'Invalid email')
				END;
			END;
		`;

		const changed = await migrate(db, targetSchema);
		expect(changed).toBe(true);

		const triggers = await db.execute(
			"SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
		);
		expect(triggers.rows.map((row) => row[0])).toEqual([
			"update_timestamp",
			"validate_email",
		]);
	} finally {
		db.close();
		await rm(filePath, { force: true });
	}
});

test("migrate creates and updates views", async () => {
	const { client: db, filePath } = createTempDb();
	try {
		await db.executeMultiple(`
			CREATE TABLE orders (
				id INTEGER PRIMARY KEY,
				user_id INTEGER,
				total REAL
			);
			CREATE VIEW order_summary AS
			SELECT user_id, COUNT(*) as order_count
			FROM orders
			GROUP BY user_id;
		`);

		const targetSchema = `
			CREATE TABLE orders (
				id INTEGER PRIMARY KEY,
				user_id INTEGER,
				total REAL,
				status TEXT
			);
			CREATE VIEW order_summary AS
			SELECT user_id, COUNT(*) as order_count, SUM(total) as total_amount
			FROM orders
			GROUP BY user_id;
		`;

		const changed = await migrate(db, targetSchema);
		expect(changed).toBe(true);

		const views = await db.execute(
			"SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'order_summary'",
		);
		expect(views.rows[0]?.[0]).toContain("SUM(total)");
	} finally {
		db.close();
		await rm(filePath, { force: true });
	}
});

test("migrate handles tables with special characters in column names", async () => {
	const { client: db, filePath } = createTempDb();
	try {
		await db.executeMultiple(`
			CREATE TABLE "my-table" (
				id INTEGER PRIMARY KEY,
				"user name" TEXT,
				"email@address" TEXT
			);
			INSERT INTO "my-table" ("user name", "email@address") VALUES ('Alice', 'alice@example.com');
		`);

		const targetSchema = `
			CREATE TABLE "my-table" (
				id INTEGER PRIMARY KEY,
				"user name" TEXT,
				"email@address" TEXT,
				"phone#number" TEXT
			);
		`;

		await migrate(db, targetSchema);

		const data = await db.execute('SELECT "user name", "email@address" FROM "my-table"');
		expect(data.rows[0]?.[0]).toBe("Alice");
		expect(data.rows[0]?.[1]).toBe("alice@example.com");
	} finally {
		db.close();
		await rm(filePath, { force: true });
	}
});

test("migrate is idempotent - running twice produces no changes", async () => {
	const { client: db, filePath } = createTempDb();
	try {
		const schema = `
			CREATE TABLE users (
				id INTEGER PRIMARY KEY,
				name TEXT
			);
			PRAGMA user_version = 5;
		`;

		const changed1 = await migrate(db, schema);
		expect(changed1).toBe(true);

		const changed2 = await migrate(db, schema);
		expect(changed2).toBe(false);
	} finally {
		db.close();
		await rm(filePath, { force: true });
	}
});

test("migrate handles empty schema gracefully", async () => {
	const { client: db, filePath } = createTempDb();
	try {
		const changed = await migrate(db, "");
		expect(changed).toBe(false);
	} finally {
		db.close();
		await rm(filePath, { force: true });
	}
});

test("migrate rejects invalid schema SQL", async () => {
	const { client: db, filePath } = createTempDb();
	try {
		await expect(
			migrate(db, "CREATE TABEL users (id INTEGER);"), // typo: TABEL instead of TABLE
		).rejects.toThrow(/Invalid schema SQL/);
	} finally {
		db.close();
		await rm(filePath, { force: true });
	}
});

test("migrate rejects dangerous ATTACH DATABASE statements", async () => {
	const { client: db, filePath } = createTempDb();
	try {
		await expect(
			migrate(db, "ATTACH DATABASE 'other.db' AS other;"),
		).rejects.toThrow(/ATTACH DATABASE/);
	} finally {
		db.close();
		await rm(filePath, { force: true });
	}
});

test("migrate handles column deletion when allowDeletions is true", async () => {
	const { client: db, filePath } = createTempDb();
	try {
		await db.executeMultiple(`
			CREATE TABLE users (
				id INTEGER PRIMARY KEY,
				name TEXT,
				deprecated_field TEXT
			);
			INSERT INTO users (name, deprecated_field) VALUES ('Alice', 'old');
		`);

		const targetSchema = `
			CREATE TABLE users (
				id INTEGER PRIMARY KEY,
				name TEXT
			);
		`;

		const changed = await migrate(db, targetSchema, true);
		expect(changed).toBe(true);

		const columns = await db.execute("PRAGMA table_info(users)");
		expect(columns.rows.map((row) => row[1])).toEqual(["id", "name"]);

		const data = await db.execute("SELECT name FROM users");
		expect(data.rows[0]?.[0]).toBe("Alice");
	} finally {
		db.close();
		await rm(filePath, { force: true });
	}
});

test("migrate refuses column deletion when allowDeletions is false", async () => {
	const { client: db, filePath } = createTempDb();
	try {
		await db.executeMultiple(`
			CREATE TABLE users (
				id INTEGER PRIMARY KEY,
				name TEXT,
				email TEXT
			);
		`);

		const targetSchema = `
			CREATE TABLE users (
				id INTEGER PRIMARY KEY,
				name TEXT
			);
		`;

		await expect(migrate(db, targetSchema, false)).rejects.toThrow(
			/Refusing to remove columns/,
		);
	} finally {
		db.close();
		await rm(filePath, { force: true });
	}
});

test("migrate handles complex schema with triggers, views, and indices on recreated tables", async () => {
	const { client: db, filePath } = createTempDb();
	try {
		await db.executeMultiple(`
			CREATE TABLE articles (
				id INTEGER PRIMARY KEY,
				title TEXT,
				created_at INTEGER
			);
			CREATE INDEX idx_title ON articles(title);
			CREATE TRIGGER set_created_at
			AFTER INSERT ON articles
			BEGIN
				UPDATE articles SET created_at = strftime('%s', 'now') WHERE id = NEW.id;
			END;
			CREATE VIEW recent_articles AS
			SELECT * FROM articles ORDER BY created_at DESC LIMIT 10;
			INSERT INTO articles (title) VALUES ('First Article');
		`);

		const targetSchema = `
			CREATE TABLE articles (
				id INTEGER PRIMARY KEY,
				title TEXT,
				content TEXT,
				created_at INTEGER
			);
			CREATE INDEX idx_title ON articles(title);
			CREATE TRIGGER set_created_at
			AFTER INSERT ON articles
			BEGIN
				UPDATE articles SET created_at = strftime('%s', 'now') WHERE id = NEW.id;
			END;
			CREATE VIEW recent_articles AS
			SELECT * FROM articles ORDER BY created_at DESC LIMIT 10;
		`;

		await migrate(db, targetSchema);

		// Verify table structure
		const columns = await db.execute("PRAGMA table_info(articles)");
		expect(columns.rows.map((row) => row[1])).toEqual([
			"id",
			"title",
			"content",
			"created_at",
		]);

		// Verify data preserved
		const data = await db.execute("SELECT title FROM articles");
		expect(data.rows[0]?.[0]).toBe("First Article");

		// Verify index exists
		const indices = await db.execute(
			"SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_title'",
		);
		expect(indices.rows.length).toBe(1);

		// Verify trigger exists
		const triggers = await db.execute(
			"SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'set_created_at'",
		);
		expect(triggers.rows.length).toBe(1);

		// Verify view exists
		const views = await db.execute(
			"SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'recent_articles'",
		);
		expect(views.rows.length).toBe(1);
	} finally {
		db.close();
		await rm(filePath, { force: true });
	}
});
