import { actions, claims, experiences, observations, tasks, type ActionDoc } from "@claims/db";
import { classifyRejection } from "../llm/jobs.ts";
import { llmReview } from "../worker/handlers.ts";
import { messageClaimant, type ClaimCtx } from "../worker/context.ts";

/**
 * Rejection subflow (doc steps 1-6). The rejected action is NEVER retried: a fix is a new
 * submission with a NEW idempotency key that `supersedes` the old action (the task's planner mints
 * it), or a fact-gathering task first. Out of coverage, or a second rejection: tell the claimant
 * and close the task as denied.
 */
export async function runRejection(c: ClaimCtx, action: ActionDoc, reason: string): Promise<void> {
  const tag = "rejection";
  const t = await tasks.getTask(c.claimId, action.taskId);
  if (!t) return;
  // 1. action is already `rejected` (executor); store the reason as an observation
  await observations.insertObservation({ claimId: c.claimId, source: "system", kind: "rejection", body: { actionId: String(action._id), taskId: action.taskId, system: action.system, kind: action.kind, reason }, matchedActionId: String(action._id), processed: true });
  c.log(tag, `1 ${action.taskId} ${action.system}.${action.kind} rejected: "${reason}" (key ${action.idempotencyKey} is retired)`);

  // 3. similar past rejections (looked up first so the classifier can use them)
  const similar = await experiences.findSimilarExperiences(reason, { problemType: "rejection", system: action.system }, 3);
  c.log(tag, `3 similar experiences: ${similar.map((e) => `"${e.problem.slice(0, 50)}"(${e.score.toFixed(2)})`).join("; ") || "none"}`);

  // 2. LLM classifies the reason
  const inv = String(action.payload.invoiceId ?? "");
  const knownFacts = inv ? { ...((c.claim.facts as Record<string, Record<string, unknown>>).invoices?.[inv] ?? {}) } : {};
  const r = await classifyRejection({ system: action.system, kind: action.kind, reason, payload: action.payload, knownFacts, experiences: similar.map((e) => ({ problem: e.problem, fix: e.fix, outcome: e.outcome })) });
  if (!r.ok) {
    await llmReview(c, t, "classifyRejection", r, `close ${t.taskId} by hand`, { actionId: String(action._id), reason });
    await tasks.setTaskStatus(c.claimId, t.taskId, "awaiting_approval", { by: c.workerId, note: "rejection classification needs an operator" });
    return;
  }
  const cls = r.value;
  c.log(tag, `2 classified: ${cls.category}${cls.missingField ? ` (${cls.missingField} from ${cls.factSource})` : ""}, needsNewFacts=${cls.needsNewFacts}`);

  const priorRejections = (await actions.listActions(c.claimId, { taskId: t.taskId, status: ["rejected"] })).filter((a) => a.kind === action.kind).length;
  let outcome: string;

  // 6. out of coverage, or a second rejection: tell the claimant, close as denied
  if (cls.category === "out_of_coverage" || priorRejections >= 2) {
    const why = cls.category === "out_of_coverage" ? "it isn't covered by your policy" : `it was rejected twice ("${reason}")`;
    await messageClaimant(c, `The insurer will not pay ${inv ? `invoice ${inv}` : t.title}: ${why}. We've closed this item; reply if you want an operator to dispute it.`, { taskId: t.taskId });
    await tasks.setTaskStatus(c.claimId, t.taskId, "denied", { by: c.workerId, note: why });
    if (t.taskId.startsWith("T13#")) {
      const paidId = t.taskId.replace("T13#", "T14#");
      await tasks.setTaskStatus(c.claimId, paidId, "denied", { by: c.workerId, note: `${t.taskId} denied` });
      await claims.upsertMoneyItem(c.claimId, { ref: `invoice:${inv}`, category: "medical", gapReason: `denied by insurer: ${reason}; claimant told` });
    }
    outcome = "denied; claimant told";
    c.event(`${t.taskId} denied (${why})`);
  } else if (cls.category === "duplicate") {
    await tasks.setTaskStatus(c.claimId, t.taskId, "closed_by_human", { by: c.workerId, note: "duplicate of an earlier submission; nothing to resubmit" });
    outcome = "closed as duplicate";
  } else if (cls.needsNewFacts && cls.missingField === "treatmentCode" && cls.factSource === "clinic" && inv) {
    // 5. needs facts we don't have: create a task to get them, then resubmit
    const factId = `${t.taskId}:fact`;
    await tasks.insertTaskIfMissing({ claimId: c.claimId, taskId: factId, type: "invoice_fact", title: `Get the treatment code for ${inv} from the clinic`, track: "medical", dependsOn: [], params: { invoiceId: inv, field: "treatmentCode" } });
    await tasks.addDependency(c.claimId, t.taskId, factId);
    await tasks.setTaskStatus(c.claimId, t.taskId, "pending", { by: c.workerId, note: `waits for ${factId}, then resubmits with a new key` });
    outcome = `created ${factId}; will resubmit with a new key`;
    c.log(tag, `5 needs ${cls.missingField} from ${cls.factSource}: created ${factId}, wired into ${t.taskId}.dependsOn`);
  } else if (cls.needsNewFacts && cls.factSource === "claimant") {
    const reqId = `${t.taskId}:claimant`;
    await tasks.insertTaskIfMissing({ claimId: c.claimId, taskId: reqId, type: "claimant_request", title: `Claimant to provide ${cls.missingField ?? "information"}`, track: "intake", dependsOn: [], params: { request: cls.proposedFix, from: "The insurer" } });
    await tasks.addDependency(c.claimId, t.taskId, reqId);
    await tasks.setTaskStatus(c.claimId, t.taskId, "pending", { by: c.workerId, note: `waits for ${reqId}` });
    outcome = `asked claimant for ${cls.missingField}`;
  } else if (!cls.needsNewFacts && cls.category !== "other") {
    // 4. known fix, no new facts: back to the planner, which builds a corrected action (new key, supersedes)
    await tasks.setTaskStatus(c.claimId, t.taskId, "pending", { by: c.workerId, note: `resubmit: ${cls.proposedFix}` });
    outcome = `corrected resubmission planned: ${cls.proposedFix}`;
  } else {
    await llmReview(c, t, "classifyRejection", { ok: false, reason: "low_confidence", detail: `no automatic fix for "${reason}"` }, `close ${t.taskId} by hand`, { actionId: String(action._id) });
    await tasks.setTaskStatus(c.claimId, t.taskId, "awaiting_approval", { by: c.workerId, note: "no automatic fix" });
    outcome = "handed to operator";
  }

  await experiences.recordExperience({ problemType: "rejection", system: action.system, problem: `${action.kind} rejected: ${reason}`, fix: { classification: cls.category, missingField: cls.missingField, factSource: cls.factSource, needsNewFacts: cls.needsNewFacts }, outcome, claimId: c.claimId });
  c.event(`rejection on ${action.taskId}: ${outcome}`);
}
