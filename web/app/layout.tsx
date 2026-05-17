import "./globals.css";
import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { TopNav } from "./_components/TopNav";
import { BottomNav } from "./_components/BottomNav";
import { LayoutModeSwitcher } from "./_components/LayoutModeSwitcher";
import { BurnerModeProvider } from "@/lib/burnerModeContext";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

// Terminal-feel mono shipped self-hosted via next/font/google. Same
// `display: swap` as Inter so first paint uses system mono and then
// re-renders without layout shift once the web font lands. Weights:
// 500/600 for labels, 700 for tabular values, 400 kept for incidentals.
// `--vl-font-mono` in globals.css points at this CSS variable first.
const jetBrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600", "700"],
  variable: "--font-jetbrains-mono",
});

export const metadata: Metadata = {
  // Per-page metadata sets a short string ("Burner", "Groups", group
  // name…) and the template wraps it as "VictoryLabs — <page>". The
  // `default` is the fallback when a page doesn't override (e.g. error
  // pages or routes without their own metadata export).
  title: {
    default: "VictoryLabs",
    template: "VictoryLabs — %s",
  },
  description: "Solana wallet group dashboard",
};

// Pre-paint layout-mode application. The SSR HTML ships with the laptop
// default (`data-layout="laptop"` below) so the most common case never
// flashes; this inline script runs during HTML parse — before hydration —
// to swap in the persisted `pc` / `phone` value for those users. Mirrors
// the nft-live-feed `vl.layoutMode` convention. Kept inline (not a module)
// so it executes synchronously ahead of any layout-affecting CSS.
const LAYOUT_MODE_BOOT = `try{var m=localStorage.getItem('vl.layoutMode');if(m==='pc'||m==='laptop'||m==='phone'){document.documentElement.dataset.layout=m;}}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const authEnabled = Boolean(process.env.WEB_PASSWORD);
  return (
    // suppressHydrationWarning: the inline script below mutates
    // documentElement.dataset.layout before React hydrates, which would
    // otherwise be flagged as an attribute mismatch on <html>.
    <html
      lang="en"
      className={`${inter.variable} ${jetBrainsMono.variable} dark`}
      data-layout="laptop"
      suppressHydrationWarning
    >
      <body className="min-h-screen bg-neutral-950 text-white" style={{ fontFamily: "var(--font-inter), Inter, ui-sans-serif, system-ui, sans-serif" }}>
        <script dangerouslySetInnerHTML={{ __html: LAYOUT_MODE_BOOT }} />
        {/* BurnerModeProvider lifts Bulk Burner Safe/Fast signing mode
            so the new persistent BottomNav HUD can toggle it from
            outside the /burner page tree. Inside /burner, the existing
            inline pill above the bulk button reads/writes the same
            context — both controls stay in lock-step. Defaults to
            "safe" per session (no localStorage; conservative default
            for a destructive flow). */}
        <BurnerModeProvider>
          <TopNav authEnabled={authEnabled} />
          {/* WC v2 `.vl-layout` content wrapper. Default = centered 1480px;
              `data-layout="pc|laptop|phone"` switches to full-width with
              mode-specific horizontal padding (24 / 16 / 10 px) — so the
              Burner (and every page) shares one workspace width per mode
              instead of the old fixed 1280px centered column. Auth, TopNav,
              providers and global shell behavior are unchanged. */}
          <div className="vl-layout">
            <main>{children}</main>
          </div>
          <LayoutModeSwitcher />
          {/* Persistent bottom HUD. Visual chrome ported 1:1 from
              nft-live-feed BottomStatusBar; content tailored: Burner /
              Groups tabs, footer links, and (on /burner) the Safe/Fast
              mode pill that drives the lifted BurnerMode context. */}
          <BottomNav />
        </BurnerModeProvider>
      </body>
    </html>
  );
}
