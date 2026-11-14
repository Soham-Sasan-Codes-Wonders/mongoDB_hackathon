import type { Db } from "mongodb";
import { COLLECTIONS } from "./collections.ts";
import { getDb } from "./env.ts";
import { validators } from "./schemas.ts";
import { EMBED_DIM } from "./embed.ts";
import { PROFILE_VECTOR_INDEX } from "./profiles.ts";
import { EXPERIENCE_VECTOR_INDEX } from "./experiences.ts";
import { DOCUMENTS_TEXT_INDEX } from "./documents.ts";

const log = (m: string) => console.log(`[db:setup] ${m}`);

async function ensureCollection(db: Db, name: string, opts: Record<string, unknown>) {
  const exists = (await db.listCollections({ name }).toArray()).length > 0;
  if (!exists) {
    await db.createCollection(name, opts);
    log(`created ${name}`);
  } else if (opts.validator) {
    await db.command({ collMod: name, validator: opts.validator, validationLevel: "strict", validationAction: "error" });
  }
}

/** Collections, validators, regular/TTL/unique indexes, time-series, and the 3 search indexes. Idempotent. */
export async function setupDatabase(opts: { searchIndexes?: boolean; waitForSearch?: boolean } = {}) {
  const db = await getDb();
  for (const name of COLLECTIONS) {
    if (name === "system_health") continue;
    const v = validators[name];
    await ensureCollection(db, name, v ? { validator: { $jsonSchema: v }, validationLevel: "strict", validationAction: "error" } : {});
  }
  // time-series (fallback to a normal collection if the cluster refuses)
  const hasHealth = (await db.listCollections({ name: "system_health" }).toArray()).length > 0;
  if (!hasHealth) {
    try {
      await db.createCollection("system_health", { timeseries: { timeField: "ts", metaField: "system", granularity: "seconds" } });
      log("created system_health (time-series)");
    } catch (e) {
      log(`time-series failed (${(e as Error).message}); falling back to a normal collection`);
      await db.createCollection("system_health");
    }
  }
  await db.collection("system_health").createIndex({ system: 1, ts: -1 });

  await db.collection("tasks").createIndex({ claimId: 1, taskId: 1 }, { unique: true });
  await db.collection("tasks").createIndex({ claimId: 1, status: 1 });
  await db.collection("actions").createIndex({ idempotencyKey: 1 }, { unique: true });
  await db.collection("actions").createIndex({ claimId: 1, status: 1 });
  await db.collection("actions").createIndex({ claimId: 1, taskId: 1, createdAt: -1 });
  await db.collection("observations").createIndex({ claimId: 1, processedAt: 1, receivedAt: 1 });
  await db.collection("timers").createIndex({ fired: 1, cancelled: 1, dueAt: 1 });
  await db.collection("timers").createIndex({ claimId: 1, taskId: 1 });
  await db.collection("leases").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 3600 }); // cleanup only
  await db.collection("approvals").createIndex({ claimId: 1, status: 1 });
  await db.collection("system_profiles").createIndex({ docType: 1, system: 1, version: -1 });
  await db.collection("documents").createIndex({ claimId: 1, docType: 1 });
  await db.collection("contacts").createIndex({ phone: 1 }, { unique: true });
  await db.collection("contacts").createIndex({ claimIds: 1 });
  log("indexes ok");

  if (opts.searchIndexes !== false) await setupSearchIndexes(db, opts.waitForSearch ?? true);
}

const SEARCH_INDEXES = [
  {
    coll: "system_profiles",
    def: {
      name: PROFILE_VECTOR_INDEX,
      type: "vectorSearch",
      definition: {
        fields: [
          { type: "vector", path: "embedding", numDimensions: EMBED_DIM, similarity: "cosine" },
          { type: "filter", path: "docType" },
          { type: "filter", path: "system" },
        ],
      },
    },
  },
  {
    coll: "experiences",
    def: {
      name: EXPERIENCE_VECTOR_INDEX,
      type: "vectorSearch",
      definition: {
        fields: [
          { type: "vector", path: "embedding", numDimensions: EMBED_DIM, similarity: "cosine" },
          { type: "filter", path: "problemType" },
          { type: "filter", path: "system" },
        ],
      },
    },
  },
  {
    coll: "documents",
    def: {
      name: DOCUMENTS_TEXT_INDEX,
      type: "search",
      definition: {
        mappings: {
          dynamic: false,
          fields: { extractedText: { type: "string" }, docType: { type: "token" }, claimId: { type: "token" } },
        },
      },
    },
  },
] as const;

/** Exactly 3 search indexes (the M0 budget). Skipped with a message on a non-Atlas deployment. */
export async function setupSearchIndexes(db: Db, wait: boolean) {
  for (const { coll, def } of SEARCH_INDEXES) {
    const c = db.collection(coll);
    let existing: { name: string; queryable?: boolean }[];
    try {
      existing = (await c.listSearchIndexes().toArray()) as never;
    } catch (e) {
      log(`search indexes not supported here (${(e as Error).message.slice(0, 80)}). Skipping all 3; vector/text search will use local fallbacks.`);
      return;
    }
    if (!existing.some((i) => i.name === def.name)) {
      await c.createSearchIndex(def as never);
      log(`created search index ${def.name}`);
    }
  }
  if (!wait) return;
  for (const { coll, def } of SEARCH_INDEXES) {
    const c = db.collection(coll);
    for (let i = 0; i < 120; i++) {
      const [idx] = (await c.listSearchIndexes(def.name).toArray()) as { queryable?: boolean }[];
      if (idx?.queryable) break;
      if (i === 0) log(`waiting for ${def.name} to become queryable...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  log("search indexes queryable");
}

/** Drop every collection in the database (db:reset). */
export async function dropEverything() {
  const db = await getDb();
  await db.dropDatabase();
}

/**
 * Demo reset that keeps the database, indexes, seed data and worker resume tokens: removes all
 * claim data, profile versions > 1 and claim-made experiences, then restarts the sim clock.
 * Uses deleteMany (never drop) so running change streams stay valid.
 */
export async function resetDemoData(): Promise<void> {
  const db = await getDb();
  for (const name of ["claims", "tasks", "actions", "observations", "timers", "leases", "approvals", "documents", "system_health"]) {
    await db.collection(name).deleteMany({});
  }
  await db.collection("files.files").deleteMany({});
  await db.collection("files.chunks").deleteMany({});
  await db.collection("system_profiles").deleteMany({ docType: { $in: ["profile", "field"] }, version: { $gt: 1 } });
  await db.collection("experiences").deleteMany({ claimId: { $ne: null } });
  await db.collection("contacts").updateMany({}, { $set: { claimIds: [] } });
  await db.collection("contacts").deleteMany({ role: "claimant" });
  const { resetClock } = await import("./clock.ts");
  await resetClock();
}
