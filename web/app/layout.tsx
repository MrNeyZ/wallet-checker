import "./globals.css";
import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Wallet Checker",
  description: "Solana wallet group dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="mx-auto max-w-6xl px-6 py-6">
          <header className="mb-8 flex items-center justify-between border-b border-zinc-200 pb-4">
            <Link href="/groups" className="text-lg font-semibold tracking-tight">
              wallet-checker
            </Link>
            <nav className="text-sm text-zinc-600">
              <Link href="/groups" className="hover:text-zinc-900">
                Groups
              </Link>
            </nav>
          </header>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
