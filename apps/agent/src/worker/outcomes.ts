import { actions, approvals, clock, tasks, timers, type ActionDoc, type OutsideSystem, type TaskDoc } from "@claims/db";
import { config } from "../config.ts";
import { readBack, retry, type ExecOutcome } from "../executor/index.ts";
import { errMsg } from "../log.ts";
import { runDrift } from "../subflows/drift.ts";
import { runRejection } from "../subflows/rejection.ts";
import type { ClaimCtx } from "./context.ts";
import { handlerFor } from "./handlers.ts";

/** React to what the executor reported. Drift and rejection start their subflows. */
export async function handleOutcome(c: ClaimCtx, o: ExecOutcome, depth = 0): Promise<void> {
  switch (o.outcome) {
    case "acknowledged":
      c.event(`${o.action.taskId} ${o.action.system}.${o.action.kind} acknowledged (awaiting proof)`);
      return;
    case "transient":
      c.log("step 8 execute", `${o.action.taskId} transient failure: ${o.error}; verify timer will read back first`);
      c.progress = true;
      return;
    case "rejected":
      await runRejection(c, o.action, o.reason);
      return;
    case "drift": {
      if (depth > 1) {
        c.log("drift", `${o.action.taskId}: still failing validation after a fix; leaving blocked for an operator`);
        return;
      }
      const r = await runDrift(c, { system: o.action.system as OutsideSystem, taskId: o.action.taskId, action: o.action, trigger: "validation_error", error: o.error, op: o.op });
      if (r.outcome) await handleOutcome(c, r.outcome, depth + 1);
      c.progress = true;
      return;
    }
  }
}

/** A task is proven done: confirm it, cancel its timers (a confirmed task never gets chased). */
export async function confirmTask(c: ClaimCtx, taskId: string, note: string, status: "confirmed" | "closed_by_human" = "confirmed") {
  const ok = await tasks.setTaskStatus(c.claimId, taskId, status, { by: c.workerId, note, from: ["pending", "ready", "in_progress", "waiting", "awaiting_approval", "blocked_drift"] });
  if (!ok) return;
  await timers.cancelTimersForTask(c.claimId, taskId);
  c.log("step 9 bookkeeping", `${taskId} -> ${status}: ${note}`);
  c.event(`${taskId} ${status}: ${note}`);
  if (taskId === "T11") {
    // T12 resolves once T11 proves the car is ready.
    const t12 = await tasks.getTask(c.claimId, "T12");
    if (t12 && ["waiting", "pending"].includes(t12.status)) await tasks.setTaskStatus(c.claimId, "T12", "pending", { by: c.workerId, note: "T11 confirmed; re-evaluate" });
    await timers.cancelTimersForTask(c.claimId, "T12", ["rental_expiring"]);
  }
}

export async function onActionConfirmed(c: ClaimCtx, a: ActionDoc, effect: Record<string, unknown>) {
  const t = await tasks.getTask(c.claimId, a.taskId);
  if (!t) return;
  await c.reload();
  if (a.kind === "send_message" && t.type !== "relay_decision") {
    c.event(`follow-up to ${a.system} delivered (read-back)`);
    return; // a chase message never completes the task it chases
  }
  const h = handlerFor(t);
  const res = h.onConfirmed ? await h.onConfirmed(c, t, a, effect) : { task: "confirm" as const };
  if (res.task === "confirm") await confirmTask(c, t.taskId, res.note ?? `${a.kind} confirmed by read-back`);
  else if (res.task === "keep_open") await tasks.setTaskStatus(c.claimId, t.taskId, res.status ?? "waiting", { by: c.workerId, note: res.note });
  else await tasks.setTaskStatus(c.claimId, t.taskId, "pending", { by: c.workerId, note: res.note ?? "next action" });
}

/**
 * Verify one sent/acknowledged action: read back; confirmed -> task effects; missing -> retry with
 * the SAME key (up to config.maxVerifyRetries), then the "unverified after 3 retries" operator gate.
 */
export async function verifyAction(c: ClaimCtx, a: ActionDoc, opts: { force?: boolean; task?: TaskDoc | null } = {}): Promise<void> {
  if (a.status !== "sent" && a.status !== "acknowledged") return;
  const t = opts.task ?? (await tasks.getTask(c.claimId, a.taskId));
  if (t?.status === "blocked_drift") return; // the drift subflow owns it
  if (!opts.force && a.verifyAfter && a.verifyAfter.getTime() > clock.nowMs()) return;
  const r = await readBack(a, c.workerId);
  c.progress = true;
  if (r.confirmed) {
    c.event(`${a.taskId} ${a.system}.${a.kind} confirmed`);
    await onActionConfirmed(c, r.action, r.effect ?? {});
    return;
  }
  if (r.shapeError) {
    const d = await runDrift(c, { system: a.system as OutsideSystem, taskId: a.taskId, action: a, trigger: "readback_mismatch", error: r.shapeError });
    if (d.outcome) await handleOutcome(c, d.outcome, 1);
    return;
  }
  const retriesUsed = Math.max(0, a.attempts - 1);
  if (retriesUsed < config.maxVerifyRetries) {
    c.log("step 3 verify", `${a.taskId} ${a.kind}: read-back found nothing; retry ${retriesUsed + 1}/${config.maxVerifyRetries} with the same key ${a.idempotencyKey}`);
    try {
      await handleOutcome(c, await retry(a, c.workerId));
    } catch (e) {
      c.log("step 3 verify", `retry refused: ${errMsg(e)}`);
    }
    return;
  }
  if (await approvals.findPendingApproval(c.claimId, "unverified_after_retries", a.taskId)) return;
  await approvals.createApproval({
    claimId: c.claimId,
    actionId: String(a._id),
    taskId: a.taskId,
    gate: "unverified_after_retries",
    request: `${a.system}.${a.kind} for ${a.taskId} is still unverified after ${config.maxVerifyRetries} retries with key ${a.idempotencyKey}. Approve if you've confirmed it happened (closes it by hand); decline to cancel it and re-plan with a new key.`,
    details: { idempotencyKey: a.idempotencyKey, attempts: a.attempts, lastReadback: r.observed ?? null },
  });
  await actions.noteAction(a._id, `unverified after ${config.maxVerifyRetries} retries: operator gate`, c.workerId);
  await tasks.setTaskStatus(c.claimId, a.taskId, "awaiting_approval", { by: c.workerId, note: "action unverified after retries" });
  c.event(`${a.taskId}: unverified after ${config.maxVerifyRetries} retries, handed to an operator`);
}
