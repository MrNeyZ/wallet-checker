import { Router } from "express";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import {
  fetchWalletPnl,
  MissingApiKeyError,
  ProviderError,
} from "../services/pnl/solanaTrackerProvider.js";
import { runWithConcurrency } from "../lib/concurrency.js";

const router = Router();

const MAX_WALLETS = 50;
const CONCURRENCY = 5;

const isPublicKey = (val: string) => {
  try {
    new PublicKey(val);
    return true;
  } catch {
    return false;
  }
};

const batchSchema = z.object({
  wallets: z
    .array(z.string().refine(isPublicKey, { message: "Invalid Solana address" }))
    .min(1)
    .max(MAX_WALLETS),
});

interface BatchItemResult {
  wallet: string;
  ok: boolean;
  data?: unknown;
  summary?: unknown;
  error?: string;
  cacheHit?: boolean;
  cacheTtlSeconds?: number;
}

router.post("/pnl", async (req, res) => {
  const parsed = batchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const wallets = parsed.data.wallets;

  const results = await runWithConcurrency<string, BatchItemResult>(
    wallets,
    CONCURRENCY,
    async (wallet) => {
      try {
        const result = await fetchWalletPnl(wallet);
        return {
          wallet,
          ok: true,
          data: result.data,
          summary: result.summary,
          cacheHit: result.cacheHit,
          cacheTtlSeconds: result.cacheTtlSeconds,
        };
      } catch (err) {
        let message: string;
        if (err instanceof MissingApiKeyError) message = err.message;
        else if (err instanceof ProviderError) message = err.message;
        else message = err instanceof Error ? err.message : "Unknown error";
        return { wallet, ok: false, error: message };
      }
    },
  );

  const okCount = results.filter((r) => r.ok).length;
  res.json({
    provider: "solanatracker",
    count: results.length,
    ok: okCount,
    failed: results.length - okCount,
    results,
  });
});

export default router;
