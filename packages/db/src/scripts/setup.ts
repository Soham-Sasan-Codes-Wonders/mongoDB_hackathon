import { client, closeDatabase, db } from "../database.js";
import { setupDatabase } from "../setup.js";

try {
  await client.connect();
  await setupDatabase(db);
  console.log(`Database setup complete: ${db.databaseName}`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
