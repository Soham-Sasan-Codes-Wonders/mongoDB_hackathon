import { createInterface } from "node:readline/promises";
import { closeDb, env, setup } from "../src/index.ts";
if (!process.argv.includes("--yes")) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(`Drop EVERYTHING in database "${env.dbName}"? Type the db name to confirm: `);
  rl.close();
  if (a.trim() !== env.dbName) {
    console.log("aborted");
    process.exit(1);
  }
}
await setup.dropEverything();
console.log(`[db:reset] dropped ${env.dbName}`);
await closeDb();
