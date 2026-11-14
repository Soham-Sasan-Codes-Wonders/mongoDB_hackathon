import { actions, approvals, claims, experiences, tasks, timers, type ApprovalDoc, type OutsideSystem, type SystemSpec } from "../db.ts";
import { applyDriftProposal } from "../subflows/drift.ts";
import type { MappingProposal } from "../llm/jobs.ts";
import { notifyOperator, type ClaimCtx } from "./context.ts";
import { confirmTask, handleOutcome } from "./outcomes.ts";

/**
 * Apply a human decision recorded on an approval document. The dashboard sets decidedBy/decidedAt
 * and inserts an `approval_ui` observation; the agent (here) moves the action. A declined gate ->
 * action `cancelled`, task back to step 5 (its planner sees the decline and adapts).
 */
export async function applyDecision(c: ClaimCtx, body: Record<string, unknown>): Promise<void> {
  const approvalId = String(body.approvalId ?? "");
  let ap: ApprovalDoc | null = approvalId ? await approvals.getApproval(approvalId) : null;
  if (!ap) {
    c.log("step 3 verify", `approval_ui observation for unknown approval ${approvalId}`);
    return;
  }
  if (ap.status === "pending") {
    const decision = body.decision === "approved" ? "approved" : body.decision === "declined" ? "declined" : null;
    if (!decision) return;
    ap = (await approvals.decideApproval(approvalId, decision, String(body.decidedBy ?? "approval_ui"), body.note ? String(body.note) : undefined)) ?? ap;
  }
  if (ap.status === "pending") return;
  const approved = ap.status === "approved";
  const by = String(ap.decidedBy ?? "?").startsWith(`${ap.approverRole}:`) ? String(ap.decidedBy) : `${ap.approverRole}:${ap.decidedBy ?? "?"}`;
  await timers.cancelTimersForApproval(approvalId);
  c.log("step 3 verify", `approval ${ap.gate} ${ap.status} by ${ap.decidedBy}`);
  c.event(`${ap.approverRole} ${ap.status} ${ap.gate}${ap.taskId ? ` (${ap.taskId})` : ""}`);

  switch (ap.gate) {
    case "accept_settlement":
    case "sign_release":
    case "discuss_fault":
    case "rental_overage": {
      const a = ap.actionId ? await actions.getAction(ap.actionId) : null;
      if (!a || a.status !== "awaiting_approval") return;
      if (approved) {
        await actions.transitionAction(a._id, "approved", { by, note: `gate ${ap.gate} approved` });
        await tasks.setTaskStatus(c.claimId, a.taskId, "in_progress", { by: c.workerId, note: "approved; executing" });
      } else {
        await actions.transitionAction(a._id, "cancelled", { by, note: `gate ${ap.gate} declined` });
        await tasks.setTaskStatus(c.claimId, a.taskId, "pending", { by: c.workerId, note: `${ap.gate} declined; re-plan (loop step 5)` });
      }
      return;
    }
    case "unverified_after_retries": {
      const a = ap.actionId ? await actions.getAction(ap.actionId) : null;
      if (!a || !["sent", "acknowledged"].includes(a.status)) return;
      if (approved) {
        await actions.transitionAction(a._id, "closed_by_human", { by, note: ap.decisionNote ?? "operator confirmed out of band" });
        await confirmTask(c, a.taskId, `closed by ${by}`, "closed_by_human");
      } else {
        await actions.transitionAction(a._id, "cancelled", { by, note: "operator cancelled; re-plan with a new key" });
        await tasks.setTaskStatus(c.claimId, a.taskId, "pending", { by: c.workerId, note: "unverified action cancelled; re-plan (loop step 5)" });
      }
      return;
    }
    case "drift_mapping": {
      const d = (ap.details ?? {}) as { trigger?: Record<string, unknown>; proposal?: MappingProposal | null; describe?: SystemSpec };
      const trig = d.trigger ?? {};
      if (!approved || !d.proposal || !d.describe) {
        await experiences.recordExperience({ problemType: "drift", system: String(trig.system ?? "unknown"), problem: String(trig.error ?? "drift"), fix: { operatorRejected: d.proposal ?? null }, outcome: "operator declined the proposed mapping", claimId: c.claimId });
        await notifyOperator(c, `Drift on ${trig.system} for ${ap.taskId} still needs a manual fix.`);
        return;
      }
      const action = ap.actionId ? await actions.getAction(ap.actionId) : null;
      const outcome = await applyDriftProposal(c, { system: trig.system as OutsideSystem, taskId: String(ap.taskId), action, trigger: trig.trigger as never, error: String(trig.error) }, d.proposal, d.describe, "operator");
      if (outcome) await handleOutcome(c, outcome, 1);
      return;
    }
    case "decision_request": {
      const det = (ap.details ?? {}) as Record<string, unknown>;
      const id = `CALL#${String(det.observationId ?? approvalId).slice(-6)}:decision`;
      await tasks.insertTaskIfMissing({ claimId: c.claimId, taskId: id, type: "relay_decision", title: `Relay the claimant's answer to ${det.system ?? "the caller"}`, track: "intake", dependsOn: [], params: { system: det.system ?? "insurer", question: det.question, decision: ap.status, note: ap.decisionNote ?? null } });
      return;
    }
    case "reconciliation_gap": {
      if (!approved) {
        await notifyOperator(c, "Reconciliation gaps were declined; T18 stays open until they're resolved.");
        return;
      }
      for (const g of ((ap.details ?? {}).gaps as { ref: string; category: "repair" | "rental" | "medical" }[]) ?? []) {
        await claims.upsertMoneyItem(c.claimId, { ref: g.ref, category: g.category, gapReason: `operator ${ap.decidedBy}: ${ap.decisionNote ?? "explained"}` });
      }
      await tasks.setTaskStatus(c.claimId, "T18", "pending", { by: c.workerId, note: "gaps explained by operator; reconcile again" });
      return;
    }
    case "llm_review": {
      if (!ap.taskId) return;
      if (approved) await confirmTask(c, ap.taskId, `operator ${ap.decidedBy}: ${String((ap.details ?? {}).onApprove ?? "approved")}`, ap.taskId === "T1" ? "confirmed" : "closed_by_human");
      else await notifyOperator(c, `${ap.taskId} left for manual handling (LLM review declined).`);
      return;
    }
  }
}
