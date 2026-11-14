import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { client, closeDatabase, db } from "../database.js";

try {
  await client.connect();
  if (!process.argv.includes("--yes")) {
    const prompt = createInterface({ input: stdin, output: stdout });
    const answer = await prompt.question(`Drop all data in ${db.databaseName}? Type "yes" to confirm: `);
    prompt.close();
    if (answer.trim().toLowerCase() !== "yes") {
      console.log("Reset cancelled.");
      process.exitCode = 1;
    } else {
      await db.dropDatabase();
      console.log(`Dropped ${db.databaseName}.`);
    }
  } else {
    await db.dropDatabase();
    console.log(`Dropped ${db.databaseName}.`);
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
