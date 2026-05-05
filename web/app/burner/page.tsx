"use client";

// Standalone Solana Burner page — Burner.html-style chrome wrapping the
// real CleanerRow burn flows. NO scan/burn/sign/audit/transaction logic
// lives here; everything destructive still runs through the
// CleanerRow → CleanerDetails → BurnSignAndSendBlock pipeline that the
// /groups/[id]?tab=cleaner view also uses. This file owns ONLY:
//   • warning strip
//   • 4-up stat cards (Items Found / Selected / Est. Reclaim / Est. Network Fee)
//   • category tabs (NFTs / Core / Tokens / Empty Accounts)
//   • CleanerRow (compact slim wallet+Scan toolbar lives inside it)
//   • SolRip-style sticky bottom action bar driven by the lifted
//     BurnSelectionProvider registry that each burn section publishes
//     into via useBurnSelectionPublisher

import { useEffect, useState } from "react";
import {
  BurnAckProvider,
  BurnSelectionProvider,
  CleanerRow,
  ScanRegistryProvider,
  WalletProvider,
  useBurnSelectionRegistry,
  useWallet,
  type BurnSectionKey,
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
        <BurnSelectionProvider>
          <BurnerBody />
        </BurnSelectionProvider>
      </ScanRegistryProvider>
    </WalletProvider>
  );
}

function BurnerBody() {
  const { connected, connecting, connect } = useWallet();
  const [tab, setTab] = useState<CleanerVisibleSection>("nfts");
  const [summary, setSummary] = useState<CleanerRowSummary | null>(null);

  // The page-level "Acknowledge irreversible burn" checkbox was removed
  // (operator was tired of the extra click). Phantom's own wallet sign
  // dialog already requires an explicit user confirmation per burn, and
  // the audit / wallet-match / simulation gates inside
  // BurnSignAndSendBlock are unchanged — that's the safety boundary the
  // burn pipeline actually relies on. We keep the BurnAckProvider with
  // a hard-coded `true` so the compact `BurnSignAndSendBlock` (which
  // still reads `useBurnAck()`) sees the ack as always-satisfied
  // without us having to touch its internals.

  // NOTE: this component intentionally does NOT subscribe to the burn
  // selection registry. Every per-section publisher tick (selection toggle,
  // discovery completion, canBuild flip) would otherwise re-render
  // BurnerBody, which would in turn re-render the heavy CleanerRow tree
  // — even though only the StatCards + sticky bar actually depend on
  // registry data. The registry consumers are split into BurnerStatTiles
  // and StickyActionBarWired children below; they re-render on publisher
  // ticks while CleanerRow stays put.

  return (
    <BurnAckProvider value={true}>
    {/* `vl-burner` scopes a perf-trim CSS block in globals.css that
        disables backdrop-filter blur + heavy box-shadow glow on every
        .vl-card / .vl-burn-card / .vl-action-bar inside this subtree.
        Hundreds of frosted cards on a 1000+ NFT wallet were a major
        compositor hot path. The full /groups/[id] view stays untouched. */}
    <div className="vl-burner space-y-2.5">
      {/* Warning strip — slim red-coded banner; matches Burner.html. */}
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

      <BurnerStatTiles summary={summary} />

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
        // Key on the connected wallet ONLY. Switching tabs must not
        // remount CleanerRow — otherwise every Legacy/pNFT/Core
        // discovery and every selection state would be thrown away on
        // each tab click. CleanerDetails handles the per-tab visibility
        // via `visibleSection` with a lazy-mount + hidden-attribute
        // pattern (see CleanerDetails). The slim wallet+Scan toolbar
        // lives inside CleanerRow's compact header, so the previous
        // page-level WalletConnectBar (chunky duplicate) is gone.
        <>
          {/* Bottom padding so content scrolls clear of the sticky
              action bar (~88px including safe area). */}
          <div className="pb-[88px]">
            <CleanerRow
              key={connected}
              wallet={{ address: connected, label: null }}
              visibleSection={tab}
              compact
              onSummaryChange={setSummary}
            />
          </div>
          <StickyActionBarWired
            tab={tab}
            hasScan={summary !== null}
          />
        </>
      ) : (
        <DisconnectedCta onConnect={() => void connect()} connecting={connecting} />
      )}
    </div>
    </BurnAckProvider>
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
  // Compact tile inside the .vl-card surface. Smaller value + tighter
  // padding so the empty pre-scan state reads as informational chrome,
  // not as four giant placeholder cards.
  const valColor =
    accent === "green"
      ? "text-[color:var(--vl-purple-2)]"
      : accent === "muted"
        ? "text-[color:var(--vl-fg-2)]"
        : "text-white";
  return (
    <div className="vl-card flex flex-col gap-0.5 px-3 py-2">
      <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.4px] text-[color:var(--vl-fg-3)]">
        {label}
      </div>
      <div className={`text-[18px] font-bold leading-tight tracking-tight tabular-nums ${valColor}`}>
        {value}
      </div>
      {sub && (
        <div className="font-mono text-[10px] text-[color:var(--vl-fg-4)]">
          {sub}
        </div>
      )}
    </div>
  );
}

// Subscribes to the burn selection registry — re-renders on every
// per-section publish, but stays a leaf so the heavy CleanerRow tree
// in BurnerBody is unaffected.
function BurnerStatTiles({ summary }: { summary: CleanerRowSummary | null }) {
  const registry = useBurnSelectionRegistry();

  // Items Found = sum of every burnable section's RENDERED list size.
  // Reads `totalBurnable` directly from each section's registry entry
  // so the headline number is exactly what the four tabs collectively
  // display — never the raw scan totals (which include empty-account
  // close ops, filtered NFT candidates, and misc pre-filter noise).
  // Empty accounts intentionally excluded: the headline counts only
  // burnable assets per the user's spec.
  // null = the section hasn't finished its discovery pass yet (Legacy /
  // pNFT / Core do their own DAS-backed discovery after the cleanup
  // scan resolves). Only sections that HAVE published a non-null
  // totalBurnable contribute — `anyDiscovered` gates the headline so
  // it shows "—" until at least one of the four burnable sections has
  // reported, instead of an artificially low intermediate count.
  const legacyBurnable = registry.legacyNft?.totalBurnable ?? null;
  const pnftBurnable   = registry.pnft?.totalBurnable      ?? null;
  const coreBurnable   = registry.core?.totalBurnable      ?? null;
  const splBurnable    = registry.splBurn?.totalBurnable   ?? null;
  const anyDiscovered =
    legacyBurnable !== null ||
    pnftBurnable   !== null ||
    coreBurnable   !== null ||
    splBurnable    !== null;
  const itemsFound = anyDiscovered
    ? (legacyBurnable ?? 0) +
      (pnftBurnable   ?? 0) +
      (coreBurnable   ?? 0) +
      (splBurnable    ?? 0)
    : null;
  const fmtPart = (n: number | null) => (n === null ? "…" : n.toString());
  const itemsBreakdown = `NFT: ${fmtPart(legacyBurnable)} • pNFT: ${fmtPart(pnftBurnable)} • Core: ${fmtPart(coreBurnable)} • SPL: ${fmtPart(splBurnable)}`;

  // Aggregate selected count + reclaim across ALL sections (not just the
  // active tab) for the "Selected" + "Est. Reclaim" stat cards — those
  // tiles read as "what's currently staged for burn", which spans tabs.
  const totalSelected = totalSelectedAcrossSections(registry);
  const totalReclaimSelected = totalReclaimAcrossSections(registry);

  // Routing summary log — fires only when one of the per-type discovery
  // counts actually changes (selection toggles don't move these), so we
  // get one stable line per "discovery completed" event rather than a
  // log spam on every checkbox click. `skipped` is best-effort: the
  // registry doesn't carry per-section non-burnable counts (those live
  // inside each section's local state), so we surface only the four
  // burnable totals here.
  useEffect(() => {
    console.log("[burner] routing summary", {
      legacy: legacyBurnable,
      pnft: pnftBurnable,
      core: coreBurnable,
      spl: splBurnable,
      skipped: "see per-section discovery logs",
    });
  }, [legacyBurnable, pnftBurnable, coreBurnable, splBurnable]);

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <StatCard
        label="Items Found"
        value={itemsFound !== null ? itemsFound.toLocaleString("en-US") : "—"}
        sub={summary ? itemsBreakdown : "scan to populate"}
      />
      <StatCard
        label="Selected"
        value={totalSelected > 0 ? totalSelected.toLocaleString("en-US") : "—"}
        sub={
          totalSelected > 0
            ? "across all sections"
            : "select items below"
        }
        accent={totalSelected > 0 ? undefined : "muted"}
      />
      <StatCard
        label="Est. Reclaim"
        value={
          totalSelected > 0
            ? `${fmtSol(totalReclaimSelected)} SOL`
            : summary
              ? `${fmtSol(summary.reclaimSol)} SOL`
              : "—"
        }
        sub={
          totalSelected > 0
            ? "from current selection"
            : summary
              ? "max possible"
              : "scan to populate"
        }
        accent="green"
      />
      <StatCard
        label="Est. Network Fee"
        value="—"
        sub="depends on selection"
        accent="muted"
      />
    </div>
  );
}

// Subscribes to the registry to compute the per-tab aggregate. Same
// reasoning as BurnerStatTiles — keep registry consumption out of
// BurnerBody so CleanerRow doesn't repaint on every publisher tick.
function StickyActionBarWired({
  tab,
  hasScan,
}: {
  tab: CleanerVisibleSection;
  hasScan: boolean;
}) {
  const registry = useBurnSelectionRegistry();
  const aggregate = aggregateForTab(registry, tab);
  return (
    <StickyActionBar tab={tab} hasScan={hasScan} aggregate={aggregate} />
  );
}

function DisconnectedCta({
  onConnect,
  connecting,
}: {
  onConnect: () => void;
  connecting: boolean;
}) {
  return (
    <div className="vl-card px-4 py-8 text-center sm:py-10">
      <div className="mx-auto max-w-sm space-y-3">
        <div className="text-base font-semibold text-white">
          Connect a wallet to begin
        </div>
        <p className="text-sm text-[color:var(--vl-fg-2)]">
          The burner needs Phantom or Solflare to sign close-empty and burn
          transactions. Each burn flow gates the sign button on wallet match,
          a client-side audit, and a destructive-action acknowledgement.
        </p>
        <button
          type="button"
          onClick={onConnect}
          disabled={connecting}
          className="vl-btn vl-btn-primary"
        >
          {connecting ? "Connecting…" : "Connect wallet"}
        </button>
      </div>
    </div>
  );
}

// ── Sticky action bar plumbing ───────────────────────────────────────────

// Maps page-level tabs to the section keys CleanerDetails publishes via
// `data-vl-burn-trigger` AND via `useBurnSelectionPublisher`. The "nfts"
// tab covers two sections (Legacy Metaplex + pNFT) — the bar shows the
// combined count and reclaim across both, and the trigger walks them in
// order so whichever section the user has selections in fires first.
const TAB_TO_SECTIONS: Record<CleanerVisibleSection, BurnSectionKey[]> = {
  nfts: ["legacyNft", "pnft"],
  core: ["core"],
  tokens: ["splBurn"],
  empty: ["closeEmpty"],
  // The "all" tab is unused at the page level (only /groups/[id] uses it);
  // leave empty so dispatch is a no-op in that branch.
  all: [],
};

const TAB_LABEL: Record<CleanerVisibleSection, string> = {
  nfts: "NFT",
  core: "Core asset",
  tokens: "SPL token",
  empty: "empty account",
  all: "item",
};

const TAB_ACTION_VERB: Record<CleanerVisibleSection, string> = {
  nfts: "Burn selected",
  core: "Burn selected",
  tokens: "Burn selected",
  empty: "Close & reclaim",
  all: "Burn selected",
};

interface TabAggregate {
  selectedCount: number;
  reclaimSol: number;
  canBuild: boolean;
  // Section keys (in tab-priority order) that currently have a non-zero
  // selection. The dispatcher fires the FIRST entry on click — which
  // for the NFTs tab means Legacy Metaplex wins ties with pNFT.
  triggerOrder: BurnSectionKey[];
}

// Reduce the per-section registry into a per-tab summary. The bar uses
// the result for its label, count, reclaim line, and disabled state.
function aggregateForTab(
  registry: Partial<Record<BurnSectionKey, import("../groups/[id]/cleaner").BurnSelectionEntry>>,
  tab: CleanerVisibleSection,
): TabAggregate {
  const sectionKeys = TAB_TO_SECTIONS[tab];
  let selectedCount = 0;
  let reclaimSol = 0;
  let anyCanBuild = false;
  const triggerOrder: BurnSectionKey[] = [];
  for (const key of sectionKeys) {
    const entry = registry[key];
    if (!entry) continue;
    selectedCount += entry.selectedCount;
    if (entry.selectedReclaimSol !== null) reclaimSol += entry.selectedReclaimSol;
    if (entry.canBuild) {
      anyCanBuild = true;
      triggerOrder.push(key);
    }
  }
  return { selectedCount, reclaimSol, canBuild: anyCanBuild, triggerOrder };
}

function totalSelectedAcrossSections(
  registry: Partial<Record<BurnSectionKey, import("../groups/[id]/cleaner").BurnSelectionEntry>>,
): number {
  let n = 0;
  for (const key of Object.keys(registry) as BurnSectionKey[]) {
    n += registry[key]?.selectedCount ?? 0;
  }
  return n;
}

function totalReclaimAcrossSections(
  registry: Partial<Record<BurnSectionKey, import("../groups/[id]/cleaner").BurnSelectionEntry>>,
): number {
  let s = 0;
  for (const key of Object.keys(registry) as BurnSectionKey[]) {
    const v = registry[key]?.selectedReclaimSol;
    if (typeof v === "number") s += v;
  }
  return s;
}

// SolRip-inspired sticky bottom action bar. Renders fixed at the bottom
// of the viewport so the primary action is always one click away. The
// data it shows is REAL — every burn section publishes its current
// (selectedCount, selectedReclaimSol, canBuild) into the
// BurnSelectionProvider registry; this bar aggregates per-tab. Click
// dispatches `.click()` to the first section in `triggerOrder` that
// currently has selections — preserving every safety gate (audit, ack,
// wallet match, simulationOk for pNFT/Core, blockhash) because the
// section's own existing handleBuild → preview → BurnSignAndSendBlock
// pipeline runs unchanged.
function StickyActionBar({
  tab,
  hasScan,
  aggregate,
}: {
  tab: CleanerVisibleSection;
  hasScan: boolean;
  aggregate: TabAggregate;
}) {
  const actionVerb = TAB_ACTION_VERB[tab];
  const itemLabel = TAB_LABEL[tab];
  const { selectedCount, reclaimSol, canBuild, triggerOrder } = aggregate;
  // The page-level destructive-ack checkbox was removed (operator
  // request — Phantom's own sign confirmation already requires an
  // explicit click per burn). The remaining gate `canBuild` is what
  // actually matters: it requires a non-empty selection AND the
  // section's own discovery / build pipeline to be ready. Audit /
  // wallet-match / simulation gates still run inside
  // BurnSignAndSendBlock before the wallet ever opens.
  const canFire = canBuild && triggerOrder.length > 0;

  const handleBurn = () => {
    if (typeof document === "undefined") return;
    if (!canFire) return;
    // Fire the first section with selections. For NFTs tab this means
    // Legacy NFTs win ties over pNFT — user can pick the other from
    // the in-section state if needed.
    const key = triggerOrder[0];
    const btn = document.querySelector<HTMLButtonElement>(
      `[data-vl-burn-trigger="${key}"]`,
    );
    if (!btn) return;
    // Scroll the section's card into view first so the inline preview
    // / sign block that the trigger reveals lands on screen.
    const wrap = btn.closest(".vl-burn-card") ?? btn;
    if (wrap instanceof HTMLElement) {
      wrap.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    // Defer the click one frame so the scroll starts before the
    // build/preview render swaps the layout out from under it.
    window.setTimeout(() => {
      if (!btn.disabled) btn.click();
    }, 240);
  };

  const subline = (() => {
    if (!hasScan) return `Scan a wallet to populate ${itemLabel}s.`;
    if (selectedCount === 0) {
      return `Select ${itemLabel}s in the section above to enable.`;
    }
    return `${selectedCount} ${itemLabel}${selectedCount === 1 ? "" : "s"} · +${fmtSol(reclaimSol)} SOL reclaim`;
  })();

  return (
    <div
      role="region"
      aria-label="Burn action bar"
      className="vl-action-bar fixed bottom-3 left-1/2 z-50 flex w-[calc(100%-1.5rem)] max-w-[1080px] -translate-x-1/2 items-center justify-between gap-3 px-4 py-2.5"
    >
      <div className="flex min-w-0 flex-col">
        <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.4px] text-[color:var(--vl-fg-3)]">
          {tab === "all" ? "Burner" : `Active · ${tab.toUpperCase()}`}
        </div>
        <div className="truncate text-[12px] text-[color:var(--vl-fg-2)]">
          {subline}
        </div>
      </div>
      <button
        type="button"
        onClick={handleBurn}
        disabled={!canFire}
        className="vl-btn vl-btn-burn shrink-0"
        aria-label={
          canFire
            ? `${actionVerb} (${selectedCount} item${selectedCount === 1 ? "" : "s"})`
            : `${actionVerb} — disabled, no items selected`
        }
      >
        {actionVerb}
        {selectedCount > 0 && (
          <span className="ml-1 font-mono text-[11px] opacity-90">
            · {selectedCount}
          </span>
        )}
      </button>
    </div>
  );
}
