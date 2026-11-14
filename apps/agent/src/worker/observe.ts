import {
  actions, approvals, claims, clock, mintIdempotencyKey, observations, planTaskWithAction, tasks, timers,
  type ActionDoc, type ObservationDoc, type TimerDoc,
} from "../db.ts";
import { config } from "../config.ts";
import { execute } from "../executor/index.ts";
import { interpretInboundMessage, writeFollowUp } from "../llm/jobs.ts";
import { errMsg } from "../log.ts";
import { handleCall, runPromiseCheck } from "../phone/handleCall.ts";
import { runDrift } from "../subflows/drift.ts";
import { messageClaimant, notifyOperator, type ClaimCtx } from "./context.ts";
import { applyDecision } from "./decisions.ts";
import { chaseTarget, handlerFor, llmReview } from "./handlers.ts";
import { confirmTask, handleOutcome, verifyAction } from "./outcomes.ts";
import { medicalTaskIds } from "./taskGraph.ts";

const obj = (x: unknown) => (x && typeof x === "object" ? (x as Record<string, unknown>) : {});

/** Which wait tasks a webhook event is evidence for (a read-back still decides). */
const EVENT_TASKS: Record<string, (data: Record<string, unknown>) => string[]> = {
  "insurer.adjuster_assigned": () => ["T3"],
  "insurer.estimate_approved": () => ["T9"],
  "insurer.claim_status": () => ["T3", "T9"],
  "insurer.invoice_paid": (d) => [medicalTaskIds(String(d.invoiceId)).paid],
  "insurer.settlement_paid": () => ["T15"],
  "insurer.rental_paid": () => ["T18"],
  "body_shop.estimate_ready": () => ["T7"],
  "body_shop.status_changed": () => ["T7", "T11", "T16"],
  "body_shop.repair_progress": () => ["T11"],
  "body_shop.payment_received": () => ["T15"],
  "rental.reservation_status": () => [],
  "rental.reservation_created": () => [],
  "rental.reservation_extended": () => [],
  "rental.reservation_returned": () => [],
  "clinic.invoice_issued": () => [],
  "insurer.requirement_added": () => [],
};

/** Run a wait task's read-only proof check; confirm it when the system of record agrees. */
export async function checkWait(c: ClaimCtx, taskId: string): Promise<boolean> {
  const t = await tasks.getTask(c.claimId, taskId);
  if (!t) return false;
  if (t.type === "reconcile_close") {
    if (t.status === "waiting") await tasks.setTaskStatus(c.claimId, taskId, "pending", { by: c.workerId, note: "payment arrived; reconcile again" });
    return false;
  }
  if (t.status !== "waiting") return false;
  const h = handlerFor(t);
  if (!h.check) return false;
  await c.reload();
  const r = await h.check(c, t);
  if (r.done) {
    await confirmTask(c, taskId, r.note ?? "proof arrived");
    return true;
  }
  if (r.blockedStep) {
    const d = await runDrift(c, { system: "insurer", taskId, action: null, trigger: "new_required_step", error: r.note ?? `new required step ${r.blockedStep}`, step: r.blockedStep });
    if (d.outcome) await handleOutcome(c, d.outcome, 1);
  }
  return false;
}

/* ------------------------------------------------------------ observations */

async function onWebhook(c: ClaimCtx, o: ObservationDoc): Promise<{ matched: string | null; note: string }> {
  const data = obj(o.body.data);
  const key = o.body.key ? String(o.body.key) : null;
  let matched: string | null = null;
  // Match the webhook to the action it is about (by our idempotency key).
  if (key) {
    const a = await actions.findActionByKey(key);
    if (a) {
      matched = String(a._id);
      if (a.status === "sent" || a.status === "acknowledged") c.verifyNow.add(matched);
    }
  }
  const evt = `${o.source}.${o.kind}`;
  if (evt === "clinic.invoice_issued") {
    await spawnMedicalTasks(c, String(data.invoiceId), Number(data.amount), String(data.description ?? ""));
    return { matched, note: `T13/T14 created for ${data.invoiceId}` };
  }
  if (evt === "insurer.requirement_added") {
    c.recheck.add("T9");
    const t9 = await tasks.getTask(c.claimId, "T9");
    const exists = (await tasks.listTasks(c.claimId)).some((t) => t.params?.step === data.step);
    if (!exists && t9 && t9.status !== "confirmed") {
      const d = await runDrift(c, { system: "insurer", taskId: "T9", action: null, trigger: "new_required_step", error: `insurer added required step '${data.step}'`, step: String(data.step) });
      if (d.outcome) await handleOutcome(c, d.outcome, 1);
    }
    return { matched, note: `new required step ${data.step}` };
  }
  const fn = EVENT_TASKS[evt];
  if (!fn) {
    c.log("step 3 verify", `unrecognised webhook shape ${evt}; stored, not acted on`);
    return { matched, note: "unrecognised webhook (stored, not acted on)" };
  }
  for (const id of fn(data)) c.recheck.add(id);
  // A generic status ping: also read back anything unverified on that system.
  if (/status/.test(o.kind)) for (const a of await actions.listUnverified(c.claimId)) if (a.system === o.source) c.verifyNow.add(String(a._id));
  return { matched, note: `evidence for ${fn(data).join(", ") || "unverified actions"}` };
}

async function spawnMedicalTasks(c: ClaimCtx, invoiceId: string, amount: number, description: string) {
  const ids = medicalTaskIds(invoiceId);
  await claims.updateClaim(c.claimId, { [`facts.invoices.${invoiceId}`]: { amount, description } });
  const a = await tasks.insertTaskIfMissing({ claimId: c.claimId, taskId: ids.submit, type: "forward_invoice", title: `Forward medical invoice ${invoiceId}`, track: "medical", dependsOn: ["T2"], params: { invoiceId } });
  await tasks.insertTaskIfMissing({ claimId: c.claimId, taskId: ids.paid, type: "medical_reimbursement", title: `Reimbursement for ${invoiceId}`, track: "medical", dependsOn: [ids.submit], isWait: true, params: { invoiceId } });
  await tasks.addDependency(c.claimId, "T18", ids.submit);
  await tasks.addDependency(c.claimId, "T18", ids.paid);
  await claims.upsertMoneyItem(c.claimId, { ref: `invoice:${invoiceId}`, category: "medical", billed: amount });
  if (a) c.event(`clinic invoice ${invoiceId} $${amount}: created ${ids.submit} + ${ids.paid}`);
}

async function onClaimant(c: ClaimCtx, o: ObservationDoc): Promise<string> {
  if (o.kind === "intake") return "intake form (read by T1)";
  if (o.kind === "task_done") {
    const id = String(o.body.taskId ?? "");
    const t = id ? await tasks.getTask(c.claimId, id) : null;
    if (t && t.type === "claimant_request") await confirmTask(c, id, "claimant marked it done");
    else if (t?.taskId === "T16") c.recheck.add("T16");
    return `task_done ${id}`;
  }
  if (o.kind === "document") {
    for (const t of await tasks.listTasks(c.claimId, { status: ["waiting"] })) {
      if (t.type === "upload_step") await tasks.setTaskStatus(c.claimId, t.taskId, "pending", { by: c.workerId, note: "claimant uploaded a document" });
      if (t.type === "claimant_request") await confirmTask(c, t.taskId, `claimant uploaded ${o.body.docType ?? "a document"}`);
    }
    return "document";
  }
  // a free-text message
  const text = String(o.body.text ?? "");
  const open = (await tasks.listOpenTasks(c.claimId)).map((t) => `${t.taskId} ${t.title} (${t.status})`);
  const r = await interpretInboundMessage({ from: "claimant", text, compactSummary: c.claim.compactSummary, openTasks: open });
  if (!r.ok) {
    await llmReview(c, null, "interpretInboundMessage", r, "acknowledge the message (nothing is written)", { observationId: String(o._id) });
    return `message needs operator review (${r.reason})`;
  }
  const v = r.value;
  if (v.providedFields.length) {
    const set: Record<string, unknown> = {};
    for (const f of v.providedFields) set[`facts.providedFields.${f.field}`] = f.value;
    await claims.updateClaim(c.claimId, set);
    const t1 = await tasks.getTask(c.claimId, "T1");
    if (t1 && ["waiting", "awaiting_approval"].includes(t1.status)) await tasks.setTaskStatus(c.claimId, "T1", "pending", { by: c.workerId, note: "claimant provided details" });
    c.event(`claimant provided ${v.providedFields.map((f) => f.field).join(", ")}`);
  }
  if (v.needsReply && v.replyText) await messageClaimant(c, v.replyText);
  return `${v.intent}: ${v.summary.slice(0, 120)}`;
}

/** Step 3b: match every new observation, in arrival order, then mark it processed. */
export async function processObservations(c: ClaimCtx): Promise<number> {
  const list = await observations.listUnprocessed(c.claimId);
  for (const o of list) {
    let note = "";
    let matched: string | null = null;
    try {
      if (["insurer", "body_shop", "rental", "clinic"].includes(o.source)) ({ matched, note } = await onWebhook(c, o));
      else if (o.source === "approval_ui") {
        await applyDecision(c, o.body);
        matched = (o.body.actionId as string) ?? null;
        note = `decision ${o.body.decision}`;
      } else if (o.source === "claimant") note = await onClaimant(c, o);
      else if (o.source === "phone") {
        await handleCall(c, o);
        c.progress = true;
        continue; // handleCall marks it processed with its own verified flag
      } else note = "system";
    } catch (e) {
      note = `error: ${errMsg(e)}`;
      c.log("step 3 verify", `observation ${o.source}.${o.kind} failed: ${errMsg(e)}`);
    }
    await observations.markProcessed(o._id, c.workerId, { matchedActionId: matched, note });
    c.log("step 3 verify", `observation ${o.source}.${o.kind}${matched ? ` -> action ${matched.slice(-6)}` : ""}: ${note}`);
    c.progress = true;
  }
  return list.length;
}

/* ------------------------------------------------------------------ timers */

async function chase(c: ClaimCtx, timer: TimerDoc) {
  const t = await tasks.getTask(c.claimId, timer.taskId);
  if (!t || ["confirmed", "denied", "closed_by_human"].includes(t.status)) return;
  if (t.type === "reconcile_close") {
    await tasks.updateTaskFields(c.claimId, t.taskId, { "params.paymentOverdue": true });
    await tasks.setTaskStatus(c.claimId, t.taskId, "pending", { by: c.workerId, note: "payment overdue: reconcile and hand gaps to an operator" });
    return;
  }
  if (await checkWait(c, t.taskId)) return; // maybe the webhook was dropped: read back first
  const target = chaseTarget(c, t);
  const level = timer.escalationLevel;
  if (target.system === "claimant") {
    await messageClaimant(c, `Reminder: ${target.purpose}.`, { taskId: t.taskId });
  } else if (target.ref) {
    const f = await writeFollowUp({ to: target.system, purpose: target.purpose, facts: { claimRef: target.ref, claimId: c.claimId, waitingSince: (t.updatedAt ?? t.createdAt ?? clock.now()).toISOString() }, escalationLevel: level });
    if (!f.ok) await llmReview(c, t, "writeFollowUp", f, "send no follow-up this time");
    else {
      const attempt = (await actions.countActionsForTask(c.claimId, t.taskId, "send_message")) + 1;
      const { action } = await planTaskWithAction({ claimId: c.claimId, taskId: t.taskId, status: t.status, note: `chase ${target.system} (level ${level})`, by: c.workerId }, {
        claimId: c.claimId,
        taskId: t.taskId,
        system: target.system,
        kind: "send_message",
        idempotencyKey: mintIdempotencyKey(c.claimId, t.taskId, "send_message", attempt),
        payload: { ref: target.ref, text: f.value.text },
        expectedEffect: { messageStored: true },
        verifyBy: "readback",
        deadline: new Date(clock.nowMs() + config.actionDeadlineSim),
      });
      await handleOutcome(c, await execute(action, c.workerId));
    }
  }
  if (level >= 1) await notifyOperator(c, `Escalation: still no ${target.purpose} for ${t.taskId} after ${level + 1} follow-ups.`);
  if (level < 2) await timers.createTimer({ claimId: c.claimId, taskId: t.taskId, rule: timer.rule, dueAt: new Date(clock.nowMs() + (timer.rule === "claimant_reminder" ? config.claimantReminderSim : config.chaseAfterSim)), escalationLevel: level + 1 });
  c.event(`chased ${target.system} for ${t.taskId} (level ${level})`);
}

async function onTimer(c: ClaimCtx, timer: TimerDoc) {
  switch (timer.rule) {
    case "verify_action": {
      const a = timer.actionId ? await actions.getAction(timer.actionId) : null;
      if (a) c.verifyNow.add(String(a._id));
      return;
    }
    case "chase_party":
    case "payment_overdue":
      return chase(c, timer);
    case "rental_expiring": {
      const t11 = await tasks.getTask(c.claimId, "T11");
      const t12 = await tasks.getTask(c.claimId, "T12");
      if (!t12 || t11?.status === "confirmed" || ["confirmed", "closed_by_human"].includes(t12.status)) return;
      await tasks.updateTaskFields(c.claimId, "T12", { triggeredAt: clock.now() });
      await tasks.setTaskStatus(c.claimId, "T12", "pending", { by: c.workerId, note: `rental_expiring: ends ${timer.params?.endDate}, repair not ready` });
      c.event(`rental ends ${timer.params?.endDate} and the repair isn't ready: T12 armed`);
      return;
    }
    case "claimant_reminder": {
      if (timer.approvalId) {
        const ap = await approvals.getApproval(timer.approvalId);
        if (!ap || ap.status !== "pending") return;
        await messageClaimant(c, `Reminder: we're waiting for your decision: ${ap.request}`, { approvalId: timer.approvalId });
        if (timer.escalationLevel < 3) await timers.createTimer({ claimId: c.claimId, taskId: timer.taskId, rule: "claimant_reminder", dueAt: new Date(clock.nowMs() + config.claimantReminderSim), approvalId: timer.approvalId, escalationLevel: timer.escalationLevel + 1 });
        c.event("claimant reminded about a pending decision");
        return;
      }
      return chase(c, timer);
    }
    case "promise_check":
      return runPromiseCheck(c, timer.params ?? {});
  }
}

/** Step 3a: due timers for this claim (compare-and-set fired, so two workers never fire one twice). */
export async function processTimers(c: ClaimCtx): Promise<number> {
  const due = await timers.dueTimers(clock.now(), c.claimId);
  let n = 0;
  for (const t of due) {
    if (!(await timers.markFired(t._id))) continue;
    n++;
    c.log("step 3 verify", `timer ${t.rule} for ${t.taskId}${t.escalationLevel ? ` (level ${t.escalationLevel})` : ""} fired`);
    try {
      await onTimer(c, t);
    } catch (e) {
      c.log("step 3 verify", `timer ${t.rule} failed: ${errMsg(e)}`);
    }
    c.progress = true;
  }
  return n;
}

/** Step 3c: verify every sent/acknowledged action that is due (or matched by a webhook/timer). */
export async function verifyUnverified(c: ClaimCtx): Promise<void> {
  const list: ActionDoc[] = await actions.listUnverified(c.claimId);
  for (const a of list) {
    const forced = c.verifyNow.has(String(a._id));
    await verifyAction(c, a, { force: forced });
  }
  c.verifyNow.clear();
  for (const id of [...c.recheck]) await checkWait(c, id);
  c.recheck.clear();
}
