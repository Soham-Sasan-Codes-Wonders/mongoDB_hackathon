import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { MongoClient, type Db, type ClientSession } from "mongodb";

/** Walk up from cwd looking for the repo-root .env (the file next to pnpm-workspace.yaml). */
function loadEnv(): void {
  let dir = resolve(process.cwd());
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      const p = join(dir, ".env");
      if (existsSync(p)) loadDotenv({ path: p, quiet: true } as never);
      return;
    }
    const up = dirname(dir);
    if (up === dir) return;
    dir = up;
  }
}
loadEnv();

export const env = {
  get uri() {
    return process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/?replicaSet=rs0";
  },
  get dbName() {
    return process.env.MONGODB_DB ?? "claims_coordinator";
  },
  get voyageKey() {
    return process.env.VOYAGE_API_KEY ?? "";
  },
};

let client: MongoClient | null = null;
let clientPromise: Promise<MongoClient> | null = null;

export async function getClient(): Promise<MongoClient> {
  if (client) return client;
  if (!clientPromise) {
    clientPromise = (async () => {
      const c = new MongoClient(env.uri, { maxPoolSize: 20, serverSelectionTimeoutMS: 10_000 });
      await c.connect();
      client = c;
      return c;
    })();
  }
  return clientPromise;
}

export async function getDb(): Promise<Db> {
  return (await getClient()).db(env.dbName);
}

export async function closeDb(): Promise<void> {
  if (client) await client.close();
  client = null;
  clientPromise = null;
}

/** Run `fn` inside a single multi-document transaction (Atlas M0 is a 3-node replica set). */
export async function withTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const c = await getClient();
  const session = c.startSession();
  try {
    let out!: T;
    await session.withTransaction(async () => {
      out = await fn(session);
    });
    return out;
  } finally {
    await session.endSession();
  }
}

/** True when talking to Atlas (search/vector indexes available). Detected lazily. */
let atlasSearch: boolean | null = null;
export function setAtlasSearchAvailable(v: boolean) {
  atlasSearch = v;
}
export function atlasSearchAvailable(): boolean | null {
  return atlasSearch;
}
