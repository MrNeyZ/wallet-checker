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

import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  BurnAckProvider,
  BurnSelectionProvider,
  CleanerRow,
  ScanRegistryProvider,
  WalletProvider,
  useBulkBurnSnapshot,
  useBurnSelectionClearAll,
  useBurnSelectionRegistry,
  useWallet,
  type BurnSectionKey,
  type CleanerRowSummary,
  type CleanerVisibleSection,
} from "../groups/[id]/cleaner";
import { fmtSol } from "@/lib/format";
import { useBulkBurnSession, type BulkBurnMode } from "./useBulkBurnSession";
import { BulkBurnDialog } from "./BulkBurnDialog";
import { useClientLegacyBurnPrototype } from "./useClientLegacyBurnPrototype";
import { ClientLegacyBurnDialog } from "./ClientLegacyBurnDialog";
import { useBurnerMode } from "@/lib/burnerModeContext";

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

  // ── Auto-scan on open ──────────────────────────────────────────────────
  // When the burner opens with a connected wallet, start the cleanup scan
  // automatically — once per connected wallet, for the life of this page.
  // It reuses CleanerRow's own scan trigger (the same one the Scan/Rescan
  // button and `handleRescan` call), exposed up via `registerScanTrigger`;
  // there is NO separate auto-scan code path or API.
  //
  // Guard rails (must not double-scan, must not auto-loop, must not re-fire
  // on React re-renders):
  //  • `autoScannedRef` — a Set of addresses we've already auto-triggered.
  //    Re-renders, burn-registry ticks, the React.StrictMode double-mount,
  //    and every `scanStatus` transition all hit an early return. Connecting
  //    a *different* wallet re-arms it for that new address.
  //  • `scanStatus !== "idle"` → a scan is already loading / done (the user
  //    beat the effect to it, or `scanStatus` is briefly stale from the
  //    previous wallet right after a switch) → skip without arming, so the
  //    next render (once CleanerRow re-reports "idle") can auto-scan.
  //  • `!scanTriggerRef.current` → CleanerRow hasn't registered its trigger
  //    yet (shouldn't happen — child effects commit before this parent
  //    effect — but defensive); leave the address un-armed so a later render
  //    retries. Worst case the user clicks Scan manually.
  const autoScannedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!connected) return;
    if (autoScannedRef.current.has(connected)) return;
    if (scanStatus !== "idle") return;
    const trigger = scanTriggerRef.current;
    if (!trigger) return;
    autoScannedRef.current.add(connected);
    trigger();
  }, [connected, scanStatus]);

  // ── Stale-selection guard on wallet switch ──────────────────────────────
  // Burn-selection sections stay mounted across wallet identity changes
  // (the connected boolean stays truthy when the user switches accounts
  // inside Phantom), so their per-section publisher cleanup never fires
  // and prior wallet's selection entries linger in the registry. Without
  // this guard the sticky action bar can briefly show wallet-A's
  // selection counts while wallet-B's scan is still in flight. The
  // clearAll is a single setState that no-ops when the registry is
  // already empty, so it pays nothing on initial connect.
  const clearBurnSelection = useBurnSelectionClearAll();
  const prevConnectedRef = useRef<string | null>(connected);
  useEffect(() => {
    if (prevConnectedRef.current !== connected) {
      if (prevConnectedRef.current !== null) clearBurnSelection();
      prevConnectedRef.current = connected;
    }
  }, [connected, clearBurnSelection]);

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

          {/* 5b — Bulk Burner (Phase 1 MVP). Renders nothing in resting
              state; the floating "Bulk burn (all)" trigger appears only
              when a cross-category selection exists. The dialog renders
              progress + final summary. The hook owns the full state
              machine; this component just routes UI events into it. The
              existing per-tab Burn N button is intentionally left
              untouched. */}
          <BulkBurnUiWired />

          {/* 5c — Phase B prototype: client-built Legacy NFT burn.
              Renders nothing unless ?proto=1 is in the URL AND the
              user has selected exactly 1 legacy NFT (no other
              categories). Visually distinct (🧪 amber border) so it
              cannot be confused with the production bulk path. The
              shipping per-section + bulk flows are NOT affected. */}
          <ClientLegacyBurnPrototypeWired />
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

// Color palette for the wallet-composition donut + segmented bars in the
// legend. Cyan + amber join the existing site purple + neutral to give
// each kind a distinct hue without leaving the dark-terminal vibe.
const KIND_COLORS = {
  pnft:   "#a890e8", // purple — matches site --vl-purple
  legacy: "#7a7a94", // muted lilac-gray
  core:   "#5fcde4", // cyan
  spl:    "#e8c14a", // amber
} as const;

// Wallet composition donut. Memoized on the four primitive counts so
// it never re-renders during selection toggles / scroll / hover —
// matches the perf rules: SVG only, no libs, no continuous animation.
// Fixed 96 × 96 px viewport. The center "items" total reads as the
// headline number; the four arcs read counter-clockwise from top.
const WalletDonut = memo(function WalletDonut({
  legacy,
  pnft,
  core,
  spl,
}: {
  legacy: number | null;
  pnft:   number | null;
  core:   number | null;
  spl:    number | null;
}) {
  const safe = (n: number | null) => (typeof n === "number" && n > 0 ? n : 0);
  const sLegacy = safe(legacy);
  const sPnft   = safe(pnft);
  const sCore   = safe(core);
  const sSpl    = safe(spl);
  const total = sLegacy + sPnft + sCore + sSpl;
  const r = 42;
  const C = 2 * Math.PI * r;
  // Segment stack: each arc starts where the previous one ended via
  // strokeDashoffset, so the four arcs compose one continuous ring.
  // Order = pNFT (usually biggest), legacy, core, spl — stable so the
  // ring doesn't reshuffle colors when one kind appears/disappears.
  const segs = [
    { k: "pnft",   v: sPnft,   c: KIND_COLORS.pnft   },
    { k: "legacy", v: sLegacy, c: KIND_COLORS.legacy },
    { k: "core",   v: sCore,   c: KIND_COLORS.core   },
    { k: "spl",    v: sSpl,    c: KIND_COLORS.spl    },
  ];
  let accFrac = 0;
  return (
    <svg
      viewBox="0 0 100 100"
      width="96"
      height="96"
      className="vl-burner-donut"
      aria-hidden
    >
      <circle
        cx="50" cy="50" r={r}
        fill="none"
        stroke="rgba(255,255,255,0.05)"
        strokeWidth="7"
      />
      {total > 0 && segs.map((s) => {
        if (s.v <= 0) return null;
        const frac   = s.v / total;
        const arc    = frac * C;
        const offset = -(accFrac * C);
        accFrac += frac;
        return (
          <circle
            key={s.k}
            cx="50" cy="50" r={r}
            fill="none"
            stroke={s.c}
            strokeWidth="7"
            strokeDasharray={`${arc} ${C - arc}`}
            strokeDashoffset={offset}
            strokeLinecap="butt"
            transform="rotate(-90 50 50)"
          />
        );
      })}
      <text
        x="50" y="47.5"
        textAnchor="middle"
        fontSize="16"
        fontFamily="var(--vl-font-mono)"
        fontWeight="700"
        fill="var(--vl-fg)"
        letterSpacing="-0.8"
        style={{ fontFeatureSettings: '"tnum","ss01"' }}
      >
        {total > 0 ? total.toLocaleString("en-US") : "—"}
      </text>
      <text
        x="50" y="59"
        textAnchor="middle"
        fontSize="6.2"
        fontFamily="var(--vl-font-mono)"
        fontWeight="600"
        fill="var(--vl-fg-2)"
        letterSpacing="1.4"
      >
        ITEMS
      </text>
    </svg>
  );
});

// One row in the donut legend: color dot + uppercase label + mini bar +
// count. Width-bound bar uses relative share (count / max-across-kinds)
// so the eye can compare item sizes at a glance. Rendered dim when the
// count is 0 / null so empty kinds recede.
function DonutLegendRow({
  color,
  label,
  count,
  max,
}: {
  color: string;
  label: string;
  count: number | null;
  max:   number;
}) {
  const c = typeof count === "number" ? count : 0;
  const widthPct = max > 0 ? Math.max(2, (c / max) * 100) : 0;
  const isDim = c === 0;
  return (
    <li className={`vl-donut-row${isDim ? " is-dim" : ""}`}>
      <span className="dot" style={{ background: color }} aria-hidden />
      <span className="label">{label}</span>
      <span className="bar" aria-hidden>
        <span
          className="bar-fill"
          style={{ width: `${widthPct}%`, background: color }}
        />
      </span>
      <span className="count">{count === null ? "—" : c.toLocaleString("en-US")}</span>
    </li>
  );
}

function StatCard({
  label,
  value,
  sub,
  accent,
  loading,
  tier = "secondary",
  active = true,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: "green" | "muted";
  loading?: boolean;
  // `primary` = headline metric (larger value font, full opacity).
  // `secondary` = supporting metric (smaller value, slightly muted).
  // Hierarchy lives in CSS via `.vl-burner .vl-tile.is-primary/.is-secondary`.
  tier?: "primary" | "secondary";
  // When false, the tile dims (value color → fg-3, label opacity 0.65).
  // Use for "selected=0", "txs=0" pre-selection states so empty cards
  // visibly recede.
  active?: boolean;
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
  const tierCls = tier === "primary" ? " is-primary" : " is-secondary";
  const activeCls = active ? "" : " is-inactive";
  return (
    <div className={`vl-tile${tierCls}${activeCls}`}>
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

  // Per-section tx-count estimate (Math.ceil(selected / TX_BATCH_SIZE) per
  // kind), summed across all sections. Drives the new "Est. TXs" tile +
  // its sub line. Frontend estimate — the backend's chunker is authoritative
  // at build time; once it surfaces a real count we'll prefer that.
  const txsLegacy = estimateTxsForSection(registry, "legacyNft");
  const txsPnft   = estimateTxsForSection(registry, "pnft");
  const txsCore   = estimateTxsForSection(registry, "core");
  const txsSpl    = estimateTxsForSection(registry, "splBurn");
  const totalTxs  = txsLegacy + txsPnft + txsCore + txsSpl;

  // Routing summary log — fires only when one of the per-type discovery
  // counts actually changes (selection toggles don't move these), so we
  // get one stable line per "discovery completed" event rather than a
  // log spam on every checkbox click. `skipped` is best-effort: the
  // registry doesn't carry per-section non-burnable counts (those live
  // inside each section's local state), so we surface only the four
  // burnable totals here.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    console.log("[burner] routing summary", {
      legacy: legacyBurnable,
      pnft: pnftBurnable,
      core: coreBurnable,
      spl: splBurnable,
      skipped: "see per-section discovery logs",
    });
  }, [legacyBurnable, pnftBurnable, coreBurnable, splBurnable]);

  // Max single-kind count drives the legend's bar widths so the eye can
  // compare relative sizes (vs `count/total` which makes everything tiny
  // when one kind dominates). Falls back to 0 → bars empty.
  const maxKind = Math.max(
    typeof legacyBurnable === "number" ? legacyBurnable : 0,
    typeof pnftBurnable   === "number" ? pnftBurnable   : 0,
    typeof coreBurnable   === "number" ? coreBurnable   : 0,
    typeof splBurnable    === "number" ? splBurnable    : 0,
  );
  const hasReclaimContext =
    totalReclaimSelected > 0 || (summary !== null && summary.reclaimSol > 0);

  return (
    // Two-column dashboard: composition donut on the left, metric strip
    // on the right. On phone the donut stacks above the strip via the
    // `.vl-burner-dash` media rule in globals.css.
    <div className="vl-burner-dash">
      <div className="vl-burner-donut-panel">
        <WalletDonut
          legacy={legacyBurnable}
          pnft={pnftBurnable}
          core={coreBurnable}
          spl={splBurnable}
        />
        <ul className="vl-donut-legend">
          <DonutLegendRow color={KIND_COLORS.pnft}   label="pNFT" count={pnftBurnable}   max={maxKind} />
          <DonutLegendRow color={KIND_COLORS.legacy} label="NFT"  count={legacyBurnable} max={maxKind} />
          <DonutLegendRow color={KIND_COLORS.core}   label="Core" count={coreBurnable}   max={maxKind} />
          <DonutLegendRow color={KIND_COLORS.spl}    label="SPL"  count={splBurnable}    max={maxKind} />
        </ul>
      </div>
      <div className="vl-stat-strip">
        <StatCard
          label="Items Found"
          value={itemsFound !== null ? itemsFound.toLocaleString("en-US") : "—"}
          sub={summary ? itemsBreakdown : scanning ? "scanning…" : "scan to populate"}
          loading={scanning && itemsFound === null}
          tier="primary"
          active={itemsFound !== null && itemsFound > 0}
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
          tier="secondary"
          active={totalSelected > 0}
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
          tier="primary"
          active={hasReclaimContext}
        />
        <StatCard
          label="Est. TXs"
          value={totalTxs > 0 ? totalTxs.toLocaleString("en-US") : "—"}
          sub={
            totalTxs > 0
              // Show the per-kind tx breakdown only when more than one kind
              // contributes — keeps the line short for single-kind burns.
              ? (() => {
                  const parts: string[] = [];
                  if (txsLegacy > 0) parts.push(`${txsLegacy} legacy`);
                  if (txsPnft   > 0) parts.push(`${txsPnft} pNFT`);
                  if (txsCore   > 0) parts.push(`${txsCore} Core`);
                  if (txsSpl    > 0) parts.push(`${txsSpl} SPL`);
                  return parts.length > 1 ? parts.join(" + ") : `auto-split into batches`;
                })()
              // Pre-selection: surface the recommended batch sizes so the
              // operator knows how the chunker carves up large picks. Tone
              // matches the rest of the sub line (mono · muted).
              : "≤6 legacy · ≤3 pNFT · ≤4 Core · ≤8 SPL per tx"
          }
          accent={totalTxs > 0 ? undefined : "muted"}
          tier="secondary"
          active={totalTxs > 0}
        />
      </div>
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
  // "Clear" clears only the section(s) under the ACTIVE tab — matching our
  // per-section selection model. Sections with no per-item selection
  // (closeEmpty) expose no `clearSelection`, so the Clear button is hidden
  // on the Empty tab. Each handler is the section's own stable
  // `setSelected*(new Set())` — the same reset that fires after a
  // successful burn — so this is a safe, no-side-effect operation.
  const clearFns = TAB_TO_SECTIONS[tab]
    .map((k) => registry[k]?.clearSelection)
    .filter((f): f is () => void => typeof f === "function");
  const onClear =
    clearFns.length > 0 ? () => clearFns.forEach((f) => f()) : undefined;
  return <StickyActionBar tab={tab} aggregate={aggregate} onClear={onClear} />;
}

// Phase 1 Bulk Burner wiring. Reads the cross-tab aggregate from the
// burn-selection registry to decide visibility, and the bulk-mints
// snapshot only at click time (passed to the hook). The dialog renders
// progress + summary; the floating button sits ABOVE the sticky action
// bar so it doesn't overlap the per-tab Burn N button.
function BulkBurnUiWired() {
  const { connected } = useWallet();
  const registry = useBurnSelectionRegistry();
  const getMintsSnapshot = useBulkBurnSnapshot();
  // Cross-category total — includes closeEmpty's emptyCount.
  const totalSelected = (Object.values(registry) as Array<
    { selectedCount: number } | undefined
  >).reduce((s, e) => s + (e?.selectedCount ?? 0), 0);
  const includeCloseEmpty = (registry.closeEmpty?.selectedCount ?? 0) > 0;
  // Signing mode — defaults to "safe" so first-time users get the
  // accurate-preview Phantom UX without thinking. Persisted to this
  // component's lifetime only (no localStorage); the user re-picks per
  // session because the trade-off is meaningful.
  //
  // Lifted to the layout-level BurnerModeContext so the persistent
  // bottom-HUD nav can toggle it from outside this component's tree.
  // The inline Safe/Fast pill below stays — both control surfaces
  // drive the same context value.
  const { mode, setMode } = useBurnerMode();
  const session = useBulkBurnSession({
    targetWallet: connected,
    connectedWallet: connected,
    getMintsSnapshot,
    includeCloseEmpty,
    mode,
  });
  const isRunning =
    session.state.status === "running" ||
    session.state.status === "done" ||
    session.state.status === "cancelled" ||
    session.state.status === "failed";
  // Floating UI — visible only when something is selected AND the
  // dialog isn't open. Shows the Safe/Fast toggle inline with the
  // bulk-burn trigger so the user picks the mode at the click point.
  const showButton =
    !isRunning && totalSelected > 0 && session.state.status === "idle";
  return (
    <>
      {showButton && (
        <div className="fixed bottom-[68px] right-4 z-[60] flex flex-col items-end gap-1.5">
          <BulkBurnModeToggle mode={mode} onChange={setMode} />
          <button
            type="button"
            onClick={() => void session.start()}
            aria-label={`Bulk burn (${totalSelected} items across categories, ${mode} mode)`}
            className="vl-btn vl-btn-secondary is-sm shadow-lg"
          >
            Bulk burn · {totalSelected}
          </button>
        </div>
      )}
      <BulkBurnDialog
        state={session.state}
        onCancel={session.cancel}
        onClose={session.reset}
      />
    </>
  );
}

// Small inline Safe/Fast pill. Compact, default safe, no localStorage.
// Tooltip-style description on hover via `title` so the unicode-only
// pill stays out of the way visually.
function BulkBurnModeToggle({
  mode,
  onChange,
}: {
  mode: BulkBurnMode;
  onChange: (m: BulkBurnMode) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Bulk burn signing mode"
      className="flex items-center gap-0 rounded border border-[color:var(--vl-border)] bg-[color:var(--vl-bg-1)] overflow-hidden shadow-md text-[11px]"
    >
      <button
        type="button"
        role="radio"
        aria-checked={mode === "safe"}
        onClick={() => onChange("safe")}
        title="Safe: one approval per transaction. Phantom shows accurate NFT changes."
        className={`px-2.5 py-1 ${
          mode === "safe"
            ? "bg-emerald-900/40 text-emerald-200"
            : "text-[color:var(--vl-fg-3)] hover:text-[color:var(--vl-fg-1)]"
        }`}
      >
        Safe
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={mode === "fast"}
        onClick={() => onChange("fast")}
        title="Fast: one batched approval per window. Phantom may show 0 changes / unsafe warning."
        className={`px-2.5 py-1 border-l border-[color:var(--vl-border)] ${
          mode === "fast"
            ? "bg-red-900/40 text-red-200"
            : "text-[color:var(--vl-fg-3)] hover:text-[color:var(--vl-fg-1)]"
        }`}
      >
        Fast
      </button>
    </div>
  );
}

// ── Phase B prototype wiring ───────────────────────────────────────
// Gate: `?proto=1` in URL AND exactly 1 legacy NFT selected AND nothing
// else selected (no pNFT / Core / SPL / closeEmpty). Renders an amber
// experimental button + dialog. The hook builds the BurnV1 ix in the
// browser using @metaplex-foundation/mpl-token-metadata and never
// decodes a backend-built transactionBase64. The shipping bulk and
// per-section flows are unaffected — this component is parallel.
function ClientLegacyBurnPrototypeWired() {
  const { connected } = useWallet();
  const registry = useBurnSelectionRegistry();
  const getMintsSnapshot = useBulkBurnSnapshot();
  const [open, setOpen] = useState(false);

  // ?proto=1 detection — read on every render so flipping the flag
  // mid-session takes effect without a hard refresh. window is only
  // available in the browser (this page is "use client").
  const protoEnabled =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("proto") === "1";

  // Selection gate: exactly 1 legacy, 0 of everything else.
  const counts = {
    closeEmpty: registry.closeEmpty?.selectedCount ?? 0,
    splBurn: registry.splBurn?.selectedCount ?? 0,
    legacyNft: registry.legacyNft?.selectedCount ?? 0,
    pnft: registry.pnft?.selectedCount ?? 0,
    core: registry.core?.selectedCount ?? 0,
  };
  const gatePassed =
    protoEnabled &&
    counts.legacyNft === 1 &&
    counts.closeEmpty === 0 &&
    counts.splBurn === 0 &&
    counts.pnft === 0 &&
    counts.core === 0;

  // Read the single legacy mint from the bulk-burn snapshot. The
  // snapshot is ref-backed and updated by useBulkBurnMintsPublisher in
  // each section; reading it on demand here is cheap.
  const snapshot = gatePassed ? getMintsSnapshot() : {};
  const targetMint = gatePassed ? snapshot.legacyNft?.[0] ?? null : null;

  const proto = useClientLegacyBurnPrototype({
    connectedWallet: connected,
    targetMint,
  });

  // Auto-close + reset when the user dismisses, only when not mid-run.
  const handleClose = () => {
    setOpen(false);
    proto.reset();
  };
  const handleStart = () => {
    void proto.start();
  };

  if (!protoEnabled) return null;

  return (
    <>
      {gatePassed && targetMint && !open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed bottom-[120px] right-4 z-[60] vl-btn vl-btn-ghost is-sm shadow-lg border-2 border-amber-500/60 bg-amber-900/30"
          aria-label="Experimental client-built legacy burn"
        >
          🧪 Client-built legacy burn
        </button>
      )}
      {open && (
        <ClientLegacyBurnDialog
          state={proto.state}
          onStart={handleStart}
          onClose={handleClose}
        />
      )}
    </>
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

// Rough per-tx capacity by burn kind — drives the "Est. TXs" headline and
// the small "≤ N per tx" recommendation. Numbers come from the existing
// builder's bounded-by-Solana-1232-byte-tx-size constraint:
//   • Legacy Metaplex BurnV1 — ~6 mints per tx (smallest instruction set)
//   • pNFT BurnV1            — ~3 mints per tx (token-record + auth-rules
//                              accounts swell the message)
//   • Metaplex Core BurnV1   — ~4 assets per tx
//   • SPL burn-and-close     — ~8 mints per tx (burn ix + close ix per mint)
//   • Empty-account close    — ~20 accounts per tx (close ix only)
// These are *frontend display* estimates. The backend's chunker is the
// source of truth at build time; once we expose a real per-build count
// it'll replace this map. Until then, the values match the operator's
// observed per-tx capacity.
const TX_BATCH_SIZE: Record<BurnSectionKey, number> = {
  legacyNft:  6,
  pnft:       3,
  core:       4,
  splBurn:    8,
  closeEmpty: 20,
};

// Compute a per-section estimated tx count from a registry entry's
// `selectedCount`. Returns 0 when no selection (or no entry). Caller
// sums across the relevant keys (per-tab or global).
function estimateTxsForSection(
  registry: Partial<Record<BurnSectionKey, import("../groups/[id]/cleaner").BurnSelectionEntry>>,
  key: BurnSectionKey,
): number {
  const entry = registry[key];
  if (!entry || entry.selectedCount === 0) return 0;
  return Math.ceil(entry.selectedCount / TX_BATCH_SIZE[key]);
}

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
  onClear,
}: {
  tab: CleanerVisibleSection;
  aggregate: TabAggregate;
  // Clears the active tab's selection; undefined for tabs whose section
  // has no per-item selection (Empty) — the Clear button is then hidden.
  onClear?: () => void;
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
    // Only scroll if the section's card is COMPLETELY offscreen.
    // Earlier `r.top >= 8 && r.top <= vh - 80` was a TOP-only check —
    // it treated a tall card whose header had scrolled off as "not in
    // view" and forcibly scrolled the page back up to the header.
    // That's the actual scroll-jump the operator sees: they scroll
    // down through the NFT grid (which lives inside the card), click
    // Burn Selected, and the page snaps to the section start. Switch
    // to a strict overlap geometry: ANY pixel of the card inside the
    // viewport counts as "in view" and skips the scroll entirely.
    // This matches the operator's expectation that staying inside the
    // section preserves position exactly.
    const wrap = btn.closest(".vl-burn-card") ?? btn;
    let willScroll = false;
    if (wrap instanceof HTMLElement) {
      const r = wrap.getBoundingClientRect();
      const vh = window.innerHeight || document.documentElement.clientHeight;
      // Card overlaps viewport whenever its bottom hasn't scrolled
      // above the top AND its top hasn't scrolled past the bottom.
      const overlapsViewport = r.bottom > 0 && r.top < vh;
      if (!overlapsViewport) {
        wrap.scrollIntoView({ behavior: "smooth", block: "start" });
        willScroll = true;
      }
    }
    // When we scrolled, defer the click ~240 ms so the smooth scroll
    // starts before the build/preview render swaps layout under it.
    // When we didn't scroll, fire immediately — but capture scrollY
    // first and restore it across the React re-render. Restoration
    // pattern: double `requestAnimationFrame` (waits for React's
    // commit + browser paint) then a setTimeout(50) mop-up for any
    // async layout follow-up (Server Action latency repaint,
    // transition-pending → ready re-render). All three are idempotent
    // — they only call scrollTo if the page actually drifted off the
    // captured scrollY. Covers the two non-scrollIntoView causes of a
    // jump:
    //   • document shrinks when an existing preview unmounts on a
    //     retry click → browser clamps scrollY down to new max.
    //   • DOM mutation triggers scroll-anchor adjustment.
    // Both restores are skipped in the scrolled path so the smooth
    // scroll-into-view animation isn't cancelled mid-flight.
    const fire = () => {
      if (!btn.disabled) btn.click();
    };
    if (willScroll) {
      window.setTimeout(fire, 240);
    } else {
      const prevY = window.scrollY;
      fire();
      const restore = () => {
        if (Math.abs(window.scrollY - prevY) > 1) {
          window.scrollTo({ top: prevY, behavior: "auto" });
        }
      };
      requestAnimationFrame(() => {
        requestAnimationFrame(restore);
      });
      window.setTimeout(restore, 50);
    }
  };

  // Bar only renders when selectedCount > 0 (StickyActionBarWired gates it),
  // so the subline is always the "staged" form. The build pipeline may not
  // be ready yet (canBuild false → button disabled), but items are staged.
  //
  // Tx-count estimate: TabAggregate only carries the SUM across sections,
  // not per-section counts. For single-section tabs (Core / Tokens /
  // Empty) the math is exact. For the NFTs tab (legacy + pnft) we don't
  // know the per-kind split, so we use the SMALLEST batch size in the
  // tab as a conservative upper bound — the displayed "est N tx" then
  // reads as "at most N transactions", which is the honest answer when
  // the split isn't known.
  const batchSizesForTab = TAB_TO_SECTIONS[tab].map((k) => TX_BATCH_SIZE[k]);
  const conservativeBatchSize = batchSizesForTab.length === 0
    ? Infinity
    : Math.min(...batchSizesForTab);
  const estTxs = conservativeBatchSize === Infinity || selectedCount === 0
    ? 0
    : Math.ceil(selectedCount / conservativeBatchSize);
  const txTail = estTxs > 0 ? ` · est ${estTxs} tx${estTxs === 1 ? "" : "s"}` : "";
  const subline = `${selectedCount} ${itemLabel}${selectedCount === 1 ? "" : "s"} staged · +${fmtSol(reclaimSol)} SOL reclaim${txTail}`;

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
        {onClear && (
          <button
            type="button"
            onClick={onClear}
            className="vl-btn vl-btn-ghost is-sm shrink-0"
            aria-label={`Clear ${itemLabel} selection`}
          >
            Clear
          </button>
        )}
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
