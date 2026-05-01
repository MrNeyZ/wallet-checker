"use client";

// Standalone Solana Burner page. Composes the per-wallet CleanerRow from the
// group cleaner module — that single component already implements every
// burner requirement (collapsible burn sections default-collapsed, close-empty
// always visible, no auto-select, sign+send gated by destructive-ack +
// audit + wallet match, ReclaimSummary + ActionPlan). Page chrome (title,
// subtitle, warning, connect CTA) is burner-specific and lives here.
//
// The shell here is the only Batch-1 surface the user sees on this route —
// `CleanerRow` internals are explicitly out of scope per migration plan.

import {
  CleanerRow,
  ScanRegistryProvider,
  WalletConnectBar,
  WalletProvider,
  useWallet,
} from "../groups/[id]/cleaner";
import { Card } from "@/ui-kit/components/Card";

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
  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <div className="vl-section-header">VictoryLabs · Burner</div>
        <h1 className="text-xl font-bold tracking-tight text-white sm:text-2xl">
          Solana Burner
        </h1>
        <p className="text-sm text-[color:var(--vl-fg-2)]">
          Clean empty token accounts and preview max-reclaim burns for SPL,
          Legacy NFT, pNFT, and Core.
        </p>
      </header>

      {/* Destructive-action banner — red-coded but desaturated to match the
          Burner.html "warning strip" tone (low surface, soft border, faint
          red glyph). */}
      <div
        role="note"
        className="flex items-start gap-2 rounded-[10px] border border-[rgba(239,120,120,0.16)] bg-[rgba(239,120,120,0.04)] px-3 py-2 text-xs text-[rgba(239,120,120,0.85)]"
      >
        <span className="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--vl-red)] shadow-[0_0_8px_rgba(239,120,120,0.6)]" />
        <span>
          <span className="font-semibold text-[#f8a7a7]">destructive</span>
          {" · "}burns are irreversible. Every burn requires you to acknowledge
          the action before the sign button enables — no auto-sign anywhere.
        </span>
      </div>

      <WalletConnectBar />

      {connected ? (
        // Remount on account switch so per-wallet scan state resets cleanly.
        <CleanerRow
          key={connected}
          wallet={{ address: connected, label: null }}
        />
      ) : (
        <DisconnectedCta />
      )}
    </div>
  );
}

function DisconnectedCta() {
  return (
    <Card tone="vl" className="px-4 py-8 text-center sm:py-10">
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
    </Card>
  );
}
