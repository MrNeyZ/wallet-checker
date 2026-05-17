"use client";

// Global top navigation. Mirrors the nft-live-feed TopNav visual language
// (gradient chrome, sliding-pill active state) but ships the wallet-checker
// tab set: GROUPS + BURNER. Active tab is derived from `usePathname()` so
// any future Link in the header stays in sync without callers passing an
// `active` prop.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { logoutAction } from "../login/actions";

type Tab = { key: string; label: string; href: string; matches: string[] };

const TABS: Tab[] = [
  { key: "groups", label: "GROUPS", href: "/groups", matches: ["/groups"] },
  { key: "burner", label: "BURNER", href: "/burner", matches: ["/burner"] },
];

export function TopNav({ authEnabled }: { authEnabled: boolean }) {
  const pathname = usePathname() ?? "";
  const activeKey = TABS.find((t) => t.matches.some((p) => pathname.startsWith(p)))?.key;

  return (
    <header className="vl-topnav">
      <div className="vl-topnav-inner">
        <div className="vl-topnav-left">
          {/* Typography-only VictoryLabs wordmark — italic Playfair "V"
              + "L" lockup, ported 1:1 from nft-live-feed TopNav
              (frontend/src/soloist/shared.tsx:849-861). The link carries
              the accessible name; the lockup itself is aria-hidden. */}
          <Link href="/groups" className="vl-topnav-logo" aria-label="VictoryLabs — home">
            <div className="vl-logo" aria-hidden="true">
              <span className="v">Victory</span><span className="l">Labs</span>
            </div>
          </Link>
          <nav className="vl-topnav-tabs" aria-label="Primary">
            {TABS.map((t) => (
              <Link
                key={t.key}
                href={t.href}
                className={`vl-topnav-tab ${activeKey === t.key ? "is-active" : ""}`}
                data-tab={t.key}
              >
                {t.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="vl-topnav-right">
          {authEnabled && (
            <form action={logoutAction}>
              <button type="submit" className="vl-topnav-logout">
                Logout
              </button>
            </form>
          )}
        </div>
      </div>
    </header>
  );
}
