import Link from "next/link";

const POINTS = [
  { t: "Proof, not responses", d: "An API's OK is only an acknowledgement. A step counts once a read-back proves it." },
  { t: "Survives a crash", d: "State lives in MongoDB. Kill the agent mid-claim and it picks up where it left off." },
  { t: "Humans decide what's binding", d: "Settlements, releases, fault and extra costs always wait for a person." },
];

export default function Home() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-14 sm:px-6 sm:py-20">
      <p className="text-xs font-semibold tracking-widest text-mute uppercase">Claim Coordinator</p>
      <h1 className="mt-3 max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl">From the accident to a closed claim, with every step proven.</h1>
      <p className="mt-4 max-w-2xl text-lg text-ink2">An AI agent that works across the insurer, body shop, rental company and clinic, and only marks a step done when it can show it really happened.</p>
      <div className="mt-8 flex flex-wrap gap-3">
        <Link href="/new" className="inline-flex h-10 items-center rounded-lg bg-ink px-4 text-sm font-medium text-[var(--bg)] hover:opacity-90">Start a claim</Link>
        <Link href="/ops" className="inline-flex h-10 items-center rounded-lg border border-line bg-s1 px-4 text-sm font-medium text-ink shadow-[var(--shadow-sm)] hover:bg-s2">Open the operator console</Link>
      </div>
      <div className="mt-16 grid gap-6 border-t border-line pt-8 sm:grid-cols-3">
        {POINTS.map((p) => (
          <div key={p.t}>
            <h2 className="text-sm font-semibold">{p.t}</h2>
            <p className="mt-1 text-sm text-ink2">{p.d}</p>
          </div>
        ))}
      </div>
    </main>
  );
}
