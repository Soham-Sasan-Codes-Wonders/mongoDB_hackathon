import { initClock } from "./clock.ts";
import { col } from "./collections.ts";
import { upsertContact } from "./contacts.ts";
import { recordExperience, type NewExperience } from "./experiences.ts";
import { getLatestProfile, saveProfileVersion, upsertCanonicalField } from "./profiles.ts";
import { CANONICAL_FIELDS, specToProfileFields, V1_SYSTEM_SPECS } from "./systemSpecs.ts";
import { OUTSIDE_SYSTEMS, type Contact } from "./schemas.ts";

/** Demo parties. Claim creation links the company contacts to each new claim. */
export const DEMO_CONTACTS: Contact[] = [
  { phone: "+15550101001", name: "Morgan Lee", company: "Acme Mutual Insurance", role: "adjuster", claimIds: [], trust: "known", isCompanyMainLine: false },
  { phone: "+15550101000", name: "Acme Mutual main line", company: "Acme Mutual Insurance", role: "adjuster", claimIds: [], trust: "company_line", isCompanyMainLine: true },
  { phone: "+15550102001", name: "Sam Ortiz", company: "Precision Auto Body", role: "body_shop", claimIds: [], trust: "known", isCompanyMainLine: false },
  { phone: "+15550103001", name: "Riley Chen", company: "QuickRent Downtown", role: "rental_branch", claimIds: [], trust: "known", isCompanyMainLine: false },
  { phone: "+15550104001", name: "Northside Clinic billing", company: "Northside Clinic", role: "clinic", claimIds: [], trust: "known", isCompanyMainLine: false },
];

const STARTER_EXPERIENCES: NewExperience[] = [
  { problemType: "ghost_booking", system: "rental", problem: "Rental API returned 200 for a reservation but read-back by idempotency key found nothing", fix: { action: "retry_same_key", maxRetries: 3 }, outcome: "Retry with the same idempotency key created exactly one reservation" },
  { problemType: "drift", system: "insurer", problem: "Insurer renamed field policyNumber to policy_ref; validation error 'policy_ref required, policyNumber unknown'", fix: { mapping: { policyNumber: "policy_ref" } }, outcome: "Mapped canonical policyNumber to policy_ref, retried with the same key, accepted" },
  { problemType: "drift", system: "insurer", problem: "Insurer added a new required workflow step 'photos' before estimate approval", fix: { newTask: { type: "upload_photos", blocks: "T9", endpoint: "/insurer/claims/:claimNo/photos" } }, outcome: "Inserted an upload-photos task before T9; approval followed" },
  { problemType: "drift", system: "body_shop", problem: "Body shop webhook used status 'in-repair' instead of 'in_repair'", fix: { mapping: { "status:in-repair": "in_repair" } }, outcome: "Normalized status values" },
  { problemType: "rejection", system: "insurer", problem: "Insurer rejected medical invoice: missing treatment code", fix: { classification: "missing_field", field: "treatmentCode", source: "clinic", needsFacts: true }, outcome: "Fetched the treatment code from the clinic invoice detail and resubmitted with a new key" },
  { problemType: "rejection", system: "insurer", problem: "Insurer rejected medical invoice as duplicate of an earlier submission", fix: { classification: "duplicate", action: "close_as_duplicate" }, outcome: "Verified the original submission was received; closed the duplicate" },
  { problemType: "rejection", system: "insurer", problem: "Insurer rejected chiropractic invoice: treatment not covered by policy", fix: { classification: "out_of_coverage" }, outcome: "Told the claimant and closed the invoice task as denied" },
  { problemType: "caller_pattern", system: "insurer", problem: "Adjuster Morgan Lee gives verbal approvals on the phone about a day before the portal updates", fix: { promiseCheckDelayDays: 1 }, outcome: "Portal showed the approval the next day" },
  { problemType: "crash", system: "internal", problem: "Worker killed between send and acknowledgement; action left in sent", fix: { action: "readback_before_resend" }, outcome: "Read-back found the effect; action confirmed without resending" },
  { problemType: "caller_pattern", system: "body_shop", problem: "Body shop promises ready dates by phone that slip by 1-2 days", fix: { promiseCheckDelayDays: 1 }, outcome: "Checked status on the promised day; extended the rental once" },
];

export async function seedDatabase(log: (m: string) => void = console.log) {
  await initClock({ refreshMs: 0 });
  for (const f of CANONICAL_FIELDS) await upsertCanonicalField(f);
  log(`canonical fields: ${CANONICAL_FIELDS.length}`);
  for (const system of OUTSIDE_SYSTEMS) {
    if (await getLatestProfile(system)) continue;
    const spec = V1_SYSTEM_SPECS[system];
    await saveProfileVersion({ system, fields: specToProfileFields(spec), workflowSteps: spec.workflowSteps, fieldMap: {}, source: "seed:v1" });
  }
  log("system_profiles v1 ok");
  const exp = await col.experiences();
  if ((await exp.countDocuments({ claimId: null })) === 0) {
    for (const e of STARTER_EXPERIENCES) await recordExperience(e);
    log(`experiences: ${STARTER_EXPERIENCES.length}`);
  }
  for (const c of DEMO_CONTACTS) await upsertContact(c);
  log(`contacts: ${DEMO_CONTACTS.length}`);
}
