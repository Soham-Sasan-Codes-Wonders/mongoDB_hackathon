"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { startClaim } from "@/app/actions";
import { Button, Card, useRun } from "@/components/ui";
import { DEMO_INTAKE, type IntakeInput } from "@/lib/demo";

const EMPTY: IntakeInput = { name: "", phone: "", email: "", date: "", place: "", description: "", otherDriverName: "", otherDriverPlate: "", otherDriverInsurer: "", policyNumber: "", policeReportNumber: "", injuries: false, vin: "", make: "", model: "" };

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium text-ink2">{label}</span>
      {children}
      {hint && <span className="text-xs text-mute">{hint}</span>}
    </label>
  );
}
const input = "rounded-lg border border-line bg-s2 px-3 py-2 text-base text-ink outline-none focus:border-accent";

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
    <main className="mx-auto max-w-4xl px-4 py-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-3xl font-bold">Start a claim</h1>
        <Button onClick={() => setF({ ...DEMO_INTAKE })}>Fill with demo values</Button>
      </div>
      <form onSubmit={submit} className="grid gap-4">
        <Card title="Tell us what happened">
          <textarea required value={f.description} onChange={(e) => set("description", e.target.value)} rows={4} placeholder="In your own words…" className={`${input} w-full`} />
          <label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={f.injuries} onChange={(e) => set("injuries", e.target.checked)} /> Someone was hurt (we'll track medical bills too)</label>
        </Card>
        <Card title="The accident">
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Date"><input required type="date" value={f.date} onChange={(e) => set("date", e.target.value)} className={input} /></Field>
            <Field label="Place"><input required value={f.place} onChange={(e) => set("place", e.target.value)} className={input} /></Field>
            <Field label="Other driver's name"><input value={f.otherDriverName} onChange={(e) => set("otherDriverName", e.target.value)} className={input} /></Field>
            <Field label="Other driver's plate"><input value={f.otherDriverPlate} onChange={(e) => set("otherDriverPlate", e.target.value)} className={input} /></Field>
            <Field label="Other driver's insurer"><input value={f.otherDriverInsurer} onChange={(e) => set("otherDriverInsurer", e.target.value)} className={input} /></Field>
            <Field label="Police report number" hint="e.g. PR-55120"><input value={f.policeReportNumber} onChange={(e) => set("policeReportNumber", e.target.value)} className={input} /></Field>
          </div>
        </Card>
        <Card title="You, your policy and your car">
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Your name"><input required value={f.name} onChange={(e) => set("name", e.target.value)} className={input} /></Field>
            <Field label="Phone" hint="E.164, e.g. +15550109999"><input required pattern="^\+[1-9]\d{6,14}$" value={f.phone} onChange={(e) => set("phone", e.target.value)} className={input} /></Field>
            <Field label="Email"><input type="email" value={f.email} onChange={(e) => set("email", e.target.value)} className={input} /></Field>
            <Field label="Policy number" hint="e.g. POL-88812"><input required value={f.policyNumber} onChange={(e) => set("policyNumber", e.target.value)} className={input} /></Field>
            <Field label="VIN"><input required value={f.vin} onChange={(e) => set("vin", e.target.value)} className={input} /></Field>
            <Field label="Make / model"><div className="flex gap-2"><input value={f.make} onChange={(e) => set("make", e.target.value)} placeholder="Make" className={`${input} w-1/2`} /><input value={f.model} onChange={(e) => set("model", e.target.value)} placeholder="Model" className={`${input} w-1/2`} /></div></Field>
            <Field label="Photos of the damage" hint="Stored in MongoDB GridFS"><input type="file" multiple accept="image/*" onChange={(e) => setFiles([...(e.target.files ?? [])])} className="text-sm" /></Field>
          </div>
        </Card>
        <div className="flex justify-end"><Button type="submit" kind="primary" disabled={!!busy} className="px-6 py-2.5 text-base">{busy ? "Filing…" : "File my claim"}</Button></div>
      </form>
    </main>
  );
}
