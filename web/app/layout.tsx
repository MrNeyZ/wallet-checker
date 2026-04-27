import "./globals.css";
import Link from "next/link";
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { logoutAction } from "./login/actions";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "Wallet Checker",
  description: "Solana wallet group dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const authEnabled = Boolean(process.env.WEB_PASSWORD);
  return (
    <html lang="en" className={`${inter.variable} dark`}>
      <body className="min-h-screen bg-neutral-950 text-white" style={{ fontFamily: "var(--font-inter), Inter, ui-sans-serif, system-ui, sans-serif" }}>
        <div className="mx-auto max-w-7xl px-4 py-3">
          <header className="mb-4 flex items-center justify-between border-b border-neutral-800 pb-2">
            <Link
              href="/groups"
              className="flex items-center gap-2 text-sm font-semibold tracking-tight text-neutral-200 transition-colors duration-100 hover:text-white"
            >
              <span className="ui-live-dot" />
              wallet-checker
            </Link>
            <nav className="flex items-center gap-5 text-sm text-neutral-400">
              <Link href="/groups" className="transition-colors duration-100 hover:text-white">
                Groups
              </Link>
              <Link href="/preview" className="transition-colors duration-100 hover:text-white">
                Preview
              </Link>
              {authEnabled && (
                <form action={logoutAction}>
                  <button
                    type="submit"
                    className="text-neutral-400 transition-colors duration-100 hover:text-white"
                  >
                    Logout
                  </button>
                </form>
              )}
            </nav>
          </header>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
