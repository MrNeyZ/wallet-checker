import type { TradeRecord } from "./types.js";

// Quote tokens: any trade where one leg is a quote and the other is not is a
// directional swap. Sym matching is uppercase-insensitive.
export const QUOTE_SYMBOLS: ReadonlySet<string> = new Set([
  "SOL",
  "WSOL",
  "USDC",
  "USDT",
  "USDH",
  "EURC",
]);

// Buy = spent quote, received non-quote token.
export function isBuyTrade(t: TradeRecord): boolean {
  const fromSym = (t.from?.token?.symbol ?? "").toUpperCase();
  const toSym = (t.to?.token?.symbol ?? "").toUpperCase();
  return QUOTE_SYMBOLS.has(fromSym) && !QUOTE_SYMBOLS.has(toSym);
}

// Sell = spent non-quote token, received quote.
export function isSellTrade(t: TradeRecord): boolean {
  const fromSym = (t.from?.token?.symbol ?? "").toUpperCase();
  const toSym = (t.to?.token?.symbol ?? "").toUpperCase();
  return !QUOTE_SYMBOLS.has(fromSym) && QUOTE_SYMBOLS.has(toSym);
}
