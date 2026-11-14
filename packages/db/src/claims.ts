import type { ClientSession } from "mongodb";
import { col } from "./collections.ts";
import { now } from "./clock.ts";
import { Claim, MoneyItem, type MoneyItem as MoneyItemT } from "./schemas.ts";

const zeroCat = () => ({ billed: 0, submitted: 0, paid: 0 });
export const emptyMoney = () => ({ items: [] as MoneyItemT[], totals: { repair: zeroCat(), rental: zeroCat(), medical: zeroCat() } });

export async function nextClaimId(): Promise<string> {
  const res = await (await col.counters()).findOneAndUpdate(
    { _id: "claim" },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" },
  );
  return `CLM-${1041 + (res?.seq ?? 1)}`;
}

export type NewClaim = Omit<Claim, "createdAt" | "createdWallAt" | "money" | "compactSummary" | "phase" | "external" | "facts"> &
  Partial<Pick<Claim, "phase" | "compactSummary" | "external" | "facts">>;

export async function createClaim(c: NewClaim, session?: ClientSession): Promise<Claim> {
  const doc = Claim.parse({
    phase: "intake",
    compactSummary: "",
    external: {},
    facts: {},
    ...c,
    money: emptyMoney(),
    createdAt: now(),
    createdWallAt: new Date(),
  });
  await (await col.claims()).insertOne(doc, { session });
  return doc;
}

export async function getClaim(claimId: string): Promise<Claim | null> {
  return (await col.claims()).findOne({ _id: claimId });
}

/** Shallow $set on a claim (dot paths allowed, e.g. "external.insurerClaimNo"). */
export async function updateClaim(claimId: string, set: Record<string, unknown>): Promise<void> {
  await (await col.claims()).updateOne({ _id: claimId }, { $set: set });
}

/** The ONLY context the agent reloads after a crash. Hard-capped at 2k chars. */
export async function setCompactSummary(claimId: string, summary: string): Promise<void> {
  await (await col.claims()).updateOne({ _id: claimId }, { $set: { compactSummary: summary.slice(0, 2000) } });
}

export async function listActiveClaimIds(): Promise<string[]> {
  return (await col.claims()).distinct("_id", { phase: { $ne: "closed" } });
}

/** Insert or update one money line (by ref). Undefined fields are left as they are. */
export async function upsertMoneyItem(
  claimId: string,
  item: { ref: string; category: MoneyItemT["category"] } & Partial<Pick<MoneyItemT, "billed" | "submitted" | "paid" | "gapReason">>,
): Promise<void> {
  const claims = await col.claims();
  const claim = await claims.findOne({ _id: claimId }, { projection: { "money.items": 1 } });
  if (!claim) throw new Error(`claim ${claimId} not found`);
  const existing = claim.money.items.find((i) => i.ref === item.ref);
  if (existing) {
    const set: Record<string, unknown> = {};
    for (const k of ["billed", "submitted", "paid", "gapReason"] as const) {
      if (item[k] !== undefined) set[`money.items.$.${k}`] = item[k];
    }
    if (Object.keys(set).length) await claims.updateOne({ _id: claimId, "money.items.ref": item.ref }, { $set: set });
  } else {
    const full = MoneyItem.parse({ billed: 0, submitted: 0, paid: 0, gapReason: null, ...item });
    await claims.updateOne({ _id: claimId, "money.items.ref": { $ne: item.ref } }, { $push: { "money.items": full } });
  }
}

/** Recompute claims.money.totals from the line items with an aggregation (never JS arithmetic). */
export async function recomputeMoneyTotals(claimId: string): Promise<Claim["money"]["totals"]> {
  const claims = await col.claims();
  const rows = await claims
    .aggregate<{ _id: string; billed: number; submitted: number; paid: number }>([
      { $match: { _id: claimId } },
      { $unwind: "$money.items" },
      {
        $group: {
          _id: "$money.items.category",
          billed: { $sum: "$money.items.billed" },
          submitted: { $sum: "$money.items.submitted" },
          paid: { $sum: "$money.items.paid" },
        },
      },
    ])
    .toArray();
  const totals = { repair: zeroCat(), rental: zeroCat(), medical: zeroCat() };
  for (const r of rows) {
    const cat = r._id as keyof typeof totals;
    if (totals[cat]) totals[cat] = { billed: r.billed, submitted: r.submitted, paid: r.paid };
  }
  await claims.updateOne({ _id: claimId }, { $set: { "money.totals": totals } });
  return totals;
}

export interface MoneyGap {
  ref: string;
  category: string;
  billed: number;
  submitted: number;
  paid: number;
  billedMinusSubmitted: number;
  submittedMinusPaid: number;
  gapReason: string | null;
  explained: boolean;
}

/**
 * Money reconciliation as an aggregation pipeline: billed = submitted = paid per line item,
 * or the gap carries a recorded reason. Returns every gap and whether any is unexplained.
 */
export async function reconcileMoney(claimId: string): Promise<{ balanced: boolean; gaps: MoneyGap[]; unexplained: MoneyGap[]; itemCount: number }> {
  const claims = await col.claims();
  const [res] = await claims
    .aggregate<{ itemCount: number; gaps: MoneyGap[] }>([
      { $match: { _id: claimId } },
      { $unwind: "$money.items" },
      { $replaceWith: "$money.items" },
      {
        $set: {
          billedMinusSubmitted: { $round: [{ $subtract: ["$billed", "$submitted"] }, 2] },
          submittedMinusPaid: { $round: [{ $subtract: ["$submitted", "$paid"] }, 2] },
          gapReason: { $ifNull: ["$gapReason", null] },
        },
      },
      {
        $set: {
          hasGap: { $or: [{ $ne: ["$billedMinusSubmitted", 0] }, { $ne: ["$submittedMinusPaid", 0] }] },
          explained: { $gt: [{ $strLenCP: { $ifNull: ["$gapReason", ""] } }, 0] },
        },
      },
      {
        $facet: {
          count: [{ $count: "n" }],
          gaps: [{ $match: { hasGap: true } }, { $project: { _id: 0, hasGap: 0 } }, { $sort: { ref: 1 } }],
        },
      },
      { $project: { itemCount: { $ifNull: [{ $first: "$count.n" }, 0] }, gaps: 1 } },
    ])
    .toArray();
  const gaps = res?.gaps ?? [];
  const unexplained = gaps.filter((g) => !g.explained);
  return { balanced: unexplained.length === 0, gaps, unexplained, itemCount: res?.itemCount ?? 0 };
}
