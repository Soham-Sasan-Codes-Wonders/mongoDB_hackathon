import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <h1 className="text-4xl font-bold tracking-tight">Claim Coordinator</h1>
      <p className="mt-2 max-w-3xl text-lg text-ink2">An AI agent that takes a car accident claim from first report to a closed file across the insurer, body shop, rental company and clinic, and only counts a step as done when it can prove it took effect.</p>
      <div className="mt-8 grid gap-4 md:grid-cols-2">
        <Link href="/new" className="rounded-xl border border-line bg-s1 p-6 hover:border-accent">
          <h2 className="text-2xl font-semibold">Start a claim →</h2>
          <p className="mt-1 text-ink2">For the person who had the accident: tell us what happened and follow every step, with plain status.</p>
        </Link>
        <Link href="/ops" className="rounded-xl border border-line bg-s1 p-6 hover:border-accent">
          <h2 className="text-2xl font-semibold">Operator console →</h2>
          <p className="mt-1 text-ink2">For the team and the demo: task graph, action timeline, approvals, agent status and the chaos panel.</p>
        </Link>
      </div>
    </main>
  );
}
