import type { GroupWallet } from "../../lib/groupsStore.js";
import { buildPnlOverview } from "./groupPnl.js";
import { buildPortfolioSummary } from "./groupPortfolio.js";
import { buildTokenActivity, fetchGroupTrades } from "./groupTrades.js";

export interface DashboardOptions {
  tradesPerWallet?: number;
  recentLimit?: number;
}

export async function buildGroupDashboard(
  group: { id: string; name: string; wallets: GroupWallet[] },
  options: DashboardOptions = {},
) {
  const tradesPerWallet = options.tradesPerWallet ?? 50;
  const recentLimit = options.recentLimit ?? 20;
  const warnings: string[] = [];

  const [pnlRes, portfolioRes, tradesRes] = await Promise.allSettled([
    buildPnlOverview(group),
    buildPortfolioSummary(group),
    fetchGroupTrades(group, tradesPerWallet),
  ]);

  let pnlOverview: unknown = null;
  if (pnlRes.status === "fulfilled") {
    pnlOverview = pnlRes.value;
    if (pnlRes.value.failed > 0) {
      warnings.push(`pnlOverview: ${pnlRes.value.failed} wallet(s) failed`);
    }
  } else {
    warnings.push(`pnlOverview section failed: ${(pnlRes.reason as Error)?.message ?? "unknown"}`);
  }

  let portfolioSummary: unknown = null;
  if (portfolioRes.status === "fulfilled") {
    portfolioSummary = portfolioRes.value;
    if (portfolioRes.value.failedWallets.length > 0) {
      warnings.push(
        `portfolioSummary: ${portfolioRes.value.failedWallets.length} wallet(s) failed`,
      );
    }
  } else {
    warnings.push(
      `portfolioSummary section failed: ${(portfolioRes.reason as Error)?.message ?? "unknown"}`,
    );
  }

  let tokenActivitySummary: unknown = null;
  let recentTrades: unknown = null;
  if (tradesRes.status === "fulfilled") {
    const { merged, failedWallets } = tradesRes.value;
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
  } else {
    warnings.push(`trades sections failed: ${(tradesRes.reason as Error)?.message ?? "unknown"}`);
  }

  return {
    pnlOverview,
    portfolioSummary,
    tokenActivitySummary,
    recentTrades,
    warnings,
  };
}
