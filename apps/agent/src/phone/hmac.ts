import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * ElevenLabs post-call webhook signature: header `ElevenLabs-Signature: t=<unix seconds>,v0=<hex>`
 * where hex = HMAC-SHA256(secret, `${t}.${rawBody}`). Rejects a missing secret, missing/malformed
 * header, a wrong signature, or a timestamp outside the tolerance (replay protection).
 */
export function verifyElevenLabsSignature(
  rawBody: string,
  header: string | undefined | null,
  secret: string | undefined | null,
  opts: { nowSec?: number; toleranceSec?: number } = {},
): { ok: true } | { ok: false; reason: string } {
  if (!secret) return { ok: false, reason: "ELEVENLABS_WEBHOOK_SECRET not configured" };
  if (!header) return { ok: false, reason: "missing ElevenLabs-Signature header" };
  const parts = Object.fromEntries(
    header.split(",").map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  const sig = parts.v0;
  if (!Number.isFinite(t) || !sig || !/^[0-9a-f]+$/i.test(sig)) return { ok: false, reason: "malformed signature header" };
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (opts.toleranceSec ?? 30 * 60)) return { ok: false, reason: "signature timestamp outside tolerance" };
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  const given = Buffer.from(sig, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "signature mismatch" };
  return { ok: true };
}

export function signElevenLabs(rawBody: string, secret: string, tSec = Math.floor(Date.now() / 1000)): string {
  return `t=${tSec},v0=${createHmac("sha256", secret).update(`${tSec}.${rawBody}`).digest("hex")}`;
}
