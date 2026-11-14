import { getDb } from "@/lib/server/db";
export const dynamic = "force-dynamic";
/** Download a stored document (estimate PDF, photo, call transcript) from GridFS. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = await getDb();
  const meta = await db.getDocumentMeta(id);
  if (!meta) return new Response("not found", { status: 404 });
  const bytes = await db.downloadDocument(String(meta.gridfsId));
  const type = meta.docType === "estimate" ? "application/pdf" : meta.docType === "photo" ? "application/octet-stream" : "text/plain; charset=utf-8";
  return new Response(new Uint8Array(bytes), { headers: { "content-type": type, "content-disposition": `inline; filename="${meta.docType}-${id}"` } });
}
