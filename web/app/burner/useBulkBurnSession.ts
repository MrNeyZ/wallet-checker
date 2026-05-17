"use client";

// Phase 1 Bulk Burner — client-driven windowed bulk burn.
//
// Reduces wallet-popup spam by signing N transactions in one Phantom prompt
// (signAllTransactions) when the wallet supports it; falls back to sequential
// per-tx prompts otherwise. No server-side session, no DB, no key custody.
// Every safety gate from the existing per-category sign block is reproduced
// here: simulationOk, feePayer/wallet match, connected-wallet equality at
// signing time, no submit before successful signature.
//
// Execution order is fixed (closeEmpty → splBurn → legacyNft → core → pnft).
// Within each category the user's selected mints are partitioned into
// batches sized to the backend's per-tx cap. The full work list is built
// into a queue once at click time; we never re-snapshot mid-run, so a
// selection toggle during a bulk run cannot retarget work in flight.

import { useCallback, useRef, useState } from "react";
import { Transaction } from "@solana/web3.js";
import {
  buildBurnAndCloseTxAction,
  buildCloseEmptyTxAction,
  buildCoreBurnTxAction,
  buildLegacyNftBurnTxAction,
  buildPnftBurnTxAction,
} from "../groups/actions";
import { decodeBase64Transaction, getProvider } from "@/lib/wallet";
import { getConnection } from "@/lib/solana";
import type { BulkBurnMintsSnapshot } from "../groups/[id]/cleaner";

// Mirror of backend per-tx caps. Kept in sync by hand — the backend
// constants live in src/lib/txBuilder.ts and are not exported to the wire.
// If a future change tightens any cap, the backend will return a tx with
// fewer items than requested (it does its own slice), so an out-of-sync
// frontend cap here merely produces an extra batch with zero items — wasted
// build call but not a correctness bug.
const MAX_SPL_PER_TX = 5;
// Legacy: backend's effective per-tx cap is 5 in practice (the response
// returns `maxPerTx: 6` but `burnCount` lands at 5 due to packet+CU fit
// after the trim loop). With Phase 1 NOT chaining `nextBatchCandidates`,
// sending more than 5 per spec silently drops the overflow. Match the
// backend's effective cap so the partition produces deterministic
// per-spec counts the user can see in the dialog.
const MAX_LEGACY_PER_TX = 5;
const MAX_CORE_PER_TX = 10;
const MAX_PNFT_PER_TX = 5;

// Window: number of transactions signed in a single Phantom prompt.
// Conservative for Phase 1 — Phantom's signAllTransactions has its own
// upper bound (~10) and we want plenty of headroom for blockhash freshness.
export const DEFAULT_WINDOW_SIZE = 3;

// Confirmation polling — same shape as the existing full-clean loop in
// cleaner.tsx. Per-tx wall-clock cap so a stuck tx can't block the session
// forever; 'confirmed' commitment is enough to move on (the existing code
// uses the same threshold).
const CONFIRM_POLL_INTERVAL_MS = 1500;
const CONFIRM_POLL_MAX_ATTEMPTS = 40; // ≈ 60s

export type BulkBurnCategory =
  | "closeEmpty"
  | "splBurn"
  | "legacyNft"
  | "core"
  | "pnft";

export type BulkBurnStatus =
  | "idle"
  | "running"
  | "done"
  | "cancelled"
  | "failed";

export type BulkBurnStep =
  | "preparing"
  | "building"
  | "signing"
  | "submitting"
  | "confirming"
  | "between-windows";

// A single planned build invocation. One spec → one backend POST → one tx.
type BuildSpec =
  | { kind: "closeEmpty"; planLabel: string }
  | { kind: "splBurn"; mints: string[]; planLabel: string }
  | { kind: "legacyNft"; mints: string[]; planLabel: string }
  | { kind: "core"; assetIds: string[]; planLabel: string }
  | { kind: "pnft"; mints: string[]; planLabel: string };

export interface BulkBurnWindowEntryResult {
  spec: BuildSpec;
  // Final per-spec outcome. Lifecycle:
  //   building → ready (built+gated) → signed → submitted → confirmed
  // or terminal-failures:
  //   build-failed | gate-failed | sign-failed | submit-failed |
  //   confirm-failed | skipped-stale | skipped-cancel
  status:
    | "building"
    | "ready"
    | "signed"
    | "submitted"
    | "confirmed"
    | "build-failed"
    | "gate-failed"
    | "sign-failed"
    | "submit-failed"
    | "confirm-failed"
    | "skipped-stale"
    | "skipped-cancel";
  signature?: string;
  error?: string;
  // Asset-count outcome for the summary. For closeEmpty it's the number
  // of accounts closed; for the others it's the items the BACKEND
  // actually included in the built tx (may be < requested due to per-tx
  // cap or builder-side rejection).
  itemsAffected?: number;
  // Non-error informational note rendered alongside the row in the
  // dialog. Currently used only by closeEmpty when the wallet has more
  // empties than fit in one tx; the user must rescan + re-run bulk
  // burn for the rest (Phase 1 deliberately does not auto-chain).
  note?: string;
}

export interface BulkBurnSessionState {
  status: BulkBurnStatus;
  step: BulkBurnStep | null;
  // Active window index + total windows planned.
  windowIndex: number; // 0-based; -1 when idle
  totalWindows: number;
  // Active-tx pointer inside the current window (0..windowSize-1).
  activeTxInWindow: number;
  // Per-spec rolling state. Order matches the original build queue.
  results: BulkBurnWindowEntryResult[];
  // Snapshot of provider's signAllTransactions capability at start time.
  // Frozen for the duration of the run; if the wallet was swapped to one
  // without it mid-run we'd refuse to sign anyway via the wallet-match
  // gate, so this is purely informational.
  hadSignAll: boolean;
  // One-shot notice surfaced to the UI when signAllTransactions wasn't
  // available at start, so the user sees the fallback was used.
  fellBackToSequential: boolean;
  // Top-level error if the session bailed before completion (e.g. no
  // wallet connected, queue was empty). null for in-progress / clean
  // completions.
  topError: string | null;
}

const INITIAL_STATE: BulkBurnSessionState = {
  status: "idle",
  step: null,
  windowIndex: -1,
  totalWindows: 0,
  activeTxInWindow: 0,
  results: [],
  hadSignAll: false,
  fellBackToSequential: false,
  topError: null,
};

export interface UseBulkBurnSessionOpts {
  // Wallet whose pubkey is the URL path argument for every build call.
  // The connected wallet must equal this throughout the run; we re-check
  // at every gate.
  targetWallet: string | null;
  // Live connected-wallet pubkey from the wallet provider context. Used
  // for the per-tx wallet-match gate before each sign.
  connectedWallet: string | null;
  // Reader for the bulk-burn mint snapshot. Called exactly once at
  // start() time; the snapshot drives the entire queue. Selection
  // changes after start() are ignored — they cannot retarget work
  // already in flight.
  getMintsSnapshot: () => BulkBurnMintsSnapshot;
  // True iff closeEmpty should be included. Read from the rendered
  // BurnSelectionRegistry's closeEmpty entry — we don't add it to the
  // mint snapshot because closeEmpty has no per-item selection model.
  includeCloseEmpty: boolean;
  windowSize?: number;
}

function partition<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) return [items.slice()];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Build the work queue in the locked execution order. closeEmpty is
// included as a single spec (the backend caps at 10 closes/tx; if more
// remain we'd surface it in the summary and ask the user to bulk-burn
// again after rescan — Phase 1 deliberately does NOT chain closeEmpty
// across multiple builds within one session).
function buildQueue(
  snapshot: BulkBurnMintsSnapshot,
  includeCloseEmpty: boolean,
): BuildSpec[] {
  const queue: BuildSpec[] = [];
  if (includeCloseEmpty) {
    queue.push({ kind: "closeEmpty", planLabel: "Close empty accounts" });
  }
  const splMints = snapshot.splBurn ?? [];
  partition(splMints, MAX_SPL_PER_TX).forEach((batch, i, all) => {
    queue.push({
      kind: "splBurn",
      mints: batch,
      planLabel: `SPL burn-close batch ${i + 1}/${all.length}`,
    });
  });
  const legacyMints = snapshot.legacyNft ?? [];
  partition(legacyMints, MAX_LEGACY_PER_TX).forEach((batch, i, all) => {
    queue.push({
      kind: "legacyNft",
      mints: batch,
      planLabel: `Legacy NFT batch ${i + 1}/${all.length}`,
    });
  });
  const coreIds = snapshot.core ?? [];
  partition(coreIds, MAX_CORE_PER_TX).forEach((batch, i, all) => {
    queue.push({
      kind: "core",
      assetIds: batch,
      planLabel: `Core batch ${i + 1}/${all.length}`,
    });
  });
  const pnftMints = snapshot.pnft ?? [];
  partition(pnftMints, MAX_PNFT_PER_TX).forEach((batch, i, all) => {
    queue.push({
      kind: "pnft",
      mints: batch,
      planLabel: `pNFT batch ${i + 1}/${all.length}`,
    });
  });
  return queue;
}

// Common envelope across all backend build endpoints. Each builder's
// concrete response shape is wider; we narrow to the fields the bulk
// session needs and accept `undefined` for fields some builders don't
// emit. Strict — anything missing falls into the gate-failed path.
//
// closeEmpty is the one builder that does NOT preflight-simulate (rent
// reclaim is dead-simple; the existing single-burn UX skips its sim
// gate too). We surface that via `kindSimulates: false` so the post-
// build gate skips the simulationOk check for it. All other builders
// MUST sim and return simulationOk=true to pass the gate.
interface NarrowBuild {
  transactionBase64: string | null;
  // null when the builder doesn't simulate (closeEmpty); boolean
  // otherwise. The gate's strict check requires `=== true`.
  simulationOk: boolean | null;
  simulationError?: string;
  kindSimulates: boolean;
  blockhash: string | null;
  lastValidBlockHeight: number | null;
  feePayer: string;
  requiresSignatureFrom?: string;
  itemsAffected: number;
  // closeEmpty-only — the backend caps closes at 10 per tx. If the
  // wallet has more than 10 empties, this is the count NOT included in
  // the just-built tx. Phase 1 does not auto-chain another closeEmpty
  // build; we just surface a note to the user in the summary so they
  // know to rescan + re-run bulk burn for the remainder. Zero / absent
  // for all other builders.
  closeEmptySkipped?: number;
}

async function buildOne(
  spec: BuildSpec,
  wallet: string,
): Promise<{ ok: true; built: NarrowBuild } | { ok: false; error: string }> {
  try {
    if (spec.kind === "closeEmpty") {
      const r = await buildCloseEmptyTxAction(wallet);
      if (!r.ok) return { ok: false, error: r.error };
      return {
        ok: true,
        built: {
          transactionBase64: r.result.transactionBase64,
          // close-empty doesn't preflight-simulate (the existing single
          // -burn UX doesn't gate on sim for this kind either).
          simulationOk: null,
          simulationError: undefined,
          kindSimulates: false,
          // close-empty response carries no blockhash metadata — the
          // tx itself has a blockhash baked in by the backend; we just
          // can't surface a staleness window from this result. Matches
          // the existing flow.
          blockhash: null,
          lastValidBlockHeight: null,
          feePayer: r.result.feePayer,
          requiresSignatureFrom: r.result.requiresSignatureFrom,
          itemsAffected: r.result.includedAccounts.length,
          // skippedAccounts = totalEmpty - includedAccounts.length on
          // the backend side. Surfaced to the dialog so a user with
          // 25 empties doesn't see "10 confirmed" and assume the rest
          // were cleaned too.
          closeEmptySkipped: r.result.skippedAccounts,
        },
      };
    }
    if (spec.kind === "splBurn") {
      const r = await buildBurnAndCloseTxAction(wallet, spec.mints);
      if (!r.ok) return { ok: false, error: r.error };
      return {
        ok: true,
        built: {
          transactionBase64: r.result.transactionBase64,
          simulationOk: r.result.simulationOk,
          simulationError: r.result.simulationError,
          kindSimulates: true,
          blockhash: r.result.blockhash,
          lastValidBlockHeight: r.result.lastValidBlockHeight,
          feePayer: r.result.feePayer,
          requiresSignatureFrom: r.result.requiresSignatureFrom,
          itemsAffected: r.result.burnCount,
        },
      };
    }
    if (spec.kind === "legacyNft") {
      const r = await buildLegacyNftBurnTxAction(wallet, spec.mints);
      if (!r.ok) return { ok: false, error: r.error };
      return {
        ok: true,
        built: {
          transactionBase64: r.result.transactionBase64,
          simulationOk: r.result.simulationOk,
          simulationError: r.result.simulationError,
          kindSimulates: true,
          blockhash: r.result.blockhash,
          lastValidBlockHeight: r.result.lastValidBlockHeight,
          feePayer: r.result.feePayer,
          requiresSignatureFrom: r.result.requiresSignatureFrom,
          itemsAffected: r.result.burnCount,
        },
      };
    }
    if (spec.kind === "pnft") {
      const r = await buildPnftBurnTxAction(wallet, spec.mints);
      if (!r.ok) return { ok: false, error: r.error };
      return {
        ok: true,
        built: {
          transactionBase64: r.result.transactionBase64,
          simulationOk: r.result.simulationOk,
          simulationError: r.result.simulationError,
          kindSimulates: true,
          blockhash: r.result.blockhash,
          lastValidBlockHeight: r.result.lastValidBlockHeight,
          feePayer: r.result.feePayer,
          requiresSignatureFrom: r.result.requiresSignatureFrom,
          itemsAffected: r.result.burnCount,
        },
      };
    }
    // core
    const r = await buildCoreBurnTxAction(wallet, spec.assetIds);
    if (!r.ok) return { ok: false, error: r.error };
    return {
      ok: true,
      built: {
        transactionBase64: r.result.transactionBase64,
        simulationOk: r.result.simulationOk,
        simulationError: r.result.simulationError,
        kindSimulates: true,
        blockhash: r.result.blockhash,
        lastValidBlockHeight: r.result.lastValidBlockHeight,
        feePayer: r.result.feePayer,
        requiresSignatureFrom: r.result.requiresSignatureFrom,
        itemsAffected: r.result.burnCount,
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Build failed" };
  }
}

// Post-build gate. Returns either "ready" with the decoded Transaction or
// a typed reason for skipping the spec. Strict — every gate must pass.
function gateBuilt(
  built: NarrowBuild,
  wallet: string,
  connected: string | null,
): { ok: true; tx: Transaction } | { ok: false; reason: string } {
  if (!built.transactionBase64) {
    return {
      ok: false,
      reason:
        built.simulationError ??
        "Backend returned no transaction (nothing to burn in this batch).",
    };
  }
  // closeEmpty doesn't simulate — `kindSimulates: false` short-circuits
  // this check. Every other builder MUST return simulationOk=true.
  if (built.kindSimulates && built.simulationOk !== true) {
    return {
      ok: false,
      reason: `Preflight rejected: ${built.simulationError ?? "simulation did not pass"}`,
    };
  }
  if (built.feePayer !== wallet) {
    return {
      ok: false,
      reason: `feePayer (${built.feePayer.slice(0, 6)}…) does not match target wallet`,
    };
  }
  if (built.requiresSignatureFrom && built.requiresSignatureFrom !== wallet) {
    return {
      ok: false,
      reason: "requiresSignatureFrom does not match target wallet",
    };
  }
  if (!connected || connected !== wallet) {
    return {
      ok: false,
      reason: connected
        ? "Connected wallet changed during bulk run"
        : "Wallet disconnected during bulk run",
    };
  }
  let tx: Transaction;
  try {
    tx = decodeBase64Transaction(built.transactionBase64);
  } catch (err) {
    return {
      ok: false,
      reason: `Decode failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // Belt-and-braces — the backend's assertBuiltTxMatchesWallet already
  // verified this, but re-checking client-side catches any in-transit
  // tampering.
  if (tx.feePayer?.toBase58() !== wallet) {
    return { ok: false, reason: "Decoded tx feePayer does not match target wallet" };
  }
  return { ok: true, tx };
}

// Poll signature confirmation. Uses the same RPC connection that
// sendRawTransaction used; bounded by CONFIRM_POLL_MAX_ATTEMPTS so a
// stuck tx never blocks the session forever.
//
// Deliberately does NOT honor the session-level cancel signal. Once a
// tx has been submitted, the chain owns its lifecycle — we just stop
// waiting if we want to give up, but marking already-submitted txs as
// "cancelled" is misleading (the tx will still confirm on-chain). Per
// spec: cancel stops new builds / new signs / new submits; it lets
// already-submitted confirmations drain naturally.
async function confirmSignature(
  signature: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const conn = getConnection();
  for (let i = 0; i < CONFIRM_POLL_MAX_ATTEMPTS; i++) {
    try {
      const status = await conn.getSignatureStatus(signature, {
        searchTransactionHistory: false,
      });
      const s = status?.value;
      if (s) {
        if (s.err) return { ok: false, reason: `On-chain error: ${JSON.stringify(s.err)}` };
        if (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized") {
          return { ok: true };
        }
      }
    } catch {
      // transient RPC error — keep polling until budget exhausted
    }
    await new Promise<void>((res) => setTimeout(res, CONFIRM_POLL_INTERVAL_MS));
  }
  return { ok: false, reason: "Confirmation timeout (60s)" };
}

export function useBulkBurnSession(opts: UseBulkBurnSessionOpts): {
  state: BulkBurnSessionState;
  start: () => Promise<void>;
  cancel: () => void;
  reset: () => void;
} {
  const [state, setState] = useState<BulkBurnSessionState>(INITIAL_STATE);
  // Mutable mid-run state held outside React so per-tx updates don't
  // chain through useState's queueing.
  const cancelRef = useRef<{ cancelled: boolean }>({ cancelled: false });
  const runningRef = useRef(false);
  // Live mirror of opts.connectedWallet. The start() callback closes
  // over `opts` at invocation time; without this ref every subsequent
  // wallet-match check inside the running async session would see the
  // STALE connectedWallet captured at start time, missing a mid-run
  // Phantom account switch. Phantom itself refuses to sign with a
  // mismatched feePayer (defense-in-depth), but we still want our gate
  // to surface a clean "Wallet changed" status instead of leaning on
  // the Phantom error popup.
  const connectedWalletRef = useRef<string | null>(opts.connectedWallet);
  connectedWalletRef.current = opts.connectedWallet;

  const cancel = useCallback(() => {
    cancelRef.current.cancelled = true;
  }, []);

  const reset = useCallback(() => {
    if (runningRef.current) return; // can't reset mid-run
    cancelRef.current.cancelled = false;
    setState(INITIAL_STATE);
  }, []);

  const start = useCallback(async () => {
    if (runningRef.current) return; // re-entry guard
    runningRef.current = true;
    cancelRef.current = { cancelled: false };

    const wallet = opts.targetWallet;
    if (!wallet) {
      setState({ ...INITIAL_STATE, status: "failed", topError: "No target wallet" });
      runningRef.current = false;
      return;
    }
    if (opts.connectedWallet !== wallet) {
      setState({
        ...INITIAL_STATE,
        status: "failed",
        topError: "Connected wallet does not match target wallet",
      });
      runningRef.current = false;
      return;
    }

    const snapshot = opts.getMintsSnapshot();
    const queue = buildQueue(snapshot, opts.includeCloseEmpty);
    if (queue.length === 0) {
      setState({
        ...INITIAL_STATE,
        status: "failed",
        topError: "Nothing selected to burn",
      });
      runningRef.current = false;
      return;
    }

    const provider = getProvider();
    if (!provider) {
      setState({
        ...INITIAL_STATE,
        status: "failed",
        topError: "No wallet provider available",
      });
      runningRef.current = false;
      return;
    }
    const hadSignAll = typeof provider.signAllTransactions === "function";

    const windowSize = Math.max(1, opts.windowSize ?? DEFAULT_WINDOW_SIZE);
    const totalWindows = Math.ceil(queue.length / windowSize);
    // Initial result slots — one per spec, status="building" updated as
    // we work through them.
    const results: BulkBurnWindowEntryResult[] = queue.map((spec) => ({
      spec,
      status: "building",
    }));

    setState({
      status: "running",
      step: "preparing",
      windowIndex: 0,
      totalWindows,
      activeTxInWindow: 0,
      results,
      hadSignAll,
      fellBackToSequential: !hadSignAll,
      topError: null,
    });

    // Helper to mutate a single result slot + flush to React state. We
    // never mutate state.results directly — we replace the slot and
    // call setState with the new array reference.
    const updateResult = (idx: number, patch: Partial<BulkBurnWindowEntryResult>) => {
      results[idx] = { ...results[idx], ...patch };
      setState((prev) => ({ ...prev, results: [...results] }));
    };

    try {
      for (let wi = 0; wi < totalWindows; wi++) {
        if (cancelRef.current.cancelled) break;

        const startIdx = wi * windowSize;
        const endIdx = Math.min(startIdx + windowSize, queue.length);
        const windowIndices: number[] = [];
        for (let i = startIdx; i < endIdx; i++) windowIndices.push(i);

        setState((prev) => ({
          ...prev,
          windowIndex: wi,
          step: "building",
          activeTxInWindow: 0,
        }));

        // ── BUILD ──────────────────────────────────────────────────
        // Sequential — each build call can take many seconds; we don't
        // want to fan out and saturate the backend or surface a wall of
        // simultaneous Helius traffic.
        const builtForSigning: Array<{
          idx: number;
          tx: Transaction;
          built: NarrowBuild;
        }> = [];
        for (let i = 0; i < windowIndices.length; i++) {
          if (cancelRef.current.cancelled) {
            for (const remIdx of windowIndices.slice(i)) {
              updateResult(remIdx, { status: "skipped-cancel" });
            }
            break;
          }
          const idx = windowIndices[i];
          setState((prev) => ({ ...prev, activeTxInWindow: i, step: "building" }));
          const built = await buildOne(queue[idx], wallet);
          if (!built.ok) {
            updateResult(idx, { status: "build-failed", error: built.error });
            continue;
          }
          // Live ref read — the running session must see post-render
          // wallet changes; a mid-run Phantom account switch otherwise
          // slips past this gate until Phantom itself rejects the sign.
          const gate = gateBuilt(built.built, wallet, connectedWalletRef.current);
          if (!gate.ok) {
            updateResult(idx, {
              status: "gate-failed",
              error: gate.reason,
              itemsAffected: built.built.itemsAffected,
            });
            continue;
          }
          // Surface a one-time note for closeEmpty when the backend's
          // 10-per-tx cap left some accounts behind. Phase 1 doesn't
          // auto-chain another closeEmpty build; user must rescan and
          // re-run the bulk burn to clean the rest.
          const note =
            built.built.closeEmptySkipped && built.built.closeEmptySkipped > 0
              ? `${built.built.closeEmptySkipped} empty accounts still remain — rescan and run bulk burn again to close the rest.`
              : undefined;
          updateResult(idx, {
            status: "ready",
            itemsAffected: built.built.itemsAffected,
            note,
          });
          builtForSigning.push({ idx, tx: gate.tx, built: built.built });
        }

        if (builtForSigning.length === 0) {
          // Nothing to sign this window — move on (or end if last).
          continue;
        }
        if (cancelRef.current.cancelled) {
          for (const e of builtForSigning) {
            updateResult(e.idx, { status: "skipped-cancel" });
          }
          break;
        }

        // ── SIGN ──────────────────────────────────────────────────
        setState((prev) => ({ ...prev, step: "signing", activeTxInWindow: 0 }));
        // Final pre-sign wallet-match check — read the LIVE ref so a
        // mid-window Phantom switch trips this gate before any popup.
        if (connectedWalletRef.current !== wallet) {
          for (const e of builtForSigning) {
            updateResult(e.idx, {
              status: "gate-failed",
              error: "Wallet changed before signing",
            });
          }
          continue;
        }
        let signedTxs: Transaction[] = [];
        try {
          // Phantom's signAllTransactions UI collapses to a fee-only
          // batch-confirm screen even for length-1 arrays (no per-tx
          // simulation, no asset-change preview). For a single-tx
          // window, signTransaction gives Phantom's full UI with
          // asset diffs — the same screen the per-section Burn N flow
          // uses today. Guard length > 1 so we only invoke the batched
          // API when it actually saves popups.
          if (hadSignAll && provider.signAllTransactions && builtForSigning.length > 1) {
            signedTxs = await provider.signAllTransactions(builtForSigning.map((e) => e.tx));
          } else {
            // Sequential path: one popup per tx. Hit when (a) wallet
            // lacks signAllTransactions OR (b) the window has exactly
            // 1 tx and we deliberately route to the single-tx UI.
            for (const e of builtForSigning) {
              if (cancelRef.current.cancelled) break;
              // eslint-disable-next-line no-await-in-loop
              const s = await provider.signTransaction(e.tx);
              signedTxs.push(s);
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Sign failed";
          for (const e of builtForSigning) {
            updateResult(e.idx, { status: "sign-failed", error: msg });
          }
          continue;
        }
        if (signedTxs.length !== builtForSigning.length) {
          // Fallback path that bailed mid-loop (cancel or wallet error
          // mid-sequence). Mark the un-signed remainder as sign-failed.
          for (let i = signedTxs.length; i < builtForSigning.length; i++) {
            updateResult(builtForSigning[i].idx, {
              status: "sign-failed",
              error: "Signature not produced",
            });
          }
        }

        // ── SUBMIT ──────────────────────────────────────────────────
        setState((prev) => ({ ...prev, step: "submitting" }));
        const submitted: Array<{ idx: number; signature: string }> = [];
        const conn = getConnection();
        for (let i = 0; i < signedTxs.length; i++) {
          if (cancelRef.current.cancelled) break;
          const idx = builtForSigning[i].idx;
          setState((prev) => ({ ...prev, activeTxInWindow: i, step: "submitting" }));
          try {
            // eslint-disable-next-line no-await-in-loop
            const signature = await conn.sendRawTransaction(signedTxs[i].serialize(), {
              skipPreflight: false,
              preflightCommitment: "confirmed",
              maxRetries: 3,
            });
            updateResult(idx, { status: "submitted", signature });
            submitted.push({ idx, signature });
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Submit failed";
            // Don't classify BlockhashNotFound specially in Phase 1 —
            // treat as failed, surface to summary, do not retry.
            updateResult(idx, { status: "submit-failed", error: msg });
          }
        }

        // ── CONFIRM ──────────────────────────────────────────────────
        // Sequential per submitted tx, polling getSignatureStatus.
        if (submitted.length > 0) {
          setState((prev) => ({ ...prev, step: "confirming" }));
          for (let i = 0; i < submitted.length; i++) {
            setState((prev) => ({ ...prev, activeTxInWindow: i, step: "confirming" }));
            const { idx, signature } = submitted[i];
            // eslint-disable-next-line no-await-in-loop
            const conf = await confirmSignature(signature);
            if (conf.ok) {
              updateResult(idx, { status: "confirmed" });
            } else {
              updateResult(idx, { status: "confirm-failed", error: conf.reason });
            }
          }
        }

        if (cancelRef.current.cancelled) break;
        setState((prev) => ({ ...prev, step: "between-windows" }));
      }

      const finalStatus: BulkBurnStatus = cancelRef.current.cancelled ? "cancelled" : "done";
      setState((prev) => ({ ...prev, status: finalStatus, step: null }));
    } catch (err) {
      setState((prev) => ({
        ...prev,
        status: "failed",
        step: null,
        topError: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      runningRef.current = false;
    }
  }, [opts]);

  return { state, start, cancel, reset };
}
