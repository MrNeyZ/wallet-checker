import type { OverviewResult, ScoredWallet } from "./types.js";

// v1 weights:
//   pnl       0.6  — primary success metric
//   winRate   0.2  — secondary, already 0–1
//   activity  0.2  — proxy for volume + recency, normalised over trade count
// Trade count carries the spec's lost weight (volumeUsd 0.1 + recencyBoost 0.1)
// since OverviewResult doesn't carry per-wallet volume or last-trade time.
// Replacing that proxy is a future refinement; the surface stays the same.
const WEIGHTS = {
  pnl: 0.6,
  winRate: 0.2,
  activity: 0.2,
} as const;

function normalize(value: number, arr: number[]): number {
  const min = Math.min(...arr);
  const max = Math.max(...arr);
  if (max === min) return 0.5;
  return (value - min) / (max - min);
}

// Scores a list of overview rows and returns descending-sorted ScoredWallet
// objects. Rows without an `ok` flag or with non-finite PnL are dropped.
export function computeWalletScores(results: OverviewResult[]): ScoredWallet[] {
  const usable = results.filter(
    (r) =>
      r.ok &&
      r.summary &&
      typeof r.summary.totalPnlUsd === "number" &&
      Number.isFinite(r.summary.totalPnlUsd),
  );
  if (usable.length === 0) return [];

  const pnls = usable.map((r) => r.summary!.totalPnlUsd as number);
  const trades = usable.map((r) => r.summary!.totalTrades ?? 0);

  return usable
    .map<ScoredWallet>((r) => {
      const s = r.summary!;
      const pnlUsd = (s.totalPnlUsd as number) ?? 0;
      const winRate =
        typeof s.winRate === "number" && Number.isFinite(s.winRate)
          ? s.winRate
          : 0;
      const t = s.totalTrades ?? 0;
      const score01 =
        normalize(pnlUsd, pnls) * WEIGHTS.pnl +
        winRate * WEIGHTS.winRate +
        normalize(t, trades) * WEIGHTS.activity;
      return {
        wallet: r.wallet,
        label: r.label,
        score: Math.round(Math.max(0, Math.min(1, score01)) * 100),
        pnlUsd,
        winRate,
        trades: t,
      };
    })
    .sort((a, b) => b.score - a.score);
}
