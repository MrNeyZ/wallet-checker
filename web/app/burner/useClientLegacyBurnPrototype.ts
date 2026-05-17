"use client";

// Experimental client-built Legacy NFT burn prototype (Phase B, scope-A).
//
// Goal: validate the hypothesis that Phantom/Blowfish renders the burn
// preview differently when the dApp constructs the transaction in the
// browser vs. handing Phantom a serialized base64 string from the
// backend. The bytes SHOULD be identical for identical accounts, but
// the deploy of Phase 1 bulk burner surfaced a Phantom "0 changes /
// fee only" display, and the user wants to test whether a fully-client
// -built path bypasses that.
//
// Strict scope:
//   - Legacy NFT ONLY. pNFT / Core / SPL / closeEmpty untouched.
//   - Exactly 1 NFT per run (we'll lift to 2-3 only if the 1-NFT case
//     proves out in the browser).
//   - Discovery still uses the existing backend endpoint
//     `POST /api/wallet/:addr/legacy-nft-burn-tx` (no `mints`) to get
//     `burnableCandidates[]` — that response carries the pre-derived
//     metadata + masterEdition PDAs + verified-collection MINT we need.
//     The endpoint's `transactionBase64` is IGNORED here; we build our
//     own Transaction locally and never decode the backend's bytes.
//   - No backend changes.
//
// This hook is INDEPENDENT of useBulkBurnSession. It does not share
// state, does not consume the BurnSelectionRegistry, does not affect
// the existing bulk path. The UI wires it via a separate experimental
// button rendered only when ?proto=1 is in the URL.

import { useCallback, useRef, useState } from "react";
import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import { api, type BurnableLegacyCandidate } from "@/lib/api";
import { getConnection } from "@/lib/solana";
import { getProvider } from "@/lib/wallet";
import { buildLegacyBurnIx } from "@/lib/legacyBurnIx";

// Mirrors backend's CU_PER_NFT_BURN at txBuilder.ts:611. Slightly
// generous on top of N=1 — the on-chain burn typically consumes
// ~40k CU; we book 50k + a 5k headroom so the priority-fee
// calculation lines up if the operator ever bumps CLEANER_PRIORITY_FEE.
const CU_PER_NFT_BURN = 50_000;
const CU_HEADROOM = 5_000;

// Confirmation poll (same shape as useBulkBurnSession).
const CONFIRM_POLL_INTERVAL_MS = 1500;
const CONFIRM_POLL_MAX_ATTEMPTS = 40; // ~60s

export type ClientLegacyBurnStatus =
  | "idle"
  | "discovering"
  | "building"
  | "simulating"
  | "ready"
  | "signing"
  | "submitting"
  | "confirming"
  | "confirmed"
  | "failed";

export interface ClientLegacyBurnState {
  status: ClientLegacyBurnStatus;
  step: string;
  // Mint targeted by this run; null until user starts.
  targetMint: string | null;
  // Mint's display name, surfaced for the experimental dialog.
  targetName: string | null;
  signature: string | null;
  // Set on the failure terminal; passed through verbatim.
  error: string | null;
  // Number of BurnV1 instructions in the locally-built tx (always 1
  // in the prototype). Surfaced so the dialog can prove the tx isn't
  // empty.
  builtIxCount: number | null;
  // Latest blockhash captured at build time. Surfaced for the dialog
  // so the user can verify a fresh blockhash was used.
  blockhash: string | null;
}

const INITIAL_STATE: ClientLegacyBurnState = {
  status: "idle",
  step: "",
  targetMint: null,
  targetName: null,
  signature: null,
  error: null,
  builtIxCount: null,
  blockhash: null,
};

export interface UseClientLegacyBurnOpts {
  // Connected wallet pubkey (live; the hook re-reads through a ref
  // before every wallet-sensitive checkpoint).
  connectedWallet: string | null;
  // Mint of the single legacy NFT the user has selected. The hook
  // re-fetches discovery to locate this mint in burnableCandidates
  // and refuses to proceed if it's not actually burnable per the
  // backend's confirm pass.
  targetMint: string | null;
}

export function useClientLegacyBurnPrototype(
  opts: UseClientLegacyBurnOpts,
): {
  state: ClientLegacyBurnState;
  start: () => Promise<void>;
  reset: () => void;
} {
  const [state, setState] = useState<ClientLegacyBurnState>(INITIAL_STATE);
  const runningRef = useRef(false);
  // Live mirror of the connected wallet — same pattern as
  // useBulkBurnSession's Fix 1 (avoid stale closure capture).
  const connectedRef = useRef<string | null>(opts.connectedWallet);
  connectedRef.current = opts.connectedWallet;

  const reset = useCallback(() => {
    if (runningRef.current) return;
    setState(INITIAL_STATE);
  }, []);

  const start = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;

    const wallet = opts.connectedWallet;
    const mint = opts.targetMint;
    if (!wallet || !mint) {
      setState({
        ...INITIAL_STATE,
        status: "failed",
        step: "validate",
        error: !wallet ? "No wallet connected" : "No mint selected",
      });
      runningRef.current = false;
      return;
    }

    setState({
      ...INITIAL_STATE,
      status: "discovering",
      step: "Fetching burn candidate from backend…",
      targetMint: mint,
    });

    // ── DISCOVERY ─────────────────────────────────────────────────
    // Existing backend endpoint — we use ONLY the burnableCandidates
    // list; the response's transactionBase64 is intentionally ignored.
    let candidate: BurnableLegacyCandidate | null = null;
    try {
      const r = await api.buildLegacyNftBurnTx(wallet, []);
      const found = (r.burnableCandidates ?? []).find((c) => c.mint === mint);
      if (!found) {
        setState((prev) => ({
          ...prev,
          status: "failed",
          step: "discover",
          error: `Mint ${mint.slice(0, 6)}…${mint.slice(-4)} is not in backend's burnable list. Rescan and try again.`,
        }));
        runningRef.current = false;
        return;
      }
      candidate = found;
    } catch (err) {
      setState((prev) => ({
        ...prev,
        status: "failed",
        step: "discover",
        error: err instanceof Error ? err.message : "Discovery failed",
      }));
      runningRef.current = false;
      return;
    }

    setState((prev) => ({
      ...prev,
      targetName: candidate?.name ?? null,
    }));

    // Live wallet re-check before building. The user could disconnect
    // / switch accounts during the discovery roundtrip.
    if (connectedRef.current !== wallet) {
      setState((prev) => ({
        ...prev,
        status: "failed",
        step: "validate",
        error: "Wallet changed during discovery — start over",
      }));
      runningRef.current = false;
      return;
    }

    // ── BUILD ──────────────────────────────────────────────────────
    setState((prev) => ({ ...prev, status: "building", step: "Building BurnV1 ix locally…" }));
    const conn = getConnection();
    const owner = new PublicKey(wallet);

    let blockhash: string;
    let lastValidBlockHeight: number;
    try {
      const got = await conn.getLatestBlockhash();
      blockhash = got.blockhash;
      lastValidBlockHeight = got.lastValidBlockHeight;
    } catch (err) {
      setState((prev) => ({
        ...prev,
        status: "failed",
        step: "build",
        error: `getLatestBlockhash failed: ${err instanceof Error ? err.message : String(err)}`,
      }));
      runningRef.current = false;
      return;
    }

    const tx = new Transaction();
    // ComputeBudget ix matches the backend pattern. No priority-fee ix
    // here — prototype keeps the wire as small as possible.
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: CU_PER_NFT_BURN + CU_HEADROOM }));
    tx.add(
      buildLegacyBurnIx(owner, {
        mint: candidate.mint,
        tokenAccount: candidate.tokenAccount,
        metadata: candidate.metadata,
        masterEdition: candidate.masterEdition,
        collection: candidate.collection,
      }),
    );
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.feePayer = owner;

    setState((prev) => ({
      ...prev,
      builtIxCount: tx.instructions.length,
      blockhash,
    }));

    // ── SIMULATE (sanity gate) ────────────────────────────────────
    setState((prev) => ({ ...prev, status: "simulating", step: "Simulating locally before signing…" }));
    try {
      const sim = await conn.simulateTransaction(tx, undefined, [owner]);
      if (sim.value.err) {
        setState((prev) => ({
          ...prev,
          status: "failed",
          step: "simulate",
          error: `Local simulate rejected: ${JSON.stringify(sim.value.err)}`,
        }));
        runningRef.current = false;
        return;
      }
    } catch (err) {
      setState((prev) => ({
        ...prev,
        status: "failed",
        step: "simulate",
        error: `simulateTransaction failed: ${err instanceof Error ? err.message : String(err)}`,
      }));
      runningRef.current = false;
      return;
    }

    setState((prev) => ({ ...prev, status: "ready", step: "Simulation passed — ready to sign" }));

    // ── SIGN ─────────────────────────────────────────────────────
    // Live wallet check before opening Phantom popup.
    if (connectedRef.current !== wallet) {
      setState((prev) => ({
        ...prev,
        status: "failed",
        step: "sign",
        error: "Wallet changed before signing",
      }));
      runningRef.current = false;
      return;
    }
    const provider = getProvider();
    if (!provider) {
      setState((prev) => ({
        ...prev,
        status: "failed",
        step: "sign",
        error: "No wallet provider available",
      }));
      runningRef.current = false;
      return;
    }

    setState((prev) => ({ ...prev, status: "signing", step: "Awaiting wallet signature…" }));
    let signedTx: Transaction;
    try {
      signedTx = await provider.signTransaction(tx);
    } catch (err) {
      setState((prev) => ({
        ...prev,
        status: "failed",
        step: "sign",
        error: err instanceof Error ? err.message : "Sign failed",
      }));
      runningRef.current = false;
      return;
    }

    // ── SUBMIT ────────────────────────────────────────────────────
    setState((prev) => ({ ...prev, status: "submitting", step: "Broadcasting…" }));
    let signature: string;
    try {
      signature = await conn.sendRawTransaction(signedTx.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
        maxRetries: 3,
      });
      setState((prev) => ({ ...prev, signature }));
    } catch (err) {
      setState((prev) => ({
        ...prev,
        status: "failed",
        step: "submit",
        error: err instanceof Error ? err.message : "Submit failed",
      }));
      runningRef.current = false;
      return;
    }

    // ── CONFIRM ──────────────────────────────────────────────────
    setState((prev) => ({ ...prev, status: "confirming", step: "Confirming on chain…" }));
    let confirmed = false;
    for (let i = 0; i < CONFIRM_POLL_MAX_ATTEMPTS; i++) {
      try {
        const status = await conn.getSignatureStatus(signature, {
          searchTransactionHistory: false,
        });
        const s = status?.value;
        if (s) {
          if (s.err) {
            setState((prev) => ({
              ...prev,
              status: "failed",
              step: "confirm",
              error: `On-chain error: ${JSON.stringify(s.err)}`,
            }));
            runningRef.current = false;
            return;
          }
          if (
            s.confirmationStatus === "confirmed" ||
            s.confirmationStatus === "finalized"
          ) {
            confirmed = true;
            break;
          }
        }
      } catch {
        // transient RPC error — keep polling
      }
      await new Promise<void>((res) => setTimeout(res, CONFIRM_POLL_INTERVAL_MS));
    }
    if (!confirmed) {
      setState((prev) => ({
        ...prev,
        status: "failed",
        step: "confirm",
        error: "Confirmation timeout (60s)",
      }));
      runningRef.current = false;
      return;
    }

    setState((prev) => ({ ...prev, status: "confirmed", step: "Burned and confirmed" }));
    runningRef.current = false;
  }, [opts.connectedWallet, opts.targetMint]);

  return { state, start, reset };
}
