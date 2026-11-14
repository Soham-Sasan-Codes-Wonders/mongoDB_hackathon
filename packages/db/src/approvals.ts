import { ObjectId, type WithId } from "mongodb";
import { col } from "./collections.ts";
import { now } from "./clock.ts";
import { Approval, type Gate } from "./schemas.ts";

export type ApprovalDoc = WithId<Approval>;

export const GATE_APPROVER: Record<Gate, "claimant" | "operator"> = {
  settlement_acceptance: "claimant",
  sign_release: "claimant",
  fault_statement: "claimant",
  rental_beyond_coverage: "claimant",
  decision_request: "claimant",
  low_confidence_drift: "operator",
  unverified_after_retries: "operator",
  reconciliation_gap: "operator",
  llm_review: "operator",
};

export interface NewApproval {
  claimId: string;
  actionId: string | null;
  taskId?: string | null;
  gate: Gate;
  request: string;
  details?: Record<string, unknown>;
}

export function buildApprovalDoc(a: NewApproval): Approval {
  return Approval.parse({
    claimId: a.claimId,
    actionId: a.actionId,
    taskId: a.taskId ?? null,
    gate: a.gate,
    approverRole: GATE_APPROVER[a.gate],
    request: a.request,
    details: a.details ?? {},
    status: "pending",
    decidedBy: null,
    decidedAt: null,
    createdAt: now(),
  });
}

export async function createApproval(a: NewApproval): Promise<string> {
  const res = await (await col.approvals()).insertOne(buildApprovalDoc(a));
  return String(res.insertedId);
}

export async function getApproval(id: string): Promise<ApprovalDoc | null> {
  return (await col.approvals()).findOne({ _id: new ObjectId(id) });
}

export async function listApprovals(claimId: string, status?: Approval["status"]): Promise<ApprovalDoc[]> {
  return (await col.approvals()).find({ claimId, ...(status ? { status } : {}) }).sort({ createdAt: 1 }).toArray();
}

export async function findPendingApproval(claimId: string, gate: Gate, taskId?: string): Promise<ApprovalDoc | null> {
  return (await col.approvals()).findOne({ claimId, gate, status: "pending", ...(taskId ? { taskId } : {}) });
}

/**
 * Record a human decision on the approval document (who + when = the audit trail).
 * Used by the dashboard; the dashboard ALSO inserts an `approval_ui` observation so the agent wakes
 * and moves the action itself. Only a pending approval can be decided.
 */
export async function decideApproval(id: string, decision: "approved" | "declined", decidedBy: string, note?: string): Promise<ApprovalDoc | null> {
  return (await col.approvals()).findOneAndUpdate(
    { _id: new ObjectId(id), status: "pending" },
    { $set: { status: decision, decidedBy, decidedAt: now(), decisionNote: note ?? null } },
    { returnDocument: "after" },
  );
}
