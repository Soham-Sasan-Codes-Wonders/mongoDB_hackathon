"use client";

import { createElement, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { voiceCallerVars, voiceCallSetup, type VoiceCaller } from "@/app/actions";

const WIDGET_SRC = "https://unpkg.com/@elevenlabs/convai-widget-embed";
const UNKNOWN = "+15559998888"; // not in contacts: the agent treats it as an unknown caller

function loadWidgetScript() {
  if (document.querySelector(`script[src="${WIDGET_SRC}"]`)) return;
  const s = document.createElement("script");
  s.src = WIDGET_SRC;
  s.async = true;
  document.body.appendChild(s);
}

/**
 * Live voice call from the demo panel: pick who you're calling as, then talk to the ElevenLabs
 * agent through its web widget. The transcript reaches the agent through the normal post-call
 * webhook (:4100/phone/post-call), exactly like a phone call.
 */
export function VoiceCall({ claimId }: { claimId?: string }) {
  const [agentId, setAgentId] = useState<string | null>(null);
  const [callers, setCallers] = useState<VoiceCaller[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [as, setAs] = useState("");
  const [vars, setVars] = useState<Record<string, string> | null>(null);

  useEffect(() => {
    if (!claimId) return;
    voiceCallSetup(claimId).then((r) => {
      if (!r.ok) return setError(r.message);
      setAgentId(r.agentId!);
      setCallers(r.callers ?? []);
    });
  }, [claimId]);

  async function pick(phone: string) {
    setAs(phone);
    setVars(null);
    setError(null);
    if (!phone) return;
    loadWidgetScript();
    const r = await voiceCallerVars(phone);
    if (!r.ok) return setError(r.message);
    setVars(r.vars!);
  }

  if (!claimId) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <label htmlFor="voice-as" className="text-mute">☎ Live voice call as</label>
      <select id="voice-as" className="rounded-lg border border-line bg-s2 px-2 py-1" value={as} disabled={!agentId} onChange={(e) => pick(e.target.value)}>
        <option value="">off</option>
        {callers.map((c) => <option key={c.phone} value={c.phone}>{c.name} · {c.company} ({c.role}{c.trust === "company_line" ? ", main line" : ""})</option>)}
        <option value={UNKNOWN}>Unknown number</option>
      </select>
      {error && <span className="text-xs text-[var(--st-failed,#e5484d)]">{error}</span>}
      {vars && <span className="text-xs text-mute">trust: {vars.trust_level} · press the call button (bottom right)</span>}
      {/* Portal to <body>: the demo panel's backdrop-blur would otherwise trap the widget's fixed
          positioning inside the panel. Keyed per caller so each pick starts a fresh conversation. */}
      {agentId && vars && createPortal(createElement("elevenlabs-convai", { key: as, "agent-id": agentId, "dynamic-variables": JSON.stringify(vars) }), document.body)}
    </div>
  );
}
