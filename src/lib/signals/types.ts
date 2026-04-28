// Pure type definitions for the signal pipeline.
// These mirror the frontend shapes the UI already passes through (TradeItem,
// OverviewResultItem) but are restated here so the backend module can stand
// on its own with no cross-package import. The frontend will continue to
// own its current local copies until the evaluator service is wired up.

export interface PnlSummary {
  totalPnlUsd: number | null;
  realizedPnlUsd: number | null;
  unrealizedPnlUsd: number | null;
  winRate: number | null;
  totalTrades: number | null;
  tokensCount: number | null;
}

export interface OverviewResult {
  wallet: string;
  label: string | null;
  ok: boolean;
  summary?: PnlSummary;
  error?: string;
}

export interface TokenLeg {
  address: string;
  amount: number;
  token: { symbol: string; name: string };
  priceUsd: number;
}

export interface TradeRecord {
  wallet: string;
  label: string | null;
  tx: string;
  time: number; // ms epoch
  program: string;
  from: TokenLeg;
  to: TokenLeg;
  volume: { usd: number; sol: number };
}

// ============================================================================
// Output types
// ============================================================================

export interface ScoredWallet {
  wallet: string;
  label: string | null;
  score: number; // 0–100
  pnlUsd: number;
  winRate: number; // 0–1
  trades: number;
}

export interface SmartSignal {
  trade: TradeRecord;
  scored: ScoredWallet;
  rank: number; // 1-based among scored wallets
}

export interface AccumulationSignal {
  wallet: string;
  walletLabel: string | null;
  rank: number;
  score: number;
  tokenMint: string;
  tokenSymbol: string | null;
  tokenName: string | null;
  buyCount: number;
  totalUsd: number;
  firstTime: number;
  lastTime: number;
  latestTx: string;
}

export interface StrongSignalTopWallet {
  wallet: string;
  label: string | null;
  rank: number;
  score: number;
}

export interface StrongSignal {
  tokenMint: string;
  tokenSymbol: string | null;
  tokenName: string | null;
  walletCount: number;
  topWallets: StrongSignalTopWallet[];
  totalUsd: number;
  latestTime: number;
  latestTx: string;
  txCount: number;
}

export interface DumpSignal {
  trade: TradeRecord;
  scored: ScoredWallet;
  rank: number;
}

export interface MultiDumpSignal {
  tokenMint: string;
  tokenSymbol: string | null;
  tokenName: string | null;
  walletCount: number;
  topWallets: StrongSignalTopWallet[];
  totalUsd: number;
  latestTime: number;
  latestTx: string;
  txCount: number;
}
