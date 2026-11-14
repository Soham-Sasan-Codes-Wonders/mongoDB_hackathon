import type { ChangeStream, Document } from "mongodb";
import { collection, db } from "./database.js";
import type { Experience, Timer } from "./schemas.js";

/** Collections the dashboard streams live (SSE). */
export const DASHBOARD_COLLECTIONS = ["claims", "tasks", "actions", "observations", "approvals", "timers", "leases"] as const;

/**
 * One database-level change stream filtered on collection names (M0 only accepts string/regex
 * filters on namespaces) and, optionally, one claim. Updates carry `fullDocument: "updateLookup"`
 * so the claim id is available. The dashboard treats every event as "refetch the snapshot".
 */
export function watchDashboardChanges(claimId?: string): ChangeStream {
  const match: Document = { "ns.coll": { $in: [...DASHBOARD_COLLECTIONS] }, operationType: { $in: ["insert", "update", "replace", "delete"] } };
  if (claimId) match.$or = [{ "fullDocument.claimId": claimId }, { "fullDocument._id": claimId }, { operationType: "delete" }];
  return db.watch([{ $match: match }, { $project: { operationType: 1, ns: 1, documentKey: 1, "fullDocument.claimId": 1, "fullDocument._id": 1 } }], { fullDocument: "updateLookup" });
}

/** Every timer of a claim, open and fired, soonest first. */
export async function listTimers(claimId: string, limit = 200): Promise<(Timer & { _id: unknown })[]> {
  return collection<Timer & Document>("timers").find({ claimId }).sort({ dueAt: 1 }).limit(limit).toArray();
}

/** Experiences without their embeddings; optional case-insensitive text filter over problem/outcome/system. */
export async function listExperiences(query?: string, limit = 100): Promise<Omit<Experience, "embedding">[]> {
  const rx = query ? new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : null;
  return collection<Experience & Document>("experiences")
    .find(rx ? { $or: [{ problem: rx }, { outcome: rx }, { system: rx }, { problemType: rx }] } : {}, { projection: { embedding: 0 } })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray() as Promise<Omit<Experience, "embedding">[]>;
}

export interface ClaimSummaryRow {
  _id: string;
  claimantName: string;
  phase: string;
  createdAt: Date;
  openGates: number;
  unconfirmedActions: number;
  tasksDone: number;
  tasksTotal: number;
  leaseHolder: string | null;
  leaseLive: boolean;
}

/** Claims list for the operator view: phase, open gates, unconfirmed actions, lease holder (one aggregation). */
export async function listClaimSummaries(limit = 50): Promise<ClaimSummaryRow[]> {
  return collection("claims").aggregate<ClaimSummaryRow>([
    { $sort: { createdAt: -1 } },
    { $limit: limit },
    { $lookup: { from: "approvals", let: { id: "$_id" }, pipeline: [{ $match: { $expr: { $and: [{ $eq: ["$claimId", "$$id"] }, { $eq: ["$status", "pending"] }] } } }, { $count: "n" }], as: "gates" } },
    { $lookup: { from: "actions", let: { id: "$_id" }, pipeline: [{ $match: { $expr: { $and: [{ $eq: ["$claimId", "$$id"] }, { $in: ["$status", ["sent", "acknowledged"]] }] } } }, { $count: "n" }], as: "unconf" } },
    { $lookup: { from: "tasks", let: { id: "$_id" }, pipeline: [{ $match: { $expr: { $eq: ["$claimId", "$$id"] } } }, { $group: { _id: null, total: { $sum: 1 }, done: { $sum: { $cond: [{ $in: ["$status", ["confirmed", "denied", "closed_by_human"]] }, 1, 0] } } } }], as: "t" } },
    { $lookup: { from: "leases", localField: "_id", foreignField: "_id", as: "lease" } },
    {
      $project: {
        claimantName: "$claimant.name",
        phase: 1,
        createdAt: 1,
        openGates: { $ifNull: [{ $first: "$gates.n" }, 0] },
        unconfirmedActions: { $ifNull: [{ $first: "$unconf.n" }, 0] },
        tasksDone: { $ifNull: [{ $first: "$t.done" }, 0] },
        tasksTotal: { $ifNull: [{ $first: "$t.total" }, 0] },
        leaseHolder: { $ifNull: [{ $first: "$lease.workerId" }, null] },
        leaseLive: { $gt: [{ $ifNull: [{ $first: "$lease.expiresAt" }, new Date(0)] }, "$$NOW"] },
      },
    },
  ]).toArray();
}
