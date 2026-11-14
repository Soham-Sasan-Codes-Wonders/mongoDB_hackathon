/**
 * `pnpm --filter agent tunnel`: a free public URL for the ElevenLabs post-call webhook, with no
 * account. Runs a localhost.run tunnel (plain ssh) to the control server and, every time the
 * tunnel gets a new address (it rotates), creates a new HMAC webhook in ElevenLabs, attaches it to
 * the agent, deletes the previous one, and writes the new secret to the repo-root .env. The running
 * server re-reads that secret (config.elevenLabsSecret), so no restart is needed.
 *
 * ElevenLabs ignores webhook_url on PATCH /v1/workspace/webhooks/:id, hence create + delete.
 * Needs ELEVENLABS_API_KEY in the repo-root .env.local (webhooks write + agents write permissions)
 * and ELEVENLABS_AGENT_ID in .env. Never prints the key or the secret.
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const ENV = resolve(ROOT, ".env");
const ENV_LOCAL = resolve(ROOT, ".env.local");
const PORT = Number(process.env.CONTROL_PORT ?? 4100);
const API = "https://api.elevenlabs.io/v1";
const NAME = "claim-agent post-call";

function envValue(file: string, name: string): string | undefined {
  try {
    const line = readFileSync(file, "utf8").split("\n").find((l) => l.startsWith(`${name}=`));
    return line?.slice(name.length + 1).trim().replace(/^["']|["']$/g, "") || undefined;
  } catch {
    return undefined;
  }
}

function setEnvValue(name: string, value: string) {
  let s = "";
  try {
    s = readFileSync(ENV, "utf8");
  } catch { /* new file */ }
  const re = new RegExp(`^${name}=.*$`, "m");
  s = re.test(s) ? s.replace(re, `${name}=${value}`) : `${s.replace(/\n?$/, "\n")}${name}=${value}\n`;
  writeFileSync(ENV, s);
}

const key = envValue(ENV_LOCAL, "ELEVENLABS_API_KEY") ?? process.env.ELEVENLABS_API_KEY;
const agentId = envValue(ENV, "ELEVENLABS_AGENT_ID") ?? process.env.ELEVENLABS_AGENT_ID;
if (!key || !agentId) {
  console.error(`[tunnel] missing ${!key ? "ELEVENLABS_API_KEY in .env.local" : "ELEVENLABS_AGENT_ID in .env"}`);
  process.exit(1);
}
const H = { "xi-api-key": key, "content-type": "application/json" };

async function api(method: string, path: string, body?: unknown) {
  const r = await fetch(`${API}${path}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch { /* non-JSON error body */ }
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${text.slice(0, 300)}`);
  return json;
}

/** Point the agent at a fresh webhook for this URL; delete the ones this script made before. */
async function rewire(publicUrl: string) {
  const hookUrl = `${publicUrl}/phone/post-call`;
  const created = await api("POST", "/workspace/webhooks", { settings: { auth_type: "hmac", name: NAME, webhook_url: hookUrl } });
  const id = String(created.webhook_id);
  if (!created.webhook_secret) throw new Error("ElevenLabs returned no webhook secret");
  // Secret first, then the agent: the server can verify the new webhook before any call uses it.
  setEnvValue("ELEVENLABS_WEBHOOK_SECRET", String(created.webhook_secret));
  await api("PATCH", `/convai/agents/${agentId}`, { platform_settings: { workspace_overrides: { webhooks: { post_call_webhook_id: id, events: ["transcript"] } } } });
  const list = await api("GET", "/workspace/webhooks");
  for (const w of (list.webhooks as Array<Record<string, unknown>> | undefined) ?? []) {
    if (w.name === NAME && w.webhook_id !== id) await api("DELETE", `/workspace/webhooks/${w.webhook_id}`).catch((e) => console.error(`[tunnel] could not delete old webhook: ${e.message}`));
  }
  console.log(`[tunnel] ElevenLabs post-call webhook -> ${hookUrl} (secret saved to .env)`);
}

let current = "";
let queue = Promise.resolve();
function onUrl(url: string) {
  if (url === current) return;
  current = url;
  console.log(`[tunnel] public URL: ${url}`);
  queue = queue.then(() => rewire(url)).catch((e) => console.error(`[tunnel] rewire failed: ${e.message}`));
}

function start() {
  const ssh = spawn("ssh", ["-o", "StrictHostKeyChecking=accept-new", "-o", "ServerAliveInterval=30", "-o", "ExitOnForwardFailure=yes", "-R", `80:localhost:${PORT}`, "nokey@localhost.run"], { stdio: ["ignore", "pipe", "pipe"] });
  const scan = (buf: Buffer) => {
    for (const m of buf.toString().matchAll(/https:\/\/[a-z0-9]+\.(?:app\.)?lhr\.life/g)) onUrl(m[0]);
  };
  ssh.stdout.on("data", scan);
  ssh.stderr.on("data", scan);
  ssh.on("exit", (code) => {
    console.error(`[tunnel] ssh exited (${code}); reconnecting in 3s`);
    setTimeout(start, 3000);
  });
}

console.log(`[tunnel] opening localhost.run tunnel to :${PORT} for agent ${agentId}`);
start();
