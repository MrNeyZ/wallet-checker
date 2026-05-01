import type { GroupWallet } from "../../lib/groupsStore.js";
import { runWithConcurrency } from "../../lib/concurrency.js";
import {
  fetchWalletPortfolio,
  type PortfolioTokenItem,
} from "../portfolio/solanaTrackerPortfolio.js";

const CONCURRENCY = 5;

export interface AggregatedPortfolioToken {
  mint: string;
  symbol: string | null;
  name: string | null;
  image: string | null;
  totalBalance: number;
  totalValueUsd: number;
  walletsCount: number;
  wallets: { wallet: string; label: string | null; balance: number; valueUsd: number }[];
}

interface PortfolioFetchResult {
  wallet: string;
  label: string | null;
  ok: boolean;
  totalUsd?: number;
  totalSol?: number | null;
  tokens?: PortfolioTokenItem[];
  error?: string;
}

const SUSPICIOUS_PATTERNS = ["reward", "rewards", "claim", "airdrop", ".io"];

const QUOTE_MINTS = new Set([
  "So11111111111111111111111111111111111111111", // native SOL (Helius)
  "So11111111111111111111111111111111111111112", // wrapped SOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);
const QUOTE_SYMBOLS = new Set(["SOL", "WSOL", "USDC", "USDT"]);

function isQuoteToken(t: PortfolioTokenItem): boolean {
  if (QUOTE_MINTS.has(t.mint)) return true;
  if (t.symbol && QUOTE_SYMBOLS.has(t.symbol.toUpperCase())) return true;
  return false;
}

function isSpamToken(t: PortfolioTokenItem): boolean {
  const sym = (t.symbol ?? "").toLowerCase();
  const name = (t.name ?? "").toLowerCase();
  for (const p of SUSPICIOUS_PATTERNS) {
    if (sym.includes(p) || name.includes(p)) return true;
  }
  if (t.valueUsd > 1000 && !isQuoteToken(t)) return true;
  return false;
}

export async function buildPortfolioSummary(group: { wallets: GroupWallet[] }) {
  const failedWallets: { wallet: string; label: string | null; error: string }[] = [];
  const settled = await runWithConcurrency<GroupWallet, PortfolioFetchResult>(
    group.wallets,
    CONCURRENCY,
    async ({ address, label }) => {
      try {
        const result = await fetchWalletPortfolio(address);
        return {
          wallet: address,
          label,
          ok: true,
          totalUsd: result.totalUsd,
          totalSol: result.totalSol,
          tokens: result.tokens,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        failedWallets.push({ wallet: address, label, error: message });
        return { wallet: address, label, ok: false, error: message };
      }
    },
  );
  const perWallet: PortfolioFetchResult[] = settled.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    const { address, label } = group.wallets[i];
    const message = r.reason instanceof Error ? r.reason.message : "Unknown error";
    failedWallets.push({ wallet: address, label, error: message });
    return { wallet: address, label, ok: false, error: message };
  });

  let totalUsd = 0;
  let totalSol = 0;
  let filteredTokensCount = 0;
  const tokens = new Map<string, AggregatedPortfolioToken>();

  for (const w of perWallet) {
    if (!w.ok || !w.tokens) continue;
    totalSol += w.totalSol ?? 0;
    for (const tk of w.tokens) {
      if (isSpamToken(tk)) {
        filteredTokensCount += 1;
        continue;
      }
      totalUsd += tk.valueUsd;
      let agg = tokens.get(tk.mint);
      if (!agg) {
        agg = {
          mint: tk.mint,
          symbol: tk.symbol,
          name: tk.name,
          image: tk.image,
          totalBalance: 0,
          totalValueUsd: 0,
          walletsCount: 0,
          wallets: [],
        };
        tokens.set(tk.mint, agg);
      }
      if (agg.symbol === null && tk.symbol !== null) agg.symbol = tk.symbol;
      if (agg.name === null && tk.name !== null) agg.name = tk.name;
      if (agg.image === null && tk.image !== null) agg.image = tk.image;
      agg.totalBalance += tk.balance;
      agg.totalValueUsd += tk.valueUsd;
      agg.wallets.push({
        wallet: w.wallet,
        label: w.label,
        balance: tk.balance,
        valueUsd: tk.valueUsd,
      });
      agg.walletsCount = agg.wallets.length;
    }
  }

  return {
    totalUsd,
    totalSol,
    tokens: Array.from(tokens.values()).sort((a, b) => b.totalValueUsd - a.totalValueUsd),
    filteredTokensCount,
    failedWallets,
  };
}
