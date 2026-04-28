// Backend-friendly signal pipeline. Pure functions, no I/O.
// Consumers (the future signal evaluator service) feed in the same trades +
// overview shapes the existing groupTrades / groupOverview services produce,
// plus a SignalSettings object, and receive all signal kinds back.

export type {
  AccumulationSignal,
  DumpSignal,
  MultiDumpSignal,
  OverviewResult,
  PnlSummary,
  ScoredWallet,
  SmartSignal,
  StrongSignal,
  StrongSignalTopWallet,
  TokenLeg,
  TradeRecord,
} from "./types.js";
export {
  DEFAULT_SIGNAL_SETTINGS,
  DUMP_MULTI_MIN_WALLETS,
  STRONG_MIN_WALLETS,
  type SignalSettings,
} from "./settings.js";
export { QUOTE_SYMBOLS, isBuyTrade, isSellTrade } from "./quote.js";
export { computeWalletScores } from "./scoring.js";
export {
  buildAccumulationSignals,
  buildAllSignals,
  buildDumpSignals,
  buildMultiDumpSignals,
  buildSmartSignals,
  buildStrongSignals,
} from "./builders.js";
