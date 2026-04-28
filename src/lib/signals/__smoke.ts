// Smoke check for the signals module. Compiles under the same `tsc` build as
// the rest of the backend; run as `npm run signals:smoke` to also exercise
// the values at runtime. Constructs minimal hand-rolled inputs and asserts
// each builder returns the expected counts. No fetch / fs / env / Express.

import {
  DEFAULT_SIGNAL_SETTINGS,
  buildAllSignals,
  computeWalletScores,
  isBuyTrade,
  isSellTrade,
  type OverviewResult,
  type TradeRecord,
} from "./index.js";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok  ${msg}`);
}

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PUMP = "PumpFunMintAddress11111111111111111111111111";
const A = "WalletAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "WalletBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const buy = (
  wallet: string,
  tx: string,
  time: number,
  usd: number,
): TradeRecord => ({
  wallet,
  label: null,
  tx,
  time,
  program: "raydium",
  from: { address: SOL, amount: usd / 100, token: { symbol: "SOL", name: "Solana" }, priceUsd: 100 },
  to: { address: PUMP, amount: 1_000, token: { symbol: "PUMP", name: "Pump Token" }, priceUsd: usd / 1000 },
  volume: { usd, sol: usd / 100 },
});

const sell = (
  wallet: string,
  tx: string,
  time: number,
  usd: number,
): TradeRecord => ({
  wallet,
  label: null,
  tx,
  time,
  program: "raydium",
  from: { address: PUMP, amount: 1_000, token: { symbol: "PUMP", name: "Pump Token" }, priceUsd: usd / 1000 },
  to: { address: USDC, amount: usd, token: { symbol: "USDC", name: "USD Coin" }, priceUsd: 1 },
  volume: { usd, sol: usd / 100 },
});

console.log("==> isBuyTrade / isSellTrade");
const sampleBuy = buy(A, "tx-buy", 0, 100);
const sampleSell = sell(A, "tx-sell", 0, 100);
assert(isBuyTrade(sampleBuy), "SOL→PUMP classified as buy");
assert(!isSellTrade(sampleBuy), "buy is not a sell");
assert(isSellTrade(sampleSell), "PUMP→USDC classified as sell");
assert(!isBuyTrade(sampleSell), "sell is not a buy");

console.log("==> computeWalletScores");
const overview: OverviewResult[] = [
  {
    wallet: A,
    label: "alpha",
    ok: true,
    summary: {
      totalPnlUsd: 1000,
      realizedPnlUsd: 800,
      unrealizedPnlUsd: 200,
      winRate: 0.7,
      totalTrades: 50,
      tokensCount: 12,
    },
  },
  {
    wallet: B,
    label: "beta",
    ok: true,
    summary: {
      totalPnlUsd: -200,
      realizedPnlUsd: -150,
      unrealizedPnlUsd: -50,
      winRate: 0.3,
      totalTrades: 10,
      tokensCount: 4,
    },
  },
  // Third wallet to satisfy the top-3 minimum gate.
  {
    wallet: "WalletCcccccccccccccccccccccccccccccccccccc",
    label: "gamma",
    ok: true,
    summary: {
      totalPnlUsd: 0,
      realizedPnlUsd: 0,
      unrealizedPnlUsd: 0,
      winRate: 0.5,
      totalTrades: 5,
      tokensCount: 2,
    },
  },
  // Failing row — must be filtered out.
  { wallet: "WalletFail", label: null, ok: false, error: "boom" },
];
const scored = computeWalletScores(overview);
assert(scored.length === 3, "scored 3 usable wallets");
assert(scored[0].wallet === A, "wallet A ranks first");
assert(scored[scored.length - 1].wallet === B, "wallet B ranks last");
assert(scored[0].score >= scored[1].score, "scores are descending");

console.log("==> buildAllSignals (smart + cluster + dumps)");
// Three buys by A on PUMP within ~3 minutes — accumulation.
// One additional buy by B on PUMP at minute 4 — completes a strong cluster.
// Two sells (A and B) on PUMP within 1 minute → multi-wallet dump.
const t0 = 1_700_000_000_000;
const trades: TradeRecord[] = [
  buy(A, "buy-1", t0 + 0 * 60_000, 200),
  buy(A, "buy-2", t0 + 1 * 60_000, 250),
  buy(A, "buy-3", t0 + 2 * 60_000, 300),
  buy(B, "buy-4", t0 + 4 * 60_000, 400),
  sell(A, "sell-1", t0 + 30 * 60_000, 600),
  sell(B, "sell-2", t0 + 30 * 60_000 + 30_000, 700),
];

const out = buildAllSignals(trades, scored, DEFAULT_SIGNAL_SETTINGS);
assert(out.smart.length === 4, `smart=4 (got ${out.smart.length})`);
assert(out.accumulation.length === 1, `accumulation=1 (got ${out.accumulation.length})`);
assert(out.accumulation[0].buyCount >= 3, "accumulation cluster has ≥3 buys");
assert(out.strong.length === 1, `strong=1 (got ${out.strong.length})`);
assert(out.strong[0].walletCount === 2, "strong cluster has 2 distinct wallets");
assert(out.dumps.length === 2, `dumps=2 (got ${out.dumps.length})`);
assert(
  out.multiDumps.length === 1,
  `multiDumps=1 (got ${out.multiDumps.length})`,
);
assert(
  out.multiDumps[0].walletCount === 2,
  "multi-dump cluster has 2 distinct wallets",
);

// Volume threshold honoured for dumps: lowering settings.minDumpUsd should
// keep all sells; raising it should drop them.
const noFloor = buildAllSignals(trades, scored, {
  ...DEFAULT_SIGNAL_SETTINGS,
  minDumpUsd: 0,
});
assert(noFloor.dumps.length === 2, "minDumpUsd=0 keeps both sells");

const highFloor = buildAllSignals(trades, scored, {
  ...DEFAULT_SIGNAL_SETTINGS,
  minDumpUsd: 1_000_000,
});
assert(highFloor.dumps.length === 0, "huge minDumpUsd drops all sells");

// Buy-USD floor.
const bigBuysOnly = buildAllSignals(trades, scored, {
  ...DEFAULT_SIGNAL_SETTINGS,
  minBuyUsd: 350,
});
assert(
  bigBuysOnly.smart.length === 1,
  `minBuyUsd=350 keeps only the $400 buy (got ${bigBuysOnly.smart.length})`,
);

console.log("\nAll signal-module smoke checks passed.");
