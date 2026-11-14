import {
  actions, approvals, claims, clock, findReadyTasks, leases, mintIdempotencyKey, observations, planTaskWithAction, tasks, timers,
  type ActionDoc, type TaskDoc,
} from "@claims/db";
import { config } from "../config.ts";
import { execute, GateError } from "../executor/index.ts";
import { pickNextTask, summarizeClaim } from "../llm/jobs.ts";
import { errMsg } from "../log.ts";
import { runRecovery } from "../subflows/recovery.ts";
import { ClaimCtx } from "./context.ts";
import { handlerFor, type Plan } from "./handlers.ts";
import { checkWait, processObservations, processTimers, verifyUnverified } from "./observe.ts";
import { confirmTask, handleOutcome } from "./outcomes.ts";
import { taskRank } from "./taskGraph.ts";

export interface WorkerState {
  workerId: string;
  /** Claims this process has already run crash recovery for. */
  recovered: Set<string>;
  /** Claims whose lease this process holds (renewed by the heartbeat). */
  held: Set<string>;
  /** Claims taken over from a worker that stopped renewing (recovery reason). */
  takenOver: Set<string>;
}

/* ============================================================ the 10 steps */

/** Step 1: take the claim lease (conditional findOneAndUpdate). Renewed by the heartbeat. */
async function step1Lease(c: ClaimCtx, w: WorkerState): Promise<boolean> {
  const had = w.held.has(c.claimId);
  const prev = had ? null : await leases.getLease(c.claimId);
  const ok = await leases.acquireLease(c.claimId, w.workerId, config.leaseTtlMs);
  if (!ok) {
    w.held.delete(c.claimId);
    return false;
  }
  if (!had) {
    w.held.add(c.claimId);
    const takeover = prev && prev.workerId !== w.workerId;
    c.log("step 1 lease", takeover ? `took over the lease from ${prev!.workerId} (expired ${prev!.expiresAt.toISOString()})` : "lease acquired");
    if (takeover) {
      w.recovered.delete(c.claimId);
      w.takenOver.add(c.claimId);
    }
  }
  return true;
}

/** Step 2: load compactSummary + open tasks. Never any conversation history. */
async function step2Load(c: ClaimCtx): Promise<TaskDoc[]> {
  await c.reload();
  const open = await tasks.listOpenTasks(c.claimId);
  return open;
}

/** Step 3: verify first. Timers, new observations, then read back every unverified action. */
async function step3Verify(c: ClaimCtx, w: WorkerState): Promise<void> {
  if (!w.recovered.has(c.claimId)) {
    await runRecovery(c, w.takenOver.delete(c.claimId) ? "lease_takeover" : "startup");
    w.recovered.add(c.claimId);
  }
  await processTimers(c);
  await processObservations(c);
  await verifyUnverified(c);
}

/** Step 4: ready tasks from the dependency graph (plain code). */
async function step4Ready(c: ClaimCtx): Promise<TaskDoc[]> {
  const ready = await findReadyTasks(c.claimId);
  for (const t of ready) if (t.status === "pending") await tasks.setTaskStatus(c.claimId, t.taskId, "ready", { by: c.workerId, note: "dependencies confirmed" });
  if (ready.length) c.log("step 4 ready", ready.map((t) => t.taskId).join(", "));
  return ready;
}

/** Step 5: if several are ready the LLM picks the order; code checks every pick is in the ready set. */
async function step5Order(c: ClaimCtx, ready: TaskDoc[]): Promise<TaskDoc[]> {
  const byRank = [...ready].sort((a, b) => taskRank(a.taskId) - taskRank(b.taskId));
  if (ready.length < 2) return byRank;
  const r = await pickNextTask({ ready: ready.map((t) => ({ taskId: t.taskId, title: t.title, track: t.track })), compactSummary: c.claim.compactSummary });
  if (!r.ok) {
    c.log("step 5 order", `pickNextTask failed (${r.reason}); using graph order`);
    return byRank;
  }
  const ids = new Set(ready.map((t) => t.taskId));
  const picks = r.value.order.filter((id, i, arr) => arr.indexOf(id) === i);
  const invalid = picks.filter((id) => !ids.has(id));
  if (invalid.length) {
    c.log("step 5 order", `LLM picked tasks outside the ready set (${invalid.join(", ")}); rejected, using graph order`);
    return byRank;
  }
  const ordered = [...picks.map((id) => ready.find((t) => t.taskId === id)!), ...byRank.filter((t) => !picks.includes(t.taskId))];
  c.log("step 5 order", `${ordered.map((t) => t.taskId).join(" > ")}${r.value.rationale ? ` (${r.value.rationale.slice(0, 80)})` : ""}`);
  return ordered;
}

/** Step 6: the handler builds the payload + expectedEffect; code mints or reuses the idempotency key. */
async function step6Plan(c: ClaimCtx, t: TaskDoc): Promise<Plan | null> {
  const open = await actions.listOpenForTask(c.claimId, t.taskId);
  if (open.length) {
    c.log("step 6 plan", `${t.taskId} already has an open action (${open[0]!.status}); not planning another`);
    return null;
  }
  await c.reload();
  const plan = await handlerFor(t).plan(c, t);
  c.log("step 6 plan", `${t.taskId} ${t.type}: ${plan.type}${plan.type === "action" ? ` ${plan.system}.${plan.kind}${plan.gate ? ` [gate ${plan.gate}]` : ""}` : ` (${plan.note})`}`);
  return plan;
}

/** Step 7: one transaction (task + action [+ approval]). Then step 8 executes. */
async function step7Commit(c: ClaimCtx, t: TaskDoc, plan: Extract<Plan, { type: "action" }>): Promise<ActionDoc> {
  const attempt = (await actions.countActionsForTask(c.claimId, t.taskId, plan.kind)) + 1;
  const key = mintIdempotencyKey(c.claimId, t.taskId, plan.kind, attempt);
  const gate = plan.gate ?? null;
  const { action, approvalId } = await planTaskWithAction(
    null,
    { claimId: c.claimId, taskId: t.taskId, status: "in_progress", note: plan.note ?? `${plan.kind} planned`, by: c.workerId },
    {
      claimId: c.claimId,
      taskId: t.taskId,
      system: plan.system,
      kind: plan.kind,
      idempotencyKey: key,
      payload: plan.payload,
      expectedEffect: plan.expectedEffect,
      verifyBy: plan.verifyBy ?? "readback",
      deadline: new Date(clock.nowMs() + config.actionDeadlineSim),
      gate,
      supersedes: plan.supersedes ?? null,
      by: c.workerId,
      note: plan.note,
    },
    gate ? { taskId: t.taskId, gate, request: plan.gateRequest ?? `Approve ${plan.kind}?`, details: { payload: plan.payload, ...(plan.gateDetails ?? {}) } } : undefined,
  );
  c.log("step 7 commit", `${t.taskId}: action ${plan.kind} key=${key}${gate ? ` -> awaiting_approval (${gate})` : " planned"} [transaction]`);
  if (approvalId) {
    await timers.createTimer({ claimId: c.claimId, taskId: t.taskId, rule: "claimant_reminder", dueAt: new Date(clock.nowMs() + config.claimantReminderSim), approvalId, actionId: String(action._id) });
    c.event(`${t.taskId} needs ${gate} approval`);
  } else c.event(`${t.taskId} planned ${plan.kind}`);
  return action;
}

/** Step 8: execute every planned/approved action (safe to repeat: same idempotency key). */
async function step8Execute(c: ClaimCtx): Promise<void> {
  const todo = await actions.listActions(c.claimId, { status: ["planned", "approved"] });
  for (const a of todo) {
    try {
      await handleOutcome(c, await execute(a, c.workerId));
    } catch (e) {
      if (e instanceof GateError) c.log("step 8 execute", `refused by gate check: ${e.message}`);
      else c.log("step 8 execute", `${a.taskId} ${a.kind} failed: ${errMsg(e)}`);
    }
  }
}

async function applyNonAction(c: ClaimCtx, t: TaskDoc, plan: Exclude<Plan, { type: "action" }>) {
  switch (plan.type) {
    case "confirm":
      await confirmTask(c, t.taskId, plan.note);
      break;
    case "deny":
      await tasks.setTaskStatus(c.claimId, t.taskId, "denied", { by: c.workerId, note: plan.note });
      c.event(`${t.taskId} denied: ${plan.note}`);
      break;
    case "hold":
      if (t.status !== plan.status) {
        await tasks.setTaskStatus(c.claimId, t.taskId, plan.status, { by: c.workerId, note: plan.note });
        c.event(`${t.taskId} ${plan.status}: ${plan.note}`);
      }
      break;
    case "wait":
      await tasks.setTaskStatus(c.claimId, t.taskId, "waiting", { by: c.workerId, note: plan.note });
      if (plan.chase) await timers.ensureTimer({ claimId: c.claimId, taskId: t.taskId, rule: plan.chase.rule, dueAt: new Date(clock.nowMs() + plan.chase.afterSim) });
      c.event(`${t.taskId} waiting: ${plan.note}`);
      await checkWait(c, t.taskId); // the proof may already be there
      break;
  }
}

/** Step 9: timers, compact summary (LLM, <= 2k chars), money totals, renew the lease. */
async function step9Bookkeeping(c: ClaimCtx, w: WorkerState): Promise<void> {
  await claims.recomputeMoneyTotals(c.claimId);
  if (c.events.length) {
    await c.reload();
    const all = await tasks.listTasks(c.claimId);
    const r = await summarizeClaim({
      previousSummary: c.claim.compactSummary,
      claimFacts: { claimId: c.claimId, claimant: c.claim.claimant.name, phase: c.claim.phase, insurerClaimNo: c.ext("insurerClaimNo"), bookingId: c.ext("bookingId"), reservationId: c.ext("reservationId"), policy: c.claim.policy },
      tasks: all.map((t) => ({ taskId: t.taskId, title: t.title, status: t.status })),
      recentEvents: c.events.slice(-20),
      money: c.claim.money.totals,
    });
    if (r.ok) await claims.setCompactSummary(c.claimId, r.value.summary);
    else c.log("step 9 bookkeeping", `summary not updated (${r.reason}); keeping the previous one`);
  }
  await leases.renewLease(c.claimId, w.workerId, config.leaseTtlMs);
}

/** Step 10: sleep until the next wake-up (change stream, due timer, or lease sweep). */
async function step10Sleep(c: ClaimCtx) {
  const next = (await timers.listOpenTimers(c.claimId))[0];
  const pend = (await approvals.listApprovals(c.claimId, "pending")).length;
  c.log("step 10 sleep", `until next event${next ? ` or timer ${next.rule}/${next.taskId} at ${next.dueAt.toISOString().slice(5, 16)} (sim)` : ""}${pend ? `; ${pend} approval(s) pending` : ""}`);
}

/* =========================================================== entry point */

/** Run the agent loop for one claim until there is nothing left to do this wake-up. */
export async function runClaim(claimId: string, w: WorkerState): Promise<void> {
  const c = new ClaimCtx(claimId, w.workerId);
  if (!(await claims.getClaim(claimId))) return;
  if (!(await step1Lease(c, w))) {
    c.log("step 1 lease", "held by another worker; skipping");
    return;
  }
  for (let i = 0; i < config.maxIterationsPerWake; i++) {
    c.progress = false;
    if (!(await leases.renewLease(claimId, w.workerId, config.leaseTtlMs))) {
      c.log("step 1 lease", "lost the lease mid-run; stopping");
      w.held.delete(claimId);
      return;
    }
    await step2Load(c);
    if (c.claim.phase === "closed" && !(await observations.listUnprocessed(claimId)).length) break;
    await step3Verify(c, w);
    const ready = await step4Ready(c);
    const ordered = await step5Order(c, ready);
    for (const t of ordered) {
      const plan = await step6Plan(c, t);
      if (!plan) continue;
      if (plan.type === "action") await step7Commit(c, t, plan);
      else await applyNonAction(c, t, plan);
    }
    await step8Execute(c);
    await step9Bookkeeping(c, w);
    if (!c.progress) break;
    c.events = []; // each iteration's events are summarised once, in its own step 9
  }
  await step10Sleep(c);
}
