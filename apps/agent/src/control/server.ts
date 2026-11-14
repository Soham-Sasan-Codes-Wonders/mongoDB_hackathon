import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { claims, clock, contacts, leases, observations, tasks } from "../db.ts";
import { config } from "../config.ts";
import { errMsg, log } from "../log.ts";
import { registerPhoneRoutes } from "../phone/routes.ts";
import { seedTasks } from "../worker/taskGraph.ts";
import type { Supervisor } from "./supervisor.ts";

/** Intake form from the dashboard's "Start a claim". */
export const IntakeForm = z.object({
  claimant: z.object({ name: z.string().min(1), phone: z.string().regex(/^\+[1-9]\d{6,14}$/), email: z.string().nullish() }),
  accident: z.object({
    date: z.string().default(""),
    place: z.string().default(""),
    description: z.string().default(""),
    otherDriver: z.union([z.string(), z.object({ name: z.string().nullish(), plate: z.string().nullish(), insurer: z.string().nullish() })]).nullish(),
    policeReportNumber: z.string().nullish(),
    injuries: z.boolean().default(false),
  }),
  policyNumber: z.string().default(""),
  insurer: z.string().default("Acme Mutual Insurance"),
  vehicle: z.object({ vin: z.string().min(3), make: z.string().nullish(), model: z.string().nullish(), year: z.number().nullish(), plate: z.string().nullish() }),
  photos: z.array(z.string()).default([]),
  message: z.string().nullish(),
});

const WEBHOOK_SYSTEMS = new Set(["insurer", "body_shop", "rental", "clinic"]);

export function buildControlServer(sup: Supervisor | null): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024 });
  // keep the raw body: the ElevenLabs HMAC is computed over the exact bytes
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as unknown as { rawBody: string }).rawBody = body as string;
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch (e) {
      done(e as Error, undefined);
    }
  });

  /* -------------------------------------------------------------- control */

  app.post("/control/claims", async (req, reply) => {
    const parsed = IntakeForm.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid intake form", issues: parsed.error.issues });
    const f = parsed.data;
    const claimId = await claims.nextClaimId();
    const od = f.accident.otherDriver;
    const otherDriver = !od ? null : typeof od === "string" ? { name: od, plate: null, insurer: null } : { name: od.name ?? null, plate: od.plate ?? null, insurer: od.insurer ?? null };
    const at = clock.now();
    // Claim + its 18-task graph in ONE transaction (packages/db createClaimWithTasks).
    await claims.createClaimWithTasks(
      {
        _id: claimId,
        claimant: { name: f.claimant.name, firstName: f.claimant.name.split(/\s+/)[0]!, phone: f.claimant.phone, ...(f.claimant.email ? { email: f.claimant.email } : {}) },
        parties: { claimant: f.claimant.name, insurer: f.insurer },
        vehicle: { make: f.vehicle.make ?? "Unknown", model: f.vehicle.model ?? "Unknown", vin: f.vehicle.vin, ...(f.vehicle.year ? { year: f.vehicle.year } : {}), ...(f.vehicle.plate ? { licencePlate: f.vehicle.plate } : {}) },
        // Rental limits are unknown until T4 reads the policy (0 = not read yet).
        policy: { number: f.policyNumber, insurer: f.insurer, rentalDailyLimit: 0, rentalMaxDays: 0 },
        accident: { date: f.accident.date, place: f.accident.place, description: f.accident.description, policeReportNumber: f.accident.policeReportNumber ?? null, injuries: f.accident.injuries, otherDriver },
        phase: "intake",
        compactSummary: "",
        money: { totals: [], items: [] },
        external: {},
        facts: { photos: f.photos },
        createdAt: at,
      },
      seedTasks(claimId).map((t) => tasks.buildTask(t)),
    );
    await contacts.upsertContact({ phone: f.claimant.phone, name: f.claimant.name, company: "Claimant", role: "claimant", claimIds: [claimId], trust: "known", isCompanyMainLine: false });
    // The seeded company contacts (adjuster, shop, rental branch, clinic) are parties on every demo claim.
    for (const c of await contacts.listContacts()) if (c.role !== "claimant") await contacts.linkContactToClaim(c.phone, claimId);
    // The intake observation wakes the agent (change stream).
    await observations.insertObservation({ claimId, source: "claimant", kind: "intake", body: { form: { ...f.accident, policyNumber: f.policyNumber, otherDriver, photos: f.photos }, message: f.message ?? null } });
    if (f.message) await observations.insertObservation({ claimId, source: "claimant", kind: "message", body: { text: f.message } });
    // World simulation: an injured claimant visits the clinic, which will bill later (not an agent action).
    if (f.accident.injuries) {
      fetch(`${config.mocksUrl}/clinic/visits`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ claimRef: claimId, patientName: f.claimant.name }) }).catch((e) => log("control", `clinic visit sim failed: ${errMsg(e)}`));
    }
    log("control", `claim ${claimId} created (18-task graph seeded); intake observation inserted`);
    return reply.code(201).send({ claimId });
  });

  app.post("/control/kill-worker", async (req, reply) => {
    if (!sup) return reply.code(503).send({ error: "no supervisor in this process" });
    const b = (req.body ?? {}) as { workerId?: string };
    return { killed: sup.kill(b.workerId) };
  });
  app.post("/control/start-worker", async (req, reply) => {
    if (!sup) return reply.code(503).send({ error: "no supervisor in this process" });
    const b = (req.body ?? {}) as { workerId?: string };
    return { started: sup.start(b.workerId) };
  });
  app.get("/control/status", async () => {
    const [ls, ws] = await Promise.all([leases.listLeases(), observations.listWorkerStates()]);
    const nowWall = Date.now();
    return {
      clock: { sim: clock.now().toISOString(), wall: new Date().toISOString() },
      workers: sup?.status() ?? null,
      leases: ls.map((l) => ({ claimId: l._id, workerId: l.workerId, expiresAt: l.expiresAt, live: l.expiresAt.getTime() > nowWall })),
      workerState: ws.map((w) => {
        const x = w as unknown as Record<string, unknown>;
        return { workerId: w._id, resumeTokenSavedAt: w.resumeToken ? w.updatedAt : null, heartbeatAt: x.heartbeatAt ?? null, held: x.held ?? [], pid: x.pid ?? null, replayedFromToken: x.replayed ?? 0 };
      }),
      llmMode: config.llmMode,
    };
  });

  /* -------------------------------------------------------------- webhooks */

  app.post("/webhooks/:system", async (req, reply) => {
    const system = (req.params as { system: string }).system;
    if (!WEBHOOK_SYSTEMS.has(system)) return reply.code(404).send({ error: "unknown system" });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const claimRef = String(b.claimRef ?? "");
    const id = await observations.insertObservation({
      claimId: /^CLM-\d+$/.test(claimRef) ? claimRef : "CLM-0",
      source: system as "insurer",
      kind: String(b.event ?? "unknown"),
      body: b,
      processed: !/^CLM-\d+$/.test(claimRef),
    });
    return { ok: true, observationId: id };
  });

  registerPhoneRoutes(app);
  app.get("/health", async () => ({ ok: true }));
  return app;
}
