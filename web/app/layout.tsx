import "./globals.css";
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { TopNav } from "./_components/TopNav";

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
        <TopNav authEnabled={authEnabled} />
        <div className="mx-auto max-w-7xl px-4 py-3">
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
