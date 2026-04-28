// User-tunable thresholds for the signal pipeline. Defaults match the
// frontend's hardcoded defaults so backend-driven Telegram notifications
// (added in a later task) trigger on the same conditions the user sees in
// the Activity tab.

export interface SignalSettings {
  minBuyUsd: number;
  minDumpUsd: number;
  accumulationMinBuys: number;
  accumulationWindowMinutes: number;
  strongSignalWindowMinutes: number;
  multiDumpWindowMinutes: number;
}

export const DEFAULT_SIGNAL_SETTINGS: SignalSettings = {
  minBuyUsd: 0,
  minDumpUsd: 50,
  accumulationMinBuys: 3,
  accumulationWindowMinutes: 10,
  strongSignalWindowMinutes: 5,
  multiDumpWindowMinutes: 5,
};

// Definitional minimums for "multi-wallet" — not user-tunable; if the user
// could lower this to 1 the cluster signals would collapse into the
// single-trade signals.
export const STRONG_MIN_WALLETS = 2;
export const DUMP_MULTI_MIN_WALLETS = 2;
