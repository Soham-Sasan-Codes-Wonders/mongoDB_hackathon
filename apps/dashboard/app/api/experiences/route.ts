import { getDb, plain } from "@/lib/server/db";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q") ?? undefined;
  const db = await getDb();
  return Response.json(plain(await db.listExperiences(q || undefined, 100)));
}
