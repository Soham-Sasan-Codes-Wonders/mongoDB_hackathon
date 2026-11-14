import type { Document } from "mongodb";
import { collection } from "./database.js";
import { ClaimSchema, type Claim } from "./schemas.js";

export async function getClaim(claimId: string): Promise<Claim | null> { return collection<Claim>("claims").findOne({ _id: claimId } as Document); }
export async function putClaim(claim: Claim): Promise<void> { const parsed = ClaimSchema.parse(claim); await collection<Claim>("claims").replaceOne({ _id: parsed._id }, parsed, { upsert: true }); }
export async function listClaims(): Promise<Claim[]> { return collection<Claim>("claims").find().sort({ createdAt: -1 }).toArray(); }
export async function updateCompactSummary(claimId: string, compactSummary: string): Promise<boolean> {
  if (compactSummary.length > 2000) throw new RangeError("compactSummary must be at most 2,000 characters");
  return (await collection("claims").updateOne({ _id: claimId } as Document, { $set: { compactSummary, updatedAt: new Date() } })).modifiedCount === 1;
}

export async function reconcileMoney(claimId: string): Promise<Array<{ itemId: string; kind: string; category: string; billed: number; submitted: number; paid: number; billedToSubmittedGap: number; submittedToPaidGap: number; reason?: string }>> {
  return collection("claims").aggregate([
    { $match: { _id: claimId } }, { $unwind: "$money.items" },
    { $project: { _id: 0, itemId: "$money.items.itemId", kind: "$money.items.kind", category: "$money.items.category", billed: "$money.items.billed", submitted: "$money.items.submitted", paid: "$money.items.paid", reason: "$money.items.reason", billedToSubmittedGap: { $subtract: ["$money.items.billed", "$money.items.submitted"] }, submittedToPaidGap: { $subtract: ["$money.items.submitted", "$money.items.paid"] } } }
  ]).toArray() as unknown as Array<{ itemId: string; kind: string; category: string; billed: number; submitted: number; paid: number; billedToSubmittedGap: number; submittedToPaidGap: number; reason?: string }>;
}

export async function getClaimOverview(claimId: string): Promise<Document | null> {
  const rows = await collection("claims").aggregate([
    { $match: { _id: claimId } },
    { $lookup: { from: "tasks", localField: "_id", foreignField: "claimId", as: "tasks" } },
    { $lookup: { from: "actions", let: { id: "$_id" }, pipeline: [
      { $match: { $expr: { $eq: ["$claimId", "$$id"] } } }, { $sort: { createdAt: -1, _id: -1 } },
      { $group: { _id: "$taskId", action: { $first: "$$ROOT" } } }, { $replaceRoot: { newRoot: "$action" } }
    ], as: "latestActions" } },
    { $lookup: { from: "approvals", let: { id: "$_id" }, pipeline: [{ $match: { $expr: { $and: [{ $eq: ["$claimId", "$$id"] }, { $eq: ["$status", "pending"] }] } } }], as: "pendingApprovals" } },
    { $lookup: { from: "timers", let: { id: "$_id" }, pipeline: [{ $match: { $expr: { $and: [{ $eq: ["$claimId", "$$id"] }, { $eq: ["$fired", false] }, { $eq: ["$cancelled", false] }] } } }], as: "openTimers" } },
    { $project: { latestActions: 1, tasks: 1, pendingApprovals: 1, openTimers: 1, claimant: 1, parties: 1, vehicle: 1, policy: 1, phase: 1, compactSummary: 1, money: 1, createdAt: 1, updatedAt: 1 } }
  ]).toArray();
  return rows[0] ?? null;
}

export async function getActionTimeline(claimId: string): Promise<Document[]> {
  return collection("actions").aggregate([{ $match: { claimId } }, { $unwind: "$history" }, { $sort: { "history.wallAt": 1 } }, { $project: { _id: 0, actionId: "$_id", taskId: 1, kind: 1, system: 1, idempotencyKey: 1, ...Object.fromEntries(["status", "at", "wallAt", "by", "note"].map((key) => [key, `$history.${key}`])) } }]).toArray();
}
