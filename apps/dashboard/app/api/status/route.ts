import { getAgentStatus } from "@/lib/server/status";
export const dynamic = "force-dynamic";
export async function GET() {
  return Response.json(await getAgentStatus());
}
