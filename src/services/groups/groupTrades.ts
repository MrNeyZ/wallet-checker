import type { GroupWallet } from "../../lib/groupsStore.js";
import { runWithConcurrency } from "../../lib/concurrency.js";
import { fetchWalletTrades } from "../trades/solanaTrackerTrades.js";

const CONCURRENCY = 5;

export const QUOTE_MINTS = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);

export interface MergedTrade {
  wallet: string;
  label: string | null;
  tx: unknown;
  time: number;
  program: unknown;
  from: unknown;
  to: unknown;
  price: unknown;
  volume: unknown;
}

export interface FailedWallet {
  wallet: string;
  label: string | null;
  error: string;
}

export interface TradeFilters {
  minUsd?: number;
  program?: string;
  side?: "buy" | "sell";
  token?: string;
}

export interface TokenAggregate {
  mint: string;
  symbol: string | null;
  name: string | null;
  image: string | null;
  buysCount: number;
  sellsCount: number;
  totalBuyUsd: number;
  totalSellUsd: number;
  netUsd: number;
  walletsCount: number;
  wallets: { wallet: string; label: string | null }[];
}

export function tradeSide(trade: MergedTrade): "buy" | "sell" | "unknown" {
  const fromAddr = (trade.from as { address?: unknown } | null)?.address;
  const toAddr = (trade.to as { address?: unknown } | null)?.address;
  const fromQuote = typeof fromAddr === "string" && QUOTE_MINTS.has(fromAddr);
  const toQuote = typeof toAddr === "string" && QUOTE_MINTS.has(toAddr);
  if (fromQuote && !toQuote) return "buy";
  if (toQuote && !fromQuote) return "sell";
  return "unknown";
}

function legMatchesToken(leg: unknown, query: string, queryLower: string): boolean {
  if (!leg || typeof leg !== "object") return false;
  const l = leg as { address?: unknown; token?: unknown };
  if (typeof l.address === "string" && l.address === query) return true;
  if (l.token && typeof l.token === "object") {
    const tk = l.token as { symbol?: unknown; name?: unknown };
    if (typeof tk.symbol === "string" && tk.symbol.toLowerCase() === queryLower) return true;
    if (typeof tk.name === "string" && tk.name.toLowerCase() === queryLower) return true;
  }
  return false;
}

export async function fetchGroupTrades(
  group: { wallets: GroupWallet[] },
  perWalletLimit: number,
): Promise<{ merged: MergedTrade[]; failedWallets: FailedWallet[] }> {
  const failedWallets: FailedWallet[] = [];
  const settled = await runWithConcurrency<GroupWallet, MergedTrade[]>(
    group.wallets,
    CONCURRENCY,
    async ({ address, label }) => {
      try {
        const result = await fetchWalletTrades(address, { limit: perWalletLimit });
        return result.trades.map((raw) => {
          const t = raw as Record<string, unknown>;
          const time = typeof t.time === "number" ? t.time : 0;
          return {
            wallet: address,
            label,
            tx: t.tx,
            time,
            program: t.program,
            from: t.from,
            to: t.to,
            price: t.price,
            volume: t.volume,
          } satisfies MergedTrade;
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        failedWallets.push({ wallet: address, label, error: message });
        return [];
      }
    },
  );
  const perWallet: MergedTrade[][] = settled.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    const { address, label } = group.wallets[i];
    const message = r.reason instanceof Error ? r.reason.message : "Unknown error";
    failedWallets.push({ wallet: address, label, error: message });
    return [];
  });
  const merged = perWallet.flat().sort((a, b) => b.time - a.time);
  return { merged, failedWallets };
}

export function applyTradeFilters(trades: MergedTrade[], filters: TradeFilters): MergedTrade[] {
  let out = trades;
  if (filters.program !== undefined) {
    const target = filters.program.toLowerCase();
    out = out.filter(
      (t) => typeof t.program === "string" && t.program.toLowerCase() === target,
    );
  }
  if (filters.minUsd !== undefined) {
    const min = filters.minUsd;
    out = out.filter((t) => {
      const usd = (t.volume as { usd?: unknown } | null)?.usd;
      return typeof usd === "number" && usd >= min;
    });
  }
  if (filters.side !== undefined) {
    const target = filters.side;
    out = out.filter((t) => tradeSide(t) === target);
  }
  if (filters.token !== undefined) {
    const q = filters.token;
    const ql = q.toLowerCase();
    out = out.filter((t) => legMatchesToken(t.from, q, ql) || legMatchesToken(t.to, q, ql));
  }
  return out;
}

export function buildTokenActivity(merged: MergedTrade[]): TokenAggregate[] {
  interface Internal {
    mint: string;
    symbol: string | null;
    name: string | null;
    image: string | null;
    buysCount: number;
    sellsCount: number;
    totalBuyUsd: number;
    totalSellUsd: number;
    walletsSet: Set<string>;
    wallets: { wallet: string; label: string | null }[];
    walletsSeen: Set<string>;
  }
  const tokens = new Map<string, Internal>();
  const getLeg = (leg: unknown) =>
    leg && typeof leg === "object"
      ? (leg as {
          address?: unknown;
          token?: { symbol?: unknown; name?: unknown; image?: unknown };
        })
      : null;

  for (const t of merged) {
    const from = getLeg(t.from);
    const to = getLeg(t.to);
    if (!from || !to) continue;
    const fromAddr = typeof from.address === "string" ? from.address : null;
    const toAddr = typeof to.address === "string" ? to.address : null;
    if (!fromAddr || !toAddr) continue;
    const fromQuote = QUOTE_MINTS.has(fromAddr);
    const toQuote = QUOTE_MINTS.has(toAddr);

    let mint: string;
    let leg: typeof from;
    let isBuy: boolean;
    if (fromQuote && !toQuote) {
      mint = toAddr;
      leg = to;
      isBuy = true;
    } else if (toQuote && !fromQuote) {
      mint = fromAddr;
      leg = from;
      isBuy = false;
    } else {
      continue;
    }

    const usd = (t.volume as { usd?: unknown } | null)?.usd;
    const usdNum = typeof usd === "number" && Number.isFinite(usd) ? usd : 0;

    let agg = tokens.get(mint);
    if (!agg) {
      agg = {
        mint,
        symbol: typeof leg.token?.symbol === "string" ? leg.token.symbol : null,
        name: typeof leg.token?.name === "string" ? leg.token.name : null,
        image: typeof leg.token?.image === "string" ? leg.token.image : null,
        buysCount: 0,
        sellsCount: 0,
        totalBuyUsd: 0,
        totalSellUsd: 0,
        walletsSet: new Set(),
        wallets: [],
        walletsSeen: new Set(),
      };
      tokens.set(mint, agg);
    }

    if (isBuy) {
      agg.buysCount += 1;
      agg.totalBuyUsd += usdNum;
    } else {
      agg.sellsCount += 1;
      agg.totalSellUsd += usdNum;
    }
    agg.walletsSet.add(t.wallet);
    if (!agg.walletsSeen.has(t.wallet)) {
      agg.walletsSeen.add(t.wallet);
      agg.wallets.push({ wallet: t.wallet, label: t.label });
    }
  }

  return Array.from(tokens.values())
    .map((agg) => ({
      mint: agg.mint,
      symbol: agg.symbol,
      name: agg.name,
      image: agg.image,
      buysCount: agg.buysCount,
      sellsCount: agg.sellsCount,
      totalBuyUsd: agg.totalBuyUsd,
      totalSellUsd: agg.totalSellUsd,
      netUsd: agg.totalBuyUsd - agg.totalSellUsd,
      walletsCount: agg.walletsSet.size,
      wallets: agg.wallets,
    }))
    .sort((a, b) => Math.abs(b.netUsd) - Math.abs(a.netUsd));
}

export async function buildGroupTokenSummary(
  group: { wallets: GroupWallet[] },
  perWalletLimit: number,
  minUsd: number | undefined,
) {
  const { merged, failedWallets } = await fetchGroupTrades(group, perWalletLimit);
  let trades = merged;
  if (minUsd !== undefined) {
    trades = applyTradeFilters(merged, { minUsd });
  }
  return { tokens: buildTokenActivity(trades), failedWallets };
}
