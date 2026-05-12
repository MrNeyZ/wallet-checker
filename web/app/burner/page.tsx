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

import { useCallback, useEffect, useRef, useState } from "react";
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

type ScanStatus = "idle" | "loading" | "scanned" | "error";

function BurnerBody() {
  const { connected, connecting, connect } = useWallet();
  const [tab, setTab] = useState<CleanerVisibleSection>("nfts");
  const [summary, setSummary] = useState<CleanerRowSummary | null>(null);
  // Lifted from CleanerRow via `onScanStateChange` — drives the page-level
  // scan-progress strip. Real state: "loading" only while a scan request
  // is actually in flight. Not cosmetic.
  const [scanStatus, setScanStatus] = useState<ScanStatus>("idle");
  // Real wall-clock scan duration: stamped when status → loading, computed
  // when status → scanned. Honest measurement, not a faked figure.
  const [scanDurationMs, setScanDurationMs] = useState<number | null>(null);
  const scanStartedAtRef = useRef<number | null>(null);
  // Holds CleanerRow's existing `handleScan` (the same trigger its toolbar
  // Scan/Rescan button uses), exposed up via `registerScanTrigger`. Lets the
  // page offer a "Rescan" without owning or duplicating any scan logic.
  const scanTriggerRef = useRef<(() => void) | null>(null);

  const handleScanStateChange = useCallback((status: ScanStatus) => {
    setScanStatus(status);
    if (status === "loading") {
      scanStartedAtRef.current = Date.now();
      setScanDurationMs(null);
    } else if (status === "scanned" && scanStartedAtRef.current != null) {
      setScanDurationMs(Date.now() - scanStartedAtRef.current);
      scanStartedAtRef.current = null;
    }
  }, []);
  const registerScanTrigger = useCallback((fn: () => void) => {
    scanTriggerRef.current = fn;
  }, []);
  const handleRescan = useCallback(() => {
    scanTriggerRef.current?.();
  }, []);

  // BurnAckProvider is hard-coded `true` (the page-level ack checkbox was
  // removed by operator request); the real safety boundary is the per-section
  // BurnSignAndSendBlock (audit + simulation + wallet-match + sign), untouched.
  //
  // BurnerBody intentionally does NOT subscribe to the burn-selection registry
  // — that would re-render the heavy CleanerRow tree on every selection tick.
  // The registry consumers (BurnerStatTiles / BurnerTabs / StickyActionBarWired)
  // are isolated leaves.

  return (
    <BurnAckProvider value={true}>
    {/* `vl-burner` scopes a perf-trim CSS block in globals.css (strips
        backdrop-blur + heavy shadows from .vl-card/.vl-burn-card/etc. so a
        1000+ NFT wallet doesn't melt the compositor). The width comes from
        the root layout's `.vl-layout` wrapper, which goes full-width per
        the active `data-layout` mode. Composition mirrors the WC v2
        prototype's BurnerPage: a flat stack — scan strip → stat tiles →
        tabs → one content section → action bar. No enclosing workspace
        card, no header band (the prototype has neither). */}
    <div className="vl-burner flex flex-col gap-3">
      {connected ? (
        <>
          {/* 1 — scan strip / scan-complete line (prototype: <ScanStrip>). */}
          <BurnerScanStrip
            status={scanStatus}
            summary={summary}
            durationMs={scanDurationMs}
            onRescan={handleRescan}
          />

          {/* 2 — stat tiles (prototype: .vl-stat-strip of <StatTile>). */}
          <BurnerStatTiles summary={summary} scanning={scanStatus === "loading"} />

          {/* 3 — tabs with per-tab count badges (prototype: .vl-tabstrip
              with .vl-tab .count). Counts come from the real burn-selection
              registry + the scan summary. */}
          <BurnerTabs active={tab} onChange={setTab} summary={summary} />

          {/* slim destructive banner — the prototype puts the danger cue on
              the section card's red top-stripe; our content (CleanerRow)
              uses a neutral .vl-card, so a one-line .vl-warn-strip above it
              carries the "this is destructive" signal. */}
          <div role="note" className="vl-warn-strip">
            <span className="dot" />
            <span>
              <span className="font-semibold text-[#f8a7a7]">destructive</span>
              {" · "}burns are irreversible — audit pass + wallet match
              required before the wallet ever opens.
            </span>
            <span className="ml-auto font-mono text-[11px] text-[color:var(--vl-fg-3)]">
              safety: <span className="font-semibold text-[color:var(--vl-fg)]">strict</span>
            </span>
          </div>

          {/* 4 — single main content section: CleanerRow (its own .vl-card —
              wallet+Scan toolbar + the burn sections). Keyed on the wallet
              only so tab switches don't remount it (which would drop
              discovery + selection state). Bottom padding clears the fixed
              action bar. The internal section-body restructure (the
              prototype's single .vl-burn-card + shared toolbar vs our
              per-section cards) is a later phase. */}
          <div className="pb-[100px]">
            <CleanerRow
              key={connected}
              wallet={{ address: connected, label: null }}
              visibleSection={tab}
              compact
              onSummaryChange={setSummary}
              onScanStateChange={handleScanStateChange}
              registerScanTrigger={registerScanTrigger}
            />
          </div>

          {/* 5 — action bar (prototype: .vl-action-bar, shown only when
              something is staged). */}
          <StickyActionBarWired tab={tab} />
        </>
      ) : (
        <DisconnectedCta onConnect={() => void connect()} connecting={connecting} />
      )}
    </div>
    </BurnAckProvider>
  );
}

// Page-level scan-progress strip — wired to the real scan lifecycle lifted
// from CleanerRow. Mirrors the prototype's <ScanStrip> while a scan is in
// flight (.vl-scan: spinning status + an indeterminate progress bar + the
// six-step pill row) and collapses to a one-line "scan complete" marker
// when done. The production scan is a single call (not the prototype's
// faked stepped interval) so there's no real per-step % — the bar is
// honestly indeterminate, the step row shows the pipeline phases with the
// first marked active. No fake data, no mock results.
const SCAN_STEPS = [
  "RPC accounts",
  "DAS NFTs",
  "pNFT discovery",
  "Core assets",
  "SPL classify",
  "Audit",
] as const;

function BurnerScanStrip({
  status,
  summary,
  durationMs,
  onRescan,
}: {
  status: ScanStatus;
  summary: CleanerRowSummary | null;
  durationMs: number | null;
  onRescan: () => void;
}) {
  if (status === "loading") {
    return (
      <div className="vl-scan">
        <div className="vl-scan-head">
          <span className="status">
            <span className="spin" /> Scanning wallet…
          </span>
          <span className="mono text-[11px] text-[color:var(--vl-fg-3)]">
            on-chain · DAS
          </span>
        </div>
        {/* Honest indeterminate bar — the production scan is a single call,
            it does not stream per-phase progress, so no faked %. */}
        <div className="vl-progress">
          <div className="bar is-indeterminate" />
        </div>
        {/* Step pills are the pipeline phases as labels only — none is
            marked `is-done` (we don't observe real phase completion). The
            first carries `is-active` purely as a "working" cue. */}
        <div className="vl-scan-steps">
          {SCAN_STEPS.map((s, i) => (
            <span key={s} className={`vl-scan-step ${i === 0 ? "is-active" : ""}`}>
              {s}
            </span>
          ))}
        </div>
      </div>
    );
  }
  if (status === "error") {
    return (
      <div className="vl-warn-strip">
        <span className="dot" />
        <span>Scan failed.</span>
        <button
          type="button"
          onClick={onRescan}
          className="vl-btn vl-btn-ghost is-sm ml-auto"
        >
          Rescan
        </button>
      </div>
    );
  }
  if (status === "scanned" || summary) {
    const total =
      summary != null ? summary.nft + summary.fungible + summary.empty : null;
    const dur =
      durationMs != null ? `${(durationMs / 1000).toFixed(1)}s` : null;
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-[color:var(--vl-green)]">
          <span
            className="inline-block h-[7px] w-[7px] shrink-0 rounded-full bg-[color:var(--vl-green)]"
            style={{ boxShadow: "0 0 8px rgba(79,182,125,0.6)" }}
          />
          Scan complete
          {total != null ? ` · ${total.toLocaleString("en-US")} items` : ""}
          {dur ? ` · ${dur}` : ""}
        </span>
        <span className="font-mono text-[11px] text-[color:var(--vl-fg-4)]">·</span>
        <span className="font-mono text-[11px] text-[color:var(--vl-fg-3)]">
          pick a category tab to review burnable assets
        </span>
        <button
          type="button"
          onClick={onRescan}
          className="vl-btn vl-btn-ghost is-sm ml-auto"
        >
          Rescan
        </button>
      </div>
    );
  }
  return (
    <div className="font-mono text-[11px] text-[color:var(--vl-fg-4)]">
      Press{" "}
      <strong className="font-semibold text-[color:var(--vl-fg-2)]">Scan</strong>{" "}
      in the wallet toolbar below to inventory this wallet.
    </div>
  );
}

// Category tabs with per-tab count badges (prototype: .vl-tabstrip with
// `.vl-tab .count`). Counts are real: NFT = legacy + pNFT burnable,
// Core = core burnable, Tokens = SPL burnable (all from the burn-selection
// registry's `totalBurnable`), Empty = the cleanup-scan summary's empty
// count. "…" until a section has reported. Isolated leaf — re-renders on
// registry ticks without disturbing CleanerRow.
function BurnerTabs({
  active,
  onChange,
  summary,
}: {
  active: CleanerVisibleSection;
  onChange: (t: CleanerVisibleSection) => void;
  summary: CleanerRowSummary | null;
}) {
  const reg = useBurnSelectionRegistry();
  const legacy = reg.legacyNft?.totalBurnable ?? null;
  const pnft = reg.pnft?.totalBurnable ?? null;
  const core = reg.core?.totalBurnable ?? null;
  const spl = reg.splBurn?.totalBurnable ?? null;
  const count = (key: CleanerVisibleSection): string => {
    if (key === "nfts")
      return legacy === null && pnft === null
        ? "…"
        : String((legacy ?? 0) + (pnft ?? 0));
    if (key === "core") return core === null ? "…" : String(core);
    if (key === "tokens") return spl === null ? "…" : String(spl);
    if (key === "empty") return summary != null ? String(summary.empty) : "…";
    return "";
  };
  return (
    <nav role="tablist" aria-label="Burn categories" className="vl-tabstrip">
      {TABS.map((t) => {
        const isActive = active === t.key;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(t.key)}
            className={`vl-tab ${isActive ? "is-active" : ""}`}
          >
            {t.label} <span className="count num">{count(t.key)}</span>
          </button>
        );
      })}
    </nav>
  );
}

function StatCard({
  label,
  value,
  sub,
  accent,
  loading,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: "green" | "muted";
  loading?: boolean;
}) {
  // WC v2 `.vl-tile` rendered inside a `.vl-stat-strip` parent — the
  // strip's grid rules place `.vl-section-header` (caption), `.vl-stat-value`
  // (number), and the `.mono` sub-line into a compact one-row layout that
  // collapses to 2x2 on `html[data-layout="phone"]`. Accent → vl-stat-value
  // modifier (`is-purple` preserves the prior reclaim-tile look, `is-muted`
  // for placeholder/dim values). `loading` swaps the value for a `.vl-skel`
  // shimmer (matches the prototype's <StatTile loading>).
  const valMod =
    accent === "green" ? "is-purple" : accent === "muted" ? "is-muted" : "";
  return (
    <div className="vl-tile">
      <div className="vl-section-header">{label}</div>
      {loading ? (
        <div className="vl-skel" style={{ height: 18, width: "62%" }} />
      ) : (
        <div className={`vl-stat-value${valMod ? ` ${valMod}` : ""}`}>{value}</div>
      )}
      {sub && <div className="mono">{sub}</div>}
    </div>
  );
}

// Subscribes to the burn selection registry — re-renders on every
// per-section publish, but stays a leaf so the heavy CleanerRow tree
// in BurnerBody is unaffected.
function BurnerStatTiles({
  summary,
  scanning,
}: {
  summary: CleanerRowSummary | null;
  scanning?: boolean;
}) {
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
    <div className="vl-stat-strip">
      <StatCard
        label="Items Found"
        value={itemsFound !== null ? itemsFound.toLocaleString("en-US") : "—"}
        sub={summary ? itemsBreakdown : scanning ? "scanning…" : "scan to populate"}
        loading={scanning && itemsFound === null}
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
// Renders nothing until the active tab has a non-empty selection
// (prototype: the action bar only appears once items are staged).
function StickyActionBarWired({ tab }: { tab: CleanerVisibleSection }) {
  const registry = useBurnSelectionRegistry();
  const aggregate = aggregateForTab(registry, tab);
  if (aggregate.selectedCount === 0) return null;
  return <StickyActionBar tab={tab} aggregate={aggregate} />;
}

function DisconnectedCta({
  onConnect,
  connecting,
}: {
  onConnect: () => void;
  connecting: boolean;
}) {
  return (
    <div className="vl-card overflow-hidden">
      <div className="vl-empty">
        <div className="icon" aria-hidden>⌬</div>
        <div className="title">Connect a wallet to begin</div>
        <div className="sub">
          The burner needs Phantom or Solflare to sign close-empty and burn
          transactions. Every burn flow gates the sign button on a wallet
          match and a client-side audit.
        </div>
        <button
          type="button"
          onClick={onConnect}
          disabled={connecting}
          className="vl-btn vl-btn-primary is-sm mt-1"
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
  aggregate,
}: {
  tab: CleanerVisibleSection;
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

  // Bar only renders when selectedCount > 0 (StickyActionBarWired gates it),
  // so the subline is always the "staged" form. The build pipeline may not
  // be ready yet (canBuild false → button disabled), but items are staged.
  const subline = `${selectedCount} ${itemLabel}${selectedCount === 1 ? "" : "s"} staged · +${fmtSol(reclaimSol)} SOL reclaim`;

  return (
    <div
      role="region"
      aria-label="Burn action bar"
      className="vl-action-bar fixed bottom-3 left-1/2 z-50 flex w-[calc(100%-1.5rem)] max-w-[1200px] -translate-x-1/2 items-center gap-3 px-4 py-2.5"
    >
      <div className="left">
        <span className="pip" aria-hidden />
        <div className="meta">
          <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.4px] text-[color:var(--vl-fg-3)]">
            Burner · {tab === "all" ? "ALL" : tab.toUpperCase()}
          </div>
          <div className="truncate text-[12px] text-[color:var(--vl-fg-2)]">
            {subline}
          </div>
        </div>
      </div>
      <div className="right">
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
    </div>
  );
}
