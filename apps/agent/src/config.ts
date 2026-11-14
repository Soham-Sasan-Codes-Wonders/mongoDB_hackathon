import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { clock } from "./db.ts";

/**
 * `pnpm --filter agent tunnel` makes a new ElevenLabs webhook (with a new HMAC secret) each time the
 * free tunnel changes address, and writes the secret to the repo-root .env. Re-read it when the
 * file changes so the running server picks it up without a restart.
 */
const ROOT_ENV = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env");
let envCache: { mtimeMs: number; value: string } | null = null;
function freshEnvValue(name: string): string | undefined {
  try {
    const mtimeMs = statSync(ROOT_ENV).mtimeMs;
    if (envCache?.mtimeMs !== mtimeMs) {
      const line = readFileSync(ROOT_ENV, "utf8").split("\n").find((l) => l.startsWith(`${name}=`));
      envCache = { mtimeMs, value: line ? line.slice(name.length + 1).trim().replace(/^["']|["']$/g, "") : "" };
    }
    return envCache.value || undefined;
  } catch {
    return undefined;
  }
}

const num = (v: string | undefined, d: number) => (v !== undefined && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : d);

export const config = {
  mocksPort: num(process.env.MOCKS_PORT, 4000),
  controlPort: num(process.env.CONTROL_PORT, 4100),
  get mocksUrl() {
    return process.env.MOCKS_URL ?? `http://127.0.0.1:${this.mocksPort}`;
  },
  get controlUrl() {
    return process.env.CONTROL_URL ?? `http://127.0.0.1:${this.controlPort}`;
  },

  /** Drift mappings at or above this confidence auto-apply; below goes to an operator. */
  driftAutoApplyThreshold: num(process.env.DRIFT_AUTO_APPLY_THRESHOLD, 0.85),
  /** Below this, an LLM interpretation goes to a human instead of the database. */
  llmMinConfidence: num(process.env.LLM_MIN_CONFIDENCE, 0.6),

  /** Retries (same key) before the "unverified after 3 retries" operator gate. */
  maxVerifyRetries: 3,
  /** How long an acknowledged action waits before its read-back (sim ms). Makes sent→ack→confirmed visible. */
  verifyDelaySim: num(process.env.VERIFY_DELAY_SIM_MS, 2 * clock.HOUR),
  /** Deadline for an action to be confirmed (sim ms). */
  actionDeadlineSim: 1 * clock.DAY,

  chaseAfterSim: 3 * clock.DAY,
  rentalExpiringLeadSim: 2 * clock.DAY,
  paymentOverdueSim: 10 * clock.DAY,
  claimantReminderSim: 1 * clock.DAY,

  leaseTtlMs: num(process.env.LEASE_TTL_MS, 10_000),
  heartbeatMs: 3_000,
  timerPollMs: 2_000,
  sweeperMs: 4_000,
  /** Max loop iterations per wake-up before sleeping (guards against a spin). */
  maxIterationsPerWake: 12,

  workers: num(process.env.WORKERS, 1),
  llmMode: (process.env.LLM_MODE ?? (process.env.ANTHROPIC_API_KEY ? "live" : "stub")) as "live" | "stub",
  get elevenLabsSecret(): string {
    return freshEnvValue("ELEVENLABS_WEBHOOK_SECRET") ?? process.env.ELEVENLABS_WEBHOOK_SECRET ?? "";
  },
  /** "operator" (default): the agent decides operator approvals itself (worker/autopilot.ts). "off": a person does. */
  autopilot: (process.env.AUTOPILOT === "off" ? "off" : "operator") as "off" | "operator",
  /** Voice agent for the browser call page (/phone/web). */
  elevenLabsAgentId: process.env.ELEVENLABS_AGENT_ID ?? "",
};
