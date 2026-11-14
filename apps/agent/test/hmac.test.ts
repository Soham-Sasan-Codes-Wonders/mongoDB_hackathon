import { describe, expect, it } from "vitest";
import { signElevenLabs, verifyElevenLabsSignature } from "../src/phone/hmac.ts";

const secret = "whsec_test";
const body = JSON.stringify({ type: "post_call_transcription", data: { conversation_id: "c1" } });
const now = 1_800_000_000;

describe("ElevenLabs HMAC check", () => {
  it("accepts a correct signature", () => {
    expect(verifyElevenLabsSignature(body, signElevenLabs(body, secret, now), secret, { nowSec: now })).toEqual({ ok: true });
  });
  it("rejects when the secret isn't configured", () => {
    expect(verifyElevenLabsSignature(body, signElevenLabs(body, secret, now), "", { nowSec: now }).ok).toBe(false);
  });
  it("rejects a missing header", () => {
    expect(verifyElevenLabsSignature(body, undefined, secret, { nowSec: now })).toEqual({ ok: false, reason: "missing ElevenLabs-Signature header" });
  });
  it("rejects a wrong secret", () => {
    expect(verifyElevenLabsSignature(body, signElevenLabs(body, "other", now), secret, { nowSec: now })).toEqual({ ok: false, reason: "signature mismatch" });
  });
  it("rejects a tampered body", () => {
    const sig = signElevenLabs(body, secret, now);
    expect(verifyElevenLabsSignature(body.replace("c1", "c2"), sig, secret, { nowSec: now }).ok).toBe(false);
  });
  it("rejects a stale timestamp (replay)", () => {
    expect(verifyElevenLabsSignature(body, signElevenLabs(body, secret, now - 3600), secret, { nowSec: now })).toEqual({ ok: false, reason: "signature timestamp outside tolerance" });
  });
  it("rejects malformed headers", () => {
    for (const h of ["garbage", "t=abc,v0=00", "t=1800000000", "v0=zz,t=1800000000"]) expect(verifyElevenLabsSignature(body, h, secret, { nowSec: now }).ok).toBe(false);
  });
});
