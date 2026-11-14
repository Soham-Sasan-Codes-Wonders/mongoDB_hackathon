import { col } from "./collections.ts";
import { listOpenTimers } from "./timers.ts";

/** claim + tasks + latest action per task + pending approvals + open timers */
export async function getClaimOverview(claimId: string) {
  const [claim, tasks, actions, approvals, timers] = await Promise.all([
    (await col.claims()).findOne({ _id: claimId }),
    (await col.tasks()).find({ claimId }).sort({ createdAt: 1, _id: 1 }).toArray(),
    (await col.actions()).find({ claimId }).sort({ createdAt: 1, _id: 1 }).toArray(),
    (await col.approvals()).find({ claimId, status: "pending" }).sort({ createdAt: 1 }).toArray(),
    listOpenTimers(claimId),
  ]);
  if (!claim) return null;
  const latestByTask = new Map<string, (typeof actions)[number]>();
  for (const a of actions) latestByTask.set(a.taskId, a);
  return {
    claim,
    tasks: tasks.map((t) => ({ ...t, latestAction: latestByTask.get(t.taskId) ?? null })),
    pendingApprovals: approvals,
    openTimers: timers,
  };
}

export async function listClaims() {
  return (await col.claims())
    .find({}, { projection: { claimant: 1, phase: 1, createdAt: 1, "policy.number": 1, "money.totals": 1, compactSummary: 1 } })
    .sort({ createdAt: -1 })
    .toArray();
}

/** Every action transition for a claim, flattened and ordered: the audit trail. */
export async function getActionTimeline(claimId: string) {
  return (await col.actions())
    .aggregate<{ actionId: unknown; taskId: string; system: string; kind: string; idempotencyKey: string; status: string; at: Date; wallAt: Date; by: string; note?: string }>([
      { $match: { claimId } },
      { $unwind: "$history" },
      {
        $project: {
          _id: 0,
          actionId: "$_id",
          taskId: 1,
          system: 1,
          kind: 1,
          idempotencyKey: 1,
          status: "$history.status",
          at: "$history.at",
          wallAt: "$history.wallAt",
          by: "$history.by",
          note: "$history.note",
        },
      },
      { $sort: { wallAt: 1 } },
    ])
    .toArray();
}

export { getHealthSeries } from "./health.ts";
export { searchDocuments } from "./documents.ts";
