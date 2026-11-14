import { getClaimSnapshot } from "@/lib/server/snapshot";
export const dynamic = "force-dynamic";
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const snap = await getClaimSnapshot(id);
  return snap ? Response.json(snap) : Response.json({ error: "not found" }, { status: 404 });
}
