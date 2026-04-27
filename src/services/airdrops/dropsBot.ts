// drops.bot value-endpoint provider.
// Endpoint: GET https://api.drops.bot/shared/v1/value/airdrops/solana/{wallet}
// Auth: x-api-key header.
// Returns aggregated airdrop count + USD total per wallet.
import { env } from "../../config/env.js";

const BASE_URL = "https://api.drops.bot/shared/v1/value/airdrops/solana";
export const AIRDROPS_CACHE_TTL_MS = 30 * 60 * 1000;

export class MissingDropsBotConfigError extends Error {
  constructor() {
    super("DROPS_BOT_API_KEY is not configured");
    this.name = "MissingDropsBotConfigError";
  }
}

export class DropsBotApiError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "DropsBotApiError";
  }
}

export interface AirdropValueResult {
  wallet: string;
  airdropsCount: number;
  totalValueUsd: number;
  totalValueUsdFormatted: string | null;
  isUnknownUsdValue: boolean;
  addressUrl: string | null;
  fetchedAt: string;
  cacheHit: boolean;
  cacheTtlSeconds: number;
}

interface CacheEntry {
  airdropsCount: number;
  totalValueUsd: number;
  totalValueUsdFormatted: string | null;
  isUnknownUsdValue: boolean;
  addressUrl: string | null;
  fetchedAt: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function normalize(raw: unknown): Omit<CacheEntry, "fetchedAt" | "expiresAt"> {
  const root = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const data = root.data && typeof root.data === "object" ? (root.data as Record<string, unknown>) : root;
  return {
    airdropsCount: num(data.airdropsCount),
    totalValueUsd: num(data.totalValueUsd),
    totalValueUsdFormatted: strOrNull(data.totalValueUsdFormatted),
    isUnknownUsdValue: data.isUnknownUsdValue === true,
    addressUrl: strOrNull(data.addressUrl),
  };
}

export async function fetchWalletAirdropValue(wallet: string): Promise<AirdropValueResult> {
  const now = Date.now();
  const cached = cache.get(wallet);
  if (cached && cached.expiresAt > now) {
    return {
      wallet,
      airdropsCount: cached.airdropsCount,
      totalValueUsd: cached.totalValueUsd,
      totalValueUsdFormatted: cached.totalValueUsdFormatted,
      isUnknownUsdValue: cached.isUnknownUsdValue,
      addressUrl: cached.addressUrl,
      fetchedAt: cached.fetchedAt,
      cacheHit: true,
      cacheTtlSeconds: Math.ceil((cached.expiresAt - now) / 1000),
    };
  }

  const apiKey = env.DROPS_BOT_API_KEY;
  if (!apiKey) throw new MissingDropsBotConfigError();

  const url = `${BASE_URL}/${encodeURIComponent(wallet)}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { "x-api-key": apiKey } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Network error";
    throw new DropsBotApiError(`drops.bot request failed: ${message}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new DropsBotApiError(
      `drops.bot returned ${res.status}: ${body.slice(0, 300)}`,
      res.status,
    );
  }

  let raw: unknown;
  try {
    raw = await res.json();
  } catch (err) {
    throw new DropsBotApiError(`drops.bot response was not valid JSON: ${(err as Error).message}`);
  }

  const normalized = normalize(raw);
  const fetchedAt = new Date().toISOString();
  const expiresAt = Date.now() + AIRDROPS_CACHE_TTL_MS;
  cache.set(wallet, { ...normalized, fetchedAt, expiresAt });

  return {
    wallet,
    ...normalized,
    fetchedAt,
    cacheHit: false,
    cacheTtlSeconds: Math.ceil(AIRDROPS_CACHE_TTL_MS / 1000),
  };
}
