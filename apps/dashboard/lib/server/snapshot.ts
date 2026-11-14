import type { ClaimSnapshot } from "../types";
import { getDb, plain } from "./db";

/** Everything one claim screen shows, read through @claim-coordinator/db. */
export async function getClaimSnapshot(claimId: string): Promise<ClaimSnapshot | null> {
  const db = await getDb();
  const claim = await db.getClaim(claimId);
  if (!claim) return null;
  const [tasks, actions, observations, approvals, timers, money, documents, lease] = await Promise.all([
    db.listTasks(claimId),
    db.listActions(claimId),
    db.listObservations(claimId, 300),
    db.listApprovals(claimId),
    db.listTimers(claimId),
    db.reconcileMoney(claimId),
    db.listDocuments(claimId),
    db.getLease(claimId),
  ]);
  return plain({ claim, tasks, actions, observations, approvals, timers, money, documents, lease, simNow: db.nowSync() }) as unknown as ClaimSnapshot;
}
