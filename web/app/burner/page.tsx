"use client";

// Standalone Solana Burner page — Burner.html-style chrome wrapping the
// real CleanerRow burn flows. NO scan/burn/sign/audit/transaction logic
// lives here; everything destructive still runs through the
// CleanerRow → CleanerDetails → BurnSignAndSendBlock pipeline that the
// /groups/[id]?tab=cleaner view also uses. This file owns ONLY:
//   • warning strip
//   • 4-up stat cards (Items Found / Selected / Est. Reclaim / Est. Network Fee)
//   • category tabs (NFTs / Core / Tokens / Empty Accounts)
//   • toolbar (Rescan; "showing N items")
//   • CleanerRow rendered with the active tab's `visibleSection`
//
// Data not currently exposed by CleanerRow's children (e.g. live
// "Selected" count across discovery sub-trees, real "Est. Network Fee")
// is rendered as `—` rather than a fake number, per spec.

import { useMemo, useState } from "react";
import {
  CleanerRow,
  ScanRegistryProvider,
  WalletConnectBar,
  WalletProvider,
  useWallet,
  type CleanerRowSummary,
  type CleanerVisibleSection,
} from "../groups/[id]/cleaner";
import { fmtSol } from "@/lib/format";

type Tab = { key: CleanerVisibleSection; label: string };

const TABS: Tab[] = [
  { key: "nfts", label: "NFTs" },
  { key: "core", label: "Core" },
  { key: "tokens", label: "Tokens" },
  { key: "empty", label: "Empty Accounts" },
];

export default function BurnerPage() {
  return (
    <WalletProvider>
      <ScanRegistryProvider>
        <BurnerBody />
      </ScanRegistryProvider>
    </WalletProvider>
  );
}

function BurnerBody() {
  const { connected } = useWallet();
  const [tab, setTab] = useState<CleanerVisibleSection>("nfts");
  const [summary, setSummary] = useState<CleanerRowSummary | null>(null);

  // Items Found = (empty token accounts) + (SPL burn candidates) + (NFTs).
  // Core assets aren't in the cleanup-scan registry (they're discovered
  // lazily by their burn section), so they're not counted here — the
  // Core tab still works, the top stat just doesn't include them.
  const itemsFound = summary
    ? summary.empty + summary.fungible + summary.nft
    : null;

  return (
    <div className="space-y-3">
      {/* Warning strip — matches Burner.html "destructive" banner.
          Red-coded but desaturated so it reads as info, not alarm. */}
      <div
        role="note"
        className="flex items-center gap-2 rounded-[10px] border border-[rgba(239,120,120,0.16)] bg-[rgba(239,120,120,0.04)] px-3 py-1.5 text-[12px] text-[rgba(239,120,120,0.85)]"
      >
        <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--vl-red)] shadow-[0_0_8px_rgba(239,120,120,0.6)]" />
        <span>
          <span className="font-semibold text-[#f8a7a7]">destructive</span>
          {" · "}burns are irreversible. Every burn requires acknowledgement,
          audit pass, and wallet match before sign.
        </span>
        <span className="ml-auto font-mono text-[11px] text-[color:var(--vl-fg-3)]">
          safety: <span className="font-semibold text-[color:var(--vl-fg)]">strict</span>
        </span>
      </div>

      {/* 4-up stat cards. Items / Reclaim derive from the lifted scan
          summary; Selected / Network Fee aren't exposed by the cleaner
          subtree without lifting more state — rendered as `—` per the
          "no fake data" spec. */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <StatCard
          label="Items Found"
          value={itemsFound !== null ? itemsFound.toLocaleString("en-US") : "—"}
          sub={summary ? "across NFTs · SPL · Empty" : "scan a wallet"}
        />
        <StatCard
          label="Selected"
          value="—"
          sub="select items below"
        />
        <StatCard
          label="Est. Reclaim"
          value={
            summary ? `${fmtSol(summary.reclaimSol)} SOL` : "—"
          }
          sub={summary ? "max possible" : "scan a wallet"}
          accent="green"
        />
        <StatCard
          label="Est. Network Fee"
          value="—"
          sub="depends on selection"
          accent="muted"
        />
      </div>

      {/* Compact wallet pill — replaces the "old bulky wallet/scan row".
          Connect / disconnect lives here; per-wallet rescan lives inside
          CleanerRow's compact header below. */}
      <WalletConnectBar />

      {/* Category tabs — driven by `visibleSection` filter on
          CleanerRow → CleanerDetails. Tab state is page-local. */}
      <nav role="tablist" aria-label="Burn categories" className="vl-tabstrip">
        {TABS.map((t) => {
          const isActive = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setTab(t.key)}
              className={`vl-tab ${isActive ? "is-active" : ""}`}
            >
              {t.label}
            </button>
          );
        })}
      </nav>

      {connected ? (
        // Remount on account switch so per-wallet scan state resets cleanly.
        // `key` deliberately includes the active tab so the open state of
        // each section seeds correctly when the user switches tabs.
        <CleanerRow
          key={`${connected}:${tab}`}
          wallet={{ address: connected, label: null }}
          visibleSection={tab}
          compact
          onSummaryChange={setSummary}
        />
      ) : (
        <DisconnectedCta />
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: "green" | "muted";
}) {
  // `vl-card` gives the lifted purple-bordered surface; the 22px value
  // sets the visual weight per Burner.html.
  const valColor =
    accent === "green"
      ? "text-[color:var(--vl-purple-2)]"
      : accent === "muted"
        ? "text-[color:var(--vl-fg-2)]"
        : "text-white";
  return (
    <div className="vl-card flex flex-col gap-0.5 px-3.5 py-3">
      <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.4px] text-[color:var(--vl-fg-3)]">
        {label}
      </div>
      <div className={`text-[22px] font-bold leading-tight tracking-tight tabular-nums ${valColor}`}>
        {value}
      </div>
      {sub && (
        <div className="font-mono text-[11px] text-[color:var(--vl-fg-4)]">
          {sub}
        </div>
      )}
    </div>
  );
}

function DisconnectedCta() {
  return (
    <div className="vl-card px-4 py-8 text-center sm:py-10">
      <div className="mx-auto max-w-sm space-y-2">
        <div className="text-base font-semibold text-white">
          Connect a wallet to begin
        </div>
        <p className="text-sm text-[color:var(--vl-fg-2)]">
          The burner needs Phantom or Solflare to sign close-empty and burn
          transactions. Each burn flow gates the sign button on wallet match,
          a client-side audit, and a destructive-action acknowledgement.
        </p>
        <p className="text-[11px] text-[color:var(--vl-fg-3)]">
          Use the “Connect wallet” button above.
        </p>
      </div>
    </div>
  );
}
