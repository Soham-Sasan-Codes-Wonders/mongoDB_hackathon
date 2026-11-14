"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentStatus, ClaimRow, ClaimSnapshot } from "@/lib/types";

/** Subscribe to /api/stream (SSE): every change event triggers a debounced refetch; agent status arrives pushed. */
function useStream(claimId: string | undefined, onChange: () => void) {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [connected, setConnected] = useState(false);
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    const es = new EventSource(`/api/stream${claimId ? `?claimId=${encodeURIComponent(claimId)}` : ""}`);
    let t: ReturnType<typeof setTimeout> | null = null;
    es.addEventListener("hello", () => setConnected(true));
    es.addEventListener("status", (e) => setStatus(JSON.parse((e as MessageEvent).data)));
    es.addEventListener("change", () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => cb.current(), 250);
    });
    es.onerror = () => setConnected(false);
    es.onopen = () => setConnected(true);
    return () => {
      if (t) clearTimeout(t);
      es.close();
    };
  }, [claimId]);
  return { status, connected };
}

export function useLiveClaim(claimId: string) {
  const [snap, setSnap] = useState<ClaimSnapshot | null>(null);
  const [missing, setMissing] = useState(false);
  const refresh = useCallback(async () => {
    const r = await fetch(`/api/claims/${encodeURIComponent(claimId)}`, { cache: "no-store" });
    if (r.status === 404) return setMissing(true);
    if (r.ok) setSnap(await r.json());
  }, [claimId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const { status, connected } = useStream(claimId, refresh);
  return { snap, status, connected, refresh, missing };
}

export function useLiveClaims() {
  const [rows, setRows] = useState<ClaimRow[] | null>(null);
  const refresh = useCallback(async () => {
    const r = await fetch("/api/claims", { cache: "no-store" });
    if (r.ok) setRows(await r.json());
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const { status, connected } = useStream(undefined, refresh);
  return { rows, status, connected, refresh };
}
