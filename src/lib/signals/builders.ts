import { isBuyTrade, isSellTrade } from "./quote.js";
import {
  DUMP_MULTI_MIN_WALLETS,
  STRONG_MIN_WALLETS,
  type SignalSettings,
} from "./settings.js";
import type {
  AccumulationSignal,
  DumpSignal,
  MultiDumpSignal,
  ScoredWallet,
  SmartSignal,
  StrongSignal,
  StrongSignalTopWallet,
  TradeRecord,
} from "./types.js";

// Top 20% by score with a minimum of 3 — same gate as Smart signals on the
// frontend. Returns a Map<wallet, { scored, rank }> for O(1) lookup.
function topWalletRanks(
  scored: ScoredWallet[],
): Map<string, { scored: ScoredWallet; rank: number }> {
  if (scored.length === 0) return new Map();
  const cutoff = Math.max(3, Math.ceil(scored.length * 0.2));
  const slice = scored.slice(0, Math.min(cutoff, scored.length));
  const map = new Map<string, { scored: ScoredWallet; rank: number }>();
  slice.forEach((s, i) => map.set(s.wallet, { scored: s, rank: i + 1 }));
  return map;
}

// =============================================================================
// Smart signals — single-trade buys from any top wallet.
// =============================================================================
export function buildSmartSignals(
  trades: TradeRecord[],
  scored: ScoredWallet[],
  minBuyUsd: number,
): SmartSignal[] {
  if (scored.length === 0 || trades.length === 0) return [];
  const ranks = topWalletRanks(scored);

  const out: SmartSignal[] = [];
  const seenTx = new Set<string>();
  for (const t of trades) {
    if (seenTx.has(t.tx)) continue;
    const hit = ranks.get(t.wallet);
    if (!hit) continue;
    if (!isBuyTrade(t)) continue;
    if (minBuyUsd > 0 && (t.volume?.usd ?? 0) < minBuyUsd) continue;
    seenTx.add(t.tx);
    out.push({ trade: t, scored: hit.scored, rank: hit.rank });
  }
  out.sort((a, b) => b.trade.time - a.trade.time);
  return out;
}

// =============================================================================
// Strong signals — clusters of ≥STRONG_MIN_WALLETS distinct top wallets buying
// the same token within a sliding window.
// =============================================================================
export function buildStrongSignals(
  signals: SmartSignal[],
  windowMs: number,
): StrongSignal[] {
  const byMint = new Map<string, SmartSignal[]>();
  for (const s of signals) {
    const mint = s.trade.to?.address ?? "";
    if (!mint) continue;
    let arr = byMint.get(mint);
    if (!arr) {
      arr = [];
      byMint.set(mint, arr);
    }
    arr.push(s);
  }

  const out: StrongSignal[] = [];
  for (const group of byMint.values()) {
    const sorted = [...group].sort((a, b) => a.trade.time - b.trade.time);
    let i = 0;
    while (i < sorted.length) {
      let j = i;
      while (
        j + 1 < sorted.length &&
        sorted[j + 1].trade.time - sorted[i].trade.time <= windowMs
      ) {
        j++;
      }
      const cluster = sorted.slice(i, j + 1);
      const distinct = new Map<string, SmartSignal>();
      for (const c of cluster) {
        const existing = distinct.get(c.trade.wallet);
        if (!existing || c.scored.score > existing.scored.score) {
          distinct.set(c.trade.wallet, c);
        }
      }
      if (distinct.size >= STRONG_MIN_WALLETS) {
        const sample = cluster[0].trade;
        const totalUsd = cluster.reduce(
          (acc, c) => acc + (c.trade.volume?.usd ?? 0),
          0,
        );
        const topWallets: StrongSignalTopWallet[] = [...distinct.values()]
          .sort((a, b) => a.rank - b.rank)
          .slice(0, 3)
          .map((c) => ({
            wallet: c.trade.wallet,
            label: c.trade.label,
            rank: c.rank,
            score: c.scored.score,
          }));
        out.push({
          tokenMint: sample.to.address,
          tokenSymbol: sample.to.token?.symbol ?? null,
          tokenName: sample.to.token?.name ?? null,
          walletCount: distinct.size,
          topWallets,
          totalUsd,
          latestTime: sorted[j].trade.time,
          latestTx: sorted[j].trade.tx,
          txCount: cluster.length,
        });
      }
      i = j + 1;
    }
  }
  return out.sort((a, b) => b.latestTime - a.latestTime);
}

// =============================================================================
// Early accumulation — single top wallet stacks ≥minBuys buys on the same
// token within windowMs. Same-wallet revisits after a pause yield separate
// signals (non-overlapping clusters).
// =============================================================================
export function buildAccumulationSignals(
  signals: SmartSignal[],
  opts: { windowMs: number; minBuys: number },
): AccumulationSignal[] {
  const byKey = new Map<string, SmartSignal[]>();
  for (const s of signals) {
    const mint = s.trade.to?.address ?? "";
    if (!mint) continue;
    const key = `${s.trade.wallet}|${mint}`;
    let arr = byKey.get(key);
    if (!arr) {
      arr = [];
      byKey.set(key, arr);
    }
    arr.push(s);
  }

  const out: AccumulationSignal[] = [];
  for (const group of byKey.values()) {
    const sorted = [...group].sort((a, b) => a.trade.time - b.trade.time);
    let i = 0;
    while (i < sorted.length) {
      let j = i;
      while (
        j + 1 < sorted.length &&
        sorted[j + 1].trade.time - sorted[i].trade.time <= opts.windowMs
      ) {
        j++;
      }
      const clusterLen = j - i + 1;
      if (clusterLen >= opts.minBuys) {
        const first = sorted[i];
        const last = sorted[j];
        const totalUsd = sorted
          .slice(i, j + 1)
          .reduce((acc, c) => acc + (c.trade.volume?.usd ?? 0), 0);
        out.push({
          wallet: first.trade.wallet,
          walletLabel: first.trade.label,
          rank: first.rank,
          score: first.scored.score,
          tokenMint: first.trade.to.address,
          tokenSymbol: first.trade.to.token?.symbol ?? null,
          tokenName: first.trade.to.token?.name ?? null,
          buyCount: clusterLen,
          totalUsd,
          firstTime: first.trade.time,
          lastTime: last.trade.time,
          latestTx: last.trade.tx,
        });
      }
      i = j + 1;
    }
  }
  return out.sort((a, b) => b.lastTime - a.lastTime);
}

// =============================================================================
// Dump signals — single-trade sells from any top wallet, over the volume floor.
// =============================================================================
export function buildDumpSignals(
  trades: TradeRecord[],
  scored: ScoredWallet[],
  minDumpUsd: number,
): DumpSignal[] {
  if (scored.length === 0 || trades.length === 0) return [];
  const ranks = topWalletRanks(scored);

  const out: DumpSignal[] = [];
  const seenTx = new Set<string>();
  for (const t of trades) {
    if (seenTx.has(t.tx)) continue;
    const hit = ranks.get(t.wallet);
    if (!hit) continue;
    if (!isSellTrade(t)) continue;
    if ((t.volume?.usd ?? 0) < minDumpUsd) continue;
    seenTx.add(t.tx);
    out.push({ trade: t, scored: hit.scored, rank: hit.rank });
  }
  out.sort((a, b) => b.trade.time - a.trade.time);
  return out;
}

// =============================================================================
// Multi-wallet dumps — clusters of ≥DUMP_MULTI_MIN_WALLETS distinct top
// wallets selling the same token within windowMs.
// =============================================================================
export function buildMultiDumpSignals(
  dumps: DumpSignal[],
  windowMs: number,
): MultiDumpSignal[] {
  const byMint = new Map<string, DumpSignal[]>();
  for (const d of dumps) {
    const mint = d.trade.from?.address ?? "";
    if (!mint) continue;
    let arr = byMint.get(mint);
    if (!arr) {
      arr = [];
      byMint.set(mint, arr);
    }
    arr.push(d);
  }

  const out: MultiDumpSignal[] = [];
  for (const group of byMint.values()) {
    const sorted = [...group].sort((a, b) => a.trade.time - b.trade.time);
    let i = 0;
    while (i < sorted.length) {
      let j = i;
      while (
        j + 1 < sorted.length &&
        sorted[j + 1].trade.time - sorted[i].trade.time <= windowMs
      ) {
        j++;
      }
      const cluster = sorted.slice(i, j + 1);
      const distinct = new Map<string, DumpSignal>();
      for (const c of cluster) {
        const existing = distinct.get(c.trade.wallet);
        if (!existing || c.scored.score > existing.scored.score) {
          distinct.set(c.trade.wallet, c);
        }
      }
      if (distinct.size >= DUMP_MULTI_MIN_WALLETS) {
        const sample = cluster[0].trade;
        const totalUsd = cluster.reduce(
          (acc, c) => acc + (c.trade.volume?.usd ?? 0),
          0,
        );
        const topWallets: StrongSignalTopWallet[] = [...distinct.values()]
          .sort((a, b) => a.rank - b.rank)
          .slice(0, 3)
          .map((c) => ({
            wallet: c.trade.wallet,
            label: c.trade.label,
            rank: c.rank,
            score: c.scored.score,
          }));
        out.push({
          tokenMint: sample.from.address,
          tokenSymbol: sample.from.token?.symbol ?? null,
          tokenName: sample.from.token?.name ?? null,
          walletCount: distinct.size,
          topWallets,
          totalUsd,
          latestTime: sorted[j].trade.time,
          latestTx: sorted[j].trade.tx,
          txCount: cluster.length,
        });
      }
      i = j + 1;
    }
  }
  return out.sort((a, b) => b.latestTime - a.latestTime);
}

// Convenience wrapper: take overview + trades + settings, return all signal
// kinds at once. Useful for the future evaluator service. Pure — no I/O.
export function buildAllSignals(
  trades: TradeRecord[],
  scored: ScoredWallet[],
  settings: SignalSettings,
): {
  smart: SmartSignal[];
  strong: StrongSignal[];
  accumulation: AccumulationSignal[];
  dumps: DumpSignal[];
  multiDumps: MultiDumpSignal[];
} {
  const smart = buildSmartSignals(trades, scored, settings.minBuyUsd);
  const strong = buildStrongSignals(
    smart,
    settings.strongSignalWindowMinutes * 60_000,
  );
  const accumulation = buildAccumulationSignals(smart, {
    windowMs: settings.accumulationWindowMinutes * 60_000,
    minBuys: settings.accumulationMinBuys,
  });
  const dumps = buildDumpSignals(trades, scored, settings.minDumpUsd);
  const multiDumps = buildMultiDumpSignals(
    dumps,
    settings.multiDumpWindowMinutes * 60_000,
  );
  return { smart, strong, accumulation, dumps, multiDumps };
}
