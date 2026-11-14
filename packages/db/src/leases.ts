import { col } from "./collections.ts";
import type { Lease } from "./schemas.ts";

/**
 * Leases use WALL-clock time (they guard real processes). Takeover checks expiresAt directly;
 * the TTL index only cleans up (M0 TTL runs about once a minute).
 */
export async function acquireLease(claimId: string, workerId: string, ttlMs: number): Promise<boolean> {
  const leases = await col.leases();
  const nowWall = new Date();
  const expiresAt = new Date(nowWall.getTime() + ttlMs);
  try {
    const res = await leases.findOneAndUpdate(
      { _id: claimId, $or: [{ workerId }, { expiresAt: { $lt: nowWall } }] },
      { $set: { workerId, expiresAt }, $setOnInsert: { acquiredAt: nowWall } },
      { upsert: true, returnDocument: "after" },
    );
    return res?.workerId === workerId;
  } catch (e: unknown) {
    // Duplicate key: another worker holds a live lease (the filter didn't match, the upsert collided).
    if ((e as { code?: number }).code === 11000) return false;
    throw e;
  }
}

export async function renewLease(claimId: string, workerId: string, ttlMs: number): Promise<boolean> {
  const res = await (await col.leases()).updateOne(
    { _id: claimId, workerId },
    { $set: { expiresAt: new Date(Date.now() + ttlMs) } },
  );
  return res.matchedCount === 1;
}

export async function releaseLease(claimId: string, workerId: string): Promise<void> {
  await (await col.leases()).deleteOne({ _id: claimId, workerId });
}

export async function getLease(claimId: string): Promise<Lease | null> {
  return (await col.leases()).findOne({ _id: claimId });
}

export async function listLeases(): Promise<Lease[]> {
  return (await col.leases()).find({}).toArray();
}

/** Leases whose holder stopped renewing (the sweeper's takeover candidates). */
export async function expiredLeases(): Promise<Lease[]> {
  return (await col.leases()).find({ expiresAt: { $lt: new Date() } }).toArray();
}
