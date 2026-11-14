import { getDb, plain } from "@/lib/server/db";
export const dynamic = "force-dynamic";
export async function GET() {
  const db = await getDb();
  return Response.json(plain(await db.listClaimSummaries()));
}
