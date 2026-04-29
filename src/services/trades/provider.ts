// Wallet trades provider seam.
//
// This is a deliberately tiny indirection so a future Helius-based trades
// implementation can replace SolanaTracker without touching every call
// site. Today it just re-exports the SolanaTracker function, but new
// callers should import `tradesProvider.fetchWalletTrades` (instead of
// the concrete `fetchWalletTrades`) so the swap is one-line.
//
// TODO(helius-trades): when Helius DAS / Enhanced Transactions can supply
// trade history at the granularity we need (token in/out, USD-denominated
// price, paginated cursor), implement a HeliusTradesProvider and choose
// between providers via env (e.g. TRADES_PROVIDER=helius). Keep the
// SolanaTracker provider as a fallback for the foreseeable future since
// its PnL aggregation is what we actually surface in the UI.

import {
  fetchWalletTrades,
  type FetchWalletTradesOptions,
  type WalletTradesResponse,
} from "./solanaTrackerTrades.js";

export interface WalletTradesProvider {
  fetchWalletTrades(
    wallet: string,
    opts?: FetchWalletTradesOptions,
  ): Promise<WalletTradesResponse>;
}

// Default — SolanaTracker. Change this binding to swap providers.
export const tradesProvider: WalletTradesProvider = {
  fetchWalletTrades,
};
