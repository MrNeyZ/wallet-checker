import type { GroupWallet } from "../../lib/groupsStore.js";
import { buildPnlOverview } from "./groupPnl.js";
import { buildPortfolioSummary } from "./groupPortfolio.js";
import { buildTokenActivity, fetchGroupTrades } from "./groupTrades.js";

export interface DashboardOptions {
  tradesPerWallet?: number;
  recentLimit?: number;
  stepDelayMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function buildGroupDashboard(
  group: { id: string; name: string; wallets: GroupWallet[] },
  options: DashboardOptions = {},
) {
  const tradesPerWallet = options.tradesPerWallet ?? 50;
  const recentLimit = options.recentLimit ?? 20;
  const stepDelayMs = options.stepDelayMs ?? 500;
  const warnings: string[] = [];

  let pnlOverview: unknown = null;
  try {
    const value = await buildPnlOverview(group);
    pnlOverview = value;
    if (value.failed > 0) {
      warnings.push(`pnlOverview: ${value.failed} wallet(s) failed`);
    }
  } catch (err) {
    warnings.push(`pnlOverview section failed: ${(err as Error)?.message ?? "unknown"}`);
  }

  await sleep(stepDelayMs);

  let portfolioSummary: unknown = null;
  try {
    const value = await buildPortfolioSummary(group);
    portfolioSummary = value;
    if (value.failedWallets.length > 0) {
      warnings.push(`portfolioSummary: ${value.failedWallets.length} wallet(s) failed`);
    }
  } catch (err) {
    warnings.push(`portfolioSummary section failed: ${(err as Error)?.message ?? "unknown"}`);
  }

  await sleep(stepDelayMs);

  let tokenActivitySummary: unknown = null;
  let recentTrades: unknown = null;
  try {
    const { merged, failedWallets } = await fetchGroupTrades(group, tradesPerWallet);
    tokenActivitySummary = {
      perWalletLimit: tradesPerWallet,
      tokens: buildTokenActivity(merged),
      failedWallets,
    };
    recentTrades = {
      limit: recentLimit,
      trades: merged.slice(0, recentLimit),
      failedWallets,
    };
    if (failedWallets.length > 0) {
      warnings.push(`trades fetch: ${failedWallets.length} wallet(s) failed`);
    }
  } catch (err) {
    warnings.push(`trades sections failed: ${(err as Error)?.message ?? "unknown"}`);
  }

  return {
    pnlOverview,
    portfolioSummary,
    tokenActivitySummary,
    recentTrades,
    warnings,
  };
}
