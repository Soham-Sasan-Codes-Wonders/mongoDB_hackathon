import dotenv from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Db, MongoClient, type Document } from "mongodb";

dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env") });
const uri = process.env.MONGODB_URI;
if (!uri) throw new Error("MONGODB_URI is required");

export const client = new MongoClient(uri, { maxPoolSize: 20, retryWrites: true });
export const db: Db = client.db(process.env.MONGODB_DB ?? "claims_coordinator");
export const collection = <T extends Document = Document>(name: string) => db.collection<T>(name);
export const wallNow = (): Date => new Date();

export async function closeDatabase(): Promise<void> {
  await client.close();
}
