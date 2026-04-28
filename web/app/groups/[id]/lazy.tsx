"use client";

// Client-side lazy wrappers for the heavy sections. Each one fetches its own
// data on mount via a server action, with loading/error/retry states. Mounting
// is gated by the parent tab, so the fetch only fires when the tab is active.

import { useCallback, useEffect, useRef, useState } from "react";
import { prettifyApiError } from "@/lib/prettifyError";
import type {
  AirdropsState,
  GroupLpResponse,
  GroupTradesFilters,
  GroupTradesResponse,
  OverviewResponse,
  PortfolioResponse,
  TokenActivityResponse,
  TradeItem,
} from "@/lib/api";
import {
  loadAirdropsAction,
  loadLpAction,
  loadOverviewAction,
  loadPortfolioAction,
  loadTokenSummaryAction,
  loadTradesAction,
} from "../actions";
import { AlertsSection } from "./alerts";
import {
  AirdropsView,
  FilteredTradesView,
  LpView,
  Panel,
  PanelError,
  PanelSkeleton,
  PnlOverviewLoadingSkeleton,
  PnlOverviewView,
  PortfolioLoadingSkeleton,
  PortfolioView,
  RecentTradesView,
  TokenActivityView,
  TradesLoadingSkeleton,
  computeWalletScores,
  type ScoredWallet,
} from "./sections";
import { fmtTime, fmtUsd, shortAddr } from "@/lib/format";
import { TxLink } from "@/ui-kit/components/TxLink";
import { WalletLink } from "@/ui-kit/components/WalletLink";
import { solscanTxUrl } from "@/lib/wallet";
import Link from "next/link";

type LoadState<T> =
  | { status: "loading" }
  | { status: "ok"; data: T }
  | { status: "error"; error: string };

// Dev-only timing wrapper. process.env.NODE_ENV is statically inlined by
// Next.js at build, so the production bundle drops the console calls.
const IS_DEV = process.env.NODE_ENV !== "production";
let labelCounter = 0;
async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (!IS_DEV) return fn();
  const tag = `lazy:${label}#${++labelCounter}`;
  console.time(tag);
  try {
    return await fn();
  } finally {
    console.timeEnd(tag);
  }
}

function useLazyLoad<T>(
  label: string,
  loader: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>,
  opts?: { initialDelayMs?: number },
): { state: LoadState<T>; reload: () => void } {
  const [state, setState] = useState<LoadState<T>>({ status: "loading" });
  // Keep loader reference stable-ish; we re-run only on mount + manual reload.
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const reload = useCallback(() => {
    setState({ status: "loading" });
    let cancelled = false;
    (async () => {
      const res = await timed(label, () => loaderRef.current());
      if (cancelled) return;
      if (res.ok) setState({ status: "ok", data: res.data });
      else setState({ status: "error", error: prettifyApiError(res.error) });
    })();
    return () => {
      cancelled = true;
    };
  }, [label]);

  useEffect(() => {
    let cancelled = false;
    let cleanupFromReload: (() => void) | undefined;
    const delay = opts?.initialDelayMs ?? 0;
    const t = setTimeout(() => {
      if (cancelled) return;
      cleanupFromReload = reload();
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(t);
      cleanupFromReload?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { state, reload };
}

// Re-export so call sites that already import from this module keep working.
export { prettifyApiError };

// Module-level cache so PnL overview survives tab unmount/remount. Keyed by
// groupId; same-key remount uses cached data instantly with no auto-refetch.
const overviewCache = new Map<
  string,
  { data: OverviewResponse; fetchedAt: number }
>();

export function LazyPnlOverview({
  groupId,
  initialDelayMs = 0,
}: {
  groupId: string;
  initialDelayMs?: number;
}) {
  const cached = overviewCache.get(groupId);
  const [data, setData] = useState<OverviewResponse | null>(cached?.data ?? null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(cached?.fetchedAt ?? null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(() => {
    setRefreshing(true);
    setError(null);
    let cancelled = false;
    (async () => {
      const res = await timed("overview", () => loadOverviewAction(groupId));
      if (cancelled) return;
      if (res.ok) {
        const now = Date.now();
        overviewCache.set(groupId, { data: res.data, fetchedAt: now });
        setData(res.data);
        setFetchedAt(now);
      } else {
        setError(prettifyApiError(res.error));
      }
      setRefreshing(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [groupId]);

  useEffect(() => {
    if (data) return;
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    const t = setTimeout(() => {
      if (cancelled) return;
      cleanup = load();
    }, initialDelayMs);
    return () => {
      cancelled = true;
      clearTimeout(t);
      cleanup?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!data) {
    if (error) return <PanelError title="PnL overview" error={error} onRetry={load} />;
    return <PnlOverviewLoadingSkeleton />;
  }

  return (
    <>
      <PnlOverviewView
        data={data}
        headerRight={
          <RefreshHeaderRight
            fetchedAt={fetchedAt}
            refreshing={refreshing}
            onRefresh={load}
          />
        }
      />
      {error && (
        <div className="-mt-2 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-1.5 text-xs text-red-300">
          Refresh failed: {error}
        </div>
      )}
    </>
  );
}

// Module-level cache so portfolio data survives tab unmount/remount (the parent
// only mounts Positions-tab content when active). Keyed by groupId; stays for
// the lifetime of the page.
const portfolioCache = new Map<
  string,
  { data: PortfolioResponse; fetchedAt: number }
>();

export function LazyPortfolio({
  groupId,
  initialDelayMs = 0,
}: {
  groupId: string;
  initialDelayMs?: number;
}) {
  const cached = portfolioCache.get(groupId);
  const [data, setData] = useState<PortfolioResponse | null>(cached?.data ?? null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(cached?.fetchedAt ?? null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(() => {
    setRefreshing(true);
    setError(null);
    let cancelled = false;
    (async () => {
      const res = await timed("portfolio", () => loadPortfolioAction(groupId));
      if (cancelled) return;
      if (res.ok) {
        const now = Date.now();
        portfolioCache.set(groupId, { data: res.data, fetchedAt: now });
        setData(res.data);
        setFetchedAt(now);
      } else {
        setError(prettifyApiError(res.error));
      }
      setRefreshing(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [groupId]);

  // Fetch on mount only when no cached data. If we already have data from a
  // previous mount, skip the fetch — user can hit Refresh manually.
  useEffect(() => {
    if (data) return;
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    const t = setTimeout(() => {
      if (cancelled) return;
      cleanup = load();
    }, initialDelayMs);
    return () => {
      cancelled = true;
      clearTimeout(t);
      cleanup?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // First load, no data yet
  if (!data) {
    if (error) return <PanelError title="Portfolio" error={error} onRetry={load} />;
    return <PortfolioLoadingSkeleton />;
  }

  // Have data — render with refresh chrome. Cached data stays visible while
  // refreshing; refresh errors surface as a non-blocking banner.
  return (
    <>
      <PortfolioView
        data={data}
        headerRight={
          <RefreshHeaderRight
            fetchedAt={fetchedAt}
            refreshing={refreshing}
            onRefresh={load}
          />
        }
      />
      {error && (
        <div className="-mt-2 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-1.5 text-xs text-red-300">
          Refresh failed: {error}
        </div>
      )}
    </>
  );
}

// Shared header chrome for panels that support manual refresh + last-updated.
function RefreshHeaderRight({
  fetchedAt,
  refreshing,
  onRefresh,
}: {
  fetchedAt: number | null;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <span className="ml-3 inline-flex items-center gap-2 text-[11px] text-neutral-400">
      <span className="text-neutral-500">·</span>
      <LastUpdated fetchedAt={fetchedAt} refreshing={refreshing} />
      <button
        type="button"
        onClick={onRefresh}
        disabled={refreshing}
        className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-[11px] font-semibold text-white transition-colors duration-100 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {refreshing ? "Refreshing…" : "Refresh"}
      </button>
    </span>
  );
}

function LastUpdated({
  fetchedAt,
  refreshing,
}: {
  fetchedAt: number | null;
  refreshing: boolean;
}) {
  // Re-render every 10s so the relative timestamp stays fresh.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 10_000);
    return () => clearInterval(id);
  }, []);

  if (refreshing) {
    return (
      <span className="inline-flex items-center gap-1.5 text-violet-300">
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-violet-400" />
        Refreshing…
      </span>
    );
  }

  if (fetchedAt === null) return <span className="text-neutral-500">—</span>;

  const ageSec = Math.max(0, Math.floor((Date.now() - fetchedAt) / 1000));
  let label: string;
  if (ageSec < 5) label = "Last updated now";
  else if (ageSec < 60) label = `Last updated ${ageSec}s ago`;
  else if (ageSec < 3600) label = `Last updated ${Math.floor(ageSec / 60)}m ago`;
  else label = `Last updated ${Math.floor(ageSec / 3600)}h ago`;

  return <span className="text-neutral-400">{label}</span>;
}

export function LazyLp({
  groupId,
  initialDelayMs = 0,
}: {
  groupId: string;
  initialDelayMs?: number;
}) {
  const { state, reload } = useLazyLoad<GroupLpResponse>(
    "lp",
    () => loadLpAction(groupId),
    { initialDelayMs },
  );
  if (state.status === "loading") return <PanelSkeleton title="LP Positions" lines={3} />;
  if (state.status === "error")
    return <PanelError title="LP Positions" error={state.error} onRetry={reload} />;
  return <LpView data={state.data} />;
}

export function LazyAirdrops({
  groupId,
  initialDelayMs = 0,
}: {
  groupId: string;
  initialDelayMs?: number;
}) {
  const { state, reload } = useLazyLoad<AirdropsState>(
    "airdrops",
    () => loadAirdropsAction(groupId),
    { initialDelayMs },
  );
  if (state.status === "loading") return <PanelSkeleton title="Airdrops" lines={3} />;
  if (state.status === "error")
    return <PanelError title="Airdrops" error={state.error} onRetry={reload} />;
  return <AirdropsView state={state.data} />;
}

export function LazyTokenActivity({ groupId }: { groupId: string }) {
  const { state, reload } = useLazyLoad<TokenActivityResponse>("token-activity", () =>
    loadTokenSummaryAction(groupId),
  );
  if (state.status === "loading") return <PanelSkeleton title="Token activity" lines={6} />;
  if (state.status === "error")
    return <PanelError title="Token activity" error={state.error} onRetry={reload} />;
  return <TokenActivityView data={state.data} />;
}

// Module-level cache so trades survive tab unmount/remount and filter
// transitions. Keyed by groupId + serialized filters. A different cache key
// (e.g. user changes filters) triggers a fresh fetch on mount; the same key
// reuses the cached response with no auto-refetch.
const tradesCache = new Map<
  string,
  { data: GroupTradesResponse; fetchedAt: number }
>();
function tradesCacheKey(groupId: string, filters: GroupTradesFilters): string {
  return `${groupId}|${JSON.stringify(filters)}`;
}

export function LazyTrades({
  groupId,
  filters,
  hasFilters,
}: {
  groupId: string;
  filters: GroupTradesFilters;
  hasFilters: boolean;
}) {
  const cacheKey = tradesCacheKey(groupId, filters);
  // Track latest filters in a ref so the loader closure always uses the
  // current value — important if the user changes filters mid-fetch.
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const initial = tradesCache.get(cacheKey);
  const [data, setData] = useState<GroupTradesResponse | null>(initial?.data ?? null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(initial?.fetchedAt ?? null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(() => {
    setRefreshing(true);
    setError(null);
    let cancelled = false;
    (async () => {
      const keyAtStart = tradesCacheKey(groupId, filtersRef.current);
      const res = await timed("trades", () =>
        loadTradesAction(groupId, filtersRef.current),
      );
      if (cancelled) return;
      if (res.ok) {
        const now = Date.now();
        tradesCache.set(keyAtStart, { data: res.data, fetchedAt: now });
        setData(res.data);
        setFetchedAt(now);
      } else {
        setError(prettifyApiError(res.error));
      }
      setRefreshing(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [groupId]);

  // Cache lookup by current filters key. When filters change, swap to the
  // cached value for the new key (instant) — or fetch if we haven't seen it.
  useEffect(() => {
    const cached = tradesCache.get(cacheKey);
    if (cached) {
      setData(cached.data);
      setFetchedAt(cached.fetchedAt);
      setError(null);
      return;
    }
    // No cached entry for this filter combination — fetch.
    const cleanup = load();
    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey]);

  const trades: TradeItem[] = data?.trades ?? [];

  // Initial cold load: no data yet. Show trade-shaped skeleton + an
  // AlertsSection on empty so the Local Preview Alerts panel still renders.
  if (!data) {
    return (
      <>
        {error ? (
          <PanelError title="Recent trades" error={error} onRetry={load} />
        ) : (
          <TradesLoadingSkeleton />
        )}
        <AlertsSection trades={[]} />
      </>
    );
  }

  const headerRight = (
    <RefreshHeaderRight
      fetchedAt={fetchedAt}
      refreshing={refreshing}
      onRefresh={load}
    />
  );
  const filtersForView = {
    minUsd: typeof filters.minUsd === "string" ? filters.minUsd : undefined,
    token: filters.token,
    side: filters.side,
    program: filters.program,
  };

  return (
    <>
      {filters.token && (
        <TokenDetailPanel
          groupId={groupId}
          mint={filters.token}
          trades={trades}
        />
      )}
      {hasFilters ? (
        <FilteredTradesView
          trades={trades}
          error={null}
          filters={filtersForView}
          headerRight={headerRight}
        />
      ) : (
        <RecentTradesView data={data} headerRight={headerRight} />
      )}
      {error && (
        <div className="-mt-2 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-1.5 text-xs text-red-300">
          Refresh failed: {error}
        </div>
      )}
      <AlertsSection trades={trades} />
    </>
  );
}

// ============================================================================
// LazySmartSignals — feed of buy signals from top-scoring wallets.
// ----------------------------------------------------------------------------
// Reuses two module-level caches that already exist on the page:
//   - overviewCache (populated when LazyPnlOverview loads on Positions tab)
//   - tradesCache   (populated when LazyTrades loads on Activity tab)
// Adds zero new HTTP traffic; if either cache is empty we render a hint
// telling the user which tab to visit. No polling — view re-renders on the
// usual React re-render cycles, which fire whenever the underlying lazy
// panels refresh their cached entries.
// ============================================================================

// Quote tokens we treat as the "spent" side of a buy. A trade where the user
// sent one of these and received something else is classified as a buy of
// the received token.
const QUOTE_SYMBOLS = new Set(["SOL", "WSOL", "USDC", "USDT", "USDH", "EURC"]);

function isBuyTrade(t: TradeItem): boolean {
  const fromSym = (t.from?.token?.symbol ?? "").toUpperCase();
  const toSym = (t.to?.token?.symbol ?? "").toUpperCase();
  return QUOTE_SYMBOLS.has(fromSym) && !QUOTE_SYMBOLS.has(toSym);
}

// A sell is the inverse: spent something non-quote, received a quote token.
function isSellTrade(t: TradeItem): boolean {
  const fromSym = (t.from?.token?.symbol ?? "").toUpperCase();
  const toSym = (t.to?.token?.symbol ?? "").toUpperCase();
  return !QUOTE_SYMBOLS.has(fromSym) && QUOTE_SYMBOLS.has(toSym);
}

interface SmartSignal {
  trade: TradeItem;
  scored: ScoredWallet;
  rank: number; // 1-based among scored wallets
}

// Multi-wallet thresholds that aren't user-tunable. Min wallet counts stay
// fixed because they define what "multi" means — the user can move the
// time window, not the cluster size.
const STRONG_MIN_WALLETS = 2;
const DUMP_MULTI_MIN_WALLETS = 2;

// User-tunable thresholds for the signal pipeline. Defaults match the
// previous hardcoded values so behavior is identical until the user opens
// Signal settings and changes something.
interface SignalSettings {
  minBuyUsd: number;
  minDumpUsd: number;
  accumulationMinBuys: number;
  accumulationWindowMinutes: number;
  strongSignalWindowMinutes: number;
  multiDumpWindowMinutes: number;
}

const DEFAULT_SIGNAL_SETTINGS: SignalSettings = {
  minBuyUsd: 0,
  minDumpUsd: 50,
  accumulationMinBuys: 3,
  accumulationWindowMinutes: 10,
  strongSignalWindowMinutes: 5,
  multiDumpWindowMinutes: 5,
};

const SIGNAL_SETTINGS_STORAGE_KEY = "wallet-checker:signal-settings";

function readStoredSignalSettings(): SignalSettings {
  if (typeof window === "undefined") return DEFAULT_SIGNAL_SETTINGS;
  try {
    const raw = window.localStorage.getItem(SIGNAL_SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_SIGNAL_SETTINGS;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return DEFAULT_SIGNAL_SETTINGS;
    const merged: SignalSettings = { ...DEFAULT_SIGNAL_SETTINGS };
    for (const k of Object.keys(DEFAULT_SIGNAL_SETTINGS) as (keyof SignalSettings)[]) {
      const v = (parsed as Record<string, unknown>)[k];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
        merged[k] = v;
      }
    }
    return merged;
  } catch {
    return DEFAULT_SIGNAL_SETTINGS;
  }
}

function useSignalSettings(): {
  settings: SignalSettings;
  update: (patch: Partial<SignalSettings>) => void;
  reset: () => void;
} {
  // Start with defaults so the server-rendered HTML matches the first
  // client render (avoids hydration mismatch). Real stored values load in
  // a useEffect right after mount.
  const [settings, setSettings] = useState<SignalSettings>(
    DEFAULT_SIGNAL_SETTINGS,
  );
  useEffect(() => {
    setSettings(readStoredSignalSettings());
  }, []);

  const update = useCallback((patch: Partial<SignalSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      try {
        window.localStorage.setItem(
          SIGNAL_SETTINGS_STORAGE_KEY,
          JSON.stringify(next),
        );
      } catch {
        // localStorage may be disabled (private mode, quota); ignore — the
        // change still applies in-memory for the rest of the session.
      }
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    try {
      window.localStorage.removeItem(SIGNAL_SETTINGS_STORAGE_KEY);
    } catch {
      /* ignore */
    }
    setSettings(DEFAULT_SIGNAL_SETTINGS);
  }, []);

  return { settings, update, reset };
}

interface StrongSignal {
  tokenMint: string;
  tokenSymbol: string | null;
  tokenName: string | null;
  walletCount: number;
  topWallets: {
    wallet: string;
    label: string | null;
    rank: number;
    score: number;
  }[];
  totalUsd: number;
  latestTime: number;
  latestTx: string;
  txCount: number;
}

function buildStrongSignals(
  signals: SmartSignal[],
  windowMs: number,
): StrongSignal[] {
  // Bucket per token mint (the canonical identifier; symbol can collide).
  const byMint = new Map<string, SmartSignal[]>();
  for (const s of signals) {
    const mint = s.trade.to?.address ?? "";
    if (!mint) continue;
    let arr = byMint.get(mint);
    if (!arr) {
      arr = [];
      byMint.set(mint, arr);
    }
    arr.push(s);
  }

  const out: StrongSignal[] = [];
  for (const group of byMint.values()) {
    // Sort ascending by time so we can walk a sliding window and emit one
    // cluster per contiguous burst of buys within STRONG_WINDOW_MS.
    const sorted = [...group].sort((a, b) => a.trade.time - b.trade.time);
    let i = 0;
    while (i < sorted.length) {
      let j = i;
      while (
        j + 1 < sorted.length &&
        sorted[j + 1].trade.time - sorted[i].trade.time <= windowMs
      ) {
        j++;
      }
      const cluster = sorted.slice(i, j + 1);
      // Keep the highest-score signal per wallet so the badge reflects best
      // rank; also collapses dedupe-by-tx-but-same-wallet edge cases.
      const distinct = new Map<string, SmartSignal>();
      for (const c of cluster) {
        const existing = distinct.get(c.trade.wallet);
        if (!existing || c.scored.score > existing.scored.score) {
          distinct.set(c.trade.wallet, c);
        }
      }
      if (distinct.size >= STRONG_MIN_WALLETS) {
        const sample = cluster[0].trade;
        const totalUsd = cluster.reduce(
          (acc, c) => acc + (c.trade.volume?.usd ?? 0),
          0,
        );
        const topWallets = [...distinct.values()]
          .sort((a, b) => a.rank - b.rank)
          .slice(0, 3)
          .map((c) => ({
            wallet: c.trade.wallet,
            label: c.trade.label,
            rank: c.rank,
            score: c.scored.score,
          }));
        out.push({
          tokenMint: sample.to.address,
          tokenSymbol: sample.to.token?.symbol ?? null,
          tokenName: sample.to.token?.name ?? null,
          walletCount: distinct.size,
          topWallets,
          totalUsd,
          latestTime: sorted[j].trade.time,
          latestTx: sorted[j].trade.tx,
          txCount: cluster.length,
        });
      }
      i = j + 1;
    }
  }

  // Newest cluster first.
  return out.sort((a, b) => b.latestTime - a.latestTime);
}

interface AccumulationSignal {
  wallet: string;
  walletLabel: string | null;
  rank: number;
  score: number;
  tokenMint: string;
  tokenSymbol: string | null;
  tokenName: string | null;
  buyCount: number;
  totalUsd: number;
  firstTime: number;
  lastTime: number;
  // Most-recent tx hash in the cluster — surfaced as the "View tx" target
  // since the cluster spans many txs but the freshest one is most useful.
  latestTx: string;
}

function buildAccumulationSignals(
  signals: SmartSignal[],
  opts: { windowMs: number; minBuys: number },
): AccumulationSignal[] {
  // Bucket per (wallet, mint). Same wallet/token combo across non-overlapping
  // 10-minute windows produces separate accumulation signals — useful when a
  // wallet revisits the same token after a pause.
  const byKey = new Map<string, SmartSignal[]>();
  for (const s of signals) {
    const mint = s.trade.to?.address ?? "";
    if (!mint) continue;
    const key = `${s.trade.wallet}|${mint}`;
    let arr = byKey.get(key);
    if (!arr) {
      arr = [];
      byKey.set(key, arr);
    }
    arr.push(s);
  }

  const out: AccumulationSignal[] = [];
  for (const group of byKey.values()) {
    const sorted = [...group].sort((a, b) => a.trade.time - b.trade.time);
    let i = 0;
    while (i < sorted.length) {
      let j = i;
      while (
        j + 1 < sorted.length &&
        sorted[j + 1].trade.time - sorted[i].trade.time <= opts.windowMs
      ) {
        j++;
      }
      // Cluster: indices [i, j]. Smart signals are already deduped by tx,
      // so the cluster's length equals distinct buy count.
      const clusterLen = j - i + 1;
      if (clusterLen >= opts.minBuys) {
        const first = sorted[i];
        const last = sorted[j];
        const totalUsd = sorted
          .slice(i, j + 1)
          .reduce((acc, c) => acc + (c.trade.volume?.usd ?? 0), 0);
        out.push({
          wallet: first.trade.wallet,
          walletLabel: first.trade.label,
          rank: first.rank,
          score: first.scored.score,
          tokenMint: first.trade.to.address,
          tokenSymbol: first.trade.to.token?.symbol ?? null,
          tokenName: first.trade.to.token?.name ?? null,
          buyCount: clusterLen,
          totalUsd,
          firstTime: first.trade.time,
          lastTime: last.trade.time,
          latestTx: last.trade.tx,
        });
      }
      i = j + 1;
    }
  }

  // Newest accumulation first.
  return out.sort((a, b) => b.lastTime - a.lastTime);
}

// Single-wallet dump — mirror of SmartSignal but for sells over threshold.
interface DumpSignal {
  trade: TradeItem;
  scored: ScoredWallet;
  rank: number;
}

interface MultiDumpSignal {
  tokenMint: string;
  tokenSymbol: string | null;
  tokenName: string | null;
  walletCount: number;
  topWallets: {
    wallet: string;
    label: string | null;
    rank: number;
    score: number;
  }[];
  totalUsd: number;
  latestTime: number;
  latestTx: string;
  txCount: number;
}

function buildDumpSignals(
  trades: TradeItem[],
  scored: ScoredWallet[],
  minDumpUsd: number,
): DumpSignal[] {
  if (scored.length === 0 || trades.length === 0) return [];

  // Same top-20% (min 3, max all) gate as buy signals.
  const cutoff = Math.max(3, Math.ceil(scored.length * 0.2));
  const topSlice = scored.slice(0, Math.min(cutoff, scored.length));
  const rankByWallet = new Map<
    string,
    { scored: ScoredWallet; rank: number }
  >();
  topSlice.forEach((s, i) =>
    rankByWallet.set(s.wallet, { scored: s, rank: i + 1 }),
  );

  const out: DumpSignal[] = [];
  const seenTx = new Set<string>();
  for (const t of trades) {
    if (seenTx.has(t.tx)) continue;
    const hit = rankByWallet.get(t.wallet);
    if (!hit) continue;
    if (!isSellTrade(t)) continue;
    // Ignore micro-dust dumps to keep the panel signal-rich.
    if ((t.volume?.usd ?? 0) < minDumpUsd) continue;
    seenTx.add(t.tx);
    out.push({ trade: t, scored: hit.scored, rank: hit.rank });
  }
  out.sort((a, b) => b.trade.time - a.trade.time);
  return out;
}

function buildMultiDumpSignals(
  dumps: DumpSignal[],
  windowMs: number,
): MultiDumpSignal[] {
  // Bucket by SOLD-token mint (= trade.from.address for sells).
  const byMint = new Map<string, DumpSignal[]>();
  for (const d of dumps) {
    const mint = d.trade.from?.address ?? "";
    if (!mint) continue;
    let arr = byMint.get(mint);
    if (!arr) {
      arr = [];
      byMint.set(mint, arr);
    }
    arr.push(d);
  }

  const out: MultiDumpSignal[] = [];
  for (const group of byMint.values()) {
    const sorted = [...group].sort((a, b) => a.trade.time - b.trade.time);
    let i = 0;
    while (i < sorted.length) {
      let j = i;
      while (
        j + 1 < sorted.length &&
        sorted[j + 1].trade.time - sorted[i].trade.time <= windowMs
      ) {
        j++;
      }
      const cluster = sorted.slice(i, j + 1);
      const distinct = new Map<string, DumpSignal>();
      for (const c of cluster) {
        const existing = distinct.get(c.trade.wallet);
        if (!existing || c.scored.score > existing.scored.score) {
          distinct.set(c.trade.wallet, c);
        }
      }
      if (distinct.size >= DUMP_MULTI_MIN_WALLETS) {
        const sample = cluster[0].trade;
        const totalUsd = cluster.reduce(
          (acc, c) => acc + (c.trade.volume?.usd ?? 0),
          0,
        );
        const topWallets = [...distinct.values()]
          .sort((a, b) => a.rank - b.rank)
          .slice(0, 3)
          .map((c) => ({
            wallet: c.trade.wallet,
            label: c.trade.label,
            rank: c.rank,
            score: c.scored.score,
          }));
        out.push({
          tokenMint: sample.from.address,
          tokenSymbol: sample.from.token?.symbol ?? null,
          tokenName: sample.from.token?.name ?? null,
          walletCount: distinct.size,
          topWallets,
          totalUsd,
          latestTime: sorted[j].trade.time,
          latestTx: sorted[j].trade.tx,
          txCount: cluster.length,
        });
      }
      i = j + 1;
    }
  }
  return out.sort((a, b) => b.latestTime - a.latestTime);
}

function buildSmartSignals(
  trades: TradeItem[],
  scored: ScoredWallet[],
  minBuyUsd: number,
): SmartSignal[] {
  if (scored.length === 0 || trades.length === 0) return [];

  // Top 20% by score, minimum 3 wallets (or all wallets if there are fewer).
  // computeWalletScores already returns descending-sorted array.
  const cutoff = Math.max(3, Math.ceil(scored.length * 0.2));
  const topSlice = scored.slice(0, Math.min(cutoff, scored.length));
  const rankByWallet = new Map<string, { scored: ScoredWallet; rank: number }>();
  topSlice.forEach((s, i) =>
    rankByWallet.set(s.wallet, { scored: s, rank: i + 1 }),
  );

  const signals: SmartSignal[] = [];
  const seenTx = new Set<string>(); // dedupe by tx hash
  for (const t of trades) {
    if (seenTx.has(t.tx)) continue;
    const hit = rankByWallet.get(t.wallet);
    if (!hit) continue;
    if (!isBuyTrade(t)) continue;
    if (minBuyUsd > 0 && (t.volume?.usd ?? 0) < minBuyUsd) continue;
    seenTx.add(t.tx);
    signals.push({ trade: t, scored: hit.scored, rank: hit.rank });
  }
  // Most recent first.
  signals.sort((a, b) => b.trade.time - a.trade.time);
  return signals;
}

export function LazySmartSignals({ groupId }: { groupId: string }) {
  // Settings panel always renders, even before caches populate, so the user
  // can tune thresholds while waiting on the first scan/trades fetch.
  const { settings, update, reset } = useSignalSettings();

  // Read both caches synchronously. These are module-level Maps populated by
  // sibling lazy panels; they don't trigger fetches here.
  const overviewEntry = overviewCache.get(groupId);
  const tradesEntry = tradesCache.get(tradesCacheKey(groupId, {}));

  if (!overviewEntry) {
    return (
      <>
        <SignalSettingsPanel settings={settings} onUpdate={update} onReset={reset} />
        <Panel title="Smart signals">
          <div className="px-4 py-6 text-center text-sm text-neutral-500">
            Visit the <span className="font-semibold text-neutral-300">Positions</span> tab
            first to score wallets — signals are derived from PnL Overview data.
          </div>
        </Panel>
      </>
    );
  }
  if (!tradesEntry) {
    return (
      <>
        <SignalSettingsPanel settings={settings} onUpdate={update} onReset={reset} />
        <Panel title="Smart signals">
          <div className="px-4 py-6 text-center text-sm text-neutral-500">
            Waiting for the trades feed to populate…
          </div>
        </Panel>
      </>
    );
  }

  const scored = computeWalletScores(overviewEntry.data.results);
  const portfolioEntry = portfolioCache.get(groupId);
  const portfolioIndex = buildPortfolioIndex(portfolioEntry?.data);
  const lookupPosition = makeLookupPosition(
    portfolioEntry?.data,
    portfolioIndex,
  );
  const signals = buildSmartSignals(
    tradesEntry.data.trades,
    scored,
    settings.minBuyUsd,
  );
  const strong = buildStrongSignals(
    signals,
    settings.strongSignalWindowMinutes * 60_000,
  );
  const accumulation = buildAccumulationSignals(signals, {
    windowMs: settings.accumulationWindowMinutes * 60_000,
    minBuys: settings.accumulationMinBuys,
  });
  const dumps = buildDumpSignals(
    tradesEntry.data.trades,
    scored,
    settings.minDumpUsd,
  );
  const multiDumps = buildMultiDumpSignals(
    dumps,
    settings.multiDumpWindowMinutes * 60_000,
  );
  const cutoff = Math.max(3, Math.ceil(scored.length * 0.2));
  const topCount = Math.min(cutoff, scored.length);

  const subtitle = (
    <span className="text-[11px] text-neutral-400">
      Top {topCount} of {scored.length} wallet
      {scored.length === 1 ? "" : "s"} · {signals.length} signal
      {signals.length === 1 ? "" : "s"}
    </span>
  );

  return (
    <>
      <SignalSettingsPanel
        settings={settings}
        onUpdate={update}
        onReset={reset}
      />
      {!portfolioEntry && (
        <div className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-[11px] text-neutral-400">
          <span className="font-semibold text-neutral-300">Position status:</span>{" "}
          uses cached Portfolio data. Open the{" "}
          <span className="font-semibold text-neutral-300">Positions</span> tab
          first to resolve Holding/Exited badges.
        </div>
      )}
      {accumulation.length > 0 && (
        <AccumulationPanel
          signals={accumulation}
          settings={settings}
          groupId={groupId}
          lookupPosition={lookupPosition}
        />
      )}
      {strong.length > 0 && (
        <StrongSignalsPanel
          signals={strong}
          settings={settings}
          groupId={groupId}
          lookupPosition={lookupPosition}
        />
      )}
      {(dumps.length > 0 || multiDumps.length > 0) && (
        <DumpSignalsPanel
          dumps={dumps}
          multiDumps={multiDumps}
          settings={settings}
          groupId={groupId}
          lookupPosition={lookupPosition}
        />
      )}
      {signals.length === 0 ? (
        <Panel title="Smart signals" subtitle={subtitle}>
          <div className="px-4 py-6 text-center text-sm text-neutral-500">
            No recent buys from top-scoring wallets in the loaded trade feed.
          </div>
        </Panel>
      ) : (
        <Panel title="Smart signals" subtitle={subtitle}>
          <ul className="divide-y divide-neutral-800">
            {signals.map((s) => (
              <SmartSignalCard
                key={s.trade.tx}
                signal={s}
                groupId={groupId}
                lookupPosition={lookupPosition}
              />
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
}

function SignalSettingsPanel({
  settings,
  onUpdate,
  onReset,
}: {
  settings: SignalSettings;
  onUpdate: (patch: Partial<SignalSettings>) => void;
  onReset: () => void;
}) {
  // All inputs share the same number-input styling. Each fires onUpdate on
  // every change, which immediately re-renders the signal panels with the
  // new thresholds — no apply button needed.
  const inputCls =
    "w-20 rounded border border-neutral-700 bg-neutral-950 px-1.5 py-0.5 text-right text-xs font-mono tabular-nums text-white focus:outline-none focus:border-violet-500 focus:ring-1 focus:ring-violet-500/30";
  const fields: {
    key: keyof SignalSettings;
    label: string;
    suffix: string;
    step: number;
    min?: number;
  }[] = [
    { key: "minBuyUsd", label: "Min buy", suffix: "USD", step: 1, min: 0 },
    { key: "minDumpUsd", label: "Min dump", suffix: "USD", step: 1, min: 0 },
    { key: "accumulationMinBuys", label: "Accumulation min buys", suffix: "buys", step: 1, min: 1 },
    { key: "accumulationWindowMinutes", label: "Accumulation window", suffix: "min", step: 1, min: 1 },
    { key: "strongSignalWindowMinutes", label: "Strong window", suffix: "min", step: 1, min: 1 },
    { key: "multiDumpWindowMinutes", label: "Multi-dump window", suffix: "min", step: 1, min: 1 },
  ];
  const isDefault = (Object.keys(DEFAULT_SIGNAL_SETTINGS) as (keyof SignalSettings)[]).every(
    (k) => settings[k] === DEFAULT_SIGNAL_SETTINGS[k],
  );
  return (
    <div className="overflow-hidden rounded-md border border-neutral-700 bg-neutral-900">
      <div className="flex items-baseline justify-between border-b border-neutral-700 px-3 py-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-300">
          Signal settings
        </span>
        <button
          type="button"
          onClick={onReset}
          disabled={isDefault}
          className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-300 transition-colors duration-100 hover:bg-neutral-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          Reset defaults
        </button>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 px-3 py-2 sm:grid-cols-3">
        {fields.map((f) => {
          const v = settings[f.key];
          const def = DEFAULT_SIGNAL_SETTINGS[f.key];
          const dirty = v !== def;
          return (
            <label
              key={f.key}
              className="flex items-center justify-between gap-2 text-[11px]"
            >
              <span className={dirty ? "text-violet-300" : "text-neutral-400"}>
                {f.label}
              </span>
              <span className="inline-flex items-center gap-1">
                <input
                  type="number"
                  inputMode="numeric"
                  step={f.step}
                  min={f.min}
                  value={v}
                  onChange={(e) => {
                    const raw = e.currentTarget.value;
                    const n = Number(raw);
                    if (raw === "" || !Number.isFinite(n) || n < (f.min ?? 0)) return;
                    onUpdate({ [f.key]: n } as Partial<SignalSettings>);
                  }}
                  aria-label={f.label}
                  className={inputCls}
                />
                <span className="text-[10px] text-neutral-500">{f.suffix}</span>
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function AccumulationPanel({
  signals,
  settings,
  groupId,
  lookupPosition,
}: {
  signals: AccumulationSignal[];
  settings: SignalSettings;
  groupId: string;
  lookupPosition: LookupPosition;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-amber-500/40 bg-neutral-900">
      <div className="flex items-baseline justify-between border-b border-amber-500/30 bg-amber-500/[0.08] px-3 py-1.5">
        <span className="text-[10px] font-bold uppercase tracking-wider text-amber-300">
          🧠 Early accumulation
        </span>
        <span className="text-[11px] text-amber-300/80">
          {signals.length} detection{signals.length === 1 ? "" : "s"} · ≥
          {settings.accumulationMinBuys} buys within{" "}
          {settings.accumulationWindowMinutes} min
        </span>
      </div>
      <ul className="divide-y divide-amber-500/15">
        {signals.map((s) => (
          <AccumulationCard
            key={`${s.wallet}|${s.tokenMint}@${s.lastTime}`}
            signal={s}
            settings={settings}
            groupId={groupId}
            lookupPosition={lookupPosition}
          />
        ))}
      </ul>
    </div>
  );
}

function AccumulationCard({
  signal,
  settings,
  groupId,
  lookupPosition,
}: {
  signal: AccumulationSignal;
  settings: SignalSettings;
  groupId: string;
  lookupPosition: LookupPosition;
}) {
  const position = lookupPosition(signal.wallet, signal.tokenMint);
  const tokenLabel =
    signal.tokenSymbol ?? signal.tokenName ?? `${signal.tokenMint.slice(0, 8)}…`;
  const showName =
    signal.tokenName &&
    signal.tokenSymbol &&
    signal.tokenName !== signal.tokenSymbol;
  const durationSec = Math.max(
    0,
    Math.round((signal.lastTime - signal.firstTime) / 1000),
  );
  const durationLabel =
    durationSec < 60
      ? `${durationSec}s`
      : `${Math.floor(durationSec / 60)}m ${durationSec % 60}s`;
  return (
    <li className="flex flex-col gap-1.5 bg-amber-500/[0.04] px-3 py-2.5 transition-colors duration-100 hover:bg-amber-500/[0.08]">
      {/* row 1: badge + buy count + wallet rank + latest time */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-bold uppercase tracking-wider text-amber-300">
          🧠 Accumulation
        </span>
        <span className="inline-flex items-center rounded-md bg-amber-500/20 px-1.5 py-0.5 text-[11px] font-bold text-amber-100 ring-1 ring-amber-500/30">
          {signal.buyCount} buys
        </span>
        <span className="rounded bg-amber-400/20 px-1 text-[10px] font-bold tabular-nums text-amber-200">
          #{signal.rank}
        </span>
        <span className="text-[10px] text-neutral-500">
          score {signal.score}
        </span>
        <span className="ml-auto font-mono text-[11px] text-neutral-400">
          {fmtTime(signal.lastTime)}
        </span>
      </div>
      {/* row 2: wallet + token + total volume */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="min-w-0 inline-flex items-center gap-1.5">
          {signal.walletLabel ? (
            <span className="font-semibold text-white">
              {signal.walletLabel}
            </span>
          ) : (
            <WalletLink address={signal.wallet} chars={4} />
          )}
          <PositionBadge status={position.status} />
        </span>
        <span className="text-neutral-500">→</span>
        <span className="min-w-0 truncate">
          <span className="text-base font-bold text-white">{tokenLabel}</span>
          {showName && (
            <span className="ml-1.5 text-[11px] text-neutral-400">
              {signal.tokenName}
            </span>
          )}
        </span>
        <span className="ml-auto text-sm font-bold tabular-nums text-emerald-300">
          {fmtUsd(signal.totalUsd)}
        </span>
      </div>
      {/* row 3: time range */}
      <div className="text-[11px] text-neutral-500">
        <span className="text-neutral-500">Range</span>{" "}
        <span className="font-mono text-neutral-300">
          {fmtTime(signal.firstTime)}
        </span>
        <span className="text-neutral-500"> → </span>
        <span className="font-mono text-neutral-300">
          {fmtTime(signal.lastTime)}
        </span>
        <span className="ml-1.5 text-neutral-500">({durationLabel})</span>
      </div>
      <WhyLine
        actions={
          <SignalActions
            tx={signal.latestTx}
            mint={signal.tokenMint}
            groupId={groupId}
          />
        }
      >
        Triggered because{" "}
        <span className="font-semibold text-neutral-300">
          {explainWalletLabel(signal.walletLabel, signal.wallet)}
        </span>{" "}
        bought{" "}
        <span className="font-semibold text-neutral-300">
          {explainTokenLabel({
            symbol: signal.tokenSymbol,
            name: signal.tokenName,
            mint: signal.tokenMint,
          })}
        </span>{" "}
        <span className="font-semibold text-neutral-300">
          {signal.buyCount} times
        </span>{" "}
        within{" "}
        <span className="font-semibold text-neutral-300">
          {settings.accumulationWindowMinutes} min
        </span>
        .
      </WhyLine>
    </li>
  );
}

function DumpSignalsPanel({
  dumps,
  multiDumps,
  settings,
  groupId,
  lookupPosition,
}: {
  dumps: DumpSignal[];
  multiDumps: MultiDumpSignal[];
  settings: SignalSettings;
  groupId: string;
  lookupPosition: LookupPosition;
}) {
  // Stronger red treatment than the buy "🚨 Strong signals" panel:
  // saturated red-600 border, dark red-tinted body, larger drop shadow.
  return (
    <div className="overflow-hidden rounded-md border-2 border-red-600/60 bg-red-950/30 shadow-lg shadow-red-700/20">
      <div className="flex items-baseline justify-between border-b border-red-600/40 bg-red-600/20 px-3 py-1.5">
        <span className="text-[10px] font-bold uppercase tracking-wider text-red-200">
          🔻 Dump signals
        </span>
        <span className="text-[11px] text-red-200/80">
          {multiDumps.length} cluster{multiDumps.length === 1 ? "" : "s"} ·{" "}
          {dumps.length} sell{dumps.length === 1 ? "" : "s"} · ≥${settings.minDumpUsd}
        </span>
      </div>
      {multiDumps.length > 0 && (
        <ul className="divide-y divide-red-600/20">
          {multiDumps.map((m) => (
            <MultiDumpCard
              key={`${m.tokenMint}@${m.latestTime}`}
              signal={m}
              settings={settings}
              groupId={groupId}
              lookupPosition={lookupPosition}
            />
          ))}
        </ul>
      )}
      {multiDumps.length > 0 && dumps.length > 0 && (
        <div className="border-t border-red-600/30 bg-red-600/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-red-300">
          Single-wallet exits
        </div>
      )}
      {dumps.length > 0 && (
        <ul className="divide-y divide-red-600/15">
          {dumps.map((d) => (
            <DumpSignalCard
              key={d.trade.tx}
              signal={d}
              groupId={groupId}
              lookupPosition={lookupPosition}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function MultiDumpCard({
  signal,
  settings,
  groupId,
  lookupPosition,
}: {
  signal: MultiDumpSignal;
  settings: SignalSettings;
  groupId: string;
  lookupPosition: LookupPosition;
}) {
  const positions = signal.topWallets.map((w) =>
    lookupPosition(w.wallet, signal.tokenMint),
  );
  const exitedCount = positions.filter((p) => p.status === "exited").length;
  const totalKnown = positions.filter((p) => p.status !== "unknown").length;
  const tokenLabel =
    signal.tokenSymbol ?? signal.tokenName ?? `${signal.tokenMint.slice(0, 8)}…`;
  const showName =
    signal.tokenName &&
    signal.tokenSymbol &&
    signal.tokenName !== signal.tokenSymbol;
  return (
    <li className="flex flex-col gap-2 bg-red-600/[0.06] px-4 py-3 transition-colors duration-100 hover:bg-red-600/[0.12]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-bold uppercase tracking-wider text-red-200">
          💥 Multi-wallet dump
        </span>
        <span className="inline-flex items-center rounded-md bg-red-600/30 px-2 py-0.5 text-[11px] font-bold text-red-50 ring-1 ring-red-500/50">
          {signal.walletCount} wallets
        </span>
        {signal.txCount > signal.walletCount && (
          <span className="text-[10px] text-neutral-500">
            ({signal.txCount} txs)
          </span>
        )}
        <span className="ml-auto font-mono text-[11px] text-red-200/80">
          {fmtTime(signal.latestTime)}
        </span>
      </div>
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-lg font-bold text-white">
            {tokenLabel}
          </div>
          {showName && (
            <div className="truncate text-[11px] text-neutral-400">
              {signal.tokenName}
            </div>
          )}
        </div>
        <div className="shrink-0 text-right">
          <div className="text-2xl font-bold tabular-nums text-red-300">
            {fmtUsd(signal.totalUsd)}
          </div>
          <div className="text-[10px] uppercase tracking-wider text-red-200/70">
            total exited
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-red-600/20 pt-2 text-[11px]">
        <span className="text-red-200/70">Wallets:</span>
        {signal.topWallets.map((w, i) => (
          <span key={w.wallet} className="inline-flex items-center gap-1">
            {w.label ? (
              <span className="font-semibold text-white">{w.label}</span>
            ) : (
              <WalletLink address={w.wallet} chars={4} />
            )}
            <span className="rounded bg-amber-400/20 px-1 text-[10px] font-bold tabular-nums text-amber-200">
              #{w.rank}
            </span>
            <span className="text-[10px] text-neutral-500">({w.score})</span>
            <PositionBadge status={positions[i].status} />
          </span>
        ))}
        {signal.walletCount > signal.topWallets.length && (
          <span className="text-neutral-500">
            +{signal.walletCount - signal.topWallets.length} more
          </span>
        )}
        {totalKnown > 0 && (
          <span className="ml-auto text-[10px] text-red-200/80">
            <span className="font-semibold text-red-300">{exitedCount}</span>
            <span className="text-red-200/70"> / {totalKnown} fully exited</span>
          </span>
        )}
      </div>
      <WhyLine
        actions={
          <SignalActions
            tx={signal.latestTx}
            mint={signal.tokenMint}
            groupId={groupId}
          />
        }
      >
        Triggered because{" "}
        <span className="font-semibold text-neutral-300">
          {signal.walletCount} top wallets
        </span>{" "}
        sold{" "}
        <span className="font-semibold text-neutral-300">
          {explainTokenLabel({
            symbol: signal.tokenSymbol,
            name: signal.tokenName,
            mint: signal.tokenMint,
          })}
        </span>{" "}
        within{" "}
        <span className="font-semibold text-neutral-300">
          {settings.multiDumpWindowMinutes} min
        </span>
        .
      </WhyLine>
    </li>
  );
}

function DumpSignalCard({
  signal,
  groupId,
  lookupPosition,
}: {
  signal: DumpSignal;
  groupId: string;
  lookupPosition: LookupPosition;
}) {
  const position = lookupPosition(signal.trade.wallet, signal.trade.from.address);
  const t = signal.trade;
  const tokenName = t.from.token.name ?? t.from.token.symbol ?? "—";
  const tokenSymbol = t.from.token.symbol ?? null;
  return (
    <li
      className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 transition-colors duration-100 hover:bg-red-600/[0.12] ${
        signal.rank <= 3
          ? "bg-red-600/[0.05] border-l-2 border-red-500/60"
          : "border-l-2 border-red-500/30"
      }`}
    >
      <span className="inline-flex items-center gap-1.5 text-red-300">
        <span aria-hidden>🔻</span>
        <span className="text-[11px] font-bold uppercase tracking-wider">
          Dump
        </span>
      </span>
      <span className="inline-flex items-center rounded-md bg-red-600/25 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-red-50 ring-1 ring-red-500/40">
        #{signal.rank}
      </span>
      <span className="min-w-0 inline-flex items-center gap-1.5">
        {t.label ? (
          <span className="text-sm font-semibold text-white">{t.label}</span>
        ) : (
          <WalletLink address={t.wallet} chars={4} />
        )}
        <span className="text-[10px] text-neutral-500">
          score {signal.scored.score}
        </span>
        <PositionBadge status={position.status} />
      </span>
      <span className="min-w-0 inline-flex flex-1 items-baseline gap-1.5">
        <span className="text-neutral-500">→</span>
        {tokenSymbol ? (
          <span className="font-semibold text-white">{tokenSymbol}</span>
        ) : null}
        <span className="truncate text-[11px] text-neutral-400">{tokenName}</span>
      </span>
      <span className="ml-auto inline-flex items-center gap-2 text-[11px]">
        <span className="font-bold tabular-nums text-red-300">
          {fmtUsd(t.volume.usd)}
        </span>
        <span className="font-mono text-neutral-500">{fmtTime(t.time)}</span>
        <TxLink signature={t.tx} />
      </span>
      <WhyLine
        actions={
          <SignalActions tx={t.tx} mint={t.from.address} groupId={groupId} />
        }
      >
        Triggered because top wallet sold{" "}
        <span className="font-semibold text-neutral-300">
          {fmtUsd(t.volume.usd)}
        </span>{" "}
        of{" "}
        <span className="font-semibold text-neutral-300">
          {explainTokenLabel({
            symbol: t.from.token?.symbol,
            name: t.from.token?.name,
            mint: t.from.address,
          })}
        </span>
        .
      </WhyLine>
    </li>
  );
}

function StrongSignalsPanel({
  signals,
  settings,
  groupId,
  lookupPosition,
}: {
  signals: StrongSignal[];
  settings: SignalSettings;
  groupId: string;
  lookupPosition: LookupPosition;
}) {
  return (
    <div className="overflow-hidden rounded-md border-2 border-red-500/40 bg-neutral-900 shadow shadow-red-500/10">
      <div className="flex items-baseline justify-between border-b border-red-500/30 bg-red-500/10 px-3 py-1.5">
        <span className="text-[10px] font-bold uppercase tracking-wider text-red-300">
          🚨 Strong signals
        </span>
        <span className="text-[11px] text-red-300/80">
          {signals.length} cluster{signals.length === 1 ? "" : "s"} · ≥
          {STRONG_MIN_WALLETS} top wallets within{" "}
          {settings.strongSignalWindowMinutes} min
        </span>
      </div>
      <ul className="divide-y divide-red-500/15">
        {signals.map((s) => (
          <StrongSignalCard
            key={`${s.tokenMint}@${s.latestTime}`}
            signal={s}
            settings={settings}
            groupId={groupId}
            lookupPosition={lookupPosition}
          />
        ))}
      </ul>
    </div>
  );
}

function StrongSignalCard({
  signal,
  settings,
  groupId,
  lookupPosition,
}: {
  signal: StrongSignal;
  settings: SignalSettings;
  groupId: string;
  lookupPosition: LookupPosition;
}) {
  // Aggregate: how many of the displayed top wallets still hold this token.
  const positions = signal.topWallets.map((w) =>
    lookupPosition(w.wallet, signal.tokenMint),
  );
  const holdingCount = positions.filter((p) => p.status === "holding").length;
  const totalKnown = positions.filter((p) => p.status !== "unknown").length;
  const tokenLabel =
    signal.tokenSymbol ?? signal.tokenName ?? `${signal.tokenMint.slice(0, 8)}…`;
  const showName =
    signal.tokenName &&
    signal.tokenSymbol &&
    signal.tokenName !== signal.tokenSymbol;
  return (
    <li className="flex flex-col gap-2 bg-red-500/[0.04] px-4 py-3 transition-colors duration-100 hover:bg-red-500/[0.08]">
      {/* row 1: badge + wallet count + time */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-bold uppercase tracking-wider text-red-300">
          🚨 Multi-wallet buy
        </span>
        <span className="inline-flex items-center rounded-md bg-red-500/20 px-2 py-0.5 text-[11px] font-bold text-red-100 ring-1 ring-red-500/40">
          {signal.walletCount} wallets
        </span>
        {signal.txCount > signal.walletCount && (
          <span className="text-[10px] text-neutral-500">
            ({signal.txCount} txs)
          </span>
        )}
        <span className="ml-auto font-mono text-[11px] text-neutral-400">
          {fmtTime(signal.latestTime)}
        </span>
      </div>
      {/* row 2: token name (large) + total volume (large) */}
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-lg font-bold text-white">
            {tokenLabel}
          </div>
          {showName && (
            <div className="truncate text-[11px] text-neutral-400">
              {signal.tokenName}
            </div>
          )}
        </div>
        <div className="shrink-0 text-right">
          <div className="text-2xl font-bold tabular-nums text-emerald-300">
            {fmtUsd(signal.totalUsd)}
          </div>
          <div className="text-[10px] uppercase tracking-wider text-neutral-500">
            total volume
          </div>
        </div>
      </div>
      {/* row 3: top wallets */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-red-500/15 pt-2 text-[11px]">
        <span className="text-neutral-500">Wallets:</span>
        {signal.topWallets.map((w, i) => (
          <span key={w.wallet} className="inline-flex items-center gap-1">
            {w.label ? (
              <span className="font-semibold text-white">{w.label}</span>
            ) : (
              <WalletLink address={w.wallet} chars={4} />
            )}
            <span className="rounded bg-amber-400/20 px-1 text-[10px] font-bold tabular-nums text-amber-200">
              #{w.rank}
            </span>
            <span className="text-[10px] text-neutral-500">({w.score})</span>
            <PositionBadge status={positions[i].status} />
          </span>
        ))}
        {signal.walletCount > signal.topWallets.length && (
          <span className="text-neutral-500">
            +{signal.walletCount - signal.topWallets.length} more
          </span>
        )}
        {totalKnown > 0 && (
          <span className="ml-auto text-[10px] text-neutral-400">
            <span className="font-semibold text-emerald-300">
              {holdingCount}
            </span>
            <span className="text-neutral-500"> / {totalKnown} still holding</span>
          </span>
        )}
      </div>
      <WhyLine
        actions={
          <SignalActions
            tx={signal.latestTx}
            mint={signal.tokenMint}
            groupId={groupId}
          />
        }
      >
        Triggered because{" "}
        <span className="font-semibold text-neutral-300">
          {signal.walletCount} top wallets
        </span>{" "}
        bought{" "}
        <span className="font-semibold text-neutral-300">
          {explainTokenLabel({
            symbol: signal.tokenSymbol,
            name: signal.tokenName,
            mint: signal.tokenMint,
          })}
        </span>{" "}
        within{" "}
        <span className="font-semibold text-neutral-300">
          {settings.strongSignalWindowMinutes} min
        </span>
        .
      </WhyLine>
    </li>
  );
}

const RANK_BADGES: Record<number, { label: string; className: string }> = {
  1: { label: "🥇 #1", className: "bg-amber-400 text-neutral-950" },
  2: { label: "🥈 #2", className: "bg-neutral-300 text-neutral-950" },
  3: { label: "🥉 #3", className: "bg-orange-400 text-neutral-950" },
};

// Compact muted "Why?" explanation rendered as the last line of each signal
// card. The optional `actions` slot sits inline on the right edge so the
// "View tx / Copy mint / Filter" row reuses the same line and the card's
// vertical height doesn't grow. `basis-full` forces a line-break inside
// flex-wrap card rows.
function WhyLine({
  children,
  actions,
  className = "",
}: {
  children: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`basis-full flex items-baseline gap-2 ${className}`}>
      <div className="min-w-0 flex-1 text-[10px] leading-snug text-neutral-500">
        <span className="font-semibold text-neutral-400">Why?</span> {children}
      </div>
      {actions && <div className="shrink-0">{actions}</div>}
    </div>
  );
}

// =============== Position awareness =========================================
// Reuses the portfolioCache that LazyPortfolio populates on the Positions
// tab. No new HTTP. If the cache is missing (user hasn't visited Positions
// yet) we render "?" badges with a tooltip nudging them to the right tab.
// =============================================================================

type PositionStatus = "holding" | "exited" | "unknown";

interface PositionInfo {
  status: PositionStatus;
  balance: number;
}

type PortfolioIndex = Map<string, Map<string, number>>; // wallet → mint → balance

function buildPortfolioIndex(
  portfolio: PortfolioResponse | undefined,
): PortfolioIndex | null {
  if (!portfolio) return null;
  const idx: PortfolioIndex = new Map();
  for (const t of portfolio.tokens) {
    for (const w of t.wallets) {
      let m = idx.get(w.wallet);
      if (!m) {
        m = new Map();
        idx.set(w.wallet, m);
      }
      m.set(t.mint, w.balance);
    }
  }
  return idx;
}

type LookupPosition = (wallet: string, mint: string) => PositionInfo;

function makeLookupPosition(
  portfolio: PortfolioResponse | undefined,
  index: PortfolioIndex | null,
): LookupPosition {
  // Capture failedWallets as a Set for O(1) lookup.
  const failedSet = new Set(portfolio?.failedWallets.map((f) => f.wallet) ?? []);
  return (wallet, mint) => {
    if (!portfolio || !index) return { status: "unknown", balance: 0 };
    if (failedSet.has(wallet)) return { status: "unknown", balance: 0 };
    const balance = index.get(wallet)?.get(mint) ?? 0;
    return { status: balance > 0 ? "holding" : "exited", balance };
  };
}

function PositionBadge({
  status,
  remainingPctText,
}: {
  status: PositionStatus;
  remainingPctText?: string | null;
}) {
  const cls =
    "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold ring-1";
  if (status === "holding") {
    return (
      <span
        className={`${cls} bg-emerald-500/15 text-emerald-300 ring-emerald-500/30`}
        title="Wallet still holds this token"
      >
        🟢 Holding
        {remainingPctText && (
          <span className="font-medium text-emerald-200/80">
            · {remainingPctText}
          </span>
        )}
      </span>
    );
  }
  if (status === "exited") {
    return (
      <span
        className={`${cls} bg-red-500/15 text-red-300 ring-red-500/30`}
        title="Wallet no longer holds this token"
      >
        🔴 Exited
      </span>
    );
  }
  return (
    <span
      className={`${cls} bg-neutral-700/30 text-neutral-400 ring-neutral-600/40`}
      title="Portfolio not loaded — visit the Positions tab"
    >
      ? Unknown
    </span>
  );
}

// Per-card quick-action row. Kept small so it tucks alongside the WhyLine
// on the same row of every card. View tx → Solscan in a new tab. Copy mint →
// navigator.clipboard with a brief "Copied ✓" confirmation. Filter → next/link
// to the same group page with ?tab=activity&token=<mint>, which the page-
// level normalizeFilters already plumbs into the LazyTrades panel.
function SignalActions({
  tx,
  mint,
  groupId,
}: {
  tx: string;
  mint: string;
  groupId: string;
}) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    navigator.clipboard
      .writeText(mint)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        /* clipboard denied or unavailable; silently ignore */
      });
  }, [mint]);
  const btn =
    "inline-flex items-center rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 text-[10px] font-semibold text-neutral-300 transition-colors duration-100 hover:border-neutral-500 hover:bg-neutral-800 hover:text-white focus:outline-none focus:ring-1 focus:ring-violet-500/40";
  return (
    <span className="inline-flex items-center gap-1">
      <a
        href={solscanTxUrl(tx)}
        target="_blank"
        rel="noopener noreferrer"
        className={btn}
        aria-label="Open transaction on Solscan"
        title="Open transaction on Solscan"
      >
        View tx ↗
      </a>
      <button
        type="button"
        onClick={handleCopy}
        className={btn}
        aria-label="Copy token mint to clipboard"
        title="Copy token mint to clipboard"
      >
        {copied ? "Copied ✓" : "Copy mint"}
      </button>
      <Link
        href={`/groups/${groupId}?tab=activity&token=${mint}`}
        scroll={false}
        className={btn}
        aria-label="Filter trades by this token"
        title="Filter trades by this token"
      >
        Filter
      </Link>
    </span>
  );
}

// Common token-label resolver used in explanations: prefer symbol, then name,
// then a short mint snippet so the sentence always reads with something
// human-recognisable.
function explainTokenLabel(opts: {
  symbol?: string | null;
  name?: string | null;
  mint?: string;
}): string {
  return (
    opts.symbol ??
    opts.name ??
    (opts.mint ? `${opts.mint.slice(0, 6)}…` : "this token")
  );
}

function explainWalletLabel(label: string | null, address: string): string {
  return label ?? shortAddr(address, 4, 4);
}

function SmartSignalCard({
  signal,
  groupId,
  lookupPosition,
}: {
  signal: SmartSignal;
  groupId: string;
  lookupPosition: LookupPosition;
}) {
  const position = lookupPosition(signal.trade.wallet, signal.trade.to.address);
  // Optional "% remaining vs initial buy" — only meaningful when the wallet
  // still holds AND we know the bought amount from this single signal trade.
  // For multi-buy clusters we don't have totals, so % is per-card and only
  // shown here. >100% means the wallet kept buying after this signal.
  const bought = signal.trade.to.amount;
  const remainingPctText =
    position.status === "holding" && bought > 0
      ? `${Math.min(999, Math.round((position.balance / bought) * 100))}% left`
      : null;
  const t = signal.trade;
  const podium = RANK_BADGES[signal.rank];
  const tokenName = t.to.token.name ?? t.to.token.symbol ?? "—";
  const tokenSymbol = t.to.token.symbol ?? null;
  return (
    <li
      className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 transition-colors duration-100 hover:bg-neutral-800/60 ${
        podium ? "bg-emerald-500/[0.04] border-l-2 border-emerald-500/40" : "border-l-2 border-emerald-500/20"
      }`}
    >
      {/* lead badge */}
      <span className="inline-flex items-center gap-1.5 text-emerald-300">
        <span aria-hidden>🔥</span>
        <span className="text-[11px] font-bold uppercase tracking-wider">
          Top wallet buy
        </span>
      </span>

      {/* rank pill */}
      {podium ? (
        <span
          className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-bold tabular-nums ${podium.className}`}
          aria-label={`Rank ${signal.rank}`}
        >
          {podium.label}
        </span>
      ) : (
        <span className="inline-flex items-center rounded-md bg-neutral-800 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-neutral-300">
          TOP · #{signal.rank}
        </span>
      )}

      {/* wallet */}
      <span className="min-w-0 inline-flex items-center gap-1.5">
        {t.label ? (
          <span className="text-sm font-semibold text-white">{t.label}</span>
        ) : (
          <WalletLink address={t.wallet} chars={4} />
        )}
        <span className="text-[10px] text-neutral-500">
          score {signal.scored.score}
        </span>
        <PositionBadge
          status={position.status}
          remainingPctText={remainingPctText}
        />
      </span>

      {/* token */}
      <span className="min-w-0 inline-flex flex-1 items-baseline gap-1.5">
        <span className="text-neutral-500">→</span>
        {tokenSymbol ? (
          <span className="font-semibold text-white">{tokenSymbol}</span>
        ) : null}
        <span className="truncate text-[11px] text-neutral-400">{tokenName}</span>
      </span>

      {/* meta */}
      <span className="ml-auto inline-flex items-center gap-2 text-[11px]">
        <span className="font-bold tabular-nums text-emerald-300">
          {fmtUsd(t.volume.usd)}
        </span>
        <span className="font-mono text-neutral-500">{fmtTime(t.time)}</span>
        <TxLink signature={t.tx} />
      </span>

      <WhyLine
        actions={
          <SignalActions tx={t.tx} mint={t.to.address} groupId={groupId} />
        }
      >
        Triggered because this wallet is ranked{" "}
        <span className="font-semibold text-neutral-300">#{signal.rank}</span>{" "}
        with score{" "}
        <span className="font-semibold text-neutral-300">
          {signal.scored.score}
        </span>
        .
      </WhyLine>
    </li>
  );
}

// ============================================================================
// TokenDetailPanel — focused view of a single token, derived from cached
// trades. Renders above the trades feed when ?tab=activity&token=<mint> is
// in the URL. No new HTTP — operates entirely on the trades that LazyTrades
// already fetched for this filter combination.
// ============================================================================

interface WalletTokenStats {
  wallet: string;
  label: string | null;
  buyUsd: number;
  sellUsd: number;
  buyCount: number;
  sellCount: number;
  totalUsd: number;
}

function TokenDetailPanel({
  groupId,
  mint,
  trades,
}: {
  groupId: string;
  mint: string;
  trades: TradeItem[];
}) {
  // Defensive: filter exact-mint matches even though the backend should already
  // have filtered upstream. If a backend filter ever changes to a fuzzy match
  // we still render the right slice.
  const tokenTrades = trades.filter(
    (t) => t.from?.address === mint || t.to?.address === mint,
  );

  // Identify token metadata from any trade leg that references this mint.
  let tokenSymbol: string | null = null;
  let tokenName: string | null = null;
  for (const t of tokenTrades) {
    if (t.to?.address === mint) {
      tokenSymbol = tokenSymbol ?? t.to.token?.symbol ?? null;
      tokenName = tokenName ?? t.to.token?.name ?? null;
    }
    if (t.from?.address === mint) {
      tokenSymbol = tokenSymbol ?? t.from.token?.symbol ?? null;
      tokenName = tokenName ?? t.from.token?.name ?? null;
    }
    if (tokenSymbol && tokenName) break;
  }

  // Aggregate per-wallet buy/sell USD + counts across this token's trades.
  let totalBuyUsd = 0;
  let totalSellUsd = 0;
  const byWallet = new Map<string, WalletTokenStats>();
  for (const t of tokenTrades) {
    const usd = t.volume?.usd ?? 0;
    let s = byWallet.get(t.wallet);
    if (!s) {
      s = {
        wallet: t.wallet,
        label: t.label,
        buyUsd: 0,
        sellUsd: 0,
        buyCount: 0,
        sellCount: 0,
        totalUsd: 0,
      };
      byWallet.set(t.wallet, s);
    }
    if (t.to?.address === mint) {
      totalBuyUsd += usd;
      s.buyUsd += usd;
      s.buyCount++;
    } else if (t.from?.address === mint) {
      totalSellUsd += usd;
      s.sellUsd += usd;
      s.sellCount++;
    }
    s.totalUsd = s.buyUsd + s.sellUsd;
  }
  const netUsd = totalBuyUsd - totalSellUsd;
  const walletStats = [...byWallet.values()]
    .sort((a, b) => b.totalUsd - a.totalUsd)
    .slice(0, 5);

  // Position lookup for the top-wallets table.
  const portfolioEntry = portfolioCache.get(groupId);
  const portfolioIndex = buildPortfolioIndex(portfolioEntry?.data);
  const lookupPosition = makeLookupPosition(portfolioEntry?.data, portfolioIndex);

  const headerLabel = tokenSymbol
    ? `${tokenSymbol}${tokenName && tokenName !== tokenSymbol ? ` · ${tokenName}` : ""}`
    : tokenName ?? `${mint.slice(0, 8)}…`;

  return (
    <Panel
      title={`Token detail · ${headerLabel}`}
      subtitle={
        <span className="inline-flex items-center gap-2 text-[11px]">
          <span className="font-mono text-neutral-300">
            {shortAddr(mint, 6, 6)}
          </span>
          <CopyMintButton mint={mint} />
          <Link
            href={`/groups/${groupId}?tab=activity`}
            scroll={false}
            title="Clear token filter"
            aria-label="Clear token filter"
            className="rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 text-[10px] font-semibold text-neutral-300 transition-colors duration-100 hover:border-neutral-500 hover:bg-neutral-800 hover:text-white"
          >
            Clear filter ✕
          </Link>
        </span>
      }
    >
      {/* stats grid */}
      <div className="grid grid-cols-2 gap-px border-b border-neutral-800 bg-neutral-800 sm:grid-cols-4">
        <TokenStatTile
          label="Total buy volume"
          value={
            <span className="text-emerald-300">{fmtUsd(totalBuyUsd)}</span>
          }
        />
        <TokenStatTile
          label="Total sell volume"
          value={<span className="text-red-300">{fmtUsd(totalSellUsd)}</span>}
        />
        <TokenStatTile
          label="Net flow"
          value={
            <span
              className={
                netUsd > 0
                  ? "text-emerald-300"
                  : netUsd < 0
                  ? "text-red-300"
                  : "text-neutral-200"
              }
            >
              {netUsd > 0 ? "+" : ""}
              {fmtUsd(netUsd)}
            </span>
          }
        />
        <TokenStatTile
          label="Wallets active"
          value={<span className="text-white">{byWallet.size}</span>}
        />
      </div>

      {/* top wallets in this token */}
      {walletStats.length > 0 ? (
        <div>
          <div className="grid grid-cols-12 gap-3 border-b border-neutral-800 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
            <div className="col-span-4">Wallet</div>
            <div className="col-span-3 text-right">Buy USD</div>
            <div className="col-span-3 text-right">Sell USD</div>
            <div className="col-span-2 text-right">Position</div>
          </div>
          <ul className="divide-y divide-neutral-800">
            {walletStats.map((w) => {
              const pos = lookupPosition(w.wallet, mint);
              return (
                <li
                  key={w.wallet}
                  className="grid grid-cols-12 items-center gap-3 px-3 py-1.5 text-xs transition-colors duration-100 hover:bg-neutral-800/60"
                >
                  <div className="col-span-4 min-w-0">
                    {w.label ? (
                      <div className="truncate text-sm font-semibold text-white">
                        {w.label}
                      </div>
                    ) : (
                      <WalletLink address={w.wallet} chars={4} />
                    )}
                    <div className="text-[10px] text-neutral-500">
                      {w.buyCount} buys · {w.sellCount} sells
                    </div>
                  </div>
                  <div className="col-span-3 text-right">
                    <div className="font-semibold tabular-nums text-emerald-300">
                      {fmtUsd(w.buyUsd)}
                    </div>
                  </div>
                  <div className="col-span-3 text-right">
                    <div className="font-semibold tabular-nums text-red-300">
                      {fmtUsd(w.sellUsd)}
                    </div>
                  </div>
                  <div className="col-span-2 flex justify-end">
                    <PositionBadge status={pos.status} />
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <div className="px-4 py-6 text-center text-sm text-neutral-500">
          No trades for this token in the loaded feed.
        </div>
      )}
    </Panel>
  );
}

function TokenStatTile({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="bg-neutral-900 px-3 py-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
        {label}
      </div>
      <div className="mt-0.5 text-lg font-bold tabular-nums">{value}</div>
    </div>
  );
}

function CopyMintButton({ mint }: { mint: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    navigator.clipboard
      .writeText(mint)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        /* clipboard unavailable; ignore */
      });
  }, [mint]);
  return (
    <button
      type="button"
      onClick={handleCopy}
      title="Copy token mint to clipboard"
      aria-label="Copy token mint to clipboard"
      className="rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 text-[10px] font-semibold text-neutral-300 transition-colors duration-100 hover:border-neutral-500 hover:bg-neutral-800 hover:text-white"
    >
      {copied ? "Copied ✓" : "Copy"}
    </button>
  );
}
