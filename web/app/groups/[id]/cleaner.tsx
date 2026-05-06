"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { api } from "@/lib/api";
import type {
  BuildBurnAndCloseTxResult,
  BuildCloseEmptyTxResult,
  BuildCoreBurnTxResult,
  BuildLegacyNftBurnTxResult,
  BuildPnftBurnTxResult,
  BurnCandidate,
  BurnCandidatesResult,
  CleanupScanResult,
  CoreBurnIncludedEntry,
  CoreBurnSkippedEntry,
  GroupCleanupScanAllResult,
  LegacyNftBurnIncludedEntry,
  LegacyNftBurnSkippedEntry,
  PnftBurnIncludedEntry,
  PnftBurnSkippedEntry,
  ScannedTokenAccount,
} from "@/lib/api";
import { fmtNumber, fmtSol, shortAddr } from "@/lib/format";
import {
  buildBurnAndCloseTxAction,
  buildCloseEmptyTxAction,
  buildCoreBurnTxAction,
  buildLegacyNftBurnTxAction,
  buildPnftBurnTxAction,
  scanCleanupAction,
} from "../actions";
import { Badge } from "@/ui-kit/components/Badge";
import { WalletLink } from "@/ui-kit/components/WalletLink";
import { btnPrimary, btnSecondary } from "@/lib/buttonStyles";
import { prettifyApiError } from "@/lib/prettifyError";
import { proxyImageUrl } from "@/lib/imageProxy";
import {
  auditBurnAndCloseTx,
  auditCloseEmptyTx,
  auditCoreBurnTx,
  auditLegacyNftBurnTx,
  decodeBase64Transaction,
  getProvider,
  solscanTxUrl,
  type BurnAuditResult,
  type CoreBurnAuditResult,
  type InstructionAuditResult,
  type LegacyNftAuditResult,
} from "@/lib/wallet";
import { getConnection } from "@/lib/solana";

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

type ScanState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "scanned"; scan: CleanupScanResult; burn: BurnCandidatesResult }
  | { status: "error"; error: string };

interface WalletEntry {
  address: string;
  label: string | null;
}

interface WalletCtx {
  connected: string | null; // base58 pubkey, null if not connected
  connecting: boolean;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
}
const WalletContext = createContext<WalletCtx | null>(null);

export function useWallet(): WalletCtx {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used within WalletProvider");
  return ctx;
}

// Compact-mode context — set to `true` only inside /burner (the standalone
// page that owns the SolRip-style sticky bottom action bar). When true,
// each burn section hides its own inline "Burn selected" button and
// instead renders a hidden trigger element with `data-vl-burn-trigger`
// that the page-level sticky bar dispatches `.click()` to. The /groups/
// [id]?tab=cleaner view never enters this provider, so its existing
// inline button layout is byte-for-byte preserved.
const CompactModeCtx = createContext(false);
function useCompactMode(): boolean {
  return useContext(CompactModeCtx);
}

// Page-level destructive acknowledgement. Owned by /burner's sticky
// action bar — once the user ticks the persistent "I understand burns
// are irreversible" checkbox there, this context publishes `true` to
// every BurnSignAndSendBlock inside the page so they can skip their own
// in-section ack checkbox UI and auto-fire sign on build-success.
//
// `false` outside the standalone /burner page (the default), so the
// original /groups/[id]?tab=cleaner view continues to require its own
// per-section ack checkbox before the inline sign button enables.
const BurnAckCtx = createContext(false);
export function BurnAckProvider({
  value,
  children,
}: {
  value: boolean;
  children: ReactNode;
}) {
  return <BurnAckCtx.Provider value={value}>{children}</BurnAckCtx.Provider>;
}
function useBurnAck(): boolean {
  return useContext(BurnAckCtx);
}

// ── Burn selection registry ───────────────────────────────────────────────
// Each burn section publishes its current selection state (count, reclaim
// estimate, build readiness) into this registry. The page-level sticky
// action bar reads the registry, aggregates per-tab, and renders the
// real "X selected · Y SOL" summary plus an enabled/disabled CTA.
//
// Trigger contract: every section also exposes a stable `data-vl-burn-trigger`
// data attribute on its (hidden-when-compact) inline build button. The
// sticky bar still dispatches `.click()` against that DOM target — which
// keeps the build/sign/audit/safety pipeline running through the
// section's own `handleBuild` → `BurnSignAndSendBlock` path with no
// logic lift.
export type BurnSectionKey =
  | "splBurn"
  | "legacyNft"
  | "pnft"
  | "core"
  | "closeEmpty";

export interface BurnSelectionEntry {
  // Stable section identifier; doubles as the value of the section's
  // `data-vl-burn-trigger` attribute used for click dispatch.
  sectionKey: BurnSectionKey;
  // 0 means "no items selected" (or for closeEmpty: "no empty accounts
  // exist"). The sticky bar uses this to disable + render copy.
  selectedCount: number;
  // Best-effort reclaim estimate for the current selection in SOL.
  // null when the section can't surface a per-selection number yet
  // (e.g. mid-loading); the bar then shows "—" instead of "0".
  selectedReclaimSol: number | null;
  // True iff the section's build button is enabled right now (typically
  // selectedCount > 0 AND no in-flight build). Sticky bar mirrors this
  // into its disabled state.
  canBuild: boolean;
  // Total burnable items the section currently exposes in its UI grid
  // (NOT raw scan totals — already filtered to what the user can click
  // to burn). null when the section hasn't finished discovery yet so
  // the page-level Items Found tile can show "—" instead of underreporting.
  totalBurnable: number | null;
}

interface BurnSelectionRegistryCtx {
  registry: Partial<Record<BurnSectionKey, BurnSelectionEntry>>;
  publish: (key: BurnSectionKey, entry: BurnSelectionEntry | null) => void;
}
const BurnSelectionCtx = createContext<BurnSelectionRegistryCtx | null>(null);

export function BurnSelectionProvider({ children }: { children: ReactNode }) {
  const [registry, setRegistry] = useState<
    Partial<Record<BurnSectionKey, BurnSelectionEntry>>
  >({});
  const publish = useCallback(
    (key: BurnSectionKey, entry: BurnSelectionEntry | null) => {
      setRegistry((prev) => {
        const cur = prev[key];
        // Skip the no-op state update if nothing actually changed —
        // prevents a publish-driven render loop when a section's
        // useEffect re-fires with structurally-equal data.
        if (entry === null && !cur) return prev;
        if (
          cur &&
          entry &&
          cur.selectedCount === entry.selectedCount &&
          cur.selectedReclaimSol === entry.selectedReclaimSol &&
          cur.canBuild === entry.canBuild &&
          cur.totalBurnable === entry.totalBurnable
        ) {
          return prev;
        }
        const next = { ...prev };
        if (entry === null) delete next[key];
        else next[key] = entry;
        return next;
      });
    },
    [],
  );
  const value = useMemo(() => ({ registry, publish }), [registry, publish]);
  return (
    <BurnSelectionCtx.Provider value={value}>{children}</BurnSelectionCtx.Provider>
  );
}

// Reader hook — returns the full registry. The page-level sticky bar
// uses this to aggregate across whatever tab is active. Returns an empty
// registry when no provider is mounted (e.g. the default /groups/[id]
// view), which keeps callers safe.
export function useBurnSelectionRegistry(): Partial<
  Record<BurnSectionKey, BurnSelectionEntry>
> {
  const ctx = useContext(BurnSelectionCtx);
  return ctx?.registry ?? {};
}

// Publisher hook — each burn section calls this with its current state.
// No-op when no provider is mounted, so existing /groups/[id] callers
// pay zero cost. The publish on unmount clears the registry entry so a
// section that's been unmounted (e.g. via tab-not-yet-visited lazy
// pattern) doesn't leave stale data behind.
function useBurnSelectionPublisher(
  key: BurnSectionKey,
  selectedCount: number,
  selectedReclaimSol: number | null,
  canBuild: boolean,
  totalBurnable: number | null = null,
): void {
  const ctx = useContext(BurnSelectionCtx);
  // Stringify so a fresh-object render with structurally-equal values
  // doesn't trigger a redundant publish.
  const stableKey = `${selectedCount}:${selectedReclaimSol ?? "null"}:${canBuild ? 1 : 0}:${totalBurnable ?? "null"}`;
  useEffect(() => {
    if (!ctx) return;
    ctx.publish(key, {
      sectionKey: key,
      selectedCount,
      selectedReclaimSol,
      canBuild,
      totalBurnable,
    });
    return () => ctx.publish(key, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, key, stableKey]);
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [connected, setConnected] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Subscribe to provider events so external disconnects/account swaps update
  // our state.
  useEffect(() => {
    const provider = getProvider();
    if (!provider?.on) return;
    const onConnect = (...args: unknown[]) => {
      const pk = args[0] as { toBase58?: () => string } | undefined;
      if (pk?.toBase58) setConnected(pk.toBase58());
    };
    const onDisconnect = () => setConnected(null);
    const onAccountChanged = (...args: unknown[]) => {
      const pk = args[0] as { toBase58?: () => string } | null | undefined;
      setConnected(pk?.toBase58 ? pk.toBase58() : null);
    };
    provider.on("connect", onConnect);
    provider.on("disconnect", onDisconnect);
    provider.on("accountChanged", onAccountChanged);
    return () => {
      provider.off?.("connect", onConnect);
      provider.off?.("disconnect", onDisconnect);
      provider.off?.("accountChanged", onAccountChanged);
    };
  }, []);

  // Try silent reconnect for previously-trusted sessions.
  //
  // React strict-mode (next.config.mjs has `reactStrictMode: true`) runs
  // effects twice in dev. Without a guard, two parallel silent
  // `connect({ onlyIfTrusted: true })` calls race against Phantom's
  // single-flight connect handler, producing noisy logs and the
  // occasional dropped `connect` event. The `didRunRef` short-circuits
  // the second strict-mode invocation; the `cancelled` flag guards
  // against a late `.then` resolving after unmount and writing into a
  // stale state setter.
  const silentConnectDidRunRef = useRef(false);
  useEffect(() => {
    if (silentConnectDidRunRef.current) return;
    silentConnectDidRunRef.current = true;
    const provider = getProvider();
    if (!provider) return;
    let cancelled = false;
    provider
      .connect({ onlyIfTrusted: true })
      .then((res) => {
        if (cancelled) return;
        setConnected(res.publicKey.toBase58());
      })
      .catch(() => {
        /* not previously authorized — leave disconnected */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const connect = useCallback(async () => {
    const provider = getProvider();
    if (!provider) {
      setError(
        "No Solana wallet detected. Install Phantom or Solflare and reload.",
      );
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      const res = await provider.connect();
      setConnected(res.publicKey.toBase58());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connect failed");
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    const provider = getProvider();
    if (provider) {
      try {
        await provider.disconnect();
      } catch {
        /* ignore */
      }
    }
    setConnected(null);
  }, []);

  const value = useMemo(
    () => ({ connected, connecting, error, connect, disconnect }),
    [connected, connecting, error, connect, disconnect],
  );
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function WalletConnectBar() {
  const w = useWallet();
  return (
    // Slim wallet pill row — same VL surface but tighter padding so the
    // "wallet selected" state reads as one compact line instead of a
    // chunky banner. Helper copy lives in the page-level disconnected
    // CTA, not here.
    <div className="vl-card flex flex-wrap items-center gap-2 px-3 py-1.5 text-xs">
      <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.4px] text-[color:var(--vl-fg-3)]">
        Wallet
      </span>
      {w.connected ? (
        <>
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-[color:var(--vl-green)] shadow-[0_0_6px_var(--vl-green)]" />
          <span className="font-mono text-[11px] text-[color:var(--vl-fg)]">
            {shortAddr(w.connected, 6, 6)}
          </span>
          <button
            type="button"
            onClick={() => void w.disconnect()}
            className="ml-auto rounded-md border border-[color:var(--vl-border)] bg-transparent px-2.5 py-1 text-[11px] font-semibold text-[color:var(--vl-fg-2)] transition-all duration-[var(--vl-motion,180ms)] hover:border-[var(--vl-border-h)] hover:text-[color:var(--vl-fg)]"
          >
            Disconnect
          </button>
        </>
      ) : (
        <>
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-[color:var(--vl-fg-4)]" />
          <span className="text-[color:var(--vl-fg-3)]">Not connected</span>
          <button
            type="button"
            onClick={() => void w.connect()}
            disabled={w.connecting}
            className="vl-btn vl-btn-primary ml-auto !px-3 !py-1.5 !text-[11px]"
          >
            {w.connecting ? "Connecting…" : "Connect wallet"}
          </button>
        </>
      )}
      {w.error && (
        <span className="ml-1 text-[color:var(--vl-red)]">{w.error}</span>
      )}
    </div>
  );
}

// Per-wallet scan summary surfaced from each CleanerRow up to the section so
// the group-level overview tile can aggregate totals. Key = wallet address.
interface ScanSummary {
  empty: number;
  reclaimSol: number;
  fungible: number;
  nft: number;
}
interface ScanRegistryCtx {
  scans: Record<string, ScanSummary>;
  setScan: (address: string, summary: ScanSummary) => void;
}
const ScanRegistryContext = createContext<ScanRegistryCtx | null>(null);
function useScanRegistry(): ScanRegistryCtx {
  const ctx = useContext(ScanRegistryContext);
  if (!ctx) throw new Error("ScanRegistryContext missing");
  return ctx;
}

export function ScanRegistryProvider({ children }: { children: React.ReactNode }) {
  const [scans, setScans] = useState<Record<string, ScanSummary>>({});
  const setScan = useCallback((address: string, summary: ScanSummary) => {
    setScans((prev) => ({ ...prev, [address]: summary }));
  }, []);
  const value = useMemo(() => ({ scans, setScan }), [scans, setScan]);
  return <ScanRegistryContext.Provider value={value}>{children}</ScanRegistryContext.Provider>;
}

// ============================================================================
// "Scan all" / "Clean all" orchestrator
// ----------------------------------------------------------------------------
// Drives sequential scan/clean across every wallet in the group while leaving
// each individual sign-and-send to the user (one Phantom popup per wallet).
// Cancellation flows through a ref so the running async loop can poll it on
// every iteration without re-rendering or stale closures.
// ============================================================================

interface ScanFailure {
  wallet: string;
  label: string | null;
  error: string;
}

interface ScanAllCounts {
  ok: number;
  cached: number;
  timeout: number;
  rateLimited: number;
  error: number;
}

type ScanAllState =
  | { status: "idle" }
  | {
      status: "running";
      completed: number;
      total: number;
      etaSeconds: number | null;
      // First wallet in the queue — purely advisory copy for the user.
      // Per-wallet progress isn't streamed back from the batch endpoint,
      // so this stays static for the duration of the call.
      activeAddress: string | null;
      failed: ScanFailure[];
    }
  | {
      status: "done";
      total: number;
      succeeded: number;
      failed: ScanFailure[];
      counts: ScanAllCounts;
      cancelled: boolean;
    };

interface CleanResult {
  wallet: string;
  label: string | null;
  outcome:
    | "success"
    | "skipped-mismatch"
    | "skipped-no-empty"
    | "skipped-cancel"
    | "error";
  signature?: string;
  error?: string;
}

type CleanAllState =
  | { status: "idle" }
  | {
      status: "running";
      idx: number;
      total: number;
      currentWallet: string;
      currentLabel: string | null;
      step: "building" | "signing" | "rescanning";
      results: CleanResult[];
    }
  | { status: "done"; results: CleanResult[]; cancelled: boolean };

const DELAY_BETWEEN_WALLETS_MS = 200;

// Scan-all is now a single backend batch call. The browser fires it
// through the cancellable Next.js proxy at
// `POST /web-api/groups/:id/cleanup-scan-all`, which forwards
// `request.signal` into the upstream Express endpoint at
// `POST /api/groups/:id/cleanup-scan-all`. All retry / queue /
// per-wallet timeout policy lives server-side.

function GroupAllActions({
  groupId,
  wallets,
}: {
  groupId: string;
  wallets: WalletEntry[];
}) {
  const { scans, setScan } = useScanRegistry();
  const w = useWallet();
  const [scanAll, setScanAll] = useState<ScanAllState>({ status: "idle" });
  const [cleanAll, setCleanAll] = useState<CleanAllState>({ status: "idle" });
  // Mutable cancel flag — async loops poll this on each iteration so cancel
  // takes effect without React state churn or stale closure captures.
  const cancelRef = useRef(false);
  // AbortController for the current scan-all HTTP request. Storing the
  // controller in a ref lets the cancel button tear down the underlying
  // fetch (which causes the Express backend's `req.on("close")` handler
  // to abort the in-progress wallet scan instead of running every
  // remaining wallet to completion).
  const scanAllAbortRef = useRef<AbortController | null>(null);

  const isScanning = scanAll.status === "running";
  const isCleaning = cleanAll.status === "running";
  const busy = isScanning || isCleaning;

  const allScanned = wallets.every((wlt) => scans[wlt.address] !== undefined);
  const candidates = wallets.filter(
    (wlt) => (scans[wlt.address]?.empty ?? 0) > 0,
  );
  // Per spec, signing must stay manual and per-wallet. The connected Phantom
  // account can only sign for its own pubkey, so wallets in the group whose
  // address doesn't match the connected one will be skipped this run. The
  // user can switch accounts in their wallet extension and click Clean all
  // again to handle the remaining wallets.
  const matchable = w.connected
    ? candidates.filter((wlt) => wlt.address === w.connected)
    : [];

  async function runScanAll(opts: { force?: boolean } = {}) {
    cancelRef.current = false;
    // Tear down any prior in-flight controller before issuing a new one
    // so a rapid second click never leaves an orphan request running in
    // the background.
    scanAllAbortRef.current?.abort();
    scanAllAbortRef.current = new AbortController();
    const total = wallets.length;
    // Single backend call. The scan-all action is a Next.js server action
    // (no client-side AbortController hook) so cancelling can't actually
    // tear down the in-flight server request — but the user-facing
    // experience only requires the UI to break out of "Scanning…" state
    // immediately. We set cancelled state in cancel() the moment the user
    // clicks the button; the post-await handler then merges any successful
    // wallet results into the scan registry (per spec: "Keep already
    // completed wallet results") without overwriting the cancelled state.
    setScanAll({
      status: "running",
      completed: 0,
      total,
      etaSeconds: null,
      failed: [],
      activeAddress: wallets[0]?.address ?? null,
    });
    // Same-origin proxy → Express. Calling fetch directly (instead of via
    // the prior `scanGroupCleanupAllAction` server action) is what lets
    // `scanAllAbortRef.current.abort()` actually tear down the underlying
    // connection: the proxy forwards `req.signal` to the upstream fetch,
    // and Express's `req.on("close")` aborts the in-progress wallet scan.
    const controller = scanAllAbortRef.current;
    let res:
      | { ok: true; result: GroupCleanupScanAllResult }
      | { ok: false; error: string };
    try {
      const httpRes = await fetch(
        // /web-api (not /api) — see web/app/web-api/.../route.ts header
        // comment for the nginx routing rationale. /api/* in production
        // forwards directly to Express, which would skip the
        // AbortSignal-forwarding proxy entirely.
        `/web-api/groups/${encodeURIComponent(groupId)}/cleanup-scan-all`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ force: opts.force ?? false }),
          signal: controller?.signal,
          cache: "no-store",
        },
      );
      if (!httpRes.ok) {
        const text = await httpRes.text().catch(() => "");
        res = { ok: false, error: text || `HTTP ${httpRes.status}` };
      } else {
        res = {
          ok: true,
          result: (await httpRes.json()) as GroupCleanupScanAllResult,
        };
      }
    } catch (err) {
      // AbortError from the user clicking Cancel — cancel() has already
      // flipped the UI to the cancelled "done" state, so just exit. Do
      // NOT fall through to the error branch below.
      if (
        (err as Error)?.name === "AbortError" ||
        controller?.signal.aborted ||
        cancelRef.current
      ) {
        return;
      }
      res = {
        ok: false,
        error: err instanceof Error ? err.message : "Group scan failed",
      };
    }
    if (cancelRef.current) {
      // User cancelled mid-flight — UI state was already set to cancelled
      // in cancel(). Hydrate the scan registry with any successful results
      // so completed wallets aren't lost; do NOT overwrite scanAll state.
      if (res.ok) {
        for (const w of res.result.wallets) {
          if (w.scan && w.burn && (w.status === "ok" || w.status === "cached")) {
            setScan(w.address, {
              empty: w.scan.emptyTokenAccounts.length,
              reclaimSol: w.scan.totals.estimatedReclaimSol,
              fungible: w.burn.count,
              nft: w.scan.nftTokenAccounts.length,
            });
          }
        }
      }
      return;
    }
    if (!res.ok) {
      setScanAll({
        status: "done",
        total,
        succeeded: 0,
        failed: wallets.map((w) => ({
          wallet: w.address,
          label: w.label,
          error: prettifyApiError(res.error),
        })),
        counts: { ok: 0, cached: 0, timeout: 0, rateLimited: 0, error: total },
        cancelled: false,
      });
      return;
    }
    // Success — push every successful wallet's result into the scan
    // registry so the per-wallet rows below pick up totals immediately.
    const failed: ScanFailure[] = [];
    let succeeded = 0;
    for (const w of res.result.wallets) {
      if (w.scan && w.burn && (w.status === "ok" || w.status === "cached")) {
        setScan(w.address, {
          empty: w.scan.emptyTokenAccounts.length,
          reclaimSol: w.scan.totals.estimatedReclaimSol,
          fungible: w.burn.count,
          nft: w.scan.nftTokenAccounts.length,
        });
        succeeded++;
      } else {
        failed.push({
          wallet: w.address,
          label: w.label,
          error: prettifyApiError(
            w.error ??
              (w.status === "timeout"
                ? "Per-wallet 45s budget exceeded"
                : "Scan failed"),
          ),
        });
      }
    }
    setScanAll({
      status: "done",
      total,
      succeeded,
      failed,
      counts: {
        ok: res.result.counts.ok,
        cached: res.result.counts.cached,
        timeout: res.result.counts.timeout,
        rateLimited: res.result.counts.rateLimited,
        error: res.result.counts.error,
      },
      cancelled: false,
    });
  }

  async function runCleanAll() {
    cancelRef.current = false;
    const targets = wallets.filter(
      (wlt) => (scans[wlt.address]?.empty ?? 0) > 0,
    );
    const results: CleanResult[] = [];
    const provider = getProvider();

    for (let i = 0; i < targets.length; i++) {
      if (cancelRef.current) {
        // Mark the rest as user-cancelled so the result list explains why.
        for (let j = i; j < targets.length; j++) {
          results.push({
            wallet: targets[j].address,
            label: targets[j].label,
            outcome: "skipped-cancel",
          });
        }
        break;
      }

      const wlt = targets[i];

      // Connected wallet must match the wallet being cleaned. Skipping is
      // safer than auto-prompting an account switch — the user can re-run
      // after switching wallets in their extension.
      if (!w.connected || w.connected !== wlt.address) {
        results.push({
          wallet: wlt.address,
          label: wlt.label,
          outcome: "skipped-mismatch",
          error: !w.connected
            ? "No wallet connected"
            : `Connected wallet is ${shortAddr(w.connected, 4, 4)}, not ${shortAddr(wlt.address, 4, 4)}`,
        });
        continue;
      }

      setCleanAll({
        status: "running",
        idx: i + 1,
        total: targets.length,
        currentWallet: wlt.address,
        currentLabel: wlt.label,
        step: "building",
        results: [...results],
      });

      const built = await buildCloseEmptyTxAction(wlt.address);
      if (!built.ok) {
        results.push({
          wallet: wlt.address,
          label: wlt.label,
          outcome: "error",
          error: built.error,
        });
        continue;
      }
      const tx = built.result;
      if (tx.transactionBase64 === null || tx.includedAccounts.length === 0) {
        results.push({
          wallet: wlt.address,
          label: wlt.label,
          outcome: "skipped-no-empty",
        });
        continue;
      }
      const audit = auditCloseEmptyTx(tx.transactionBase64);
      if (!audit.ok) {
        results.push({
          wallet: wlt.address,
          label: wlt.label,
          outcome: "error",
          error: `Audit failed: ${audit.reason ?? "unknown"}`,
        });
        continue;
      }

      setCleanAll({
        status: "running",
        idx: i + 1,
        total: targets.length,
        currentWallet: wlt.address,
        currentLabel: wlt.label,
        step: "signing",
        results: [...results],
      });

      if (!provider) {
        results.push({
          wallet: wlt.address,
          label: wlt.label,
          outcome: "error",
          error: "Wallet provider unavailable",
        });
        continue;
      }
      try {
        const decoded = decodeBase64Transaction(tx.transactionBase64);
        const sent = await provider.signAndSendTransaction(decoded);
        results.push({
          wallet: wlt.address,
          label: wlt.label,
          outcome: "success",
          signature: sent.signature,
        });

        setCleanAll({
          status: "running",
          idx: i + 1,
          total: targets.length,
          currentWallet: wlt.address,
          currentLabel: wlt.label,
          step: "rescanning",
          results: [...results],
        });
        const rescan = await scanCleanupAction(wlt.address);
        if (rescan.ok) {
          setScan(wlt.address, {
            empty: rescan.scan.emptyTokenAccounts.length,
            reclaimSol: rescan.scan.totals.estimatedReclaimSol,
            fungible: rescan.burn.count,
            nft: rescan.scan.nftTokenAccounts.length,
          });
        }
      } catch (err) {
        results.push({
          wallet: wlt.address,
          label: wlt.label,
          outcome: "error",
          error: prettifyWalletError(err),
        });
        // On rejection / failure, continue to the next wallet rather than
        // aborting — the user may want to skip just this one.
      }

      if (i < targets.length - 1) await sleep(DELAY_BETWEEN_WALLETS_MS);
    }

    setCleanAll({
      status: "done",
      results,
      cancelled: cancelRef.current,
    });
  }

  function cancel() {
    cancelRef.current = true;
    // Abort the underlying scan-all HTTP request. The Express backend
    // listens for `req.on("close")` and tears down the in-progress
    // wallet scan + retry backoff — so the user-perceived cancel
    // actually frees the queue instead of waiting for the remaining
    // wallets to finish.
    scanAllAbortRef.current?.abort();
    scanAllAbortRef.current = null;
    // Snap the UI out of "running" state immediately. The backend scan-all
    // call may still resolve later — the post-await handler in runScanAll
    // detects the cancelled flag and skips the state overwrite (it merges
    // any completed wallets into the scan registry instead).
    setScanAll((prev) => {
      if (prev.status !== "running") return prev;
      return {
        status: "done",
        total: prev.total,
        succeeded: 0,
        failed: [],
        counts: { ok: 0, cached: 0, timeout: 0, rateLimited: 0, error: 0 },
        cancelled: true,
      };
    });
    // Clean-all is a per-wallet frontend loop that polls cancelRef on each
    // iteration, so it self-terminates — but still flush the running state
    // here so the UI doesn't have to wait for the in-flight wallet's tx
    // round-trip to finish before it visibly stops.
    setCleanAll((prev) => {
      if (prev.status !== "running") return prev;
      return {
        status: "done",
        results: prev.results ?? [],
        cancelled: true,
      };
    });
  }

  // ---- render ----
  return (
    <div className="border-t border-[color:var(--vl-border)] bg-[rgba(0,0,0,0.22)]">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => void runScanAll()}
          disabled={busy}
          title="Scan every wallet in this group. Cached results (within 10 min) return instantly."
          className={signSendButtonClass(
            isScanning ? "loading" : busy ? "blocked" : "idle",
          )}
        >
          {isScanning ? (
            <>
              <Spinner /> Scanning {wallets.length} wallet
              {wallets.length === 1 ? "" : "s"}…
            </>
          ) : (
            "Scan all wallets"
          )}
        </button>
        <button
          type="button"
          onClick={() => void runScanAll({ force: true })}
          disabled={busy}
          title="Bypass server-side cache and re-scan every wallet from scratch."
          className={signSendButtonClass(busy ? "blocked" : "secondary")}
        >
          Force rescan
        </button>
        <button
          type="button"
          onClick={() => void runCleanAll()}
          disabled={busy || !allScanned || candidates.length === 0}
          title={
            !allScanned
              ? "Scan all wallets first"
              : candidates.length === 0
              ? "No wallets have closeable empty accounts"
              : matchable.length === 0
              ? "Connected wallet does not match any candidate; only matching wallets will be cleaned this run"
              : undefined
          }
          className={signSendButtonClass(
            isCleaning
              ? "loading"
              : busy || !allScanned || candidates.length === 0
              ? "blocked"
              : "idle",
          )}
        >
          {isCleaning ? (
            <>
              <Spinner /> Cleaning {cleanAll.status === "running" ? cleanAll.idx : 0} /{" "}
              {cleanAll.status === "running" ? cleanAll.total : 0}
            </>
          ) : (
            `Clean all wallets${candidates.length > 0 ? ` (${candidates.length})` : ""}`
          )}
        </button>
        {busy && (
          <button
            type="button"
            onClick={cancel}
            className={signSendButtonClass("secondary")}
          >
            Cancel
          </button>
        )}
        {!busy && allScanned && candidates.length > 0 && w.connected && matchable.length < candidates.length && (
          <span className="text-[11px] text-amber-300">
            Only {matchable.length} / {candidates.length} candidates match the
            connected wallet. Switch accounts in your wallet to clean the rest.
          </span>
        )}
      </div>

      {isScanning && scanAll.status === "running" && (
        <ScanAllProgress state={scanAll} />
      )}

      {isCleaning && cleanAll.status === "running" && (
        <div className="border-t border-[color:var(--vl-border)] bg-[rgba(168,144,232,0.04)] px-3 py-1.5 text-[11px] text-[color:var(--vl-fg-2)]">
          {cleanAll.step === "building" && "Building close tx for"}
          {cleanAll.step === "signing" && "Awaiting wallet signature for"}
          {cleanAll.step === "rescanning" && "Rescanning"}{" "}
          {cleanAll.currentLabel ? (
            <span className="font-semibold text-white">{cleanAll.currentLabel}</span>
          ) : (
            <span className="font-mono">
              {shortAddr(cleanAll.currentWallet, 4, 4)}
            </span>
          )}{" "}
          ({cleanAll.idx} / {cleanAll.total})
        </div>
      )}

      {scanAll.status === "done" && (
        <div className="border-t border-[color:var(--vl-border)] bg-[rgba(168,144,232,0.04)] px-3 py-1.5 text-[11px]">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-neutral-300">
            {scanAll.cancelled ? (
              // When cancelled the counts are 0/unknown (the backend may
              // still finish but we no longer wait for the result). The
              // scan registry still holds any per-wallet results that
              // landed before / after cancel, so completed scans aren't
              // lost — they just aren't counted in this header.
              <span className="font-semibold text-amber-300">
                Scan cancelled
                <span className="ml-1 text-neutral-500">
                  · already-scanned wallets are kept
                </span>
              </span>
            ) : (
              <>
                <span>
                  Scan all:{" "}
                  <span className="font-semibold text-white">
                    {scanAll.succeeded}
                  </span>{" "}
                  ok
                  {scanAll.counts.cached > 0 && (
                    <span className="ml-1 text-emerald-300/80">
                      ({scanAll.counts.cached} cached)
                    </span>
                  )}
                  ,{" "}
                  <span
                    className={
                      scanAll.failed.length > 0
                        ? "font-semibold text-red-300"
                        : "text-neutral-400"
                    }
                  >
                    {scanAll.failed.length}
                  </span>{" "}
                  failed
                </span>
                {scanAll.counts.timeout > 0 && (
                  <span className="text-amber-300">
                    · {scanAll.counts.timeout} timed out
                  </span>
                )}
                {scanAll.counts.rateLimited > 0 && (
                  <span className="text-amber-300">
                    · {scanAll.counts.rateLimited} rate-limited
                  </span>
                )}
              </>
            )}
          </div>
          {scanAll.failed.length > 0 && (
            <ul className="mt-1 list-inside list-disc space-y-0.5 text-red-400">
              {scanAll.failed.map((f) => (
                <li key={f.wallet}>
                  <span className="font-mono">{shortAddr(f.wallet, 4, 4)}</span>
                  : {f.error}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {cleanAll.status === "done" && (
        <CleanAllResults results={cleanAll.results} cancelled={cleanAll.cancelled} />
      )}
    </div>
  );
}

function CleanAllResults({
  results,
  cancelled,
}: {
  results: CleanResult[];
  cancelled: boolean;
}) {
  const counts = results.reduce(
    (acc, r) => {
      acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
      return acc;
    },
    {} as Record<CleanResult["outcome"], number>,
  );
  return (
    <div className="border-t border-[color:var(--vl-border)] bg-[rgba(168,144,232,0.04)] px-3 py-1.5 text-[11px]">
      <div className="text-neutral-300">
        Clean all done:
        <span className="ml-1 text-emerald-300">
          {counts.success ?? 0} success
        </span>
        {(counts["skipped-mismatch"] ?? 0) > 0 && (
          <span className="ml-1 text-amber-300">
            · {counts["skipped-mismatch"]} skipped (wallet mismatch)
          </span>
        )}
        {(counts["skipped-no-empty"] ?? 0) > 0 && (
          <span className="ml-1 text-neutral-500">
            · {counts["skipped-no-empty"]} skipped (no empty)
          </span>
        )}
        {(counts["skipped-cancel"] ?? 0) > 0 && (
          <span className="ml-1 text-neutral-500">
            · {counts["skipped-cancel"]} cancelled
          </span>
        )}
        {(counts.error ?? 0) > 0 && (
          <span className="ml-1 text-red-400">· {counts.error} error</span>
        )}
        {cancelled && <span className="ml-1 text-neutral-400">· (cancelled)</span>}
      </div>
      <ul className="mt-1 space-y-0.5">
        {results.map((r) => (
          <li key={r.wallet} className="flex flex-wrap items-baseline gap-1.5">
            <span className="font-mono text-neutral-300">
              {r.label ?? shortAddr(r.wallet, 4, 4)}
            </span>
            {r.outcome === "success" && r.signature ? (
              <>
                <span className="text-emerald-300">✓ sent</span>
                <a
                  href={solscanTxUrl(r.signature)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-semibold text-violet-300 hover:text-violet-200"
                >
                  {shortAddr(r.signature, 6, 6)} ↗
                </a>
              </>
            ) : r.outcome === "skipped-mismatch" ? (
              <span className="text-amber-300">
                ⤳ skipped (wallet mismatch)
                {r.error && <span className="ml-1 text-amber-200/70">— {r.error}</span>}
              </span>
            ) : r.outcome === "skipped-no-empty" ? (
              <span className="text-neutral-500">⤳ skipped (no empty)</span>
            ) : r.outcome === "skipped-cancel" ? (
              <span className="text-neutral-500">⤳ skipped (cancelled)</span>
            ) : (
              <span className="text-red-400">
                ✕ {r.error ?? "error"}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function GroupCleanerSummary({
  groupId,
  wallets,
}: {
  groupId: string;
  wallets: WalletEntry[];
}) {
  const totalWallets = wallets.length;
  const { scans } = useScanRegistry();
  const entries = Object.values(scans);
  const scanned = entries.length;
  const totals = entries.reduce(
    (acc, s) => ({
      empty: acc.empty + s.empty,
      reclaim: acc.reclaim + s.reclaimSol,
      fungible: acc.fungible + s.fungible,
      nft: acc.nft + s.nft,
    }),
    { empty: 0, reclaim: 0, fungible: 0, nft: 0 },
  );
  const dimWhenZero = scanned === 0;
  const tiles: { label: string; value: React.ReactNode; tone?: "ok" }[] = [
    {
      label: "Wallets scanned",
      value: (
        <>
          {scanned}
          <span className="ml-1 text-[11px] font-normal text-neutral-500">
            / {totalWallets}
          </span>
        </>
      ),
    },
    { label: "Empty accounts", value: dimWhenZero ? "—" : totals.empty },
    {
      label: "Gross reclaim",
      value: dimWhenZero ? (
        "—"
      ) : (
        <span className="text-emerald-300">{fmtSol(totals.reclaim)} SOL</span>
      ),
    },
    { label: "Burn candidates", value: dimWhenZero ? "—" : totals.fungible },
    { label: "NFTs", value: dimWhenZero ? "—" : totals.nft },
  ];
  return (
    <div className="vl-card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[color:var(--vl-border)] px-3 py-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--vl-fg-3)]">
          Group cleaner overview
        </span>
        <span className="inline-flex items-center gap-2">
          {scanned < totalWallets && (
            <span className="text-[11px] text-[color:var(--vl-fg-3)]">
              {totalWallets - scanned} wallet
              {totalWallets - scanned === 1 ? "" : "s"} not scanned yet
            </span>
          )}
          <button
            type="button"
            onClick={() => exportCleanerOverviewCsv(wallets, scans)}
            disabled={scanned === 0}
            title={
              scanned === 0
                ? "Scan at least one wallet first"
                : "Download scanned wallets as CSV"
            }
            aria-label="Export cleaner overview as CSV"
            className="rounded border border-[color:var(--vl-border)] bg-transparent px-2 py-0.5 text-[10px] font-semibold text-[color:var(--vl-fg-2)] transition-all duration-[var(--vl-motion,180ms)] hover:border-[rgba(79,182,125,0.50)] hover:bg-[rgba(79,182,125,0.08)] hover:text-[color:var(--vl-green)] disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-[color:var(--vl-border)] disabled:hover:bg-transparent disabled:hover:text-[color:var(--vl-fg-2)]"
          >
            Export CSV ↓
          </button>
        </span>
      </div>
      {/* 5-up tile strip — darker tiles inside the panel so the panel
          header reads above them. Pixel borders provided by the gap-px
          on the parent grid + the inset background. */}
      <div className="vl-card-inset grid grid-cols-2 gap-px sm:grid-cols-5">
        {tiles.map((t) => (
          <div key={t.label} className="bg-transparent px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--vl-fg-3)]">
              {t.label}
            </div>
            <div className="mt-0.5 text-sm font-bold tabular-nums text-white">
              {t.value}
            </div>
          </div>
        ))}
      </div>
      <GroupAllActions groupId={groupId} wallets={wallets} />
    </div>
  );
}

export function CleanerSection({
  groupId,
  wallets,
}: {
  groupId: string;
  wallets: WalletEntry[];
}) {
  if (wallets.length === 0) {
    return (
      <div className="vl-card p-6 text-center text-sm text-[color:var(--vl-fg-3)]">
        Add a wallet to this group first (Settings tab) to run cleanup scans.
      </div>
    );
  }
  return (
    <WalletProvider>
      <ScanRegistryProvider>
        <div className="space-y-3">
          <div className="vl-card p-3 text-xs text-[color:var(--vl-fg-2)]">
            <span className="font-semibold text-white">Wallet Cleaner</span>
            <span className="ml-2 text-[color:var(--vl-fg-3)]">
              Scans report empty SPL token accounts (rent reclaimable) and burn
              candidates (SPL, Legacy NFT, pNFT, Core). Connect a wallet to
              build a preview, then sign to execute. Every burn requires a
              destructive-action acknowledgement before the sign button enables.
            </span>
          </div>
          <WalletConnectBar />
          <GroupCleanerSummary groupId={groupId} wallets={wallets} />
          {wallets.map((w) => (
            <CleanerRow key={w.address} wallet={w} />
          ))}
        </div>
      </ScanRegistryProvider>
    </WalletProvider>
  );
}

type BuildState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; result: BuildCloseEmptyTxResult }
  | { status: "error"; error: string };

// "Clean wallet fully" auto-loop state. Each iteration is a full
// build → audit → sign → wait-cache → rescan cycle for one wallet.
type FullCleanState =
  | { status: "idle" }
  | {
      status: "running";
      batch: number;
      expectedBatches: number;
      remainingEmpty: number;
      step: "building" | "signing" | "waiting-cache" | "rescanning";
      waitSecondsLeft?: number;
      lastSignature?: string;
    }
  | { status: "done"; batches: number; signatures: string[] }
  | { status: "error"; batches: number; error: string; signatures: string[] }
  | { status: "cancelled"; batches: number; signatures: string[] };

// Confirmation polling for the full-clean loop. After the close tx is
// broadcast, the instruction is in flight but may not have landed at
// 'confirmed' commitment yet. We poll the cleanup-scan endpoint with
// ?refresh=true (which bypasses the 10-minute cache) up to N times,
// sleeping between attempts, until the scanned empty count drops. If
// it never drops inside the budget, we proceed with the latest result
// anyway — the next build call will return transactionBase64=null and
// the loop terminates
// cleanly. Hard cap keeps the loop responsive (matches Solana's typical
// 1–2 s confirmation time with margin).
const CONFIRM_POLL_INTERVAL_MS = 1_000;
const CONFIRM_POLL_MAX_ATTEMPTS = 8; // ≤ 8 s wall-clock worst case
// Mirrors the backend MAX_CLOSE_IX_PER_TX. Used to estimate batch count
// for progress display ("Closing batch K / N").
const MAX_CLOSE_IX_PER_TX = 10;

// `visibleSection` filters which destructive sub-section renders inside
// CleanerDetails. Used by the standalone `/burner` page to render one
// burn category at a time (NFTs / Core / Tokens / Empty) under tabs.
// Default `'all'` keeps `/groups/[id]?tab=cleaner` rendering every
// section, so existing callers stay byte-for-byte unchanged.
//
// `compact` collapses the per-wallet header strip (wallet label / stats /
// scan-buttons) to a slim wallet-+-rescan row so the page-level chrome
// (stat cards, tabs, toolbar) can own those affordances.
//
// `onSummaryChange` lifts the per-wallet scan summary up to the parent
// (used by /burner to populate its top-level stat cards). Optional;
// existing callers don't need to wire it.
export type CleanerVisibleSection = "all" | "tokens" | "nfts" | "core" | "empty";
export interface CleanerRowSummary {
  empty: number;
  reclaimSol: number;
  fungible: number;
  nft: number;
}

export function CleanerRow({
  wallet,
  visibleSection = "all",
  compact = false,
  onSummaryChange,
}: {
  wallet: WalletEntry;
  visibleSection?: CleanerVisibleSection;
  compact?: boolean;
  onSummaryChange?: (s: CleanerRowSummary | null) => void;
}) {
  const [state, setState] = useState<ScanState>({ status: "idle" });
  const [showDetails, setShowDetails] = useState(false);
  const [pending, startTransition] = useTransition();
  const [buildState, setBuildState] = useState<BuildState>({ status: "idle" });
  const [buildPending, startBuildTransition] = useTransition();
  // Tracks the most recent successful send so post-send rescans can show
  // a different empty-state message ("Wallet cleaned: …") and skip auto-build.
  const [lastSentSig, setLastSentSig] = useState<string | null>(null);
  // Push per-wallet scan results up to the section so the group overview
  // tile can aggregate. Updates on every successful (re)scan.
  const { setScan } = useScanRegistry();
  const w = useWallet();

  // Auto-loop "Clean wallet fully" state. Runs build → sign → wait-cache →
  // rescan repeatedly until empty=0 or an error/cancel occurs. Cancel is
  // signalled through a ref so the running async loop can poll it on every
  // step without React closure churn.
  const [fullClean, setFullClean] = useState<FullCleanState>({ status: "idle" });
  const fullCleanCancelRef = useRef(false);
  const isFullCleaning = fullClean.status === "running";

  // AbortController + scanRunId for the wallet's cleanup scan.
  // - controller.abort() actually tears down the upstream HTTP fetch via
  //   the same-origin /web-api/wallet/[address]/cleanup-scan proxy, which
  //   forwards request.signal into the Express backend. Without this the
  //   Cancel button stopped only the UI; the backend kept walking the
  //   wallet on RPC.
  // - scanRunId guards against a stale response landing into setState
  //   AFTER the user has already cancelled or kicked off a fresh scan.
  //   Each scan increments runId; the in-flight handler closes over its
  //   own snapshot and bails if it doesn't match the live ref.
  const scanAbortRef = useRef<AbortController | null>(null);
  const scanRunIdRef = useRef(0);

  const handleScan = useCallback(() => {
    // Tear down any in-flight scan before kicking off a new one — protects
    // against a double-click hammering both the proxy and the backend.
    scanAbortRef.current?.abort();
    const controller = new AbortController();
    scanAbortRef.current = controller;
    const myRunId = ++scanRunIdRef.current;

    setState({ status: "loading" });
    setBuildState({ status: "idle" });
    startTransition(async () => {
      try {
        const httpRes = await fetch(
          `/web-api/wallet/${encodeURIComponent(wallet.address)}/cleanup-scan`,
          { method: "GET", cache: "no-store", signal: controller.signal },
        );
        // 499 = client-closed (we aborted). Any other non-2xx is a real
        // backend error worth surfacing.
        if (httpRes.status === 499) return;
        if (!httpRes.ok) {
          if (myRunId !== scanRunIdRef.current) return;
          const detail = await httpRes.text().catch(() => "");
          setState({
            status: "error",
            error: `Backend ${httpRes.status}: ${detail.slice(0, 300)}`,
          });
          return;
        }
        const res = (await httpRes.json()) as {
          scan: CleanupScanResult;
          burn: BurnCandidatesResult;
        };
        if (myRunId !== scanRunIdRef.current) return;
        setState({ status: "scanned", scan: res.scan, burn: res.burn });
        setShowDetails(true);
        setScan(wallet.address, {
          empty: res.scan.emptyTokenAccounts.length,
          reclaimSol: res.scan.totals.estimatedReclaimSol,
          fungible: res.burn.count,
          nft: res.scan.nftTokenAccounts.length,
        });
      } catch (err) {
        if (
          (err as Error)?.name === "AbortError" ||
          controller.signal.aborted
        ) {
          // Cancel handler already reset the UI state.
          return;
        }
        if (myRunId !== scanRunIdRef.current) return;
        setState({
          status: "error",
          error: err instanceof Error ? err.message : "Scan failed",
        });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet.address]);

  // Cancel the current cleanup scan. Bumps scanRunId so any late-landing
  // response is dropped, aborts the in-flight fetch (which propagates to
  // the backend via /web-api/wallet/[address]/cleanup-scan), and snaps the UI
  // back to "idle" so the Scan button re-appears immediately.
  const cancelScan = useCallback(() => {
    if (!scanAbortRef.current) return;
    console.log(`[burner] scan aborted client ${wallet.address}`);
    scanRunIdRef.current++;
    scanAbortRef.current.abort();
    scanAbortRef.current = null;
    setState({ status: "idle" });
  }, [wallet.address]);

  function handleBuildTx() {
    setBuildState({ status: "loading" });
    startBuildTransition(async () => {
      const res = await buildCloseEmptyTxAction(wallet.address);
      if (res.ok) setBuildState({ status: "ready", result: res.result });
      else setBuildState({ status: "error", error: res.error });
    });
  }

  async function runFullClean() {
    if (state.status !== "scanned") return;
    if (state.scan.emptyTokenAccounts.length === 0) return;
    fullCleanCancelRef.current = false;
    // Hide the standalone "Build close transaction" preview while the loop
    // owns the build/sign cycle. Otherwise the user sees a stale preview
    // from a manual build alongside the auto-loop progress.
    setBuildState({ status: "idle" });

    // Snapshot the wallet under cleanup at loop start. The user can switch
    // accounts in their browser wallet mid-loop, which would mutate
    // `w.connected` between iterations; comparing every check against this
    // frozen value (rather than the live ref) prevents partially-completed
    // loops from being silently retargeted at a different wallet.
    const expectedWallet = wallet.address;

    const initialEmpty = state.scan.emptyTokenAccounts.length;
    const expectedBatches = Math.ceil(initialEmpty / MAX_CLOSE_IX_PER_TX);
    let remainingEmpty = initialEmpty;
    let batch = 0;
    const signatures: string[] = [];

    const fail = (error: string) =>
      setFullClean({ status: "error", batches: batch, error, signatures: [...signatures] });
    const cancelExit = () =>
      setFullClean({ status: "cancelled", batches: batch, signatures: [...signatures] });

    while (remainingEmpty > 0) {
      if (fullCleanCancelRef.current) return cancelExit();
      batch++;

      // 1. BUILD
      setFullClean({
        status: "running",
        batch,
        expectedBatches: Math.max(expectedBatches, batch),
        remainingEmpty,
        step: "building",
      });
      const built = await buildCloseEmptyTxAction(expectedWallet);
      if (!built.ok) return fail(built.error);
      const tx = built.result;
      if (tx.transactionBase64 === null || tx.includedAccounts.length === 0) {
        // Build returned no closeable accounts — wallet is clean.
        setFullClean({ status: "done", batches: batch - 1, signatures: [...signatures] });
        return;
      }
      // Defence-in-depth: builder must produce a tx for the same wallet we
      // started with. Catches any backend bug or middleware swap before the
      // user is asked to sign.
      if (tx.requiresSignatureFrom !== expectedWallet) {
        return fail(
          `Built tx wallet mismatch: expected ${shortAddr(expectedWallet, 4, 4)}, got ${shortAddr(tx.requiresSignatureFrom, 4, 4)}`,
        );
      }

      // 2. AUDIT — same whitelist the manual Sign & send button uses.
      const audit = auditCloseEmptyTx(tx.transactionBase64);
      if (!audit.ok) return fail(`Audit failed: ${audit.reason ?? "unknown"}`);

      // 3. WALLET CHECK — compare live connection to the snapshot, NOT to
      //    the (also live) wallet.address prop, so a mid-loop account
      //    switch fails clean instead of silently retargeting.
      if (w.connected !== expectedWallet) {
        return fail(
          w.connected
            ? `Connected wallet ${shortAddr(w.connected, 4, 4)} does not match ${shortAddr(expectedWallet, 4, 4)}`
            : "No wallet connected. Connect the wallet being cleaned and retry.",
        );
      }
      const provider = getProvider();
      if (!provider) return fail("No wallet provider available.");

      // 4. SIGN
      setFullClean({
        status: "running",
        batch,
        expectedBatches: Math.max(expectedBatches, batch),
        remainingEmpty,
        step: "signing",
      });
      let signature: string;
      try {
        const decoded = decodeBase64Transaction(tx.transactionBase64);
        // Sign locally + broadcast through OUR RPC (same pattern as
        // BurnSignAndSendBlock). Bypasses Phantom's bundled RPC, which
        // intermittently returns 403 on the shared Helius tier and used
        // to leave this loop stuck on signAndSendTransaction. The
        // existing scan-polling below is the confirmation source of
        // truth — no separate getSignatureStatuses loop needed here.
        const signed = await provider.signTransaction(decoded);
        signature = await getConnection().sendRawTransaction(
          signed.serialize(),
          {
            skipPreflight: false,
            preflightCommitment: "confirmed",
            maxRetries: 5,
          },
        );
      } catch (err) {
        return fail(prettifyWalletError(err));
      }
      signatures.push(signature);
      setLastSentSig(signature);

      // 5. CONFIRM + RESCAN — poll the scan endpoint with ?refresh=true to
      //    bypass the 10-minute cache. Repeat until the empty count drops below
      //    the pre-sign value (= the close has confirmed at 'confirmed'
      //    commitment) or the attempt budget is exhausted. With Solana
      //    typically confirming in 1–2 s this usually exits on the first
      //    or second attempt; the budget is just defensive.
      let rescanResult: Awaited<ReturnType<typeof scanCleanupAction>> | null = null;
      for (let attempt = 1; attempt <= CONFIRM_POLL_MAX_ATTEMPTS; attempt++) {
        if (fullCleanCancelRef.current) return cancelExit();
        setFullClean({
          status: "running",
          batch,
          expectedBatches: Math.max(expectedBatches, batch),
          remainingEmpty,
          step: attempt === 1 ? "rescanning" : "waiting-cache",
          waitSecondsLeft: attempt === 1
            ? undefined
            : Math.max(0, CONFIRM_POLL_MAX_ATTEMPTS - attempt + 1),
          lastSignature: signature,
        });
        rescanResult = await scanCleanupAction(expectedWallet, { refresh: true });
        if (!rescanResult.ok) break;
        const newEmpty = rescanResult.scan.emptyTokenAccounts.length;
        if (newEmpty < remainingEmpty) {
          // Close has landed and is reflected on-chain.
          break;
        }
        if (attempt < CONFIRM_POLL_MAX_ATTEMPTS) {
          await sleep(CONFIRM_POLL_INTERVAL_MS);
        }
      }
      if (!rescanResult || !rescanResult.ok) {
        return fail(
          rescanResult ? rescanResult.error : "Rescan failed after close",
        );
      }

      setState({ status: "scanned", scan: rescanResult.scan, burn: rescanResult.burn });
      setScan(expectedWallet, {
        empty: rescanResult.scan.emptyTokenAccounts.length,
        reclaimSol: rescanResult.scan.totals.estimatedReclaimSol,
        fungible: rescanResult.burn.count,
        nft: rescanResult.scan.nftTokenAccounts.length,
      });
      remainingEmpty = rescanResult.scan.emptyTokenAccounts.length;
      // Loop back to BUILD if there are still empties; otherwise fall out.
    }

    setFullClean({ status: "done", batches: batch, signatures: [...signatures] });
  }

  function cancelFullClean() {
    fullCleanCancelRef.current = true;
  }

  const summary = useMemo(
    () =>
      state.status === "scanned"
        ? {
            empty: state.scan.emptyTokenAccounts.length,
            reclaimSol: state.scan.totals.estimatedReclaimSol,
            fungible: state.burn.count,
            nft: state.scan.nftTokenAccounts.length,
          }
        : null,
    [state],
  );

  // Lift the per-wallet summary so a parent (e.g. the standalone /burner
  // page) can populate its top-level "Items Found / Reclaim" stat cards
  // without duplicating the scan request. No-op when `onSummaryChange`
  // isn't passed.
  useEffect(() => {
    if (onSummaryChange) onSummaryChange(summary);
  }, [summary, onSummaryChange]);

  return (
    <div className="vl-card overflow-hidden">
      {/* Compact mode (standalone /burner): single-row toolbar — wallet
          short address on the left, Scan/Rescan on the right. No
          12-col grid, no per-wallet stats columns (page owns those).
          Default mode (/groups/[id]?tab=cleaner) keeps the original
          desktop 12-col layout with stats + button cluster. */}
      <div
        className={
          compact
            ? "flex flex-wrap items-center gap-2 px-3 py-1.5"
            : "flex flex-col gap-3 px-3 py-2 md:grid md:grid-cols-12 md:items-center"
        }
      >
        <div className={compact ? "min-w-0" : "min-w-0 md:col-span-3"}>
          {wallet.label ? (
            <div className="truncate text-sm font-semibold text-white">{wallet.label}</div>
          ) : null}
          <WalletLink address={wallet.address} chars={6} className="text-xs" />
        </div>

        {/* Per-wallet stats columns — suppressed in compact mode (page
            owns the top-level stat cards). */}
        {!compact && (
        <div className="grid grid-cols-4 gap-2 md:contents">
          <div className="md:col-span-2 md:text-right">
            <div className="text-[10px] uppercase tracking-wider text-[color:var(--vl-fg-3)]">Empty</div>
            <div className="text-sm font-bold tabular-nums text-white">
              {summary ? summary.empty : "—"}
            </div>
          </div>
          <div className="md:col-span-2 md:text-right">
            <div className="text-[10px] uppercase tracking-wider text-[color:var(--vl-fg-3)]">Reclaim SOL</div>
            <div className="text-sm font-bold tabular-nums text-[color:var(--vl-green)]">
              {summary ? fmtSol(summary.reclaimSol) : "—"}
            </div>
          </div>
          <div className="md:col-span-2 md:text-right">
            <div className="text-[10px] uppercase tracking-wider text-neutral-400">Burn cand.</div>
            <div className="text-sm font-bold tabular-nums text-white">
              {summary ? summary.fungible : "—"}
            </div>
          </div>
          <div className="md:col-span-1 md:text-right">
            <div className="text-[10px] uppercase tracking-wider text-neutral-400">NFTs</div>
            <div className="text-sm font-bold tabular-nums text-white">
              {summary ? summary.nft : "—"}
            </div>
          </div>
        </div>
        )}

        <div
          className={
            compact
              ? "ml-auto flex flex-wrap items-center gap-2"
              : "flex flex-wrap gap-2 md:col-span-2 md:justify-end"
          }
        >
          <button
            type="button"
            onClick={handleScan}
            disabled={pending || isFullCleaning}
            className={
              compact
                ? "rounded-md border border-[color:var(--vl-border)] bg-transparent px-3 py-1 text-[11px] font-semibold text-[color:var(--vl-fg)] transition-all duration-[var(--vl-motion,180ms)] hover:border-[var(--vl-purple)] hover:bg-[rgba(168,144,232,0.08)] hover:text-[color:var(--vl-purple-2)] disabled:opacity-50"
                : btnPrimary
            }
          >
            {state.status === "loading" || pending ? "Scanning…" : state.status === "scanned" ? "Rescan" : "Scan"}
          </button>
          {/* Cancel button — only visible while a scan is in flight. Wired to
              cancelScan, which aborts the upstream fetch (so the backend
              actually stops too) and snaps the UI state back to idle. */}
          {(state.status === "loading" || pending) && (
            <button
              type="button"
              onClick={cancelScan}
              className={
                compact
                  ? "rounded-md border border-[rgba(239,120,120,0.45)] bg-transparent px-3 py-1 text-[11px] font-semibold text-[color:var(--vl-red)] transition-all duration-[var(--vl-motion,180ms)] hover:bg-[rgba(239,120,120,0.08)]"
                  : "inline-flex items-center rounded-md border border-red-500/40 bg-transparent px-3 py-1 text-xs font-semibold text-red-300 transition-colors duration-100 hover:bg-red-500/10"
              }
            >
              Cancel
            </button>
          )}
          {/* Compact mode (standalone /burner) suppresses these legacy
              affordances — the page-level tabs already drive section
              navigation, and "Build close transaction" / "Clean wallet
              fully" are replaced by per-section "Burn selected" /
              "Close & reclaim" CTAs inside CleanerDetails. The original
              full-cleaner view (/groups/[id]?tab=cleaner) keeps every
              button. */}
          {state.status === "scanned" && !compact && (
            <button
              type="button"
              onClick={() => setShowDetails((v) => !v)}
              className={btnSecondary}
              disabled={isFullCleaning}
            >
              {showDetails ? "Hide" : "View details"}
            </button>
          )}
          {!compact && state.status === "scanned" && state.scan.emptyTokenAccounts.length > 0 && (
            <button
              type="button"
              onClick={handleBuildTx}
              disabled={
                buildPending || buildState.status === "loading" || isFullCleaning
              }
              className={btnSecondary}
            >
              {buildState.status === "loading" || buildPending
                ? "Building…"
                : buildState.status === "ready"
                ? "Rebuild close tx"
                : "Build close transaction"}
            </button>
          )}
          {!compact && state.status === "scanned" &&
            state.scan.emptyTokenAccounts.length > 0 &&
            !isFullCleaning && (
              <button
                type="button"
                onClick={() => void runFullClean()}
                disabled={
                  pending ||
                  state.status !== "scanned" ||
                  w.connected !== wallet.address
                }
                title={
                  w.connected !== wallet.address
                    ? `Connect the wallet ${shortAddr(wallet.address, 4, 4)} to enable full clean`
                    : undefined
                }
                className={btnPrimary}
              >
                Clean wallet fully
              </button>
            )}
          {!compact && isFullCleaning && (
            <button
              type="button"
              onClick={cancelFullClean}
              className={btnSecondary}
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      {state.status === "error" && (
        <div className="border-t border-[color:var(--vl-border)] bg-red-500/5 px-3 py-2 text-xs text-red-400">
          {prettifyApiError(state.error)}
        </div>
      )}

      {fullClean.status === "running" && (
        <FullCleanProgress state={fullClean} />
      )}
      {fullClean.status === "done" && (
        <div className="border-t border-[color:var(--vl-border)] bg-emerald-500/5 px-3 py-2 text-xs text-emerald-300">
          ✓ Wallet fully cleaned in {fullClean.batches} batch
          {fullClean.batches === 1 ? "" : "es"}.
          {fullClean.signatures.length > 0 && (
            <span className="ml-2 inline-flex flex-wrap gap-2 align-middle">
              {fullClean.signatures.map((sig, i) => (
                <a
                  key={sig}
                  href={solscanTxUrl(sig)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-[11px] font-semibold text-violet-300 hover:text-violet-200"
                >
                  tx{i + 1} ↗
                </a>
              ))}
            </span>
          )}
        </div>
      )}
      {fullClean.status === "cancelled" && (
        <div className="border-t border-[color:var(--vl-border)] bg-amber-500/5 px-3 py-2 text-xs text-amber-300">
          Cancelled after {fullClean.batches} batch
          {fullClean.batches === 1 ? "" : "es"}. Rescan to refresh totals.
        </div>
      )}
      {fullClean.status === "error" && (
        <div className="border-t border-[color:var(--vl-border)] bg-red-500/5 px-3 py-2 text-xs text-red-400">
          Full clean stopped at batch {fullClean.batches}:{" "}
          {prettifyApiError(fullClean.error)}
        </div>
      )}

      {state.status === "scanned" && state.scan.emptyTokenAccounts.length === 0 && (
        <div
          className={`border-t border-[color:var(--vl-border)] px-3 py-2 text-xs ${
            lastSentSig
              ? "bg-emerald-500/5 text-emerald-300"
              : "bg-neutral-950 text-neutral-500"
          }`}
        >
          {lastSentSig
            ? "Wallet cleaned: no closeable empty accounts found."
            : "No closeable empty accounts."}
        </div>
      )}

      {buildState.status === "error" && (
        <div className="border-t border-[color:var(--vl-border)] bg-red-500/5 px-3 py-2 text-xs text-red-400">
          Build failed: {prettifyApiError(buildState.error)}
        </div>
      )}

      {state.status === "idle" && !pending && (
        <div className="border-t border-[color:var(--vl-border)] bg-neutral-950 px-3 py-2 text-xs text-neutral-500">
          Scan wallet to discover reclaimable SOL.
        </div>
      )}

      {buildState.status === "ready" && (
        <CloseTxPreview
          result={buildState.result}
          targetWallet={wallet.address}
          onSent={(sig) => setLastSentSig(sig)}
          onRescan={handleScan}
          rescanPending={pending || state.status === "loading"}
        />
      )}

      {state.status === "scanned" && (showDetails || compact) && (
        <CompactModeCtx.Provider value={compact}>
          {/* `BurnSelectionProvider` is intentionally NOT mounted here —
              it lives at the page level (e.g. /burner BurnerBody) so
              both the publishers (inside CleanerDetails) and the reader
              (the sticky action bar) share the same registry instance.
              Publisher hooks are no-ops when no provider is present, so
              the default /groups/[id] view (which mounts no provider)
              pays zero cost. */}
          <CleanerDetails
            scan={state.scan}
            burn={state.burn}
            walletAddress={wallet.address}
            onWalletRescan={handleScan}
            rescanPending={pending}
            visibleSection={visibleSection}
          />
          {/* Hidden close-empty trigger — only present in compact mode so
              the page-level sticky action bar can `.click()` it via the
              data attribute. The inline "Build close transaction" button
              in the CleanerRow header is suppressed in compact mode, so
              this hidden mirror is the only programmatic entry point.
              `aria-hidden` keeps screen readers from announcing it; the
              visible sticky bar carries the real label. Also publishes
              empty-account count + reclaim into the selection registry. */}
          {compact && state.scan.emptyTokenAccounts.length > 0 && (
            <CloseEmptyHiddenTrigger
              handleBuildTx={handleBuildTx}
              disabled={buildPending || buildState.status === "loading"}
              emptyCount={state.scan.emptyTokenAccounts.length}
              reclaimSol={state.scan.totals.estimatedReclaimSol}
            />
          )}
        </CompactModeCtx.Provider>
      )}
    </div>
  );
}

type SendState =
  | { status: "idle" }
  | { status: "signing" }
  | { status: "sent"; signature: string }
  | { status: "error"; error: string };

function CloseTxPreview({
  result,
  targetWallet,
  onSent,
  onRescan,
  rescanPending,
}: {
  result: BuildCloseEmptyTxResult;
  targetWallet: string;
  onSent: (signature: string) => void;
  onRescan: () => void;
  rescanPending: boolean;
}) {
  const tx = result.transactionBase64;
  const txShort =
    tx === null
      ? "—"
      : tx.length > 80
      ? `${tx.slice(0, 40)}…${tx.slice(-20)} (${tx.length} chars)`
      : tx;
  const rows: { label: string; value: React.ReactNode; mono?: boolean }[] = [
    {
      label: "Included accounts",
      value: (
        <span className="font-bold text-white">
          {result.includedAccounts.length}
          <span className="ml-1 text-neutral-500">
            / {result.totalEmpty} total
          </span>
        </span>
      ),
    },
    {
      label: "Skipped accounts",
      value: (
        <span className="text-white">
          {result.skippedAccounts}
          {result.skippedAccounts > 0 && (
            <span className="ml-1 text-neutral-500">
              (limit {result.maxInstructionsPerTx} per tx)
            </span>
          )}
        </span>
      ),
    },
    {
      label: "Gross reclaim",
      value: (
        <span className="font-bold text-emerald-300">
          {fmtSol(result.estimatedReclaimSol)} SOL
        </span>
      ),
    },
    {
      label: "Estimated network fee",
      value: (
        <span className="text-neutral-200">
          {fmtSol(result.estimatedFeeSol)} SOL
          <span className="ml-1 text-[10px] text-neutral-500">
            (base {fmtSol(result.estimatedBaseFeeSol)}
            {result.estimatedPriorityFeeSol > 0 && (
              <> + priority {fmtSol(result.estimatedPriorityFeeSol)}</>
            )}
            ; {result.computeUnitLimit.toLocaleString()} CU
            {result.priorityFeeMicrolamports > 0 && (
              <> @ {result.priorityFeeMicrolamports} μL/CU</>
            )}
            )
          </span>
        </span>
      ),
    },
    {
      label: "Estimated net received",
      value: (
        <span className="font-bold text-emerald-300">
          {fmtSol(result.estimatedNetReclaimSol)} SOL
        </span>
      ),
    },
    {
      label: "Tx version",
      value: <Badge variant="info">{result.transactionVersion}</Badge>,
    },
    { label: "Fee payer", value: result.feePayer, mono: true },
    {
      label: "Requires signature from",
      value: result.requiresSignatureFrom,
      mono: true,
    },
    {
      label: "Transaction (base64)",
      value: txShort,
      mono: true,
    },
  ];
  return (
    <div className="border-t border-[color:var(--vl-border)] bg-[rgba(0,0,0,0.22)]">
      <div className="flex items-center justify-between border-b border-[color:var(--vl-border)] px-3 py-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-300">
          Close transaction preview
        </span>
        <Badge variant="warn">unsigned</Badge>
      </div>
      <div className="border-b border-[color:var(--vl-border)] bg-amber-500/5 px-3 py-1.5 text-[11px] text-amber-300">
        ⚠ {result.warning}
      </div>
      {result.includedAccounts.length > 0 && (
        <div className="border-b border-[color:var(--vl-border)] bg-violet-500/5 px-3 py-1.5 text-[11px] text-violet-200">
          ℹ Closing {result.includedAccounts.length} account
          {result.includedAccounts.length === 1 ? "" : "s"} in this transaction.
          {result.skippedAccounts > 0 && (
            <>
              {" "}
              {result.skippedAccounts} account
              {result.skippedAccounts === 1 ? "" : "s"} remain for the next batch.
            </>
          )}
        </div>
      )}
      <dl className="divide-y divide-[color:var(--vl-border)]">
        {rows.map((r) => (
          <div
            key={r.label}
            className="grid grid-cols-12 items-center gap-3 px-3 py-1.5 text-xs"
          >
            <dt className="col-span-4 text-neutral-400">{r.label}</dt>
            <dd
              className={`col-span-8 min-w-0 break-all ${
                r.mono ? "font-mono text-[11px] text-neutral-100" : "text-neutral-100"
              }`}
            >
              {r.value}
            </dd>
          </div>
        ))}
      </dl>
      <SignAndSendBlock
        result={result}
        targetWallet={targetWallet}
        onSent={onSent}
        onRescan={onRescan}
        rescanPending={rescanPending}
      />
    </div>
  );
}

function SignAndSendBlock({
  result,
  targetWallet,
  onSent,
  onRescan,
  rescanPending,
}: {
  result: BuildCloseEmptyTxResult;
  targetWallet: string;
  onSent: (signature: string) => void;
  onRescan: () => void;
  rescanPending: boolean;
}) {
  const w = useWallet();
  const [send, setSend] = useState<SendState>({ status: "idle" });

  const noTx = result.transactionBase64 === null;
  const noIncluded = result.includedAccounts.length === 0;
  const walletMismatch =
    w.connected !== null && w.connected !== result.requiresSignatureFrom;
  const targetMismatch = targetWallet !== result.requiresSignatureFrom;
  const cleanedVsConnectedMismatch =
    w.connected !== null && w.connected !== targetWallet;
  const alreadySent = send.status === "sent";
  const hasNextBatch = result.skippedAccounts > 0;

  // Audit transaction instructions client-side: every ix must be a CloseAccount
  // call against SPL Token / Token-2022. Memoized on the base64 string so this
  // doesn't re-run on every render.
  const audit: InstructionAuditResult | null = useMemo(() => {
    if (result.transactionBase64 === null) return null;
    return auditCloseEmptyTx(result.transactionBase64);
  }, [result.transactionBase64]);

  // Safety checklist gates: each must pass before the sign button is enabled.
  const checks = {
    walletMatches:
      w.connected !== null && w.connected === targetWallet && !walletMismatch,
    closeAccountOnly: audit?.ok === true,
    includedNonZero: !noIncluded,
    burnExcluded: true, // close-empty path: burn ixs are never bundled into the tx audited here
  };
  const checklistPassed =
    checks.walletMatches &&
    checks.closeAccountOnly &&
    checks.includedNonZero &&
    checks.burnExcluded;

  // Once a tx for this build has been sent, the same built tx cannot be sent
  // again — its blockhash is consumed. User must rescan and rebuild.
  const canSend =
    !alreadySent &&
    !noTx &&
    checklistPassed &&
    !targetMismatch &&
    send.status !== "signing";

  async function handleSignAndSend() {
    if (!canSend || result.transactionBase64 === null) return;
    const provider = getProvider();
    if (!provider) {
      setSend({ status: "error", error: "No wallet provider available." });
      return;
    }
    setSend({ status: "signing" });
    try {
      const tx = decodeBase64Transaction(result.transactionBase64);
      const res = await provider.signAndSendTransaction(tx);
      setSend({ status: "sent", signature: res.signature });
      onSent(res.signature);
    } catch (err) {
      setSend({ status: "error", error: prettifyWalletError(err) });
    }
  }

  return (
    <div className="border-t border-[color:var(--vl-border)] bg-[rgba(0,0,0,0.22)]">
      {cleanedVsConnectedMismatch && (
        <div className="border-b border-[color:var(--vl-border)] bg-amber-500/5 px-3 py-1.5 text-[11px] text-amber-300">
          ⚠ Connected wallet must match the wallet being cleaned.{" "}
          <span className="text-amber-200/80">
            Connected: <span className="font-mono">{shortAddr(w.connected!, 4, 4)}</span>{" "}
            · cleaning: <span className="font-mono">{shortAddr(targetWallet, 4, 4)}</span>
          </span>
        </div>
      )}
      <div className="border-b border-[color:var(--vl-border)] bg-amber-500/5 px-3 py-1.5 text-[11px] text-amber-300">
        ⚠ This only closes empty token accounts and returns rent. It does not
        burn tokens or NFTs.
      </div>
      <SafetyChecklist
        items={[
          {
            ok: checks.walletMatches,
            label: "Connected wallet matches target wallet",
            failHint:
              w.connected === null
                ? "Connect a wallet"
                : `Expected ${shortAddr(targetWallet, 4, 4)}, got ${shortAddr(w.connected, 4, 4)}`,
          },
          {
            ok: checks.closeAccountOnly,
            label: "Transaction only contains CloseAccount instructions",
            failHint:
              audit === null
                ? "No transaction to audit"
                : audit.reason ?? "Audit failed",
          },
          {
            ok: checks.includedNonZero,
            label: `Included accounts count > 0 (${result.includedAccounts.length})`,
            failHint: "No accounts included in this transaction",
          },
          {
            ok: checks.burnExcluded,
            label: "Burn is not included",
          },
        ]}
      />
      <div className="mt-3 flex flex-wrap items-center justify-start gap-2 px-3 pb-3">
        {!w.connected ? (
          <button
            type="button"
            onClick={() => void w.connect()}
            disabled={w.connecting}
            aria-label="Connect wallet to sign"
            className={signSendButtonClass(w.connecting ? "loading" : "idle")}
          >
            {w.connecting ? (
              <>
                <Spinner /> Connecting…
              </>
            ) : (
              "Connect wallet to sign"
            )}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void handleSignAndSend()}
            disabled={!canSend}
            aria-label="Sign and send close transaction"
            className={signSendButtonClass(
              alreadySent
                ? "sent"
                : send.status === "signing"
                ? "loading"
                : !canSend
                ? "blocked"
                : "idle",
            )}
            title={
              alreadySent
                ? "This transaction has been sent. Rescan to build a new one."
                : noIncluded
                ? "No accounts included in this transaction."
                : noTx
                ? "Nothing to send — transactionBase64 is null"
                : walletMismatch
                ? `Connected wallet does not match requiresSignatureFrom (${shortAddr(
                    result.requiresSignatureFrom,
                    4,
                    4,
                  )})`
                : undefined
            }
          >
            {send.status === "signing" ? (
              <>
                <Spinner /> Awaiting wallet…
              </>
            ) : alreadySent ? (
              "Sent ✓"
            ) : (
              "Sign & send close transaction"
            )}
          </button>
        )}
        {alreadySent && (
          <button
            type="button"
            onClick={onRescan}
            disabled={rescanPending}
            aria-label="Rescan wallet"
            className={signSendButtonClass(rescanPending ? "loading-secondary" : "secondary")}
          >
            {rescanPending ? (
              <>
                <Spinner /> Rescanning…
              </>
            ) : (
              "Rescan wallet"
            )}
          </button>
        )}
        {noIncluded && (
          <span className="text-[11px] text-neutral-500">
            No accounts included in this transaction.
          </span>
        )}
        {!noTx && walletMismatch && !cleanedVsConnectedMismatch && (
          <span className="text-[11px] text-red-400">
            Connected wallet must match{" "}
            <span className="font-mono">
              {shortAddr(result.requiresSignatureFrom, 4, 4)}
            </span>
            .
          </span>
        )}
      </div>

      {send.status === "sent" && (
        <div className="border-t border-[color:var(--vl-border)] bg-emerald-500/5 px-3 py-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="buy">Sent</Badge>
            <span className="text-neutral-300">Tx signature:</span>
            <span className="font-mono text-[11px] text-neutral-100">
              {shortAddr(send.signature, 8, 8)}
            </span>
            <a
              href={solscanTxUrl(send.signature)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] font-semibold text-violet-300 hover:text-violet-200"
            >
              View on Solscan ↗
            </a>
          </div>
          {hasNextBatch && (
            <div className="mt-1 text-[11px] text-emerald-300/80">
              Rescan after confirmation to build the next batch (
              {result.skippedAccounts} account
              {result.skippedAccounts === 1 ? "" : "s"} remaining).
            </div>
          )}
        </div>
      )}

      {send.status === "error" && (
        <div className="border-t border-[color:var(--vl-border)] bg-red-500/5 px-3 py-2 text-xs text-red-400">
          {send.error}
        </div>
      )}
    </div>
  );
}


// Per-state class string for the Sign & send action button. Inlined here
// (instead of using shared btnPrimary) because the shared `disabled:opacity-40`
// rule was making the button visually disappear against the dark
// neutral-950 panel surface whenever any safety check failed. Each state
// keeps a fully-opaque, clearly-bordered button so the affordance is
// unmistakable in every case.
type SignButtonState =
  | "idle"
  | "loading"
  | "sent"
  | "blocked"
  | "secondary"
  | "loading-secondary";

function signSendButtonClass(state: SignButtonState): string {
  const base =
    "inline-flex min-w-[200px] items-center justify-center gap-1.5 " +
    "rounded-lg border px-4 py-2 text-sm font-semibold " +
    "transition-colors duration-100 active:scale-[0.98] " +
    "focus:outline-none focus:ring-2";
  switch (state) {
    case "idle":
      return (
        `${base} cursor-pointer ` +
        "border-violet-400 bg-violet-500 text-white shadow shadow-violet-500/30 " +
        "hover:bg-violet-400 hover:border-violet-300 " +
        "focus:ring-violet-500/50"
      );
    case "loading":
      return (
        `${base} cursor-wait ` +
        "border-violet-400/70 bg-violet-600 text-white/95 " +
        "focus:ring-violet-500/50"
      );
    case "sent":
      return (
        `${base} cursor-default ` +
        "border-emerald-400 bg-emerald-500 text-white shadow shadow-emerald-500/30 " +
        "focus:ring-emerald-500/50"
      );
    case "blocked":
      return (
        `${base} cursor-not-allowed ` +
        "border-[color:var(--vl-border)] bg-neutral-800 text-neutral-400 " +
        "focus:ring-neutral-700/60"
      );
    case "secondary":
      return (
        `${base} cursor-pointer ` +
        "border-neutral-600 bg-neutral-800 text-neutral-100 " +
        "hover:border-neutral-500 hover:bg-neutral-700 hover:text-white " +
        "focus:ring-neutral-700/60"
      );
    case "loading-secondary":
      return (
        `${base} cursor-wait ` +
        "border-neutral-600 bg-neutral-800 text-neutral-200 " +
        "focus:ring-neutral-700/60"
      );
  }
}

// Progress strip while the backend batch scan is in flight. The endpoint
// is a single blocking call (no per-wallet streaming), so we can't show
// real per-wallet progress mid-flight — we show total + an indeterminate
// indicator. The per-wallet status table appears in the "done" summary.
function ScanAllProgress({
  state,
}: {
  state: Extract<ScanAllState, { status: "running" }>;
}) {
  return (
    <div className="border-t border-[color:var(--vl-border)] bg-[rgba(168,144,232,0.05)]">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-3 py-1.5 text-[11px] text-[color:var(--vl-fg-2)]">
        <span>
          <span className="font-semibold text-white">
            Scanning wallets…
          </span>
          <span className="ml-1 text-[color:var(--vl-fg-3)]">
            Fast summary scan. NFT discovery loads when you open a wallet
            section.
          </span>
        </span>
      </div>
      <div className="h-0.5 w-full overflow-hidden bg-[color:var(--vl-surface-2)]">
        <div className="ui-indeterminate-bar h-full bg-[color:var(--vl-purple)]/70" />
      </div>
    </div>
  );
}

function FullCleanProgress({
  state,
}: {
  state: Extract<FullCleanState, { status: "running" }>;
}) {
  const stepLabel =
    state.step === "building"
      ? "Building close tx"
      : state.step === "signing"
      ? "Awaiting wallet signature"
      : state.step === "waiting-cache"
      ? "Waiting for confirmation…"
      : "Rescanning";
  return (
    <div className="border-t border-[color:var(--vl-border)] bg-violet-500/5 px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Spinner />
        <span className="font-semibold text-white">
          Closing batch {state.batch} / {state.expectedBatches}
        </span>
        <span className="text-neutral-400">— {stepLabel}</span>
        <span className="ml-auto text-[11px] text-neutral-400">
          {state.remainingEmpty} empty account
          {state.remainingEmpty === 1 ? "" : "s"} remaining
        </span>
      </div>
      {state.lastSignature && (
        <div className="mt-1 text-[11px] text-neutral-500">
          Last tx:{" "}
          <a
            href={solscanTxUrl(state.lastSignature)}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono font-semibold text-violet-300 hover:text-violet-200"
          >
            {shortAddr(state.lastSignature, 6, 6)} ↗
          </a>
        </div>
      )}
    </div>
  );
}

// Compact 12-px spinner used inside primary action buttons. Inline-block so
// it sits flush with the button label; aria-hidden because the surrounding
// label already conveys state.
function Spinner() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="mr-1.5 inline-block h-3.5 w-3.5 animate-spin"
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeOpacity="0.25"
      />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

// Maps the raw error thrown by `provider.signAndSendTransaction` (Phantom /
// Solflare / generic Phantom-shaped provider) into a clean, user-facing
// sentence. The UI never shows raw provider stack traces.
function prettifyWalletError(err: unknown): string {
  const e = err as { code?: number; message?: string; name?: string } | null;
  const m = (e?.message ?? "").toLowerCase();
  // 4001 is the EIP-1193-style "user rejected" code that Phantom uses too.
  if (e?.code === 4001 || /user rejected|user denied|request rejected|cancelled/.test(m)) {
    return "Signing cancelled in wallet.";
  }
  if (/wrong[- ]?account|signer.*mismatch|missing.*signer|account does not match|signature.*mismatch/.test(m)) {
    return "Wallet does not match the cleaning wallet. Switch accounts in your wallet to the address being cleaned and try again.";
  }
  if (/blockhash not found|block height exceeded|transaction.*expired|transactiontoold|expired/.test(m)) {
    return "Transaction expired (blockhash). Click Rebuild close tx, then Sign & send again.";
  }
  if (/insufficient (lamports|funds|balance|sol)/.test(m) || /not enough sol/.test(m)) {
    return "Insufficient SOL in the wallet to pay the network fee. Add a small amount of SOL and try again.";
  }
  if (/simulation failed|preflight|failed to simulate/.test(m)) {
    return "Transaction simulation failed. The accounts may already be closed — Rescan, then rebuild.";
  }
  if (/no wallet|provider/.test(m) && /undefined|null/.test(m)) {
    return "No wallet provider detected. Make sure Phantom or Solflare is installed and unlocked.";
  }
  return e?.message
    ? `Sign/send failed: ${e.message}`
    : "Sign/send failed. Open the browser console for details.";
}

interface SafetyCheckItem {
  ok: boolean;
  label: ReactNode;
  failHint?: string;
}

function SafetyChecklist({ items }: { items: SafetyCheckItem[] }) {
  return (
    <ul className="divide-y divide-[color:var(--vl-border)] border-b border-[color:var(--vl-border)] bg-neutral-950 text-[11px]">
      {items.map((item, i) => (
        <li
          key={i}
          className="flex items-start gap-2 px-3 py-1.5"
        >
          <span
            aria-hidden
            className={`mt-[2px] inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full font-bold leading-none ${
              item.ok
                ? "bg-emerald-500/20 text-emerald-300"
                : "bg-red-500/20 text-red-300"
            }`}
          >
            {item.ok ? "✓" : "✕"}
          </span>
          <span className={`min-w-0 flex-1 ${item.ok ? "text-neutral-200" : "text-red-300"}`}>
            {item.label}
            {!item.ok && item.failHint && (
              <span className="ml-1 text-red-400/80">— {item.failHint}</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

type BurnBuildState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; result: BuildBurnAndCloseTxResult }
  | { status: "error"; error: string };

// =============================================================================
// Unified Cleaner reclaim summary — read-only roll-up of every cleanup/burn
// path. Each burn section (legacy NFT, pNFT, Core) drops its discovery
// result into this context via `useReportReclaim`; the parent renders a
// compact panel at the top of CleanerDetails. Close-empty + SPL-burn values
// are seeded synchronously from the scan / burn-candidates response that
// CleanerDetails already receives as props.
//
// Status semantics (per row):
//   - "ready":    discovery succeeded; `value` is the estimated reclaim SOL.
//   - "loading":  discovery in flight.
//   - "error":    discovery failed.
//   - "empty":    no eligible items in this category.
//   - "rejected": preflight simulation rejected the entire batch (pNFT, Core).
//                 Excluded from the running total per the spec.
// =============================================================================

type ReclaimStatus = "loading" | "ready" | "error" | "empty" | "rejected";
type ReclaimEntry = { value: number | null; status: ReclaimStatus };
type ReclaimKey = "closeEmpty" | "splBurn" | "legacyNft" | "pnft" | "core";
type ReclaimSummaryState = Record<ReclaimKey, ReclaimEntry>;

const ReclaimSummaryCtx = createContext<{
  report: (key: ReclaimKey, entry: ReclaimEntry) => void;
} | null>(null);

function useReportReclaim(key: ReclaimKey, entry: ReclaimEntry): void {
  const ctx = useContext(ReclaimSummaryCtx);
  // Stringify so a fresh object literal each render with the same content
  // doesn't trigger a no-op state update on the parent.
  const entryKey = `${entry.status}:${entry.value ?? "null"}`;
  useEffect(() => {
    if (!ctx) return;
    ctx.report(key, entry);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, key, entryKey]);
}

function CleanerDetails({
  scan,
  burn,
  walletAddress,
  onWalletRescan,
  rescanPending,
  visibleSection = "all",
}: {
  scan: CleanupScanResult;
  burn: BurnCandidatesResult;
  walletAddress: string;
  onWalletRescan: () => void;
  rescanPending: boolean;
  visibleSection?: CleanerVisibleSection;
}) {
  // Compact mode is set by CleanerRow via the surrounding provider when
  // the page (e.g. /burner) wants the section's primary action button to
  // become a hidden trigger that the page-level sticky action bar
  // dispatches `.click()` to. The default-mode (/groups/[id]?tab=cleaner)
  // never enters compact, so its inline buttons stay visible.
  const isCompact = useCompactMode();
  // Tab-mode helpers — gate which destructive section is VISIBLE so the
  // standalone /burner page can show one category at a time under tabs.
  const showAll = visibleSection === "all";
  const showEmpty = showAll || visibleSection === "empty";
  const showSpl = showAll || visibleSection === "tokens";
  const showLegacy = showAll || visibleSection === "nfts";
  const showPnft = showAll || visibleSection === "nfts";
  const showCore = showAll || visibleSection === "core";

  // Lazy-mount + keep-mounted: once a section becomes visible at least
  // once, it stays in the React tree forever and only gets `hidden`
  // when the user switches away. This is what preserves Legacy / pNFT /
  // Core discovery results, the user's NFT selection, and any in-progress
  // build state across tab switches — remounting would throw all of that
  // away and re-fire the discovery network calls. (`liveAll` is always
  // true so the original `/groups/[id]?tab=cleaner` view, which never
  // changes `visibleSection`, mounts everything immediately just like
  // before.)
  const [activated, setActivated] = useState<Set<CleanerVisibleSection>>(
    () => new Set<CleanerVisibleSection>(["all", visibleSection]),
  );
  useEffect(() => {
    setActivated((prev) => {
      if (prev.has(visibleSection)) return prev;
      const next = new Set(prev);
      next.add(visibleSection);
      return next;
    });
  }, [visibleSection]);
  const liveEmpty = showAll || activated.has("empty");
  const liveSpl = showAll || activated.has("tokens");
  const liveLegacy = showAll || activated.has("nfts");
  const livePnft = showAll || activated.has("nfts");
  const liveCore = showAll || activated.has("core");
  // Selected mints across the burn-candidates table. Mint is the discriminator
  // because the backend uses it as the allowlist key in the build request.
  const [selectedMints, setSelectedMints] = useState<Set<string>>(new Set());
  const [burnBuild, setBurnBuild] = useState<BurnBuildState>({ status: "idle" });
  const [burnPending, startBurnTransition] = useTransition();

  // Reclaim summary state. Close-empty + SPL come straight from the props
  // (synchronously available once CleanerDetails mounts). The three burn
  // sections seed themselves to "loading" and report on discovery via the
  // context below.
  const [summary, setSummary] = useState<ReclaimSummaryState>({
    closeEmpty: {
      value: scan.totals.estimatedReclaimSol,
      status: scan.emptyTokenAccounts.length === 0 ? "empty" : "ready",
    },
    splBurn: {
      value: burn.totalEstimatedReclaimSol,
      status: burn.candidates.length === 0 ? "empty" : "ready",
    },
    legacyNft: { value: null, status: "loading" },
    pnft: { value: null, status: "loading" },
    core: { value: null, status: "loading" },
  });
  const reportReclaim = useCallback(
    (key: ReclaimKey, entry: ReclaimEntry) => {
      setSummary((prev) => {
        const cur = prev[key];
        if (cur.status === entry.status && cur.value === entry.value) return prev;
        return { ...prev, [key]: entry };
      });
    },
    [],
  );
  const reclaimCtx = useMemo(() => ({ report: reportReclaim }), [reportReclaim]);

  // Unified open/collapsed state for the four destructive burn cards.
  // Default: all collapsed. Close-empty is rendered inline and always
  // visible. State is lifted to CleanerDetails so the action-plan panel
  // (rendered below ReclaimSummary) can expand a target section in one
  // click. Discovery state still lives inside each section component, so
  // toggling never re-fires the network call.
  // In tab mode (single-section /burner view) auto-expand the section
  // that matches the active tab so the user lands on the discovery/grid
  // immediately, without an extra collapse-toggle click. In `'all'` mode
  // every section starts collapsed (original /groups/[id] behavior).
  const [openSpl, setOpenSpl] = useState(visibleSection === "tokens");
  const [openLegacy, setOpenLegacy] = useState(visibleSection === "nfts");
  const [openPnft, setOpenPnft] = useState(visibleSection === "nfts");
  const [openCore, setOpenCore] = useState(visibleSection === "core");

  // Refs used by the action-plan "Go to / Expand" buttons to scroll the
  // chosen section into view.
  const closeEmptyRef = useRef<HTMLDivElement | null>(null);
  const splRef = useRef<HTMLDivElement | null>(null);
  const legacyRef = useRef<HTMLDivElement | null>(null);
  const pnftRef = useRef<HTMLDivElement | null>(null);
  const coreRef = useRef<HTMLDivElement | null>(null);

  // Open the target section (if it's collapsible) and scroll its card into
  // view. Pure UI: no fetch, no build, no sign.
  const focusSection = useCallback((key: ReclaimKey) => {
    let ref: React.RefObject<HTMLDivElement | null>;
    switch (key) {
      case "closeEmpty":
        ref = closeEmptyRef;
        break;
      case "splBurn":
        setOpenSpl(true);
        ref = splRef;
        break;
      case "legacyNft":
        setOpenLegacy(true);
        ref = legacyRef;
        break;
      case "pnft":
        setOpenPnft(true);
        ref = pnftRef;
        break;
      case "core":
        setOpenCore(true);
        ref = coreRef;
        break;
    }
    // Defer scroll one tick so the just-expanded section has rendered.
    requestAnimationFrame(() => {
      ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, []);

  function toggleSelected(mint: string): void {
    setSelectedMints((prev) => {
      const next = new Set(prev);
      if (next.has(mint)) next.delete(mint);
      else next.add(mint);
      return next;
    });
  }

  // Mints the user has just burned in this session. Adds to a local set
  // (instead of mutating `burn.candidates`, which is owned by the
  // parent scan result) so the filter is purely render-side: candidates
  // pass through `.filter(c => !splBurnedMints.has(c.mint))` below, and
  // any in-flight selection in `selectedMints` for those mints is
  // cleared. Survives re-renders; cleared only when the user kicks off
  // a fresh wallet scan (which remounts the section via its key).
  const [splBurnedMints, setSplBurnedMints] = useState<Set<string>>(new Set());
  const handleSplBurned = useCallback((mints: string[]) => {
    if (mints.length === 0) return;
    setSplBurnedMints((prev) => {
      const next = new Set(prev);
      for (const m of mints) next.add(m);
      return next;
    });
    setSelectedMints((prev) => {
      const next = new Set(prev);
      for (const m of mints) next.delete(m);
      return next;
    });
    // Clear the build preview so the user doesn't see stale "Re-prepare
    // burn" pointing at mints that no longer exist.
    setBurnBuild({ status: "idle" });
  }, []);
  const visibleSplCandidates = useMemo(
    () => burn.candidates.filter((c) => !splBurnedMints.has(c.mint)),
    [burn.candidates, splBurnedMints],
  );

  function handleBuildBurnTx(): void {
    if (selectedMints.size === 0) return;
    setBurnBuild({ status: "loading" });
    const mints = Array.from(selectedMints);
    startBurnTransition(async () => {
      const res = await buildBurnAndCloseTxAction(walletAddress, mints);
      if (res.ok) setBurnBuild({ status: "ready", result: res.result });
      else setBurnBuild({ status: "error", error: res.error });
    });
  }

  const canBuild =
    selectedMints.size > 0 &&
    burnBuild.status !== "loading" &&
    !burnPending;

  // Publish SPL selection state for the page-level sticky action bar.
  // Reclaim sum walks the burn-candidate list once per selection change
  // (memoized below) — cheap (≤ a few hundred mints in the worst case).
  const splReclaimSol = useMemo(() => {
    if (selectedMints.size === 0) return 0;
    let sum = 0;
    for (const c of burn.candidates) {
      if (selectedMints.has(c.mint)) sum += c.estimatedReclaimSolAfterBurnAndClose;
    }
    return sum;
  }, [selectedMints, burn.candidates]);
  useBurnSelectionPublisher(
    "splBurn",
    selectedMints.size,
    splReclaimSol,
    canBuild,
    burn.candidates.length,
  );

  return (
    <ReclaimSummaryCtx.Provider value={reclaimCtx}>
    <div className="border-t border-[color:var(--vl-border)] bg-[rgba(0,0,0,0.22)]">
      {/* SECTION 0 — Unified reclaim summary + recommended action plan.
          Read-only roll-up of every cleanup/burn path's discovery result.
          Auto-build/sign is never triggered from here — the plan's buttons
          only expand and scroll. */}
      {/* ReclaimSummary + ActionPlan are roll-ups across all 5 sections —
          only meaningful in the original /groups/[id]?tab=cleaner view
          where every section renders. Hidden in single-section tab mode. */}
      {showAll && <ReclaimSummary summary={summary} />}
      {showAll && (
        <ActionPlan
          summary={summary}
          openSections={{
            spl: openSpl,
            legacy: openLegacy,
            pnft: openPnft,
            core: openCore,
          }}
          onFocus={focusSection}
        />
      )}

      {/* SECTION 1 — empty accounts (closing). Plain neutral surface so this
          section reads as the "safe / implemented" path. Lazy-mounted +
          hidden across tab switches to preserve in-flight build state. */}
      {liveEmpty && (
      <div ref={closeEmptyRef} hidden={!showEmpty}>
        <SubHeader
          label="Empty token accounts (closing)"
          right={`${scan.emptyTokenAccounts.length} · reclaim ${fmtSol(scan.totals.estimatedReclaimSol)} SOL`}
        />
        {scan.emptyTokenAccounts.length === 0 ? (
          <EmptyHint>No empty token accounts.</EmptyHint>
        ) : (
          <EmptyAccountsTable rows={scan.emptyTokenAccounts} />
        )}
      </div>
      )}

      {/* SECTION 2 — burn candidates. Visually quarantined inside a red-tinted
          card so it reads as a separate, dangerous surface. Sign+send is
          wired through BurnSignAndSendBlock (NOT the close-empty Sign & send
          button) and gated on: wallet match + audit pass + destructive ack
          checkbox. */}
      {liveSpl && (
      <div
        ref={splRef}
        hidden={!showSpl}
        className="vl-burn-card m-3 overflow-hidden"
      >
        <CollapsibleBurnHeader
          collapsed={!openSpl}
          onToggle={() => setOpenSpl((v) => !v)}
          title="SPL burn · destructive"
          count={`${burn.count} candidate${burn.count === 1 ? "" : "s"}`}
          estSol={burn.totalEstimatedReclaimSol}
          toneBorder="border-red-500/30"
          toneBg="bg-red-500/10"
          toneText="text-red-300"
        />
        {openSpl && (
          <>
            <div className="border-b border-red-500/20 bg-red-500/5 px-3 py-1.5 text-[11px] font-semibold text-red-300">
              ⚠ Destructive and irreversible. Review every line of the preview, then explicitly sign to confirm.
            </div>
            {burn.warning && (
              <div className="border-b border-red-500/15 bg-amber-500/5 px-3 py-1 text-[11px] text-amber-300">
                ⚠ {burn.warning}
              </div>
            )}
            {visibleSplCandidates.length === 0 ? (
              <EmptyHint>
                {burn.candidates.length === 0
                  ? "No fungible burn candidates."
                  : "All SPL candidates burned in this session. Rescan to refresh."}
              </EmptyHint>
            ) : (
              <>
                <BurnCandidatesTable
                  rows={visibleSplCandidates}
                  selected={selectedMints}
                  onToggle={toggleSelected}
                />
                <button
                  type="button"
                  onClick={handleBuildBurnTx}
                  disabled={!canBuild}
                  aria-label="Burn selected SPL tokens"
                  data-vl-burn-trigger="splBurn"
                  hidden
                />
                {burnBuild.status === "error" && (
                  <div className="border-t border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs text-red-300">
                    Build failed: {burnBuild.error}
                  </div>
                )}
                {burnBuild.status === "ready" && (
                  <BurnTxPreview
                    result={burnBuild.result}
                    walletAddress={walletAddress}
                    onWalletRescan={onWalletRescan}
                    rescanPending={rescanPending}
                    onBurned={handleSplBurned}
                  />
                )}
              </>
            )}
          </>
        )}
      </div>
      )}

      {/* SECTION 3 — Legacy Metaplex NFT burn (Milestone 1).
          Distinct red-quarantined card from the SPL fungible burn above.
          Backend BurnV1 reclaims token + metadata + master edition rent.
          Lazy-mounted + hidden across tab switches to preserve discovery
          + selection state. */}
      {liveLegacy && (
      <div ref={legacyRef} hidden={!showLegacy}>
        <LegacyNftBurnSection
          walletAddress={walletAddress}
          nftAccountCount={scan.nftTokenAccounts.length}
          collapsed={!openLegacy}
          onToggle={() => setOpenLegacy((v) => !v)}
          onWalletRescan={onWalletRescan}
          rescanPending={rescanPending}
          visible={showLegacy}
        />
      </div>
      )}

      {/* SECTION 4 — Programmable NFT (pNFT) burn.
          Adds token-record + collection-metadata + auth-rules accounts and
          a backend preflight simulation gate. Visually distinct from the
          legacy NFT card — a slightly deeper red border so the user can't
          confuse the two flows. */}
      {livePnft && (
      <div ref={pnftRef} hidden={!showPnft}>
        <PnftBurnSection
          walletAddress={walletAddress}
          nftAccountCount={scan.nftTokenAccounts.length}
          collapsed={!openPnft}
          onToggle={() => setOpenPnft((v) => !v)}
          onWalletRescan={onWalletRescan}
          rescanPending={rescanPending}
          visible={showPnft}
        />
      </div>
      )}

      {/* SECTION 5 — Metaplex Core asset burn (Milestone 3).
          Core assets are NOT held in SPL token accounts — they're standalone
          Core program accounts owned by the wallet. The cleanup-scan above
          doesn't see them, so this section always probes the chain on mount
          (no nftAccountCount gate). Reclaims the Core asset account rent via
          Core BurnV1 and gates on a backend preflight simulation. */}
      {liveCore && (
      <div ref={coreRef} hidden={!showCore}>
        <CoreBurnSection
          walletAddress={walletAddress}
          collapsed={!openCore}
          onToggle={() => setOpenCore((v) => !v)}
          onWalletRescan={onWalletRescan}
          rescanPending={rescanPending}
          visible={showCore}
        />
      </div>
      )}
    </div>
    </ReclaimSummaryCtx.Provider>
  );
}

// Compact reclaim-summary panel rendered at the very top of CleanerDetails.
// Read-only: never triggers a build / sign / select. Per spec:
//   - Show "—" while a section is still loading.
//   - "rejected" status (preflight simulation failed) is excluded from the
//     running total.
//   - "empty" / "error" rows contribute 0 to the total but render a hint so
//     the user knows the value isn't missing data.
function ReclaimSummary({ summary }: { summary: ReclaimSummaryState }) {
  const rows: { key: ReclaimKey; label: string }[] = [
    { key: "closeEmpty", label: "Close empty" },
    { key: "splBurn", label: "SPL burn" },
    { key: "legacyNft", label: "Legacy NFT" },
    { key: "pnft", label: "pNFT" },
    { key: "core", label: "Core" },
  ];

  // Sum all rows where status === "ready". loading / rejected / error /
  // empty all contribute 0. Also identify the single best-ROI row so it
  // can be highlighted in the grid below.
  let total = 0;
  let anyLoading = false;
  let bestKey: ReclaimKey | null = null;
  let bestValue = 0;
  for (const r of rows) {
    const e = summary[r.key];
    if (e.status === "ready" && e.value !== null) {
      total += e.value;
      // Strict > so a single 0 doesn't become the "best".
      if (e.value > bestValue) {
        bestValue = e.value;
        bestKey = r.key;
      }
    }
    if (e.status === "loading") anyLoading = true;
  }

  function renderValue(e: ReclaimEntry, isBest: boolean): React.ReactNode {
    if (e.status === "loading") {
      return <span className="text-neutral-500">—</span>;
    }
    if (e.status === "error") {
      return (
        <span className="text-amber-400/80" title="discovery failed">
          err
        </span>
      );
    }
    if (e.status === "rejected") {
      return (
        <span
          className="text-red-300/80"
          title="preflight simulation rejected — excluded from total"
        >
          rejected
        </span>
      );
    }
    if (e.status === "empty" || e.value === null) {
      return <span className="tabular-nums text-neutral-400">0</span>;
    }
    return (
      <span
        className={
          isBest
            ? "tabular-nums font-bold text-emerald-300"
            : "tabular-nums font-semibold text-emerald-300/70"
        }
      >
        {fmtSol(e.value)}
      </span>
    );
  }

  return (
    <div className="border-b border-[color:var(--vl-border)] bg-[rgba(168,144,232,0.05)] px-3 py-1.5">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[10px] font-bold uppercase tracking-wider text-neutral-300">
          Total possible reclaim
        </span>
        <span className="text-[11px] tabular-nums text-neutral-400">
          {anyLoading && <span className="mr-1.5 italic">scanning…</span>}
          <span className="font-bold text-emerald-300">
            {fmtSol(total)}
          </span>{" "}
          SOL
        </span>
      </div>
      <ul className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] sm:grid-cols-3 md:grid-cols-5">
        {rows.map((r) => {
          const isBest = bestKey === r.key;
          return (
            <li
              key={r.key}
              className={
                isBest
                  ? "flex items-baseline justify-between gap-2 rounded border border-emerald-500/40 bg-emerald-500/[0.08] px-1.5 py-0.5 ring-1 ring-emerald-500/20"
                  : "flex items-baseline justify-between gap-2 px-1.5 py-0.5"
              }
              title={isBest ? "Largest reclaim source" : undefined}
            >
              <span
                className={
                  isBest ? "font-semibold text-emerald-200" : "text-neutral-400"
                }
              >
                {r.label}
              </span>
              <span>{renderValue(summary[r.key], isBest)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// =============================================================================
// Recommended action plan — compact ordered checklist rendered directly
// under ReclaimSummary. Read-only: the only action surfaced is "Go to" /
// "Expand", which scrolls the corresponding section into view (and
// expands it if collapsible). No build, sign, or selection is triggered.
//
// Step order is fixed by the spec and matches the safest cleanup order:
//   1. Close empty   (fully implemented sign+send path)
//   2. SPL burn      (sign+send wired, destructive-ack gated)
//   3. Legacy NFT    (sign+send wired, destructive-ack gated)
//   4. pNFT          (sign+send wired, destructive-ack + simulation gated)
//   5. Core          (sign+send wired, destructive-ack + simulation gated)
// =============================================================================

type ActionPlanStatusKind =
  | "ready"           // section has items; sign+send wired
  | "scanning"        // discovery in flight
  | "unavailable"     // legitimately nothing to do (empty / 0 reclaim)
  | "error"           // discovery call failed — recoverable via Retry
  | "rejected";       // pNFT/Core preflight simulation failed

function ActionPlan({
  summary,
  openSections,
  onFocus,
}: {
  summary: ReclaimSummaryState;
  openSections: { spl: boolean; legacy: boolean; pnft: boolean; core: boolean };
  onFocus: (key: ReclaimKey) => void;
}) {
  // Translate a summary entry into a displayable plan status. All five
  // sections (close-empty + four burn flows) have a real sign+send path
  // wired via SignAndSendBlock / BurnSignAndSendBlock, so any non-empty,
  // non-error section gets "ready".
  function statusFor(
    _key: ReclaimKey,
    entry: ReclaimEntry,
  ): ActionPlanStatusKind {
    if (entry.status === "loading") return "scanning";
    if (entry.status === "error") return "error";
    if (entry.status === "rejected") return "rejected";
    if (entry.status === "empty") return "unavailable";
    if (entry.value === null || entry.value === 0) return "unavailable";
    return "ready";
  }

  function isOpen(key: ReclaimKey): boolean {
    if (key === "closeEmpty") return true; // always rendered inline
    if (key === "splBurn") return openSections.spl;
    if (key === "legacyNft") return openSections.legacy;
    if (key === "pnft") return openSections.pnft;
    return openSections.core;
  }

  const steps: { key: ReclaimKey; n: number; label: string }[] = [
    { key: "closeEmpty", n: 1, label: "Close empty accounts" },
    { key: "splBurn", n: 2, label: "SPL burn preview" },
    { key: "legacyNft", n: 3, label: "Legacy NFT burn preview" },
    { key: "pnft", n: 4, label: "pNFT burn preview" },
    { key: "core", n: 5, label: "Core burn preview" },
  ];

  function renderStatus(s: ActionPlanStatusKind): React.ReactNode {
    switch (s) {
      case "ready":
        return (
          <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-300 ring-1 ring-emerald-500/30">
            ready
          </span>
        );
      case "scanning":
        return (
          <span className="rounded bg-neutral-700/40 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-neutral-300 ring-1 ring-neutral-600/40">
            scanning…
          </span>
        );
      case "rejected":
        return (
          <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-red-300 ring-1 ring-red-500/30">
            rejected
          </span>
        );
      case "error":
        return (
          <span
            className="rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-red-300 ring-1 ring-red-500/40"
            title="Discovery call failed — open the section and click Retry discovery"
          >
            discovery failed
          </span>
        );
      case "unavailable":
        return (
          <span className="rounded bg-neutral-800/60 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-neutral-500 ring-1 ring-neutral-700/40">
            unavailable
          </span>
        );
    }
  }

  return (
    <div className="border-b border-[color:var(--vl-border)] bg-[rgba(168,144,232,0.04)] px-3 py-1.5">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[10px] font-bold uppercase tracking-wider text-neutral-300">
          Recommended plan
        </span>
        <span className="text-[10px] italic text-neutral-500">
          read-only · no auto-sign
        </span>
      </div>
      <ol className="space-y-0.5 text-[11px]">
        {steps.map(({ key, n, label }) => {
          const entry = summary[key];
          const s = statusFor(key, entry);
          const sol =
            entry.status === "ready" && entry.value !== null
              ? entry.value
              : null;
          const open = isOpen(key);
          // Always allow Expand/Scroll. Even for unavailable/rejected, the
          // target section may carry the discovery error message or the
          // preflight rejection reason — the user needs to see those.
          // Toggling a card with no items is harmless.
          const actionDisabled = false;
          // Close-empty is always inline-expanded → label is "Go to".
          // Discovery-failed sections route to the in-section Retry button —
          // lead the user there explicitly. Otherwise label flips on whether
          // the target is open.
          const actionLabel =
            key === "closeEmpty"
              ? "Go to"
              : s === "error"
              ? "Open & retry →"
              : open
              ? "Scroll to →"
              : "Expand →";
          const actionTone =
            s === "error"
              ? "rounded border border-red-500/40 bg-red-500/[0.10] px-2 py-0.5 text-[10px] font-semibold text-red-200 transition-colors duration-100 hover:bg-red-500/20"
              : "rounded border border-emerald-500/40 bg-emerald-500/[0.08] px-2 py-0.5 text-[10px] font-semibold text-emerald-200 transition-colors duration-100 hover:bg-emerald-500/15";
          return (
            <li
              key={key}
              className="grid grid-cols-12 items-center gap-2"
            >
              <span className="col-span-1 text-neutral-500 tabular-nums">
                {n}.
              </span>
              <span className="col-span-4 truncate text-neutral-200">
                {label}
              </span>
              <span className="col-span-2">{renderStatus(s)}</span>
              <span className="col-span-3 text-right tabular-nums">
                {sol === null ? (
                  <span className="text-neutral-500">—</span>
                ) : (
                  <span className="font-semibold text-emerald-300">
                    {fmtSol(sol)} SOL
                  </span>
                )}
              </span>
              <span className="col-span-2 text-right">
                <button
                  type="button"
                  onClick={() => onFocus(key)}
                  disabled={actionDisabled}
                  aria-label={`${actionLabel} ${label}`}
                  className={actionTone}
                >
                  {actionLabel}
                </button>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// Burn-specific safety checklist. Renders the audit results plus the
// destructive-action acknowledgement checkbox. Doesn't gate any sign/send
// (none wired yet); kept visible so the user — and any future Sign/Send
// implementation — can read the live status of every contract.
function BurnSafetyChecklist({
  result,
  audit,
  ackDestructive,
  onToggleAck,
}: {
  result: BuildBurnAndCloseTxResult;
  audit: BurnAuditResult | null;
  ackDestructive: boolean;
  onToggleAck: () => void;
}) {
  // When there's no tx (empty branch), don't render the checklist — the
  // top-level "no candidates" state already covers it.
  if (audit === null) return null;

  // burnsPaired covers "every burn followed by close on same account",
  // !hasInvalidTokenOpcode + !hasUnknownProgram covers "only burn + close
  // (and ComputeBudget) instructions". We split them into discrete bullets
  // per spec.
  const onlyBurnClose =
    !audit.hasInvalidTokenOpcode &&
    !audit.hasUnknownProgram &&
    audit.burnsPaired &&
    audit.burnCount > 0 &&
    audit.closeCount > 0;
  const noTransfers = !audit.hasTransfers;
  const burnMatches = audit.burnCount === result.burnCount;
  const closeMatches = audit.closeCount === result.burnCount;

  const items: { ok: boolean; label: React.ReactNode; failHint?: string }[] = [
    {
      ok: onlyBurnClose,
      label: "Only Burn + CloseAccount instructions (plus ComputeBudget)",
      failHint: audit.reason ?? undefined,
    },
    {
      ok: noTransfers,
      label: "No Transfer instructions",
      failHint: audit.hasTransfers ? "Transfer detected — destructive tx is off-spec" : undefined,
    },
    {
      ok: burnMatches,
      label: (
        <>
          Burn count matches preview ({audit.burnCount} ≡ {result.burnCount})
        </>
      ),
      failHint: !burnMatches
        ? `Tx has ${audit.burnCount} burn ix(s) but preview claims ${result.burnCount}`
        : undefined,
    },
    {
      ok: closeMatches,
      label: (
        <>
          CloseAccount count matches preview ({audit.closeCount} ≡{" "}
          {result.burnCount})
        </>
      ),
      failHint: !closeMatches
        ? `Tx has ${audit.closeCount} close ix(s) but preview claims ${result.burnCount}`
        : undefined,
    },
    {
      ok: ackDestructive,
      label: "Destructive action acknowledged (manual)",
    },
  ];

  return (
    <div className="border-b border-red-500/20 bg-red-500/[0.04] px-3 py-2">
      <div className="text-[10px] font-bold uppercase tracking-wider text-red-200">
        Burn safety checklist
      </div>
      <ul className="mt-1 divide-y divide-red-500/10">
        {items.map((item, i) => {
          const isAckRow = i === items.length - 1;
          return (
            <li
              key={i}
              className="flex items-start gap-2 py-1.5 text-[11px]"
            >
              {isAckRow ? (
                <input
                  type="checkbox"
                  checked={ackDestructive}
                  onChange={onToggleAck}
                  aria-label="Acknowledge destructive burn action"
                  className="mt-[2px] h-3.5 w-3.5 cursor-pointer accent-red-500"
                />
              ) : (
                <span
                  aria-hidden
                  className={`mt-[2px] inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full font-bold leading-none ${
                    item.ok
                      ? "bg-emerald-500/20 text-emerald-300"
                      : "bg-red-500/25 text-red-200"
                  }`}
                >
                  {item.ok ? "✓" : "✕"}
                </span>
              )}
              <span
                className={`min-w-0 flex-1 ${
                  item.ok ? "text-neutral-200" : "text-red-200"
                }`}
              >
                {item.label}
                {!item.ok && item.failHint && (
                  <span className="ml-1 text-red-300/80">— {item.failHint}</span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// =============================================================================
// Burn sign-and-send block.
//
// Shared between the four burn previews (SPL, Legacy NFT, pNFT, Core). Kept
// separate from the close-empty SignAndSendBlock because the gating shape
// AND the post-send confirmation flow differ:
//   - close-empty audits CloseAccount-only ixs and never asks the user to
//     acknowledge destruction;
//   - burn flows require a destructive-ack checkbox + audit that proves the
//     tx is the right kind of burn, pNFT/Core add a backend preflight
//     simulationOk gate, and after the wallet returns we poll the chain
//     ourselves to "confirmed" then "finalized" — Phantom's optimistic
//     return is NOT proof the tx landed.
//
// Sign is gated on ALL of the following:
//   1. transactionBase64 !== null
//   2. connected wallet matches `requiresSignatureFrom` AND `targetWallet`
//   3. audit passed (caller computes; we only display the boolean + reason)
//   4. ackDestructive === true
//   5. simulationOk !== false  (pNFT/Core only — caller passes null for SPL/Legacy)
//
// Post-send lifecycle: signing → submitted → confirmed → finalized (or
// error at any step). Once the state leaves "idle", the same built tx
// CANNOT be re-sent — the user must rebuild (which generates a fresh
// blockhash). Errors do not allow retry of the same tx.
// =============================================================================

// Burn-specific send state. Distinct from close-empty's SendState because
// the burn flow tracks two confirmation milestones: "confirmed" (in a
// confirmed block, can theoretically roll back) and "finalized" (cannot
// roll back; the tx is permanent on-chain).
type BurnSendState =
  | { status: "idle" }
  | { status: "signing" }
  | { status: "submitted"; signature: string }
  | { status: "confirmed"; signature: string }
  | { status: "finalized"; signature: string }
  | { status: "error"; signature?: string; error: string };
// Compact-mode status strip rendered in place of the full review /
// checklist / sign-block panel when the page-level sticky action bar
// owns the Burn flow. No accordion, no per-item table, no skipped-count
// list, no destructive-ack checkbox, no Sign-and-send button — just a
// one-liner that mirrors the in-flight state of the auto-fired sign:
//   • idle / preparing  →  "Preparing transaction…"
//   • signing           →  "Sign the transaction in your wallet"
//   • submitted         →  "Submitted · awaiting confirmation"
//   • confirmed         →  "Confirmed · awaiting finality"
//   • finalized         →  "Burned"
//   • error             →  inline error + Retry-by-rescan hint
// Pre-build gate failures (no tx / wallet mismatch / audit fail / sim
// fail / blockhash missing) render as a compact red one-liner so the
// user sees why the auto-fire didn't trigger.
function CompactSendStatus({
  kindLabel,
  send,
  canSend,
  noTx,
  targetMismatch,
  walletMismatch,
  auditPassed,
  ackOk,
  simulationFailed,
  simulationError,
  auditReason,
  requiresSignatureFrom,
  onWalletRescan,
  rescanPending,
}: {
  kindLabel: string;
  send: BurnSendState;
  canSend: boolean;
  noTx: boolean;
  targetMismatch: boolean;
  walletMismatch: boolean;
  auditPassed: boolean;
  ackOk: boolean;
  simulationFailed: boolean;
  simulationError?: string;
  auditReason: string | null;
  requiresSignatureFrom: string;
  onWalletRescan: () => void;
  rescanPending: boolean;
}) {
  // Pre-build / pre-sign gate failure — surface the reason inline so the
  // user knows why nothing fired automatically.
  let blocker: string | null = null;
  if (send.status === "idle" && !canSend) {
    if (noTx) blocker = `Preparing ${kindLabel} transaction…`;
    else if (targetMismatch) blocker = "Built tx target mismatch — rescan and retry.";
    else if (walletMismatch)
      blocker = `Connect wallet ${shortAddr(requiresSignatureFrom, 4, 4)} to sign.`;
    else if (!auditPassed)
      blocker = `Audit failed: ${auditReason ?? "unknown reason"}.`;
    else if (!ackOk)
      blocker = "Tick the destructive acknowledgement above to enable.";
    else if (simulationFailed)
      blocker = `Preflight rejected: ${simulationError ?? "unknown"}.`;
  }

  const statusLine = (() => {
    switch (send.status) {
      case "signing": return "Sign the transaction in your wallet…";
      case "submitted": return "Submitted · awaiting confirmation";
      case "confirmed": return "Confirmed on chain · awaiting finality";
      case "finalized": return `Burned ${kindLabel}`;
      case "error": return null;
      case "idle":
      default:
        return canSend ? "Preparing transaction…" : null;
    }
  })();

  if (send.status === "error") {
    return (
      <div className="border-t border-[rgba(239,120,120,0.30)] bg-[rgba(239,120,120,0.06)] px-3 py-2 text-[11px] text-[color:var(--vl-red)]">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">Send failed:</span>
          <span className="break-all">{send.error}</span>
          <button
            type="button"
            onClick={onWalletRescan}
            disabled={rescanPending}
            className="ml-auto rounded-md border border-[color:var(--vl-border)] bg-transparent px-2 py-0.5 text-[10px] font-semibold text-[color:var(--vl-fg-2)] transition-all duration-[var(--vl-motion,180ms)] hover:border-[var(--vl-purple)] hover:text-[color:var(--vl-purple-2)] disabled:opacity-60"
          >
            {rescanPending ? "Refreshing…" : "Rescan & retry"}
          </button>
        </div>
      </div>
    );
  }

  if (blocker) {
    return (
      <div className="border-t border-[color:var(--vl-border)] bg-[rgba(168,144,232,0.04)] px-3 py-1.5 text-[11px] text-[color:var(--vl-fg-2)]">
        {blocker}
      </div>
    );
  }

  if (!statusLine) return null;
  return (
    <div className="border-t border-[color:var(--vl-border)] bg-[rgba(168,144,232,0.05)] px-3 py-1.5 text-[11px] text-[color:var(--vl-fg-2)]">
      <span className="inline-flex items-center gap-2">
        <Spinner />
        <span>{statusLine}</span>
      </span>
    </div>
  );
}

function BurnSignAndSendBlock({
  kindLabel,
  transactionBase64,
  blockhash,
  lastValidBlockHeight,
  requiresSignatureFrom,
  targetWallet,
  auditPassed,
  auditReason,
  simulationOk,
  simulationRequired = false,
  simulationError,
  ackDestructive,
  onToggleAck,
  showAckCheckbox,
  onWalletRescan,
  rescanPending,
  onBuildNext,
  nextBatchRemaining,
  onBurned,
}: {
  kindLabel: string;
  transactionBase64: string | null;
  // Carried from the build response. lastValidBlockHeight is NOT part of
  // the on-wire tx message — Transaction.serialize() drops it — so we
  // can't recover it from `transactionBase64` after a round-trip. Both
  // null whenever transactionBase64 is null. Optional so a future caller
  // that forgets to pass them gets the runtime "Rebuild transaction and
  // try again." guard instead of a hard build error; today every caller
  // (SPL, Legacy, pNFT, Core previews) passes them.
  blockhash?: string | null;
  lastValidBlockHeight?: number | null;
  requiresSignatureFrom: string;
  targetWallet: string;
  auditPassed: boolean;
  auditReason: string | null;
  simulationOk: boolean | null;
  // Strict mode: when true (pNFT / Core), simulationOk MUST be true to
  // pass the safety gate — null is treated as "not simulated → BLOCK".
  // Default false preserves SPL / Legacy behaviour where null is OK.
  simulationRequired?: boolean;
  simulationError?: string;
  ackDestructive: boolean;
  onToggleAck: () => void;
  showAckCheckbox: boolean;
  onWalletRescan: () => void;
  rescanPending: boolean;
  // Optional — only Legacy/pNFT/Core previews supply these. Provided when
  // the current build's `nextBatchCandidates` is non-empty so the user can
  // continue burning without rescanning between batches.
  onBuildNext?: () => void;
  nextBatchRemaining?: number;
  // Fired exactly once per send when the tx reaches `finalized` on chain.
  // Lets the parent section strip the just-burned items from its
  // discovery list + selection set so the user doesn't see them as
  // candidates anymore. We don't take the burned IDs as an argument —
  // each preview already knows which ids it built the tx for and binds
  // them via closure.
  onBurned?: () => void;
}) {
  const w = useWallet();
  // Compact mode = standalone /burner. In that mode the sticky page-level
  // action bar owns the destructive ack and dispatches the build click,
  // so this block becomes a headless auto-sign engine: it skips its own
  // visible UI (no review panel, no checklist, no sign button) and
  // auto-fires sign on mount once the gates pass.
  const isCompact = useCompactMode();
  const pageAck = useBurnAck();
  // When compact, the sticky bar's persistent ack checkbox supplies the
  // destructive acknowledgement instead of the in-section checkbox.
  const effectiveAck = isCompact ? pageAck : ackDestructive;
  const [send, setSend] = useState<BurnSendState>({ status: "idle" });
  // Belt-and-braces guard against the rare double-click race: a user can
  // physically click twice before React re-renders the disabled state.
  // For an irreversible burn we never want two `signAndSendTransaction`
  // calls in flight, so the ref short-circuits subsequent invocations
  // synchronously inside the click handler.
  const inFlightRef = useRef(false);
  // Stash onBurned in a ref so the post-finalize useEffect doesn't need
  // it in its dep array (its identity changes every render because it's
  // a closure over the parent's candidates state).
  const onBurnedRef = useRef(onBurned);
  onBurnedRef.current = onBurned;
  // Single-shot guard: ensure onBurned() fires exactly once per send,
  // even if React re-renders the block between "finalized" and unmount.
  const burnedFiredRef = useRef(false);
  // Defence: if the parent ever feeds this same component instance a
  // fresh `transactionBase64` (a new build for the next batch) without
  // an unmount in between, we must re-arm the single-shot. Today the
  // build state machine always passes through `loading` which unmounts
  // the preview, but a future code path that swaps tx in place would
  // otherwise silently lose the onBurned fire for batch #2.
  useEffect(() => {
    burnedFiredRef.current = false;
  }, [transactionBase64]);

  // On confirmed: fire the parent's `onBurned` callback so the section
  // can strip the just-burned ids from its discovery list + selection
  // set, AND reset build state so the user can immediately queue more.
  // We fire on "confirmed" (not "finalized") because finalized takes
  // 20-30s on mainnet (32 slots) and the user can't continue burning
  // until then. At "confirmed" the tx is already in a confirmed block —
  // a rollback is theoretically possible but vanishingly rare.
  // Single-shot via `burnedFiredRef`.
  //
  // Same effect also kicks the backend's 10-minute scan cache for this
  // wallet (fire-and-forget): subsequent build calls will re-scan
  // on-chain instead of trusting cached token-account data that still
  // includes the just-burned mints. Without this, "Build next batch"
  // would re-discover already-burned items as candidates until the
  // 10-min TTL expires. The full-clean SPL loop already does this
  // explicitly; doing it here covers Legacy/pNFT/Core/SPL burn flows.
  useEffect(() => {
    if (send.status !== "confirmed" && send.status !== "finalized") return;
    if (burnedFiredRef.current) return;
    burnedFiredRef.current = true;
    onBurnedRef.current?.();
    // Fire-and-forget cache invalidation. Errors are logged but
    // never propagated — a failed refresh just means the next build
    // gets stale data, which is the pre-fix status quo.
    api
      .getCleanupScan(targetWallet, { refresh: true })
      .catch((err) =>
        console.warn(
          "[burnSend] post-confirm scan refresh failed",
          err instanceof Error ? err.message : err,
        ),
      );
  }, [send.status, targetWallet]);

  const noTx = transactionBase64 === null;
  const walletMismatch =
    w.connected !== null && w.connected !== requiresSignatureFrom;
  const targetMismatch = targetWallet !== requiresSignatureFrom;
  const cleanedVsConnectedMismatch =
    w.connected !== null && w.connected !== targetWallet;
  // Anything past "idle" means a send is in flight or done; the same built
  // tx must NEVER be re-broadcast (its blockhash is single-use). To retry,
  // the user rebuilds — which unmounts this block and remounts a fresh
  // instance with a new blockhash from the backend.
  const alreadyUsed = send.status !== "idle";
  const simulationFailed = simulationOk === false;

  const checks = {
    walletMatches:
      w.connected !== null && w.connected === targetWallet && !walletMismatch,
    auditPassed,
    // `effectiveAck` is the page-level ack in compact mode, the in-section
    // ack checkbox in default mode. Either way, an unticked ack still
    // blocks send — the safety gate is preserved, just sourced differently.
    ackDestructive: effectiveAck,
    // pNFT / Core require an explicit `simulationOk === true`; SPL / Legacy
    // tolerate `null` (== "not simulated, assume ok").
    simulationOk: simulationRequired
      ? simulationOk === true
      : simulationOk !== false,
  };
  const checklistPassed =
    checks.walletMatches &&
    checks.auditPassed &&
    checks.ackDestructive &&
    checks.simulationOk;

  const canSend =
    !alreadyUsed && !noTx && !targetMismatch && checklistPassed;

  async function handleSignAndSend() {
    // Synchronous double-click guard — must be the FIRST statement (no
    // awaits before this) so a second click queued before the disabled
    // state paints can never start a parallel sign.
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    let signature: string | undefined;
    try {
      if (!canSend || transactionBase64 === null) return;
      const provider = getProvider();
      if (!provider) {
        setSend({ status: "error", error: "No wallet provider available." });
        return;
      }
      setSend({ status: "signing" });

      // Step 1: decode the tx + sanity-check the build metadata. The
      // blockhash + lastValidBlockHeight come from the SAME getLatestBlockhash()
      // call the backend used at serialize-time. lastValidBlockHeight is NOT
      // part of the on-wire tx message, so we can't read it back from the
      // decoded transaction — backend must surface both via response props.
      const tx = decodeBase64Transaction(transactionBase64);
      if (
        !blockhash ||
        lastValidBlockHeight === null ||
        lastValidBlockHeight === undefined
      ) {
        throw new Error("Rebuild transaction and try again.");
      }
      // Defence-in-depth: verify the decoded tx is actually for the wallet
      // we expect to sign. Catches any builder/middleware bug that swapped
      // the feePayer between the build response and what the user sees.
      const decodedFeePayer = tx.feePayer?.toBase58();
      if (decodedFeePayer !== requiresSignatureFrom) {
        throw new Error(
          `Built transaction feePayer ${decodedFeePayer ?? "<missing>"} does not match required signer ${shortAddr(requiresSignatureFrom, 4, 4)}. Rebuild and try again.`,
        );
      }
      if (w.connected !== requiresSignatureFrom) {
        throw new Error(
          `Connected wallet ${shortAddr(w.connected ?? "<none>", 4, 4)} does not match required signer ${shortAddr(requiresSignatureFrom, 4, 4)}.`,
        );
      }

      // Step 2: sign in the wallet, then broadcast through OUR RPC.
      // We deliberately avoid `signAndSendTransaction` because Phantom's
      // built-in RPC has been returning intermittent 403s (Helius shared
      // tier rate-limit). Sending the raw signed bytes through our own
      // Connection sidesteps that entirely.
      const connection = getConnection();
      const signed = await provider.signTransaction(tx);
      signature = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
        maxRetries: 5,
      });
      setSend({ status: "submitted", signature });
      console.log("[burnSend] submitted", {
        kind: kindLabel,
        signature,
        blockhash,
        lastValidBlockHeight,
      });

      // Step 3+4: confirmation via HTTP polling of getSignatureStatuses.
      // We deliberately avoid Connection.confirmTransaction because it
      // relies on websocket subscriptions, which the public mainnet RPC
      // (and many gated providers) drop — leaving the UI hung at
      // "submitted" forever even though the tx already landed.
      // Polls every 2s up to ~90s; bails when the blockhash expires.
      //
      // RPC budget: at 90s with a 2s interval, getSignatureStatuses fires
      // up to 45×. getBlockHeight only fires every 5th iteration (~10s)
      // — blockhash expiry is a slot-window event (~60-90s end-to-end),
      // so 10s resolution is more than enough to bail before the user
      // sits on a doomed tx. Cuts our hot-path RPC volume per send
      // roughly in half.
      let confirmedSeen = false;
      const pollStart = Date.now();
      const POLL_TIMEOUT_MS = 90_000;
      const POLL_INTERVAL_MS = 2_000;
      const BLOCKHEIGHT_CHECK_EVERY = 5;
      let iter = 0;
      while (Date.now() - pollStart < POLL_TIMEOUT_MS) {
        const statuses = await connection.getSignatureStatuses([signature]);
        const st = statuses.value[0];
        if (st) {
          if (st.err) {
            throw new Error(
              `Tx failed on chain: ${JSON.stringify(st.err)}`,
            );
          }
          const cs = st.confirmationStatus;
          if (!confirmedSeen && (cs === "confirmed" || cs === "finalized")) {
            confirmedSeen = true;
            setSend({ status: "confirmed", signature });
            console.log("[burnSend] confirmed", {
              kind: kindLabel,
              signature,
              slot: st.slot,
            });
          }
          if (cs === "finalized") {
            setSend({ status: "finalized", signature });
            console.log("[burnSend] finalized", {
              kind: kindLabel,
              signature,
              slot: st.slot,
            });
            break;
          }
        }
        // Blockhash-expiry bail. Cheaper to cap this RPC than to fire it
        // every 2s — see budget comment above. Skips entirely once we've
        // seen the tx confirm (expiry no longer matters at that point).
        if (!confirmedSeen && iter % BLOCKHEIGHT_CHECK_EVERY === 0) {
          const currentHeight = await connection.getBlockHeight("confirmed");
          if (currentHeight > lastValidBlockHeight) {
            throw new Error(
              "Transaction expired before landing (blockhash window passed).",
            );
          }
        }
        iter++;
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
      if (!confirmedSeen) {
        throw new Error(
          "Timed out waiting for confirmation. Check Solscan for the signature.",
        );
      }
    } catch (err) {
      setSend({
        status: "error",
        signature,
        error: prettifyWalletError(err),
      });
      console.warn("[burnSend] failed", {
        kind: kindLabel,
        signature,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      inFlightRef.current = false;
    }
  }

  // Compact-mode auto-fire. The page-level sticky bar already gated on
  // ack + selection before clicking the section's hidden trigger button
  // — so the moment the build response props arrive (transactionBase64
  // is non-null + audit + simulation + blockhash all green), we sign
  // automatically. The same `canSend` gate the visible button used in
  // default mode runs here too, so every safety check still applies.
  // The `inFlightRef` short-circuit inside handleSignAndSend prevents
  // any duplicate dispatch if React re-renders between mount and effect.
  const autoFireRef = useRef(false);
  useEffect(() => {
    if (!isCompact) return;
    if (autoFireRef.current) return;
    if (!canSend) return;
    autoFireRef.current = true;
    void handleSignAndSend();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCompact, canSend]);

  // Compact-mode UI: skip the entire review/checklist/details panel +
  // sign button. Render only a slim status strip so the user sees
  // "Preparing… → Sign in wallet → Confirming → Done" inline near the
  // section, plus a compact error inline if the build/sign fails.
  if (isCompact) {
    return (
      <CompactSendStatus
        kindLabel={kindLabel}
        send={send}
        canSend={canSend}
        noTx={noTx}
        targetMismatch={targetMismatch}
        walletMismatch={walletMismatch}
        auditPassed={auditPassed}
        ackOk={effectiveAck}
        simulationFailed={simulationFailed}
        simulationError={simulationError}
        auditReason={auditReason}
        requiresSignatureFrom={requiresSignatureFrom}
        onWalletRescan={onWalletRescan}
        rescanPending={rescanPending}
      />
    );
  }

  return (
    <div className="border-t border-red-500/30 bg-red-950/20">
      {cleanedVsConnectedMismatch && (
        <div className="border-b border-red-500/20 bg-amber-500/5 px-3 py-1.5 text-[11px] text-amber-300">
          ⚠ Connected wallet must match the wallet being burned.{" "}
          <span className="text-amber-200/80">
            Connected: <span className="font-mono">{shortAddr(w.connected!, 4, 4)}</span>
            {" · "}target: <span className="font-mono">{shortAddr(targetWallet, 4, 4)}</span>
          </span>
        </div>
      )}
      {showAckCheckbox && (
        <label className="flex cursor-pointer items-start gap-2 border-b border-red-500/20 bg-red-500/[0.04] px-3 py-2 text-[11px]">
          <input
            type="checkbox"
            checked={ackDestructive}
            onChange={onToggleAck}
            aria-label={`Acknowledge destructive ${kindLabel}`}
            className="mt-[2px] h-3.5 w-3.5 cursor-pointer accent-red-500"
          />
          <span className="text-red-200">
            I understand this {kindLabel} is destructive and irreversible.
          </span>
        </label>
      )}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        {!w.connected ? (
          <button
            type="button"
            onClick={() => void w.connect()}
            disabled={w.connecting}
            aria-label="Connect wallet to sign burn"
            className={signSendButtonClass(w.connecting ? "loading" : "idle")}
          >
            {w.connecting ? (
              <>
                <Spinner /> Connecting…
              </>
            ) : (
              "Connect wallet to sign"
            )}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void handleSignAndSend()}
            disabled={!canSend}
            aria-label={`Sign and send ${kindLabel} transaction`}
            className={signSendButtonClass(
              send.status === "submitted" ||
                send.status === "confirmed" ||
                send.status === "finalized"
                ? "sent"
                : send.status === "signing"
                ? "loading"
                : !canSend
                ? "blocked"
                : "idle",
            )}
            title={
              alreadyUsed
                ? "This transaction has been used. Rebuild to retry."
                : noTx
                ? "Nothing to send — transactionBase64 is null"
                : !checks.walletMatches
                ? `Connected wallet must match ${shortAddr(requiresSignatureFrom, 4, 4)}`
                : !checks.auditPassed
                ? auditReason ?? "Client-side audit failed"
                : simulationFailed
                ? `Preflight rejected: ${simulationError ?? "unknown"}`
                : !checks.ackDestructive
                ? "Acknowledge the destructive action to enable signing"
                : undefined
            }
          >
            {send.status === "signing" ? (
              <>
                <Spinner /> Awaiting wallet…
              </>
            ) : send.status === "submitted" ? (
              <>
                <Spinner /> Confirming…
              </>
            ) : send.status === "confirmed" ? (
              <>
                <Spinner /> Finalizing…
              </>
            ) : send.status === "finalized" ? (
              "Finalized ✓"
            ) : send.status === "error" ? (
              "Send failed"
            ) : (
              "Sign & send burn transaction"
            )}
          </button>
        )}
        {/* Auto-advance status — visible only between finalize and the
            next preview rendering. The useEffect above triggers the next
            build after 1.5s so the user sees a brief "Finalized ✓" before
            the next batch's preview loads. */}
        {send.status === "finalized" &&
          onBuildNext &&
          nextBatchRemaining !== undefined &&
          nextBatchRemaining > 0 && (
            <span className="text-[11px] text-emerald-300/80">
              {nextBatchRemaining} more selected — preparing next batch…
            </span>
          )}
        {alreadyUsed && (
          <button
            type="button"
            onClick={onWalletRescan}
            disabled={rescanPending}
            aria-label="Rescan wallet"
            className={signSendButtonClass(
              rescanPending ? "loading-secondary" : "secondary",
            )}
          >
            {rescanPending ? (
              <>
                <Spinner /> Rescanning…
              </>
            ) : (
              "Rescan wallet"
            )}
          </button>
        )}
        {!alreadyUsed && noTx && (
          <span className="text-[11px] text-red-300/80">
            Nothing to send — rebuild the transaction.
          </span>
        )}
        {!alreadyUsed && !noTx && !checks.walletMatches && (
          <span className="text-[11px] text-red-300">
            Connect{" "}
            <span className="font-mono">
              {shortAddr(requiresSignatureFrom, 4, 4)}
            </span>{" "}
            to enable signing.
          </span>
        )}
        {!alreadyUsed && !noTx && simulationFailed && (
          <span className="text-[11px] text-red-300">
            Preflight failed — sign blocked.
          </span>
        )}
        {!alreadyUsed && !noTx && !checks.ackDestructive && (
          <span className="text-[11px] text-red-300/80">
            Acknowledge to sign.
          </span>
        )}
      </div>

      {(send.status === "submitted" ||
        send.status === "confirmed" ||
        send.status === "finalized") && (
        <BurnSendProgress
          stage={send.status}
          signature={send.signature}
        />
      )}

      {send.status === "error" && (
        <div className="border-t border-red-500/20 bg-red-500/5 px-3 py-2 text-xs">
          <div className="text-red-400">
            <span className="font-semibold">Send failed:</span> {send.error}
          </div>
          {send.signature && (
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
              <span className="text-neutral-400">Last signature:</span>
              <span className="font-mono text-neutral-200">
                {shortAddr(send.signature, 8, 8)}
              </span>
              <a
                href={solscanTxUrl(send.signature)}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-violet-300 hover:text-violet-200"
              >
                Check on Solscan ↗
              </a>
            </div>
          )}
          <div className="mt-1 text-[11px] text-red-300/80">
            The built tx cannot be re-sent (blockhash consumed). Rebuild to
            try again.
          </div>
        </div>
      )}
    </div>
  );
}

// Staged confirmation strip rendered between the "Sign" button and the
// final "Finalized ✓" state. Three milestones, each shown with a label and
// an emerald check once reached. The signature + Solscan link are visible
// from the "submitted" stage onward so the user can verify on-chain progress.
function BurnSendProgress({
  stage,
  signature,
}: {
  stage: "submitted" | "confirmed" | "finalized";
  signature: string;
}) {
  const reached = (s: "submitted" | "confirmed" | "finalized"): boolean => {
    if (stage === "finalized") return true;
    if (stage === "confirmed") return s !== "finalized";
    return s === "submitted";
  };
  const stages: Array<{ key: "submitted" | "confirmed" | "finalized"; label: string }> = [
    { key: "submitted", label: "Submitted to wallet" },
    { key: "confirmed", label: "Confirmed on chain" },
    { key: "finalized", label: "Finalized" },
  ];
  return (
    <div className="border-t border-red-500/20 bg-emerald-500/[0.04] px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={stage === "finalized" ? "buy" : "neutral"}>
          {stage === "finalized" ? "Finalized" : stage === "confirmed" ? "Confirmed" : "Submitted"}
        </Badge>
        <span className="text-neutral-300">Tx signature:</span>
        <span className="font-mono text-[11px] text-neutral-100">
          {shortAddr(signature, 8, 8)}
        </span>
        <a
          href={solscanTxUrl(signature)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[11px] font-semibold text-violet-300 hover:text-violet-200"
        >
          View on Solscan ↗
        </a>
      </div>
      <ol className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
        {stages.map((s, i) => {
          const ok = reached(s.key);
          const current = s.key === stage && stage !== "finalized";
          return (
            <li key={s.key} className="flex items-center gap-1.5">
              {i > 0 && (
                <span className="text-neutral-600" aria-hidden>
                  →
                </span>
              )}
              <span
                aria-hidden
                className={`inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full text-[9px] font-bold ${
                  ok
                    ? "bg-emerald-500/25 text-emerald-200"
                    : "bg-neutral-800 text-neutral-500"
                }`}
              >
                {ok ? "✓" : "·"}
              </span>
              <span
                className={
                  current
                    ? "text-amber-200"
                    : ok
                    ? "text-emerald-200"
                    : "text-neutral-500"
                }
              >
                {s.label}
                {current && "…"}
              </span>
            </li>
          );
        })}
      </ol>
      {stage !== "finalized" && (
        <div className="mt-1 text-[11px] text-neutral-500">
          The wallet returned the signature; we&apos;re polling our RPC to
          verify the tx landed. Don&apos;t close this tab.
        </div>
      )}
      {stage === "finalized" && (
        <div className="mt-1 text-[11px] text-emerald-300/80">
          The tx is permanently on-chain. Rescan the wallet to refresh
          balances and build the next batch.
        </div>
      )}
    </div>
  );
}

// Diagnostic badge for the build response's blockhash + lastValidBlockHeight.
// Surfaced in each preview's Transaction details disclosure so we can confirm
// at a glance that the backend supplied both fields. If either is missing the
// frontend's BurnSignAndSendBlock will refuse to broadcast (see the guard in
// handleSignAndSend) — this badge makes the cause visible without needing
// devtools.
function presenceBadge(present: boolean): React.ReactNode {
  return present ? (
    <span className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold text-emerald-300 ring-1 ring-emerald-500/30">
      ✓ yes
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] font-bold text-red-300 ring-1 ring-red-500/30">
      ✕ no
    </span>
  );
}

// Read-only preview for the burn-and-close transaction. Visually red /
// destructive — distinct from the violet close-empty preview so the user
// can never confuse the two flows.
function BurnTxPreview({
  result,
  walletAddress,
  onWalletRescan,
  rescanPending,
  onBurned,
}: {
  result: BuildBurnAndCloseTxResult;
  walletAddress: string;
  onWalletRescan: () => void;
  rescanPending: boolean;
  onBurned?: (mints: string[]) => void;
}) {
  const isCompact = useCompactMode();
  // Audit the actual bytes the backend produced. The check is memoised on
  // the base64 string so the panel doesn't redo the deserialize on every
  // re-render of the parent (which happens every checkbox toggle).
  const audit: BurnAuditResult | null = useMemo(() => {
    if (result.transactionBase64 === null) return null;
    return auditBurnAndCloseTx(result.transactionBase64);
  }, [result.transactionBase64]);

  // The acknowledgement checkbox is a per-preview UI gate that doesn't
  // gate any action (no sign/send is wired here yet) but is part of the
  // safety checklist contract per the task spec.
  const [ackDestructive, setAckDestructive] = useState(false);
  const tx = result.transactionBase64;
  const txShort =
    tx === null
      ? "—"
      : tx.length > 80
      ? `${tx.slice(0, 40)}…${tx.slice(-20)} (${tx.length} chars)`
      : tx;
  const rows: { label: string; value: React.ReactNode; mono?: boolean }[] = [
    {
      label: "blockhash present",
      value: presenceBadge(Boolean(result.blockhash)),
    },
    {
      label: "lastValidBlockHeight present",
      value: presenceBadge(
        result.lastValidBlockHeight !== null &&
          result.lastValidBlockHeight !== undefined,
      ),
    },
    {
      label: "Burn count",
      value: (
        <span className="font-bold text-red-200">
          {result.burnCount}
          <span className="ml-1 text-red-300/70">
            / {result.totalBurnable} candidate
            {result.totalBurnable === 1 ? "" : "s"}
          </span>
        </span>
      ),
    },
    {
      label: "Included accounts",
      value: (
        <span className="font-bold text-white">
          {result.includedAccounts.length}
        </span>
      ),
    },
    {
      label: "Skipped accounts",
      value: (
        <span className="text-white">
          {result.skippedAccounts}
          {result.skippedAccounts > 0 && (
            <span className="ml-1 text-neutral-500">
              (limit {result.maxAccountsPerTx} per tx)
            </span>
          )}
        </span>
      ),
    },
    {
      label: "Gross reclaim",
      value: (
        <span className="font-bold text-emerald-300">
          {fmtSol(result.estimatedReclaimSol)} SOL
        </span>
      ),
    },
    {
      label: "Estimated network fee",
      value: (
        <span className="text-neutral-200">
          {fmtSol(result.estimatedFeeSol)} SOL
          <span className="ml-1 text-[10px] text-neutral-500">
            (base {fmtSol(result.estimatedBaseFeeSol)}
            {result.estimatedPriorityFeeSol > 0 && (
              <> + priority {fmtSol(result.estimatedPriorityFeeSol)}</>
            )}
            ; {result.computeUnitLimit.toLocaleString()} CU
            {result.priorityFeeMicrolamports > 0 && (
              <> @ {result.priorityFeeMicrolamports} μL/CU</>
            )}
            )
          </span>
        </span>
      ),
    },
    {
      label: "Estimated net received",
      value: (
        <span className="font-bold text-emerald-300">
          {fmtSol(result.estimatedNetReclaimSol)} SOL
        </span>
      ),
    },
    {
      label: "Tx version",
      value: <Badge variant="info">{result.transactionVersion}</Badge>,
    },
    { label: "Fee payer", value: result.feePayer, mono: true },
    {
      label: "Requires signature from",
      value: result.requiresSignatureFrom,
      mono: true,
    },
    {
      label: "Transaction (base64)",
      value: txShort,
      mono: true,
    },
  ];
  const burnBlock = (
    <BurnSignAndSendBlock
      kindLabel="SPL burn"
      transactionBase64={result.transactionBase64}
      blockhash={result.blockhash}
      lastValidBlockHeight={result.lastValidBlockHeight}
      requiresSignatureFrom={result.requiresSignatureFrom}
      targetWallet={walletAddress}
      auditPassed={audit?.ok === true}
      auditReason={audit?.reason ?? null}
      simulationOk={result.simulationOk}
      simulationError={result.simulationError}
      ackDestructive={ackDestructive}
      onToggleAck={() => setAckDestructive((v) => !v)}
      showAckCheckbox={false}
      onWalletRescan={onWalletRescan}
      rescanPending={rescanPending}
      onBurned={() =>
        onBurned?.(result.includedAccounts.map((a) => a.mint))
      }
    />
  );
  if (isCompact) return burnBlock;
  return (
    <div className="border-t border-red-500/30 bg-red-950/30">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-red-500/30 bg-red-600/15 px-3 py-1.5">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-[10px] font-bold uppercase tracking-wider text-red-200">
            🔥 Burn + close
          </span>
          <span className="text-[11px] font-semibold text-red-100">
            {result.burnCount} selected
          </span>
          <span className="text-[10px] text-red-300/80">
            · net{" "}
            <span className="font-bold text-emerald-300">
              {fmtSol(result.estimatedNetReclaimSol)} SOL
            </span>
          </span>
        </div>
        <Badge variant="sell">manual sign · destructive</Badge>
      </div>
      {result.warning && (
        <div className="border-b border-red-500/15 bg-amber-500/5 px-3 py-1 text-[11px] text-amber-300">
          ⚠ {result.warning}
        </div>
      )}
      <BurnSafetyChecklist
        result={result}
        audit={audit}
        ackDestructive={ackDestructive}
        onToggleAck={() => setAckDestructive((v) => !v)}
      />
      {burnBlock}
      <details className="group border-t border-red-500/15">
        <summary className="cursor-pointer list-none bg-red-500/[0.03] px-3 py-1.5 text-[11px] font-semibold text-red-300/80 transition-colors duration-100 hover:bg-red-500/10">
          <span className="inline-block w-3 transition-transform group-open:rotate-90">
            ▸
          </span>{" "}
          Transaction details
        </summary>
        <dl className="divide-y divide-red-500/15">
          {rows.map((r) => (
            <div
              key={r.label}
              className="grid grid-cols-12 items-center gap-3 px-3 py-1.5 text-xs"
            >
              <dt className="col-span-4 text-red-300/80">{r.label}</dt>
              <dd
                className={`col-span-8 min-w-0 break-all ${
                  r.mono
                    ? "font-mono text-[11px] text-neutral-100"
                    : "text-neutral-100"
                }`}
              >
                {r.value}
              </dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}

// =============================================================================
// Legacy Metaplex NFT burn — Milestone 1 preview UI.
// Two-phase: (1) discovery call with no mints filter on mount populates the
// candidate list; (2) build call with selected mints produces the actual
// preview tx. Both calls hit POST /legacy-nft-burn-tx. NO sign/send wired.
// =============================================================================

type LegacyDiscoverState =
  | { status: "loading" }
  | { status: "ready"; result: BuildLegacyNftBurnTxResult }
  | { status: "error"; error: string }
  | { status: "empty" }; // no NFT accounts at all

type LegacyBuildState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; result: BuildLegacyNftBurnTxResult }
  | { status: "error"; error: string };

function LegacyNftBurnSection({
  walletAddress,
  nftAccountCount,
  collapsed,
  onToggle,
  onWalletRescan,
  rescanPending,
  visible = true,
}: {
  walletAddress: string;
  nftAccountCount: number;
  collapsed: boolean;
  onToggle: () => void;
  onWalletRescan: () => void;
  rescanPending: boolean;
  // Optional perf gate. Caller (CleanerDetails) sets to false when the
  // section is in a `<div hidden>` parent (e.g. the user is on a
  // different /burner tab). Discovery effect + state still run so
  // we don't refetch on tab switch — only the heavy candidate grid is
  // skipped. Defaults to true so /groups/[id]?tab=cleaner (always-show
  // mode) keeps its existing behaviour.
  visible?: boolean;
}) {
  const isCompact = useCompactMode();
  const [discover, setDiscover] = useState<LegacyDiscoverState>(
    nftAccountCount === 0 ? { status: "empty" } : { status: "loading" },
  );
  const [build, setBuild] = useState<LegacyBuildState>({ status: "idle" });
  const [buildPending, startBuildTransition] = useTransition();
  const [selectedMints, setSelectedMints] = useState<Set<string>>(new Set());
  // Cancel handle for any in-flight discovery so the unmount path / retry
  // click never races with a stale response landing into setDiscover.
  const discoverCancelRef = useRef<(() => void) | null>(null);

  // Section-scoped discovery. Called once on mount and again on Retry. Does
  // not trigger a wallet rescan — only re-fires this section's backend
  // discovery call. Selection is cleared because a new discovery may not
  // include the previously-selected mints.
  const runDiscover = useCallback(() => {
    if (nftAccountCount === 0) {
      setDiscover({ status: "empty" });
      return;
    }
    discoverCancelRef.current?.();
    let cancelled = false;
    discoverCancelRef.current = () => {
      cancelled = true;
    };
    setDiscover({ status: "loading" });
    setSelectedMints(new Set());
    setBuild({ status: "idle" });
    (async () => {
      const res = await buildLegacyNftBurnTxAction(walletAddress, []);
      if (cancelled) return;
      if (res.ok) setDiscover({ status: "ready", result: res.result });
      else setDiscover({ status: "error", error: res.error });
    })();
  }, [walletAddress, nftAccountCount]);

  // Discovery: one call with no mints on mount. Captures the candidate list
  // (includedNfts have full metadata; cap-skipped entries surface mint only).
  // We deliberately ignore the discovery call's `transactionBase64` — that's
  // a side-effect of the backend always building a tx for the first ≤3
  // burnable NFTs. The user's *real* preview comes from the Build phase.
  useEffect(() => {
    runDiscover();
    return () => {
      discoverCancelRef.current?.();
    };
  }, [runDiscover]);

  // Report this section's discovery to the parent reclaim-summary panel.
  // We use per-NFT × totalBurnable as the upper bound (matches this card's
  // own header). Legacy BurnV1 has no preflight gate, so there's no
  // "rejected" path here.
  const legacyEntry: ReclaimEntry = (() => {
    if (discover.status === "loading")
      return { value: null, status: "loading" };
    if (discover.status === "error")
      return { value: null, status: "error" };
    if (discover.status === "empty")
      return { value: 0, status: "empty" };
    const r = discover.result;
    if (r.totalBurnable === 0) return { value: 0, status: "empty" };
    const per = r.includedNfts[0]?.estimatedGrossReclaimSol ?? 0;
    return { value: per * r.totalBurnable, status: "ready" };
  })();
  useReportReclaim("legacyNft", legacyEntry);

  // Two buckets from discovery:
  //   1. burnable    — full burnableCandidates list from backend. Every
  //                    selectable row in the table comes from here.
  //   2. nonBurnable — actually unsupported (wrong token standard, missing
  //                    metadata, etc.). Grouped by reason for compact display.
  // The current-tx batch (includedNfts) is consumed by the preview, not
  // by this table.
  // Mints already burned in this session. Filtered out of `candidates`
  // below so the just-burned NFTs disappear from the selection grid the
  // moment their tx finalizes (no rescan required). Cleared only when
  // discovery re-runs (which re-mounts state).
  const [burnedMints, setBurnedMints] = useState<Set<string>>(new Set());
  const handleBurned = useCallback((mints: string[]) => {
    if (mints.length === 0) return;
    setBurnedMints((prev) => {
      const next = new Set(prev);
      for (const m of mints) next.add(m);
      return next;
    });
    setSelectedMints((prev) => {
      const next = new Set(prev);
      for (const m of mints) next.delete(m);
      return next;
    });
    // Drop the build preview so the user doesn't see stale tx state
    // pointing at mints that no longer exist on-chain.
    setBuild({ status: "idle" });
  }, []);

  const candidates = useMemo(() => {
    if (discover.status !== "ready") return null;
    const burnable = discover.result.burnableCandidates
      .filter((c) => !burnedMints.has(c.mint))
      .map((c) => ({
        mint: c.mint,
        tokenAccount: c.tokenAccount,
        name: c.name,
        symbol: c.symbol,
        image: c.image,
        collection: c.collection,
        estimatedGrossReclaimSol: c.estimatedGrossReclaimSol as number | null,
      }));
    // Defensive: if a future backend reverts to pushing cap-overflow into
    // skipped, exclude them from nonBurnable.
    const nonBurnable = discover.result.skippedNfts.filter(
      (s) =>
        !(s.reason.startsWith("Cap of") || s.reason.startsWith("Trimmed to fit")),
    );
    return { burnable, nonBurnable };
  }, [discover, burnedMints]);

  // Stable across renders so the memoized BurnCandidateCard children
  // skip re-render when other items toggle. setSelectedMints from
  // useState already has a stable identity.
  const toggleSelected = useCallback((mint: string): void => {
    setSelectedMints((prev) => {
      const next = new Set(prev);
      if (next.has(mint)) next.delete(mint);
      else next.add(mint);
      return next;
    });
  }, []);

  // Parameterised so the "Build next batch" button can request a build
  // for an explicit mint subset (the leftover from the prior batch's
  // nextBatchCandidates) instead of the user's full selection set.
  function handleBuildBatch(mints: string[]): void {
    if (mints.length === 0) return;
    setBuild({ status: "loading" });
    startBuildTransition(async () => {
      const res = await buildLegacyNftBurnTxAction(walletAddress, mints);
      if (res.ok) setBuild({ status: "ready", result: res.result });
      else setBuild({ status: "error", error: res.error });
    });
  }

  function handleBuild(): void {
    handleBuildBatch(Array.from(selectedMints));
  }

  // No upfront selection cap — backend slices the user's selection into
  // per-tx batches automatically and the frontend walks them sequentially
  // through the existing "Build next batch" flow.
  const canBuild =
    selectedMints.size > 0 && build.status !== "loading";

  // Publish Legacy NFT selection state for the page-level sticky bar.
  // Reclaim sum walks the burnable list once per selection change. Each
  // burnable carries a per-NFT `estimatedGrossReclaimSol` from the
  // backend; missing values are skipped (rare but defensive).
  const legacyReclaimSol = useMemo(() => {
    if (selectedMints.size === 0 || !candidates) return 0;
    let sum = 0;
    for (const c of candidates.burnable) {
      if (selectedMints.has(c.mint) && typeof c.estimatedGrossReclaimSol === "number") {
        sum += c.estimatedGrossReclaimSol;
      }
    }
    return sum;
  }, [selectedMints, candidates]);
  useBurnSelectionPublisher(
    "legacyNft",
    selectedMints.size,
    legacyReclaimSol,
    canBuild,
    candidates ? candidates.burnable.length : null,
  );

  // Toggle every mint in a collection group at once. If `selectAll` is
  // true, ensure all are in the selection set; otherwise remove all.
  const toggleGroupSelected = useCallback(
    (ids: string[], selectAll: boolean): void => {
      setSelectedMints((prev) => {
        const next = new Set(prev);
        for (const id of ids) {
          if (selectAll) next.add(id);
          else next.delete(id);
        }
        return next;
      });
    },
    [],
  );

  // Collapsed/onToggle are controlled by the parent (CleanerDetails) so the
  // unified action-plan panel above can expand a specific section on demand.
  // Discovery state stays local to this component, so toggling never
  // re-fires the network call.

  // Header summary numbers — count of burnable items and an upper-bound
  // SOL estimate (per-NFT × totalBurnable). Falls back to "scanning…" while
  // discovery is in flight.
  const headerCount =
    discover.status === "ready"
      ? `${discover.result.totalBurnable} burnable`
      : discover.status === "loading"
      ? null
      : "0 burnable";
  const headerSol =
    discover.status === "ready"
      ? (discover.result.includedNfts[0]?.estimatedGrossReclaimSol ?? 0) *
        discover.result.totalBurnable
      : null;

  return (
    <div className="vl-burn-card m-3 overflow-hidden">
      <CollapsibleBurnHeader
        collapsed={collapsed}
        onToggle={onToggle}
        title="Legacy NFT burn · max reclaim"
        count={headerCount}
        estSol={headerSol}
        toneBorder="border-red-500/30"
        toneBg="bg-red-500/10"
        toneText="text-red-300"
      />
      {!collapsed && (
        <>
          <div className="border-b border-red-500/20 bg-red-500/5 px-3 py-1.5 text-[11px] font-semibold text-red-300">
            ⚠ Destructive and irreversible. Review every line of the preview, then explicitly sign to confirm.
          </div>

          {discover.status === "empty" && (
            <EmptyHint>
              No NFT-shaped token accounts found in this wallet.
            </EmptyHint>
          )}
          {discover.status === "loading" && (
            <EmptyHint>Discovering legacy NFTs…</EmptyHint>
          )}
          {discover.status === "error" && (
            <div className="flex flex-wrap items-center justify-between gap-2 bg-red-500/10 px-3 py-1.5 text-xs text-red-300">
              <span>
                <span className="font-semibold">Discovery failed:</span>{" "}
                {prettifyApiError(discover.error)}
              </span>
              <button
                type="button"
                onClick={runDiscover}
                aria-label="Retry legacy NFT discovery"
                className="rounded border border-red-500/40 bg-red-500/15 px-2 py-0.5 text-[10px] font-semibold text-red-100 transition-colors duration-100 hover:bg-red-500/25"
              >
                Retry discovery
              </button>
            </div>
          )}

          {discover.status === "ready" && candidates && (
            <>
              {candidates.burnable.length === 0 ? (
                <>
                  {/* Surface skipped reasons FIRST when nothing is burnable —
                      that's the "why" the user came here for. */}
                  {candidates.nonBurnable.length > 0 && (
                    <NonBurnableNftSummary entries={candidates.nonBurnable} />
                  )}
                  <EmptyHint>
                    {candidates.nonBurnable.length > 0
                      ? "0 legacy Metaplex NFTs eligible for BurnV1. See the skipped-reason counts above."
                      : "No legacy NFT-shape token accounts found in this wallet. If you hold Metaplex Core assets or pNFTs, try those sections."}
                  </EmptyHint>
                </>
              ) : (
                <>
                  {visible ? (
                    <BurnCandidateGroupGrid
                      items={candidates.burnable.map((c) => ({
                        id: c.mint,
                        name: c.name,
                        symbol: c.symbol,
                        image: c.image,
                        collection: c.collection,
                        estimatedGrossReclaimSol: c.estimatedGrossReclaimSol,
                      }))}
                      selected={selectedMints}
                      onToggle={toggleSelected}
                      onToggleGroup={toggleGroupSelected}
                      itemKindLabel="NFT"
                    />
                  ) : (
                    <HiddenGridPlaceholder
                      count={candidates.burnable.length}
                      kind="NFT"
                    />
                  )}
                  <button
                    type="button"
                    onClick={handleBuild}
                    disabled={!canBuild}
                    aria-label="Burn selected legacy NFTs"
                    data-vl-burn-trigger="legacyNft"
                    hidden
                  />
                  {build.status === "error" && (
                    <div className="border-t border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs text-red-300">
                      Build failed: {build.error}
                    </div>
                  )}
                  {build.status === "ready" && (
                    <LegacyNftBurnPreview
                      result={build.result}
                      walletAddress={walletAddress}
                      onWalletRescan={onWalletRescan}
                      rescanPending={rescanPending}
                      onBuildBatch={handleBuildBatch}
                      onBurned={handleBurned}
                    />
                  )}
                  {candidates.nonBurnable.length > 0 && (
                    <NonBurnableNftSummary entries={candidates.nonBurnable} />
                  )}
                </>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function LegacyNftCandidatesTable({
  rows,
  selected,
  onToggle,
}: {
  rows: {
    mint: string;
    tokenAccount: string;
    name: string | null;
    symbol: string | null;
    image: string | null;
    estimatedGrossReclaimSol: number | null;
  }[];
  selected: Set<string>;
  onToggle: (mint: string) => void;
}) {
  return (
    // Horizontal scroll on viewports narrower than the table — the dense
    // 5-column layout is unreadable when columns crush below ~560px.
    <div className="overflow-x-auto">
     <div className="min-w-[560px]">
      <div className="grid grid-cols-12 gap-3 border-b border-red-500/20 bg-red-500/[0.03] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-red-300/80">
        <div className="col-span-1">Burn</div>
        <div className="col-span-5">Name</div>
        <div className="col-span-2">Symbol</div>
        <div className="col-span-2">Mint</div>
        <div className="col-span-2 text-right">Reclaim</div>
      </div>
      <div>
        {rows.map((r) => {
          const isChecked = selected.has(r.mint);
          const isBatchOverflow = r.estimatedGrossReclaimSol === null;
          return (
            <label
              key={r.tokenAccount}
              className={`grid cursor-pointer grid-cols-12 items-center gap-3 border-b border-[color:var(--vl-border)] px-3 py-1.5 text-xs last:border-b-0 transition-colors duration-[var(--vl-motion,180ms)] hover:bg-[rgba(168,144,232,0.06)] ${
                isChecked ? "bg-[var(--vl-purple-soft)] ring-1 ring-inset ring-[var(--vl-purple-border)]" : ""
              }`}
            >
              <div className="col-span-1">
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => onToggle(r.mint)}
                  aria-label={`Select ${r.name ?? "NFT"} for burn`}
                  className="vl-checkbox h-3.5 w-3.5 cursor-pointer"
                />
              </div>
              <div className="col-span-5 flex min-w-0 items-center gap-2">
                <NftThumbnail src={r.image} alt={r.name ?? "NFT"} />
                <div className="min-w-0 flex-1">
                  {r.name ? (
                    <div className="truncate font-semibold text-neutral-100">
                      {r.name}
                    </div>
                  ) : (
                    <div className="truncate font-mono text-[11px] text-neutral-400">
                      {shortAddr(r.mint, 4, 4)}
                    </div>
                  )}
                </div>
              </div>
              <div className="col-span-2 truncate text-[11px] text-neutral-300">
                {r.symbol ?? "—"}
              </div>
              <div className="col-span-2 truncate font-mono text-[11px] text-neutral-300">
                {shortAddr(r.mint, 4, 4)}
              </div>
              <div className="col-span-2 text-right font-semibold tabular-nums text-emerald-300/90">
                {isBatchOverflow ? "—" : fmtSol(r.estimatedGrossReclaimSol!)}
              </div>
            </label>
          );
        })}
      </div>
     </div>
    </div>
  );
}

// Tiny image cell for NFT/Core candidate rows. Renders a fixed-size neutral
// placeholder box when image is null OR errors, so layout stays consistent
// and broken-image icons never flash. Lazy + async decode + no-referrer keep
// rendering 200+ candidates from blasting the network on first paint or
// leaking the wallet page URL to image hosts.
// Memoized so re-renders of a parent (selection toggles, scroll, hover
// state on a sibling card, etc.) don't re-mount the underlying <img>
// for every card in a 200+ NFT grid. With memoization the image element
// only re-renders when (src, alt, size) actually change.
const NftThumbnail = React.memo(function NftThumbnail({
  src,
  alt,
  size = "sm",
  kindLabel,
}: {
  src: string | null;
  alt: string;
  size?: "sm" | "lg";
  // Optional short label ("NFT" / "pNFT" / "Core" / "SPL") shown inside
  // the compact-mode placeholder when image loading is suppressed. Only
  // used when `useCompactMode()` is true; rendered as a small centered
  // text so the cards stay visually distinguishable without doing any
  // network/decode work.
  kindLabel?: string;
}) {
  const isCompact = useCompactMode();
  const cls = size === "lg" ? "h-16 w-16" : "h-7 w-7";
  // /burner runs CleanerRow with `compact`, which flips this context on.
  // In that mode we deliberately render a labelled placeholder instead of
  // ever touching `proxyImageUrl(src)` or mounting an <img>. Hundreds of
  // image-proxy round-trips + decodes per scan was a major source of
  // the laptop CPU/GPU heat the operator reported. The full /groups/[id]
  // view (non-compact) still loads images normally.
  if (isCompact) {
    const label = kindLabel ?? alt;
    return (
      <span
        aria-hidden
        className={`inline-flex ${cls} shrink-0 items-center justify-center rounded bg-neutral-800 font-mono text-[9px] font-bold uppercase tracking-wider text-[color:var(--vl-fg-3)]`}
      >
        {label}
      </span>
    );
  }
  // Hide-on-error needs state so the placeholder takes over reliably across
  // re-renders (style.visibility hack survived for one render only).
  const [errored, setErrored] = useState(false);
  // Prefer the same-origin proxy URL — caches by hash, serves the second
  // and subsequent visits instantly. Falls back to null for non-http(s)
  // sources (which the placeholder branch handles).
  const proxied = proxyImageUrl(src);
  if (!src || !proxied || errored) {
    return (
      <span
        aria-hidden
        className={`inline-block ${cls} shrink-0 rounded bg-neutral-800`}
      />
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={proxied}
      alt={alt}
      loading="lazy"
      decoding="async"
      // Deprioritize the network + decode queue for small (28px)
      // thumbnails — they're decorative, off-the-critical-path, and a
      // grid of 200+ at once was previously fighting the rest of the
      // page for bandwidth/CPU. `lg` thumbnails sit in the burn
      // preview where the user is actively reviewing — keep those at
      // default priority.
      fetchPriority={size === "lg" ? "auto" : "low"}
      referrerPolicy="no-referrer"
      width={size === "lg" ? 64 : 28}
      height={size === "lg" ? 64 : 28}
      // `content-visibility: auto` lets the browser skip rendering work
      // for off-screen items in long scrollable grids — complements
      // loading="lazy" by also short-circuiting layout/paint, not just
      // network. Safe because we always supply explicit width/height.
      style={{ contentVisibility: "auto" }}
      className={`${cls} shrink-0 rounded bg-neutral-800 object-cover`}
      onError={() => setErrored(true)}
    />
  );
});

// Generic burn candidate item shape — the three flows (legacy/pNFT/Core)
// share enough that one grid component renders all three. Each flow's
// section maps its candidate type into this shape before passing in.
interface BurnCandidateItem {
  id: string; // mint or asset address
  name: string | null;
  symbol: string | null;
  image: string | null;
  collection: string | null;
  estimatedGrossReclaimSol: number | null;
}

// One card cell in BurnCandidateGroupGrid. Memoized on its primitive
// props so toggling one item's selection only re-renders that card —
// not all 60 cards in the group. The parent passes a stable
// `onToggle: (id) => void` (via useCallback) and primitive scalars,
// so React.memo's default shallow compare is enough.
const BurnCandidateCard = React.memo(function BurnCandidateCard({
  id,
  name,
  image,
  itemKindLabel,
  estimatedGrossReclaimSol,
  isChecked,
  onToggle,
  compact,
}: {
  id: string;
  name: string | null;
  image: string | null;
  itemKindLabel: string;
  estimatedGrossReclaimSol: number | null;
  isChecked: boolean;
  onToggle: (id: string) => void;
  // Compact = `/burner`. Tightens padding, drops the redundant
  // short-mint chip + per-card SOL line, smaller checkbox — DOM stays
  // light when 1000+ cards render at once.
  compact: boolean;
}) {
  if (compact) {
    // Compact card label: split into two parts so both stay readable
    // when 22 NFTs in the same collection have an identical prefix.
    //   • Left  → the name PREFIX (everything before the last "#" or
    //             trailing whitespace+number). Truncated by CSS when
    //             the column is narrow.
    //   • Right → the unique SUFFIX (`#255`, `420`, …). Never
    //             truncates — that's the differentiator.
    // If the name has no recognisable suffix we just show the full
    // name (truncated). If there's no name at all, fall back to the
    // last 4 chars of the mint.
    const split = (() => {
      if (!name) return { prefix: shortAddr(id, 4, 4), suffix: null as string | null };
      const hash = name.lastIndexOf("#");
      if (hash >= 0 && hash < name.length - 1) {
        return {
          prefix: name.slice(0, hash).trim(),
          suffix: `#${name.slice(hash + 1).trim()}`,
        };
      }
      // Trailing-number heuristic ("Claws Mythic 12" → prefix "Claws
      // Mythic", suffix "12"). Only fires when the trailing token is
      // pure digits — names like "Genesis V2" stay intact.
      const m = name.match(/^(.*\S)\s+(\d+)\s*$/);
      if (m) return { prefix: m[1], suffix: m[2] };
      return { prefix: name, suffix: null };
    })();
    return (
      <label
        // Bumped vertical padding (py-1 → py-1.5) and added a min-height
        // so cards have a slightly bigger click target when 200+ render
        // densely. Width / grid columns unchanged — this only adds ~4px
        // of vertical breathing room and a slightly bigger checkbox.
        // Same DOM cost as before (no extra elements).
        className={`vl-card is-interactive flex min-h-[28px] cursor-pointer items-center gap-1.5 px-2 py-1.5 text-left ${
          isChecked ? "is-selected" : ""
        }`}
        title={name ?? id}
      >
        <input
          type="checkbox"
          checked={isChecked}
          onChange={() => onToggle(id)}
          aria-label={`Select ${name ?? itemKindLabel} for burn`}
          className="vl-checkbox h-4 w-4 shrink-0 cursor-pointer"
        />
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-white">
          {split.prefix || (name ?? shortAddr(id, 4, 4))}
        </span>
        {split.suffix && (
          <span className="shrink-0 font-mono text-[10px] text-[color:var(--vl-fg-3)]">
            {split.suffix}
          </span>
        )}
      </label>
    );
  }
  return (
    <label
      className={`vl-card is-interactive flex cursor-pointer flex-col gap-1 p-2 text-left ${
        isChecked ? "is-selected" : ""
      }`}
    >
      <div className="relative">
        <NftThumbnail
          src={image}
          alt={name ?? itemKindLabel}
          size="lg"
          kindLabel={itemKindLabel}
        />
        <input
          type="checkbox"
          checked={isChecked}
          onChange={() => onToggle(id)}
          aria-label={`Select ${name ?? itemKindLabel} for burn`}
          className="vl-checkbox absolute right-1 top-1 h-4 w-4 cursor-pointer"
        />
      </div>
      <div className="min-w-0">
        {name ? (
          <div className="truncate text-[11px] font-semibold text-white">
            {name}
          </div>
        ) : (
          <div className="truncate font-mono text-[10px] text-[color:var(--vl-fg-3)]">
            {shortAddr(id, 4, 4)}
          </div>
        )}
        <div className="flex flex-wrap items-baseline gap-1">
          <span className="rounded bg-[rgba(255,255,255,0.04)] px-1 py-px text-[9px] font-bold uppercase tracking-wider text-[color:var(--vl-fg-2)]">
            {itemKindLabel}
          </span>
          <span className="font-mono text-[9px] text-[color:var(--vl-fg-3)]">
            {shortAddr(id, 3, 3)}
          </span>
        </div>
        {estimatedGrossReclaimSol !== null && (
          <div className="mt-0.5 text-[10px] tabular-nums text-[color:var(--vl-green)]">
            {fmtSol(estimatedGrossReclaimSol)} SOL
          </div>
        )}
      </div>
    </label>
  );
});

// Collection-grouped grid of burn candidates. Replaces the prior table-
// shaped `LegacyNftCandidatesTable` / `PnftCandidatesTable` /
// `CoreCandidatesTable` components and folds in the per-collection
// "Select all" toggle. No artificial selection cap — the user can pick
// every burnable item; the backend slices into per-tx batches.
const GRID_PAGE_SIZE = 60;

// Window-scroll virtualizer for compact (`/burner`) card grids.
// Mounts only the rows currently in the viewport (plus a small
// overscan), but reserves the full grid height up front so scrolling
// feels continuous and the surrounding layout doesn't reflow as the
// user scrolls. No `position: sticky` / no internal scroll container
// — we use the page's natural window scroll so multiple groups stack
// the way the user expects.
//
// Cards have a known fixed height in compact mode (28 px min-h + 1.5
// padding × 2 + 1 gap ≈ 36 px); the grid itself uses CSS Grid with a
// responsive column count that mirrors the Tailwind breakpoints used
// elsewhere in the file. Selection toggling re-renders the parent's
// `selected` set, but `BurnCandidateCard` is React.memo'd on primitive
// props so only the toggled card actually re-renders.
const COMPACT_ROW_HEIGHT_PX = 36;
const COMPACT_ROW_GAP_PX = 4;
const COMPACT_OVERSCAN_ROWS = 3;

function compactColsForWidth(w: number): number {
  if (w >= 1280) return 7;
  if (w >= 1024) return 6;
  if (w >= 768) return 4;
  if (w >= 640) return 3;
  return 2;
}

function VirtualizedCompactCardGrid({
  items,
  selected,
  onToggle,
  itemKindLabel,
}: {
  items: BurnCandidateItem[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  itemKindLabel: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // SSR-safe defaults; the layout effect below corrects on mount.
  const [viewportW, setViewportW] = useState<number>(() =>
    typeof window === "undefined" ? 1280 : window.innerWidth,
  );
  const [viewportH, setViewportH] = useState<number>(() =>
    typeof window === "undefined" ? 800 : window.innerHeight,
  );
  // Container's offsetTop relative to the viewport top, recomputed on
  // window scroll/resize. Used to derive which rows fall inside the
  // viewport without giving up window-level scrolling.
  const [containerTop, setContainerTop] = useState<number>(0);

  const cols = compactColsForWidth(viewportW);
  const rowStride = COMPACT_ROW_HEIGHT_PX + COMPACT_ROW_GAP_PX;
  const totalRows = Math.ceil(items.length / cols);
  const totalHeight =
    totalRows === 0 ? 0 : totalRows * rowStride - COMPACT_ROW_GAP_PX;

  useEffect(() => {
    function measure() {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setContainerTop(rect.top);
      setViewportH(window.innerHeight);
      setViewportW(window.innerWidth);
    }
    measure();
    window.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, [totalHeight]);

  // Visible row range. `containerTop` is the container's top in
  // viewport coords; negative when the user has scrolled past it.
  const scrolledIntoContainer = Math.max(0, -containerTop);
  const visibleTopPx = scrolledIntoContainer;
  const visibleBottomPx = Math.min(
    totalHeight,
    scrolledIntoContainer + viewportH,
  );
  const startRow =
    totalRows === 0
      ? 0
      : Math.max(
          0,
          Math.floor(visibleTopPx / rowStride) - COMPACT_OVERSCAN_ROWS,
        );
  const endRow =
    totalRows === 0
      ? 0
      : Math.min(
          totalRows,
          Math.ceil(visibleBottomPx / rowStride) + COMPACT_OVERSCAN_ROWS,
        );
  const startIdx = startRow * cols;
  const endIdx = Math.min(items.length, endRow * cols);
  const slice = items.slice(startIdx, endIdx);

  return (
    <div
      ref={containerRef}
      className="p-1.5"
      style={{ height: totalHeight, position: "relative" }}
    >
      {slice.length > 0 && (
        <div
          style={{
            position: "absolute",
            top: startRow * rowStride,
            left: "6px", // matches container's p-1.5 horizontal padding
            right: "6px",
            display: "grid",
            gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
            gap: `${COMPACT_ROW_GAP_PX}px`,
          }}
        >
          {slice.map((item) => (
            <BurnCandidateCard
              key={item.id}
              id={item.id}
              name={item.name}
              image={item.image}
              itemKindLabel={itemKindLabel}
              estimatedGrossReclaimSol={item.estimatedGrossReclaimSol}
              isChecked={selected.has(item.id)}
              onToggle={onToggle}
              compact
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Tiny stand-in for BurnCandidateGroupGrid when the section's tab is
// not currently visible. Discovery state is preserved by keeping the
// section mounted, but the heavy thumbnail grid (60+ <img> tags +
// per-card render work) is skipped until the user comes back to this
// tab. One short text line keeps the layout stable.
function HiddenGridPlaceholder({
  count,
  kind,
}: {
  count: number;
  kind: string;
}) {
  return (
    <div className="px-3 py-2 text-[11px] text-[color:var(--vl-fg-3)]">
      {count} burnable {kind}
      {count === 1 ? "" : "s"} ready · open this tab to view the grid.
    </div>
  );
}

function BurnCandidateGroupGrid({
  items,
  selected,
  onToggle,
  onToggleGroup,
  itemKindLabel,
}: {
  items: BurnCandidateItem[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onToggleGroup: (ids: string[], selectAll: boolean) => void;
  itemKindLabel: string; // "NFT" / "pNFT" / "asset"
}) {
  // Compact (`/burner`) virtualizes the per-group card grid against the
  // window scroll. The visual UX is "one continuous grid" but only the
  // rows in the viewport (plus a small overscan) are mounted. On a
  // 1000-NFT wallet this drops the mounted card count from ~1000 to
  // ~30-50 and keeps idle CPU low after a scan.
  // Selection bookkeeping (`Select all`, `Pick N`) still operates on
  // the FULL group via `fullGroupIds`, so hidden items respond to
  // group actions and stay counted in totals.
  const isCompact = useCompactMode();
  const [visibleCount, setVisibleCount] = useState(GRID_PAGE_SIZE);
  const totalCount = items.length;
  const visibleItems = useMemo(
    () => (isCompact ? items : items.slice(0, visibleCount)),
    [items, visibleCount, isCompact],
  );

  // Group key derivation. Priority:
  //   1. Verified collection mint (`coll:<mint>`) — authoritative.
  //   2. Name-prefix fallback (`name:<prefix>`) — handles collections
  //      whose verified-collection field is null at the wallet/Helius
  //      level but whose names follow the standard "Foo #123" / "Foo 123"
  //      pattern. Without this, a wallet with 22 "Poptarteds #N" items
  //      that were minted without a collection record would all dump
  //      into "Uncollected" and the user couldn't bulk-select.
  //   3. `_uncollected` — only when there's nothing usable.
  // The same key is used by `groups` (display) and `fullGroupIds`
  // ("Select all" / "Pick N") so behavior stays consistent.
  function deriveGroupKey(item: BurnCandidateItem): string {
    if (item.collection) return `coll:${item.collection}`;
    const n = item.name?.trim();
    if (n) {
      // Strip trailing " #123" or " 123" so siblings collapse together.
      const hash = n.lastIndexOf("#");
      if (hash > 0) {
        const prefix = n.slice(0, hash).trim();
        if (prefix.length >= 2) return `name:${prefix.toLowerCase()}`;
      }
      const m = n.match(/^(.*\S)\s+\d+\s*$/);
      if (m && m[1].length >= 2) return `name:${m[1].toLowerCase()}`;
    }
    return "_uncollected";
  }

  // Display label per group. Uses the actual case-preserving name from
  // the first item in the bucket (lowercased keys above are for grouping
  // only; we don't want "POPTARTEDS" if all items are "Poptarteds").
  function groupLabel(key: string, items: BurnCandidateItem[]): string {
    if (key === "_uncollected") return "Uncollected";
    if (key.startsWith("name:")) {
      const sample = items.find((i) => i.name)?.name ?? "";
      const hash = sample.lastIndexOf("#");
      if (hash > 0) return sample.slice(0, hash).trim();
      const m = sample.match(/^(.*\S)\s+\d+\s*$/);
      if (m) return m[1];
      return sample || "Group";
    }
    // coll:<mint> — caller renders the symbol/name prefix already.
    return "";
  }

  // Group by derived key. Items in the same name-prefix bucket get
  // collapsed into one card-list; "Uncollected" stays last.
  const groups = useMemo(() => {
    const map = new Map<string, BurnCandidateItem[]>();
    for (const item of visibleItems) {
      const key = deriveGroupKey(item);
      const list = map.get(key) ?? [];
      list.push(item);
      map.set(key, list);
    }
    const entries = [...map.entries()];
    entries.sort((a, b) => {
      // Uncollected always last.
      if (a[0] === "_uncollected") return 1;
      if (b[0] === "_uncollected") return -1;
      // Otherwise: bigger groups first.
      return b[1].length - a[1].length;
    });
    return entries;
  }, [visibleItems]);

  // Full per-group ids — used by "Select all in group" + "Pick N" so
  // both operate on every item in the bucket, not just the currently-
  // visible page. Built from the raw `items` list using the same
  // derivation as `groups`.
  const fullGroupIds = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const item of items) {
      const key = deriveGroupKey(item);
      const list = map.get(key) ?? [];
      list.push(item.id);
      map.set(key, list);
    }
    return map;
  }, [items]);

  return (
    <div className="space-y-3 px-3 py-3">
      {groups.map(([groupKey, groupItems]) => {
        const isUncollected = groupKey === "_uncollected";
        // Try to derive a friendly group label: prefer the most common
        // symbol, then a name prefix (everything before the "#"), then
        // fall back to the short collection mint.
        const sym = groupItems.find((i) => i.symbol)?.symbol ?? null;
        const namePrefix = (() => {
          const n = groupItems.find((i) => i.name)?.name;
          if (!n) return null;
          const cut = n.indexOf("#");
          return (cut > 0 ? n.slice(0, cut) : n).trim();
        })();
        // Name-derived buckets surface the prefix directly via groupLabel
        // (case-preserving). Verified-collection buckets fall through to
        // the existing symbol → name-prefix → short-mint chain.
        const isNameDerived = groupKey.startsWith("name:");
        const isCollDerived = groupKey.startsWith("coll:");
        const collMint = isCollDerived ? groupKey.slice("coll:".length) : groupKey;
        const label = isUncollected
          ? "Uncollected"
          : isNameDerived
          ? groupLabel(groupKey, groupItems)
          : sym ?? namePrefix ?? `Collection ${shortAddr(collMint, 4, 4)}`;
        // Toggle "Select all" against the FULL group, not just the rendered
        // (paged) subset, so it stays useful when items spill past the page.
        const allIds = fullGroupIds.get(groupKey) ?? groupItems.map((i) => i.id);
        const ids = allIds;
        const allSelected = ids.every((id) => selected.has(id));
        const anySelected = ids.some((id) => selected.has(id));
        const fullGroupCount = ids.length;
        const visibleGroupCount = groupItems.length;
        return (
          <div
            key={groupKey}
            className="vl-card overflow-hidden"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[color:var(--vl-border)] bg-[rgba(168,144,232,0.05)] px-3 py-1.5">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-sm font-semibold text-white">
                  {label}
                </span>
                <span className="rounded-full border border-[color:var(--vl-border)] bg-[rgba(255,255,255,0.04)] px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[color:var(--vl-fg-2)]">
                  {visibleGroupCount < fullGroupCount
                    ? `${visibleGroupCount} / ${fullGroupCount}`
                    : fullGroupCount}
                </span>
                {isCollDerived && (
                  <span className="font-mono text-[10px] text-[color:var(--vl-fg-3)]">
                    {shortAddr(collMint, 4, 4)}
                  </span>
                )}
                {isNameDerived && (
                  <span className="rounded-full border border-[color:var(--vl-border)] px-1.5 py-0 text-[9px] font-bold uppercase tracking-wider text-[color:var(--vl-fg-3)]">
                    by name
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {/* "Pick N" — additive shortcut. Type a count, press Enter
                    or the button, and the first N currently-unselected
                    items in this group flip to selected. Useful when the
                    operator wants to burn a fixed batch ("just 50 from
                    this collection") without click-spamming individual
                    cards. Selection in OTHER groups is preserved. */}
                <PickNInGroup
                  ids={ids}
                  selected={selected}
                  onPick={(toAdd) => onToggleGroup(toAdd, true)}
                />
                <button
                  type="button"
                  onClick={() => onToggleGroup(ids, !allSelected)}
                  className="text-[11px] font-semibold text-[color:var(--vl-purple-2)] transition-colors duration-[var(--vl-motion,180ms)] hover:text-white"
                  aria-label={
                    allSelected ? "Deselect all in group" : "Select all in group"
                  }
                >
                  {allSelected
                    ? "Deselect all"
                    : anySelected
                      ? `Select all (+${ids.length - ids.filter((id) => selected.has(id)).length})`
                      : "Select all"}
                </button>
              </div>
            </div>
            {/* Card-grid: darker than the panel so cards visibly LIFT.
                Selected card flips to PURPLE accent (red is reserved
                for the actual burn-button, per polish-pass spec).
                Compact mode runs a denser column count + tighter
                padding because images are off — cards are tiny labels
                and we want them packed, not floating. */}
            {isCompact ? (
              // Compact (`/burner`) virtualizes against window scroll.
              // The grid LOOKS like all cards are mounted (full height
              // reserved, scrolling through is smooth), but only rows in
              // the viewport ± overscan are actually in the DOM. Drops
              // mounted card count from ~1000 to ~30-50 on big wallets.
              <VirtualizedCompactCardGrid
                items={groupItems}
                selected={selected}
                onToggle={onToggle}
                itemKindLabel={itemKindLabel}
              />
            ) : (
              <div className="vl-card-grid grid grid-cols-2 gap-2 p-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
                {groupItems.map((item) => (
                  <BurnCandidateCard
                    key={item.id}
                    id={item.id}
                    name={item.name}
                    image={item.image}
                    itemKindLabel={itemKindLabel}
                    estimatedGrossReclaimSol={item.estimatedGrossReclaimSol}
                    isChecked={selected.has(item.id)}
                    onToggle={onToggle}
                    compact={isCompact}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
      {/* "Show more" pager only renders in non-compact view (full
          /groups/[id]?tab=cleaner). The burner shows everything up-front. */}
      {!isCompact && visibleCount < totalCount && (
        <div className="vl-card flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[11px]">
          <span className="text-[color:var(--vl-fg-2)]">
            Showing{" "}
            <span className="font-semibold text-neutral-200">
              {visibleCount}
            </span>{" "}
            of{" "}
            <span className="font-semibold text-neutral-200">{totalCount}</span>{" "}
            {itemKindLabel}
            {totalCount === 1 ? "" : "s"} — extra thumbnails are hidden until
            requested to keep the page snappy.
          </span>
          <button
            type="button"
            onClick={() =>
              setVisibleCount((c) =>
                Math.min(c + GRID_PAGE_SIZE, totalCount),
              )
            }
            aria-label={`Show ${Math.min(
              GRID_PAGE_SIZE,
              totalCount - visibleCount,
            )} more`}
            className="rounded border border-red-500/40 bg-red-500/[0.10] px-2 py-1 text-[11px] font-semibold text-red-200 transition-colors duration-100 hover:bg-red-500/20"
          >
            Show {Math.min(GRID_PAGE_SIZE, totalCount - visibleCount)} more
          </button>
        </div>
      )}
    </div>
  );
}

// Per-group "Pick N" widget. Internal state so each group's input is
// independent. Picks the first N currently-unselected ids from the
// group (additive — never deselects, never touches other groups).
function PickNInGroup({
  ids,
  selected,
  onPick,
}: {
  ids: string[];
  selected: Set<string>;
  onPick: (toAdd: string[]) => void;
}) {
  const [raw, setRaw] = useState("");
  const remaining = ids.filter((id) => !selected.has(id)).length;
  const parsed = (() => {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(n, remaining);
  })();
  const apply = () => {
    if (parsed <= 0) return;
    const out: string[] = [];
    for (const id of ids) {
      if (out.length >= parsed) break;
      if (!selected.has(id)) out.push(id);
    }
    if (out.length > 0) onPick(out);
    setRaw("");
  };
  return (
    <span className="inline-flex items-center gap-1">
      {/* Plain text input with `inputMode="numeric"` instead of
          `type="number"` — browser spinner arrows on number inputs
          covered the "N" placeholder + ate ~12px of horizontal space
          inside the 48px field, so the user couldn't read or hit the
          input cleanly. Mobile keyboards still show the numeric pad
          via `inputMode`; we strip non-digits in onChange. */}
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        placeholder="N"
        value={raw}
        onChange={(e) => setRaw(e.target.value.replace(/\D+/g, ""))}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            apply();
          }
        }}
        aria-label="Pick first N items in this group"
        disabled={remaining === 0}
        className="w-10 rounded border border-[color:var(--vl-border)] bg-transparent px-1.5 py-0.5 text-right text-[11px] font-mono text-[color:var(--vl-fg)] outline-none transition-colors duration-[var(--vl-motion,180ms)] focus:border-[var(--vl-purple)] disabled:opacity-50"
      />
      <button
        type="button"
        onClick={apply}
        disabled={parsed <= 0}
        className="rounded border border-[color:var(--vl-border)] bg-transparent px-1.5 py-0.5 text-[11px] font-semibold text-[color:var(--vl-fg-2)] transition-colors duration-[var(--vl-motion,180ms)] hover:border-[var(--vl-purple)] hover:text-[color:var(--vl-purple-2)] disabled:cursor-not-allowed disabled:opacity-40"
        aria-label={
          parsed > 0 ? `Select first ${parsed} in group` : "Enter a count to pick"
        }
        title={
          remaining === 0
            ? "All items in this group already selected"
            : `Select the first ${parsed || "N"} unselected items in this group`
        }
      >
        Pick
      </button>
    </span>
  );
}

// Header line above each burn candidate table. Frames the table as the
// FULL burnable list and tells the user how many of those they can include
// in a single transaction (per-tx cap comes from backend, not a frontend
// constant — keeps the two in sync).
function BurnBatchHeader({
  totalBurnable,
  perTxCap,
  kind,
}: {
  totalBurnable: number;
  perTxCap: number;
  kind: string;
}) {
  return (
    <div className="border-b border-red-500/15 bg-red-500/[0.02] px-3 py-1 text-[11px] text-neutral-400">
      <span className="font-semibold text-neutral-200">
        Showing all {totalBurnable} burnable {kind}
        {totalBurnable === 1 ? "" : "s"}
      </span>
      <span className="ml-1 text-neutral-500">
        · select up to {perTxCap} per transaction
      </span>
    </div>
  );
}

function NonBurnableNftSummary({
  entries,
}: {
  entries: { reason: string }[];
}) {
  // Group by reason for compact display — typically 200+ entries on a real
  // wallet, dominated by pNFTs.
  const byReason = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of entries) m.set(e.reason, (m.get(e.reason) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [entries]);
  const total = entries.length;
  return (
    <div className="border-t border-red-500/20 bg-red-950/20 px-3 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-[10px] font-bold uppercase tracking-wider text-red-300/80">
          Skipped — counts by reason
        </div>
        <div className="text-[10px] tabular-nums text-red-300/60">
          {total} item{total === 1 ? "" : "s"}
        </div>
      </div>
      <ul className="mt-1 space-y-0.5 text-[11px] text-red-200/70">
        {byReason.map(([reason, count]) => (
          <li key={reason}>
            <span className="font-semibold text-red-200">{count}×</span>{" "}
            {reason}
          </li>
        ))}
      </ul>
    </div>
  );
}

// Legacy-NFT-specific safety checklist. Mirrors the SPL fungible
// BurnSafetyChecklist visually but checks the legacy-NFT contract: BurnV1
// is the only Metaplex op, no top-level SPL Token Burn / Transfer, audit's
// burnV1Count matches the preview's burnCount, and the user has explicitly
// acknowledged destructiveness via the inline checkbox.
function LegacyNftSafetyChecklist({
  result,
  audit,
  ackDestructive,
  onToggleAck,
}: {
  result: BuildLegacyNftBurnTxResult;
  audit: LegacyNftAuditResult | null;
  ackDestructive: boolean;
  onToggleAck: () => void;
}) {
  if (audit === null) return null;

  const usesBurnV1 =
    audit.burnV1Count > 0 && !audit.hasUnknownProgram && !audit.hasSplTokenBurn;
  const noSplTokenBurn = !audit.hasSplTokenBurn;
  const noTransfers = !audit.hasTransfers;
  const burnMatches = audit.burnV1Count === result.burnCount;

  const items: { ok: boolean; label: React.ReactNode; failHint?: string }[] = [
    {
      ok: usesBurnV1,
      label: "Uses Metaplex BurnV1 (no other Metaplex ix)",
      failHint: !usesBurnV1
        ? audit.reason ?? "BurnV1 not detected"
        : undefined,
    },
    {
      ok: noSplTokenBurn,
      label: "No top-level SPL Token Burn instruction",
      failHint: audit.hasSplTokenBurn
        ? "Top-level SPL Token Burn detected — legacy NFT burn must use Metaplex BurnV1"
        : undefined,
    },
    {
      ok: noTransfers,
      label: "No Transfer instructions",
      failHint: audit.hasTransfers ? "Top-level token Transfer detected" : undefined,
    },
    {
      ok: burnMatches,
      label: (
        <>
          Burn count matches preview ({audit.burnV1Count} ≡ {result.burnCount})
        </>
      ),
      failHint: !burnMatches
        ? `Tx has ${audit.burnV1Count} BurnV1 ix(s) but preview claims ${result.burnCount}`
        : undefined,
    },
    {
      ok: ackDestructive,
      label: "Destructive action acknowledged (manual)",
    },
  ];

  return (
    <div className="border-b border-red-500/20 bg-red-500/[0.04] px-3 py-2">
      <div className="text-[10px] font-bold uppercase tracking-wider text-red-200">
        Legacy NFT burn safety checklist
      </div>
      <ul className="mt-1 divide-y divide-red-500/10">
        {items.map((item, i) => {
          const isAckRow = i === items.length - 1;
          return (
            <li
              key={i}
              className="flex items-start gap-2 py-1.5 text-[11px]"
            >
              {isAckRow ? (
                <input
                  type="checkbox"
                  checked={ackDestructive}
                  onChange={onToggleAck}
                  aria-label="Acknowledge destructive legacy NFT burn"
                  className="mt-[2px] h-3.5 w-3.5 cursor-pointer accent-red-500"
                />
              ) : (
                <span
                  aria-hidden
                  className={`mt-[2px] inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full font-bold leading-none ${
                    item.ok
                      ? "bg-emerald-500/20 text-emerald-300"
                      : "bg-red-500/25 text-red-200"
                  }`}
                >
                  {item.ok ? "✓" : "✕"}
                </span>
              )}
              <span
                className={`min-w-0 flex-1 ${
                  item.ok ? "text-neutral-200" : "text-red-200"
                }`}
              >
                {item.label}
                {!item.ok && item.failHint && (
                  <span className="ml-1 text-red-300/80">— {item.failHint}</span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function LegacyNftBurnPreview({
  result,
  walletAddress,
  onWalletRescan,
  rescanPending,
  onBuildBatch,
  onBurned,
}: {
  result: BuildLegacyNftBurnTxResult;
  walletAddress: string;
  onWalletRescan: () => void;
  rescanPending: boolean;
  // Triggers a fresh build with the supplied mints (the "Build next batch"
  // shortcut). Section computes the wrapper; preview just supplies the
  // current build's nextBatchCandidates as the mint list.
  onBuildBatch: (mints: string[]) => void;
  // Section-level callback: receives the just-burned mints once the tx
  // reaches `finalized` so the section can strip them from
  // `candidates.burnable` + `selectedMints`. Bound by closure to
  // `result.includedNfts` here.
  onBurned?: (mints: string[]) => void;
}) {
  const isCompact = useCompactMode();
  // Audit the actual produced bytes. Memoised on the base64 string so the
  // ack-checkbox toggle doesn't redo the deserialize on every render.
  const audit: LegacyNftAuditResult | null = useMemo(() => {
    if (result.transactionBase64 === null) return null;
    return auditLegacyNftBurnTx(result.transactionBase64);
  }, [result.transactionBase64]);
  const [ackDestructive, setAckDestructive] = useState(false);

  const tx = result.transactionBase64;
  const txShort =
    tx === null
      ? "—"
      : tx.length > 80
      ? `${tx.slice(0, 40)}…${tx.slice(-20)} (${tx.length} chars)`
      : tx;

  const rows: { label: string; value: React.ReactNode; mono?: boolean }[] = [
    {
      label: "blockhash present",
      value: presenceBadge(Boolean(result.blockhash)),
    },
    {
      label: "lastValidBlockHeight present",
      value: presenceBadge(
        result.lastValidBlockHeight !== null &&
          result.lastValidBlockHeight !== undefined,
      ),
    },
    {
      label: "Burn count",
      value: (
        <span className="font-bold text-red-200">
          {result.burnCount}
          <span className="ml-1 text-red-300/70">
            / {result.totalBurnable} eligible
          </span>
        </span>
      ),
    },
    {
      label: "Preflight simulation",
      value: result.simulationOk ? (
        <span className="inline-flex items-center gap-1.5 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] font-bold text-emerald-300 ring-1 ring-emerald-500/30">
          ✓ Passed
        </span>
      ) : (
        <span className="inline-flex flex-col gap-0.5">
          <span className="inline-flex w-fit items-center gap-1.5 rounded bg-red-500/15 px-1.5 py-0.5 text-[11px] font-bold text-red-300 ring-1 ring-red-500/30">
            ✕ Rejected
          </span>
          {result.simulationError && (
            <span className="text-[10px] text-red-300/80">
              {result.simulationError}
            </span>
          )}
        </span>
      ),
    },
    {
      label: "Gross reclaim",
      value: (
        <span className="font-bold text-emerald-300">
          {fmtSol(result.estimatedGrossReclaimSol)} SOL
        </span>
      ),
    },
    {
      label: "Estimated network fee",
      value: (
        <span className="text-neutral-200">
          {fmtSol(result.estimatedFeeSol)} SOL
          <span className="ml-1 text-[10px] text-neutral-500">
            (base {fmtSol(result.estimatedBaseFeeSol)}
            {result.estimatedPriorityFeeSol > 0 && (
              <> + priority {fmtSol(result.estimatedPriorityFeeSol)}</>
            )}
            ; {result.computeUnitLimit.toLocaleString()} CU
            {result.priorityFeeMicrolamports > 0 && (
              <> @ {result.priorityFeeMicrolamports} μL/CU</>
            )}
            )
          </span>
        </span>
      ),
    },
    {
      label: "Estimated net received",
      value: (
        <span className="font-bold text-emerald-300">
          {fmtSol(result.estimatedNetReclaimSol)} SOL
        </span>
      ),
    },
    {
      label: "Net wallet reclaim",
      value: (
        <NetReclaimCell
          netSol={result.netWalletReclaimSol}
          grossSol={result.estimatedGrossReclaimSol}
        />
      ),
    },
    {
      label: "Tx version",
      value: <Badge variant="info">{result.transactionVersion}</Badge>,
    },
    { label: "Fee payer", value: result.feePayer, mono: true },
    {
      label: "Requires signature from",
      value: result.requiresSignatureFrom,
      mono: true,
    },
    {
      label: "Transaction (base64)",
      value: txShort,
      mono: true,
    },
  ];

  // The actual sign-and-send block. Extracted into a constant so compact
  // mode can render it bare (no review/checklist/details chrome around
  // it) while the default mode still wraps it with the full preview UI.
  const burnBlock = (
    <BurnSignAndSendBlock
      kindLabel="legacy NFT burn"
      transactionBase64={result.transactionBase64}
      blockhash={result.blockhash}
      lastValidBlockHeight={result.lastValidBlockHeight}
      requiresSignatureFrom={result.requiresSignatureFrom}
      targetWallet={walletAddress}
      auditPassed={audit?.ok === true}
      auditReason={audit?.reason ?? null}
      simulationOk={result.simulationOk}
      simulationError={result.simulationError}
      ackDestructive={ackDestructive}
      onToggleAck={() => setAckDestructive((v) => !v)}
      showAckCheckbox={false}
      onWalletRescan={onWalletRescan}
      rescanPending={rescanPending}
      nextBatchRemaining={result.nextBatchCandidates.length}
      onBuildNext={() =>
        onBuildBatch(result.nextBatchCandidates.map((c) => c.mint))
      }
      onBurned={() =>
        onBurned?.(result.includedNfts.map((n) => n.mint))
      }
    />
  );

  // Compact mode (standalone /burner): the page-level sticky bar owns
  // the user-facing Burn flow. Skip the entire review / checklist /
  // accordion / skipped-counts panel — render only the (now headless,
  // auto-firing) sign block. All safety gates (audit, ack, wallet
  // match, simulationOk, blockhash) still run inside BurnSignAndSendBlock.
  if (isCompact) return burnBlock;

  return (
    <div className="border-t border-red-500/30 bg-red-950/30">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-red-500/30 bg-red-600/15 px-3 py-1.5">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-[10px] font-bold uppercase tracking-wider text-red-200">
            🔥 Legacy NFT burn
          </span>
          <span className="text-[11px] font-semibold text-red-100">
            {result.burnCount} selected
          </span>
          <span className="text-[10px] text-red-300/80">
            · net{" "}
            <span className="font-bold text-emerald-300">
              {fmtSol(result.estimatedNetReclaimSol)} SOL
            </span>
          </span>
          {result.simulationOk ? (
            <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold text-emerald-300 ring-1 ring-emerald-500/30">
              ✓ preflight
            </span>
          ) : (
            <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] font-bold text-red-300 ring-1 ring-red-500/30">
              ✕ preflight
            </span>
          )}
        </div>
        <Badge variant="sell">manual sign · destructive</Badge>
      </div>
      {result.warning && (
        <div className="border-b border-red-500/15 bg-amber-500/5 px-3 py-1 text-[11px] text-amber-300">
          ⚠ {result.warning}
        </div>
      )}
      <LegacyNftSafetyChecklist
        result={result}
        audit={audit}
        ackDestructive={ackDestructive}
        onToggleAck={() => setAckDestructive((v) => !v)}
      />
      {burnBlock}
      <details className="group border-t border-red-500/15">
        <summary className="cursor-pointer list-none bg-red-500/[0.03] px-3 py-1.5 text-[11px] font-semibold text-red-300/80 transition-colors duration-100 hover:bg-red-500/10">
          <span className="inline-block w-3 transition-transform group-open:rotate-90">
            ▸
          </span>{" "}
          Transaction details
          {result.includedNfts.length > 0 && (
            <span className="ml-2 text-[10px] text-red-300/60">
              ({result.includedNfts.length} item
              {result.includedNfts.length === 1 ? "" : "s"})
            </span>
          )}
        </summary>
        {result.includedNfts.length > 0 && (
          <ul className="divide-y divide-red-500/15 border-b border-red-500/15">
            {result.includedNfts.map((n: LegacyNftBurnIncludedEntry) => (
              <li
                key={n.tokenAccount}
                className="grid grid-cols-12 items-center gap-3 px-3 py-1.5 text-xs"
              >
                <div className="col-span-5 min-w-0">
                  <div className="truncate font-semibold text-neutral-100">
                    {n.name ?? "—"}
                  </div>
                  <div className="truncate font-mono text-[10px] text-neutral-400">
                    {shortAddr(n.mint, 4, 4)}
                  </div>
                </div>
                <div className="col-span-2 truncate text-[11px] text-neutral-300">
                  {n.symbol ?? "—"}
                </div>
                <div className="col-span-2 truncate text-[10px] text-neutral-500">
                  {n.reason}
                </div>
                <div className="col-span-3 text-right font-semibold tabular-nums text-emerald-300/90">
                  {fmtSol(n.estimatedGrossReclaimSol)} SOL
                </div>
              </li>
            ))}
          </ul>
        )}
        {result.skippedNfts.length > 0 && (
          <NonBurnableNftSummary entries={result.skippedNfts} />
        )}
        <dl className="divide-y divide-red-500/15">
          {rows.map((r) => (
            <div
              key={r.label}
              className="grid grid-cols-12 items-center gap-3 px-3 py-1.5 text-xs"
            >
              <dt className="col-span-4 text-red-300/80">{r.label}</dt>
              <dd
                className={`col-span-8 min-w-0 break-all ${
                  r.mono
                    ? "font-mono text-[11px] text-neutral-100"
                    : "text-neutral-100"
                }`}
              >
                {r.value}
              </dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}

// =============================================================================
// pNFT burn — preview UI.
// Same two-phase pattern as LegacyNftBurnSection. Differs in:
//   - Backend response shape (includedPnfts / skippedPnfts / simulationOk).
//   - Adds a preflight simulation badge (Ok / Failed with reason).
//   - Slightly deeper red border so the section is visually distinct from
//     the legacy NFT card just above it.
// =============================================================================

type PnftDiscoverState =
  | { status: "loading" }
  | { status: "ready"; result: BuildPnftBurnTxResult }
  | { status: "error"; error: string }
  | { status: "empty" };

type PnftBuildState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; result: BuildPnftBurnTxResult }
  | { status: "error"; error: string };

function PnftBurnSection({
  walletAddress,
  nftAccountCount,
  collapsed,
  onToggle,
  onWalletRescan,
  rescanPending,
  visible = true,
}: {
  walletAddress: string;
  nftAccountCount: number;
  collapsed: boolean;
  onToggle: () => void;
  onWalletRescan: () => void;
  rescanPending: boolean;
  // See LegacyNftBurnSection — perf gate that skips the candidate grid
  // render when the section is in a hidden tab. Discovery effect still
  // runs so state is preserved across tab switches.
  visible?: boolean;
}) {
  const isCompact = useCompactMode();
  const [discover, setDiscover] = useState<PnftDiscoverState>(
    nftAccountCount === 0 ? { status: "empty" } : { status: "loading" },
  );
  const [build, setBuild] = useState<PnftBuildState>({ status: "idle" });
  const [buildPending, startBuildTransition] = useTransition();
  const [selectedMints, setSelectedMints] = useState<Set<string>>(new Set());
  const discoverCancelRef = useRef<(() => void) | null>(null);

  // Section-scoped discovery. See LegacyNftBurnSection.runDiscover for the
  // pattern — Retry uses this same callback to re-fire only this section's
  // backend call without triggering a wallet rescan.
  const runDiscover = useCallback(() => {
    if (nftAccountCount === 0) {
      setDiscover({ status: "empty" });
      return;
    }
    discoverCancelRef.current?.();
    let cancelled = false;
    discoverCancelRef.current = () => {
      cancelled = true;
    };
    setDiscover({ status: "loading" });
    setSelectedMints(new Set());
    setBuild({ status: "idle" });
    (async () => {
      const res = await buildPnftBurnTxAction(walletAddress, []);
      if (cancelled) return;
      if (res.ok) setDiscover({ status: "ready", result: res.result });
      else setDiscover({ status: "error", error: res.error });
    })();
  }, [walletAddress, nftAccountCount]);

  useEffect(() => {
    runDiscover();
    return () => {
      discoverCancelRef.current?.();
    };
  }, [runDiscover]);

  // Report this section's discovery to the parent reclaim-summary panel.
  // pNFT has a preflight simulation gate — if discovery's simulationOk is
  // false, the entire batch is currently un-burnable. Per the spec, do not
  // include rejected items in the running total.
  const pnftEntry: ReclaimEntry = (() => {
    if (discover.status === "loading")
      return { value: null, status: "loading" };
    if (discover.status === "error")
      return { value: null, status: "error" };
    if (discover.status === "empty")
      return { value: 0, status: "empty" };
    const r = discover.result;
    if (r.totalBurnable === 0) return { value: 0, status: "empty" };
    if (!r.simulationOk) return { value: null, status: "rejected" };
    const per = r.includedPnfts[0]?.estimatedGrossReclaimSol ?? 0;
    return { value: per * r.totalBurnable, status: "ready" };
  })();
  useReportReclaim("pnft", pnftEntry);

  // Burnable candidates surfaced by discovery: includedPnfts (with full
  // metadata) + skippedPnfts whose reason indicates batch overflow. The
  // Two buckets — see LegacyNftBurnSection.candidates for the rationale.
  // Selectable table renders the full burnableCandidates list; the build
  // call narrows to the user's selection.
  // Local set of pNFT mints burned in this session — same pattern as
  // the legacy section. Filtered out of `candidates.burnable` so the
  // grid drops the just-finalized items without waiting for a rescan.
  const [burnedMints, setBurnedMints] = useState<Set<string>>(new Set());
  const handleBurned = useCallback((mints: string[]) => {
    if (mints.length === 0) return;
    setBurnedMints((prev) => {
      const next = new Set(prev);
      for (const m of mints) next.add(m);
      return next;
    });
    setSelectedMints((prev) => {
      const next = new Set(prev);
      for (const m of mints) next.delete(m);
      return next;
    });
    setBuild({ status: "idle" });
  }, []);

  const candidates = useMemo(() => {
    if (discover.status !== "ready") return null;
    const burnable = discover.result.burnableCandidates
      .filter((c) => !burnedMints.has(c.mint))
      .map((c) => ({
        mint: c.mint,
        tokenAccount: c.tokenAccount,
        name: c.name,
        symbol: c.symbol,
        image: c.image,
        collection: c.collection,
        estimatedGrossReclaimSol: c.estimatedGrossReclaimSol as number | null,
      }));
    const nonBurnable = discover.result.skippedPnfts.filter(
      (s) =>
        !(s.reason.startsWith("Cap of") || s.reason.startsWith("Trimmed to fit")),
    );
    return { burnable, nonBurnable };
  }, [discover, burnedMints]);

  const toggleSelected = useCallback((mint: string): void => {
    setSelectedMints((prev) => {
      const next = new Set(prev);
      if (next.has(mint)) next.delete(mint);
      else next.add(mint);
      return next;
    });
  }, []);

  function handleBuildBatch(mints: string[]): void {
    if (mints.length === 0) return;
    setBuild({ status: "loading" });
    startBuildTransition(async () => {
      const res = await buildPnftBurnTxAction(walletAddress, mints);
      if (res.ok) setBuild({ status: "ready", result: res.result });
      else setBuild({ status: "error", error: res.error });
    });
  }

  function handleBuild(): void {
    handleBuildBatch(Array.from(selectedMints));
  }

  // No upfront selection cap — backend slices into per-tx batches.
  const canBuild =
    selectedMints.size > 0 && build.status !== "loading";

  // Publish pNFT selection state for the page-level sticky bar.
  const pnftReclaimSol = useMemo(() => {
    if (selectedMints.size === 0 || !candidates) return 0;
    let sum = 0;
    for (const c of candidates.burnable) {
      if (selectedMints.has(c.mint) && typeof c.estimatedGrossReclaimSol === "number") {
        sum += c.estimatedGrossReclaimSol;
      }
    }
    return sum;
  }, [selectedMints, candidates]);
  useBurnSelectionPublisher(
    "pnft",
    selectedMints.size,
    pnftReclaimSol,
    canBuild,
    candidates ? candidates.burnable.length : null,
  );

  const toggleGroupSelected = useCallback(
    (ids: string[], selectAll: boolean): void => {
      setSelectedMints((prev) => {
        const next = new Set(prev);
        for (const id of ids) {
          if (selectAll) next.add(id);
          else next.delete(id);
        }
        return next;
      });
    },
    [],
  );

  // collapsed/onToggle come from CleanerDetails so the action-plan panel
  // above can drive expansion. Local discovery/build state is unaffected.

  const headerCount =
    discover.status === "ready"
      ? `${discover.result.totalBurnable} burnable`
      : discover.status === "loading"
      ? null
      : "0 burnable";
  const headerSol =
    discover.status === "ready"
      ? (discover.result.includedPnfts[0]?.estimatedGrossReclaimSol ?? 0) *
        discover.result.totalBurnable
      : null;

  return (
    <div className="vl-burn-card m-3 overflow-hidden">
      <CollapsibleBurnHeader
        collapsed={collapsed}
        onToggle={onToggle}
        title="pNFT burn · max reclaim"
        count={headerCount}
        estSol={headerSol}
        toneBorder="border-red-600/40"
        toneBg="bg-red-600/15"
        toneText="text-red-200"
      />
      {!collapsed && (
        <>
          <div className="border-b border-red-500/20 bg-red-500/10 px-3 py-1.5 text-[11px] font-semibold text-red-200">
            ⚠ Destructive and irreversible. Uses Metaplex BurnV1 with token
            record, collection metadata, and auth-rules. Review the preview
            before signing.
          </div>

          {discover.status === "empty" && (
            <EmptyHint>
              No NFT-shaped token accounts found in this wallet.
            </EmptyHint>
          )}
          {discover.status === "loading" && (
            <EmptyHint>Discovering pNFTs…</EmptyHint>
          )}
          {discover.status === "error" && (
            <div className="flex flex-wrap items-center justify-between gap-2 bg-red-500/10 px-3 py-1.5 text-xs text-red-300">
              <span>
                <span className="font-semibold">Discovery failed:</span>{" "}
                {prettifyApiError(discover.error)}
              </span>
              <button
                type="button"
                onClick={runDiscover}
                aria-label="Retry pNFT discovery"
                className="rounded border border-red-500/40 bg-red-500/15 px-2 py-0.5 text-[10px] font-semibold text-red-100 transition-colors duration-100 hover:bg-red-500/25"
              >
                Retry discovery
              </button>
            </div>
          )}

          {discover.status === "ready" && candidates && (
            <>
              {candidates.burnable.length === 0 ? (
                <>
                  {/* Surface skipped reasons FIRST when nothing is burnable —
                      that's the "why" the user came here for. */}
                  {candidates.nonBurnable.length > 0 && (
                    <NonBurnableNftSummary entries={candidates.nonBurnable} />
                  )}
                  <EmptyHint>
                    {candidates.nonBurnable.length > 0
                      ? "0 pNFTs eligible for BurnV1. See the skipped-reason counts above."
                      : "No NFT-shape token accounts found in this wallet. If you hold Metaplex Core assets or legacy NFTs, try those sections."}
                  </EmptyHint>
                </>
              ) : (
                <>
                  {visible ? (
                    <BurnCandidateGroupGrid
                      items={candidates.burnable.map((c) => ({
                        id: c.mint,
                        name: c.name,
                        symbol: c.symbol,
                        image: c.image,
                        collection: c.collection,
                        estimatedGrossReclaimSol: c.estimatedGrossReclaimSol,
                      }))}
                      selected={selectedMints}
                      onToggle={toggleSelected}
                      onToggleGroup={toggleGroupSelected}
                      itemKindLabel="pNFT"
                    />
                  ) : (
                    <HiddenGridPlaceholder
                      count={candidates.burnable.length}
                      kind="pNFT"
                    />
                  )}
                  <button
                    type="button"
                    onClick={handleBuild}
                    disabled={!canBuild}
                    aria-label="Burn selected pNFTs"
                    data-vl-burn-trigger="pnft"
                    hidden
                  />
                  {build.status === "error" && (
                    <div className="border-t border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs text-red-300">
                      Build failed: {build.error}
                    </div>
                  )}
                  {build.status === "ready" && (
                    <PnftBurnPreview
                      result={build.result}
                      walletAddress={walletAddress}
                      onWalletRescan={onWalletRescan}
                      rescanPending={rescanPending}
                      onBuildBatch={handleBuildBatch}
                      onBurned={handleBurned}
                    />
                  )}
                  {candidates.nonBurnable.length > 0 && (
                    <NonBurnableNftSummary entries={candidates.nonBurnable} />
                  )}
                </>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function PnftCandidatesTable({
  rows,
  selected,
  onToggle,
}: {
  rows: {
    mint: string;
    tokenAccount: string;
    name: string | null;
    symbol: string | null;
    image: string | null;
    estimatedGrossReclaimSol: number | null;
  }[];
  selected: Set<string>;
  onToggle: (mint: string) => void;
}) {
  return (
    <div className="overflow-x-auto">
     <div className="min-w-[560px]">
      <div className="grid grid-cols-12 gap-3 border-b border-red-600/20 bg-red-600/[0.05] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-red-200/80">
        <div className="col-span-1">Burn</div>
        <div className="col-span-5">Name</div>
        <div className="col-span-2">Symbol</div>
        <div className="col-span-2">Mint</div>
        <div className="col-span-2 text-right">Reclaim</div>
      </div>
      <div>
        {rows.map((r) => {
          const isChecked = selected.has(r.mint);
          const isBatchOverflow = r.estimatedGrossReclaimSol === null;
          return (
            <label
              key={r.tokenAccount}
              className={`grid cursor-pointer grid-cols-12 items-center gap-3 border-b border-[color:var(--vl-border)] px-3 py-1.5 text-xs last:border-b-0 transition-colors duration-[var(--vl-motion,180ms)] hover:bg-[rgba(168,144,232,0.06)] ${
                isChecked ? "bg-[var(--vl-purple-soft)] ring-1 ring-inset ring-[var(--vl-purple-border)]" : ""
              }`}
            >
              <div className="col-span-1">
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => onToggle(r.mint)}
                  aria-label={`Select ${r.name ?? "pNFT"} for burn`}
                  className="vl-checkbox h-3.5 w-3.5 cursor-pointer"
                />
              </div>
              <div className="col-span-5 flex min-w-0 items-center gap-2">
                <NftThumbnail src={r.image} alt={r.name ?? "pNFT"} />
                <div className="min-w-0 flex-1">
                  {r.name ? (
                    <div className="truncate font-semibold text-neutral-100">
                      {r.name}
                    </div>
                  ) : (
                    <div className="truncate font-mono text-[11px] text-neutral-400">
                      {shortAddr(r.mint, 4, 4)}
                    </div>
                  )}
                </div>
              </div>
              <div className="col-span-2 truncate text-[11px] text-neutral-300">
                {r.symbol ?? "—"}
              </div>
              <div className="col-span-2 truncate font-mono text-[11px] text-neutral-300">
                {shortAddr(r.mint, 4, 4)}
              </div>
              <div className="col-span-2 text-right font-semibold tabular-nums text-emerald-300/90">
                {isBatchOverflow ? "—" : fmtSol(r.estimatedGrossReclaimSol!)}
              </div>
            </label>
          );
        })}
      </div>
     </div>
    </div>
  );
}

function PnftBurnPreview({
  result,
  walletAddress,
  onWalletRescan,
  rescanPending,
  onBuildBatch,
  onBurned,
}: {
  result: BuildPnftBurnTxResult;
  walletAddress: string;
  onWalletRescan: () => void;
  rescanPending: boolean;
  onBuildBatch: (mints: string[]) => void;
  onBurned?: (mints: string[]) => void;
}) {
  const isCompact = useCompactMode();
  // pNFT BurnV1 uses the same Token Metadata program + opcode 41 as the
  // legacy NFT burn — the auth-rules / token-record accounts ride on the
  // BurnV1 instruction's account list. Reuse the existing legacy audit.
  const audit: LegacyNftAuditResult | null = useMemo(() => {
    if (result.transactionBase64 === null) return null;
    return auditLegacyNftBurnTx(result.transactionBase64);
  }, [result.transactionBase64]);
  const [ackDestructive, setAckDestructive] = useState(false);
  const tx = result.transactionBase64;
  const txShort =
    tx === null
      ? "—"
      : tx.length > 80
      ? `${tx.slice(0, 40)}…${tx.slice(-20)} (${tx.length} chars)`
      : tx;

  const rows: { label: string; value: React.ReactNode; mono?: boolean }[] = [
    {
      label: "blockhash present",
      value: presenceBadge(Boolean(result.blockhash)),
    },
    {
      label: "lastValidBlockHeight present",
      value: presenceBadge(
        result.lastValidBlockHeight !== null &&
          result.lastValidBlockHeight !== undefined,
      ),
    },
    {
      label: "Burn count",
      value: (
        <span className="font-bold text-red-200">
          {result.burnCount}
          <span className="ml-1 text-red-300/70">
            / {result.totalBurnable} eligible
          </span>
        </span>
      ),
    },
    {
      label: "Preflight simulation",
      value: result.simulationOk ? (
        <span className="inline-flex items-center gap-1.5 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] font-bold text-emerald-300 ring-1 ring-emerald-500/30">
          ✓ Passed
        </span>
      ) : (
        <span className="inline-flex flex-col gap-0.5">
          <span className="inline-flex w-fit items-center gap-1.5 rounded bg-red-500/15 px-1.5 py-0.5 text-[11px] font-bold text-red-300 ring-1 ring-red-500/30">
            ✕ Rejected
          </span>
          {result.simulationError && (
            <span className="text-[10px] text-red-300/80">
              {result.simulationError}
            </span>
          )}
        </span>
      ),
    },
    {
      label: "Gross reclaim",
      value: (
        <span className="font-bold text-emerald-300">
          {fmtSol(result.estimatedGrossReclaimSol)} SOL
        </span>
      ),
    },
    {
      label: "Estimated network fee",
      value: (
        <span className="text-neutral-200">
          {fmtSol(result.estimatedFeeSol)} SOL
          <span className="ml-1 text-[10px] text-neutral-500">
            (base {fmtSol(result.estimatedBaseFeeSol)}
            {result.estimatedPriorityFeeSol > 0 && (
              <> + priority {fmtSol(result.estimatedPriorityFeeSol)}</>
            )}
            ; {result.computeUnitLimit.toLocaleString()} CU
            {result.priorityFeeMicrolamports > 0 && (
              <> @ {result.priorityFeeMicrolamports} μL/CU</>
            )}
            )
          </span>
        </span>
      ),
    },
    {
      label: "Estimated net received",
      value: (
        <span className="font-bold text-emerald-300">
          {fmtSol(result.estimatedNetReclaimSol)} SOL
        </span>
      ),
    },
    {
      label: "Net wallet reclaim",
      value: (
        <NetReclaimCell
          netSol={result.netWalletReclaimSol}
          grossSol={result.estimatedGrossReclaimSol}
        />
      ),
    },
    {
      label: "Tx version",
      value: <Badge variant="info">{result.transactionVersion}</Badge>,
    },
    { label: "Fee payer", value: result.feePayer, mono: true },
    {
      label: "Requires signature from",
      value: result.requiresSignatureFrom,
      mono: true,
    },
    {
      label: "Transaction (base64)",
      value: txShort,
      mono: true,
    },
  ];

  const burnBlock = (
    <BurnSignAndSendBlock
      kindLabel="pNFT burn"
      transactionBase64={result.transactionBase64}
      blockhash={result.blockhash}
      lastValidBlockHeight={result.lastValidBlockHeight}
      requiresSignatureFrom={result.requiresSignatureFrom}
      targetWallet={walletAddress}
      auditPassed={audit?.ok === true}
      auditReason={audit?.reason ?? null}
      simulationOk={result.simulationOk}
      simulationRequired
      simulationError={result.simulationError}
      ackDestructive={ackDestructive}
      onToggleAck={() => setAckDestructive((v) => !v)}
      showAckCheckbox={true}
      onWalletRescan={onWalletRescan}
      rescanPending={rescanPending}
      nextBatchRemaining={result.nextBatchCandidates.length}
      onBuildNext={() =>
        onBuildBatch(result.nextBatchCandidates.map((c) => c.mint))
      }
      onBurned={() =>
        onBurned?.(result.includedPnfts.map((n) => n.mint))
      }
    />
  );
  if (isCompact) return burnBlock;

  return (
    <div className="border-t border-red-600/30 bg-red-950/35">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-red-600/40 bg-red-700/20 px-3 py-1.5">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-[10px] font-bold uppercase tracking-wider text-red-200">
            🔥 pNFT burn
          </span>
          <span className="text-[11px] font-semibold text-red-100">
            {result.burnCount} selected
          </span>
          <span className="text-[10px] text-red-300/80">
            · net{" "}
            <span className="font-bold text-emerald-300">
              {fmtSol(result.estimatedNetReclaimSol)} SOL
            </span>
          </span>
          {result.simulationOk ? (
            <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold text-emerald-300 ring-1 ring-emerald-500/30">
              ✓ preflight
            </span>
          ) : (
            <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] font-bold text-red-300 ring-1 ring-red-500/30">
              ✕ preflight
            </span>
          )}
        </div>
        <Badge variant="sell">manual sign · destructive</Badge>
      </div>
      {result.warning && (
        <div className="border-b border-red-500/15 bg-amber-500/5 px-3 py-1 text-[11px] text-amber-300">
          ⚠ {result.warning}
        </div>
      )}
      {burnBlock}
      <details className="group border-t border-red-600/15">
        <summary className="cursor-pointer list-none bg-red-600/[0.04] px-3 py-1.5 text-[11px] font-semibold text-red-300/80 transition-colors duration-100 hover:bg-red-600/10">
          <span className="inline-block w-3 transition-transform group-open:rotate-90">
            ▸
          </span>{" "}
          Transaction details
          {result.includedPnfts.length > 0 && (
            <span className="ml-2 text-[10px] text-red-300/60">
              ({result.includedPnfts.length} item
              {result.includedPnfts.length === 1 ? "" : "s"})
            </span>
          )}
        </summary>
        {result.includedPnfts.length > 0 && (
          <ul className="divide-y divide-red-600/15 border-b border-red-600/15">
            {result.includedPnfts.map((n: PnftBurnIncludedEntry) => (
              <li
                key={n.tokenAccount}
                className="grid grid-cols-12 items-center gap-3 px-3 py-1.5 text-xs"
              >
                <div className="col-span-5 min-w-0">
                  <div className="truncate font-semibold text-neutral-100">
                    {n.name ?? "—"}
                  </div>
                  <div className="truncate font-mono text-[10px] text-neutral-400">
                    {shortAddr(n.mint, 4, 4)}
                  </div>
                </div>
                <div className="col-span-2 truncate text-[11px] text-neutral-300">
                  {n.symbol ?? "—"}
                </div>
                <div className="col-span-2 truncate text-[10px] text-neutral-500">
                  {n.reason}
                </div>
                <div className="col-span-3 text-right font-semibold tabular-nums text-emerald-300/90">
                  {fmtSol(n.estimatedGrossReclaimSol)} SOL
                </div>
              </li>
            ))}
          </ul>
        )}
        {result.skippedPnfts.length > 0 && (
          <NonBurnableNftSummary
            entries={result.skippedPnfts as PnftBurnSkippedEntry[]}
          />
        )}
        <dl className="divide-y divide-red-600/15">
          {rows.map((r) => (
            <div
              key={r.label}
              className="grid grid-cols-12 items-center gap-3 px-3 py-1.5 text-xs"
            >
              <dt className="col-span-4 text-red-300/80">{r.label}</dt>
              <dd
                className={`col-span-8 min-w-0 break-all ${
                  r.mono
                    ? "font-mono text-[11px] text-neutral-100"
                    : "text-neutral-100"
                }`}
              >
                {r.value}
              </dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}

// =============================================================================
// Metaplex Core asset burn — Milestone 3 preview UI.
// Same two-phase pattern as PnftBurnSection. Differs in:
//   - Discovers via Core program (getProgramAccounts) — independent of
//     scan.nftTokenAccounts, which only enumerates SPL token accounts.
//   - Selection key is the Core asset address (no SPL "mint" for Core).
//   - Backend body uses `assetIds`, response uses `includedAssets` /
//     `skippedAssets`.
//   - Slightly deeper red (red-700) border so the section is visually
//     distinct from the pNFT (red-600) and legacy NFT (red-500) cards above.
// =============================================================================

type CoreDiscoverState =
  | { status: "loading" }
  | { status: "ready"; result: BuildCoreBurnTxResult }
  | { status: "error"; error: string };

type CoreBuildState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; result: BuildCoreBurnTxResult }
  | { status: "error"; error: string };

function CoreBurnSection({
  walletAddress,
  collapsed,
  onToggle,
  onWalletRescan,
  rescanPending,
  visible = true,
}: {
  walletAddress: string;
  collapsed: boolean;
  onToggle: () => void;
  onWalletRescan: () => void;
  rescanPending: boolean;
  // See LegacyNftBurnSection — perf gate that skips the candidate grid
  // render when the section is in a hidden tab. Discovery effect still
  // runs so state is preserved across tab switches.
  visible?: boolean;
}) {
  const isCompact = useCompactMode();
  const [discover, setDiscover] = useState<CoreDiscoverState>({
    status: "loading",
  });
  const [build, setBuild] = useState<CoreBuildState>({ status: "idle" });
  const [buildPending, startBuildTransition] = useTransition();
  const [selectedAssets, setSelectedAssets] = useState<Set<string>>(new Set());
  const discoverCancelRef = useRef<(() => void) | null>(null);

  // Section-scoped discovery. See LegacyNftBurnSection.runDiscover for the
  // pattern — Retry uses this same callback to re-fire only this section's
  // backend call without triggering a wallet rescan.
  const runDiscover = useCallback(() => {
    discoverCancelRef.current?.();
    let cancelled = false;
    discoverCancelRef.current = () => {
      cancelled = true;
    };
    setDiscover({ status: "loading" });
    setSelectedAssets(new Set());
    setBuild({ status: "idle" });
    (async () => {
      const res = await buildCoreBurnTxAction(walletAddress, []);
      if (cancelled) return;
      if (res.ok) setDiscover({ status: "ready", result: res.result });
      else setDiscover({ status: "error", error: res.error });
    })();
  }, [walletAddress]);

  // Discovery: one no-assetIds call on mount. Backend probes the Core
  // program for AssetV1 accounts owned by the wallet and returns up to N
  // burnable in includedAssets, with the rest in skippedAssets. The
  // discovery tx is for a default batch — we ignore it and rebuild against
  // the user's selection in the build phase.
  useEffect(() => {
    runDiscover();
    return () => {
      discoverCancelRef.current?.();
    };
  }, [runDiscover]);

  // Report this section's discovery to the parent reclaim-summary panel.
  // Core also has a preflight simulation gate (Permanent Freeze /
  // Burn-Delegate plugins, etc.). If simulationOk is false, exclude this
  // section's value from the running total per spec.
  const coreEntry: ReclaimEntry = (() => {
    if (discover.status === "loading")
      return { value: null, status: "loading" };
    if (discover.status === "error")
      return { value: null, status: "error" };
    const r = discover.result;
    if (r.totalBurnable === 0) return { value: 0, status: "empty" };
    if (!r.simulationOk) return { value: null, status: "rejected" };
    const per = r.includedAssets[0]?.estimatedGrossReclaimSol ?? 0;
    return { value: per * r.totalBurnable, status: "ready" };
  })();
  useReportReclaim("core", coreEntry);

  // Burnable candidates: includedAssets (full metadata) + skippedAssets
  // Two buckets — see LegacyNftBurnSection.candidates for the rationale.
  // Selectable table renders the full burnableCandidates list; the build
  // call narrows to the user's selection.
  // Local set of Core asset ids burned in this session — same pattern
  // as the legacy / pNFT sections. Filtered out of `candidates.burnable`
  // so the just-finalized assets disappear from the grid without
  // waiting for a rescan.
  const [burnedAssets, setBurnedAssets] = useState<Set<string>>(new Set());
  const handleBurned = useCallback((assets: string[]) => {
    if (assets.length === 0) return;
    setBurnedAssets((prev) => {
      const next = new Set(prev);
      for (const a of assets) next.add(a);
      return next;
    });
    setSelectedAssets((prev) => {
      const next = new Set(prev);
      for (const a of assets) next.delete(a);
      return next;
    });
    setBuild({ status: "idle" });
  }, []);

  const candidates = useMemo(() => {
    if (discover.status !== "ready") return null;
    const burnable = discover.result.burnableCandidates
      .filter((c) => !burnedAssets.has(c.asset))
      .map((c) => ({
        asset: c.asset,
        collection: c.collection,
        name: c.name,
        uri: c.uri,
        image: c.image,
        estimatedGrossReclaimSol: c.estimatedGrossReclaimSol as number | null,
      }));
    const nonBurnable = discover.result.skippedAssets.filter(
      (s) =>
        !(s.reason.startsWith("Cap of") || s.reason.startsWith("Trimmed to fit")),
    );
    return { burnable, nonBurnable };
  }, [discover, burnedAssets]);

  const toggleSelected = useCallback((asset: string): void => {
    setSelectedAssets((prev) => {
      const next = new Set(prev);
      if (next.has(asset)) next.delete(asset);
      else next.add(asset);
      return next;
    });
  }, []);

  function handleBuildBatch(assetIds: string[]): void {
    if (assetIds.length === 0) return;
    setBuild({ status: "loading" });
    startBuildTransition(async () => {
      const res = await buildCoreBurnTxAction(walletAddress, assetIds);
      if (res.ok) setBuild({ status: "ready", result: res.result });
      else setBuild({ status: "error", error: res.error });
    });
  }

  function handleBuild(): void {
    handleBuildBatch(Array.from(selectedAssets));
  }

  const canBuild =
    selectedAssets.size > 0 && build.status !== "loading";

  // Publish Core selection state for the page-level sticky bar.
  const coreReclaimSol = useMemo(() => {
    if (selectedAssets.size === 0 || !candidates) return 0;
    let sum = 0;
    for (const c of candidates.burnable) {
      if (selectedAssets.has(c.asset) && typeof c.estimatedGrossReclaimSol === "number") {
        sum += c.estimatedGrossReclaimSol;
      }
    }
    return sum;
  }, [selectedAssets, candidates]);
  useBurnSelectionPublisher(
    "core",
    selectedAssets.size,
    coreReclaimSol,
    canBuild,
    candidates ? candidates.burnable.length : null,
  );

  const toggleGroupSelected = useCallback(
    (ids: string[], selectAll: boolean): void => {
      setSelectedAssets((prev) => {
        const next = new Set(prev);
        for (const id of ids) {
          if (selectAll) next.add(id);
          else next.delete(id);
        }
        return next;
      });
    },
    [],
  );

  // collapsed/onToggle come from CleanerDetails (see other burn sections).

  const headerCount =
    discover.status === "ready"
      ? `${discover.result.totalBurnable} burnable`
      : discover.status === "loading"
      ? null
      : "0 burnable";
  const headerSol =
    discover.status === "ready"
      ? (discover.result.includedAssets[0]?.estimatedGrossReclaimSol ?? 0) *
        discover.result.totalBurnable
      : null;

  return (
    <div className="vl-burn-card m-3 overflow-hidden">
      <CollapsibleBurnHeader
        collapsed={collapsed}
        onToggle={onToggle}
        title="Core asset burn · max reclaim"
        count={headerCount}
        estSol={headerSol}
        toneBorder="border-red-700/50"
        toneBg="bg-red-700/20"
        toneText="text-red-200"
      />
      {!collapsed && (
        <>
          <div className="border-b border-red-600/25 bg-red-600/10 px-3 py-1.5 text-[11px] font-semibold text-red-200">
            ⚠ Destructive and irreversible. Uses Metaplex Core BurnV1 and
            reclaims the Core asset account rent. Review the preview before
            signing.
          </div>

          {discover.status === "loading" && (
            <EmptyHint>Discovering Core assets…</EmptyHint>
          )}
          {discover.status === "error" && (
            <div className="flex flex-wrap items-center justify-between gap-2 bg-red-600/10 px-3 py-1.5 text-xs text-red-300">
              <span>
                <span className="font-semibold">Discovery failed:</span>{" "}
                {prettifyApiError(discover.error)}
              </span>
              <button
                type="button"
                onClick={runDiscover}
                aria-label="Retry Core asset discovery"
                className="rounded border border-red-500/40 bg-red-500/15 px-2 py-0.5 text-[10px] font-semibold text-red-100 transition-colors duration-100 hover:bg-red-500/25"
              >
                Retry discovery
              </button>
            </div>
          )}

          {discover.status === "ready" && candidates && (
            <>
              {candidates.burnable.length === 0 &&
              candidates.nonBurnable.length === 0 ? (
                <EmptyHint>
                  No Metaplex Core assets found in this wallet.
                </EmptyHint>
              ) : candidates.burnable.length === 0 ? (
                <EmptyHint>
                  No Core assets eligible for BurnV1 in this wallet. See
                  skipped reasons below — assets with permanent freeze/burn
                  delegates or unsupported plugins are not burnable here.
                </EmptyHint>
              ) : (
                <>
                  {visible ? (
                    <BurnCandidateGroupGrid
                      items={candidates.burnable.map((c) => ({
                        id: c.asset,
                        name: c.name,
                        // Core has no symbol; pass null.
                        symbol: null,
                        image: c.image,
                        collection: c.collection,
                        estimatedGrossReclaimSol: c.estimatedGrossReclaimSol,
                      }))}
                      selected={selectedAssets}
                      onToggle={toggleSelected}
                      onToggleGroup={toggleGroupSelected}
                      itemKindLabel="asset"
                    />
                  ) : (
                    <HiddenGridPlaceholder
                      count={candidates.burnable.length}
                      kind="asset"
                    />
                  )}
                  <button
                    type="button"
                    onClick={handleBuild}
                    disabled={!canBuild}
                    aria-label="Burn selected Core assets"
                    data-vl-burn-trigger="core"
                    hidden
                  />
                  {build.status === "error" && (
                    <div className="border-t border-red-600/30 bg-red-600/10 px-3 py-1.5 text-xs text-red-300">
                      Build failed: {build.error}
                    </div>
                  )}
                  {build.status === "ready" && (
                    <CoreBurnPreview
                      result={build.result}
                      walletAddress={walletAddress}
                      onWalletRescan={onWalletRescan}
                      rescanPending={rescanPending}
                      onBuildBatch={handleBuildBatch}
                      onBurned={handleBurned}
                    />
                  )}
                </>
              )}
              {candidates.nonBurnable.length > 0 && (
                <NonBurnableNftSummary entries={candidates.nonBurnable} />
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function CoreCandidatesTable({
  rows,
  selected,
  onToggle,
}: {
  rows: {
    asset: string;
    collection: string | null;
    name: string | null;
    uri: string | null;
    image: string | null;
    estimatedGrossReclaimSol: number | null;
  }[];
  selected: Set<string>;
  onToggle: (asset: string) => void;
}) {
  return (
    <div className="overflow-x-auto">
     <div className="min-w-[560px]">
      <div className="grid grid-cols-12 gap-3 border-b border-red-700/25 bg-red-700/[0.06] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-red-200/80">
        <div className="col-span-1">Burn</div>
        <div className="col-span-6">Name</div>
        <div className="col-span-3">Asset</div>
        <div className="col-span-2 text-right">Reclaim</div>
      </div>
      <div>
        {rows.map((r) => {
          const isChecked = selected.has(r.asset);
          const isBatchOverflow = r.estimatedGrossReclaimSol === null;
          return (
            <label
              key={r.asset}
              className={`grid cursor-pointer grid-cols-12 items-center gap-3 border-b border-[color:var(--vl-border)] px-3 py-1.5 text-xs last:border-b-0 transition-colors duration-[var(--vl-motion,180ms)] hover:bg-[rgba(168,144,232,0.06)] ${
                isChecked
                  ? "bg-[var(--vl-purple-soft)] ring-1 ring-inset ring-[var(--vl-purple-border)]"
                  : ""
              }`}
            >
              <div className="col-span-1">
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => onToggle(r.asset)}
                  aria-label={`Select ${r.name ?? "Core asset"} for burn`}
                  className="vl-checkbox h-3.5 w-3.5 cursor-pointer"
                />
              </div>
              <div className="col-span-6 flex min-w-0 items-center gap-2">
                <NftThumbnail src={r.image} alt={r.name ?? "Core asset"} />
                <div className="min-w-0 flex-1">
                  {r.name ? (
                    <>
                      <div className="truncate font-semibold text-neutral-100">
                        {r.name}
                      </div>
                      {r.collection && (
                        <div className="truncate font-mono text-[10px] text-neutral-400">
                          coll {shortAddr(r.collection, 4, 4)}
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="truncate font-mono text-[11px] text-neutral-400">
                      {shortAddr(r.asset, 4, 4)}
                    </div>
                  )}
                </div>
              </div>
              <div className="col-span-3 truncate font-mono text-[11px] text-neutral-300">
                {shortAddr(r.asset, 4, 4)}
              </div>
              <div className="col-span-2 text-right font-semibold tabular-nums text-emerald-300/90">
                {isBatchOverflow ? "—" : fmtSol(r.estimatedGrossReclaimSol!)}
              </div>
            </label>
          );
        })}
      </div>
     </div>
    </div>
  );
}

function CoreBurnPreview({
  result,
  walletAddress,
  onWalletRescan,
  rescanPending,
  onBuildBatch,
  onBurned,
}: {
  result: BuildCoreBurnTxResult;
  walletAddress: string;
  onWalletRescan: () => void;
  rescanPending: boolean;
  onBuildBatch: (assetIds: string[]) => void;
  onBurned?: (assets: string[]) => void;
}) {
  const isCompact = useCompactMode();
  const audit: CoreBurnAuditResult | null = useMemo(() => {
    if (result.transactionBase64 === null) return null;
    return auditCoreBurnTx(result.transactionBase64);
  }, [result.transactionBase64]);
  const [ackDestructive, setAckDestructive] = useState(false);
  const tx = result.transactionBase64;
  const txShort =
    tx === null
      ? "—"
      : tx.length > 80
      ? `${tx.slice(0, 40)}…${tx.slice(-20)} (${tx.length} chars)`
      : tx;

  const rows: { label: string; value: React.ReactNode; mono?: boolean }[] = [
    {
      label: "blockhash present",
      value: presenceBadge(Boolean(result.blockhash)),
    },
    {
      label: "lastValidBlockHeight present",
      value: presenceBadge(
        result.lastValidBlockHeight !== null &&
          result.lastValidBlockHeight !== undefined,
      ),
    },
    {
      label: "Burn count",
      value: (
        <span className="font-bold text-red-200">
          {result.burnCount}
          <span className="ml-1 text-red-300/70">
            / {result.totalBurnable} eligible
          </span>
        </span>
      ),
    },
    {
      label: "Preflight simulation",
      value: result.simulationOk ? (
        <span className="inline-flex items-center gap-1.5 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] font-bold text-emerald-300 ring-1 ring-emerald-500/30">
          ✓ Passed
        </span>
      ) : (
        <span className="inline-flex flex-col gap-0.5">
          <span className="inline-flex w-fit items-center gap-1.5 rounded bg-red-500/15 px-1.5 py-0.5 text-[11px] font-bold text-red-300 ring-1 ring-red-500/30">
            ✕ Rejected
          </span>
          {result.simulationError && (
            <span className="text-[10px] text-red-300/80">
              {result.simulationError}
            </span>
          )}
        </span>
      ),
    },
    {
      label: "Gross reclaim",
      value: (
        <span className="font-bold text-emerald-300">
          {fmtSol(result.estimatedGrossReclaimSol)} SOL
        </span>
      ),
    },
    {
      label: "Estimated network fee",
      value: (
        <span className="text-neutral-200">
          {fmtSol(result.estimatedFeeSol)} SOL
          <span className="ml-1 text-[10px] text-neutral-500">
            (base {fmtSol(result.estimatedBaseFeeSol)}
            {result.estimatedPriorityFeeSol > 0 && (
              <> + priority {fmtSol(result.estimatedPriorityFeeSol)}</>
            )}
            ; {result.computeUnitLimit.toLocaleString()} CU
            {result.priorityFeeMicrolamports > 0 && (
              <> @ {result.priorityFeeMicrolamports} μL/CU</>
            )}
            )
          </span>
        </span>
      ),
    },
    {
      label: "Estimated net received",
      value: (
        <span className="font-bold text-emerald-300">
          {fmtSol(result.estimatedNetReclaimSol)} SOL
        </span>
      ),
    },
    {
      label: "Net wallet reclaim",
      value: (
        <NetReclaimCell
          netSol={result.netWalletReclaimSol}
          grossSol={result.estimatedGrossReclaimSol}
        />
      ),
    },
    {
      label: "Tx version",
      value: <Badge variant="info">{result.transactionVersion}</Badge>,
    },
    { label: "Fee payer", value: result.feePayer, mono: true },
    {
      label: "Requires signature from",
      value: result.requiresSignatureFrom,
      mono: true,
    },
    {
      label: "Transaction (base64)",
      value: txShort,
      mono: true,
    },
  ];

  const burnBlock = (
    <BurnSignAndSendBlock
      kindLabel="Core asset burn"
      transactionBase64={result.transactionBase64}
      blockhash={result.blockhash}
      lastValidBlockHeight={result.lastValidBlockHeight}
      requiresSignatureFrom={result.requiresSignatureFrom}
      targetWallet={walletAddress}
      auditPassed={audit?.ok === true}
      auditReason={audit?.reason ?? null}
      simulationOk={result.simulationOk}
      simulationRequired
      simulationError={result.simulationError}
      ackDestructive={ackDestructive}
      onToggleAck={() => setAckDestructive((v) => !v)}
      showAckCheckbox={true}
      onWalletRescan={onWalletRescan}
      rescanPending={rescanPending}
      nextBatchRemaining={result.nextBatchCandidates.length}
      onBuildNext={() =>
        onBuildBatch(result.nextBatchCandidates.map((c) => c.asset))
      }
      onBurned={() =>
        onBurned?.(result.includedAssets.map((a) => a.asset))
      }
    />
  );
  if (isCompact) return burnBlock;

  return (
    <div className="border-t border-red-700/40 bg-red-950/40">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-red-700/50 bg-red-800/25 px-3 py-1.5">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-[10px] font-bold uppercase tracking-wider text-red-200">
            🔥 Core asset burn
          </span>
          <span className="text-[11px] font-semibold text-red-100">
            {result.burnCount} selected
          </span>
          <span className="text-[10px] text-red-300/80">
            · net{" "}
            <span className="font-bold text-emerald-300">
              {fmtSol(result.estimatedNetReclaimSol)} SOL
            </span>
          </span>
          {result.simulationOk ? (
            <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold text-emerald-300 ring-1 ring-emerald-500/30">
              ✓ preflight
            </span>
          ) : (
            <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] font-bold text-red-300 ring-1 ring-red-500/30">
              ✕ preflight
            </span>
          )}
        </div>
        <Badge variant="sell">manual sign · destructive</Badge>
      </div>
      {result.warning && (
        <div className="border-b border-red-600/20 bg-amber-500/5 px-3 py-1 text-[11px] text-amber-300">
          ⚠ {result.warning}
        </div>
      )}
      {burnBlock}
      <details className="group border-t border-red-700/20">
        <summary className="cursor-pointer list-none bg-red-700/[0.04] px-3 py-1.5 text-[11px] font-semibold text-red-300/80 transition-colors duration-100 hover:bg-red-700/10">
          <span className="inline-block w-3 transition-transform group-open:rotate-90">
            ▸
          </span>{" "}
          Transaction details
          {result.includedAssets.length > 0 && (
            <span className="ml-2 text-[10px] text-red-300/60">
              ({result.includedAssets.length} item
              {result.includedAssets.length === 1 ? "" : "s"})
            </span>
          )}
        </summary>
        {result.includedAssets.length > 0 && (
          <ul className="divide-y divide-red-700/20 border-b border-red-700/20">
            {result.includedAssets.map((a: CoreBurnIncludedEntry) => (
              <li
                key={a.asset}
                className="grid grid-cols-12 items-center gap-3 px-3 py-1.5 text-xs"
              >
                <div className="col-span-5 min-w-0">
                  <div className="truncate font-semibold text-neutral-100">
                    {a.name ?? "—"}
                  </div>
                  <div className="truncate font-mono text-[10px] text-neutral-400">
                    {shortAddr(a.asset, 4, 4)}
                  </div>
                </div>
                <div className="col-span-2 truncate font-mono text-[11px] text-neutral-300">
                  {a.collection ? shortAddr(a.collection, 4, 4) : "—"}
                </div>
                <div className="col-span-2 truncate text-[10px] text-neutral-500">
                  {a.reason}
                </div>
                <div className="col-span-3 text-right font-semibold tabular-nums text-emerald-300/90">
                  {fmtSol(a.estimatedGrossReclaimSol)} SOL
                </div>
              </li>
            ))}
          </ul>
        )}
        {result.skippedAssets.length > 0 && (
          <NonBurnableNftSummary
            entries={result.skippedAssets as CoreBurnSkippedEntry[]}
          />
        )}
        <dl className="divide-y divide-red-700/20">
          {rows.map((r) => (
            <div
              key={r.label}
              className="grid grid-cols-12 items-center gap-3 px-3 py-1.5 text-xs"
            >
              <dt className="col-span-4 text-red-300/80">{r.label}</dt>
              <dd
                className={`col-span-8 min-w-0 break-all ${
                  r.mono
                    ? "font-mono text-[11px] text-neutral-100"
                    : "text-neutral-100"
                }`}
              >
                {r.value}
              </dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}

function SubHeader({ label, right }: { label: string; right?: string }) {
  return (
    <div className="flex items-baseline justify-between border-b border-[color:var(--vl-border)] px-3 py-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-300">
        {label}
      </span>
      {right && (
        <span className="text-[11px] tabular-nums text-neutral-400">{right}</span>
      )}
    </div>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 py-4 text-center text-xs text-neutral-500">{children}</div>
  );
}

// Renders the simulation-based net wallet reclaim (post − pre) with a
// soft warning when it falls short of the asset rent estimate. Used in
// Legacy / pNFT / Core burn previews. SPL closeAccount path doesn't
// need it — its reclaim is exact and already shown.
function NetReclaimCell({
  netSol,
  grossSol,
}: {
  netSol: number | null;
  grossSol: number;
}) {
  if (netSol === null) {
    return (
      <span className="text-[11px] text-[color:var(--vl-fg-3)]">
        —{" "}
        <span className="text-[10px] text-[color:var(--vl-fg-3)]">
          (sim did not return wallet balance)
        </span>
      </span>
    );
  }
  // Treat near-equal as no-warn — fee + tiny rounding can put net just
  // below gross even on a clean burn. >0.0005 SOL gap is meaningful.
  const shortBy = grossSol - netSol;
  const showWarn = shortBy > 0.0005;
  return (
    <span className="flex flex-col items-end gap-0.5">
      <span className="font-bold text-emerald-300">{fmtSol(netSol)} SOL</span>
      <span className="text-[10px] text-[color:var(--vl-fg-3)]">
        Asset rent: {fmtSol(grossSol)} SOL
      </span>
      {showWarn && (
        <span className="text-[10px] text-amber-300/90">
          Collection plugins/fees may reduce reclaim.
        </span>
      )}
    </span>
  );
}

// Clickable header for the four destructive burn sections (SPL / Legacy /
// pNFT / Core). Toggles the section open/closed without remounting the
// section body — discovery state is preserved by virtue of the parent
// keeping the section component mounted; only the inner content is
// conditionally rendered. Pure UI; no fetch is triggered.
// Hidden close-empty trigger + selection publisher. Close-empty has no
// per-item selection — every empty account in the wallet is a candidate
// — so the "selected count" is the empty-account count and the reclaim
// is the total empty-account rent. Publishes both into the registry so
// the sticky bar can show real numbers when the Empty Accounts tab is
// active. The hidden button is the actual `.click()` target.
function CloseEmptyHiddenTrigger({
  handleBuildTx,
  disabled,
  emptyCount,
  reclaimSol,
}: {
  handleBuildTx: () => void;
  disabled: boolean;
  emptyCount: number;
  reclaimSol: number;
}) {
  useBurnSelectionPublisher(
    "closeEmpty",
    emptyCount,
    reclaimSol,
    !disabled && emptyCount > 0,
  );
  return (
    <button
      type="button"
      hidden
      aria-hidden
      tabIndex={-1}
      onClick={handleBuildTx}
      disabled={disabled}
      data-vl-burn-trigger="closeEmpty"
    />
  );
}

function CollapsibleBurnHeader({
  collapsed,
  onToggle,
  title,
  count,
  estSol,
}: {
  collapsed: boolean;
  onToggle: () => void;
  title: string;
  // `count` and `estSol` are nullable so loading/error states can render
  // a placeholder ("scanning…") rather than zeroes.
  count: string | null;
  estSol: number | null;
  // Legacy red-tone props are accepted-and-ignored for back-compat with
  // the four existing call sites — visual tone now comes from the
  // unified .vl-burn-section-* utilities so every burn section reads as
  // a product section, not a red error accordion.
  toneBorder?: string;
  toneBg?: string;
  toneText?: string;
}) {
  const summary =
    count === null
      ? "scanning…"
      : estSol === null
      ? count
      : `${count} · ${fmtSol(estSol)} SOL`;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      className="vl-burn-section-head"
    >
      <span className="vl-burn-section-title">
        <span className="inline-block w-2 text-[9px] opacity-70">
          {collapsed ? "▶" : "▼"}
        </span>
        {title}
      </span>
      <span className="vl-burn-section-summary">{summary}</span>
    </button>
  );
}

function EmptyAccountsTable({ rows }: { rows: ScannedTokenAccount[] }) {
  return (
    <div className="overflow-x-auto">
     <div className="min-w-[480px]">
      <div className="grid grid-cols-12 gap-3 border-b border-[color:var(--vl-border)] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
        <div className="col-span-5">Token account</div>
        <div className="col-span-5">Mint</div>
        <div className="col-span-2 text-right">Reclaim SOL</div>
      </div>
      <div>
        {rows.map((r) => (
          <div
            key={r.tokenAccount}
            className="grid grid-cols-12 items-center gap-3 border-b border-[color:var(--vl-border)] px-3 py-1.5 text-xs last:border-b-0"
          >
            <div className="col-span-5 truncate font-mono text-neutral-100">
              {shortAddr(r.tokenAccount, 6, 6)}
            </div>
            <div className="col-span-5 truncate font-mono text-neutral-300">
              {shortAddr(r.mint, 6, 6)}
            </div>
            <div className="col-span-2 text-right font-semibold tabular-nums text-emerald-300">
              {fmtSol(r.estimatedReclaimSol)}
            </div>
          </div>
        ))}
      </div>
     </div>
    </div>
  );
}

function BurnCandidatesTable({
  rows,
  selected,
  onToggle,
}: {
  rows: BurnCandidate[];
  selected: Set<string>;
  onToggle: (mint: string) => void;
}) {
  return (
    <div className="overflow-x-auto">
     <div className="min-w-[720px]">
      <div className="grid grid-cols-12 gap-3 border-b border-red-500/20 bg-red-500/[0.03] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-red-300/80">
        <div className="col-span-1">Burn</div>
        <div className="col-span-2">Token</div>
        <div className="col-span-2">Mint</div>
        <div className="col-span-2 text-right">Amount</div>
        <div className="col-span-1 text-right">Dec.</div>
        <div className="col-span-2 text-right">Reclaim (burn+close)</div>
        <div className="col-span-1">Risk</div>
        <div className="col-span-1">Rec?</div>
      </div>
      <div>
        {rows.map((r) => {
          // Rows where burnRecommended=false get a stronger visual: red strip
          // background + red badge in the last column, so the user can't miss
          // that this token needs manual review before any (future) burn.
          const rowTint = r.burnRecommended ? "" : "bg-red-500/[0.06]";
          const isChecked = selected.has(r.mint);
          // Headline is the symbol when present, then name, then short
          // mint as a final fallback. We never display a misleading
          // "unknown token" — the mint short addr is unambiguous and
          // identifies the token to anyone who needs to look it up.
          const headline =
            r.symbol ?? r.name ?? shortAddr(r.mint, 4, 4);
          const subline =
            r.symbol && r.name && r.name !== r.symbol ? r.name : null;
          return (
            <label
              key={r.tokenAccount}
              className={`grid cursor-pointer grid-cols-12 items-center gap-3 border-b border-[color:var(--vl-border)] px-3 py-1.5 text-xs last:border-b-0 transition-colors duration-[var(--vl-motion,180ms)] hover:bg-[rgba(168,144,232,0.06)] ${rowTint} ${isChecked ? "bg-[var(--vl-purple-soft)] ring-1 ring-inset ring-[var(--vl-purple-border)]" : ""}`}
            >
              <div className="col-span-1">
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => onToggle(r.mint)}
                  aria-label={`Select ${r.symbol ?? r.name ?? r.mint} for burn`}
                  className="vl-checkbox h-3.5 w-3.5 cursor-pointer"
                />
              </div>
              <div className="col-span-2 flex min-w-0 items-center gap-2">
                <NftThumbnail src={r.image} alt={r.symbol ?? r.name ?? "token"} />
                <div className="min-w-0 flex-1">
                  <div
                    className={`truncate font-semibold ${
                      r.symbol || r.name
                        ? "text-neutral-100"
                        : "font-mono text-[11px] text-neutral-300"
                    }`}
                  >
                    {headline}
                  </div>
                  {subline && (
                    <div className="truncate text-[10px] text-neutral-400">
                      {subline}
                    </div>
                  )}
                </div>
              </div>
              <div className="col-span-2 truncate font-mono text-[11px] text-neutral-300">
                {shortAddr(r.mint, 4, 4)}
              </div>
              <div className="col-span-2 text-right tabular-nums text-neutral-100">
                {fmtNumber(r.uiAmount)}
              </div>
              <div className="col-span-1 text-right tabular-nums text-neutral-400">
                {r.decimals}
              </div>
              <div className="col-span-2 text-right font-semibold tabular-nums text-emerald-300/90">
                {fmtSol(r.estimatedReclaimSolAfterBurnAndClose)}
              </div>
              <div className="col-span-1">
                <Badge variant={r.riskLevel === "unknown" ? "warn" : "neutral"}>
                  {r.riskLevel}
                </Badge>
              </div>
              <div className="col-span-1">
                {r.burnRecommended ? (
                  <Badge variant="buy">Yes</Badge>
                ) : (
                  <Badge variant="sell">No</Badge>
                )}
              </div>
            </label>
          );
        })}
      </div>
     </div>
    </div>
  );
}


// ============================================================================
// CSV export for the Group Cleaner overview.
// Builds rows from the ScanRegistry (only scanned wallets), pulls labels
// from the WalletEntry list, escapes per RFC 4180, and triggers a browser
// download. No new deps — pure Blob + URL.createObjectURL + <a download>.
// ============================================================================

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function exportCleanerOverviewCsv(
  wallets: WalletEntry[],
  scans: Record<string, ScanSummary>,
): void {
  if (typeof window === "undefined") return;

  const header = [
    "wallet",
    "label",
    "emptyAccounts",
    "grossReclaimSol",
    "burnCandidates",
    "nfts",
  ];
  const lines = [header.join(",")];
  // Walk wallets in display order, but only include those that have been
  // scanned. Keeps the file aligned with the rows the user actually sees.
  for (const w of wallets) {
    const s = scans[w.address];
    if (!s) continue;
    lines.push(
      [
        csvEscape(w.address),
        csvEscape(w.label ?? ""),
        String(s.empty),
        String(s.reclaimSol),
        String(s.fungible),
        String(s.nft),
      ].join(","),
    );
  }
  // CRLF for broader Excel compatibility.
  const csv = lines.join("\r\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const today = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `cleaner-overview-${today}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
