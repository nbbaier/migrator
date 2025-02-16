import { createClient } from "@libsql/client";
import { determineChanges, getTables } from "./utils";

const schemaDesired = await Bun.file("schema.sql").text();

// create the database clients
const dbCurrent = createClient({ url: "file:test.db" });
const dbDesired = createClient({
	url: ":memory:",
});

const batchStatements = schemaDesired
	.split(";")
	.map((s) => s.trim().replace(/\n/g, " ").replace(/\s+/g, " "))
	.filter(Boolean)
	.map((s) => ({ sql: s, args: [] }));

const syncDesiredSchema = await dbDesired.batch(batchStatements, "write");
const currentTables = await getTables(dbCurrent);
const desiredTables = await getTables(dbDesired);

const changes = determineChanges(currentTables, desiredTables);
console.log("Changes to be made:", changes);

for (const table of changes.newTables) {
	await dbCurrent.execute(desiredTables[table]);
}
for (const table of changes.deletedTables) {
	await dbCurrent.execute(`DROP TABLE ${table}`);
}
