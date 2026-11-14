import { col } from "./collections.ts";
import { Contact } from "./schemas.ts";

/** One indexed lookup (unique index on phone). Used by the call-initiation webhook, so keep it lean. */
export async function findByPhone(phone: string): Promise<Contact | null> {
  return (await col.contacts()).findOne({ phone }, { projection: { _id: 0 } });
}

export async function upsertContact(c: Contact): Promise<void> {
  const doc = Contact.parse(c);
  const { claimIds, ...rest } = doc;
  await (await col.contacts()).updateOne(
    { phone: doc.phone },
    { $set: rest, $addToSet: { claimIds: { $each: claimIds } } },
    { upsert: true },
  );
}

export async function linkContactToClaim(phone: string, claimId: string): Promise<void> {
  await (await col.contacts()).updateOne({ phone }, { $addToSet: { claimIds: claimId } });
}

export async function listContacts(claimId?: string): Promise<Contact[]> {
  return (await col.contacts()).find(claimId ? { claimIds: claimId } : {}, { projection: { _id: 0 } }).toArray();
}
