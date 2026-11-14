import { describe, expect, it } from "vitest";
import { ACTION_STATUSES, canTransition, computeReady, mintIdempotencyKey, TRANSITIONS } from "@claims/db";

describe("action state machine", () => {
  it("allows the happy path planned -> sent -> acknowledged -> confirmed", () => {
    expect(canTransition("planned", "sent")).toBe(true);
    expect(canTransition("sent", "acknowledged")).toBe(true);
    expect(canTransition("acknowledged", "confirmed")).toBe(true);
  });
  it("lets a webhook beat the API response (sent -> confirmed)", () => {
    expect(canTransition("sent", "confirmed")).toBe(true);
  });
  it("never treats an HTTP 200 as proof: planned cannot jump to confirmed", () => {
    expect(canTransition("planned", "confirmed")).toBe(false);
    expect(canTransition("approved", "confirmed")).toBe(false);
  });
  it("retries keep the action (sent/acknowledged -> sent)", () => {
    expect(canTransition("sent", "sent")).toBe(true);
    expect(canTransition("acknowledged", "sent")).toBe(true);
  });
  it("a rejected action is never retried", () => {
    expect(canTransition("rejected", "sent")).toBe(false);
    expect(TRANSITIONS.rejected).toEqual([]);
  });
  it("gated actions must be approved before sending; a decline cancels", () => {
    expect(canTransition("awaiting_approval", "sent")).toBe(false);
    expect(canTransition("awaiting_approval", "approved")).toBe(true);
    expect(canTransition("awaiting_approval", "cancelled")).toBe(true);
    expect(canTransition("approved", "sent")).toBe(true);
  });
  it("terminal states have no exits", () => {
    for (const s of ["confirmed", "rejected", "failed", "cancelled", "closed_by_human"] as const) {
      for (const to of ACTION_STATUSES) expect(canTransition(s, to)).toBe(false);
    }
  });
  it("any open action can be closed by a human", () => {
    for (const s of ["planned", "awaiting_approval", "approved", "sent", "acknowledged"] as const) expect(canTransition(s, "closed_by_human")).toBe(true);
  });
});

describe("idempotency keys", () => {
  it("are deterministic per claim/task/kind/attempt", () => {
    expect(mintIdempotencyKey("CLM-1042", "T5", "create_reservation", 1)).toBe("CLM-1042:T5:create_reservation:1");
    expect(mintIdempotencyKey("CLM-1042", "T5", "create_reservation", 1)).toBe(mintIdempotencyKey("CLM-1042", "T5", "create_reservation", 1));
    expect(mintIdempotencyKey("CLM-1042", "T13#INV-1", "submit_medical_invoice", 2)).toBe("CLM-1042:T13#INV-1:submit_medical_invoice:2");
  });
  it("reject attempt < 1", () => {
    expect(() => mintIdempotencyKey("CLM-1", "T1", "x", 0)).toThrow();
  });
});

describe("findReadyTasks (dependency graph, plain code)", () => {
  const t = (taskId: string, status: string, dependsOn: string[] = []) => ({ taskId, status: status as never, dependsOn });
  it("returns pending tasks whose dependencies are all resolved", () => {
    const ready = computeReady([t("T1", "confirmed"), t("T2", "pending", ["T1"]), t("T3", "pending", ["T2"])]);
    expect(ready.map((x) => x.taskId)).toEqual(["T2"]);
  });
  it("an inserted drift task blocks T9 until it is confirmed", () => {
    const base = [t("T8", "confirmed"), t("T9a#photos", "in_progress"), t("T9", "pending", ["T8", "T9a#photos"])];
    expect(computeReady(base).map((x) => x.taskId)).toEqual([]);
    base[1]!.status = "confirmed" as never;
    expect(computeReady(base).map((x) => x.taskId)).toEqual(["T9"]);
  });
  it("denied and closed_by_human count as resolved (T18 can close)", () => {
    expect(computeReady([t("A", "denied"), t("B", "closed_by_human"), t("T18", "pending", ["A", "B"])]).map((x) => x.taskId)).toEqual(["T18"]);
  });
  it("a missing dependency never counts as done", () => {
    expect(computeReady([t("T2", "pending", ["T1"])])).toEqual([]);
  });
});
