import { approvals, observations, type ApprovalDoc } from "../db.ts";
import { config } from "../config.ts";
import { log } from "../log.ts";

/**
 * Autopilot for OPERATOR gates (AUTOPILOT=operator, the default; AUTOPILOT=off restores a human
 * operator). The agent decides each operator approval itself, the way the operator console would:
 * it records the decision on the approval and inserts the same `approval_ui` observation the
 * dashboard does, so the worker applies it through the normal path (worker/decisions.ts) and the
 * approval document stays the audit trail (decidedBy "agent:autopilot", with the reason in the note).
 *
 * Claimant gates (settlement, release, fault wording, rental overage, caller decisions) are never
 * touched: those bind the claimant or cost them money.
 *
 * Loops are capped: a gate that keeps coming back for the same task is left for a human after a
 * few autopilot decisions, with an operator notice saying so.
 */
export const AUTOPILOT_BY = "agent:autopilot";
const MAX_REPEATS = 3;

type Decision = { decision: "approved" | "declined"; note: string } | null;

const money = (n: unknown) => `$${Number(n ?? 0).toFixed(0)}`;

async function priorAutopilotDecisions(ap: ApprovalDoc): Promise<number> {
  const all = await approvals.listApprovals(ap.claimId);
  return all.filter((x) => x.gate === ap.gate && (x.taskId ?? null) === (ap.taskId ?? null) && x.decidedBy === AUTOPILOT_BY).length;
}

async function decide(ap: ApprovalDoc): Promise<Decision> {
  const d = (ap.details ?? {}) as Record<string, unknown>;
  switch (ap.gate) {
    case "drift_mapping": {
      if (d.analysisFailed) return { decision: "approved", note: "autopilot: re-running the drift analysis" };
      const conf = Number(d.confidence ?? NaN);
      return { decision: "approved", note: `autopilot: applied the proposed fix${Number.isFinite(conf) ? ` (confidence ${conf.toFixed(2)})` : ""}; read-back still has to prove it worked` };
    }
    case "llm_review":
      return { decision: "approved", note: `autopilot: ${String(d.onApprove ?? "accepted")}` };
    case "unverified_after_retries":
      // Never close an action without proof: cancel it and re-plan with a new idempotency key.
      return { decision: "declined", note: "autopilot: no proof after retries; cancel and re-plan with a new key" };
    case "reconciliation_gap": {
      const gaps = (d.gaps as Array<Record<string, unknown>> | undefined) ?? [];
      const why = gaps.map((g) => {
        const paid = Number(g.paid ?? 0), billed = Number(g.billed ?? 0), submitted = Number(g.submitted ?? 0);
        if (submitted < billed) return `${g.ref}: ${money(billed - submitted)} billed but never submitted to the insurer`;
        if (paid < submitted) return `${g.ref}: insurer paid ${money(paid)} of ${money(submitted)}; the ${money(submitted - paid)} difference is outside coverage`;
        return `${g.ref}: paid ${money(paid)} vs billed ${money(billed)}`;
      });
      return { decision: "approved", note: `autopilot: ${why.join("; ") || "gap recorded"}` };
    }
    default:
      return null;
  }
}

/** Decide one pending operator approval, if autopilot is on and it hasn't looped. */
export async function autopilotApproval(approvalId: string): Promise<void> {
  if (config.autopilot === "off") return;
  const ap = await approvals.getApproval(approvalId);
  if (!ap || ap.status !== "pending" || ap.approverRole !== "operator") return;
  // Only gates that can loop on one task are capped (each llm_review/reconciliation is a new item).
  const loops = ap.gate === "drift_mapping" || ap.gate === "unverified_after_retries";
  if (loops && (await priorAutopilotDecisions(ap)) >= MAX_REPEATS) {
    await observations.insertObservation({ claimId: ap.claimId, source: "system", kind: "operator_notice", body: { to: "operator", text: `Autopilot stopped on ${ap.gate}${ap.taskId ? ` (${ap.taskId})` : ""}: it came back ${MAX_REPEATS} times. Needs a person.` }, processed: true });
    log("autopilot", `${ap.claimId} ${ap.gate} ${ap.taskId ?? ""}: repeated ${MAX_REPEATS}x, left for a human`);
    return;
  }
  const r = await decide(ap);
  if (!r) return;
  await approvals.decideApproval(approvalId, r.decision, AUTOPILOT_BY, r.note);
  await observations.insertObservation({
    claimId: ap.claimId,
    source: "approval_ui",
    kind: "approval_decision",
    body: { approvalId, actionId: ap.actionId ? String(ap.actionId) : null, decision: r.decision, decidedBy: AUTOPILOT_BY, note: r.note },
  });
  await observations.insertObservation({ claimId: ap.claimId, source: "system", kind: "operator_notice", body: { to: "operator", text: `Autopilot ${r.decision} ${ap.gate}${ap.taskId ? ` (${ap.taskId})` : ""}: ${r.note.replace(/^autopilot: /, "")}` }, processed: true });
  log("autopilot", `${ap.claimId} ${ap.gate} ${ap.taskId ?? ""} -> ${r.decision}: ${r.note}`);
}

/** On worker start: decide operator approvals left pending from before autopilot (or while it was off). */
export async function autopilotSweep(): Promise<void> {
  if (config.autopilot === "off") return;
  for (const claimId of await activeClaimIds()) {
    for (const ap of await approvals.listApprovals(claimId, "pending")) {
      if (ap.approverRole === "operator") await autopilotApproval(String(ap._id));
    }
  }
}

async function activeClaimIds(): Promise<string[]> {
  const { claims } = await import("../db.ts");
  return claims.listActiveClaimIds();
}
