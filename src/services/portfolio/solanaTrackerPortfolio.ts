// Portfolio provider — backed by Helius Wallet Balances API.
// File name preserved for minimal import-site churn; the previous SolanaTracker
// implementation has been replaced.
import { env } from "../../config/env.js";

const BASE_URL = "https://api.helius.xyz";
export const PORTFOLIO_CACHE_TTL_MS = 5 * 60 * 1000;
const PAGE_LIMIT = 100;

export class MissingHeliusConfigError extends Error {
  constructor() {
    super("HELIUS_API_KEY is not configured");
    this.name = "MissingHeliusConfigError";
  }
}

export class HeliusApiError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "HeliusApiError";
  }
}

export interface PortfolioTokenItem {
  mint: string;
  symbol: string | null;
  name: string | null;
  image: string | null;
  decimals: number | null;
  balance: number;
  valueUsd: number;
}

export interface WalletPortfolio {
  wallet: string;
  provider: "helius";
  totalUsd: number;
  totalSol: number | null;
  tokens: PortfolioTokenItem[];
  fetchedAt: string;
  cacheHit: boolean;
  cacheTtlSeconds: number;
}

interface CacheEntry {
  totalUsd: number;
  totalSol: number | null;
  tokens: PortfolioTokenItem[];
  fetchedAt: string;
  expiresAt: number;
}

const portfolioCache = new Map<string, CacheEntry>();

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function normalizeToken(raw: unknown): PortfolioTokenItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as {
    mint?: unknown;
    symbol?: unknown;
    name?: unknown;
    logoUri?: unknown;
    decimals?: unknown;
    balance?: unknown;
    usdValue?: unknown;
  };
  const mint = strOrNull(r.mint);
  if (!mint) return null;
  return {
    mint,
    symbol: strOrNull(r.symbol),
    name: strOrNull(r.name),
    image: strOrNull(r.logoUri),
    decimals: typeof r.decimals === "number" ? r.decimals : null,
    balance: num(r.balance),
    valueUsd: num(r.usdValue),
  };
}

interface HeliusBalancesResponse {
  balances?: unknown[];
  totalUsdValue?: unknown;
  pagination?: { hasMore?: boolean; page?: number };
}

async function fetchPage(
  wallet: string,
  apiKey: string,
  page: number,
): Promise<HeliusBalancesResponse> {
  const params = new URLSearchParams({
    "api-key": apiKey,
    page: String(page),
    limit: String(PAGE_LIMIT),
  });
  const url = `${BASE_URL}/v1/wallet/${encodeURIComponent(wallet)}/balances?${params.toString()}`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Network error";
    throw new HeliusApiError(`Helius request failed: ${message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new HeliusApiError(
      `Helius returned ${res.status}: ${body.slice(0, 300)}`,
      res.status,
    );
  }
  return (await res.json()) as HeliusBalancesResponse;
}

export async function fetchWalletPortfolio(wallet: string): Promise<WalletPortfolio> {
  const now = Date.now();
  const cached = portfolioCache.get(wallet);
  if (cached && cached.expiresAt > now) {
    return {
      wallet,
      provider: "helius",
      totalUsd: cached.totalUsd,
      totalSol: cached.totalSol,
      tokens: cached.tokens,
      fetchedAt: cached.fetchedAt,
      cacheHit: true,
      cacheTtlSeconds: Math.ceil((cached.expiresAt - now) / 1000),
    };
  }

  const apiKey = env.HELIUS_API_KEY;
  if (!apiKey) throw new MissingHeliusConfigError();

  const tokens: PortfolioTokenItem[] = [];
  let totalUsd = 0;
  let page = 1;
  // first page also tells us totalUsdValue (may not be repeated on later pages)
  while (true) {
    const data = await fetchPage(wallet, apiKey, page);
    if (page === 1) {
      totalUsd = num(data.totalUsdValue);
    }
    if (Array.isArray(data.balances)) {
      for (const raw of data.balances) {
        const t = normalizeToken(raw);
        if (t) tokens.push(t);
      }
    }
    if (!data.pagination?.hasMore) break;
    page += 1;
    if (page > 50) break; // hard safety cap (5000 tokens)
  }

  const fetchedAt = new Date().toISOString();
  const expiresAt = Date.now() + PORTFOLIO_CACHE_TTL_MS;
  portfolioCache.set(wallet, { totalUsd, totalSol: null, tokens, fetchedAt, expiresAt });

  return {
    wallet,
    provider: "helius",
    totalUsd,
    totalSol: null,
    tokens,
    fetchedAt,
    cacheHit: false,
    cacheTtlSeconds: Math.ceil(PORTFOLIO_CACHE_TTL_MS / 1000),
  };
}
