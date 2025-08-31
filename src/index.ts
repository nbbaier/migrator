import { createClient } from "@libsql/client";
import { applySchemaChanges, determineChanges, getSchema } from "./utils";

const schemaTarget = await Bun.file("./db/schema.sql").text();

const db = createClient({ url: "file:./db/test.db" });
const dbTarget = createClient({
	url: ":memory:",
});

await dbTarget.batch(
	schemaTarget
		.split(";")
		.map((s) => s.trim().replace(/\n/g, " ").replace(/\s+/g, " "))
		.filter(Boolean),
	"write",
);

const currentTables = await getSchema(db, "table");
const targetTables = await getSchema(dbTarget, "table");
const currentIndices = await getSchema(db, "index");
const targetIndices = await getSchema(dbTarget, "index");

const changes = {
	table: determineChanges(currentTables, targetTables),
	index: determineChanges(currentIndices, targetIndices),
};

console.log(changes);

// await applySchemaChanges(db, changes, targetTables, "table");
// await applySchemaChanges(db, changes, targetIndices, "index");
