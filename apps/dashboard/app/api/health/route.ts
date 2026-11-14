import { getDb, plain } from "@/lib/server/db";
export const dynamic = "force-dynamic";
const SYSTEMS = ["insurer", "body_shop", "rental", "clinic"];
/** Last 3 sim days of system_health samples per system (ts is sim time). */
export async function GET() {
  const db = await getDb();
  const since = db.nowSync().getTime() - 3 * 86_400_000;
  const series = await Promise.all(SYSTEMS.map(async (system) => ({ system, samples: (await db.getHealthSeries(system, since)).slice(-200) })));
  return Response.json(plain(series));
}
