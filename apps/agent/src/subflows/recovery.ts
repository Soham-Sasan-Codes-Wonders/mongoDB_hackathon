import { actions, approvals, experiences, tasks } from "../db.ts";
import { handleOutcome } from "../worker/outcomes.ts";
import { readBack, retry } from "../executor/index.ts";
import type { ClaimCtx } from "../worker/context.ts";

/**
 * Crash recovery (doc steps 1-5) for one claim, run the first time a worker touches it after
 * startup or a lease takeover. The lease (1) is already held; the compact summary and open tasks
 * (2) are loaded by the loop; the change stream (3) was resumed from the saved token at worker
 * startup. Here: (4) read back EVERY sent/acknowledged action. Never resend blind: anything still
 * unproven is left to the normal verify step, which retries with the same key only after its own
 * read-back.
 */
export async function runRecovery(c: ClaimCtx, reason: "startup" | "lease_takeover"): Promise<{ checked: number; confirmed: number; resent: 0 }> {
  const pending = await actions.listUnverified(c.claimId);
  const open = await tasks.listOpenTasks(c.claimId);
  c.log("recovery", `${reason}: summary ${c.claim.compactSummary.length} chars, ${open.length} open tasks, ${pending.length} unverified action(s) to read back`);
  let confirmed = 0;
  for (const a of pending) {
    const r = await readBack(a, `${c.workerId}:recovery`);
    if (r.confirmed) confirmed++;
    c.log("recovery", `read-back ${a.taskId} ${a.system}.${a.kind} [${a.status}] -> ${r.confirmed ? "confirmed" : "effect not visible yet (will verify, not resend blind)"}`);
  }
  await healStuckDrift(c);
  if (pending.length) {
    await experiences.recordExperience({
      problemType: "crash",
      system: "internal",
      problem: `Worker ${reason}; ${pending.length} action(s) left in sent/acknowledged`,
      fix: { action: "readback_before_resend", checked: pending.length, confirmed },
      outcome: `${confirmed} confirmed by read-back, 0 resent blind`,
      claimId: c.claimId,
    });
    c.event(`crash recovery: ${confirmed}/${pending.length} unverified actions confirmed by read-back, none resent`);
  }
  return { checked: pending.length, confirmed, resent: 0 };
}

/**
 * A task left `blocked_drift` with no pending drift approval means a drift analysis died midway
 * (e.g. the worker crashed, or a dependency failed before the failure could be handed to an
 * operator). Restart it: rerun the drift for the failed action, or let a wait task re-detect it.
 */
async function healStuckDrift(c: ClaimCtx): Promise<void> {
  const pendingDrift = (await approvals.listApprovals(c.claimId, "pending")).filter((a) => a.gate === "drift_mapping").map((a) => a.taskId);
  for (const t of await tasks.listTasks(c.claimId, { status: ["blocked_drift"] })) {
    if (pendingDrift.includes(t.taskId)) continue;
    const failed = (await actions.listActions(c.claimId, { taskId: t.taskId, status: ["failed"] })).at(-1);
    c.log("recovery", `${t.taskId} was left blocked_drift with nothing pending; ${failed ? "resending its action with the same key" : "re-checking it"}`);
    if (failed) {
      // The profile may already be fixed: resend first (same key). A new 422 re-enters the drift subflow.
      await tasks.setTaskStatus(c.claimId, t.taskId, "in_progress", { by: c.workerId, note: "recovery: resend after an unfinished drift" });
      await handleOutcome(c, await retry(failed, `${c.workerId}:recovery`));
    } else {
      await tasks.setTaskStatus(c.claimId, t.taskId, "pending", { by: c.workerId, note: "recovery: drift analysis never finished; re-check" });
    }
    c.event(`recovery: unstuck ${t.taskId} (blocked_drift)`);
  }
}
