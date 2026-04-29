import { Router } from "express";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { scanWalletForCleanup } from "../lib/scanner.js";
import {
  buildBurnAndCloseTx,
  buildCloseEmptyAccountsTx,
  buildCoreBurnTx,
  buildLegacyNftBurnTx,
  buildPnftBurnTx,
  buildStandardNftBurnTx,
} from "../lib/txBuilder.js";
import { RpcRateLimitError } from "../lib/rpc.js";
import {
  fetchWalletPnl,
  MissingApiKeyError,
  ProviderError,
} from "../services/pnl/solanaTrackerProvider.js";
import { fetchWalletTrades } from "../services/trades/solanaTrackerTrades.js";
import { fetchAssetMetadataBatch } from "../services/helius/das.js";

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const BURN_WARNING =
  "Burn is destructive and irreversible. Review every line of the preview, then explicitly sign to confirm.";

const router = Router();

// Translate any error from the cleaner pipeline into a sanitized HTTP
// response. Rate-limit errors get 429 with the clean user-facing message;
// everything else is treated as a server fault. Raw JSON-RPC bodies and stack
// traces are never sent to the client.
function sendCleanerError(res: import("express").Response, err: unknown): void {
  if (err instanceof RpcRateLimitError) {
    res.status(429).json({ error: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : "Unknown error";
  res.status(500).json({ error: message });
}

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
  // ?refresh=true bypasses the 30 s scan cache. Used by the full-clean loop
  // immediately after a close-tx is confirmed, so the next iteration sees
  // fresh on-chain state without waiting for the TTL to expire. Any other
  // truthy string ("1", "yes") is also accepted; anything else falls through
  // to the cached path.
  const refresh =
    typeof req.query.refresh === "string" &&
    /^(true|1|yes)$/i.test(req.query.refresh);

  try {
    const result = await scanWalletForCleanup(parsed.data, { refresh });
    res.json(result);
  } catch (err) {
    sendCleanerError(res, err);
  }
});

router.get("/:address/burn-candidates", async (req, res) => {
  const parsed = addressParam.safeParse(req.params.address);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  try {
    const scan = await scanWalletForCleanup(parsed.data);
    const baseCandidates = scan.fungibleTokenAccounts
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
        symbol: null as string | null,
        name: null as string | null,
        image: null as string | null,
        riskLevel: "unknown" as const,
        burnRecommended: false,
        reason: "Manual review required before destructive burn.",
      }));

    // Enrich with token metadata via Helius DAS — same call path the NFT
    // burn flows use. DAS supports SPL fungible tokens (interface
    // "FungibleToken" / "FungibleAsset") and returns the same content
    // shape we already extract: name, symbol, image. Cached in-process
    // for 10 minutes; fails open (returns empty map) if HELIUS_API_KEY
    // is missing, so candidates degrade gracefully to the existing
    // shortAddr-only display the frontend now uses as fallback.
    const dasMap = await fetchAssetMetadataBatch(
      baseCandidates.map((c) => c.mint),
    );
    const candidates = baseCandidates.map((c) => {
      const m = dasMap.get(c.mint);
      if (!m) return c;
      return {
        ...c,
        name: c.name ?? m.name,
        symbol: c.symbol ?? m.symbol,
        image: c.image ?? m.image,
      };
    });

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
    sendCleanerError(res, err);
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
    sendCleanerError(res, err);
  }
});

// Body schema for burn-and-close. Optional `mints` allowlist restricts the
// builder to specific token mints; without it every fungible non-WSOL
// account owned by the wallet becomes a candidate (capped server-side).
const burnAndCloseBodySchema = z.object({
  mints: z.array(z.string().min(1)).optional(),
});

router.post("/:address/burn-and-close-tx", async (req, res) => {
  const parsed = addressParam.safeParse(req.params.address);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  const body = burnAndCloseBodySchema.safeParse(req.body ?? {});
  if (!body.success) {
    return res.status(400).json({ error: body.error.issues[0].message });
  }

  try {
    const result = await buildBurnAndCloseTx(parsed.data, body.data);
    res.json(result);
  } catch (err) {
    sendCleanerError(res, err);
  }
});

// Body schema for standard NFT burn. Same shape as fungible burn — optional
// `mints` allowlist filters which NFTs to include.
const standardNftBurnBodySchema = z.object({
  mints: z.array(z.string().min(1)).optional(),
});

router.post("/:address/standard-nft-burn-tx", async (req, res) => {
  const parsed = addressParam.safeParse(req.params.address);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  const body = standardNftBurnBodySchema.safeParse(req.body ?? {});
  if (!body.success) {
    return res.status(400).json({ error: body.error.issues[0].message });
  }

  try {
    const result = await buildStandardNftBurnTx(parsed.data, body.data);
    res.json(result);
  } catch (err) {
    sendCleanerError(res, err);
  }
});

// Milestone 1 — canonical legacy Metaplex NFT burn endpoint (max-reclaim).
// Same body shape as standard-nft-burn-tx but a richer response envelope
// with per-NFT skip reasons and name/symbol enrichment. The older
// standard-nft-burn-tx endpoint above is kept in place to avoid breaking
// any in-flight integrations.
const legacyNftBurnBodySchema = z.object({
  mints: z.array(z.string().min(1)).optional(),
});

router.post("/:address/legacy-nft-burn-tx", async (req, res) => {
  const parsed = addressParam.safeParse(req.params.address);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  const body = legacyNftBurnBodySchema.safeParse(req.body ?? {});
  if (!body.success) {
    return res.status(400).json({ error: body.error.issues[0].message });
  }

  try {
    const result = await buildLegacyNftBurnTx(parsed.data, body.data);
    res.json(result);
  } catch (err) {
    sendCleanerError(res, err);
  }
});

// Milestone 2 — Programmable NFT (pNFT) burn preview. Same body shape as
// legacy-nft-burn-tx; only the underlying builder differs (uses Token
// Record PDA + skips ruleset-governed pNFTs).
const pnftBurnBodySchema = z.object({
  mints: z.array(z.string().min(1)).optional(),
});

router.post("/:address/pnft-burn-tx", async (req, res) => {
  const parsed = addressParam.safeParse(req.params.address);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  const body = pnftBurnBodySchema.safeParse(req.body ?? {});
  if (!body.success) {
    return res.status(400).json({ error: body.error.issues[0].message });
  }

  try {
    const result = await buildPnftBurnTx(parsed.data, body.data);
    res.json(result);
  } catch (err) {
    sendCleanerError(res, err);
  }
});

// Milestone 3 — Metaplex Core asset burn preview. Body shape mirrors the
// other NFT-burn endpoints but uses `assetIds` (Core asset addresses are
// not "mints" — they're standalone account addresses, not SPL token mints).
const coreBurnBodySchema = z.object({
  assetIds: z.array(z.string().min(1)).optional(),
});

router.post("/:address/core-burn-tx", async (req, res) => {
  const parsed = addressParam.safeParse(req.params.address);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  const body = coreBurnBodySchema.safeParse(req.body ?? {});
  if (!body.success) {
    return res.status(400).json({ error: body.error.issues[0].message });
  }

  try {
    const result = await buildCoreBurnTx(parsed.data, body.data);
    res.json(result);
  } catch (err) {
    sendCleanerError(res, err);
  }
});

export default router;
