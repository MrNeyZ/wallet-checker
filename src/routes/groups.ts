import { Router } from "express";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import {
  addWalletToGroup,
  createGroup,
  getGroup,
  listGroups,
  removeWalletFromGroup,
} from "../lib/groupsStore.js";
import { buildPnlOverview, buildGroupPnl } from "../services/groups/groupPnl.js";
import {
  fetchGroupTrades,
  applyTradeFilters,
  buildGroupTokenSummary,
} from "../services/groups/groupTrades.js";
import { buildPortfolioSummary } from "../services/groups/groupPortfolio.js";
import { buildGroupDashboard } from "../services/groups/groupDashboard.js";

const router = Router();

const isPublicKey = (val: string) => {
  try {
    new PublicKey(val);
    return true;
  } catch {
    return false;
  }
};

const createGroupSchema = z.object({
  name: z.string().trim().min(1).max(100),
});

const addWalletSchema = z.object({
  wallet: z.string().refine(isPublicKey, { message: "Invalid Solana address" }),
  label: z.string().trim().max(100).optional(),
});

router.post("/", (req, res) => {
  const parsed = createGroupSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  const group = createGroup(parsed.data.name);
  res.status(201).json(group);
});

router.get("/", (_req, res) => {
  res.json({ groups: listGroups() });
});

router.post("/:groupId/wallets", (req, res) => {
  const parsed = addWalletSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  const result = addWalletToGroup(
    req.params.groupId,
    parsed.data.wallet,
    parsed.data.label ?? null,
  );
  if (!result.ok) {
    if (result.error === "not_found") return res.status(404).json({ error: "Group not found" });
    if (result.error === "duplicate") {
      return res.status(409).json({ error: "Wallet already in group" });
    }
  } else {
    return res.status(201).json(result.wallet);
  }
});

router.get("/:groupId/wallets", (req, res) => {
  const group = getGroup(req.params.groupId);
  if (!group) return res.status(404).json({ error: "Group not found" });
  res.json({ groupId: group.id, wallets: group.wallets });
});

router.delete("/:groupId/wallets/:wallet", (req, res) => {
  if (!isPublicKey(req.params.wallet)) {
    return res.status(400).json({ error: "Invalid Solana address" });
  }
  const result = removeWalletFromGroup(req.params.groupId, req.params.wallet);
  if (result === "not_found_group") return res.status(404).json({ error: "Group not found" });
  if (result === "not_found_wallet") {
    return res.status(404).json({ error: "Wallet not in group" });
  }
  res.status(204).send();
});

router.get("/:groupId/overview", async (req, res) => {
  const group = getGroup(req.params.groupId);
  if (!group) return res.status(404).json({ error: "Group not found" });

  const overview = await buildPnlOverview(group);
  res.json({
    groupId: group.id,
    groupName: group.name,
    walletsCount: overview.results.length,
    ok: overview.ok,
    failed: overview.failed,
    totals: overview.totals,
    results: overview.results,
  });
});

const tradesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  perWalletLimit: z.coerce.number().int().min(1).max(50).default(10),
  minUsd: z.coerce.number().nonnegative().optional(),
  program: z.string().trim().min(1).optional(),
  side: z.enum(["buy", "sell"]).optional(),
  token: z.string().trim().min(1).optional(),
});

router.get("/:groupId/trades", async (req, res) => {
  const group = getGroup(req.params.groupId);
  if (!group) return res.status(404).json({ error: "Group not found" });

  const query = tradesQuerySchema.safeParse(req.query);
  if (!query.success) {
    return res.status(400).json({ error: query.error.issues[0].message });
  }
  const { limit, perWalletLimit, minUsd, program, side, token } = query.data;

  const { merged, failedWallets } = await fetchGroupTrades(group, perWalletLimit);
  const filtered = applyTradeFilters(merged, { minUsd, program, side, token }).slice(0, limit);

  res.json({
    groupId: group.id,
    groupName: group.name,
    walletsCount: group.wallets.length,
    limit,
    perWalletLimit,
    trades: filtered,
    failedWallets,
  });
});

const tokenSummaryQuerySchema = z.object({
  perWalletLimit: z.coerce.number().int().min(1).max(100).default(50),
  minUsd: z.coerce.number().nonnegative().optional(),
});

router.get("/:groupId/token-summary", async (req, res) => {
  const group = getGroup(req.params.groupId);
  if (!group) return res.status(404).json({ error: "Group not found" });

  const query = tokenSummaryQuerySchema.safeParse(req.query);
  if (!query.success) {
    return res.status(400).json({ error: query.error.issues[0].message });
  }
  const { perWalletLimit, minUsd } = query.data;

  const { tokens, failedWallets } = await buildGroupTokenSummary(group, perWalletLimit, minUsd);

  res.json({
    groupId: group.id,
    groupName: group.name,
    walletsCount: group.wallets.length,
    perWalletLimit,
    tokens,
    failedWallets,
  });
});

router.get("/:groupId/portfolio-summary", async (req, res) => {
  const group = getGroup(req.params.groupId);
  if (!group) return res.status(404).json({ error: "Group not found" });

  const summary = await buildPortfolioSummary(group);
  res.json({
    groupId: group.id,
    groupName: group.name,
    walletsCount: group.wallets.length,
    totalUsd: summary.totalUsd,
    totalSol: summary.totalSol,
    tokens: summary.tokens,
    failedWallets: summary.failedWallets,
  });
});

router.get("/:groupId/dashboard", async (req, res) => {
  const group = getGroup(req.params.groupId);
  if (!group) return res.status(404).json({ error: "Group not found" });

  const dashboard = await buildGroupDashboard(group);
  res.json({
    groupId: group.id,
    groupName: group.name,
    walletsCount: group.wallets.length,
    pnlOverview: dashboard.pnlOverview,
    portfolioSummary: dashboard.portfolioSummary,
    tokenActivitySummary: dashboard.tokenActivitySummary,
    recentTrades: dashboard.recentTrades,
    warnings: dashboard.warnings,
  });
});

router.get("/:groupId/pnl", async (req, res) => {
  const group = getGroup(req.params.groupId);
  if (!group) return res.status(404).json({ error: "Group not found" });

  if (group.wallets.length === 0) {
    return res.json({
      groupId: group.id,
      groupName: group.name,
      count: 0,
      ok: 0,
      failed: 0,
      results: [],
    });
  }

  const result = await buildGroupPnl(group);
  res.json({
    groupId: group.id,
    groupName: group.name,
    count: result.count,
    ok: result.ok,
    failed: result.failed,
    results: result.results,
  });
});

export default router;
