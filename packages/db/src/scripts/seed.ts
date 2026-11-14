import { client, closeDatabase, collection } from "../database.js";
import { setupDatabase } from "../setup.js";
import { embed } from "../search.js";
import { type Claim } from "../schemas.js";
import { V1_SYSTEM_SPECS, specToProfileFields, type SystemSpec } from "../systemSpecs.js";

const canonicalFields = [
  ["policyNumber", "The insured's policy identifier used by the insurer."],
  ["claimNumber", "The claim identifier assigned after first notice of loss."],
  ["vehicleVin", "The 17 character vehicle identification number."],
  ["accidentDate", "The date the collision happened."],
  ["accidentLocation", "The street address or place where the collision occurred."],
  ["rentalDailyLimit", "Maximum covered rental cost per day."],
  ["rentalMaxDays", "Maximum number of rental days covered by the policy."],
  ["treatmentCode", "Clinic billing code describing the medical treatment."],
  ["invoiceNumber", "The clinic or repair invoice identifier."],
  ["estimateAmount", "The body shop's repair estimate total."],
  ["repairStatus", "The current state of the vehicle repair."],
  ["reservationKey", "The idempotency key used to locate a rental reservation."],
  ["adjusterName", "The insurer employee assigned to the claim."],
  ["claimantPhone", "The claimant's E.164 phone number."],
  ["policeReportNumber", "The incident number from the responding police service."],
  ["otherDriverName", "The name of the other driver involved in the collision."]
] as const;

// v1 profiles describe the mock systems apps/agent serves at GET /<system>/describe (see systemSpecs.ts),
// so the drift subflow's diff starts from what the systems really accept.
const systems = (Object.values(V1_SYSTEM_SPECS) as SystemSpec[]).map((spec) => ({ system: spec.system, workflowSteps: spec.workflowSteps, fields: specToProfileFields(spec) }));

const starterExperiences = [
  ["drift", "rental", "Rental API renamed reservationKey to booking_ref.", { mapping: { booking_ref: "reservationKey" } }, "Field mapped and read-back verified."],
  ["drift", "insurer", "Insurer renamed policyNumber to policy_ref.", { mapping: { policy_ref: "policyNumber" } }, "Policy lookup restored without changing the idempotency key."],
  ["drift", "body_shop", "Body shop now requires repair photos before estimate review.", { insertTask: "collect_repair_photos", before: "T9" }, "New document requirement added as a task."],
  ["rejection", "clinic", "Medical invoice rejected because treatment code is missing.", { requestFactFrom: "clinic", field: "treatmentCode" }, "Clinic supplied the code and the corrected invoice was accepted."],
  ["rejection", "insurer", "Invoice rejected as a duplicate submission.", { verifyExistingPayment: true }, "Existing submission was found; no duplicate was created."],
  ["crash", "system", "Worker stopped after an action was sent and before its response was saved.", { resumeStream: true, verifyBeforeRetry: true }, "Read-back confirmed the effect; the action was not resent."],
  ["caller_pattern", "insurer", "Adjuster offered verbal approval one day before written approval.", { requireWrittenEvidence: true }, "Verbal statement was logged as unverified until portal read-back."],
  ["drift", "body_shop", "Webhook changed repairState to repair_status.", { mapping: { repair_status: "repairStatus" } }, "New webhook field mapped to canonical repair status."],
  ["rejection", "rental", "Rental reservation exceeded policy daily cap.", { clampToCoverageLimit: true, requestClaimantApprovalForOverage: true }, "Reservation stayed within the covered amount."],
  ["drift", "insurer", "Insurer introduced a required accident location field.", { canonicalField: "accidentLocation", addIntakeQuestion: true }, "Claimant supplied the location before resubmission."]
] as const;

try {
  await client.connect();
  await setupDatabase();
  const profiles = collection("system_profiles");
  const experiences = collection("experiences");
  const now = new Date();
  const profileTexts = systems.flatMap((profile) => profile.fields.map((field) => `${field.endpoint}.${field.name}: ${field.type}. ${field.description ?? ""} Samples: ${field.sampleValues.join(", ")}`));
  const seedTexts = [
    ...canonicalFields.map(([name, description]) => `${name}: ${description}`),
    ...profileTexts,
    ...starterExperiences.map((entry) => entry[2])
  ];
  const seedVectors = await embed(seedTexts, "document");
  let vectorOffset = 0;
  const canonicalVectors = seedVectors.slice(vectorOffset, vectorOffset + canonicalFields.length);
  vectorOffset += canonicalFields.length;
  for (let index = 0; index < canonicalFields.length; index += 1) {
    const [fieldName, description] = canonicalFields[index]!;
    await profiles.updateOne({ docType: "canonical_field", system: "internal", fieldName }, { $set: { docType: "canonical_field", system: "internal", version: 1, fieldName, description, embedding: canonicalVectors[index]!, createdAt: now } }, { upsert: true });
  }
  for (const profile of systems) {
    await profiles.updateOne({ docType: "profile", system: profile.system, version: 1 }, { $set: { ...profile, docType: "profile", version: 1, createdAt: now } }, { upsert: true });
    const vectors = seedVectors.slice(vectorOffset, vectorOffset + profile.fields.length);
    vectorOffset += profile.fields.length;
    for (let index = 0; index < profile.fields.length; index += 1) {
      const field = profile.fields[index]!;
      await profiles.updateOne({ docType: "field", system: profile.system, version: 1, fieldName: field.name, description: { $regex: `^${field.endpoint} ` } }, { $set: { docType: "field", system: profile.system, version: 1, fieldName: field.name, description: `${field.endpoint} ${field.description ?? ""} (${field.type}${field.required ? ", required" : ""})`, sampleValues: field.sampleValues, embedding: vectors[index]!, createdAt: now } }, { upsert: true });
    }
  }
  const experienceVectors = seedVectors.slice(vectorOffset);
  for (let index = 0; index < starterExperiences.length; index += 1) {
    const [problemType, system, problem, fix, outcome] = starterExperiences[index]!;
    await experiences.updateOne({ problemType, system, problem }, { $set: { problemType, system, problem, fix, outcome, embedding: experienceVectors[index]!, createdAt: now } }, { upsert: true });
  }

  const demoClaim: Claim = {
    _id: "CLM-1042",
    claimant: { name: "Jordan Lee", phone: "+14165550142", email: "jordan@example.test" },
    parties: { claimant: "Jordan Lee", insurer: "Northstar Mutual", adjuster: "Casey Morgan", bodyShop: "Harbour Auto Repair", rentalCompany: "Metro Rental", clinic: "Lakeside Clinic" },
    vehicle: { make: "Honda", model: "Civic", year: 2022, vin: "2HGFC2F69NH000042" },
    policy: { number: "POL-88291", insurer: "Northstar Mutual", rentalDailyLimit: 45, rentalMaxDays: 30 },
    phase: "intake", compactSummary: "Demo claim seeded for the Claim Coordinator workflow.",
    money: { totals: [], items: [] }, createdAt: now
  };
  await collection<Claim>("claims").updateOne({ _id: demoClaim._id }, { $setOnInsert: demoClaim }, { upsert: true });
  const contacts = [
    { phone: "+14165551001", name: "Casey Morgan", company: "Northstar Mutual", role: "adjuster", claimIds: [demoClaim._id], trust: "known", isCompanyMainLine: false },
    { phone: "+14165551002", name: "Harbour Auto Repair", company: "Harbour Auto Repair", role: "body_shop", claimIds: [demoClaim._id], trust: "company_line", isCompanyMainLine: true },
    { phone: "+14165551003", name: "Metro Rental Downtown", company: "Metro Rental", role: "rental_branch", claimIds: [demoClaim._id], trust: "company_line", isCompanyMainLine: true },
    { phone: "+14165551004", name: "Lakeside Clinic Billing", company: "Lakeside Clinic", role: "clinic", claimIds: [demoClaim._id], trust: "company_line", isCompanyMainLine: true },
    { phone: "+14165550142", name: "Jordan Lee", company: "Claimant", role: "claimant", claimIds: [demoClaim._id], trust: "known", isCompanyMainLine: false }
  ];
  for (const contact of contacts) await collection("contacts").updateOne({ phone: contact.phone }, { $set: contact }, { upsert: true });
  await collection("sim_clock").updateOne({ _id: "clock" } as import("mongodb").Document, { $setOnInsert: { _id: "clock", simEpoch: now, wallEpoch: now, speed: 86_400_000 / 20_000, paused: false } }, { upsert: true });
  console.log(`Seeded ${canonicalFields.length} canonical fields, ${systems.length} profiles (v1 = the mock systems' /describe), ${starterExperiences.length} experiences, 5 contacts, and the demo claim.`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
