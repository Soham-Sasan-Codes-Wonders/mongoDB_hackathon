import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { V1_SYSTEM_SPECS, type SystemSpec } from "@claims/db";
import { makePdf } from "./pdf.ts";
import { emptyState, loadState, saveState, type Booking, type InsurerClaim, type MockState, type Reservation, type Sys } from "./state.ts";

const DAY = 86_400_000;
const SYSTEMS: Sys[] = ["insurer", "body_shop", "rental", "clinic"];

export interface MockOptions {
  /** Simulated time in ms (clock.now() in the real server; injectable for tests). */
  now: () => number;
  /** Deliver a webhook to the agent (:4100/webhooks/<system>). */
  webhook: (system: Sys, payload: Record<string, unknown>) => Promise<void>;
  statePath?: string | null;
  random?: () => number;
  latency?: boolean;
  logger?: boolean;
}

type Result = { status: number; body: unknown; ghost?: boolean };

export function createMockServer(opts: MockOptions) {
  const rnd = opts.random ?? Math.random;
  let S: MockState = loadState(opts.statePath ?? null);
  let dirty = false;
  const persist = () => {
    dirty = true;
  };
  const flush = () => {
    if (dirty) saveState(opts.statePath ?? null, S);
    dirty = false;
  };
  const app: FastifyInstance = Fastify({ logger: opts.logger ?? false });

  const id = (prefix: string) => `${prefix}-${++S.seq}`;
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const schedule = (inDays: number, type: string, args: Record<string, unknown>) => {
    S.scheduled.push({ id: ++S.seq, dueAt: opts.now() + inDays * DAY, type, args });
    persist();
  };
  const hook = (system: Sys, event: string, claimRef: string, data: Record<string, unknown>, key?: string, force = false) => {
    if (system === "rental" && !force && rnd() < S.chaos.rentalWebhookDropRate) {
      app.log.info(`rental webhook ${event} dropped on purpose`);
      return;
    }
    opts.webhook(system, { event, claimRef, data, key: key ?? null, at: new Date(opts.now()).toISOString() }).catch(() => undefined);
  };
  const chaosLog = (what: string) => {
    S.chaos.log.push({ at: opts.now(), what });
    persist();
  };

  /* ------------------------------------------------------------ spec + drift */

  function currentSpec(sys: Sys): SystemSpec {
    const base = structuredClone(V1_SYSTEM_SPECS[sys]);
    const renames = S.chaos.renames[sys] ?? {};
    const steps = S.chaos.requiredSteps[sys] ?? [];
    const changed = Object.keys(renames).length > 0 || steps.length > 0;
    for (const e of base.endpoints) for (const fl of e.fields) if (renames[fl.name]) fl.name = renames[fl.name]!;
    for (const step of steps) {
      if (!base.workflowSteps.includes(step)) {
        const at = base.workflowSteps.indexOf("approval");
        base.workflowSteps.splice(at >= 0 ? at : base.workflowSteps.length, 0, step);
      }
    }
    if (changed) base.version = 2;
    return base;
  }
  /** Read a canonical field from a body using the system's CURRENT name for it. */
  const field = (sys: Sys, body: Record<string, unknown>, canonical: string) => body[S.chaos.renames[sys]?.[canonical] ?? canonical];

  function validate(sys: Sys, op: string, body: Record<string, unknown>): Result | null {
    const ep = currentSpec(sys).endpoints.find((e) => e.op === op);
    if (!ep) return null;
    const details: { field: string; issue: string }[] = [];
    for (const fl of ep.fields) if (fl.required && (body[fl.name] === undefined || body[fl.name] === null || body[fl.name] === "")) details.push({ field: fl.name, issue: "required" });
    for (const [from, to] of Object.entries(S.chaos.renames[sys] ?? {})) if (from in body && ep.fields.some((x) => x.name === to)) details.push({ field: from, issue: "unknown field" });
    if (!details.length) return null;
    return { status: 422, body: { error: "validation", message: details.map((d) => `${d.field}: ${d.issue}`).join("; "), details } };
  }

  /* -------------------------------------------------------------- idempotency */

  async function idem(sys: Sys, req: FastifyRequest, reply: FastifyReply, run: () => Result) {
    if (opts.latency !== false) await new Promise((r) => setTimeout(r, 5 + rnd() * 40));
    const key = String(req.headers["idempotency-key"] ?? "");
    if (!key) return reply.code(400).send({ error: "validation", message: "Idempotency-Key header required", details: [{ field: "Idempotency-Key", issue: "required" }] });
    const stored = S.idem[sys][key];
    if (stored) return reply.code(stored.status).header("idempotent-replay", "true").send(stored.body);
    const r = run();
    // Validation errors are not stored (the same key may be retried after a fix, like Stripe).
    // Ghost bookings return 200 and store nothing at all.
    if (!r.ghost && r.status !== 422) S.idem[sys][key] = { status: r.status, body: r.body };
    persist();
    return reply.code(r.status).send(r.body);
  }

  const body = (req: FastifyRequest) => (req.body ?? {}) as Record<string, unknown>;
  const key = (req: FastifyRequest) => String(req.headers["idempotency-key"] ?? "");
  const notFound = (reply: FastifyReply, what: string) => reply.code(404).send({ error: "not_found", message: `${what} not found` });
  const findInsurerByRef = (ref: string) => Object.values(S.insurer).find((c) => c.externalRef === ref);

  /* ================================================================ INSURER */

  app.get("/insurer/describe", async () => currentSpec("insurer"));

  app.post("/insurer/claims", (req, reply) =>
    idem("insurer", req, reply, () => {
      const b = body(req);
      const v = validate("insurer", "create_claim", b);
      if (v) return v;
      const claimNo = id("INS");
      const c: InsurerClaim = {
        claimNo,
        key: key(req),
        externalRef: String(b.externalRef),
        policyNumber: String(field("insurer", b, "policyNumber")),
        lossDate: String(b.lossDate),
        description: String(b.description),
        injuries: Boolean(b.injuries),
        status: "open",
        createdAt: opts.now(),
        adjuster: null,
        estimates: [],
        estimateStatus: "none",
        requirements: (S.chaos.requiredSteps.insurer ?? []).map((step) => ({ step, status: "missing" as const })),
        photos: [],
        medicalInvoices: [],
        offer: null,
        releaseSigned: null,
        payments: [],
      };
      S.insurer[claimNo] = c;
      schedule(0.5, "insurer.assign_adjuster", { claimNo });
      return { status: 201, body: { claimNo, status: "open" } };
    }),
  );

  app.get("/insurer/claims", async (req) => {
    const q = req.query as { key?: string; externalRef?: string };
    return { claims: Object.values(S.insurer).filter((c) => (q.key ? c.key === q.key : true) && (q.externalRef ? c.externalRef === q.externalRef : true)) };
  });
  app.get("/insurer/claims/:claimNo", async (req, reply) => {
    const c = S.insurer[(req.params as { claimNo: string }).claimNo];
    return c ?? notFound(reply, "claim");
  });

  app.get("/insurer/policies/:policyNumber", async (req, reply) => {
    const p = (req.params as { policyNumber: string }).policyNumber;
    if (!/^POL-\d+$/.test(p) || p === "POL-00000") return notFound(reply, "policy");
    return { policyNumber: p, holder: "on file", rentalDailyLimit: 40, rentalMaxDays: 21, deductible: 500, medicalCoverage: 5000, status: "active" };
  });

  const withClaim = (req: FastifyRequest, reply: FastifyReply, fn: (c: InsurerClaim) => Result) => {
    const c = S.insurer[(req.params as { claimNo: string }).claimNo];
    if (!c) return reply.code(404).send({ error: "not_found", message: "claim not found" });
    return idem("insurer", req, reply, () => fn(c));
  };

  const maybeScheduleApproval = (c: InsurerClaim, inDays: number) => {
    if (c.estimateStatus !== "pending") return;
    if (c.requirements.some((r) => r.status === "missing")) return;
    const est = c.estimates.at(-1);
    if (est) schedule(inDays, "insurer.approve_estimate", { claimNo: c.claimNo, estimateId: est.id });
  };

  app.post("/insurer/claims/:claimNo/estimates", (req, reply) =>
    withClaim(req, reply, (c) => {
      const b = body(req);
      const v = validate("insurer", "submit_estimate", b);
      if (v) return v;
      const est = { id: id("EST"), key: key(req), amount: Number(b.amount), shopRef: String(b.shopRef), status: "received" as const, approvedAmount: null, receivedAt: opts.now(), hasPdf: Boolean(b.pdfBase64) };
      c.estimates.push(est);
      c.estimateStatus = "pending";
      maybeScheduleApproval(c, 1);
      return { status: 201, body: { estimateId: est.id, status: "received", pendingRequirements: c.requirements.filter((r) => r.status === "missing").map((r) => r.step) } };
    }),
  );

  app.post("/insurer/claims/:claimNo/photos", (req, reply) =>
    withClaim(req, reply, (c) => {
      const b = body(req);
      const v = validate("insurer", "upload_photos", b);
      if (v) return v;
      const photos = (b.photos as string[]) ?? [];
      c.photos.push(...photos);
      for (const r of c.requirements) if (r.step === "photos") r.status = "received";
      maybeScheduleApproval(c, 0.5);
      return { status: 201, body: { received: photos.length, requirements: c.requirements } };
    }),
  );

  app.post("/insurer/claims/:claimNo/medical-invoices", (req, reply) =>
    withClaim(req, reply, (c) => {
      const b = body(req);
      const v = validate("insurer", "submit_medical_invoice", b);
      if (v) return v;
      const invoiceId = String(b.invoiceId);
      if (S.chaos.insurerRejectNextInvoice) {
        const reason = S.chaos.insurerRejectNextInvoice;
        S.chaos.insurerRejectNextInvoice = null;
        return { status: 409, body: { error: "rejected", reason, invoiceId } };
      }
      if (c.medicalInvoices.some((m) => m.invoiceId === invoiceId)) return { status: 409, body: { error: "rejected", reason: "duplicate submission", invoiceId } };
      c.medicalInvoices.push({ invoiceId, key: key(req), amount: Number(b.amount), treatmentCode: (b.treatmentCode as string) ?? null, status: "received", paidAmount: 0, receivedAt: opts.now() });
      schedule(2, "insurer.pay_invoice", { claimNo: c.claimNo, invoiceId });
      return { status: 201, body: { invoiceId, status: "received" } };
    }),
  );

  app.post("/insurer/claims/:claimNo/settlement/release", (req, reply) =>
    withClaim(req, reply, (c) => {
      const b = body(req);
      const v = validate("insurer", "sign_release", b);
      if (v) return v;
      if (!c.offer || c.offer.offerId !== b.offerId) return { status: 409, body: { error: "rejected", reason: "no such offer" } };
      c.releaseSigned = { signedBy: String(b.signedBy), at: opts.now(), key: key(req) };
      return { status: 201, body: { offerId: c.offer.offerId, releaseSigned: true } };
    }),
  );

  app.post("/insurer/claims/:claimNo/settlement/accept", (req, reply) =>
    withClaim(req, reply, (c) => {
      const b = body(req);
      const v = validate("insurer", "accept_settlement", b);
      if (v) return v;
      if (!c.offer || c.offer.offerId !== b.offerId) return { status: 409, body: { error: "rejected", reason: "no such offer" } };
      if (c.offer.requiresRelease && !c.releaseSigned) return { status: 409, body: { error: "rejected", reason: "release must be signed before acceptance" } };
      c.offer.status = "accepted";
      schedule(1, "insurer.pay_settlement", { claimNo: c.claimNo });
      return { status: 201, body: { offerId: c.offer.offerId, status: "accepted" } };
    }),
  );

  /* ============================================================== BODY SHOP */

  app.get("/body_shop/describe", async () => currentSpec("body_shop"));

  app.post("/body_shop/bookings", (req, reply) =>
    idem("body_shop", req, reply, () => {
      const b = body(req);
      const v = validate("body_shop", "create_booking", b);
      if (v) return v;
      const bookingId = id("BK");
      const bk: Booking = {
        bookingId,
        key: key(req),
        claimRef: String(b.claimRef),
        insurerClaimNo: String(b.insurerClaimNo),
        vehicleVin: String(field("body_shop", b, "vehicleVin")),
        customerName: String(b.customerName),
        dropOffDate: String(b.dropOffDate),
        status: "booked",
        estimate: null,
        authorized: null,
        paymentReceived: 0,
        readyAt: null,
        statusHistory: [{ status: "booked", at: opts.now() }],
      };
      S.bookings[bookingId] = bk;
      const dropIn = Math.max(0.25, (Date.parse(bk.dropOffDate) + 9 * 3_600_000 - opts.now()) / DAY);
      schedule(Math.min(dropIn, 1), "shop.drop_off", { bookingId });
      return { status: 201, body: { bookingId, status: "booked", dropOffDate: bk.dropOffDate } };
    }),
  );
  app.get("/body_shop/bookings", async (req) => {
    const q = req.query as { key?: string; claimRef?: string };
    return { bookings: Object.values(S.bookings).filter((b) => (q.key ? b.key === q.key : true) && (q.claimRef ? b.claimRef === q.claimRef : true)) };
  });
  app.get("/body_shop/bookings/:bookingId", async (req, reply) => S.bookings[(req.params as { bookingId: string }).bookingId] ?? notFound(reply, "booking"));
  app.get("/body_shop/bookings/:bookingId/estimate.pdf", async (req, reply) => {
    const bk = S.bookings[(req.params as { bookingId: string }).bookingId];
    if (!bk?.estimate) return notFound(reply, "estimate");
    return reply.type("application/pdf").send(Buffer.from(bk.estimate.pdfBase64, "base64"));
  });

  app.post("/body_shop/bookings/:bookingId/authorize", (req, reply) => {
    const bk = S.bookings[(req.params as { bookingId: string }).bookingId];
    if (!bk) return notFound(reply, "booking");
    return idem("body_shop", req, reply, () => {
      const b = body(req);
      const v = validate("body_shop", "authorize_repair", b);
      if (v) return v;
      if (!bk.estimate) return { status: 409, body: { error: "rejected", reason: "no estimate yet" } };
      bk.authorized = { approvedAmount: Number(b.approvedAmount), key: key(req), at: opts.now() };
      setShopStatus(bk, "in_repair");
      schedule(2, "shop.repair_progress", { bookingId: bk.bookingId, pct: 35 });
      schedule(4, "shop.repair_progress", { bookingId: bk.bookingId, pct: 75 });
      schedule(6, "shop.ready", { bookingId: bk.bookingId });
      return { status: 201, body: { bookingId: bk.bookingId, status: "in_repair" } };
    });
  });

  function setShopStatus(bk: Booking, status: Booking["status"]) {
    bk.status = status;
    bk.statusHistory.push({ status, at: opts.now() });
    persist();
    hook("body_shop", "status_changed", bk.claimRef, { bookingId: bk.bookingId, status }, bk.key);
  }

  /* ================================================================= RENTAL */

  app.get("/rental/describe", async () => currentSpec("rental"));

  app.post("/rental/reservations", (req, reply) =>
    idem("rental", req, reply, () => {
      const b = body(req);
      const v = validate("rental", "create_reservation", b);
      if (v) return v;
      if (S.chaos.rentalDropNext > 0) {
        S.chaos.rentalDropNext--;
        chaosLog(`ghost booking for key ${key(req)}: returned 200, stored nothing`);
        return { status: 200, body: { reservationId: id("RES"), status: "reserved" }, ghost: true };
      }
      const days = Number(b.days);
      const start = String(b.startDate);
      const r: Reservation = {
        reservationId: id("RES"),
        key: key(req),
        claimRef: String(b.claimRef),
        vehicleClass: String(b.vehicleClass),
        customerName: String(b.customerName),
        startDate: start,
        days,
        dailyRate: Number(b.dailyRate),
        endDate: day(Date.parse(start) + days * DAY),
        status: "reserved",
        extensions: [],
        returnedDate: null,
        daysUsed: null,
        finalCharge: null,
      };
      S.reservations[r.reservationId] = r;
      hook("rental", "reservation_created", r.claimRef, { reservationId: r.reservationId, endDate: r.endDate }, r.key);
      return { status: 201, body: { reservationId: r.reservationId, status: "reserved", endDate: r.endDate } };
    }),
  );
  app.get("/rental/reservations", async (req) => {
    const q = req.query as { key?: string; claimRef?: string };
    return {
      reservations: Object.values(S.reservations).filter(
        (r) => (q.key ? r.key === q.key || r.extensions.some((e) => e.key === q.key) : true) && (q.claimRef ? r.claimRef === q.claimRef : true),
      ),
    };
  });
  app.get("/rental/reservations/:reservationId", async (req, reply) => S.reservations[(req.params as { reservationId: string }).reservationId] ?? notFound(reply, "reservation"));

  app.post("/rental/reservations/:reservationId/extend", (req, reply) => {
    const r = S.reservations[(req.params as { reservationId: string }).reservationId];
    if (!r) return notFound(reply, "reservation");
    return idem("rental", req, reply, () => {
      const b = body(req);
      const v = validate("rental", "extend_reservation", b);
      if (v) return v;
      if (r.status !== "reserved") return { status: 409, body: { error: "rejected", reason: "reservation already returned" } };
      r.days = Number(b.days);
      r.endDate = day(Date.parse(r.startDate) + r.days * DAY);
      r.extensions.push({ key: key(req), days: r.days, at: opts.now() });
      hook("rental", "reservation_extended", r.claimRef, { reservationId: r.reservationId, endDate: r.endDate, days: r.days }, key(req));
      return { status: 200, body: { reservationId: r.reservationId, days: r.days, endDate: r.endDate } };
    });
  });

  app.post("/rental/reservations/:reservationId/return", (req, reply) => {
    const r = S.reservations[(req.params as { reservationId: string }).reservationId];
    if (!r) return notFound(reply, "reservation");
    return idem("rental", req, reply, () => {
      const b = body(req);
      const v = validate("rental", "return_reservation", b);
      if (v) return v;
      const ret = String(b.returnDate);
      r.status = "returned";
      r.returnedDate = ret;
      r.daysUsed = Math.max(1, Math.ceil((Date.parse(ret) - Date.parse(r.startDate)) / DAY));
      r.finalCharge = r.daysUsed * r.dailyRate;
      const ins = findInsurerByRef(r.claimRef);
      if (ins) schedule(1, "insurer.pay_rental", { claimNo: ins.claimNo, reservationId: r.reservationId });
      hook("rental", "reservation_returned", r.claimRef, { reservationId: r.reservationId, finalCharge: r.finalCharge }, key(req));
      return { status: 200, body: { reservationId: r.reservationId, status: "returned", daysUsed: r.daysUsed, finalCharge: r.finalCharge } };
    });
  });

  /* ================================================================= CLINIC */

  app.get("/clinic/describe", async () => currentSpec("clinic"));

  /** World simulation (not called by the agent): the claimant visits the clinic. */
  app.post("/clinic/visits", async (req) => {
    const b = body(req);
    const visitId = id("VIS");
    S.visits[visitId] = { claimRef: String(b.claimRef), patientName: String(b.patientName ?? "patient"), at: opts.now() };
    schedule(Number(b.firstInvoiceInDays ?? 2), "clinic.issue_invoice", { visitId, n: 1 });
    schedule(Number(b.secondInvoiceInDays ?? 5), "clinic.issue_invoice", { visitId, n: 2 });
    persist();
    return { visitId };
  });
  app.get("/clinic/invoices", async (req) => {
    const q = req.query as { claimRef?: string };
    return { invoices: Object.values(S.invoices).filter((i) => (q.claimRef ? i.claimRef === q.claimRef : true)) };
  });
  app.get("/clinic/invoices/:invoiceId", async (req, reply) => S.invoices[(req.params as { invoiceId: string }).invoiceId] ?? notFound(reply, "invoice"));

  /* ========================================================= messages (all) */

  for (const sys of SYSTEMS) {
    app.post(`/${sys}/messages`, (req, reply) =>
      idem(sys, req, reply, () => {
        const b = body(req);
        const v = validate(sys, "send_message", b);
        if (v) return v;
        const m = { id: id("MSG"), key: key(req), ref: String(b.ref), text: String(b.text), at: opts.now() };
        S.messages[sys].push(m);
        return { status: 201, body: { messageId: m.id } };
      }),
    );
    app.get(`/${sys}/messages`, async (req) => {
      const q = req.query as { key?: string };
      return { messages: S.messages[sys].filter((m) => (q.key ? m.key === q.key : true)) };
    });
  }

  /* ================================================================== CHAOS */

  app.post("/chaos/rental-drop-next-booking", async () => {
    S.chaos.rentalDropNext++;
    chaosLog("rental will drop the next booking (ghost)");
    return { ok: true, rentalDropNext: S.chaos.rentalDropNext };
  });
  app.post("/chaos/rename-field", async (req, reply) => {
    const b = body(req) as { system?: Sys; from?: string; to?: string };
    const system = (b.system ?? "insurer") as Sys;
    if (!SYSTEMS.includes(system)) return reply.code(400).send({ error: "unknown system" });
    const from = b.from ?? "policyNumber";
    const to = b.to ?? "policy_ref";
    S.chaos.renames[system] = { ...(S.chaos.renames[system] ?? {}), [from]: to };
    chaosLog(`${system} renamed ${from} -> ${to}`);
    return { ok: true, describe: currentSpec(system) };
  });
  app.post("/chaos/require-step", async (req, reply) => {
    const b = body(req) as { system?: Sys; step?: string };
    const system = (b.system ?? "insurer") as Sys;
    if (system !== "insurer") return reply.code(400).send({ error: "only the insurer supports new required steps" });
    const step = b.step ?? "photos";
    S.chaos.requiredSteps[system] = [...new Set([...(S.chaos.requiredSteps[system] ?? []), step])];
    for (const c of Object.values(S.insurer)) {
      if (c.estimateStatus === "approved" || c.requirements.some((r) => r.step === step)) continue;
      c.requirements.push({ step, status: "missing" });
      hook("insurer", "requirement_added", c.externalRef, { claimNo: c.claimNo, step }, undefined, true);
    }
    chaosLog(`insurer now requires step '${step}' before approval`);
    return { ok: true, describe: currentSpec(system) };
  });
  app.post("/chaos/insurer-reject-next-invoice", async (req) => {
    const b = body(req) as { reason?: string };
    S.chaos.insurerRejectNextInvoice = b.reason ?? "missing treatment code";
    chaosLog(`insurer will reject the next medical invoice: ${S.chaos.insurerRejectNextInvoice}`);
    return { ok: true };
  });
  app.post("/chaos/fire-webhooks", async (req) => {
    const b = body(req) as { count?: number; claimRef?: string };
    const count = Math.max(1, Math.min(20, Number(b.count ?? 3)));
    const ins = b.claimRef ? findInsurerByRef(b.claimRef) : Object.values(S.insurer).sort((x, y) => y.createdAt - x.createdAt)[0];
    const claimRef = b.claimRef ?? ins?.externalRef;
    if (!claimRef) return { ok: false, fired: 0, reason: "no claims yet" };
    const bk = Object.values(S.bookings).find((x) => x.claimRef === claimRef);
    const res = Object.values(S.reservations).find((x) => x.claimRef === claimRef);
    const fired: string[] = [];
    for (let i = 0; i < count; i++) {
      const which = i % 3;
      if (which === 0 && ins) {
        hook("insurer", "claim_status", claimRef, { claimNo: ins.claimNo, estimateStatus: ins.estimateStatus, adjuster: ins.adjuster?.name ?? null, seq: i }, undefined, true);
        fired.push("insurer.claim_status");
      } else if (which === 1 && bk) {
        hook("body_shop", "status_changed", claimRef, { bookingId: bk.bookingId, status: bk.status, seq: i }, bk.key, true);
        fired.push("body_shop.status_changed");
      } else if (res) {
        hook("rental", "reservation_status", claimRef, { reservationId: res.reservationId, status: res.status, endDate: res.endDate, seq: i }, res.key, true);
        fired.push("rental.reservation_status");
      } else if (ins) {
        hook("insurer", "claim_status", claimRef, { claimNo: ins.claimNo, estimateStatus: ins.estimateStatus, seq: i }, undefined, true);
        fired.push("insurer.claim_status");
      }
    }
    chaosLog(`fired ${fired.length} webhooks for ${claimRef}`);
    return { ok: true, fired: fired.length, events: fired, claimRef };
  });
  app.post("/chaos/rental-webhook-drop-rate", async (req) => {
    S.chaos.rentalWebhookDropRate = Math.max(0, Math.min(1, Number(body(req).rate ?? 0.5)));
    return { ok: true, rate: S.chaos.rentalWebhookDropRate };
  });
  app.get("/chaos/state", async () => ({
    chaos: S.chaos,
    describeVersions: Object.fromEntries(SYSTEMS.map((s) => [s, currentSpec(s).version])),
    counts: {
      insurerClaims: Object.keys(S.insurer).length,
      bookings: Object.keys(S.bookings).length,
      reservations: Object.keys(S.reservations).length,
      invoices: Object.keys(S.invoices).length,
      scheduled: S.scheduled.length,
    },
    reservations: Object.values(S.reservations).map((r) => ({ reservationId: r.reservationId, key: r.key, claimRef: r.claimRef, days: r.days, status: r.status })),
  }));
  app.post("/chaos/reset", async () => {
    S = emptyState();
    persist();
    return { ok: true };
  });
  app.get("/health", async () => ({ ok: true, now: new Date(opts.now()).toISOString() }));

  /* ============================================================== scheduler */

  function runEvent(type: string, a: Record<string, unknown>) {
    const ins = a.claimNo ? S.insurer[String(a.claimNo)] : undefined;
    const bk = a.bookingId ? S.bookings[String(a.bookingId)] : undefined;
    switch (type) {
      case "insurer.assign_adjuster":
        if (ins && !ins.adjuster) {
          ins.adjuster = { name: "Morgan Lee", phone: "+15550101001" };
          hook("insurer", "adjuster_assigned", ins.externalRef, { claimNo: ins.claimNo, adjuster: ins.adjuster }, ins.key);
        }
        break;
      case "insurer.approve_estimate": {
        if (!ins || ins.estimateStatus !== "pending") break;
        if (ins.requirements.some((r) => r.status === "missing")) break; // re-scheduled when the step arrives
        const est = ins.estimates.find((e) => e.id === a.estimateId) ?? ins.estimates.at(-1);
        if (!est) break;
        est.status = "approved";
        est.approvedAmount = est.amount;
        ins.estimateStatus = "approved";
        const deductible = 500;
        ins.offer = { offerId: id("OFF"), repairTotal: est.amount, deductible, amount: est.amount - deductible, requiresRelease: true, status: "open" };
        hook("insurer", "estimate_approved", ins.externalRef, { claimNo: ins.claimNo, estimateId: est.id, approvedAmount: est.amount, offer: ins.offer }, est.key);
        break;
      }
      case "insurer.pay_invoice": {
        const inv = ins?.medicalInvoices.find((m) => m.invoiceId === a.invoiceId);
        if (!ins || !inv || inv.status === "paid") break;
        inv.status = "paid";
        inv.paidAmount = inv.amount;
        ins.payments.push({ ref: `invoice:${inv.invoiceId}`, amount: inv.amount, to: "clinic", at: opts.now() });
        hook("insurer", "invoice_paid", ins.externalRef, { claimNo: ins.claimNo, invoiceId: inv.invoiceId, amount: inv.amount }, inv.key);
        break;
      }
      case "insurer.pay_settlement": {
        if (!ins?.offer || ins.offer.status !== "accepted") break;
        ins.offer.status = "paid";
        ins.payments.push({ ref: `settlement:${ins.offer.offerId}`, amount: ins.offer.amount, to: "body_shop", at: opts.now() });
        hook("insurer", "settlement_paid", ins.externalRef, { claimNo: ins.claimNo, offerId: ins.offer.offerId, amount: ins.offer.amount });
        const shop = Object.values(S.bookings).find((x) => x.claimRef === ins.externalRef);
        if (shop) {
          shop.paymentReceived += ins.offer.amount;
          hook("body_shop", "payment_received", shop.claimRef, { bookingId: shop.bookingId, amount: ins.offer.amount }, shop.key);
          if (shop.status === "ready") schedule(1, "shop.release", { bookingId: shop.bookingId });
        }
        break;
      }
      case "insurer.pay_rental": {
        const r = S.reservations[String(a.reservationId)];
        if (!ins || !r || r.finalCharge === null) break;
        if (ins.payments.some((p) => p.ref === `rental:${r.reservationId}`)) break;
        const covered = Math.min(r.daysUsed ?? 0, 21) * Math.min(r.dailyRate, 40);
        ins.payments.push({ ref: `rental:${r.reservationId}`, amount: covered, to: "rental", at: opts.now() });
        hook("insurer", "rental_paid", ins.externalRef, { claimNo: ins.claimNo, reservationId: r.reservationId, amount: covered });
        break;
      }
      case "shop.drop_off":
        if (bk && bk.status === "booked") {
          setShopStatus(bk, "dropped_off");
          setShopStatus(bk, "estimating");
          schedule(2, "shop.estimate_ready", { bookingId: bk.bookingId });
        }
        break;
      case "shop.estimate_ready":
        if (bk && !bk.estimate) {
          const lines = [
            { item: "Rear bumper replacement", amount: 900 },
            { item: "Paint and refinish", amount: 700 },
            { item: "Labor (8h)", amount: 800 },
          ];
          const amount = lines.reduce((s, l) => s + l.amount, 0);
          const estimateId = id("SE");
          const pdf = makePdf([
            "Precision Auto Body - Repair Estimate",
            `Estimate ${estimateId}   Booking ${bk.bookingId}`,
            `Claim ${bk.claimRef} / insurer ${bk.insurerClaimNo}`,
            `VIN ${bk.vehicleVin}`,
            "",
            ...lines.map((l) => `${l.item.padEnd(32)} $${l.amount}`),
            "",
            `TOTAL $${amount}`,
          ]);
          bk.estimate = { estimateId, amount, lines, pdfBase64: pdf.toString("base64") };
          persist();
          hook("body_shop", "estimate_ready", bk.claimRef, { bookingId: bk.bookingId, estimateId, amount }, bk.key);
        }
        break;
      case "shop.repair_progress":
        if (bk && bk.status === "in_repair") hook("body_shop", "repair_progress", bk.claimRef, { bookingId: bk.bookingId, pct: a.pct, status: "in_repair" }, bk.key);
        break;
      case "shop.ready":
        if (bk && bk.status === "in_repair") {
          bk.readyAt = opts.now();
          setShopStatus(bk, "ready");
          if (bk.paymentReceived > 0) schedule(1, "shop.release", { bookingId: bk.bookingId });
        }
        break;
      case "shop.release":
        if (bk && bk.status === "ready") setShopStatus(bk, "released");
        break;
      case "clinic.issue_invoice": {
        const v = S.visits[String(a.visitId)];
        if (!v) break;
        const n = Number(a.n);
        const inv = {
          invoiceId: id("INV"),
          claimRef: v.claimRef,
          patientName: v.patientName,
          amount: n === 1 ? 180 : 240,
          treatmentCode: n === 1 ? "99213" : "97110",
          description: n === 1 ? "Initial consultation, neck strain" : "Physical therapy x2",
          issuedAt: opts.now(),
        };
        S.invoices[inv.invoiceId] = inv;
        persist();
        // The webhook carries the amount but not the treatment code; the detail endpoint has it.
        hook("clinic", "invoice_issued", v.claimRef, { invoiceId: inv.invoiceId, amount: inv.amount, description: inv.description });
        break;
      }
    }
  }

  function tick() {
    const nowMs = opts.now();
    const due = S.scheduled.filter((e) => e.dueAt <= nowMs).sort((x, y) => x.dueAt - y.dueAt);
    if (!due.length) return 0;
    S.scheduled = S.scheduled.filter((e) => e.dueAt > nowMs);
    for (const e of due) runEvent(e.type, e.args);
    persist();
    return due.length;
  }

  return { app, tick, flush, state: () => S };
}
