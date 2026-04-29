import { env } from "../../config/env.js";
import { solanaTrackerFetch } from "../solanaTracker/throttle.js";
import { normalizePnlSummary, type PnlSummary } from "./normalizePnl.js";

const BASE_URL = "https://data.solanatracker.io";

export class MissingApiKeyError extends Error {
  constructor() {
    super("SOLANATRACKER_API_KEY is not configured");
    this.name = "MissingApiKeyError";
  }
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

// Bumped from 5min to 10min. PnL aggregates change slowly relative to
// trades; doubling the TTL halves group-open SolanaTracker pressure on
// repeat visits without users noticing stale data.
export const PNL_CACHE_TTL_MS = 10 * 60 * 1000;

interface CacheEntry {
  data: unknown;
  fetchedAt: string;
  expiresAt: number;
}

const pnlCache = new Map<string, CacheEntry>();
// In-flight dedupe: when N concurrent requests come in for the same wallet,
// only the first triggers a SolanaTracker fetch; the rest await the same
// promise. Without this, a single user who spam-clicks Refresh or a group
// of N wallets all sharing one address would each fire their own fetch
// through the throttle's queue, multiplying rate-limit pressure for the
// same data.
const pnlInFlight = new Map<string, Promise<NormalizedPnlResponse>>();

export interface NormalizedPnlResponse {
  wallet: string;
  provider: "solanatracker";
  data: unknown;
  summary: PnlSummary;
  fetchedAt: string;
  cacheHit: boolean;
  cacheTtlSeconds: number;
}

async function fetchFromProvider(wallet: string): Promise<{ data: unknown; fetchedAt: string }> {
  const apiKey = env.SOLANATRACKER_API_KEY;
  if (!apiKey) {
    throw new MissingApiKeyError();
  }

  const url = `${BASE_URL}/pnl/${encodeURIComponent(wallet)}`;
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

  const data = (await res.json()) as unknown;
  return { data, fetchedAt: new Date().toISOString() };
}

export async function fetchWalletPnl(wallet: string): Promise<NormalizedPnlResponse> {
  const now = Date.now();
  const cached = pnlCache.get(wallet);

  if (cached && cached.expiresAt > now) {
    console.log(`[SolanaTracker] cache hit pnl/${wallet}`);
    return {
      wallet,
      provider: "solanatracker",
      data: cached.data,
      summary: normalizePnlSummary(cached.data),
      fetchedAt: cached.fetchedAt,
      cacheHit: true,
      cacheTtlSeconds: Math.ceil((cached.expiresAt - now) / 1000),
    };
  }

  // In-flight dedupe — see pnlInFlight comment.
  const existing = pnlInFlight.get(wallet);
  if (existing) {
    console.log(`[SolanaTracker] dedupe pnl/${wallet}`);
    return existing;
  }

  console.log(`[SolanaTracker] queued pnl/${wallet}`);
  const promise = (async (): Promise<NormalizedPnlResponse> => {
    try {
      const { data, fetchedAt } = await fetchFromProvider(wallet);
      const expiresAt = Date.now() + PNL_CACHE_TTL_MS;
      pnlCache.set(wallet, { data, fetchedAt, expiresAt });
      return {
        wallet,
        provider: "solanatracker",
        data,
        summary: normalizePnlSummary(data),
        fetchedAt,
        cacheHit: false,
        cacheTtlSeconds: Math.ceil(PNL_CACHE_TTL_MS / 1000),
      };
    } finally {
      pnlInFlight.delete(wallet);
    }
  })();
  pnlInFlight.set(wallet, promise);
  return promise;
}
