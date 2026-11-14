import type { Document } from "mongodb";
import { collection } from "./database.js";
import { ContactSchema, type Contact } from "./schemas.js";

export async function upsertContact(contact: Contact): Promise<void> { const parsed = ContactSchema.parse(contact); await collection<Contact & Document>("contacts").replaceOne({ phone: parsed.phone }, parsed, { upsert: true }); }
export async function findContactByPhone(phone: string): Promise<Contact | null> { return collection<Contact & Document>("contacts").findOne({ phone }); }
export async function listContacts(claimId?: string): Promise<Contact[]> { return collection<Contact & Document>("contacts").find(claimId ? { claimIds: claimId } : {}).sort({ company: 1, name: 1 }).toArray(); }

/** Add a claim to a contact's claimIds (upsertContact replaces the whole contact). */
export async function linkContactToClaim(phone: string, claimId: string): Promise<void> {
  await collection("contacts").updateOne({ phone }, { $addToSet: { claimIds: claimId } });
}
