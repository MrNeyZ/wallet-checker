import { env } from "../../config/env.js";
import {
  MissingApiKeyError,
  ProviderError,
} from "../pnl/solanaTrackerProvider.js";

const BASE_URL = "https://data.solanatracker.io";
export const PORTFOLIO_CACHE_TTL_MS = 5 * 60 * 1000;

export { MissingApiKeyError, ProviderError };

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
  provider: "solanatracker";
  totalUsd: number;
  totalSol: number;
  tokens: PortfolioTokenItem[];
  fetchedAt: string;
  cacheHit: boolean;
  cacheTtlSeconds: number;
}

interface CacheEntry {
  totalUsd: number;
  totalSol: number;
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
  const r = raw as { token?: unknown; balance?: unknown; value?: unknown };
  const tk = r.token && typeof r.token === "object" ? (r.token as Record<string, unknown>) : null;
  const mint = strOrNull(tk?.mint);
  if (!mint) return null;
  return {
    mint,
    symbol: strOrNull(tk?.symbol),
    name: strOrNull(tk?.name),
    image: strOrNull(tk?.image),
    decimals: typeof tk?.decimals === "number" ? tk.decimals : null,
    balance: num(r.balance),
    valueUsd: num(r.value),
  };
}

export async function fetchWalletPortfolio(wallet: string): Promise<WalletPortfolio> {
  const now = Date.now();
  const cached = portfolioCache.get(wallet);
  if (cached && cached.expiresAt > now) {
    return {
      wallet,
      provider: "solanatracker",
      totalUsd: cached.totalUsd,
      totalSol: cached.totalSol,
      tokens: cached.tokens,
      fetchedAt: cached.fetchedAt,
      cacheHit: true,
      cacheTtlSeconds: Math.ceil((cached.expiresAt - now) / 1000),
    };
  }

  const apiKey = env.SOLANATRACKER_API_KEY;
  if (!apiKey) throw new MissingApiKeyError();

  const url = `${BASE_URL}/wallet/${encodeURIComponent(wallet)}`;
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
    tokens?: unknown[];
    total?: unknown;
    totalSol?: unknown;
  };

  const tokens = Array.isArray(data.tokens)
    ? data.tokens
        .map(normalizeToken)
        .filter((x): x is PortfolioTokenItem => x !== null)
    : [];
  const totalUsd = num(data.total);
  const totalSol = num(data.totalSol);
  const fetchedAt = new Date().toISOString();
  const expiresAt = Date.now() + PORTFOLIO_CACHE_TTL_MS;

  portfolioCache.set(wallet, { totalUsd, totalSol, tokens, fetchedAt, expiresAt });

  return {
    wallet,
    provider: "solanatracker",
    totalUsd,
    totalSol,
    tokens,
    fetchedAt,
    cacheHit: false,
    cacheTtlSeconds: Math.ceil(PORTFOLIO_CACHE_TTL_MS / 1000),
  };
}
