export interface PnlSummary {
  totalPnlUsd: number | null;
  realizedPnlUsd: number | null;
  unrealizedPnlUsd: number | null;
  winRate: number | null;
  totalTrades: number | null;
  tokensCount: number | null;
}

const EMPTY_SUMMARY: PnlSummary = {
  totalPnlUsd: null,
  realizedPnlUsd: null,
  unrealizedPnlUsd: null,
  winRate: null,
  totalTrades: null,
  tokensCount: null,
};

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pickNumber(source: Record<string, unknown> | undefined, keys: string[]): number | null {
  if (!source) return null;
  for (const key of keys) {
    const v = num(source[key]);
    if (v !== null) return v;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function normalizePnlSummary(data: unknown): PnlSummary {
  const root = asRecord(data);
  if (!root) return EMPTY_SUMMARY;

  const summary = asRecord(root.summary) ?? root;

  const totalPnlUsd = pickNumber(summary, ["total", "totalPnl", "totalPnlUsd", "pnl"]);
  const realizedPnlUsd = pickNumber(summary, ["realized", "realizedPnl", "realizedPnlUsd"]);
  const unrealizedPnlUsd = pickNumber(summary, [
    "unrealized",
    "unrealizedPnl",
    "unrealizedPnlUsd",
  ]);

  let winRate = pickNumber(summary, ["winPercentage", "winRate", "winrate"]);
  if (winRate !== null && winRate > 1 && winRate <= 100) winRate = winRate / 100;

  const wins = pickNumber(summary, ["totalWins", "wins"]);
  const losses = pickNumber(summary, ["totalLosses", "losses"]);
  let totalTrades = pickNumber(summary, ["totalTrades", "trades", "tradeCount"]);
  if (totalTrades === null && wins !== null && losses !== null) {
    totalTrades = wins + losses;
  }

  let tokensCount: number | null = null;
  const tokens = root.tokens;
  if (tokens && typeof tokens === "object") {
    if (Array.isArray(tokens)) tokensCount = tokens.length;
    else tokensCount = Object.keys(tokens as Record<string, unknown>).length;
  }
  if (tokensCount === null) {
    tokensCount = pickNumber(summary, ["tokensCount", "totalTokens"]);
  }

  return {
    totalPnlUsd,
    realizedPnlUsd,
    unrealizedPnlUsd,
    winRate,
    totalTrades,
    tokensCount,
  };
}
