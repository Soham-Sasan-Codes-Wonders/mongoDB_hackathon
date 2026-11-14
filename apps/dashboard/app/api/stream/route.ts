import { getDb } from "@/lib/server/db";
import { getAgentStatus } from "@/lib/server/status";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Server-Sent Events. One MongoDB change stream (claims, tasks, actions, observations, approvals,
 * timers, leases; optionally one claim) pushes `change` events; the browser refetches its snapshot.
 * Agent status is polled from :4100 on the server every 2 s and pushed as `status`. No browser polling.
 */
export async function GET(req: Request) {
  const claimId = new URL(req.url).searchParams.get("claimId") ?? undefined;
  const db = await getDb();
  const enc = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream({
    async start(ctrl) {
      const send = (event: string, data: unknown) => {
        if (!closed) ctrl.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const cs = db.watchDashboardChanges(claimId);
      const statusTimer = setInterval(async () => send("status", await getAgentStatus()), 2000);
      const ping = setInterval(() => !closed && ctrl.enqueue(enc.encode(": ping\n\n")), 15000);
      const stop = () => {
        if (closed) return;
        closed = true;
        clearInterval(statusTimer);
        clearInterval(ping);
        void cs.close().catch(() => undefined);
        try { ctrl.close(); } catch { /* already closed */ }
      };
      req.signal.addEventListener("abort", stop);
      send("status", await getAgentStatus());
      send("hello", { claimId: claimId ?? null });
      cs.on("change", (ev: { ns?: { coll?: string }; operationType?: string; fullDocument?: { claimId?: string; _id?: unknown } }) => {
        send("change", { coll: ev.ns?.coll, op: ev.operationType, claimId: ev.fullDocument?.claimId ?? (ev.ns?.coll === "claims" ? String(ev.fullDocument?._id ?? "") : null) });
      });
      cs.on("error", (e: Error) => { send("error", { message: e.message }); stop(); });
    },
    cancel() { closed = true; },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" } });
}
