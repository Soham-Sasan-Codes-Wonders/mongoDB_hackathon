/** The only two outside surfaces the dashboard calls: the agent control API (:4100) and the mock systems' chaos endpoints (:4000). */
export const CONTROL_URL = process.env.CONTROL_URL ?? "http://127.0.0.1:4100";
export const MOCKS_URL = process.env.MOCKS_URL ?? "http://127.0.0.1:4000";

export async function callJson<T = Record<string, unknown>>(base: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ ok: boolean; status: number; json: T | null; error?: string }> {
  try {
    const res = await fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, json: text ? (JSON.parse(text) as T) : null };
  } catch (e) {
    return { ok: false, status: 0, json: null, error: e instanceof Error ? e.message : String(e) };
  }
}
export const control = <T = Record<string, unknown>>(path: string, body?: unknown) => callJson<T>(CONTROL_URL, path, body);
export const mocks = <T = Record<string, unknown>>(path: string, body?: unknown) => callJson<T>(MOCKS_URL, path, body);
