import type { Document } from "mongodb";
import { client, collection } from "./database.js";
import { ClaimSchema, TaskSchema, type Claim, type Counter, type Task } from "./schemas.js";

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

/* ---------------------------------------------------------------- agent additions */

type MoneyItem = Claim["money"]["items"][number];

/** Next free `CLM-<n>` id (atomic counter in `counters`; skips ids already taken, e.g. the seeded CLM-1042). */
export async function nextClaimId(): Promise<string> {
  for (;;) {
    const res = await collection<Counter & Document>("counters").findOneAndUpdate({ _id: "claim" }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: "after" });
    const id = `CLM-${1041 + (res?.seq ?? 1)}`;
    if (!(await getClaim(id))) return id;
  }
}

/** Insert a validated claim and its seeded tasks in ONE transaction. */
export async function createClaimWithTasks(claim: Claim, tasks: Task[]): Promise<void> {
  const parsed = ClaimSchema.parse(claim);
  const parsedTasks = tasks.map((t) => TaskSchema.parse(t));
  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      await collection<Claim>("claims").insertOne(parsed, { session });
      if (parsedTasks.length) await collection("tasks").insertMany(parsedTasks as unknown as Document[], { session });
    });
  } finally {
    await session.endSession();
  }
}

/** `$set` (dot paths allowed, e.g. "external.insurerClaimNo") and optional `$unset`. The validator enforces the shape. */
export async function updateClaimFields(claimId: string, set: Record<string, unknown>, unset: string[] = []): Promise<void> {
  await collection("claims").updateOne({ _id: claimId } as Document, {
    $set: { ...set, updatedAt: new Date() },
    ...(unset.length ? { $unset: Object.fromEntries(unset.map((k) => [k, ""])) } : {}),
  });
}

export async function listActiveClaimIds(): Promise<string[]> {
  return (await collection("claims").distinct("_id", { phase: { $ne: "closed" } })) as unknown as string[];
}

/** Insert or update one money line by itemId. Omitted numbers are left as they are; `reason: null` clears it. */
export async function upsertMoneyItem(claimId: string, item: { itemId: string; kind: MoneyItem["kind"]; category: string; billed?: number; submitted?: number; paid?: number; reason?: string | null }): Promise<void> {
  const claims = collection<Claim & Document>("claims");
  const claim = await claims.findOne({ _id: claimId } as Document, { projection: { "money.items": 1 } });
  if (!claim) throw new Error(`claim ${claimId} not found`);
  const exists = claim.money.items.some((i) => i.itemId === item.itemId);
  if (exists) {
    const set: Record<string, unknown> = {};
    const unset: Record<string, ""> = {};
    for (const k of ["billed", "submitted", "paid"] as const) if (item[k] !== undefined) set[`money.items.$.${k}`] = item[k];
    if (item.reason) set["money.items.$.reason"] = item.reason;
    else if (item.reason === null) unset["money.items.$.reason"] = "";
    if (Object.keys(set).length || Object.keys(unset).length) {
      await claims.updateOne({ _id: claimId, "money.items.itemId": item.itemId } as Document, { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) });
    }
  } else {
    const line: MoneyItem = { itemId: item.itemId, kind: item.kind, category: item.category, billed: item.billed ?? 0, submitted: item.submitted ?? 0, paid: item.paid ?? 0, ...(item.reason ? { reason: item.reason } : {}) };
    await claims.updateOne({ _id: claimId, "money.items.itemId": { $ne: item.itemId } } as Document, { $push: { "money.items": line } } as Document);
  }
}

/** Recompute `money.totals` (one row per category) from the line items with an aggregation. */
export async function recomputeMoneyTotals(claimId: string): Promise<Claim["money"]["totals"]> {
  const totals = (await collection("claims").aggregate([
    { $match: { _id: claimId } }, { $unwind: "$money.items" },
    { $group: { _id: "$money.items.category", billed: { $sum: "$money.items.billed" }, submitted: { $sum: "$money.items.submitted" }, paid: { $sum: "$money.items.paid" } } },
    { $project: { _id: 0, category: "$_id", billed: 1, submitted: 1, paid: 1 } }, { $sort: { category: 1 } },
  ]).toArray()) as Claim["money"]["totals"];
  await collection("claims").updateOne({ _id: claimId } as Document, { $set: { "money.totals": totals } });
  return totals;
}
