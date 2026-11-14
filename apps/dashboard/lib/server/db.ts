import * as db from "@claim-coordinator/db";

/**
 * The dashboard reads and writes MongoDB ONLY through @claim-coordinator/db. Importing it also
 * loads the repo-root .env into process.env. Sim time comes from the package's cached clock.
 */
let ready: Promise<unknown> | null = null;
export async function getDb(): Promise<typeof db> {
  ready ??= db.initClockCache();
  await ready;
  return db;
}

/** Make Mongo docs JSON-safe (ObjectId -> hex string, Date -> ISO string). */
export function plain<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}
