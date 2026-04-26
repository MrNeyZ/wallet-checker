import { Router } from "express";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { scanWalletForCleanup } from "../lib/scanner.js";
import { buildCloseEmptyAccountsTx } from "../lib/txBuilder.js";
import {
  fetchWalletPnl,
  MissingApiKeyError,
  ProviderError,
} from "../services/pnl/solanaTrackerProvider.js";
import { fetchWalletTrades } from "../services/trades/solanaTrackerTrades.js";

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const BURN_WARNING =
  "Burn is destructive and irreversible. Burn transactions are NOT implemented yet — this endpoint only lists candidates.";

const router = Router();

const addressParam = z.string().refine(
  (val) => {
    try {
      new PublicKey(val);
      return true;
    } catch {
      return false;
    }
  },
  { message: "Invalid Solana address" },
);

router.get("/:address/cleanup-scan", async (req, res) => {
  const parsed = addressParam.safeParse(req.params.address);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  try {
    const result = await scanWalletForCleanup(parsed.data);
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

router.get("/:address/burn-candidates", async (req, res) => {
  const parsed = addressParam.safeParse(req.params.address);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  try {
    const scan = await scanWalletForCleanup(parsed.data);
    const candidates = scan.fungibleTokenAccounts
      .filter((acc) => acc.mint !== WSOL_MINT)
      .map((acc) => ({
        tokenAccount: acc.tokenAccount,
        mint: acc.mint,
        owner: acc.owner,
        amount: acc.amount,
        uiAmount: Number(acc.amount) / 10 ** acc.decimals,
        decimals: acc.decimals,
        lamports: acc.lamports,
        programId: acc.programId,
        estimatedReclaimSolAfterBurnAndClose: acc.lamports / LAMPORTS_PER_SOL,
        symbol: null,
        name: null,
        riskLevel: "unknown" as const,
        burnRecommended: false,
        reason: "Manual review required before destructive burn.",
      }));

    res.json({
      wallet: parsed.data,
      count: candidates.length,
      totalEstimatedReclaimSol: candidates.reduce(
        (sum, c) => sum + c.estimatedReclaimSolAfterBurnAndClose,
        0,
      ),
      candidates,
      warning: BURN_WARNING,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

const tradesQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

router.get("/:address/trades", async (req, res) => {
  const addr = addressParam.safeParse(req.params.address);
  if (!addr.success) {
    return res.status(400).json({ error: addr.error.issues[0].message });
  }
  const query = tradesQuerySchema.safeParse(req.query);
  if (!query.success) {
    return res.status(400).json({ error: query.error.issues[0].message });
  }

  try {
    const result = await fetchWalletTrades(addr.data, {
      cursor: query.data.cursor,
      limit: query.data.limit,
    });
    res.json(result);
  } catch (err) {
    if (err instanceof MissingApiKeyError) {
      return res.status(503).json({ error: err.message });
    }
    if (err instanceof ProviderError) {
      return res.status(502).json({ error: err.message, providerStatus: err.status });
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

router.get("/:address/pnl", async (req, res) => {
  const parsed = addressParam.safeParse(req.params.address);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  try {
    const result = await fetchWalletPnl(parsed.data);
    res.json(result);
  } catch (err) {
    if (err instanceof MissingApiKeyError) {
      return res.status(503).json({ error: err.message });
    }
    if (err instanceof ProviderError) {
      const status = err.status && err.status >= 400 && err.status < 600 ? 502 : 502;
      return res.status(status).json({ error: err.message, providerStatus: err.status });
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

router.post("/:address/close-empty-tx", async (req, res) => {
  const parsed = addressParam.safeParse(req.params.address);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  try {
    const result = await buildCloseEmptyAccountsTx(parsed.data);
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

export default router;
