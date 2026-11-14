"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { StatusLook } from "@/lib/status";

export function Pill({ look, size = "md", title }: { look: StatusLook; size?: "sm" | "md" | "lg"; title?: string }) {
  const pad = size === "sm" ? "px-1.5 py-0.5 text-xs" : size === "lg" ? "px-3 py-1 text-base" : "px-2 py-0.5 text-sm";
  return (
    <span title={title} className={`inline-flex items-center gap-1 rounded-full border font-medium whitespace-nowrap ${pad}`} style={{ borderColor: look.color, color: look.color, background: `color-mix(in oklab, ${look.color} 14%, transparent)` }}>
      <span aria-hidden>{look.icon}</span>
      {look.label}
    </span>
  );
}

export function Card({ title, right, children, className = "" }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`min-w-0 rounded-xl border border-line bg-s1 ${className}`}>
      {(title || right) && (
        <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line px-4 py-2.5">
          <h2 className="min-w-0 text-base font-semibold text-ink">{title}</h2>
          {right}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Button({ children, onClick, kind = "default", disabled, title, className = "", type = "button" }: { children: ReactNode; onClick?: () => void; kind?: "default" | "primary" | "danger" | "good" | "ghost"; disabled?: boolean; title?: string; className?: string; type?: "button" | "submit" }) {
  const styles: Record<string, string> = {
    default: "border-line bg-s2 hover:bg-s3 text-ink",
    primary: "border-transparent bg-accent text-white hover:brightness-110",
    danger: "border-[var(--st-critical)] text-[var(--st-critical)] hover:bg-[color-mix(in_oklab,var(--st-critical)_15%,transparent)]",
    good: "border-[var(--st-confirmed)] text-[var(--st-confirmed)] hover:bg-[color-mix(in_oklab,var(--st-confirmed)_15%,transparent)]",
    ghost: "border-transparent text-ink2 hover:bg-s2",
  };
  return (
    <button type={type} title={title} disabled={disabled} onClick={onClick} className={`inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${styles[kind]} ${className}`}>
      {children}
    </button>
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
    if (!t.sticky) setTimeout(() => setToasts((x) => x.filter((y) => y.id !== id)), 4500);
  }, []);
  const tone = { ok: "var(--st-confirmed)", err: "var(--st-critical)", info: "var(--st-approval)" };
  // returns the same array when nothing matches, so calling it from an effect can't loop
  const dismiss = useCallback((key: string) => setToasts((x) => (x.some((y) => y.key === key) ? x.filter((y) => y.key !== key) : x)), []);
  const value = useMemo(() => ({ push, dismiss }), [push, dismiss]);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed top-4 right-4 z-50 flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} role="status" className="toast-in pointer-events-auto flex items-start gap-2 rounded-lg border bg-s2 px-3 py-2 text-sm shadow-lg" style={{ borderColor: tone[t.tone] }}>
            <button className="flex-1 text-left" onClick={() => { t.onClick?.(); setToasts((x) => x.filter((y) => y.id !== t.id)); }}>
              {t.text}
            </button>
            <button aria-label="Dismiss" className="text-mute" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>✕</button>
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
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  useEffect(() => {
    let t: "dark" | "light" = "dark";
    try { t = (localStorage.getItem("theme") as "dark" | "light") || "dark"; } catch { /* storage blocked */ }
    setTheme(t);
    document.documentElement.dataset.theme = t;
  }, []);
  const flip = () => {
    const t = theme === "dark" ? "light" : "dark";
    setTheme(t);
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem("theme", t); } catch { /* storage blocked */ }
  };
  return <Button kind="ghost" onClick={flip} title="Toggle light/dark">{theme === "dark" ? "☀ Light" : "☾ Dark"}</Button>;
}

export function Dialog({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div role="dialog" aria-modal className="max-h-[85vh] w-full max-w-2xl overflow-auto rounded-xl border border-line bg-s1 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button aria-label="Close" className="text-mute hover:text-ink" onClick={onClose}>✕</button>
        </header>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

export function Json({ value }: { value: unknown }) {
  return <pre className="overflow-auto rounded-lg bg-s2 p-3 font-mono text-xs leading-relaxed text-ink2">{JSON.stringify(value, null, 2)}</pre>;
}
