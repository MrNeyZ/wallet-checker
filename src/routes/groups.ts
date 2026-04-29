import { Router } from "express";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import {
  addWalletToGroup,
  createGroup,
  deleteGroup,
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
import { buildGroupLpPositions } from "../services/groups/groupLp.js";
import { buildGroupAirdrops } from "../services/groups/groupAirdrops.js";
import { evaluateGroupSignals } from "../services/groups/groupSignals.js";
import { scanWalletQueued } from "../services/cleanup/scanQueue.js";
import {
  DEFAULT_INTERVAL_MS as SIGNAL_DEFAULT_INTERVAL_MS,
  MAX_INTERVAL_MS as SIGNAL_MAX_INTERVAL_MS,
  MIN_INTERVAL_MS as SIGNAL_MIN_INTERVAL_MS,
  getPollerStatus as getSignalPollerStatus,
  startPoller as startSignalPoller,
  stopPoller as stopSignalPoller,
} from "../lib/signalPoller.js";
import { env } from "../config/env.js";
import {
  createAlert,
  deleteAlert,
  getAlert,
  listAlertsForGroup,
  updateAlert,
} from "../lib/alertsStore.js";
import {
  evaluateGroupAlerts,
  DEFAULT_ALERT_PER_WALLET_LIMIT,
  MIN_ALERT_PER_WALLET_LIMIT,
  MAX_ALERT_PER_WALLET_LIMIT,
} from "../services/groups/alertEvaluator.js";
import {
  startPoller,
  stopPoller,
  getPollerStatus,
  DEFAULT_INTERVAL_MS,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
} from "../lib/alertPoller.js";

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

// Hard delete. Group is removed from the in-memory map and persisted
// (atomic write). Per-group runtime state (signal/alert pollers, caches)
// keyed by the deleted id will simply have no targets after this — the
// pollers self-noop without a matching group.
router.delete("/:groupId", (req, res) => {
  const result = deleteGroup(req.params.groupId);
  if (result === "not_found") {
    return res.status(404).json({ ok: false, error: "Group not found" });
  }
  res.json({ ok: true });
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

router.get("/:groupId/airdrops", async (req, res) => {
  const group = getGroup(req.params.groupId);
  if (!group) return res.status(404).json({ error: "Group not found" });
  if (!env.DROPS_BOT_API_KEY) {
    return res.status(503).json({ error: "DROPS_BOT_API_KEY is not configured" });
  }

  const result = await buildGroupAirdrops(group);
  res.json({
    groupId: group.id,
    groupName: group.name,
    walletsCount: group.wallets.length,
    totalAirdropsCount: result.totalAirdropsCount,
    totalValueUsd: result.totalValueUsd,
    unknownValueWallets: result.unknownValueWallets,
    wallets: result.wallets,
    failedWallets: result.failedWallets,
  });
});

router.get("/:groupId/lp-positions", async (req, res) => {
  const group = getGroup(req.params.groupId);
  if (!group) return res.status(404).json({ error: "Group not found" });

  const lp = await buildGroupLpPositions(group);
  res.json({
    groupId: group.id,
    groupName: group.name,
    walletsCount: group.wallets.length,
    totalPositions: lp.totalPositions,
    totalValueUsd: lp.totalValueUsd,
    totalUnclaimedFeesUsd: lp.totalUnclaimedFeesUsd,
    positions: lp.positions,
    failedWallets: lp.failedWallets,
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
    filteredTokensCount: summary.filteredTokensCount,
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

const createAlertSchema = z.object({
  name: z.string().trim().min(1).max(100),
  minUsd: z.coerce.number().nonnegative(),
  token: z.string().trim().min(1).optional(),
  side: z.enum(["buy", "sell"]).optional(),
  program: z.string().trim().min(1).optional(),
  enabled: z.boolean().optional(),
});

const patchAlertSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    minUsd: z.coerce.number().nonnegative().optional(),
    token: z.string().trim().min(1).optional(),
    side: z.enum(["buy", "sell"]).optional(),
    program: z.string().trim().min(1).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Empty patch body" });

const evaluateBodySchema = z.object({
  perWalletLimit: z
    .coerce.number()
    .int()
    .min(MIN_ALERT_PER_WALLET_LIMIT)
    .max(MAX_ALERT_PER_WALLET_LIMIT)
    .optional(),
});

router.post("/:groupId/alerts/evaluate", async (req, res) => {
  const group = getGroup(req.params.groupId);
  if (!group) return res.status(404).json({ error: "Group not found" });

  const parsed = evaluateBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  const perWalletLimit = parsed.data.perWalletLimit ?? DEFAULT_ALERT_PER_WALLET_LIMIT;

  const result = await evaluateGroupAlerts(group, perWalletLimit);
  res.json({ groupId: group.id, ...result });
});

const startPollerSchema = z.object({
  intervalMs: z.coerce.number().int().min(MIN_INTERVAL_MS).max(MAX_INTERVAL_MS).optional(),
});

router.post("/:groupId/alerts/start", (req, res) => {
  const group = getGroup(req.params.groupId);
  if (!group) return res.status(404).json({ error: "Group not found" });
  const parsed = startPollerSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  const intervalMs = parsed.data.intervalMs ?? DEFAULT_INTERVAL_MS;
  const groupId = group.id;
  const result = startPoller(groupId, intervalMs, async () => {
    const g = getGroup(groupId);
    if (!g) return;
    await evaluateGroupAlerts(g);
  });
  res.json({
    groupId,
    running: true,
    intervalMs: result.intervalMs,
    started: result.started,
  });
});

router.post("/:groupId/alerts/stop", (req, res) => {
  const group = getGroup(req.params.groupId);
  if (!group) return res.status(404).json({ error: "Group not found" });
  const stopped = stopPoller(group.id);
  res.json({ groupId: group.id, running: false, stopped });
});

router.get("/:groupId/alerts/status", (req, res) => {
  const group = getGroup(req.params.groupId);
  if (!group) return res.status(404).json({ error: "Group not found" });
  const status = getPollerStatus(group.id);
  res.json({ groupId: group.id, ...status });
});

router.post("/:groupId/alerts", (req, res) => {
  const group = getGroup(req.params.groupId);
  if (!group) return res.status(404).json({ error: "Group not found" });
  const parsed = createAlertSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  const rule = createAlert({ groupId: group.id, ...parsed.data });
  res.status(201).json(rule);
});

router.get("/:groupId/alerts", (req, res) => {
  const group = getGroup(req.params.groupId);
  if (!group) return res.status(404).json({ error: "Group not found" });
  res.json({ groupId: group.id, alerts: listAlertsForGroup(group.id) });
});

router.patch("/:groupId/alerts/:alertId", (req, res) => {
  const group = getGroup(req.params.groupId);
  if (!group) return res.status(404).json({ error: "Group not found" });
  const existing = getAlert(req.params.alertId);
  if (!existing || existing.groupId !== group.id) {
    return res.status(404).json({ error: "Alert not found" });
  }
  const parsed = patchAlertSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  const updated = updateAlert(existing.id, parsed.data);
  res.json(updated);
});

router.delete("/:groupId/alerts/:alertId", (req, res) => {
  const group = getGroup(req.params.groupId);
  if (!group) return res.status(404).json({ error: "Group not found" });
  const existing = getAlert(req.params.alertId);
  if (!existing || existing.groupId !== group.id) {
    return res.status(404).json({ error: "Alert not found" });
  }
  deleteAlert(existing.id);
  res.status(204).send();
});

// Manual one-shot signal evaluation. Computes smart/accumulation/strong/
// dump/multi-dump signals on demand using the cached overview + trades.
// No Telegram, no polling, no dedup persistence — those land in subsequent
// tasks. Settings fixed at DEFAULT_SIGNAL_SETTINGS for now.
router.post("/:groupId/signals/evaluate", async (req, res) => {
  const group = getGroup(req.params.groupId);
  if (!group) return res.status(404).json({ error: "Group not found" });
  try {
    const result = await evaluateGroupSignals(group);
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

// Body schema for signals/start. Bounds reflect the signal poller's tighter
// floor (60s) — trade cache TTL is 60s so faster polling would just thrash
// the cache.
const startSignalPollerSchema = z.object({
  intervalMs: z.coerce
    .number()
    .int()
    .min(SIGNAL_MIN_INTERVAL_MS)
    .max(SIGNAL_MAX_INTERVAL_MS)
    .optional(),
});

router.post("/:groupId/signals/start", (req, res) => {
  const group = getGroup(req.params.groupId);
  if (!group) return res.status(404).json({ error: "Group not found" });
  const parsed = startSignalPollerSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  const intervalMs = parsed.data.intervalMs ?? SIGNAL_DEFAULT_INTERVAL_MS;
  const groupId = group.id;
  // The tick re-resolves the group from the store on every fire so wallet
  // changes (add/remove) are picked up without restarting the poller.
  const result = startSignalPoller(groupId, intervalMs, async () => {
    const g = getGroup(groupId);
    if (!g) return;
    await evaluateGroupSignals(g);
  });
  res.json({
    groupId,
    running: true,
    intervalMs: result.intervalMs,
    started: result.started,
  });
});

router.post("/:groupId/signals/stop", (req, res) => {
  const group = getGroup(req.params.groupId);
  if (!group) return res.status(404).json({ error: "Group not found" });
  const stopped = stopSignalPoller(group.id);
  res.json({ groupId: group.id, running: false, stopped });
});

router.get("/:groupId/signals/status", (req, res) => {
  const group = getGroup(req.params.groupId);
  if (!group) return res.status(404).json({ error: "Group not found" });
  const status = getSignalPollerStatus(group.id);
  res.json({ groupId: group.id, ...status });
});

// Batch cleanup-scan for every wallet in a group. Replaces the prior
// frontend-driven worker pool, which was unreliable for groups with 5+
// large wallets (per-wallet RPC retries stacking up, no shared cache,
// blocked by network jitter). Server-side processing gets us:
//   - sequential per-wallet processing under one HTTP roundtrip
//   - shared 10-minute scanner cache hits (instant on repeat)
//   - per-wallet 45s wall-clock budget so one slow wallet doesn't block
//     the whole group
//   - 429 retry with backoffs from the spec, capped to fit the budget
// Returns a status per wallet so the UI can display ok/cached/timeout/
// rate-limited/error counts. No streaming — single blocking response.
router.post("/:groupId/cleanup-scan-all", async (req, res) => {
  const group = getGroup(req.params.groupId);
  if (!group) return res.status(404).json({ error: "Group not found" });
  const force = req.body?.force === true;
  const results: Array<
    Awaited<ReturnType<typeof scanWalletQueued>> & { label: string | null }
  > = [];
  // Sequential — concurrency=1 by design. The scanner.ts in-flight
  // dedupe handles concurrent same-wallet requests if any sneak in
  // (e.g. a single-wallet scan kicked off in parallel by the user).
  for (const wlt of group.wallets) {
    const r = await scanWalletQueued(wlt.address, { force });
    results.push({ ...r, label: wlt.label });
  }
  res.json({
    groupId: group.id,
    total: results.length,
    counts: {
      ok: results.filter((r) => r.status === "ok").length,
      cached: results.filter((r) => r.status === "cached").length,
      timeout: results.filter((r) => r.status === "timeout").length,
      rateLimited: results.filter((r) => r.status === "rate-limited").length,
      error: results.filter((r) => r.status === "error").length,
    },
    wallets: results,
  });
});

export default router;
