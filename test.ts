import { createClient, type Value } from "@libsql/client";

const db = createClient({ url: "file:pristine.db" });

interface ColumnsInfo {
  [key: string]: string;
}

function extractTableInfo(createTableStatement: string): ColumnsInfo {
  const tableInfo = createTableStatement.match(/CREATE TABLE (\w+) \((.+)\)/);
  const columnsInfo = Object.fromEntries(
    tableInfo![2].split(",").map((column) =>
      column
        .trim()
        .split(" ")
        .map((value) => value.toLowerCase())
    )
  );

  return columnsInfo;
}

function getSchema() {}

Object.fromEntries(
  (
    await db.execute(`SELECT name, sql FROM sqlite_schema
      WHERE type = 'table' AND name != 'sqlite_sequence'`)
  ).rows.map((row) => {
    const name = row[0];
    const sql = row[1] as string;
    return [
      name,
      extractTableInfo(sql.replace(/\n/g, " ").replace(/\s{2,}/g, " ")),
    ];
  })
);
