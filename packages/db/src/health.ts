import type { Document } from "mongodb";
import { collection } from "./database.js";
import { SystemHealthSchema, type SystemHealth } from "./schemas.js";

export async function recordHealth(entry: Omit<SystemHealth, "_id">): Promise<void> { await collection("system_health").insertOne(SystemHealthSchema.parse(entry) as unknown as Document); }
export async function getHealthSeries(system: string, sinceMs: number): Promise<SystemHealth[]> {
  return collection<SystemHealth & Document>("system_health").find({ system, ts: { $gte: new Date(sinceMs) } }).sort({ ts: 1 }).toArray();
}
