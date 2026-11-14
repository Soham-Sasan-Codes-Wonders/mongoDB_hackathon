import { type Document } from "mongodb";
import { collection, wallNow } from "./database.js";
import type { Lease } from "./schemas.js";

export async function acquireLease(claimId: string, workerId: string, ttlMs: number): Promise<Lease | null> {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError("ttlMs must be positive");
  const now = wallNow();
  try {
    return await collection("leases").findOneAndUpdate(
      { _id: claimId, $or: [{ workerId }, { expiresAt: { $lt: now } }] } as Document,
      { $set: { workerId, expiresAt: new Date(now.getTime() + ttlMs) } },
      { upsert: true, returnDocument: "after", includeResultMetadata: false }
    ) as Lease | null;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 11000) return null;
    throw error;
  }
}

export async function renewLease(claimId: string, workerId: string, ttlMs: number): Promise<boolean> {
  const now = wallNow();
  return (await collection("leases").updateOne({ _id: claimId, workerId, expiresAt: { $gte: now } } as Document, { $set: { expiresAt: new Date(now.getTime() + ttlMs) } })).modifiedCount === 1;
}
export async function releaseLease(claimId: string, workerId: string): Promise<boolean> {
  return (await collection("leases").deleteOne({ _id: claimId, workerId } as Document)).deletedCount === 1;
}

/* ---------------------------------------------------------------- agent additions */

export async function getLease(claimId: string): Promise<Lease | null> {
  return collection<Lease & Document>("leases").findOne({ _id: claimId } as Document);
}
export async function listLeases(): Promise<Lease[]> {
  return collection<Lease & Document>("leases").find({}).toArray();
}
/** Leases whose holder stopped renewing: the sweeper's takeover candidates (checks expiresAt directly; TTL only cleans up). */
export async function expiredLeases(): Promise<Lease[]> {
  return collection<Lease & Document>("leases").find({ expiresAt: { $lt: wallNow() } }).toArray();
}
