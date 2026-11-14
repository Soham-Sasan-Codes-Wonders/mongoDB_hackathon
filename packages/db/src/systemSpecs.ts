import type { OutsideSystem, ProfileField } from "./schemas.ts";

/**
 * Version-1 API descriptions of the four outside systems. `db:seed` stores these as v1
 * `system_profiles`; the mock systems serve them (plus any chaos changes) at GET /<system>/describe,
 * so the drift subflow diffs a live description against what we last knew.
 */
export interface EndpointSpec {
  op: string;
  method: "GET" | "POST";
  path: string;
  fields: ProfileField[];
}
export interface SystemSpec {
  system: OutsideSystem;
  version: number;
  endpoints: EndpointSpec[];
  workflowSteps: string[];
}

const f = (name: string, type: string, required: boolean, description: string, sampleValues: string[] = []): ProfileField => ({
  name,
  type,
  required,
  description,
  sampleValues,
});

export const V1_SYSTEM_SPECS: Record<OutsideSystem, SystemSpec> = {
  insurer: {
    system: "insurer",
    version: 1,
    workflowSteps: ["fnol", "adjuster_assignment", "estimate_review", "approval", "settlement", "payment"],
    endpoints: [
      {
        op: "create_claim",
        method: "POST",
        path: "/insurer/claims",
        fields: [
          f("policyNumber", "string", true, "Insurance policy number of the claimant", ["POL-88812", "POL-10293"]),
          f("lossDate", "date", true, "Date of the accident", ["2026-11-14"]),
          f("location", "string", true, "Where the accident happened", ["Main St & 3rd Ave"]),
          f("description", "string", true, "What happened", ["Rear-ended at a red light"]),
          f("vehicleVin", "string", true, "Vehicle identification number", ["1HGCM82633A004352"]),
          f("externalRef", "string", true, "Caller's own claim reference", ["CLM-1042"]),
          f("otherParty", "object", false, "Other driver details", []),
          f("injuries", "boolean", false, "Whether anyone was injured", ["true"]),
          f("policeReportNumber", "string", false, "Police report number", ["PR-55120"]),
        ],
      },
      { op: "get_claim", method: "GET", path: "/insurer/claims/:claimNo", fields: [] },
      { op: "get_policy", method: "GET", path: "/insurer/policies/:policyNumber", fields: [] },
      {
        op: "submit_estimate",
        method: "POST",
        path: "/insurer/claims/:claimNo/estimates",
        fields: [
          f("policyNumber", "string", true, "Insurance policy number of the claimant", ["POL-88812"]),
          f("amount", "number", true, "Estimate total", ["2400"]),
          f("shopRef", "string", true, "Body shop booking reference", ["BK-1001"]),
          f("lines", "array", false, "Estimate lines", []),
          f("pdfBase64", "string", false, "Estimate PDF", []),
        ],
      },
      {
        op: "submit_medical_invoice",
        method: "POST",
        path: "/insurer/claims/:claimNo/medical-invoices",
        fields: [
          f("policyNumber", "string", true, "Insurance policy number of the claimant", ["POL-88812"]),
          f("invoiceId", "string", true, "Clinic invoice id", ["INV-501"]),
          f("amount", "number", true, "Invoice total", ["180"]),
          f("clinicName", "string", false, "Clinic", ["Northside Clinic"]),
          f("treatmentCode", "string", false, "Medical treatment (CPT) code", ["99213"]),
        ],
      },
      { op: "upload_photos", method: "POST", path: "/insurer/claims/:claimNo/photos", fields: [f("photos", "array", true, "Photo references", ["photo-1.jpg"])] },
      { op: "sign_release", method: "POST", path: "/insurer/claims/:claimNo/settlement/release", fields: [f("signedBy", "string", true, "Name of signer", ["Dana Reyes"]), f("offerId", "string", true, "Offer id", ["OFF-1"])] },
      { op: "accept_settlement", method: "POST", path: "/insurer/claims/:claimNo/settlement/accept", fields: [f("offerId", "string", true, "Offer id", ["OFF-1"]), f("acceptedBy", "string", true, "Name", ["Dana Reyes"])] },
      { op: "send_message", method: "POST", path: "/insurer/messages", fields: [f("ref", "string", true, "Claim reference", ["INS-7001"]), f("text", "string", true, "Message", [])] },
    ],
  },
  body_shop: {
    system: "body_shop",
    version: 1,
    workflowSteps: ["booked", "dropped_off", "estimating", "in_repair", "ready", "released"],
    endpoints: [
      {
        op: "create_booking",
        method: "POST",
        path: "/body_shop/bookings",
        fields: [
          f("claimRef", "string", true, "Caller's claim reference", ["CLM-1042"]),
          f("insurerClaimNo", "string", true, "Insurer claim number", ["INS-7001"]),
          f("vehicleVin", "string", true, "Vehicle identification number", ["1HGCM82633A004352"]),
          f("dropOffDate", "date", true, "Drop-off day", ["2026-11-15"]),
          f("customerName", "string", true, "Customer", ["Dana Reyes"]),
        ],
      },
      { op: "get_booking", method: "GET", path: "/body_shop/bookings/:bookingId", fields: [] },
      {
        op: "authorize_repair",
        method: "POST",
        path: "/body_shop/bookings/:bookingId/authorize",
        fields: [f("approvedAmount", "number", true, "Insurer-approved amount", ["2400"]), f("insurerClaimNo", "string", true, "Insurer claim number", ["INS-7001"])],
      },
      { op: "send_message", method: "POST", path: "/body_shop/messages", fields: [f("ref", "string", true, "Booking reference", ["BK-1001"]), f("text", "string", true, "Message", [])] },
    ],
  },
  rental: {
    system: "rental",
    version: 1,
    workflowSteps: ["reserved", "picked_up", "returned"],
    endpoints: [
      {
        op: "create_reservation",
        method: "POST",
        path: "/rental/reservations",
        fields: [
          f("claimRef", "string", true, "Caller's claim reference", ["CLM-1042"]),
          f("vehicleClass", "string", true, "Car class", ["compact"]),
          f("startDate", "date", true, "Start day", ["2026-11-15"]),
          f("days", "number", true, "Number of days", ["10"]),
          f("dailyRate", "number", true, "Daily rate", ["40"]),
          f("customerName", "string", true, "Customer", ["Dana Reyes"]),
        ],
      },
      { op: "find_reservation", method: "GET", path: "/rental/reservations?key=", fields: [] },
      { op: "extend_reservation", method: "POST", path: "/rental/reservations/:reservationId/extend", fields: [f("days", "number", true, "New total days", ["14"])] },
      { op: "return_reservation", method: "POST", path: "/rental/reservations/:reservationId/return", fields: [f("returnDate", "date", true, "Return day", ["2026-11-29"])] },
      { op: "send_message", method: "POST", path: "/rental/messages", fields: [f("ref", "string", true, "Reservation reference", ["RES-1"]), f("text", "string", true, "Message", [])] },
    ],
  },
  clinic: {
    system: "clinic",
    version: 1,
    workflowSteps: ["visit", "invoice_issued"],
    endpoints: [
      { op: "get_invoice", method: "GET", path: "/clinic/invoices/:invoiceId", fields: [] },
      { op: "list_invoices", method: "GET", path: "/clinic/invoices?claimRef=", fields: [] },
      { op: "send_message", method: "POST", path: "/clinic/messages", fields: [f("ref", "string", true, "Invoice reference", ["INV-501"]), f("text", "string", true, "Message", [])] },
    ],
  },
};

/** Flatten a spec's endpoint fields into profile fields (endpoint = op). */
export function specToProfileFields(spec: SystemSpec): ProfileField[] {
  return spec.endpoints.flatMap((e) => e.fields.map((fl) => ({ ...fl, endpoint: e.op })));
}

export const CANONICAL_FIELDS: { name: string; description: string; sampleValues: string[] }[] = [
  { name: "policyNumber", description: "Insurance policy number / policy reference identifying the claimant's policy", sampleValues: ["POL-88812", "POL-10293"] },
  { name: "claimNumber", description: "Insurer's claim number", sampleValues: ["INS-7001"] },
  { name: "vehicleVin", description: "Vehicle identification number (VIN)", sampleValues: ["1HGCM82633A004352"] },
  { name: "treatmentCode", description: "Medical treatment / procedure (CPT) code on a clinic invoice", sampleValues: ["99213", "97110"] },
  { name: "lossDate", description: "Date of loss / accident date", sampleValues: ["2026-11-14"] },
  { name: "location", description: "Accident location / place", sampleValues: ["Main St & 3rd Ave"] },
  { name: "description", description: "Narrative description of what happened", sampleValues: ["Rear-ended at a red light"] },
  { name: "amount", description: "Monetary amount / total", sampleValues: ["2400", "180"] },
  { name: "invoiceId", description: "Invoice identifier", sampleValues: ["INV-501"] },
  { name: "externalRef", description: "Our own claim reference sent to an outside system", sampleValues: ["CLM-1042"] },
  { name: "claimRef", description: "Our own claim reference (claim id)", sampleValues: ["CLM-1042"] },
  { name: "dailyRate", description: "Rental daily rate", sampleValues: ["40"] },
  { name: "days", description: "Number of rental days", sampleValues: ["10"] },
  { name: "startDate", description: "Start date", sampleValues: ["2026-11-15"] },
  { name: "shopRef", description: "Body shop booking reference", sampleValues: ["BK-1001"] },
  { name: "photos", description: "Damage photos", sampleValues: ["photo-1.jpg"] },
  { name: "approvedAmount", description: "Amount approved by the insurer", sampleValues: ["2400"] },
  { name: "customerName", description: "Customer / claimant full name", sampleValues: ["Dana Reyes"] },
];
