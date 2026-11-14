import { approvals, clock, experiences, observations, tasks, timers, type ObservationDoc } from "@claims/db";
import { getter } from "../executor/index.ts";
import { reads } from "../executor/adapters.ts";
import { interpretCall, type CallItem } from "../llm/jobs.ts";
import { llmReview } from "../worker/handlers.ts";
import { messageClaimant, notifyOperator, type ClaimCtx } from "../worker/context.ts";

const obj = (x: unknown) => (x && typeof x === "object" ? (x as Record<string, unknown>) : {});

/**
 * Verify a caller's status claim against the system of record. READ-ONLY by construction: this
 * module only has GET access (reads.* via getter), so a call can never cause a write to an
 * outside system.
 */
export async function verifyStatusClaim(c: ClaimCtx, item: Pick<CallItem, "subject" | "valueClaimed" | "system">): Promise<{ verified: boolean; portal: string; verifiable: boolean }> {
  const v = String(item.valueClaimed ?? "").toLowerCase();
  const insNo = c.ext("insurerClaimNo");
  const bk = c.ext("bookingId");
  switch (item.subject) {
    case "estimate_approval": {
      if (!insNo) return { verified: false, portal: "no insurer claim yet", verifiable: false };
      const ic = obj((await reads.insurerClaim(getter("insurer"), insNo)).json);
      return { verified: ic.estimateStatus === "approved", portal: `insurer estimateStatus=${ic.estimateStatus}`, verifiable: true };
    }
    case "adjuster": {
      if (!insNo) return { verified: false, portal: "no insurer claim yet", verifiable: false };
      const ic = obj((await reads.insurerClaim(getter("insurer"), insNo)).json);
      return { verified: !!obj(ic.adjuster).name, portal: `adjuster=${obj(ic.adjuster).name ?? "none"}`, verifiable: true };
    }
    case "repair_status": {
      if (!bk) return { verified: false, portal: "no booking yet", verifiable: false };
      const b = obj((await reads.booking(getter("body_shop"), bk)).json);
      const status = String(b.status);
      const want = /release|picked/.test(v) ? ["released"] : /ready|done|finished/.test(v) ? ["ready", "released"] : /repair/.test(v) ? ["in_repair"] : [v.replace(/\s+/g, "_")];
      return { verified: want.includes(status), portal: `body shop status=${status}`, verifiable: true };
    }
    case "payment": {
      if (!insNo) return { verified: false, portal: "no insurer claim yet", verifiable: false };
      const ic = obj((await reads.insurerClaim(getter("insurer"), insNo)).json);
      const pays = (ic.payments as unknown[]) ?? [];
      return { verified: pays.length > 0, portal: `insurer payments=${pays.length}`, verifiable: true };
    }
    case "rental": {
      const rid = c.ext("reservationId");
      if (!rid) return { verified: false, portal: "no reservation yet", verifiable: false };
      const r = obj((await reads.reservation(getter("rental"), rid)).json);
      return { verified: /extend/.test(v) ? Array.isArray(r.extensions) && r.extensions.length > 0 : r.status === (/return/.test(v) ? "returned" : "reserved"), portal: `rental status=${r.status} end=${r.endDate}`, verifiable: true };
    }
    default:
      return { verified: false, portal: "no system of record for this", verifiable: false };
  }
}

/** Learned caller patterns (Vector Search over experiences) tune the follow-up timer. */
async function followUpDelayDays(callerName: string, subject: string): Promise<{ days: number; why: string }> {
  const ex = await experiences.findSimilarExperiences(`${callerName} ${subject} verbal claim before portal`, { problemType: "caller_pattern" }, 1);
  const d = Number(obj(ex[0]?.fix).promiseCheckDelayDays);
  if (ex[0] && ex[0].score > 0.6 && d > 0) return { days: d, why: `pattern: "${ex[0].problem.slice(0, 70)}"` };
  return { days: 1, why: "default" };
}

/**
 * How the agent treats what it hears (doc table). A status claim -> immediate read-back
 * (verified only if the portal agrees, else a follow-up timer); a promise -> promise_check timer;
 * a request -> a claimant task; a decision -> a claimant approval; payment/bank changes -> never
 * acted on, flagged to the claimant as possible fraud. Then a post-call summary to the claimant.
 */
export async function handleCall(c: ClaimCtx, o: ObservationDoc): Promise<void> {
  const tag = "phone";
  const fields = obj(o.body.fields);
  const caller = obj(o.body.caller);
  const callerName = String(caller.name ?? fields.caller_role ?? "Unknown caller");
  const trust = o.trust ?? "unknown";
  const transcript = String(o.body.transcriptText ?? "");
  const paymentFlag = fields.payment_details_mentioned === true || fields.payment_details_mentioned === "true";

  const r = await interpretCall({ callerRole: (caller.role as string) ?? (fields.caller_role as string) ?? null, trust, transcript, fields });
  if (!r.ok) {
    await llmReview(c, null, "interpretCall", r, "acknowledge the call (nothing is written)", { observationId: String(o._id) });
    if (paymentFlag) await fraudAlert(c, callerName, trust);
    await observations.markProcessed(o._id, c.workerId, { verified: false, note: `interpretation failed: ${r.reason}` });
    return;
  }
  const items = [...r.value.items];
  if (paymentFlag && !items.some((i) => i.type === "payment_change")) items.push({ type: "payment_change", system: null, subject: "payment", valueClaimed: null, amountClaimed: null, promisedDate: null, requestText: null, decisionQuestion: null });

  const verified: string[] = [];
  const unverified: string[] = [];
  const decisions: string[] = [];
  const requests: string[] = [];
  let allVerified = true;

  for (const [i, item] of items.entries()) {
    switch (item.type) {
      case "status_claim": {
        const v = await verifyStatusClaim(c, item);
        c.log(tag, `status claim "${item.valueClaimed}" (${item.subject}) -> read-back: ${v.portal} -> ${v.verified ? "VERIFIED" : "claimed, not confirmed"}`);
        if (v.verified) verified.push(`${item.subject.replace("_", " ")}: "${item.valueClaimed}" (portal agrees: ${v.portal})`);
        else {
          allVerified = false;
          const { days, why } = await followUpDelayDays(callerName, item.subject);
          await timers.createTimer({ claimId: c.claimId, taskId: `CALL#${String(o._id).slice(-6)}`, rule: "promise_check", dueAt: new Date(clock.nowMs() + days * clock.DAY), params: { observationId: String(o._id), subject: item.subject, system: item.system, valueClaimed: item.valueClaimed, callerName, kind: "status_claim" } });
          unverified.push(`${item.subject.replace("_", " ")}: "${item.valueClaimed}" (portal says ${v.portal}; re-checking in ${days} day(s), ${why})`);
        }
        break;
      }
      case "promise": {
        const due = item.promisedDate && !Number.isNaN(Date.parse(item.promisedDate)) ? Date.parse(item.promisedDate) + 9 * clock.HOUR : clock.nowMs() + clock.DAY;
        await timers.createTimer({ claimId: c.claimId, taskId: `CALL#${String(o._id).slice(-6)}`, rule: "promise_check", dueAt: new Date(Math.max(due, clock.nowMs())), params: { observationId: String(o._id), subject: item.subject, system: item.system, valueClaimed: item.valueClaimed ?? "ready", callerName, kind: "promise" } });
        allVerified = false;
        unverified.push(`promise: ${item.valueClaimed ?? "done"} by ${item.promisedDate ?? "soon"} (we'll check the status that day)`);
        break;
      }
      case "request": {
        const id = `CALL#${String(o._id).slice(-6)}:req${i}`;
        await tasks.insertTaskIfMissing({ claimId: c.claimId, taskId: id, type: "claimant_request", title: `Request from ${callerName}: ${String(item.requestText).slice(0, 60)}`, track: "intake", dependsOn: [], params: { request: item.requestText, from: callerName, observationId: String(o._id) } });
        requests.push(String(item.requestText));
        break;
      }
      case "decision_request": {
        await approvals.createApproval({ claimId: c.claimId, actionId: null, taskId: null, gate: "decision_request", request: `${callerName} asks: "${item.decisionQuestion}". Approve = yes, decline = no.`, details: { question: item.decisionQuestion, system: item.system, observationId: String(o._id), caller: callerName, trust } });
        decisions.push(String(item.decisionQuestion));
        break;
      }
      case "payment_change":
        await fraudAlert(c, callerName, trust);
        break;
      default:
        break;
    }
  }

  await observations.markProcessed(o._id, c.workerId, { verified: items.some((i) => i.type === "status_claim") ? allVerified : null, note: r.value.callerSummary.slice(0, 300) });
  if (verified.length) {
    // A verified status is a read-back, which is proof: let the matching wait tasks re-check now.
    for (const id of ["T3", "T9", "T11", "T16"]) c.recheck.add(id);
  }
  const trustNote = trust === "known" ? "" : trust === "company_line" ? " (company main line: caller not individually verified)" : " (UNKNOWN number: nothing about your claim was shared)";
  const summary = [
    `Call from ${callerName}${trustNote}.`,
    `They said: ${r.value.callerSummary}`,
    verified.length ? `Verified: ${verified.join("; ")}.` : "",
    unverified.length ? `Not yet verified: ${unverified.join("; ")}.` : "",
    requests.length ? `They need from you: ${requests.join("; ")}.` : "",
    decisions.length ? `Needs your decision: ${decisions.join("; ")}.` : "",
    "We made no commitments on the call.",
  ].filter(Boolean).join(" ");
  await messageClaimant(c, summary, { kind: "post_call_summary", observationId: String(o._id) });
  c.event(`phone: ${callerName} — ${verified.length} verified, ${unverified.length} unverified, ${requests.length} request(s), ${decisions.length} decision(s)`);
}

async function fraudAlert(c: ClaimCtx, callerName: string, trust: string) {
  await messageClaimant(c, `Warning: a caller (${callerName}, trust: ${trust}) asked to change payment or bank details. We have NOT acted on it and never will by phone. If you didn't expect this, it may be a fraud attempt.`, { kind: "fraud_alert" });
  await notifyOperator(c, `Possible fraud: payment/bank detail change requested by phone from ${callerName}. Not acted on.`);
}

/** promise_check timer: read back the status the caller claimed or promised. */
export async function runPromiseCheck(c: ClaimCtx, params: Record<string, unknown>): Promise<void> {
  const subject = String(params.subject ?? "other") as CallItem["subject"];
  const v = await verifyStatusClaim(c, { subject, valueClaimed: (params.valueClaimed as string) ?? null, system: (params.system as CallItem["system"]) ?? null });
  c.log("phone", `promise_check ${subject} "${params.valueClaimed}" -> ${v.portal} -> ${v.verified ? "now verified" : "still not confirmed"}`);
  if (params.observationId) await observations.updateObservation(String(params.observationId), { verified: v.verified });
  await messageClaimant(c, v.verified ? `Update: what ${params.callerName} told us ("${params.valueClaimed}") is now confirmed by the ${params.system ?? "system"} (${v.portal}).` : `Update: ${params.callerName} said "${params.valueClaimed}", but the ${params.system ?? "system"} still shows ${v.portal}. We're following up.`, { kind: "promise_check" });
  if (v.verified && params.kind === "status_claim") {
    await experiences.recordExperience({ problemType: "caller_pattern", system: String(params.system ?? "unknown"), problem: `${params.callerName} claimed "${params.valueClaimed}" (${subject}) by phone before the portal showed it`, fix: { promiseCheckDelayDays: 1 }, outcome: `portal confirmed later (${v.portal})`, claimId: c.claimId });
  }
  c.event(`promise check ${subject}: ${v.verified ? "confirmed" : "not confirmed"}`);
}
