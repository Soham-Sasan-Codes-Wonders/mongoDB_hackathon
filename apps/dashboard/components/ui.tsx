"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { StatusLook } from "@/lib/status";

/** Status pill: a soft tinted chip with an icon and a label (colour never stands alone). */
export function Pill({ look, size = "md", title }: { look: StatusLook; size?: "sm" | "md" | "lg"; title?: string }) {
  const pad = size === "sm" ? "h-5 px-1.5 text-[11px] gap-1" : size === "lg" ? "h-7 px-2.5 text-sm gap-1.5" : "h-6 px-2 text-xs gap-1";
  return (
    <span title={title} className={`inline-flex shrink-0 items-center rounded-full font-medium whitespace-nowrap ${pad}`} style={{ color: look.color, background: `color-mix(in oklab, ${look.color} 12%, transparent)` }}>
      <span aria-hidden className="leading-none">{look.icon}</span>
      {look.label}
    </span>
  );
}

export function Card({ title, right, children, className = "", flush = false }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; flush?: boolean }) {
  return (
    <section className={`min-w-0 rounded-2xl border border-line bg-s1 shadow-[var(--shadow-sm)] ${className}`}>
      {(title || right) && (
        <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-5 pt-4 pb-1">
          <h2 className="min-w-0 text-[13px] font-semibold tracking-tight text-ink">{title}</h2>
          {right && <div className="text-xs text-mute">{right}</div>}
        </header>
      )}
      <div className={flush ? "" : "px-5 pt-2 pb-5"}>{children}</div>
    </section>
  );
}

type Kind = "default" | "primary" | "danger" | "good" | "ghost";
export function Button({ children, onClick, kind = "default", disabled, title, className = "", type = "button", size = "md" }: { children: ReactNode; onClick?: () => void; kind?: Kind; disabled?: boolean; title?: string; className?: string; type?: "button" | "submit"; size?: "sm" | "md" }) {
  const styles: Record<Kind, string> = {
    default: "border border-line bg-s1 text-ink shadow-[var(--shadow-sm)] hover:bg-s2",
    primary: "bg-ink text-[var(--bg)] hover:opacity-90",
    danger: "text-[var(--st-critical)] bg-[color-mix(in_oklab,var(--st-critical)_10%,transparent)] hover:bg-[color-mix(in_oklab,var(--st-critical)_18%,transparent)]",
    good: "text-[var(--st-confirmed)] bg-[color-mix(in_oklab,var(--st-confirmed)_10%,transparent)] hover:bg-[color-mix(in_oklab,var(--st-confirmed)_18%,transparent)]",
    ghost: "text-ink2 hover:bg-s2 hover:text-ink",
  };
  const sz = size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3 text-sm";
  return (
    <button type={type} title={title} disabled={disabled} onClick={onClick} className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${sz} ${styles[kind]} ${className}`}>
      {children}
    </button>
  );
}

/** Segmented control (tabs, filters). */
export function Segmented<T extends string>({ value, options, onChange, size = "md" }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; size?: "sm" | "md" }) {
  return (
    <div role="tablist" className="inline-flex flex-wrap gap-0.5 rounded-lg bg-s2 p-0.5">
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={value === o.value} onClick={() => onChange(o.value)}
          className={`rounded-md font-medium transition ${size === "sm" ? "px-2 py-0.5 text-xs" : "px-2.5 py-1 text-[13px]"} ${value === o.value ? "bg-s1 text-ink shadow-[var(--shadow-sm)]" : "text-ink2 hover:text-ink"}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Small live indicator: pulsing dot when connected. */
export function LiveDot({ on, label }: { on: boolean; label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-mute">
      <span className={`relative inline-block h-1.5 w-1.5 rounded-full ${on ? "live-dot" : ""}`} style={{ background: on ? "var(--st-confirmed)" : "var(--st-idle)", color: on ? "var(--st-confirmed)" : undefined }} />
      {label ?? (on ? "Live" : "Reconnecting")}
    </span>
  );
}

/* ---------------------------------------------------------------- toasts */

type Toast = { id: number; text: string; tone: "ok" | "err" | "info"; onClick?: () => void; sticky?: boolean; key?: string };
const ToastCtx = createContext<{ push: (t: Omit<Toast, "id">) => void; dismiss: (key: string) => void }>({ push: () => undefined, dismiss: () => undefined });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((t: Omit<Toast, "id">) => {
    const id = Date.now() + Math.random();
    setToasts((x) => [...x.slice(-4), { ...t, id }]);
    if (!t.sticky) setTimeout(() => setToasts((x) => x.filter((y) => y.id !== id)), 4000);
  }, []);
  // returns the same array when nothing matches, so calling it from an effect can't loop
  const dismiss = useCallback((key: string) => setToasts((x) => (x.some((y) => y.key === key) ? x.filter((y) => y.key !== key) : x)), []);
  const value = useMemo(() => ({ push, dismiss }), [push, dismiss]);
  const tone = { ok: "var(--st-confirmed)", err: "var(--st-critical)", info: "var(--st-approval)" };
  const icon = { ok: "✓", err: "!", info: "⏸" };
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed top-16 right-4 z-50 flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} role="status" className="toast-in pointer-events-auto flex items-start gap-2.5 rounded-xl border border-line bg-s1 px-3 py-2.5 text-sm shadow-[var(--shadow-md)]">
            <span aria-hidden className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full text-[10px] font-bold text-white" style={{ background: tone[t.tone] }}>{icon[t.tone]}</span>
            <button className="flex-1 text-left text-ink" onClick={() => { t.onClick?.(); setToasts((x) => x.filter((y) => y.id !== t.id)); }}>
              {t.text}
            </button>
            <button aria-label="Dismiss" className="text-mute hover:text-ink" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>✕</button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

/** Run a server action from a button: pending state + a toast with its result. */
export function useRun() {
  const { push } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(async (key: string, fn: () => Promise<{ ok: boolean; message: string }>) => {
    setBusy(key);
    try {
      const r = await fn();
      push({ text: r.message, tone: r.ok ? "ok" : "err" });
      return r;
    } catch (e) {
      push({ text: e instanceof Error ? e.message : String(e), tone: "err" });
      return { ok: false, message: String(e) };
    } finally {
      setBusy(null);
    }
  }, [push]);
  return { run, busy };
}

/* ----------------------------------------------------------------- theme */

export function ThemeToggle() {
  const [dark, setDark] = useState<boolean | null>(null);
  useEffect(() => {
    const set = document.documentElement.dataset.theme;
    setDark(set ? set === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches);
  }, []);
  const flip = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.dataset.theme = next ? "dark" : "light";
    try { localStorage.setItem("theme", next ? "dark" : "light"); } catch { /* storage blocked */ }
  };
  return (
    <button onClick={flip} title="Toggle light/dark" aria-label="Toggle light or dark theme" className="grid h-8 w-8 place-items-center rounded-lg text-ink2 hover:bg-s2 hover:text-ink">
      <span aria-hidden>{dark ? "☀" : "☾"}</span>
    </button>
  );
}

export function Dialog({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4 backdrop-blur-[2px]" onClick={onClose}>
      <div role="dialog" aria-modal aria-label={title} className="rise max-h-[85vh] w-full max-w-2xl overflow-auto rounded-2xl border border-line bg-s1 shadow-[var(--shadow-md)]" onClick={(e) => e.stopPropagation()}>
        <header className="sticky top-0 flex items-center justify-between gap-3 border-b border-line bg-s1 px-5 py-3.5">
          <h2 className="font-semibold tracking-tight">{title}</h2>
          <button aria-label="Close" className="grid h-7 w-7 place-items-center rounded-md text-mute hover:bg-s2 hover:text-ink" onClick={onClose}>✕</button>
        </header>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

export function Json({ value }: { value: unknown }) {
  return <pre className="overflow-auto rounded-xl bg-s2 p-3 font-mono text-[11.5px] leading-relaxed text-ink2">{JSON.stringify(value, null, 2)}</pre>;
}

/** Small uppercase section label. */
export function Label({ children }: { children: ReactNode }) {
  return <h3 className="mb-2 text-[11px] font-semibold tracking-wider text-mute uppercase">{children}</h3>;
}
