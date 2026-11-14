import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { ThemeToggle, ToastProvider } from "@/components/ui";

export const metadata: Metadata = { title: "Claim Coordinator", description: "An AI agent that takes a car accident claim from first report to a closed file, counting only what it can prove." };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <body className="min-h-screen overflow-x-clip antialiased">
        <ToastProvider>
          <nav className="sticky top-0 z-30 flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-bg/90 px-4 py-2 backdrop-blur">
            <Link href="/" className="text-lg font-bold tracking-tight">Claim Coordinator</Link>
            <Link href="/new" className="text-ink2 hover:text-ink">Start a claim</Link>
            <Link href="/ops" className="text-ink2 hover:text-ink">Operator console</Link>
            <div className="ml-auto"><ThemeToggle /></div>
          </nav>
          {children}
        </ToastProvider>
      </body>
    </html>
  );
}
