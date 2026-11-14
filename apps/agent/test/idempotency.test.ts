import { describe, expect, it } from "vitest";
import { createMockServer } from "../src/mocks/server.ts";

function mocks() {
  let now = Date.parse("2026-11-14T09:00:00Z");
  const hooks: unknown[] = [];
  const m = createMockServer({ now: () => now, webhook: async (s, p) => void hooks.push([s, p]), statePath: null, latency: false, random: () => 0.99 });
  return { ...m, hooks, advanceDays: (d: number) => (now += d * 86_400_000) };
}
const reservation = { claimRef: "CLM-1", vehicleClass: "compact", startDate: "2026-11-14", days: 10, dailyRate: 40, customerName: "Dana Reyes" };
const post = (app: ReturnType<typeof mocks>["app"], url: string, body: unknown, key?: string) =>
  app.inject({ method: "POST", url, payload: body as object, headers: key ? { "idempotency-key": key } : {} });

describe("Idempotency-Key on every write endpoint", () => {
  it("the same key returns the same result and never creates a duplicate", async () => {
    const { app } = mocks();
    const a = await post(app, "/rental/reservations", reservation, "CLM-1:T5:create_reservation:1");
    const b = await post(app, "/rental/reservations", reservation, "CLM-1:T5:create_reservation:1");
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.json()).toEqual(a.json());
    expect(b.headers["idempotent-replay"]).toBe("true");
    const list = await app.inject({ method: "GET", url: "/rental/reservations?claimRef=CLM-1" });
    expect(list.json().reservations).toHaveLength(1);
  });
  it("a different key is a different request", async () => {
    const { app } = mocks();
    await post(app, "/rental/reservations", reservation, "k1");
    await post(app, "/rental/reservations", reservation, "k2");
    expect((await app.inject({ method: "GET", url: "/rental/reservations?claimRef=CLM-1" })).json().reservations).toHaveLength(2);
  });
  it("writes without a key are refused", async () => {
    const { app } = mocks();
    expect((await post(app, "/rental/reservations", reservation)).statusCode).toBe(400);
  });
  it("ghost booking: 200 + nothing stored; the retry with the SAME key creates exactly one", async () => {
    const { app } = mocks();
    await app.inject({ method: "POST", url: "/chaos/rental-drop-next-booking" });
    const ghost = await post(app, "/rental/reservations", reservation, "CLM-1:T5:create_reservation:1");
    expect(ghost.statusCode).toBe(200);
    const readback1 = await app.inject({ method: "GET", url: "/rental/reservations?key=CLM-1:T5:create_reservation:1" });
    expect(readback1.json().reservations).toHaveLength(0);
    const retry = await post(app, "/rental/reservations", reservation, "CLM-1:T5:create_reservation:1");
    expect(retry.statusCode).toBe(201);
    const again = await post(app, "/rental/reservations", reservation, "CLM-1:T5:create_reservation:1");
    expect(again.json()).toEqual(retry.json());
    const readback2 = await app.inject({ method: "GET", url: "/rental/reservations?key=CLM-1:T5:create_reservation:1" });
    expect(readback2.json().reservations).toHaveLength(1);
  });
  it("validation errors aren't stored: the same key succeeds after a drift fix", async () => {
    const { app } = mocks();
    const fnol = { policyNumber: "POL-1", lossDate: "2026-11-14", location: "x", description: "y", vehicleVin: "VIN", externalRef: "CLM-1" };
    await app.inject({ method: "POST", url: "/chaos/rename-field", payload: { system: "insurer", from: "policyNumber", to: "policy_ref" } });
    const bad = await post(app, "/insurer/claims", fnol, "CLM-1:T2:create_claim:1");
    expect(bad.statusCode).toBe(422);
    expect(bad.json().details).toEqual(expect.arrayContaining([{ field: "policy_ref", issue: "required" }]));
    const { policyNumber, ...rest } = fnol;
    const good = await post(app, "/insurer/claims", { ...rest, policy_ref: policyNumber }, "CLM-1:T2:create_claim:1");
    expect(good.statusCode).toBe(201);
    expect((await app.inject({ method: "GET", url: "/insurer/claims?key=CLM-1:T2:create_claim:1" })).json().claims).toHaveLength(1);
  });
  it("a definite refusal is stored: the same key replays the rejection (so the agent must mint a new key)", async () => {
    const { app } = mocks();
    const fnol = { policyNumber: "POL-1", lossDate: "2026-11-14", location: "x", description: "y", vehicleVin: "VIN", externalRef: "CLM-1" };
    const claimNo = (await post(app, "/insurer/claims", fnol, "fnol")).json().claimNo;
    await app.inject({ method: "POST", url: "/chaos/insurer-reject-next-invoice", payload: { reason: "missing treatment code" } });
    const inv = { policyNumber: "POL-1", invoiceId: "INV-1", amount: 180 };
    const r1 = await post(app, `/insurer/claims/${claimNo}/medical-invoices`, inv, "CLM-1:T13#INV-1:submit_medical_invoice:1");
    const r2 = await post(app, `/insurer/claims/${claimNo}/medical-invoices`, inv, "CLM-1:T13#INV-1:submit_medical_invoice:1");
    expect(r1.statusCode).toBe(409);
    expect(r2.statusCode).toBe(409);
    const r3 = await post(app, `/insurer/claims/${claimNo}/medical-invoices`, { ...inv, treatmentCode: "99213" }, "CLM-1:T13#INV-1:submit_medical_invoice:2");
    expect(r3.statusCode).toBe(201);
  });
  it("mocks advance on the simulated clock (estimate 2 days after drop-off)", async () => {
    const m = mocks();
    const bk = (await post(m.app, "/body_shop/bookings", { claimRef: "CLM-1", insurerClaimNo: "INS-1", vehicleVin: "VIN", dropOffDate: "2026-11-14", customerName: "D" }, "bk")).json();
    m.advanceDays(1);
    m.tick();
    expect((await m.app.inject({ method: "GET", url: `/body_shop/bookings/${bk.bookingId}` })).json().status).toBe("estimating");
    m.advanceDays(2);
    m.tick();
    const b = (await m.app.inject({ method: "GET", url: `/body_shop/bookings/${bk.bookingId}` })).json();
    expect(b.estimate.amount).toBe(2400);
    expect(Buffer.from(b.estimate.pdfBase64, "base64").subarray(0, 5).toString()).toBe("%PDF-");
  });
});
