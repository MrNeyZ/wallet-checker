"use client";

// Persistent bottom HUD/nav bar. Visual chrome mirrors nft-live-feed's
// BottomStatusBar (frontend/src/soloist/shared.tsx:1188) at a 1:1 level
// — same layered glass base (linear + radial), same purple bottom haze,
// same backdrop blur, same upward shadow set. Renders on every route;
// safe-area-inset-bottom padding keeps the bar above iOS home-indicator.
//
// Contents:
//   - Left: tabs (BURNER / GROUPS) — same sliding-active style as the
//     top nav, just anchored from bottom up. Tap-friendly on mobile.
//   - Right: Discord / Twitter footer links (parity with live-feed) +
//     a Safe / Fast signing-mode pill that ONLY renders when the active
//     route is /burner. Pill reads/writes the shared BurnerMode context
//     so the inline pill above the bulk button stays in lock-step.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useBurnerMode } from "@/lib/burnerModeContext";

type NavTab = { key: string; label: string; href: string; matches: string[] };

const TABS: NavTab[] = [
  { key: "burner", label: "BURNER", href: "/burner", matches: ["/burner"] },
  { key: "groups", label: "GROUPS", href: "/groups", matches: ["/groups"] },
];

export function BottomNav() {
  const pathname = usePathname() ?? "";
  const activeKey = TABS.find((t) => t.matches.some((p) => pathname.startsWith(p)))?.key;
  const isBurner = pathname.startsWith("/burner");
  const { mode, setMode } = useBurnerMode();

  return (
    <nav className="vl-bottomnav" aria-label="Secondary">
      <div className="vl-bottomnav-inner">
        <div className="vl-bottomnav-tabs">
          {TABS.map((t) => (
            <Link
              key={t.key}
              href={t.href}
              className={`vl-bottomnav-tab ${activeKey === t.key ? "is-active" : ""}`}
              data-tab={t.key}
            >
              {t.label}
            </Link>
          ))}
        </div>
        <div className="vl-bottomnav-right">
          <a
            href="https://discord.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="vl-bottomnav-link"
          >
            Discord
          </a>
          <a
            href="https://x.com/VictoryHell_"
            target="_blank"
            rel="noopener noreferrer"
            className="vl-bottomnav-link"
          >
            Twitter
          </a>
          {isBurner && (
            <div className="vl-bottomnav-mode" role="radiogroup" aria-label="Bulk burn signing mode">
              <button
                type="button"
                role="radio"
                aria-checked={mode === "safe"}
                onClick={() => setMode("safe")}
                title="Safe: one approval per transaction. Phantom shows accurate NFT changes."
                className={`vl-bottomnav-mode-btn ${mode === "safe" ? "is-safe" : "is-off"}`}
              >
                Safe
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={mode === "fast"}
                onClick={() => setMode("fast")}
                title="Fast: one batched approval per window. Phantom may show 0 changes / unsafe warning."
                className={`vl-bottomnav-mode-btn ${mode === "fast" ? "is-fast" : "is-off"}`}
              >
                Fast
              </button>
            </div>
          )}
        </div>
      </div>
    </nav>
  );
}
