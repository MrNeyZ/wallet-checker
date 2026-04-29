import { env } from "../../config/env.js";
import { solanaTrackerFetch } from "../solanaTracker/throttle.js";
import {
  MissingApiKeyError,
  ProviderError,
} from "../pnl/solanaTrackerProvider.js";

const BASE_URL = "https://data.solanatracker.io";

// Bumped 60s → 3min → 5min as upstream rate-limit pressure has grown.
// Trades latency tolerance is high (users don't expect real-time
// activity), so longer TTLs are net-positive for reliability.
export const TRADES_CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  trades: unknown[];
  nextCursor: string | null;
  hasNextPage: boolean;
  fetchedAt: string;
  expiresAt: number;
}

const tradesCache = new Map<string, CacheEntry>();
// In-flight dedupe — see pnlInFlight comment in solanaTrackerProvider.ts.
// Same pattern keyed by the cache key (includes cursor + limit).
const tradesInFlight = new Map<string, Promise<WalletTradesResponse>>();

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
    console.log(`[SolanaTracker] cache hit trades/${wallet}`);
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

  const existing = tradesInFlight.get(key);
  if (existing) {
    console.log(`[SolanaTracker] dedupe trades/${wallet}`);
    return existing;
  }

  console.log(`[SolanaTracker] queued trades/${wallet}`);
  const promise = (async (): Promise<WalletTradesResponse> => {
    try {
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
        res = await solanaTrackerFetch(url, { headers: { "x-api-key": apiKey } });
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
      } else if (
        typeof data.nextCursor === "number" &&
        Number.isFinite(data.nextCursor)
      ) {
        nextCursor = String(data.nextCursor);
      }

      const trades = Array.isArray(data.trades) ? data.trades : [];
      const hasNextPage = data.hasNextPage === true;
      const fetchedAt = new Date().toISOString();
      const expiresAt = Date.now() + TRADES_CACHE_TTL_MS;
      tradesCache.set(key, {
        trades,
        nextCursor,
        hasNextPage,
        fetchedAt,
        expiresAt,
      });

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
    } finally {
      tradesInFlight.delete(key);
    }
  })();
  tradesInFlight.set(key, promise);
  return promise;
}
