import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { config } from "../config.ts";
import { errMsg, log } from "../log.ts";
import { HANDBOOK } from "./prompts.ts";

export const MODEL = "claude-opus-5-5";
export type Effort = "low" | "medium";

export type LlmFailure = {
  ok: false;
  reason: "refused" | "malformed" | "max_tokens" | "api_error" | "low_confidence";
  detail: string;
  raw?: string;
};
export type LlmResult<T> = { ok: true; value: T; model: string; stub: boolean } | LlmFailure;

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ maxRetries: 3, timeout: 120_000 });
  return client;
}

/**
 * zod -> JSON schema for output_config.format. Structured outputs want closed objects with every
 * property required, and don't accept numeric/string length constraints, so we normalise here and
 * enforce ranges with zod afterwards.
 */
export function toOutputSchema(schema: z.ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema, { target: "draft-7", unrepresentable: "any" }) as Record<string, unknown>;
  const DROP = new Set(["$schema", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "pattern", "format", "minItems", "maxItems", "default"]);
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (DROP.has(k)) continue;
      out[k] = k === "properties" ? Object.fromEntries(Object.entries(v as object).map(([pk, pv]) => [pk, walk(pv)])) : walk(v);
    }
    if (out.type === "object" && out.properties) {
      out.additionalProperties = false;
      out.required = Object.keys(out.properties as object);
    }
    return out;
  };
  return walk(js) as Record<string, unknown>;
}

export interface StructuredCall<T> {
  job: string;
  /** Job-specific instructions + data. The stable HANDBOOK system prompt is always first and cached. */
  user: string;
  schema: z.ZodType<T>;
  effort: Effort;
  /** Deterministic offline implementation used when LLM_MODE=stub (no API key). */
  stub: () => T;
  maxTokens?: number;
  /** Optional confidence accessor: below config.llmMinConfidence -> low_confidence failure. */
  confidence?: (v: T) => number;
}

/**
 * Every LLM call goes through here: structured JSON via output_config.format, adaptive thinking,
 * explicit effort, server-side refusal fallbacks, stop_reason checked BEFORE content is read,
 * zod validation BEFORE anything is returned. Never throws: callers get {ok:false} and route it
 * to an operator approval instead of writing.
 */
export async function callStructured<T>(c: StructuredCall<T>): Promise<LlmResult<T>> {
  const started = Date.now();
  if (config.llmMode === "stub") {
    try {
      const v = c.schema.parse(c.stub());
      return checkConfidence(c, { ok: true, value: v, model: "stub", stub: true });
    } catch (e) {
      return { ok: false, reason: "malformed", detail: `stub: ${errMsg(e)}` };
    }
  }
  let raw = "";
  try {
    const res = await getClient().beta.messages.create({
      model: MODEL,
      max_tokens: c.maxTokens ?? 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: c.effort, format: { type: "json_schema", schema: toOutputSchema(c.schema) } },
      system: [{ type: "text", text: HANDBOOK, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: `JOB: ${c.job}\n\n${c.user}` }],
    });
    if (res.stop_reason === "refusal") {
      const sd = (res as unknown as { stop_details?: { category?: string | null; explanation?: string | null } }).stop_details;
      log("llm", `${c.job} refused (${sd?.category ?? "?"})`);
      return { ok: false, reason: "refused", detail: sd?.explanation ?? sd?.category ?? "refused" };
    }
    if (res.stop_reason === "max_tokens") return { ok: false, reason: "max_tokens", detail: "output truncated" };
    raw = res.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, reason: "malformed", detail: "not JSON", raw };
    }
    const v = c.schema.safeParse(parsed);
    if (!v.success) return { ok: false, reason: "malformed", detail: v.error.message.slice(0, 500), raw };
    log("llm", `${c.job} ok in ${Date.now() - started}ms (cache read ${res.usage.cache_read_input_tokens ?? 0} tok, served by ${res.model})`);
    return checkConfidence(c, { ok: true, value: v.data, model: res.model, stub: false });
  } catch (e) {
    log("llm", `${c.job} api error: ${errMsg(e)}`);
    return { ok: false, reason: "api_error", detail: errMsg(e), raw };
  }
}

function checkConfidence<T>(c: StructuredCall<T>, r: LlmResult<T>): LlmResult<T> {
  if (!r.ok || !c.confidence) return r;
  const conf = c.confidence(r.value);
  if (!(conf >= config.llmMinConfidence)) return { ok: false, reason: "low_confidence", detail: `confidence ${conf}`, raw: JSON.stringify(r.value) };
  return r;
}
