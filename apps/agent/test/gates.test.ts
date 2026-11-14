import { ObjectId } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getApproval = vi.fn();
const transitionAction = vi.fn();
vi.mock("../src/db.ts", async (orig) => {
  const real = await orig<typeof import("../src/db.ts")>();
  return {
    ...real,
    approvals: { ...real.approvals, getApproval: (...a: unknown[]) => getApproval(...a) },
    actions: { ...real.actions, transitionAction: (...a: unknown[]) => transitionAction(...a) },
    claims: { ...real.claims, getClaim: vi.fn(async () => ({ _id: "CLM-1", external: { insurerClaimNo: "INS-1" } })) },
  };
});

const { assertExecutable, execute, retry, GateError } = await import("../src/executor/index.ts");

const id = new ObjectId();
const action = (over: Record<string, unknown> = {}) =>
  ({ _id: id, claimId: "CLM-1", taskId: "T15", system: "insurer", kind: "accept_settlement", idempotencyKey: "CLM-1:T15:accept_settlement:1", payload: { offerId: "OFF-1" }, expectedEffect: { offerAccepted: true }, verifyBy: "readback", status: "planned", attempts: 0, deadline: new Date(), gate: null, approvalId: null, history: [], createdAt: new Date(), updatedAt: new Date(), ...over }) as never;
const approval = (status: string, actionId = id) => ({ _id: new ObjectId(), status, actionId: String(actionId) }) as never;

describe("assertExecutable (code, not a prompt)", () => {
  it("runs a planned ungated action", () => {
    expect(() => assertExecutable(action(), null)).not.toThrow();
  });
  it("refuses anything that isn't planned/approved on a first send", () => {
    for (const s of ["awaiting_approval", "sent", "acknowledged", "confirmed", "rejected", "cancelled"]) {
      expect(() => assertExecutable(action({ status: s }), null)).toThrow(GateError);
    }
  });
  it("refuses a gated action without an approval document", () => {
    expect(() => assertExecutable(action({ gate: "accept_settlement", status: "approved" }), null)).toThrow(/no approval/);
  });
  it("refuses a gated action whose approval is pending or declined", () => {
    expect(() => assertExecutable(action({ gate: "accept_settlement", status: "approved" }), approval("pending"))).toThrow(/pending/);
    expect(() => assertExecutable(action({ gate: "accept_settlement", status: "approved" }), approval("declined"))).toThrow(/declined/);
  });
  it("refuses an approval that belongs to another action", () => {
    expect(() => assertExecutable(action({ gate: "sign_release", status: "approved" }), approval("approved", new ObjectId()))).toThrow(/another action/);
  });
  it("allows a gated action once its own approval is approved", () => {
    expect(() => assertExecutable(action({ gate: "accept_settlement", status: "approved" }), approval("approved"))).not.toThrow();
  });
  it("retries only sent/acknowledged/failed actions, and still checks the gate", () => {
    expect(() => assertExecutable(action({ status: "acknowledged" }), null, "retry")).not.toThrow();
    expect(() => assertExecutable(action({ status: "failed" }), null, "retry")).not.toThrow();
    expect(() => assertExecutable(action({ status: "planned" }), null, "retry")).toThrow(GateError);
    expect(() => assertExecutable(action({ status: "sent", gate: "accept_settlement" }), approval("declined"), "retry")).toThrow(GateError);
  });
});

describe("execute() enforces the gate before any side effect", () => {
  beforeEach(() => {
    getApproval.mockReset();
    transitionAction.mockReset();
  });
  it("throws GateError and never transitions or sends for an unapproved gated action", async () => {
    getApproval.mockResolvedValue(approval("pending"));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(execute(action({ gate: "accept_settlement", status: "approved", approvalId: String(new ObjectId()) }))).rejects.toBeInstanceOf(GateError);
    expect(transitionAction).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
  it("throws for awaiting_approval even if someone approved the doc but the agent hasn't moved the action", async () => {
    getApproval.mockResolvedValue(approval("approved"));
    await expect(execute(action({ gate: "accept_settlement", status: "awaiting_approval", approvalId: "x".repeat(24) }))).rejects.toBeInstanceOf(GateError);
    expect(transitionAction).not.toHaveBeenCalled();
  });
  it("retry() refuses a confirmed action", async () => {
    await expect(retry(action({ status: "confirmed" }))).rejects.toBeInstanceOf(GateError);
  });
});
