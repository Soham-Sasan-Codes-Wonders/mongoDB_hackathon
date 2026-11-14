import { describe, expect, it } from "vitest";
import { ACTION_STATUSES, ACTION_TRANSITIONS, canTransition, mintIdempotencyKey, readyFrom } from "../src/db.ts";

describe("action state machine (packages/db)", () => {
  it("allows the happy path planned -> sent -> acknowledged -> confirmed", () => {
    expect(canTransition("planned", "sent")).toBe(true);
    expect(canTransition("sent", "acknowledged")).toBe(true);
    expect(canTransition("acknowledged", "confirmed")).toBe(true);
  });
  it("lets a webhook beat the API response (sent -> confirmed)", () => {
    expect(canTransition("sent", "confirmed")).toBe(true);
  });
  it("never treats an HTTP 200 as proof: planned/approved cannot jump to confirmed", () => {
    expect(canTransition("planned", "confirmed")).toBe(false);
    expect(canTransition("approved", "confirmed")).toBe(false);
  });
  it("a same-key retry goes through failed -> sent (an unproven send is parked first)", () => {
    expect(canTransition("acknowledged", "failed")).toBe(true);
    expect(canTransition("sent", "failed")).toBe(true);
    expect(canTransition("failed", "sent")).toBe(true);
    expect(canTransition("sent", "sent")).toBe(false);
  });
  it("a rejected action is never retried", () => {
    expect(canTransition("rejected", "sent")).toBe(false);
    expect(ACTION_TRANSITIONS.rejected).toEqual([]);
  });
  it("gated actions must be approved before sending; a decline cancels", () => {
    expect(canTransition("awaiting_approval", "sent")).toBe(false);
    expect(canTransition("awaiting_approval", "approved")).toBe(true);
    expect(canTransition("awaiting_approval", "cancelled")).toBe(true);
    expect(canTransition("approved", "sent")).toBe(true);
  });
  it("terminal states have no exits", () => {
    for (const s of ["confirmed", "rejected", "cancelled", "closed_by_human"] as const) {
      for (const to of ACTION_STATUSES) expect(canTransition(s, to)).toBe(false);
    }
  });
  it("an unverified action can be closed by a human (the operator gate)", () => {
    for (const s of ["sent", "acknowledged", "failed", "planned", "awaiting_approval"] as const) expect(canTransition(s, "closed_by_human")).toBe(true);
  });
});

describe("idempotency keys", () => {
  it("are deterministic per claim/task/kind/attempt", () => {
    expect(mintIdempotencyKey("CLM-1042", "T5", "create_reservation", 1)).toBe("CLM-1042:T5:create_reservation:1");
    expect(mintIdempotencyKey("CLM-1042", "T13#INV-1", "submit_medical_invoice", 2)).toBe("CLM-1042:T13#INV-1:submit_medical_invoice:2");
  });
  it("reject attempt < 1", () => {
    expect(() => mintIdempotencyKey("CLM-1", "T1", "x", 0)).toThrow();
  });
});

describe("findReadyTasks (dependency graph, plain code)", () => {
  type T = { taskId: string; status: never; dependsOn: string[] };
  const t = (taskId: string, status: string, dependsOn: string[] = []): T => ({ taskId, status: status as never, dependsOn });
  it("returns pending tasks whose dependencies are all resolved", () => {
    expect(readyFrom([t("T1", "confirmed"), t("T2", "pending", ["T1"]), t("T3", "pending", ["T2"])]).map((x: T) => x.taskId)).toEqual(["T2"]);
  });
  it("an inserted drift task blocks T9 until it is confirmed", () => {
    const base = [t("T8", "confirmed"), t("T9a#photos", "in_progress"), t("T9", "pending", ["T8", "T9a#photos"])];
    expect(readyFrom(base)).toEqual([]);
    base[1]!.status = "confirmed" as never;
    expect(readyFrom(base).map((x: T) => x.taskId)).toEqual(["T9"]);
  });
  it("denied and closed_by_human count as resolved (T18 can close)", () => {
    expect(readyFrom([t("A", "denied"), t("B", "closed_by_human"), t("T18", "pending", ["A", "B"])]).map((x: T) => x.taskId)).toEqual(["T18"]);
  });
  it("a missing dependency never counts as done", () => {
    expect(readyFrom([t("T2", "pending", ["T1"])])).toEqual([]);
  });
});
