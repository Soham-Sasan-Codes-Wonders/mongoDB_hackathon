import { ObjectId, type Document } from "mongodb";
import { collection } from "./database.js";
import { ApprovalSchema, type Approval } from "./schemas.js";

export async function createApproval(approval: Omit<Approval, "_id" | "createdAt">): Promise<string> {
  const result = await collection("approvals").insertOne(ApprovalSchema.parse({ ...approval, createdAt: new Date() }) as unknown as Document);
  return result.insertedId.toString();
}
export async function decideApproval(approvalId: string, decision: "approved" | "declined", decidedBy: string, decidedAt = new Date()): Promise<boolean> {
  const id = ObjectId.isValid(approvalId) ? new ObjectId(approvalId) : approvalId;
  const result = await collection("approvals").updateOne({ _id: id, status: "pending" } as Document, { $set: { status: decision, decidedBy, decidedAt } });
  return result.modifiedCount === 1;
}
export async function listPendingApprovals(claimId?: string): Promise<Approval[]> {
  return collection<Approval & Document>("approvals").find({ status: "pending", ...(claimId ? { claimId } : {}) }).sort({ createdAt: 1 }).toArray();
}
