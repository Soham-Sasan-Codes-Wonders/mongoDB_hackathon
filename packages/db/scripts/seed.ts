import { closeDb, seedDatabase } from "../src/index.ts";
await seedDatabase((m) => console.log(`[db:seed] ${m}`));
await closeDb();
