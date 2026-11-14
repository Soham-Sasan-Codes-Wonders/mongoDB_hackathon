import { actions, experiences, tasks } from "../db.ts";
import { readBack } from "../executor/index.ts";
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
