import type { GroupWallet } from "../../lib/groupsStore.js";
import { runWithConcurrency } from "../../lib/concurrency.js";
import {
  fetchWalletPnl,
  MissingApiKeyError,
  ProviderError,
} from "../pnl/solanaTrackerProvider.js";
import type { PnlSummary } from "../pnl/normalizePnl.js";

const CONCURRENCY = 5;

export type SummableField =
  | "totalPnlUsd"
  | "realizedPnlUsd"
  | "unrealizedPnlUsd"
  | "totalTrades"
  | "tokensCount";

export const SUMMABLE_FIELDS: SummableField[] = [
  "totalPnlUsd",
  "realizedPnlUsd",
  "unrealizedPnlUsd",
  "totalTrades",
  "tokensCount",
];

export interface OverviewItem {
  wallet: string;
  label: string | null;
  ok: boolean;
  summary?: PnlSummary;
  error?: string;
  cacheHit?: boolean;
  cacheTtlSeconds?: number;
}

export interface GroupPnlItem extends OverviewItem {
  data?: unknown;
}

function pnlError(err: unknown): string {
  if (err instanceof MissingApiKeyError) return err.message;
  if (err instanceof ProviderError) return err.message;
  return err instanceof Error ? err.message : "Unknown error";
}

export async function buildPnlOverview(group: { wallets: GroupWallet[] }) {
  const results = await runWithConcurrency<GroupWallet, OverviewItem>(
    group.wallets,
    CONCURRENCY,
    async ({ address, label }) => {
      try {
        const result = await fetchWalletPnl(address);
        return {
          wallet: address,
          label,
          ok: true,
          summary: result.summary,
          cacheHit: result.cacheHit,
          cacheTtlSeconds: result.cacheTtlSeconds,
        };
      } catch (err) {
        return { wallet: address, label, ok: false, error: pnlError(err) };
      }
    },
  );

  const rank = (item: OverviewItem): number => {
    if (!item.ok) return 2;
    const v = item.summary?.totalPnlUsd;
    return typeof v === "number" && Number.isFinite(v) ? 0 : 1;
  };
  results.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 0) return (b.summary!.totalPnlUsd as number) - (a.summary!.totalPnlUsd as number);
    return 0;
  });

  const totals: Record<SummableField, number | null> = {
    totalPnlUsd: null,
    realizedPnlUsd: null,
    unrealizedPnlUsd: null,
    totalTrades: null,
    tokensCount: null,
  };
  for (const field of SUMMABLE_FIELDS) {
    let total = 0;
    let any = false;
    for (const item of results) {
      if (!item.ok || !item.summary) continue;
      const v = item.summary[field];
      if (typeof v === "number" && Number.isFinite(v)) {
        total += v;
        any = true;
      }
    }
    totals[field] = any ? total : null;
  }

  const okCount = results.filter((r) => r.ok).length;
  return { ok: okCount, failed: results.length - okCount, totals, results };
}

export async function buildGroupPnl(group: { wallets: GroupWallet[] }) {
  const results = await runWithConcurrency<GroupWallet, GroupPnlItem>(
    group.wallets,
    CONCURRENCY,
    async ({ address, label }) => {
      try {
        const result = await fetchWalletPnl(address);
        return {
          wallet: address,
          label,
          ok: true,
          data: result.data,
          summary: result.summary,
          cacheHit: result.cacheHit,
          cacheTtlSeconds: result.cacheTtlSeconds,
        };
      } catch (err) {
        return { wallet: address, label, ok: false, error: pnlError(err) };
      }
    },
  );
  const okCount = results.filter((r) => r.ok).length;
  return { count: results.length, ok: okCount, failed: results.length - okCount, results };
}
