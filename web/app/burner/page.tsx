"use client";

// Standalone Solana Burner page. Composes the per-wallet CleanerRow from the
// group cleaner module — that single component already implements every
// burner requirement (collapsible burn sections default-collapsed, close-empty
// always visible, no auto-select, preview-only burns, ReclaimSummary +
// ActionPlan). Page chrome (title, subtitle, warning, connect CTA) is
// burner-specific and lives here.

import {
  CleanerRow,
  ScanRegistryProvider,
  WalletConnectBar,
  WalletProvider,
  useWallet,
} from "../groups/[id]/cleaner";

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
        <h1 className="text-xl font-bold tracking-tight text-white sm:text-2xl">
          Solana Burner
        </h1>
        <p className="text-sm text-neutral-400">
          Clean empty token accounts and preview max-reclaim burns for SPL,
          Legacy NFT, pNFT, and Core.
        </p>
      </header>

      <div
        role="note"
        className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-200"
      >
        <span className="font-semibold">Heads-up:</span> burn flows are
        preview-only. Only close-empty can be signed.
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
    <div className="rounded-md border border-dashed border-neutral-700 bg-neutral-900/40 px-4 py-8 text-center sm:py-10">
      <div className="mx-auto max-w-sm space-y-2">
        <div className="text-base font-semibold text-white">
          Connect a wallet to begin
        </div>
        <p className="text-sm text-neutral-400">
          The burner needs Phantom or Solflare to sign close-empty
          transactions. Burn flows are preview-only and require no signature.
        </p>
        <p className="text-[11px] text-neutral-500">
          Use the “Connect wallet” button above.
        </p>
      </div>
    </div>
  );
}
