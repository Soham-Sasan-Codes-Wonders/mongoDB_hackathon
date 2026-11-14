import type { ActionDoc, Claim } from "@claims/db";

/**
 * One adapter per outside system. Each action `kind` knows how to build its HTTP request (from the
 * canonical payload + the claim's external references) and how to read back proof that its
 * `expectedEffect` happened. Adapters never change state; the executor does.
 */
export interface HttpReq {
  method: "GET" | "POST";
  path: string;
  body?: Record<string, unknown>;
  /** The profile endpoint op, for field mapping + drift diffs. */
  op: string;
}

export interface ReadBackResult {
  satisfied: boolean;
  observed: unknown;
  /** Facts proven by the read-back (stored on the claim by the task handler). */
  effect?: Record<string, unknown>;
  /** The response didn't have the shape we expected (a drift trigger, not just "not yet"). */
  shapeError?: string;
}

export type Get = (path: string) => Promise<{ status: number; json: unknown }>;

interface KindSpec {
  request: (a: ActionDoc, claim: Claim) => HttpReq;
  readBack: (a: ActionDoc, claim: Claim, get: Get) => Promise<ReadBackResult>;
  /** Read-only kinds (GETs) never write to the outside system. */
  readOnly?: boolean;
}

const ext = (claim: Claim, k: string) => {
  const v = (claim.external ?? {})[k];
  if (v === undefined || v === null || v === "") throw new Error(`claim ${claim._id} has no external.${k} yet`);
  return String(v);
};
const enc = encodeURIComponent;
const asObj = (x: unknown) => (x && typeof x === "object" ? (x as Record<string, unknown>) : {});

function msgSpec(system: string): KindSpec {
  return {
    request: (a) => ({ method: "POST", path: `/${system}/messages`, body: a.payload, op: "send_message" }),
    readBack: async (a, _c, get) => {
      const r = await get(`/${system}/messages?key=${enc(a.idempotencyKey)}`);
      const list = asObj(r.json).messages;
      if (!Array.isArray(list)) return { satisfied: false, observed: r.json, shapeError: "messages[] missing" };
      return { satisfied: list.length > 0, observed: list[0] ?? null, effect: list[0] ? { messageId: asObj(list[0]).id } : undefined };
    },
  };
}

export const KINDS: Record<string, Record<string, KindSpec>> = {
  insurer: {
    create_claim: {
      request: (a) => ({ method: "POST", path: "/insurer/claims", body: a.payload, op: "create_claim" }),
      readBack: async (a, _c, get) => {
        const r = await get(`/insurer/claims?key=${enc(a.idempotencyKey)}`);
        const list = asObj(r.json).claims;
        if (!Array.isArray(list)) return { satisfied: false, observed: r.json, shapeError: "claims[] missing" };
        const c = asObj(list[0]);
        const ok = !!c.claimNo && c.externalRef === a.expectedEffect.externalRef;
        return { satisfied: ok, observed: list[0] ?? null, effect: ok ? { claimNo: c.claimNo } : undefined };
      },
    },
    get_policy: {
      readOnly: true,
      request: (a) => ({ method: "GET", path: `/insurer/policies/${enc(String(a.payload.policyNumber))}`, op: "get_policy" }),
      readBack: async (a, _c, get) => {
        const r = await get(`/insurer/policies/${enc(String(a.payload.policyNumber))}`);
        const p = asObj(r.json);
        const ok = r.status === 200 && typeof p.rentalDailyLimit === "number" && typeof p.rentalMaxDays === "number";
        return { satisfied: ok, observed: r.json, effect: ok ? { rentalDailyLimit: p.rentalDailyLimit, rentalMaxDays: p.rentalMaxDays, deductible: p.deductible } : undefined };
      },
    },
    submit_estimate: {
      request: (a, c) => ({ method: "POST", path: `/insurer/claims/${ext(c, "insurerClaimNo")}/estimates`, body: a.payload, op: "submit_estimate" }),
      readBack: async (a, c, get) => {
        const r = await get(`/insurer/claims/${ext(c, "insurerClaimNo")}`);
        const est = (asObj(r.json).estimates as unknown[] | undefined)?.map(asObj).find((e) => e.key === a.idempotencyKey);
        return { satisfied: !!est, observed: est ?? null, effect: est ? { insurerEstimateId: est.id } : undefined };
      },
    },
    upload_photos: {
      request: (a, c) => ({ method: "POST", path: `/insurer/claims/${ext(c, "insurerClaimNo")}/photos`, body: a.payload, op: "upload_photos" }),
      readBack: async (_a, c, get) => {
        const r = await get(`/insurer/claims/${ext(c, "insurerClaimNo")}`);
        const req = (asObj(r.json).requirements as unknown[] | undefined)?.map(asObj).find((x) => x.step === "photos");
        return { satisfied: req?.status === "received", observed: req ?? null };
      },
    },
    submit_medical_invoice: {
      request: (a, c) => ({ method: "POST", path: `/insurer/claims/${ext(c, "insurerClaimNo")}/medical-invoices`, body: a.payload, op: "submit_medical_invoice" }),
      readBack: async (a, c, get) => {
        const r = await get(`/insurer/claims/${ext(c, "insurerClaimNo")}`);
        const inv = (asObj(r.json).medicalInvoices as unknown[] | undefined)?.map(asObj).find((m) => m.key === a.idempotencyKey);
        return { satisfied: !!inv, observed: inv ?? null };
      },
    },
    sign_release: {
      request: (a, c) => ({ method: "POST", path: `/insurer/claims/${ext(c, "insurerClaimNo")}/settlement/release`, body: a.payload, op: "sign_release" }),
      readBack: async (a, c, get) => {
        const r = await get(`/insurer/claims/${ext(c, "insurerClaimNo")}`);
        const rel = asObj(asObj(r.json).releaseSigned);
        return { satisfied: rel.key === a.idempotencyKey, observed: asObj(r.json).releaseSigned ?? null };
      },
    },
    accept_settlement: {
      request: (a, c) => ({ method: "POST", path: `/insurer/claims/${ext(c, "insurerClaimNo")}/settlement/accept`, body: a.payload, op: "accept_settlement" }),
      readBack: async (a, c, get) => {
        const r = await get(`/insurer/claims/${ext(c, "insurerClaimNo")}`);
        const offer = asObj(asObj(r.json).offer);
        const ok = offer.offerId === a.payload.offerId && (offer.status === "accepted" || offer.status === "paid");
        return { satisfied: ok, observed: offer };
      },
    },
    send_message: msgSpec("insurer"),
  },
  body_shop: {
    create_booking: {
      request: (a) => ({ method: "POST", path: "/body_shop/bookings", body: a.payload, op: "create_booking" }),
      readBack: async (a, _c, get) => {
        const r = await get(`/body_shop/bookings?key=${enc(a.idempotencyKey)}`);
        const list = asObj(r.json).bookings;
        if (!Array.isArray(list)) return { satisfied: false, observed: r.json, shapeError: "bookings[] missing" };
        const b = asObj(list[0]);
        return { satisfied: !!b.bookingId, observed: list[0] ?? null, effect: b.bookingId ? { bookingId: b.bookingId, status: b.status } : undefined };
      },
    },
    authorize_repair: {
      request: (a, c) => ({ method: "POST", path: `/body_shop/bookings/${ext(c, "bookingId")}/authorize`, body: a.payload, op: "authorize_repair" }),
      readBack: async (a, c, get) => {
        const r = await get(`/body_shop/bookings/${ext(c, "bookingId")}`);
        const b = asObj(r.json);
        const ok = ["in_repair", "ready", "released"].includes(String(b.status)) && asObj(b.authorized).key === a.idempotencyKey;
        return { satisfied: ok, observed: { status: b.status, authorized: b.authorized }, effect: ok ? { status: b.status } : undefined };
      },
    },
    send_message: msgSpec("body_shop"),
  },
  rental: {
    create_reservation: {
      request: (a) => ({ method: "POST", path: "/rental/reservations", body: a.payload, op: "create_reservation" }),
      readBack: async (a, _c, get) => {
        const r = await get(`/rental/reservations?key=${enc(a.idempotencyKey)}`);
        const list = asObj(r.json).reservations;
        if (!Array.isArray(list)) return { satisfied: false, observed: r.json, shapeError: "reservations[] missing" };
        const res = list.map(asObj).find((x) => x.key === a.idempotencyKey);
        const ok = !!res && Number(res.days) >= Number(a.expectedEffect.days ?? 0);
        return { satisfied: ok, observed: res ?? null, effect: ok ? { reservationId: res!.reservationId, endDate: res!.endDate, days: res!.days, dailyRate: res!.dailyRate, startDate: res!.startDate } : undefined };
      },
    },
    extend_reservation: {
      request: (a, c) => ({ method: "POST", path: `/rental/reservations/${ext(c, "reservationId")}/extend`, body: a.payload, op: "extend_reservation" }),
      readBack: async (a, c, get) => {
        const r = await get(`/rental/reservations/${ext(c, "reservationId")}`);
        const res = asObj(r.json);
        const ok = Number(res.days) >= Number(a.expectedEffect.days) && Array.isArray(res.extensions) && res.extensions.some((e) => asObj(e).key === a.idempotencyKey);
        return { satisfied: ok, observed: { days: res.days, endDate: res.endDate }, effect: ok ? { endDate: res.endDate, days: res.days } : undefined };
      },
    },
    return_reservation: {
      request: (a, c) => ({ method: "POST", path: `/rental/reservations/${ext(c, "reservationId")}/return`, body: a.payload, op: "return_reservation" }),
      readBack: async (_a, c, get) => {
        const r = await get(`/rental/reservations/${ext(c, "reservationId")}`);
        const res = asObj(r.json);
        const ok = res.status === "returned" && typeof res.finalCharge === "number";
        return { satisfied: ok, observed: { status: res.status, finalCharge: res.finalCharge, daysUsed: res.daysUsed }, effect: ok ? { finalCharge: res.finalCharge, daysUsed: res.daysUsed, dailyRate: res.dailyRate } : undefined };
      },
    },
    send_message: msgSpec("rental"),
  },
  clinic: {
    get_invoice: {
      readOnly: true,
      request: (a) => ({ method: "GET", path: `/clinic/invoices/${enc(String(a.payload.invoiceId))}`, op: "get_invoice" }),
      readBack: async (a, _c, get) => {
        const r = await get(`/clinic/invoices/${enc(String(a.payload.invoiceId))}`);
        const inv = asObj(r.json);
        const ok = r.status === 200 && typeof inv.treatmentCode === "string";
        return { satisfied: ok, observed: r.json, effect: ok ? { treatmentCode: inv.treatmentCode, amount: inv.amount } : undefined };
      },
    },
    send_message: msgSpec("clinic"),
  },
};

export function kindSpec(system: string, kind: string): KindSpec {
  const s = KINDS[system]?.[kind];
  if (!s) throw new Error(`no adapter for ${system}.${kind}`);
  return s;
}

/* ---------------------------------------------- read-only checks (wait tasks + phone) */

/** Read-only queries of systems of record. Used by wait tasks, the phone handler and drift. Never write. */
export const reads = {
  insurerClaim: (get: Get, claimNo: string) => get(`/insurer/claims/${enc(claimNo)}`),
  booking: (get: Get, bookingId: string) => get(`/body_shop/bookings/${enc(bookingId)}`),
  reservation: (get: Get, reservationId: string) => get(`/rental/reservations/${enc(reservationId)}`),
  invoice: (get: Get, invoiceId: string) => get(`/clinic/invoices/${enc(invoiceId)}`),
  invoicesForClaim: (get: Get, claimRef: string) => get(`/clinic/invoices?claimRef=${enc(claimRef)}`),
  describe: (get: Get, system: string) => get(`/${system}/describe`),
};
