// Meteora DLMM LP positions provider.
// Calls the public unauthenticated DLMM datapi:
//   GET https://dlmm.datapi.meteora.ag/wallets/{wallet}/open_positions
// Endpoint is undocumented — paths discovered via the open-source
// meteora-go SDK (https://pkg.go.dev/github.com/ua1984/meteora-go/dlmm).
// Treat shape as best-effort and normalize defensively.

const BASE_URL = "https://dlmm.datapi.meteora.ag";
export const LP_CACHE_TTL_MS = 5 * 60 * 1000;

export class MeteoraApiError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "MeteoraApiError";
  }
}

export interface NormalizedTokenLeg {
  mint: string;
  symbol: string | null;
  name: string | null;
  icon: string | null;
  decimals: number | null;
}

export interface MeteoraDlmmPosition {
  protocol: "meteora_dlmm";
  poolAddress: string;
  positionAddress: string;
  pairName: string | null;
  tokenX: NormalizedTokenLeg;
  tokenY: NormalizedTokenLeg;
  valueUsd: number;
  unclaimedFeesUsd: number;
  totalDepositsUsd: number;
  totalWithdrawsUsd: number;
  totalClaimedFeesUsd: number;
  unrealizedPnlUsd: number;
  unrealizedPnlPct: number;
  lowerBinId: number | null;
  upperBinId: number | null;
  activeBinId: number | null;
  createdAt: number | null;
}

export interface MeteoraDlmmResult {
  wallet: string;
  positions: MeteoraDlmmPosition[];
  fetchedAt: string;
  cacheHit: boolean;
  cacheTtlSeconds: number;
}

interface CacheEntry {
  positions: MeteoraDlmmPosition[];
  fetchedAt: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function intOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function normalizeToken(raw: unknown): NormalizedTokenLeg {
  if (!raw || typeof raw !== "object") {
    return { mint: "", symbol: null, name: null, icon: null, decimals: null };
  }
  const t = raw as Record<string, unknown>;
  return {
    mint: typeof t.address === "string" ? t.address : "",
    symbol: strOrNull(t.symbol),
    name: strOrNull(t.name),
    icon: strOrNull(t.icon),
    decimals: typeof t.decimals === "number" ? t.decimals : null,
  };
}

interface AmountTotals {
  amount_usd?: unknown;
}

function totalsUsd(raw: unknown): number {
  if (!raw || typeof raw !== "object") return 0;
  return num((raw as AmountTotals).amount_usd);
}

function normalizePosition(
  poolAddress: string,
  pairName: string | null,
  activeBinId: number | null,
  tokenX: NormalizedTokenLeg,
  tokenY: NormalizedTokenLeg,
  rawPos: unknown,
): MeteoraDlmmPosition | null {
  if (!rawPos || typeof rawPos !== "object") return null;
  const p = rawPos as Record<string, unknown>;
  const positionAddress = typeof p.position_address === "string" ? p.position_address : null;
  if (!positionAddress) return null;

  const current = p.current_position as Record<string, unknown> | undefined;
  const currentDeposits = current?.current_deposits;
  const unclaimedFees = current?.unclaimed_fees;

  return {
    protocol: "meteora_dlmm",
    poolAddress,
    positionAddress,
    pairName,
    tokenX,
    tokenY,
    valueUsd: totalsUsd(currentDeposits),
    unclaimedFeesUsd: totalsUsd(unclaimedFees),
    totalDepositsUsd: totalsUsd(p.total_deposits),
    totalWithdrawsUsd: totalsUsd(p.total_withdraws),
    totalClaimedFeesUsd: totalsUsd(p.total_claimed_fees),
    unrealizedPnlUsd: num(p.unrealized_pnl),
    unrealizedPnlPct: num(p.unrealized_pnl_change_pct),
    lowerBinId: intOrNull(p.lower_bin_id),
    upperBinId: intOrNull(p.upper_bin_id),
    activeBinId,
    createdAt: intOrNull(p.created_at),
  };
}

function normalizeResponse(data: unknown): MeteoraDlmmPosition[] {
  if (!data || typeof data !== "object") return [];
  const root = data as { data?: unknown };
  const groups = Array.isArray(root.data) ? root.data : [];
  const out: MeteoraDlmmPosition[] = [];
  for (const g of groups) {
    if (!g || typeof g !== "object") continue;
    const grp = g as Record<string, unknown>;
    const poolAddress = typeof grp.pool_address === "string" ? grp.pool_address : "";
    if (!poolAddress) continue;
    const pairName = strOrNull(grp.name);
    const activeBinId = intOrNull(grp.active_bin_id);
    const tokenX = normalizeToken(grp.token_x);
    const tokenY = normalizeToken(grp.token_y);
    const positions = Array.isArray(grp.positions) ? grp.positions : [];
    for (const raw of positions) {
      const p = normalizePosition(poolAddress, pairName, activeBinId, tokenX, tokenY, raw);
      if (p) out.push(p);
    }
  }
  return out;
}

export async function fetchWalletMeteoraDlmm(wallet: string): Promise<MeteoraDlmmResult> {
  const now = Date.now();
  const cached = cache.get(wallet);
  if (cached && cached.expiresAt > now) {
    return {
      wallet,
      positions: cached.positions,
      fetchedAt: cached.fetchedAt,
      cacheHit: true,
      cacheTtlSeconds: Math.ceil((cached.expiresAt - now) / 1000),
    };
  }

  const url = `${BASE_URL}/wallets/${encodeURIComponent(wallet)}/open_positions`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Network error";
    throw new MeteoraApiError(`Meteora DLMM request failed: ${message}`);
  }

  // 404 = wallet has no DLMM positions; treat as success with empty array.
  if (res.status === 404) {
    const positions: MeteoraDlmmPosition[] = [];
    const fetchedAt = new Date().toISOString();
    const expiresAt = Date.now() + LP_CACHE_TTL_MS;
    cache.set(wallet, { positions, fetchedAt, expiresAt });
    return {
      wallet,
      positions,
      fetchedAt,
      cacheHit: false,
      cacheTtlSeconds: Math.ceil(LP_CACHE_TTL_MS / 1000),
    };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new MeteoraApiError(
      `Meteora DLMM returned ${res.status}: ${body.slice(0, 300)}`,
      res.status,
    );
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch (err) {
    throw new MeteoraApiError(
      `Meteora DLMM response was not valid JSON: ${(err as Error).message}`,
    );
  }

  const positions = normalizeResponse(data);
  const fetchedAt = new Date().toISOString();
  const expiresAt = Date.now() + LP_CACHE_TTL_MS;
  cache.set(wallet, { positions, fetchedAt, expiresAt });

  return {
    wallet,
    positions,
    fetchedAt,
    cacheHit: false,
    cacheTtlSeconds: Math.ceil(LP_CACHE_TTL_MS / 1000),
  };
}
