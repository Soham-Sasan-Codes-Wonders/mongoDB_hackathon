import { ObjectId, type Document } from "mongodb";
import { collection } from "./database.js";
import { ApprovalSchema, type Approval } from "./schemas.js";

export async function createApproval(approval: Omit<Approval, "_id" | "createdAt">): Promise<string> {
  const result = await collection("approvals").insertOne(ApprovalSchema.parse({ ...approval, createdAt: new Date() }) as unknown as Document);
  return result.insertedId.toString();
}
export async function decideApproval(approvalId: string, decision: "approved" | "declined", decidedBy: string, decidedAt = new Date(), decisionNote?: string): Promise<boolean> {
  const id = ObjectId.isValid(approvalId) ? new ObjectId(approvalId) : approvalId;
  const result = await collection("approvals").updateOne({ _id: id, status: "pending" } as Document, { $set: { status: decision, decidedBy, decidedAt, ...(decisionNote ? { decisionNote } : {}) } });
  return result.modifiedCount === 1;
}
export async function listPendingApprovals(claimId?: string): Promise<Approval[]> {
  return collection<Approval & Document>("approvals").find({ status: "pending", ...(claimId ? { claimId } : {}) }).sort({ createdAt: 1 }).toArray();
}

/* ---------------------------------------------------------------- agent additions */

export type ApprovalDoc = Approval & { _id: ObjectId };

/** Who decides each gate. */
export const GATE_APPROVER: Record<Approval["gate"], Approval["approverRole"]> = {
  accept_settlement: "claimant", sign_release: "claimant", discuss_fault: "claimant", rental_overage: "claimant", decision_request: "claimant",
  drift_mapping: "operator", unverified_after_retries: "operator", reconciliation_gap: "operator", llm_review: "operator",
};

export async function getApproval(approvalId: string | ObjectId): Promise<ApprovalDoc | null> {
  const id = typeof approvalId === "string" && ObjectId.isValid(approvalId) ? new ObjectId(approvalId) : approvalId;
  return collection<ApprovalDoc>("approvals").findOne({ _id: id } as Document);
}
export async function listApprovals(claimId: string, status?: Approval["status"]): Promise<ApprovalDoc[]> {
  return collection<ApprovalDoc>("approvals").find({ claimId, ...(status ? { status } : {}) }).sort({ createdAt: 1 }).toArray();
}
export async function findPendingApproval(claimId: string, gate: Approval["gate"], taskId?: string): Promise<ApprovalDoc | null> {
  return collection<ApprovalDoc>("approvals").findOne({ claimId, gate, status: "pending", ...(taskId ? { taskId } : {}) });
}
