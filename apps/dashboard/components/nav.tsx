"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ThemeToggle } from "./ui";

const LINKS = [
  { href: "/new", label: "Start a claim", match: (p: string) => p.startsWith("/new") || p.startsWith("/claim") },
  { href: "/ops", label: "Operator console", match: (p: string) => p.startsWith("/ops") },
];

export function Nav() {
  const path = usePathname() ?? "/";
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-[color-mix(in_oklab,var(--bg)_85%,transparent)] backdrop-blur-md">
      <nav className="mx-auto flex h-13 max-w-[1440px] items-center gap-1 px-4 sm:px-6">
        <Link href="/" className="mr-4 flex items-center gap-2 font-semibold tracking-tight text-ink">
          <span aria-hidden className="grid h-6 w-6 place-items-center rounded-md bg-ink text-[13px] text-[var(--bg)]">✓</span>
          <span className="hidden sm:inline">Claim Coordinator</span>
        </Link>
        {LINKS.map((l) => {
          const active = l.match(path);
          return (
            <Link key={l.href} href={l.href} aria-current={active ? "page" : undefined} className={`rounded-md px-2.5 py-1.5 text-sm transition-colors ${active ? "bg-s2 font-medium text-ink" : "text-ink2 hover:bg-s2 hover:text-ink"}`}>
              {l.label}
            </Link>
          );
        })}
        <div className="ml-auto"><ThemeToggle /></div>
      </nav>
    </header>
  );
}
