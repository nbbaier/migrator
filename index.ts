import { createClient } from "@libsql/client";

const db = createClient({ url: "file:test.db" });
const pristine = createClient({ url: "file:pristine.db" });

// const schema = await Bun.file("schema.sql").text();
// const schemaBatch = schema
//   .trim()
//   .split("\n")
//   .filter((sql) => sql.startsWith("--") === false);

const pristineTables = Object.fromEntries(
  (
    await pristine.execute(`SELECT name, sql FROM sqlite_schema
    WHERE type = 'table' AND name != 'sqlite_sequence'`)
  ).rows
    .map((row) => {
      return [row[0], row[1]];
    })
    .map(([key, value]) => [key, value])
);

const tables = Object.fromEntries(
  (
    await db.execute(`SELECT name, sql FROM sqlite_schema
      WHERE type = 'table' AND name != 'sqlite_sequence'`)
  ).rows
    .map((row) => {
      return [row[0], row[1]];
    })
    .map(([key, value]) => [key, value])
);

const newTables = Object.keys(pristineTables).filter(
  (key) => !new Set(Object.keys(tables)).has(key)
);

const removedTables = Object.keys(tables).filter(
  (key) => !new Set(Object.keys(pristineTables)).has(key)
);

if (newTables.length > 0) {
  await Promise.all(
    newTables.map(
      async (table: string) => await db.execute(pristineTables[table])
    )
  );
}

if (removedTables.length > 0) {
  await Promise.all(
    removedTables.map(
      async (table: string) => await db.execute(`DROP TABLE ${table}`)
    )
  );
}
