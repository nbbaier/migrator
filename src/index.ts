import { createClient } from "@libsql/client";
import logger from "./logger";
import { migrate } from "./migrator";

const schemaTarget = await Bun.file("./db/schema.sql").text();
const db = createClient({ url: "file:./db/test.db" });

try {
	const changed = await migrate(db, schemaTarget);
	logger.info(`Database migration completed${changed ? " with changes" : ""}.`);
} finally {
	db.close();
}
