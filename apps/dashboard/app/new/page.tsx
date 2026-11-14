"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { startClaim } from "@/app/actions";
import { Button, useRun } from "@/components/ui";
import { DEMO_INTAKE, type IntakeInput } from "@/lib/demo";

const EMPTY: IntakeInput = { name: "", phone: "", email: "", date: "", place: "", description: "", otherDriverName: "", otherDriverPlate: "", otherDriverInsurer: "", policyNumber: "", policeReportNumber: "", injuries: false, vin: "", make: "", model: "" };

function Field({ label, children, hint, wide }: { label: string; children: React.ReactNode; hint?: string; wide?: boolean }) {
  return (
    <label className={`flex flex-col gap-1.5 ${wide ? "md:col-span-2" : ""}`}>
      <span className="text-[13px] font-medium text-ink">{label}</span>
      {children}
      {hint && <span className="text-xs text-mute">{hint}</span>}
    </label>
  );
}
const input = "h-10 w-full rounded-lg border border-line bg-s1 px-3 text-sm text-ink shadow-[var(--shadow-sm)] outline-none placeholder:text-mute focus:border-line2";

function Section({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-x-10 gap-y-4 border-t border-line py-8 md:grid-cols-[14rem_1fr]">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="mt-1 text-sm text-mute">{sub}</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">{children}</div>
    </section>
  );
}

export default function NewClaim() {
  const router = useRouter();
  const { run, busy } = useRun();
  const [f, setF] = useState<IntakeInput>(EMPTY);
  const [files, setFiles] = useState<File[]>([]);
  const set = <K extends keyof IntakeInput>(k: K, v: IntakeInput[K]) => setF((x) => ({ ...x, [k]: v }));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const fd = new FormData();
    fd.set("intake", JSON.stringify({ ...f, year: f.year ? Number(f.year) : undefined }));
    for (const file of files) fd.append("photos", file);
    const r = await run("submit", () => startClaim(fd));
    if (r.ok && "claimId" in r && r.claimId) router.push(`/claim/${r.claimId}`);
  };
  return (
    <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12">
      <div className="flex flex-wrap items-end justify-between gap-3 pb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Start a claim</h1>
          <p className="mt-1 text-sm text-ink2">Takes about two minutes. We'll handle the insurer, body shop and rental car from here.</p>
        </div>
        <Button kind="ghost" onClick={() => setF({ ...DEMO_INTAKE })}>Fill with demo values</Button>
      </div>
      <form onSubmit={submit}>
        <Section title="What happened" sub="In your own words. Anything you remember helps.">
          <Field label="Description" wide>
            <textarea required value={f.description} onChange={(e) => set("description", e.target.value)} rows={4} placeholder="I was stopped at a light when…" className={`${input} h-auto py-2.5 leading-relaxed`} />
          </Field>
          <label className="flex items-center gap-2.5 text-sm text-ink2 md:col-span-2">
            <input type="checkbox" checked={f.injuries} onChange={(e) => set("injuries", e.target.checked)} className="h-4 w-4 accent-[var(--text-primary)]" />
            Someone was hurt (we'll track medical bills too)
          </label>
        </Section>
        <Section title="The accident" sub="Where and when, and who else was involved.">
          <Field label="Date"><input required type="date" value={f.date} onChange={(e) => set("date", e.target.value)} className={input} /></Field>
          <Field label="Place"><input required value={f.place} onChange={(e) => set("place", e.target.value)} placeholder="Street and city" className={input} /></Field>
          <Field label="Other driver's name"><input value={f.otherDriverName} onChange={(e) => set("otherDriverName", e.target.value)} className={input} /></Field>
          <Field label="Other driver's plate"><input value={f.otherDriverPlate} onChange={(e) => set("otherDriverPlate", e.target.value)} className={input} /></Field>
          <Field label="Other driver's insurer"><input value={f.otherDriverInsurer} onChange={(e) => set("otherDriverInsurer", e.target.value)} className={input} /></Field>
          <Field label="Police report number" hint="Optional, e.g. PR-55120"><input value={f.policeReportNumber} onChange={(e) => set("policeReportNumber", e.target.value)} className={input} /></Field>
        </Section>
        <Section title="You and your car" sub="So we can open the claim with your insurer.">
          <Field label="Your name"><input required value={f.name} onChange={(e) => set("name", e.target.value)} className={input} /></Field>
          <Field label="Phone" hint="With country code, e.g. +15550109999"><input required pattern="^\+[1-9]\d{6,14}$" value={f.phone} onChange={(e) => set("phone", e.target.value)} className={input} /></Field>
          <Field label="Email"><input type="email" value={f.email} onChange={(e) => set("email", e.target.value)} className={input} /></Field>
          <Field label="Policy number" hint="e.g. POL-88812"><input required value={f.policyNumber} onChange={(e) => set("policyNumber", e.target.value)} className={input} /></Field>
          <Field label="VIN"><input required value={f.vin} onChange={(e) => set("vin", e.target.value)} className={input} /></Field>
          <Field label="Make and model"><div className="flex gap-2"><input value={f.make} onChange={(e) => set("make", e.target.value)} placeholder="Make" aria-label="Make" className={input} /><input value={f.model} onChange={(e) => set("model", e.target.value)} placeholder="Model" aria-label="Model" className={input} /></div></Field>
          <Field label="Photos of the damage" hint="Optional. Stored securely in MongoDB GridFS." wide>
            <input type="file" multiple accept="image/*" onChange={(e) => setFiles([...(e.target.files ?? [])])} className="text-sm text-ink2 file:mr-3 file:h-8 file:rounded-lg file:border file:border-line file:bg-s1 file:px-3 file:text-sm file:font-medium file:text-ink hover:file:bg-s2" />
          </Field>
        </Section>
        <div className="flex items-center justify-end gap-3 border-t border-line pt-6">
          <span className="text-xs text-mute">You'll be able to follow every step.</span>
          <Button type="submit" kind="primary" disabled={!!busy} className="h-10 px-5">{busy ? "Filing…" : "File my claim"}</Button>
        </div>
      </form>
    </main>
  );
}
