"use client";

// Client-side lazy wrappers for the heavy sections. Each one fetches its own
// data on mount via a server action, with loading/error/retry states. Mounting
// is gated by the parent tab, so the fetch only fires when the tab is active.

import { useCallback, useEffect, useRef, useState } from "react";
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
  PanelError,
  PanelSkeleton,
  PnlOverviewLoadingSkeleton,
  PnlOverviewView,
  PortfolioLoadingSkeleton,
  PortfolioView,
  RecentTradesView,
  TokenActivityView,
  TradesLoadingSkeleton,
} from "./sections";

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
      else setState({ status: "error", error: res.error });
    })();
    return () => {
      cancelled = true;
    };
  }, [label]);

  useEffect(() => {
    const cleanup = reload();
    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { state, reload };
}

// Module-level cache so PnL overview survives tab unmount/remount. Keyed by
// groupId; same-key remount uses cached data instantly with no auto-refetch.
const overviewCache = new Map<
  string,
  { data: OverviewResponse; fetchedAt: number }
>();

export function LazyPnlOverview({ groupId }: { groupId: string }) {
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
        setError(res.error);
      }
      setRefreshing(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [groupId]);

  useEffect(() => {
    if (!data) {
      const cleanup = load();
      return cleanup;
    }
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

export function LazyPortfolio({ groupId }: { groupId: string }) {
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
        setError(res.error);
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
    if (!data) {
      const cleanup = load();
      return cleanup;
    }
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

export function LazyLp({ groupId }: { groupId: string }) {
  const { state, reload } = useLazyLoad<GroupLpResponse>("lp", () => loadLpAction(groupId));
  if (state.status === "loading") return <PanelSkeleton title="LP Positions" lines={3} />;
  if (state.status === "error")
    return <PanelError title="LP Positions" error={state.error} onRetry={reload} />;
  return <LpView data={state.data} />;
}

export function LazyAirdrops({ groupId }: { groupId: string }) {
  const { state, reload } = useLazyLoad<AirdropsState>("airdrops", () =>
    loadAirdropsAction(groupId),
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
        setError(res.error);
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
