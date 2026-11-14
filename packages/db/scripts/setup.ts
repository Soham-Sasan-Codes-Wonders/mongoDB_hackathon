import { closeDb, setup } from "../src/index.ts";
await setup.setupDatabase({ waitForSearch: !process.argv.includes("--no-wait") });
await closeDb();
