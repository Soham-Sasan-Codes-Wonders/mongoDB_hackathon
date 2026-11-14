import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type Sys = "insurer" | "body_shop" | "rental" | "clinic";

export interface InsurerClaim {
  claimNo: string;
  key: string;
  externalRef: string;
  policyNumber: string;
  lossDate: string;
  description: string;
  injuries: boolean;
  status: "open" | "closed";
  createdAt: number;
  adjuster: { name: string; phone: string } | null;
  estimates: { id: string; key: string; amount: number; shopRef: string; status: "received" | "approved"; approvedAmount: number | null; receivedAt: number; hasPdf: boolean }[];
  estimateStatus: "none" | "pending" | "approved";
  requirements: { step: string; status: "missing" | "received" }[];
  photos: string[];
  medicalInvoices: { invoiceId: string; key: string; amount: number; treatmentCode: string | null; status: "received" | "paid"; paidAmount: number; receivedAt: number }[];
  offer: { offerId: string; amount: number; repairTotal: number; deductible: number; requiresRelease: boolean; status: "open" | "accepted" | "paid" } | null;
  releaseSigned: { signedBy: string; at: number; key: string } | null;
  payments: { ref: string; amount: number; to: string; at: number }[];
}

export interface Booking {
  bookingId: string;
  key: string;
  claimRef: string;
  insurerClaimNo: string;
  vehicleVin: string;
  customerName: string;
  dropOffDate: string;
  status: "booked" | "dropped_off" | "estimating" | "in_repair" | "ready" | "released";
  estimate: { estimateId: string; amount: number; lines: { item: string; amount: number }[]; pdfBase64: string } | null;
  authorized: { approvedAmount: number; key: string; at: number } | null;
  paymentReceived: number;
  readyAt: number | null;
  statusHistory: { status: string; at: number }[];
}

export interface Reservation {
  reservationId: string;
  key: string;
  claimRef: string;
  vehicleClass: string;
  customerName: string;
  startDate: string;
  days: number;
  dailyRate: number;
  endDate: string;
  status: "reserved" | "returned";
  extensions: { key: string; days: number; at: number }[];
  returnedDate: string | null;
  daysUsed: number | null;
  finalCharge: number | null;
}

export interface Invoice {
  invoiceId: string;
  claimRef: string;
  patientName: string;
  amount: number;
  treatmentCode: string;
  description: string;
  issuedAt: number;
}

export interface Scheduled {
  id: number;
  dueAt: number;
  type: string;
  args: Record<string, unknown>;
}

export interface MockState {
  seq: number;
  idem: Record<Sys, Record<string, { status: number; body: unknown }>>;
  insurer: Record<string, InsurerClaim>;
  bookings: Record<string, Booking>;
  reservations: Record<string, Reservation>;
  invoices: Record<string, Invoice>;
  visits: Record<string, { claimRef: string; patientName: string; at: number }>;
  messages: Record<Sys, { id: string; key: string; ref: string; text: string; at: number }[]>;
  chaos: {
    rentalDropNext: number;
    renames: Partial<Record<Sys, Record<string, string>>>;
    requiredSteps: Partial<Record<Sys, string[]>>;
    insurerRejectNextInvoice: string | null;
    rentalWebhookDropRate: number;
    log: { at: number; what: string }[];
  };
  scheduled: Scheduled[];
}

export function emptyState(): MockState {
  return {
    seq: 1000,
    idem: { insurer: {}, body_shop: {}, rental: {}, clinic: {} },
    insurer: {},
    bookings: {},
    reservations: {},
    invoices: {},
    visits: {},
    messages: { insurer: [], body_shop: [], rental: [], clinic: [] },
    chaos: { rentalDropNext: 0, renames: {}, requiredSteps: {}, insurerRejectNextInvoice: null, rentalWebhookDropRate: 0.5, log: [] },
    scheduled: [],
  };
}

export function loadState(path: string | null): MockState {
  if (path && existsSync(path)) {
    try {
      return { ...emptyState(), ...(JSON.parse(readFileSync(path, "utf8")) as MockState) };
    } catch {
      /* fall through */
    }
  }
  return emptyState();
}

export function saveState(path: string | null, s: MockState) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(s));
}
