import { z } from "zod";
import {
  actions, approvals, claims, clock, documents, observations, tasks, timers,
  type ActionDoc, type Gate, type TaskDoc, type TaskStatus, type TimerRule,
} from "../db.ts";
import { config } from "../config.ts";
import { getter } from "../executor/index.ts";
import { reads } from "../executor/adapters.ts";
import { extractAccidentDetails } from "../llm/jobs.ts";
import type { LlmFailure } from "../llm/client.ts";
import { messageClaimant, type ClaimCtx } from "./context.ts";

/* ------------------------------------------------------------------- types */

export type Plan =
  | {
      type: "action";
      system: "insurer" | "body_shop" | "rental" | "clinic";
      kind: string;
      payload: Record<string, unknown>;
      expectedEffect: Record<string, unknown>;
      verifyBy?: "readback" | "readback_or_webhook";
      gate?: Gate | null;
      gateRequest?: string;
      gateDetails?: Record<string, unknown>;
      supersedes?: string | null;
      note?: string;
    }
  | { type: "wait"; note: string; chase?: { rule: TimerRule; afterSim: number } }
  | { type: "confirm"; note: string }
  | { type: "deny"; note: string }
  | { type: "hold"; note: string; status: TaskStatus };

export interface CheckResult {
  done: boolean;
  note?: string;
  /** T9: the insurer wants a workflow step we have no task for (drift: new required step). */
  blockedStep?: string;
}

export type AfterConfirm = { task: "confirm" | "keep_open" | "replan"; status?: TaskStatus; note?: string };

export interface Handler {
  plan(c: ClaimCtx, t: TaskDoc): Promise<Plan>;
  /** Read-only proof check for wait tasks. Never writes to an outside system. */
  check?(c: ClaimCtx, t: TaskDoc): Promise<CheckResult>;
  onConfirmed?(c: ClaimCtx, t: TaskDoc, a: ActionDoc, effect: Record<string, unknown>): Promise<AfterConfirm>;
}

/* ----------------------------------------------------------------- helpers */

const today = () => clock.now().toISOString().slice(0, 10);
const dayOffset = (d: number) => new Date(clock.nowMs() + d * clock.DAY).toISOString().slice(0, 10);
const obj = (x: unknown) => (x && typeof x === "object" ? (x as Record<string, unknown>) : {});
const facts = (c: ClaimCtx) => obj(c.claim.facts);
const invoiceFacts = (c: ClaimCtx, inv: string) => obj(obj(facts(c).invoices)[inv]);

export async function hasDeclined(c: ClaimCtx, taskId: string, gate: Gate): Promise<boolean> {
  return (await approvals.listApprovals(c.claimId, "declined")).some((a) => a.taskId === taskId && a.gate === gate);
}
async function hasApproved(c: ClaimCtx, gate: Gate): Promise<boolean> {
  return (await approvals.listApprovals(c.claimId, "approved")).some((a) => a.gate === gate);
}
async function confirmedAction(c: ClaimCtx, taskId: string, kind: string) {
  return (await actions.listActions(c.claimId, { taskId, status: ["confirmed", "closed_by_human"] })).find((a) => a.kind === kind) ?? null;
}

async function insurerClaim(c: ClaimCtx) {
  const no = c.ext("insurerClaimNo");
  if (!no) return null;
  const r = await reads.insurerClaim(getter("insurer"), no);
  return r.status === 200 ? obj(r.json) : null;
}
async function booking(c: ClaimCtx) {
  const id = c.ext("bookingId");
  if (!id) return null;
  const r = await reads.booking(getter("body_shop"), id);
  return r.status === 200 ? obj(r.json) : null;
}

/** An LLM answer that is malformed/refused/low-confidence goes to an operator; nothing else is written. */
export async function llmReview(c: ClaimCtx, t: TaskDoc | null, job: string, f: LlmFailure, onApprove: string, extra: Record<string, unknown> = {}) {
  const existing = await approvals.findPendingApproval(c.claimId, "llm_review", t?.taskId);
  if (existing) return existing._id.toString();
  const id = await approvals.createApproval({
    claimId: c.claimId,
    actionId: null,
    taskId: t?.taskId ?? null,
    gate: "llm_review",
    request: `The ${job} result needs a human: ${f.reason} (${f.detail.slice(0, 160)}). Approve to ${onApprove}; decline to leave it for manual handling.`,
    details: { job, reason: f.reason, detail: f.detail, raw: f.raw ?? null, onApprove, ...extra },
  });
  c.log("llm", `${job} -> operator review (${f.reason})`);
  c.event(`${job} sent to operator review (${f.reason})`);
  return id;
}

/* ================================================================ handlers */

const RequiredDetails = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  place: z.string().min(2),
  policyNumber: z.string().regex(/^POL-\d{3,}$/),
  description: z.string().min(3),
});

const T1: Handler = {
  async plan(c, t) {
    const obs = (await observations.listObservations(c.claimId)).reverse();
    const intake = obs.find((o) => o.source === "claimant" && o.kind === "intake");
    const messages = obs.filter((o) => o.source === "claimant" && o.kind === "message").map((o) => String(o.body.text ?? ""));
    const form = { ...obj(intake?.body.form), ...obj(facts(c).providedFields) };
    const r = await extractAccidentDetails({ form, messages });
    if (!r.ok) {
      await llmReview(c, t, "extractAccidentDetails", r, "accept the intake form as submitted and confirm T1");
      return { type: "hold", status: "awaiting_approval", note: "extraction needs operator review" };
    }
    const d = r.value;
    // Code, not the model, decides whether the form is complete: schema validation.
    const v = RequiredDetails.safeParse({ date: d.date, place: d.place, policyNumber: d.policyNumber, description: d.description });
    const missing = v.success ? [] : [...new Set(v.error.issues.map((i) => String(i.path[0])))];
    await claims.updateClaim(c.claimId, {
      "accident.date": d.date ?? c.claim.accident.date,
      "accident.place": d.place ?? c.claim.accident.place,
      "accident.description": d.description ?? c.claim.accident.description,
      "accident.policeReportNumber": d.policeReportNumber,
      "accident.injuries": d.injuries || c.claim.accident.injuries,
      "accident.mentionsFault": d.mentionsFault,
      "facts.faultStatement": d.faultStatement,
      "accident.otherDriver": d.otherDriver,
      ...(d.policyNumber ? { "policy.number": d.policyNumber } : {}),
    });
    if (missing.length) {
      const asked = (facts(c).askedMissing as string[] | undefined)?.join(",");
      if (asked !== missing.join(",")) {
        await messageClaimant(c, `To open your claim we still need: ${missing.join(", ")}. Reply here with the details.`, { taskId: "T1", missing });
        await claims.updateClaim(c.claimId, { "facts.askedMissing": missing });
        await timers.ensureTimer({ claimId: c.claimId, taskId: "T1", rule: "claimant_reminder", dueAt: new Date(clock.nowMs() + config.claimantReminderSim) });
      }
      return { type: "hold", status: "waiting", note: `waiting on claimant for ${missing.join(", ")}` };
    }
    return { type: "confirm", note: `form passes schema validation (extracted with confidence ${d.confidence})` };
  },
};

const T2: Handler = {
  async plan(c, t) {
    const declinedFault = await hasDeclined(c, t.taskId, "discuss_fault");
    const fault = !!c.claim.accident.mentionsFault && !declinedFault;
    const description = declinedFault ? "Two-vehicle collision. Fault not stated." : c.claim.accident.description;
    return {
      type: "action",
      system: "insurer",
      kind: "create_claim",
      payload: {
        policyNumber: c.claim.policy.number,
        lossDate: c.claim.accident.date,
        location: c.claim.accident.place,
        description,
        vehicleVin: c.claim.vehicle.vin,
        externalRef: c.claimId,
        otherParty: c.claim.accident.otherDriver ?? null,
        injuries: c.claim.accident.injuries,
        policeReportNumber: c.claim.accident.policeReportNumber,
      },
      expectedEffect: { claimExistsForKey: true, externalRef: c.claimId },
      gate: fault ? "discuss_fault" : null,
      gateRequest: fault ? `Your description includes a statement about fault: "${String(facts(c).faultStatement ?? c.claim.accident.description).slice(0, 200)}". Approve sending it to the insurer as written? Decline and we'll send a neutral description instead.` : undefined,
    };
  },
  async onConfirmed(c, _t, _a, e) {
    await claims.updateClaim(c.claimId, { "external.insurerClaimNo": e.claimNo, phase: "open" });
    c.event(`insurer claim ${e.claimNo} opened (read-back)`);
    return { task: "confirm" };
  },
};

const T3: Handler = {
  async plan() {
    return { type: "wait", note: "waiting for adjuster assignment", chase: { rule: "chase_party", afterSim: config.chaseAfterSim } };
  },
  async check(c) {
    const ic = await insurerClaim(c);
    const adj = obj(ic?.adjuster);
    if (!adj.name) return { done: false };
    await claims.updateClaim(c.claimId, { "external.adjuster": adj });
    return { done: true, note: `read-back shows adjuster ${adj.name}` };
  },
};

const T4: Handler = {
  async plan(c) {
    return { type: "action", system: "insurer", kind: "get_policy", payload: { policyNumber: c.claim.policy.number }, expectedEffect: { rentalLimitsStored: true } };
  },
  async onConfirmed(c, _t, _a, e) {
    await claims.updateClaim(c.claimId, { "policy.rentalDailyLimit": e.rentalDailyLimit, "policy.rentalMaxDays": e.rentalMaxDays, "policy.deductible": e.deductible ?? null });
    c.event(`rental coverage: $${e.rentalDailyLimit}/day, max ${e.rentalMaxDays} days`);
    return { task: "confirm" };
  },
};

const T5: Handler = {
  async plan(c, t) {
    const limit = Number(c.claim.policy.rentalDailyLimit ?? 40);
    const maxDays = Number(c.claim.policy.rentalMaxDays ?? 10);
    const requested = Number(facts(c).rentalDaysRequested ?? 10);
    const beyond = requested > maxDays && !(await hasDeclined(c, t.taskId, "rental_overage"));
    const days = beyond ? requested : Math.min(requested, maxDays);
    return {
      type: "action",
      system: "rental",
      kind: "create_reservation",
      payload: { claimRef: c.claimId, vehicleClass: "compact", startDate: today(), days, dailyRate: Math.min(40, limit), customerName: c.claim.claimant.name },
      expectedEffect: { reservationExistsWithKey: true, days },
      gate: beyond ? "rental_overage" : null,
      gateRequest: beyond ? `Book ${days} rental days? Your policy covers ${maxDays}; you would pay the extra ${days - maxDays} days.` : undefined,
    };
  },
  async onConfirmed(c, _t, _a, e) {
    await claims.updateClaim(c.claimId, { "external.reservationId": e.reservationId, "facts.rental": { startDate: e.startDate, endDate: e.endDate, days: e.days, dailyRate: e.dailyRate } });
    await armRentalExpiring(c, String(e.endDate));
    c.event(`rental ${e.reservationId} booked until ${e.endDate} (read-back by key)`);
    return { task: "confirm" };
  },
};

export async function armRentalExpiring(c: ClaimCtx, endDate: string) {
  await timers.cancelTimersForTask(c.claimId, "T12", ["rental_expiring"]);
  const due = Math.max(clock.nowMs(), Date.parse(endDate) + 9 * clock.HOUR - config.rentalExpiringLeadSim);
  await timers.createTimer({ claimId: c.claimId, taskId: "T12", rule: "rental_expiring", dueAt: new Date(due), params: { endDate } });
}

const T6: Handler = {
  async plan(c) {
    return {
      type: "action",
      system: "body_shop",
      kind: "create_booking",
      payload: { claimRef: c.claimId, insurerClaimNo: c.ext("insurerClaimNo"), vehicleVin: c.claim.vehicle.vin, dropOffDate: dayOffset(1), customerName: c.claim.claimant.name },
      expectedEffect: { bookingExistsWithKey: true },
    };
  },
  async onConfirmed(c, _t, _a, e) {
    await claims.updateClaim(c.claimId, { "external.bookingId": e.bookingId });
    c.event(`body shop booking ${e.bookingId} (read-back by key)`);
    return { task: "confirm" };
  },
};

const T7: Handler = {
  async plan() {
    return { type: "wait", note: "waiting for the shop's estimate", chase: { rule: "chase_party", afterSim: config.chaseAfterSim } };
  },
  async check(c) {
    const b = await booking(c);
    const est = obj(b?.estimate);
    if (!est.estimateId) return { done: false };
    // Save the PDF to GridFS once (the proof the estimate exists on our side too).
    const known = obj(facts(c).estimate);
    let documentId = known.estimateId === est.estimateId && known.documentId ? String(known.documentId) : "";
    if (!documentId) {
      const res = await fetch(`${config.mocksUrl}/body_shop/bookings/${c.ext("bookingId")}/estimate.pdf`);
      if (!res.ok) return { done: false, note: "estimate PDF not downloadable yet" };
      const data = Buffer.from(await res.arrayBuffer());
      const lines = (est.lines as { item: string; amount: number }[]) ?? [];
      documentId = await documents.putDocument({
        claimId: c.claimId,
        docType: "estimate",
        source: "body_shop",
        filename: `${est.estimateId}.pdf`,
        contentType: "application/pdf",
        data,
        extractedText: `Repair estimate ${est.estimateId} total ${est.amount}. ${lines.map((l) => `${l.item} ${l.amount}`).join("; ")}`,
      });
    }
    await claims.updateClaim(c.claimId, { "facts.estimate": { estimateId: est.estimateId, amount: est.amount, lines: est.lines, documentId } });
    await claims.upsertMoneyItem(c.claimId, { ref: `estimate:${est.estimateId}`, category: "repair", billed: Number(est.amount) });
    return { done: true, note: `estimate ${est.estimateId} $${est.amount} saved to GridFS` };
  },
};

const T8: Handler = {
  async plan(c) {
    const est = obj(facts(c).estimate);
    let pdfBase64: string | null = null;
    const doc = est.documentId ? await documents.getDocumentMeta(String(est.documentId)) : null;
    if (doc?.gridfsId) pdfBase64 = (await documents.getFile(doc.gridfsId as never)).toString("base64");
    return {
      type: "action",
      system: "insurer",
      kind: "submit_estimate",
      payload: { policyNumber: c.claim.policy.number, amount: Number(est.amount), shopRef: c.ext("bookingId"), lines: est.lines ?? [], pdfBase64 },
      expectedEffect: { estimateAttachedWithKey: true, amount: Number(est.amount) },
    };
  },
  async onConfirmed(c, _t, a) {
    const est = obj(facts(c).estimate);
    await claims.upsertMoneyItem(c.claimId, { ref: `estimate:${est.estimateId}`, category: "repair", submitted: Number(a.payload.amount) });
    return { task: "confirm" };
  },
};

const T9: Handler = {
  async plan() {
    return { type: "wait", note: "waiting for the insurer's approval", chase: { rule: "chase_party", afterSim: config.chaseAfterSim } };
  },
  async check(c) {
    const ic = await insurerClaim(c);
    if (!ic) return { done: false };
    if (ic.estimateStatus === "approved") {
      const est = ((ic.estimates as unknown[]) ?? []).map(obj).find((e) => e.status === "approved");
      await claims.updateClaim(c.claimId, { "facts.approvedAmount": est?.approvedAmount ?? null, "external.offer": ic.offer ?? null });
      return { done: true, note: `read-back: estimate approved for $${est?.approvedAmount}` };
    }
    const missing = ((ic.requirements as unknown[]) ?? []).map(obj).filter((r) => r.status === "missing").map((r) => String(r.step));
    for (const step of missing) {
      const all = await tasks.listTasks(c.claimId);
      if (!all.some((x) => x.params?.step === step)) return { done: false, blockedStep: step, note: `insurer requires '${step}'` };
    }
    return { done: false };
  },
};

const T10: Handler = {
  async plan(c) {
    return {
      type: "action",
      system: "body_shop",
      kind: "authorize_repair",
      payload: { approvedAmount: Number(facts(c).approvedAmount), insurerClaimNo: c.ext("insurerClaimNo") },
      expectedEffect: { status: "in_repair" },
    };
  },
  async onConfirmed() {
    return { task: "confirm" };
  },
};

const T11: Handler = {
  async plan() {
    return { type: "wait", note: "tracking the repair", chase: { rule: "chase_party", afterSim: config.chaseAfterSim } };
  },
  async check(c) {
    const b = await booking(c);
    if (!b || !["ready", "released"].includes(String(b.status))) return { done: false };
    return { done: true, note: `read-back: body shop status ${b.status}` };
  },
};

const T12: Handler = {
  async plan(c, t) {
    const t11 = await tasks.getTask(c.claimId, "T11");
    const rental = obj(facts(c).rental);
    if (t11?.status === "confirmed") return { type: "confirm", note: `repair ready; rental end ${rental.endDate} covers it` };
    if (!t.triggeredAt) return { type: "hold", status: "waiting", note: `armed: acts on the rental_expiring timer (rental ends ${rental.endDate})` };
    const maxDays = Number(c.claim.policy.rentalMaxDays ?? 21);
    const cur = Number(rental.days ?? 0);
    let days = cur + 4;
    let gate: Gate | null = null;
    if (days > maxDays) {
      if (await hasDeclined(c, t.taskId, "rental_overage")) days = maxDays;
      else gate = "rental_overage";
    }
    if (days <= cur) {
      await messageClaimant(c, `Your rental has reached the ${maxDays}-day coverage limit and the repair isn't finished. We won't extend it further without your approval.`);
      return { type: "hold", status: "waiting", note: "at coverage limit; claimant declined extra days" };
    }
    return {
      type: "action",
      system: "rental",
      kind: "extend_reservation",
      payload: { days },
      expectedEffect: { days },
      gate,
      gateRequest: gate ? `The repair is running late. Extend the rental to ${days} days? Coverage is ${maxDays} days, so you'd pay ${days - maxDays} extra day(s).` : undefined,
      note: `repair not ready ${config.rentalExpiringLeadSim / clock.DAY} days before rental end ${rental.endDate}`,
    };
  },
  async onConfirmed(c, _t, _a, e) {
    const rental = obj(facts(c).rental);
    await claims.updateClaim(c.claimId, { "facts.rental": { ...rental, endDate: e.endDate, days: e.days } });
    await tasks.updateTaskFields(c.claimId, "T12", { triggeredAt: null });
    await armRentalExpiring(c, String(e.endDate));
    c.event(`rental extended to ${e.days} days, ends ${e.endDate} (read-back)`);
    return { task: "keep_open", status: "waiting", note: `extended to ${e.days} days; re-armed` };
  },
};

const T13: Handler = {
  async plan(c, t) {
    const inv = String(t.params.invoiceId);
    const f = invoiceFacts(c, inv);
    const prior = await actions.listActions(c.claimId, { taskId: t.taskId });
    const rejected = prior.filter((a) => a.kind === "submit_medical_invoice" && a.status === "rejected");
    return {
      type: "action",
      system: "insurer",
      kind: "submit_medical_invoice",
      payload: { policyNumber: c.claim.policy.number, invoiceId: inv, amount: Number(f.amount), clinicName: "Northside Clinic", ...(f.treatmentCode ? { treatmentCode: f.treatmentCode } : {}) },
      expectedEffect: { invoiceReceivedWithKey: true, invoiceId: inv },
      supersedes: rejected.at(-1) ? String(rejected.at(-1)!._id) : null,
      note: rejected.length ? `corrected resubmission #${rejected.length + 1} (new key, supersedes the rejected one)` : undefined,
    };
  },
  async onConfirmed(c, t, a) {
    await claims.upsertMoneyItem(c.claimId, { ref: `invoice:${t.params.invoiceId}`, category: "medical", submitted: Number(a.payload.amount) });
    return { task: "confirm" };
  },
};

const T14: Handler = {
  async plan() {
    return { type: "wait", note: "waiting for medical reimbursement", chase: { rule: "payment_overdue", afterSim: config.paymentOverdueSim } };
  },
  async check(c, t) {
    const ic = await insurerClaim(c);
    const m = ((ic?.medicalInvoices as unknown[]) ?? []).map(obj).find((x) => x.invoiceId === t.params.invoiceId);
    if (!m || m.status !== "paid") return { done: false };
    await claims.upsertMoneyItem(c.claimId, { ref: `invoice:${t.params.invoiceId}`, category: "medical", paid: Number(m.paidAmount) });
    return { done: true, note: `read-back: invoice ${t.params.invoiceId} paid $${m.paidAmount}` };
  },
};

const FactInvoice: Handler = {
  async plan(_c, t) {
    return { type: "action", system: "clinic", kind: "get_invoice", payload: { invoiceId: t.params.invoiceId }, expectedEffect: { treatmentCodeKnown: true } };
  },
  async onConfirmed(c, t, _a, e) {
    const inv = String(t.params.invoiceId);
    await claims.updateClaim(c.claimId, { [`facts.invoices.${inv}.treatmentCode`]: e.treatmentCode });
    c.event(`clinic read-back: ${inv} treatment code ${e.treatmentCode}`);
    return { task: "confirm" };
  },
};

const T15: Handler = {
  async plan(c, t) {
    const offer = obj(c.claim.external?.offer);
    if (!offer.offerId) {
      const ic = await insurerClaim(c);
      if (ic?.offer) await claims.updateClaim(c.claimId, { "external.offer": ic.offer });
      else return { type: "hold", status: "waiting", note: "no settlement offer yet" };
      await c.reload();
      return T15.plan(c, t);
    }
    if ((await hasDeclined(c, t.taskId, "sign_release")) || (await hasDeclined(c, t.taskId, "accept_settlement"))) {
      return { type: "hold", status: "waiting", note: "claimant declined the settlement; an operator will follow up" };
    }
    const o = { offerId: String(offer.offerId), amount: Number(offer.amount), deductible: Number(offer.deductible), repairTotal: Number(offer.repairTotal) };
    if (offer.requiresRelease && !(await confirmedAction(c, t.taskId, "sign_release"))) {
      return {
        type: "action",
        system: "insurer",
        kind: "sign_release",
        payload: { offerId: o.offerId, signedBy: c.claim.claimant.name },
        expectedEffect: { releaseSignedWithKey: true },
        gate: "sign_release",
        gateRequest: `Sign the insurer's release for offer ${o.offerId}? Signing gives up further repair claims for this accident.`,
        gateDetails: { offer: o },
      };
    }
    if (!(await confirmedAction(c, t.taskId, "accept_settlement"))) {
      return {
        type: "action",
        system: "insurer",
        kind: "accept_settlement",
        payload: { offerId: o.offerId, acceptedBy: c.claim.claimant.name },
        expectedEffect: { offerAccepted: true, offerId: o.offerId },
        gate: "accept_settlement",
        gateRequest: `Accept the insurer's settlement: $${o.amount} paid to the body shop (repair $${o.repairTotal} minus your $${o.deductible} deductible)? This is usually final.`,
        gateDetails: { offer: o },
      };
    }
    return { type: "wait", note: "settlement accepted; waiting for payment at insurer and shop", chase: { rule: "payment_overdue", afterSim: config.paymentOverdueSim } };
  },
  async onConfirmed(c, _t, a) {
    c.event(`${a.kind} confirmed by read-back`);
    return { task: "replan" };
  },
  async check(c) {
    if (!(await confirmedAction(c, "T15", "accept_settlement"))) return { done: false };
    const ic = await insurerClaim(c);
    const b = await booking(c);
    const offer = obj(ic?.offer);
    const paid = ((ic?.payments as unknown[]) ?? []).map(obj).find((p) => p.ref === `settlement:${offer.offerId}`);
    if (!paid || !(Number(b?.paymentReceived) > 0)) return { done: false };
    const est = obj(facts(c).estimate);
    const gap = Number(offer.repairTotal) - Number(paid.amount);
    await claims.upsertMoneyItem(c.claimId, {
      ref: `estimate:${est.estimateId}`,
      category: "repair",
      paid: Number(paid.amount),
      gapReason: gap === Number(offer.deductible) ? `policy deductible $${offer.deductible} (claimant pays the shop)` : null,
    });
    return { done: true, note: `payment $${paid.amount} shows at insurer and body shop` };
  },
};

const T16: Handler = {
  async plan() {
    return { type: "wait", note: "waiting for the claimant to pick up the car", chase: { rule: "claimant_reminder", afterSim: config.claimantReminderSim } };
  },
  async check(c) {
    const b = await booking(c);
    return b?.status === "released" ? { done: true, note: "read-back: body shop status released" } : { done: false };
  },
};

const T17: Handler = {
  async plan() {
    return { type: "action", system: "rental", kind: "return_reservation", payload: { returnDate: today() }, expectedEffect: { returned: true, finalChargePresent: true } };
  },
  async onConfirmed(c, _t, _a, e) {
    const charge = Number(e.finalCharge);
    const maxDays = Number(c.claim.policy.rentalMaxDays ?? 0);
    const extra = Math.max(0, Number(e.daysUsed) - maxDays);
    await claims.upsertMoneyItem(c.claimId, {
      ref: `rental:${c.ext("reservationId")}`,
      category: "rental",
      billed: charge,
      submitted: charge,
      gapReason: extra > 0 && (await hasApproved(c, "rental_overage")) ? `claimant approved ${extra} day(s) beyond coverage` : null,
    });
    c.event(`rental returned: ${e.daysUsed} days, final charge $${charge} (read-back)`);
    return { task: "confirm" };
  },
};

const T18: Handler = {
  async plan(c, t) {
    // Refresh "paid" from the insurer's system of record (read-only), then reconcile with an aggregation.
    const ic = await insurerClaim(c);
    for (const p of ((ic?.payments as unknown[]) ?? []).map(obj)) {
      const ref = String(p.ref);
      if (ref.startsWith("rental:")) await claims.upsertMoneyItem(c.claimId, { ref, category: "rental", paid: Number(p.amount) });
      if (ref.startsWith("invoice:")) await claims.upsertMoneyItem(c.claimId, { ref, category: "medical", paid: Number(p.amount) });
    }
    await claims.recomputeMoneyTotals(c.claimId);
    const unverified = (await actions.listUnverified(c.claimId)).length;
    if (unverified) return { type: "hold", status: "waiting", note: `${unverified} action(s) still unverified` };
    await c.reload();
    const rentalItem = c.claim.money.items.find((i) => i.category === "rental");
    const overdueFired = !!t.params.paymentOverdue;
    if (rentalItem && rentalItem.paid === 0 && !overdueFired) {
      await timers.ensureTimer({ claimId: c.claimId, taskId: t.taskId, rule: "payment_overdue", dueAt: new Date(clock.nowMs() + config.paymentOverdueSim) });
      return { type: "hold", status: "waiting", note: "waiting for the insurer to pay the rental" };
    }
    const rec = await claims.reconcileMoney(c.claimId);
    c.log("step 6 plan", `T18 reconcileMoney: ${rec.itemCount} items, ${rec.gaps.length} gap(s), ${rec.unexplained.length} unexplained`);
    if (rec.balanced) {
      await claims.updateClaim(c.claimId, { phase: "closed", closedAt: clock.now() });
      await messageClaimant(c, `Your claim is closed. Car repaired and released, rental returned, ${rec.gaps.length ? `differences explained: ${rec.gaps.map((g) => g.gapReason).join("; ")}` : "every amount billed was submitted and paid"}.`);
      return { type: "confirm", note: `money reconciles (${rec.gaps.length} explained gap(s))` };
    }
    if (!(await approvals.findPendingApproval(c.claimId, "reconciliation_gap"))) {
      await approvals.createApproval({
        claimId: c.claimId,
        actionId: null,
        taskId: t.taskId,
        gate: "reconciliation_gap",
        request: `Money doesn't reconcile: ${rec.unexplained.map((g) => `${g.ref} billed $${g.billed} / submitted $${g.submitted} / paid $${g.paid}`).join("; ")}. Approve to record your explanation (in the note) and close.`,
        details: { gaps: rec.unexplained },
      });
    }
    return { type: "hold", status: "awaiting_approval", note: "unexplained gaps handed to an operator" };
  },
};

const UploadStep: Handler = {
  async plan(c, t) {
    const kind = String(t.params.kind ?? `upload_${t.params.step}`);
    if (kind !== "upload_photos") return { type: "hold", status: "blocked_drift", note: `no adapter for ${kind}; operator needed` };
    const docs = await documents.listDocuments(c.claimId, "photo");
    const photos = docs.length ? docs.map((d) => `document:${String(d._id)}`) : ((facts(c).photos as string[] | undefined) ?? []);
    if (!photos.length) {
      await messageClaimant(c, "The insurer now needs photos of the damage. Please upload them here.");
      return { type: "hold", status: "waiting", note: "waiting for claimant photos" };
    }
    return { type: "action", system: "insurer", kind, payload: { photos }, expectedEffect: { requirementReceived: t.params.step } };
  },
  async onConfirmed() {
    return { task: "confirm" };
  },
};

const ClaimantRequest: Handler = {
  async plan(c, t) {
    if (!t.params.asked) {
      await messageClaimant(c, `${t.params.from ?? "A party on your claim"} asked: "${t.params.request}". Reply here or upload the document when you can.`, { taskId: t.taskId });
      await tasks.updateTaskFields(c.claimId, t.taskId, { "params.asked": true });
      await timers.ensureTimer({ claimId: c.claimId, taskId: t.taskId, rule: "claimant_reminder", dueAt: new Date(clock.nowMs() + config.claimantReminderSim) });
    }
    return { type: "hold", status: "waiting", note: "waiting for the claimant" };
  },
};

const RelayDecision: Handler = {
  async plan(c, t) {
    const sys = String(t.params.system ?? "insurer") as "insurer" | "body_shop" | "rental" | "clinic";
    const ref = sys === "insurer" ? c.ext("insurerClaimNo") : sys === "body_shop" ? c.ext("bookingId") : sys === "rental" ? c.ext("reservationId") : c.claimId;
    return {
      type: "action",
      system: sys,
      kind: "send_message",
      payload: { ref: ref ?? c.claimId, text: `Re your question "${t.params.question}": the claimant's answer is ${t.params.decision === "approved" ? "YES" : "NO"}.${t.params.note ? ` Note: ${t.params.note}` : ""}` },
      expectedEffect: { messageStored: true },
    };
  },
  async onConfirmed() {
    return { task: "confirm" };
  },
};

export const HANDLERS: Record<string, Handler> = {
  collect_details: T1,
  open_claim: T2,
  adjuster_assigned: T3,
  rental_coverage: T4,
  book_rental: T5,
  book_body_shop: T6,
  repair_estimate: T7,
  submit_estimate: T8,
  estimate_approved: T9,
  authorize_repair: T10,
  track_repair: T11,
  extend_rental: T12,
  forward_invoice: T13,
  medical_reimbursement: T14,
  invoice_fact: FactInvoice,
  settle_repair: T15,
  car_picked_up: T16,
  return_rental: T17,
  reconcile_close: T18,
  upload_step: UploadStep,
  claimant_request: ClaimantRequest,
  relay_decision: RelayDecision,
};

export function handlerFor(t: Pick<TaskDoc, "type">): Handler {
  const h = HANDLERS[t.type];
  if (!h) throw new Error(`no handler for task type ${t.type}`);
  return h;
}

/** Who to chase for a waiting task, and with which message reference. */
export function chaseTarget(c: ClaimCtx, t: TaskDoc): { system: "insurer" | "body_shop" | "rental" | "clinic" | "claimant"; ref: string | null; purpose: string } {
  switch (t.type) {
    case "adjuster_assigned":
      return { system: "insurer", ref: c.ext("insurerClaimNo"), purpose: "adjuster assignment" };
    case "estimate_approved":
      return { system: "insurer", ref: c.ext("insurerClaimNo"), purpose: "approval of the submitted repair estimate" };
    case "medical_reimbursement":
      return { system: "insurer", ref: c.ext("insurerClaimNo"), purpose: `payment of medical invoice ${t.params.invoiceId}` };
    case "settle_repair":
    case "reconcile_close":
      return { system: "insurer", ref: c.ext("insurerClaimNo"), purpose: "the outstanding payment" };
    case "repair_estimate":
      return { system: "body_shop", ref: c.ext("bookingId"), purpose: "the repair estimate" };
    case "track_repair":
      return { system: "body_shop", ref: c.ext("bookingId"), purpose: "a repair status update" };
    default:
      return { system: "claimant", ref: null, purpose: t.title };
  }
}
