import { env } from "../../config/env.js";
import {
  MissingApiKeyError,
  ProviderError,
} from "../pnl/solanaTrackerProvider.js";

const BASE_URL = "https://data.solanatracker.io";

export const TRADES_CACHE_TTL_MS = 60 * 1000;

interface CacheEntry {
  trades: unknown[];
  nextCursor: string | null;
  hasNextPage: boolean;
  fetchedAt: string;
  expiresAt: number;
}

const tradesCache = new Map<string, CacheEntry>();

function cacheKey(wallet: string, cursor: string | undefined, limit: number | undefined): string {
  return `${wallet}|${cursor ?? ""}|${limit ?? ""}`;
}

export { MissingApiKeyError, ProviderError };

export interface WalletTradesResponse {
  wallet: string;
  provider: "solanatracker";
  trades: unknown[];
  nextCursor: string | null;
  hasNextPage: boolean;
  fetchedAt: string;
  cacheHit: boolean;
  cacheTtlSeconds: number;
}

export interface FetchWalletTradesOptions {
  cursor?: string;
  limit?: number;
}

export async function fetchWalletTrades(
  wallet: string,
  options: FetchWalletTradesOptions = {},
): Promise<WalletTradesResponse> {
  const key = cacheKey(wallet, options.cursor, options.limit);
  const now = Date.now();
  const cached = tradesCache.get(key);
  if (cached && cached.expiresAt > now) {
    return {
      wallet,
      provider: "solanatracker",
      trades: cached.trades,
      nextCursor: cached.nextCursor,
      hasNextPage: cached.hasNextPage,
      fetchedAt: cached.fetchedAt,
      cacheHit: true,
      cacheTtlSeconds: Math.ceil((cached.expiresAt - now) / 1000),
    };
  }

  const apiKey = env.SOLANATRACKER_API_KEY;
  if (!apiKey) {
    throw new MissingApiKeyError();
  }

  const params = new URLSearchParams();
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  const qs = params.toString();
  const url = `${BASE_URL}/wallet/${encodeURIComponent(wallet)}/trades${qs ? `?${qs}` : ""}`;

  let res: Response;
  try {
    res = await fetch(url, { headers: { "x-api-key": apiKey } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Network error";
    throw new ProviderError(`SolanaTracker request failed: ${message}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ProviderError(
      `SolanaTracker returned ${res.status}: ${body.slice(0, 300)}`,
      res.status,
    );
  }

  const data = (await res.json()) as {
    trades?: unknown[];
    nextCursor?: string | number | null;
    hasNextPage?: boolean;
  };

  let nextCursor: string | null = null;
  if (typeof data.nextCursor === "string" && data.nextCursor.length > 0) {
    nextCursor = data.nextCursor;
  } else if (typeof data.nextCursor === "number" && Number.isFinite(data.nextCursor)) {
    nextCursor = String(data.nextCursor);
  }

  const trades = Array.isArray(data.trades) ? data.trades : [];
  const hasNextPage = data.hasNextPage === true;
  const fetchedAt = new Date().toISOString();
  const expiresAt = Date.now() + TRADES_CACHE_TTL_MS;
  tradesCache.set(key, { trades, nextCursor, hasNextPage, fetchedAt, expiresAt });

  return {
    wallet,
    provider: "solanatracker",
    trades,
    nextCursor,
    hasNextPage,
    fetchedAt,
    cacheHit: false,
    cacheTtlSeconds: Math.ceil(TRADES_CACHE_TTL_MS / 1000),
  };
}
