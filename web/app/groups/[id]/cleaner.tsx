"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import type {
  BuildCloseEmptyTxResult,
  BurnCandidate,
  BurnCandidatesResult,
  CleanupScanResult,
  ScannedTokenAccount,
} from "@/lib/api";
import { fmtNumber, fmtSol, shortAddr } from "@/lib/format";
import { buildCloseEmptyTxAction, scanCleanupAction } from "../actions";
import { Badge } from "@/ui-kit/components/Badge";
import { WalletLink } from "@/ui-kit/components/WalletLink";
import { btnPrimary, btnSecondary } from "@/lib/buttonStyles";
import {
  auditCloseEmptyTx,
  decodeBase64Transaction,
  getProvider,
  solscanTxUrl,
  type InstructionAuditResult,
} from "@/lib/wallet";

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

type ScanState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "scanned"; scan: CleanupScanResult; burn: BurnCandidatesResult }
  | { status: "error"; error: string };

interface WalletEntry {
  address: string;
  label: string | null;
}

interface WalletCtx {
  connected: string | null; // base58 pubkey, null if not connected
  connecting: boolean;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
}
const WalletContext = createContext<WalletCtx | null>(null);

function useWallet(): WalletCtx {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used within WalletProvider");
  return ctx;
}

function WalletProvider({ children }: { children: React.ReactNode }) {
  const [connected, setConnected] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Subscribe to provider events so external disconnects/account swaps update
  // our state.
  useEffect(() => {
    const provider = getProvider();
    if (!provider?.on) return;
    const onConnect = (...args: unknown[]) => {
      const pk = args[0] as { toBase58?: () => string } | undefined;
      if (pk?.toBase58) setConnected(pk.toBase58());
    };
    const onDisconnect = () => setConnected(null);
    const onAccountChanged = (...args: unknown[]) => {
      const pk = args[0] as { toBase58?: () => string } | null | undefined;
      setConnected(pk?.toBase58 ? pk.toBase58() : null);
    };
    provider.on("connect", onConnect);
    provider.on("disconnect", onDisconnect);
    provider.on("accountChanged", onAccountChanged);
    return () => {
      provider.off?.("connect", onConnect);
      provider.off?.("disconnect", onDisconnect);
      provider.off?.("accountChanged", onAccountChanged);
    };
  }, []);

  // Try silent reconnect for previously-trusted sessions.
  useEffect(() => {
    const provider = getProvider();
    if (!provider) return;
    provider
      .connect({ onlyIfTrusted: true })
      .then((res) => setConnected(res.publicKey.toBase58()))
      .catch(() => {
        /* not previously authorized — leave disconnected */
      });
  }, []);

  const connect = useCallback(async () => {
    const provider = getProvider();
    if (!provider) {
      setError(
        "No Solana wallet detected. Install Phantom or Solflare and reload.",
      );
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      const res = await provider.connect();
      setConnected(res.publicKey.toBase58());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connect failed");
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    const provider = getProvider();
    if (provider) {
      try {
        await provider.disconnect();
      } catch {
        /* ignore */
      }
    }
    setConnected(null);
  }, []);

  const value = useMemo(
    () => ({ connected, connecting, error, connect, disconnect }),
    [connected, connecting, error, connect, disconnect],
  );
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

function WalletConnectBar() {
  const w = useWallet();
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-neutral-700 bg-neutral-900 p-3 text-xs">
      <span className="font-semibold text-white">Wallet</span>
      {w.connected ? (
        <>
          <Badge variant="buy">Connected</Badge>
          <span className="font-mono text-[11px] text-neutral-200">
            {shortAddr(w.connected, 6, 6)}
          </span>
          <button
            type="button"
            onClick={() => void w.disconnect()}
            className={btnSecondary}
          >
            Disconnect
          </button>
        </>
      ) : (
        <>
          <Badge variant="neutral">Not connected</Badge>
          <button
            type="button"
            onClick={() => void w.connect()}
            disabled={w.connecting}
            className={btnPrimary}
          >
            {w.connecting ? "Connecting…" : "Connect wallet"}
          </button>
        </>
      )}
      {w.error && (
        <span className="ml-1 text-red-400">{w.error}</span>
      )}
      <span className="ml-auto text-neutral-500">
        Phantom or Solflare. Used only to sign close-empty transactions.
      </span>
    </div>
  );
}

// Per-wallet scan summary surfaced from each CleanerRow up to the section so
// the group-level overview tile can aggregate totals. Key = wallet address.
interface ScanSummary {
  empty: number;
  reclaimSol: number;
  fungible: number;
  nft: number;
}
interface ScanRegistryCtx {
  scans: Record<string, ScanSummary>;
  setScan: (address: string, summary: ScanSummary) => void;
}
const ScanRegistryContext = createContext<ScanRegistryCtx | null>(null);
function useScanRegistry(): ScanRegistryCtx {
  const ctx = useContext(ScanRegistryContext);
  if (!ctx) throw new Error("ScanRegistryContext missing");
  return ctx;
}

function ScanRegistryProvider({ children }: { children: React.ReactNode }) {
  const [scans, setScans] = useState<Record<string, ScanSummary>>({});
  const setScan = useCallback((address: string, summary: ScanSummary) => {
    setScans((prev) => ({ ...prev, [address]: summary }));
  }, []);
  const value = useMemo(() => ({ scans, setScan }), [scans, setScan]);
  return <ScanRegistryContext.Provider value={value}>{children}</ScanRegistryContext.Provider>;
}

// ============================================================================
// "Scan all" / "Clean all" orchestrator
// ----------------------------------------------------------------------------
// Drives sequential scan/clean across every wallet in the group while leaving
// each individual sign-and-send to the user (one Phantom popup per wallet).
// Cancellation flows through a ref so the running async loop can poll it on
// every iteration without re-rendering or stale closures.
// ============================================================================

interface ScanFailure {
  wallet: string;
  label: string | null;
  error: string;
}

type ScanAllState =
  | { status: "idle" }
  | {
      status: "running";
      idx: number;
      total: number;
      currentWallet: string;
      failed: ScanFailure[];
    }
  | {
      status: "done";
      total: number;
      succeeded: number;
      failed: ScanFailure[];
      cancelled: boolean;
    };

interface CleanResult {
  wallet: string;
  label: string | null;
  outcome:
    | "success"
    | "skipped-mismatch"
    | "skipped-no-empty"
    | "skipped-cancel"
    | "error";
  signature?: string;
  error?: string;
}

type CleanAllState =
  | { status: "idle" }
  | {
      status: "running";
      idx: number;
      total: number;
      currentWallet: string;
      currentLabel: string | null;
      step: "building" | "signing" | "rescanning";
      results: CleanResult[];
    }
  | { status: "done"; results: CleanResult[]; cancelled: boolean };

const DELAY_BETWEEN_WALLETS_MS = 200;

function GroupAllActions({ wallets }: { wallets: WalletEntry[] }) {
  const { scans, setScan } = useScanRegistry();
  const w = useWallet();
  const [scanAll, setScanAll] = useState<ScanAllState>({ status: "idle" });
  const [cleanAll, setCleanAll] = useState<CleanAllState>({ status: "idle" });
  // Mutable cancel flag — async loops poll this on each iteration so cancel
  // takes effect without React state churn or stale closure captures.
  const cancelRef = useRef(false);

  const isScanning = scanAll.status === "running";
  const isCleaning = cleanAll.status === "running";
  const busy = isScanning || isCleaning;

  const allScanned = wallets.every((wlt) => scans[wlt.address] !== undefined);
  const candidates = wallets.filter(
    (wlt) => (scans[wlt.address]?.empty ?? 0) > 0,
  );
  // Per spec, signing must stay manual and per-wallet. The connected Phantom
  // account can only sign for its own pubkey, so wallets in the group whose
  // address doesn't match the connected one will be skipped this run. The
  // user can switch accounts in their wallet extension and click Clean all
  // again to handle the remaining wallets.
  const matchable = w.connected
    ? candidates.filter((wlt) => wlt.address === w.connected)
    : [];

  async function runScanAll() {
    cancelRef.current = false;
    const failed: ScanFailure[] = [];
    let succeeded = 0;
    for (let i = 0; i < wallets.length; i++) {
      if (cancelRef.current) {
        setScanAll({
          status: "done",
          total: wallets.length,
          succeeded,
          failed,
          cancelled: true,
        });
        return;
      }
      const wlt = wallets[i];
      setScanAll({
        status: "running",
        idx: i + 1,
        total: wallets.length,
        currentWallet: wlt.address,
        failed: [...failed],
      });
      const res = await scanCleanupAction(wlt.address);
      if (res.ok) {
        setScan(wlt.address, {
          empty: res.scan.emptyTokenAccounts.length,
          reclaimSol: res.scan.totals.estimatedReclaimSol,
          fungible: res.burn.count,
          nft: res.scan.nftTokenAccounts.length,
        });
        succeeded++;
      } else {
        failed.push({ wallet: wlt.address, label: wlt.label, error: res.error });
      }
      // Light spacing between RPC bursts; the backend already throttles
      // getParsedTokenAccountsByOwner but a small client-side delay keeps
      // things friendly even if multiple users share the backend.
      if (i < wallets.length - 1) await sleep(DELAY_BETWEEN_WALLETS_MS);
    }
    setScanAll({
      status: "done",
      total: wallets.length,
      succeeded,
      failed,
      cancelled: false,
    });
  }

  async function runCleanAll() {
    cancelRef.current = false;
    const targets = wallets.filter(
      (wlt) => (scans[wlt.address]?.empty ?? 0) > 0,
    );
    const results: CleanResult[] = [];
    const provider = getProvider();

    for (let i = 0; i < targets.length; i++) {
      if (cancelRef.current) {
        // Mark the rest as user-cancelled so the result list explains why.
        for (let j = i; j < targets.length; j++) {
          results.push({
            wallet: targets[j].address,
            label: targets[j].label,
            outcome: "skipped-cancel",
          });
        }
        break;
      }

      const wlt = targets[i];

      // Connected wallet must match the wallet being cleaned. Skipping is
      // safer than auto-prompting an account switch — the user can re-run
      // after switching wallets in their extension.
      if (!w.connected || w.connected !== wlt.address) {
        results.push({
          wallet: wlt.address,
          label: wlt.label,
          outcome: "skipped-mismatch",
          error: !w.connected
            ? "No wallet connected"
            : `Connected wallet is ${shortAddr(w.connected, 4, 4)}, not ${shortAddr(wlt.address, 4, 4)}`,
        });
        continue;
      }

      setCleanAll({
        status: "running",
        idx: i + 1,
        total: targets.length,
        currentWallet: wlt.address,
        currentLabel: wlt.label,
        step: "building",
        results: [...results],
      });

      const built = await buildCloseEmptyTxAction(wlt.address);
      if (!built.ok) {
        results.push({
          wallet: wlt.address,
          label: wlt.label,
          outcome: "error",
          error: built.error,
        });
        continue;
      }
      const tx = built.result;
      if (tx.transactionBase64 === null || tx.includedAccounts.length === 0) {
        results.push({
          wallet: wlt.address,
          label: wlt.label,
          outcome: "skipped-no-empty",
        });
        continue;
      }
      const audit = auditCloseEmptyTx(tx.transactionBase64);
      if (!audit.ok) {
        results.push({
          wallet: wlt.address,
          label: wlt.label,
          outcome: "error",
          error: `Audit failed: ${audit.reason ?? "unknown"}`,
        });
        continue;
      }

      setCleanAll({
        status: "running",
        idx: i + 1,
        total: targets.length,
        currentWallet: wlt.address,
        currentLabel: wlt.label,
        step: "signing",
        results: [...results],
      });

      if (!provider) {
        results.push({
          wallet: wlt.address,
          label: wlt.label,
          outcome: "error",
          error: "Wallet provider unavailable",
        });
        continue;
      }
      try {
        const decoded = decodeBase64Transaction(tx.transactionBase64);
        const sent = await provider.signAndSendTransaction(decoded);
        results.push({
          wallet: wlt.address,
          label: wlt.label,
          outcome: "success",
          signature: sent.signature,
        });

        setCleanAll({
          status: "running",
          idx: i + 1,
          total: targets.length,
          currentWallet: wlt.address,
          currentLabel: wlt.label,
          step: "rescanning",
          results: [...results],
        });
        const rescan = await scanCleanupAction(wlt.address);
        if (rescan.ok) {
          setScan(wlt.address, {
            empty: rescan.scan.emptyTokenAccounts.length,
            reclaimSol: rescan.scan.totals.estimatedReclaimSol,
            fungible: rescan.burn.count,
            nft: rescan.scan.nftTokenAccounts.length,
          });
        }
      } catch (err) {
        results.push({
          wallet: wlt.address,
          label: wlt.label,
          outcome: "error",
          error: prettifyWalletError(err),
        });
        // On rejection / failure, continue to the next wallet rather than
        // aborting — the user may want to skip just this one.
      }

      if (i < targets.length - 1) await sleep(DELAY_BETWEEN_WALLETS_MS);
    }

    setCleanAll({
      status: "done",
      results,
      cancelled: cancelRef.current,
    });
  }

  function cancel() {
    cancelRef.current = true;
  }

  // ---- render ----
  return (
    <div className="border-t border-neutral-800 bg-neutral-950">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => void runScanAll()}
          disabled={busy}
          className={signSendButtonClass(
            isScanning ? "loading" : busy ? "blocked" : "idle",
          )}
        >
          {isScanning ? (
            <>
              <Spinner /> Scanning {scanAll.status === "running" ? scanAll.idx : 0} /{" "}
              {wallets.length}
            </>
          ) : (
            "Scan all wallets"
          )}
        </button>
        <button
          type="button"
          onClick={() => void runCleanAll()}
          disabled={busy || !allScanned || candidates.length === 0}
          title={
            !allScanned
              ? "Scan all wallets first"
              : candidates.length === 0
              ? "No wallets have closeable empty accounts"
              : matchable.length === 0
              ? "Connected wallet does not match any candidate; only matching wallets will be cleaned this run"
              : undefined
          }
          className={signSendButtonClass(
            isCleaning
              ? "loading"
              : busy || !allScanned || candidates.length === 0
              ? "blocked"
              : "idle",
          )}
        >
          {isCleaning ? (
            <>
              <Spinner /> Cleaning {cleanAll.status === "running" ? cleanAll.idx : 0} /{" "}
              {cleanAll.status === "running" ? cleanAll.total : 0}
            </>
          ) : (
            `Clean all wallets${candidates.length > 0 ? ` (${candidates.length})` : ""}`
          )}
        </button>
        {busy && (
          <button
            type="button"
            onClick={cancel}
            className={signSendButtonClass("secondary")}
          >
            Cancel
          </button>
        )}
        {!busy && allScanned && candidates.length > 0 && w.connected && matchable.length < candidates.length && (
          <span className="text-[11px] text-amber-300">
            Only {matchable.length} / {candidates.length} candidates match the
            connected wallet. Switch accounts in your wallet to clean the rest.
          </span>
        )}
      </div>

      {isScanning && scanAll.status === "running" && (
        <div className="border-t border-neutral-800 bg-neutral-900 px-3 py-1.5 text-[11px] text-neutral-300">
          Scanning <span className="font-mono">{shortAddr(scanAll.currentWallet, 4, 4)}</span>{" "}
          ({scanAll.idx} / {scanAll.total})
        </div>
      )}

      {isCleaning && cleanAll.status === "running" && (
        <div className="border-t border-neutral-800 bg-neutral-900 px-3 py-1.5 text-[11px] text-neutral-300">
          {cleanAll.step === "building" && "Building close tx for"}
          {cleanAll.step === "signing" && "Awaiting wallet signature for"}
          {cleanAll.step === "rescanning" && "Rescanning"}{" "}
          {cleanAll.currentLabel ? (
            <span className="font-semibold text-white">{cleanAll.currentLabel}</span>
          ) : (
            <span className="font-mono">
              {shortAddr(cleanAll.currentWallet, 4, 4)}
            </span>
          )}{" "}
          ({cleanAll.idx} / {cleanAll.total})
        </div>
      )}

      {scanAll.status === "done" && (
        <div className="border-t border-neutral-800 bg-neutral-900 px-3 py-1.5 text-[11px]">
          <span className="text-neutral-300">
            Scan all: {scanAll.succeeded} ok, {scanAll.failed.length} failed
            {scanAll.cancelled && " (cancelled)"}
          </span>
          {scanAll.failed.length > 0 && (
            <ul className="mt-1 list-inside list-disc space-y-0.5 text-red-400">
              {scanAll.failed.map((f) => (
                <li key={f.wallet}>
                  <span className="font-mono">{shortAddr(f.wallet, 4, 4)}</span>
                  : {f.error}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {cleanAll.status === "done" && (
        <CleanAllResults results={cleanAll.results} cancelled={cleanAll.cancelled} />
      )}
    </div>
  );
}

function CleanAllResults({
  results,
  cancelled,
}: {
  results: CleanResult[];
  cancelled: boolean;
}) {
  const counts = results.reduce(
    (acc, r) => {
      acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
      return acc;
    },
    {} as Record<CleanResult["outcome"], number>,
  );
  return (
    <div className="border-t border-neutral-800 bg-neutral-900 px-3 py-1.5 text-[11px]">
      <div className="text-neutral-300">
        Clean all done:
        <span className="ml-1 text-emerald-300">
          {counts.success ?? 0} success
        </span>
        {(counts["skipped-mismatch"] ?? 0) > 0 && (
          <span className="ml-1 text-amber-300">
            · {counts["skipped-mismatch"]} skipped (wallet mismatch)
          </span>
        )}
        {(counts["skipped-no-empty"] ?? 0) > 0 && (
          <span className="ml-1 text-neutral-500">
            · {counts["skipped-no-empty"]} skipped (no empty)
          </span>
        )}
        {(counts["skipped-cancel"] ?? 0) > 0 && (
          <span className="ml-1 text-neutral-500">
            · {counts["skipped-cancel"]} cancelled
          </span>
        )}
        {(counts.error ?? 0) > 0 && (
          <span className="ml-1 text-red-400">· {counts.error} error</span>
        )}
        {cancelled && <span className="ml-1 text-neutral-400">· (cancelled)</span>}
      </div>
      <ul className="mt-1 space-y-0.5">
        {results.map((r) => (
          <li key={r.wallet} className="flex flex-wrap items-baseline gap-1.5">
            <span className="font-mono text-neutral-300">
              {r.label ?? shortAddr(r.wallet, 4, 4)}
            </span>
            {r.outcome === "success" && r.signature ? (
              <>
                <span className="text-emerald-300">✓ sent</span>
                <a
                  href={solscanTxUrl(r.signature)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-semibold text-violet-300 hover:text-violet-200"
                >
                  {shortAddr(r.signature, 6, 6)} ↗
                </a>
              </>
            ) : r.outcome === "skipped-mismatch" ? (
              <span className="text-amber-300">
                ⤳ skipped (wallet mismatch)
                {r.error && <span className="ml-1 text-amber-200/70">— {r.error}</span>}
              </span>
            ) : r.outcome === "skipped-no-empty" ? (
              <span className="text-neutral-500">⤳ skipped (no empty)</span>
            ) : r.outcome === "skipped-cancel" ? (
              <span className="text-neutral-500">⤳ skipped (cancelled)</span>
            ) : (
              <span className="text-red-400">
                ✕ {r.error ?? "error"}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function GroupCleanerSummary({
  wallets,
}: {
  wallets: WalletEntry[];
}) {
  const totalWallets = wallets.length;
  const { scans } = useScanRegistry();
  const entries = Object.values(scans);
  const scanned = entries.length;
  const totals = entries.reduce(
    (acc, s) => ({
      empty: acc.empty + s.empty,
      reclaim: acc.reclaim + s.reclaimSol,
      fungible: acc.fungible + s.fungible,
      nft: acc.nft + s.nft,
    }),
    { empty: 0, reclaim: 0, fungible: 0, nft: 0 },
  );
  const dimWhenZero = scanned === 0;
  const tiles: { label: string; value: React.ReactNode; tone?: "ok" }[] = [
    {
      label: "Wallets scanned",
      value: (
        <>
          {scanned}
          <span className="ml-1 text-[11px] font-normal text-neutral-500">
            / {totalWallets}
          </span>
        </>
      ),
    },
    { label: "Empty accounts", value: dimWhenZero ? "—" : totals.empty },
    {
      label: "Gross reclaim",
      value: dimWhenZero ? (
        "—"
      ) : (
        <span className="text-emerald-300">{fmtSol(totals.reclaim)} SOL</span>
      ),
    },
    { label: "Burn candidates", value: dimWhenZero ? "—" : totals.fungible },
    { label: "NFTs", value: dimWhenZero ? "—" : totals.nft },
  ];
  return (
    <div className="overflow-hidden rounded-md border border-neutral-700 bg-neutral-900">
      <div className="flex items-baseline justify-between border-b border-neutral-700 px-3 py-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-300">
          Group cleaner overview
        </span>
        {scanned < totalWallets && (
          <span className="text-[11px] text-neutral-500">
            {totalWallets - scanned} wallet
            {totalWallets - scanned === 1 ? "" : "s"} not scanned yet
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-px bg-neutral-800 sm:grid-cols-5">
        {tiles.map((t) => (
          <div key={t.label} className="bg-neutral-900 px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
              {t.label}
            </div>
            <div className="mt-0.5 text-sm font-bold tabular-nums text-white">
              {t.value}
            </div>
          </div>
        ))}
      </div>
      <GroupAllActions wallets={wallets} />
    </div>
  );
}

export function CleanerSection({ wallets }: { wallets: WalletEntry[] }) {
  if (wallets.length === 0) {
    return (
      <div className="rounded-md border border-neutral-700 bg-neutral-900 p-6 text-center text-sm text-neutral-500">
        Add a wallet to this group first (Settings tab) to run cleanup scans.
      </div>
    );
  }
  return (
    <WalletProvider>
      <ScanRegistryProvider>
        <div className="space-y-3">
          <div className="rounded-md border border-neutral-700 bg-neutral-900 p-3 text-xs text-neutral-300">
            <span className="font-semibold text-white">Wallet Cleaner</span>
            <span className="ml-2 text-neutral-500">
              Scans report empty SPL token accounts (rent reclaimable) and fungible
              burn candidates. Connect a wallet to sign close-empty transactions
              and reclaim rent. Burn flow is not implemented.
            </span>
          </div>
          <WalletConnectBar />
          <GroupCleanerSummary wallets={wallets} />
          {wallets.map((w) => (
            <CleanerRow key={w.address} wallet={w} />
          ))}
        </div>
      </ScanRegistryProvider>
    </WalletProvider>
  );
}

type BuildState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; result: BuildCloseEmptyTxResult }
  | { status: "error"; error: string };

// "Clean wallet fully" auto-loop state. Each iteration is a full
// build → audit → sign → wait-cache → rescan cycle for one wallet.
type FullCleanState =
  | { status: "idle" }
  | {
      status: "running";
      batch: number;
      expectedBatches: number;
      remainingEmpty: number;
      step: "building" | "signing" | "waiting-cache" | "rescanning";
      waitSecondsLeft?: number;
      lastSignature?: string;
    }
  | { status: "done"; batches: number; signatures: string[] }
  | { status: "error"; batches: number; error: string; signatures: string[] }
  | { status: "cancelled"; batches: number; signatures: string[] };

// Confirmation polling for the full-clean loop. After signAndSendTransaction
// returns, the close instruction is in flight but may not have landed at
// 'confirmed' commitment yet. We poll the cleanup-scan endpoint with
// ?refresh=true (which bypasses the 30 s cache) up to N times, sleeping
// between attempts, until the scanned empty count drops. If it never drops
// inside the budget, we proceed with the latest result anyway — the next
// build call will return transactionBase64=null and the loop terminates
// cleanly. Hard cap keeps the loop responsive (matches Solana's typical
// 1–2 s confirmation time with margin).
const CONFIRM_POLL_INTERVAL_MS = 1_000;
const CONFIRM_POLL_MAX_ATTEMPTS = 8; // ≤ 8 s wall-clock worst case
// Mirrors the backend MAX_CLOSE_IX_PER_TX. Used to estimate batch count
// for progress display ("Closing batch K / N").
const MAX_CLOSE_IX_PER_TX = 10;

function CleanerRow({ wallet }: { wallet: WalletEntry }) {
  const [state, setState] = useState<ScanState>({ status: "idle" });
  const [showDetails, setShowDetails] = useState(false);
  const [pending, startTransition] = useTransition();
  const [buildState, setBuildState] = useState<BuildState>({ status: "idle" });
  const [buildPending, startBuildTransition] = useTransition();
  // Tracks the most recent successful send so post-send rescans can show
  // a different empty-state message ("Wallet cleaned: …") and skip auto-build.
  const [lastSentSig, setLastSentSig] = useState<string | null>(null);
  // Push per-wallet scan results up to the section so the group overview
  // tile can aggregate. Updates on every successful (re)scan.
  const { setScan } = useScanRegistry();
  const w = useWallet();

  // Auto-loop "Clean wallet fully" state. Runs build → sign → wait-cache →
  // rescan repeatedly until empty=0 or an error/cancel occurs. Cancel is
  // signalled through a ref so the running async loop can poll it on every
  // step without React closure churn.
  const [fullClean, setFullClean] = useState<FullCleanState>({ status: "idle" });
  const fullCleanCancelRef = useRef(false);
  const isFullCleaning = fullClean.status === "running";

  function handleScan() {
    setState({ status: "loading" });
    setBuildState({ status: "idle" });
    startTransition(async () => {
      const res = await scanCleanupAction(wallet.address);
      if (res.ok) {
        setState({ status: "scanned", scan: res.scan, burn: res.burn });
        setShowDetails(true);
        setScan(wallet.address, {
          empty: res.scan.emptyTokenAccounts.length,
          reclaimSol: res.scan.totals.estimatedReclaimSol,
          fungible: res.burn.count,
          nft: res.scan.nftTokenAccounts.length,
        });
      } else {
        setState({ status: "error", error: res.error });
      }
    });
  }

  function handleBuildTx() {
    setBuildState({ status: "loading" });
    startBuildTransition(async () => {
      const res = await buildCloseEmptyTxAction(wallet.address);
      if (res.ok) setBuildState({ status: "ready", result: res.result });
      else setBuildState({ status: "error", error: res.error });
    });
  }

  async function runFullClean() {
    if (state.status !== "scanned") return;
    if (state.scan.emptyTokenAccounts.length === 0) return;
    fullCleanCancelRef.current = false;
    // Hide the standalone "Build close transaction" preview while the loop
    // owns the build/sign cycle. Otherwise the user sees a stale preview
    // from a manual build alongside the auto-loop progress.
    setBuildState({ status: "idle" });

    const initialEmpty = state.scan.emptyTokenAccounts.length;
    const expectedBatches = Math.ceil(initialEmpty / MAX_CLOSE_IX_PER_TX);
    let remainingEmpty = initialEmpty;
    let batch = 0;
    const signatures: string[] = [];

    const fail = (error: string) =>
      setFullClean({ status: "error", batches: batch, error, signatures: [...signatures] });
    const cancelExit = () =>
      setFullClean({ status: "cancelled", batches: batch, signatures: [...signatures] });

    while (remainingEmpty > 0) {
      if (fullCleanCancelRef.current) return cancelExit();
      batch++;

      // 1. BUILD
      setFullClean({
        status: "running",
        batch,
        expectedBatches: Math.max(expectedBatches, batch),
        remainingEmpty,
        step: "building",
      });
      const built = await buildCloseEmptyTxAction(wallet.address);
      if (!built.ok) return fail(built.error);
      const tx = built.result;
      if (tx.transactionBase64 === null || tx.includedAccounts.length === 0) {
        // Build returned no closeable accounts — wallet is clean.
        setFullClean({ status: "done", batches: batch - 1, signatures: [...signatures] });
        return;
      }

      // 2. AUDIT — same whitelist the manual Sign & send button uses.
      const audit = auditCloseEmptyTx(tx.transactionBase64);
      if (!audit.ok) return fail(`Audit failed: ${audit.reason ?? "unknown"}`);

      // 3. WALLET CHECK
      if (w.connected !== wallet.address) {
        return fail(
          w.connected
            ? `Connected wallet ${shortAddr(w.connected, 4, 4)} does not match ${shortAddr(wallet.address, 4, 4)}`
            : "No wallet connected. Connect the wallet being cleaned and retry.",
        );
      }
      const provider = getProvider();
      if (!provider) return fail("No wallet provider available.");

      // 4. SIGN
      setFullClean({
        status: "running",
        batch,
        expectedBatches: Math.max(expectedBatches, batch),
        remainingEmpty,
        step: "signing",
      });
      let signature: string;
      try {
        const decoded = decodeBase64Transaction(tx.transactionBase64);
        const sent = await provider.signAndSendTransaction(decoded);
        signature = sent.signature;
      } catch (err) {
        return fail(prettifyWalletError(err));
      }
      signatures.push(signature);
      setLastSentSig(signature);

      // 5. CONFIRM + RESCAN — poll the scan endpoint with ?refresh=true to
      //    bypass the 30 s cache. Repeat until the empty count drops below
      //    the pre-sign value (= the close has confirmed at 'confirmed'
      //    commitment) or the attempt budget is exhausted. With Solana
      //    typically confirming in 1–2 s this usually exits on the first
      //    or second attempt; the budget is just defensive.
      let rescanResult: Awaited<ReturnType<typeof scanCleanupAction>> | null = null;
      for (let attempt = 1; attempt <= CONFIRM_POLL_MAX_ATTEMPTS; attempt++) {
        if (fullCleanCancelRef.current) return cancelExit();
        setFullClean({
          status: "running",
          batch,
          expectedBatches: Math.max(expectedBatches, batch),
          remainingEmpty,
          step: attempt === 1 ? "rescanning" : "waiting-cache",
          waitSecondsLeft: attempt === 1
            ? undefined
            : Math.max(0, CONFIRM_POLL_MAX_ATTEMPTS - attempt + 1),
          lastSignature: signature,
        });
        rescanResult = await scanCleanupAction(wallet.address, { refresh: true });
        if (!rescanResult.ok) break;
        const newEmpty = rescanResult.scan.emptyTokenAccounts.length;
        if (newEmpty < remainingEmpty) {
          // Close has landed and is reflected on-chain.
          break;
        }
        if (attempt < CONFIRM_POLL_MAX_ATTEMPTS) {
          await sleep(CONFIRM_POLL_INTERVAL_MS);
        }
      }
      if (!rescanResult || !rescanResult.ok) {
        return fail(
          rescanResult ? rescanResult.error : "Rescan failed after close",
        );
      }

      setState({ status: "scanned", scan: rescanResult.scan, burn: rescanResult.burn });
      setScan(wallet.address, {
        empty: rescanResult.scan.emptyTokenAccounts.length,
        reclaimSol: rescanResult.scan.totals.estimatedReclaimSol,
        fungible: rescanResult.burn.count,
        nft: rescanResult.scan.nftTokenAccounts.length,
      });
      remainingEmpty = rescanResult.scan.emptyTokenAccounts.length;
      // Loop back to BUILD if there are still empties; otherwise fall out.
    }

    setFullClean({ status: "done", batches: batch, signatures: [...signatures] });
  }

  function cancelFullClean() {
    fullCleanCancelRef.current = true;
  }

  const summary =
    state.status === "scanned"
      ? {
          empty: state.scan.emptyTokenAccounts.length,
          reclaimSol: state.scan.totals.estimatedReclaimSol,
          fungible: state.burn.count,
          nft: state.scan.nftTokenAccounts.length,
        }
      : null;

  return (
    <div className="overflow-hidden rounded-md border border-neutral-700 bg-neutral-900">
      <div className="grid grid-cols-12 items-center gap-3 px-3 py-2">
        <div className="col-span-3 min-w-0">
          {wallet.label ? (
            <div className="text-sm font-semibold text-white">{wallet.label}</div>
          ) : null}
          <WalletLink address={wallet.address} chars={6} className="text-xs" />
        </div>

        <div className="col-span-2 text-right">
          <div className="text-[10px] uppercase tracking-wider text-neutral-400">Empty</div>
          <div className="text-sm font-bold tabular-nums text-white">
            {summary ? summary.empty : "—"}
          </div>
        </div>
        <div className="col-span-2 text-right">
          <div className="text-[10px] uppercase tracking-wider text-neutral-400">Reclaim SOL</div>
          <div className="text-sm font-bold tabular-nums text-emerald-300">
            {summary ? fmtSol(summary.reclaimSol) : "—"}
          </div>
        </div>
        <div className="col-span-2 text-right">
          <div className="text-[10px] uppercase tracking-wider text-neutral-400">Burn cand.</div>
          <div className="text-sm font-bold tabular-nums text-white">
            {summary ? summary.fungible : "—"}
          </div>
        </div>
        <div className="col-span-1 text-right">
          <div className="text-[10px] uppercase tracking-wider text-neutral-400">NFTs</div>
          <div className="text-sm font-bold tabular-nums text-white">
            {summary ? summary.nft : "—"}
          </div>
        </div>

        <div className="col-span-2 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={handleScan}
            disabled={pending || isFullCleaning}
            className={btnPrimary}
          >
            {state.status === "loading" || pending ? "Scanning…" : state.status === "scanned" ? "Rescan" : "Scan"}
          </button>
          {state.status === "scanned" && (
            <button
              type="button"
              onClick={() => setShowDetails((v) => !v)}
              className={btnSecondary}
              disabled={isFullCleaning}
            >
              {showDetails ? "Hide" : "View details"}
            </button>
          )}
          {state.status === "scanned" && state.scan.emptyTokenAccounts.length > 0 && (
            <button
              type="button"
              onClick={handleBuildTx}
              disabled={
                buildPending || buildState.status === "loading" || isFullCleaning
              }
              className={btnSecondary}
            >
              {buildState.status === "loading" || buildPending
                ? "Building…"
                : buildState.status === "ready"
                ? "Rebuild close tx"
                : "Build close transaction"}
            </button>
          )}
          {state.status === "scanned" &&
            state.scan.emptyTokenAccounts.length > 0 &&
            !isFullCleaning && (
              <button
                type="button"
                onClick={() => void runFullClean()}
                disabled={
                  pending ||
                  state.status !== "scanned" ||
                  w.connected !== wallet.address
                }
                title={
                  w.connected !== wallet.address
                    ? `Connect the wallet ${shortAddr(wallet.address, 4, 4)} to enable full clean`
                    : undefined
                }
                className={btnPrimary}
              >
                Clean wallet fully
              </button>
            )}
          {isFullCleaning && (
            <button
              type="button"
              onClick={cancelFullClean}
              className={btnSecondary}
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      {state.status === "error" && (
        <div className="border-t border-neutral-800 bg-red-500/5 px-3 py-2 text-xs text-red-400">
          {state.error}
        </div>
      )}

      {fullClean.status === "running" && (
        <FullCleanProgress state={fullClean} />
      )}
      {fullClean.status === "done" && (
        <div className="border-t border-neutral-800 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-300">
          ✓ Wallet fully cleaned in {fullClean.batches} batch
          {fullClean.batches === 1 ? "" : "es"}.
          {fullClean.signatures.length > 0 && (
            <span className="ml-2 inline-flex flex-wrap gap-2 align-middle">
              {fullClean.signatures.map((sig, i) => (
                <a
                  key={sig}
                  href={solscanTxUrl(sig)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-[11px] font-semibold text-violet-300 hover:text-violet-200"
                >
                  tx{i + 1} ↗
                </a>
              ))}
            </span>
          )}
        </div>
      )}
      {fullClean.status === "cancelled" && (
        <div className="border-t border-neutral-800 bg-amber-500/5 px-3 py-2 text-xs text-amber-300">
          Cancelled after {fullClean.batches} batch
          {fullClean.batches === 1 ? "" : "es"}. Rescan to refresh totals.
        </div>
      )}
      {fullClean.status === "error" && (
        <div className="border-t border-neutral-800 bg-red-500/5 px-3 py-2 text-xs text-red-400">
          Full clean stopped at batch {fullClean.batches}: {fullClean.error}
        </div>
      )}

      {state.status === "scanned" && state.scan.emptyTokenAccounts.length === 0 && (
        <div
          className={`border-t border-neutral-800 px-3 py-2 text-xs ${
            lastSentSig
              ? "bg-emerald-500/5 text-emerald-300"
              : "bg-neutral-950 text-neutral-500"
          }`}
        >
          {lastSentSig
            ? "Wallet cleaned: no closeable empty accounts found."
            : "No closeable empty accounts."}
        </div>
      )}

      {buildState.status === "error" && (
        <div className="border-t border-neutral-800 bg-red-500/5 px-3 py-2 text-xs text-red-400">
          Build failed: {buildState.error}
        </div>
      )}

      {buildState.status === "ready" && (
        <CloseTxPreview
          result={buildState.result}
          targetWallet={wallet.address}
          onSent={(sig) => setLastSentSig(sig)}
          onRescan={handleScan}
          rescanPending={pending || state.status === "loading"}
        />
      )}

      {state.status === "scanned" && showDetails && (
        <CleanerDetails scan={state.scan} burn={state.burn} />
      )}
    </div>
  );
}

type SendState =
  | { status: "idle" }
  | { status: "signing" }
  | { status: "sent"; signature: string }
  | { status: "error"; error: string };

function CloseTxPreview({
  result,
  targetWallet,
  onSent,
  onRescan,
  rescanPending,
}: {
  result: BuildCloseEmptyTxResult;
  targetWallet: string;
  onSent: (signature: string) => void;
  onRescan: () => void;
  rescanPending: boolean;
}) {
  const tx = result.transactionBase64;
  const txShort =
    tx === null
      ? "—"
      : tx.length > 80
      ? `${tx.slice(0, 40)}…${tx.slice(-20)} (${tx.length} chars)`
      : tx;
  const rows: { label: string; value: React.ReactNode; mono?: boolean }[] = [
    {
      label: "Included accounts",
      value: (
        <span className="font-bold text-white">
          {result.includedAccounts.length}
          <span className="ml-1 text-neutral-500">
            / {result.totalEmpty} total
          </span>
        </span>
      ),
    },
    {
      label: "Skipped accounts",
      value: (
        <span className="text-white">
          {result.skippedAccounts}
          {result.skippedAccounts > 0 && (
            <span className="ml-1 text-neutral-500">
              (limit {result.maxInstructionsPerTx} per tx)
            </span>
          )}
        </span>
      ),
    },
    {
      label: "Gross reclaim",
      value: (
        <span className="font-bold text-emerald-300">
          {fmtSol(result.estimatedReclaimSol)} SOL
        </span>
      ),
    },
    {
      label: "Estimated network fee",
      value: (
        <span className="text-neutral-200">
          {fmtSol(result.estimatedFeeSol)} SOL
          <span className="ml-1 text-[10px] text-neutral-500">
            (base {fmtSol(result.estimatedBaseFeeSol)}
            {result.estimatedPriorityFeeSol > 0 && (
              <> + priority {fmtSol(result.estimatedPriorityFeeSol)}</>
            )}
            ; {result.computeUnitLimit.toLocaleString()} CU
            {result.priorityFeeMicrolamports > 0 && (
              <> @ {result.priorityFeeMicrolamports} μL/CU</>
            )}
            )
          </span>
        </span>
      ),
    },
    {
      label: "Estimated net received",
      value: (
        <span className="font-bold text-emerald-300">
          {fmtSol(result.estimatedNetReclaimSol)} SOL
        </span>
      ),
    },
    {
      label: "Tx version",
      value: <Badge variant="info">{result.transactionVersion}</Badge>,
    },
    { label: "Fee payer", value: result.feePayer, mono: true },
    {
      label: "Requires signature from",
      value: result.requiresSignatureFrom,
      mono: true,
    },
    {
      label: "Transaction (base64)",
      value: txShort,
      mono: true,
    },
  ];
  return (
    <div className="border-t border-neutral-800 bg-neutral-950">
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-300">
          Close transaction preview
        </span>
        <Badge variant="warn">unsigned</Badge>
      </div>
      <div className="border-b border-neutral-800 bg-amber-500/5 px-3 py-1.5 text-[11px] text-amber-300">
        ⚠ {result.warning}
      </div>
      {result.includedAccounts.length > 0 && (
        <div className="border-b border-neutral-800 bg-violet-500/5 px-3 py-1.5 text-[11px] text-violet-200">
          ℹ Closing {result.includedAccounts.length} account
          {result.includedAccounts.length === 1 ? "" : "s"} in this transaction.
          {result.skippedAccounts > 0 && (
            <>
              {" "}
              {result.skippedAccounts} account
              {result.skippedAccounts === 1 ? "" : "s"} remain for the next batch.
            </>
          )}
        </div>
      )}
      <dl className="divide-y divide-neutral-800">
        {rows.map((r) => (
          <div
            key={r.label}
            className="grid grid-cols-12 items-center gap-3 px-3 py-1.5 text-xs"
          >
            <dt className="col-span-4 text-neutral-400">{r.label}</dt>
            <dd
              className={`col-span-8 min-w-0 break-all ${
                r.mono ? "font-mono text-[11px] text-neutral-100" : "text-neutral-100"
              }`}
            >
              {r.value}
            </dd>
          </div>
        ))}
      </dl>
      <SignAndSendBlock
        result={result}
        targetWallet={targetWallet}
        onSent={onSent}
        onRescan={onRescan}
        rescanPending={rescanPending}
      />
    </div>
  );
}

function SignAndSendBlock({
  result,
  targetWallet,
  onSent,
  onRescan,
  rescanPending,
}: {
  result: BuildCloseEmptyTxResult;
  targetWallet: string;
  onSent: (signature: string) => void;
  onRescan: () => void;
  rescanPending: boolean;
}) {
  const w = useWallet();
  const [send, setSend] = useState<SendState>({ status: "idle" });

  const noTx = result.transactionBase64 === null;
  const noIncluded = result.includedAccounts.length === 0;
  const walletMismatch =
    w.connected !== null && w.connected !== result.requiresSignatureFrom;
  const targetMismatch = targetWallet !== result.requiresSignatureFrom;
  const cleanedVsConnectedMismatch =
    w.connected !== null && w.connected !== targetWallet;
  const alreadySent = send.status === "sent";
  const hasNextBatch = result.skippedAccounts > 0;

  // Audit transaction instructions client-side: every ix must be a CloseAccount
  // call against SPL Token / Token-2022. Memoized on the base64 string so this
  // doesn't re-run on every render.
  const audit: InstructionAuditResult | null = useMemo(() => {
    if (result.transactionBase64 === null) return null;
    return auditCloseEmptyTx(result.transactionBase64);
  }, [result.transactionBase64]);

  // Safety checklist gates: each must pass before the sign button is enabled.
  const checks = {
    walletMatches:
      w.connected !== null && w.connected === targetWallet && !walletMismatch,
    closeAccountOnly: audit?.ok === true,
    includedNonZero: !noIncluded,
    burnExcluded: true, // burn flow is not implemented anywhere in this codebase
  };
  const checklistPassed =
    checks.walletMatches &&
    checks.closeAccountOnly &&
    checks.includedNonZero &&
    checks.burnExcluded;

  // Once a tx for this build has been sent, the same built tx cannot be sent
  // again — its blockhash is consumed. User must rescan and rebuild.
  const canSend =
    !alreadySent &&
    !noTx &&
    checklistPassed &&
    !targetMismatch &&
    send.status !== "signing";

  async function handleSignAndSend() {
    const dev = process.env.NODE_ENV !== "production";
    const provider = getProvider();
    // [cleaner-debug] click-time snapshot — remove after triage.
    if (dev) {
      const p = provider as (typeof provider & { isSolflare?: boolean; isPhantom?: boolean }) | null;
      const providerName = p?.isPhantom
        ? "phantom"
        : p?.isSolflare
        ? "solflare"
        : provider
        ? "unknown"
        : "(none)";
      console.debug("[cleaner-debug] sign click", {
        providerName,
        connected: w.connected,
        targetWallet,
        requiresSignatureFrom: result.requiresSignatureFrom,
        feePayer: result.feePayer,
        txB64Length: result.transactionBase64?.length ?? null,
        included: result.includedAccounts.length,
        guards: { noTx, noIncluded, walletMismatch, targetMismatch, alreadySent, canSend },
        audit,
      });
    }
    if (!canSend || result.transactionBase64 === null) return;
    if (!provider) {
      setSend({ status: "error", error: "No wallet provider available." });
      return;
    }
    setSend({ status: "signing" });
    try {
      const tx = decodeBase64Transaction(result.transactionBase64);
      if (dev) {
        console.debug("[cleaner-debug] decoded tx", {
          instructions: tx.instructions.length,
          programIds: tx.instructions.map((i) => i.programId.toBase58()),
          opcodes: tx.instructions.map((i) => i.data[0]),
          feePayer: tx.feePayer?.toBase58(),
          recentBlockhash: tx.recentBlockhash,
          signaturesCount: tx.signatures.length,
        });
      }
      const res = await provider.signAndSendTransaction(tx);
      if (dev) console.debug("[cleaner-debug] signAndSendTransaction ok", { signature: res.signature });
      setSend({ status: "sent", signature: res.signature });
      onSent(res.signature);
    } catch (err) {
      if (dev) console.debug("[cleaner-debug] signAndSendTransaction error", err);
      setSend({ status: "error", error: prettifyWalletError(err) });
    }
  }

  return (
    <div className="border-t border-neutral-800 bg-neutral-950">
      {cleanedVsConnectedMismatch && (
        <div className="border-b border-neutral-800 bg-amber-500/5 px-3 py-1.5 text-[11px] text-amber-300">
          ⚠ Connected wallet must match the wallet being cleaned.{" "}
          <span className="text-amber-200/80">
            Connected: <span className="font-mono">{shortAddr(w.connected!, 4, 4)}</span>{" "}
            · cleaning: <span className="font-mono">{shortAddr(targetWallet, 4, 4)}</span>
          </span>
        </div>
      )}
      <div className="border-b border-neutral-800 bg-amber-500/5 px-3 py-1.5 text-[11px] text-amber-300">
        ⚠ This only closes empty token accounts and returns rent. It does not
        burn tokens or NFTs.
      </div>
      <SafetyChecklist
        items={[
          {
            ok: checks.walletMatches,
            label: "Connected wallet matches target wallet",
            failHint:
              w.connected === null
                ? "Connect a wallet"
                : `Expected ${shortAddr(targetWallet, 4, 4)}, got ${shortAddr(w.connected, 4, 4)}`,
          },
          {
            ok: checks.closeAccountOnly,
            label: "Transaction only contains CloseAccount instructions",
            failHint:
              audit === null
                ? "No transaction to audit"
                : audit.reason ?? "Audit failed",
          },
          {
            ok: checks.includedNonZero,
            label: `Included accounts count > 0 (${result.includedAccounts.length})`,
            failHint: "No accounts included in this transaction",
          },
          {
            ok: checks.burnExcluded,
            label: "Burn is not included",
          },
        ]}
      />
      <div className="mt-3 flex flex-wrap items-center justify-start gap-2 px-3 pb-3">
        {!w.connected ? (
          <button
            type="button"
            onClick={() => void w.connect()}
            disabled={w.connecting}
            aria-label="Connect wallet to sign"
            className={signSendButtonClass(w.connecting ? "loading" : "idle")}
          >
            {w.connecting ? (
              <>
                <Spinner /> Connecting…
              </>
            ) : (
              "Connect wallet to sign"
            )}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void handleSignAndSend()}
            disabled={!canSend}
            aria-label="Sign and send close transaction"
            className={signSendButtonClass(
              alreadySent
                ? "sent"
                : send.status === "signing"
                ? "loading"
                : !canSend
                ? "blocked"
                : "idle",
            )}
            title={
              alreadySent
                ? "This transaction has been sent. Rescan to build a new one."
                : noIncluded
                ? "No accounts included in this transaction."
                : noTx
                ? "Nothing to send — transactionBase64 is null"
                : walletMismatch
                ? `Connected wallet does not match requiresSignatureFrom (${shortAddr(
                    result.requiresSignatureFrom,
                    4,
                    4,
                  )})`
                : undefined
            }
          >
            {send.status === "signing" ? (
              <>
                <Spinner /> Awaiting wallet…
              </>
            ) : alreadySent ? (
              "Sent ✓"
            ) : (
              "Sign & send close transaction"
            )}
          </button>
        )}
        {alreadySent && (
          <button
            type="button"
            onClick={onRescan}
            disabled={rescanPending}
            aria-label="Rescan wallet"
            className={signSendButtonClass(rescanPending ? "loading-secondary" : "secondary")}
          >
            {rescanPending ? (
              <>
                <Spinner /> Rescanning…
              </>
            ) : (
              "Rescan wallet"
            )}
          </button>
        )}
        {noIncluded && (
          <span className="text-[11px] text-neutral-500">
            No accounts included in this transaction.
          </span>
        )}
        {!noTx && walletMismatch && !cleanedVsConnectedMismatch && (
          <span className="text-[11px] text-red-400">
            Connected wallet must match{" "}
            <span className="font-mono">
              {shortAddr(result.requiresSignatureFrom, 4, 4)}
            </span>
            .
          </span>
        )}
      </div>

      {send.status === "sent" && (
        <div className="border-t border-neutral-800 bg-emerald-500/5 px-3 py-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="buy">Sent</Badge>
            <span className="text-neutral-300">Tx signature:</span>
            <span className="font-mono text-[11px] text-neutral-100">
              {shortAddr(send.signature, 8, 8)}
            </span>
            <a
              href={solscanTxUrl(send.signature)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] font-semibold text-violet-300 hover:text-violet-200"
            >
              View on Solscan ↗
            </a>
          </div>
          {hasNextBatch && (
            <div className="mt-1 text-[11px] text-emerald-300/80">
              Rescan after confirmation to build the next batch (
              {result.skippedAccounts} account
              {result.skippedAccounts === 1 ? "" : "s"} remaining).
            </div>
          )}
        </div>
      )}

      {send.status === "error" && (
        <div className="border-t border-neutral-800 bg-red-500/5 px-3 py-2 text-xs text-red-400">
          {send.error}
        </div>
      )}
    </div>
  );
}


// Per-state class string for the Sign & send action button. Inlined here
// (instead of using shared btnPrimary) because the shared `disabled:opacity-40`
// rule was making the button visually disappear against the dark
// neutral-950 panel surface whenever any safety check failed. Each state
// keeps a fully-opaque, clearly-bordered button so the affordance is
// unmistakable in every case.
type SignButtonState =
  | "idle"
  | "loading"
  | "sent"
  | "blocked"
  | "secondary"
  | "loading-secondary";

function signSendButtonClass(state: SignButtonState): string {
  const base =
    "inline-flex min-w-[200px] items-center justify-center gap-1.5 " +
    "rounded-lg border px-4 py-2 text-sm font-semibold " +
    "transition-colors duration-100 active:scale-[0.98] " +
    "focus:outline-none focus:ring-2";
  switch (state) {
    case "idle":
      return (
        `${base} cursor-pointer ` +
        "border-violet-400 bg-violet-500 text-white shadow shadow-violet-500/30 " +
        "hover:bg-violet-400 hover:border-violet-300 " +
        "focus:ring-violet-500/50"
      );
    case "loading":
      return (
        `${base} cursor-wait ` +
        "border-violet-400/70 bg-violet-600 text-white/95 " +
        "focus:ring-violet-500/50"
      );
    case "sent":
      return (
        `${base} cursor-default ` +
        "border-emerald-400 bg-emerald-500 text-white shadow shadow-emerald-500/30 " +
        "focus:ring-emerald-500/50"
      );
    case "blocked":
      return (
        `${base} cursor-not-allowed ` +
        "border-neutral-700 bg-neutral-800 text-neutral-400 " +
        "focus:ring-neutral-700/60"
      );
    case "secondary":
      return (
        `${base} cursor-pointer ` +
        "border-neutral-600 bg-neutral-800 text-neutral-100 " +
        "hover:border-neutral-500 hover:bg-neutral-700 hover:text-white " +
        "focus:ring-neutral-700/60"
      );
    case "loading-secondary":
      return (
        `${base} cursor-wait ` +
        "border-neutral-600 bg-neutral-800 text-neutral-200 " +
        "focus:ring-neutral-700/60"
      );
  }
}

function FullCleanProgress({
  state,
}: {
  state: Extract<FullCleanState, { status: "running" }>;
}) {
  const stepLabel =
    state.step === "building"
      ? "Building close tx"
      : state.step === "signing"
      ? "Awaiting wallet signature"
      : state.step === "waiting-cache"
      ? "Waiting for confirmation…"
      : "Rescanning";
  return (
    <div className="border-t border-neutral-800 bg-violet-500/5 px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Spinner />
        <span className="font-semibold text-white">
          Closing batch {state.batch} / {state.expectedBatches}
        </span>
        <span className="text-neutral-400">— {stepLabel}</span>
        <span className="ml-auto text-[11px] text-neutral-400">
          {state.remainingEmpty} empty account
          {state.remainingEmpty === 1 ? "" : "s"} remaining
        </span>
      </div>
      {state.lastSignature && (
        <div className="mt-1 text-[11px] text-neutral-500">
          Last tx:{" "}
          <a
            href={solscanTxUrl(state.lastSignature)}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono font-semibold text-violet-300 hover:text-violet-200"
          >
            {shortAddr(state.lastSignature, 6, 6)} ↗
          </a>
        </div>
      )}
    </div>
  );
}

// Compact 12-px spinner used inside primary action buttons. Inline-block so
// it sits flush with the button label; aria-hidden because the surrounding
// label already conveys state.
function Spinner() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="mr-1.5 inline-block h-3.5 w-3.5 animate-spin"
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeOpacity="0.25"
      />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

// Maps the raw error thrown by `provider.signAndSendTransaction` (Phantom /
// Solflare / generic Phantom-shaped provider) into a clean, user-facing
// sentence. We keep the original error in dev console via [cleaner-debug],
// but the UI never shows raw provider stack traces.
function prettifyWalletError(err: unknown): string {
  const e = err as { code?: number; message?: string; name?: string } | null;
  const m = (e?.message ?? "").toLowerCase();
  // 4001 is the EIP-1193-style "user rejected" code that Phantom uses too.
  if (e?.code === 4001 || /user rejected|user denied|request rejected|cancelled/.test(m)) {
    return "Signing cancelled in wallet.";
  }
  if (/wrong[- ]?account|signer.*mismatch|missing.*signer|account does not match|signature.*mismatch/.test(m)) {
    return "Wallet does not match the cleaning wallet. Switch accounts in your wallet to the address being cleaned and try again.";
  }
  if (/blockhash not found|block height exceeded|transaction.*expired|transactiontoold|expired/.test(m)) {
    return "Transaction expired (blockhash). Click Rebuild close tx, then Sign & send again.";
  }
  if (/insufficient (lamports|funds|balance|sol)/.test(m) || /not enough sol/.test(m)) {
    return "Insufficient SOL in the wallet to pay the network fee. Add a small amount of SOL and try again.";
  }
  if (/simulation failed|preflight|failed to simulate/.test(m)) {
    return "Transaction simulation failed. The accounts may already be closed — Rescan, then rebuild.";
  }
  if (/no wallet|provider/.test(m) && /undefined|null/.test(m)) {
    return "No wallet provider detected. Make sure Phantom or Solflare is installed and unlocked.";
  }
  return e?.message
    ? `Sign/send failed: ${e.message}`
    : "Sign/send failed. Open the browser console for details.";
}

interface SafetyCheckItem {
  ok: boolean;
  label: ReactNode;
  failHint?: string;
}

function SafetyChecklist({ items }: { items: SafetyCheckItem[] }) {
  return (
    <ul className="divide-y divide-neutral-800 border-b border-neutral-800 bg-neutral-950 text-[11px]">
      {items.map((item, i) => (
        <li
          key={i}
          className="flex items-start gap-2 px-3 py-1.5"
        >
          <span
            aria-hidden
            className={`mt-[2px] inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full font-bold leading-none ${
              item.ok
                ? "bg-emerald-500/20 text-emerald-300"
                : "bg-red-500/20 text-red-300"
            }`}
          >
            {item.ok ? "✓" : "✕"}
          </span>
          <span className={`min-w-0 flex-1 ${item.ok ? "text-neutral-200" : "text-red-300"}`}>
            {item.label}
            {!item.ok && item.failHint && (
              <span className="ml-1 text-red-400/80">— {item.failHint}</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

function CleanerDetails({
  scan,
  burn,
}: {
  scan: CleanupScanResult;
  burn: BurnCandidatesResult;
}) {
  return (
    <div className="border-t border-neutral-800 bg-neutral-950">
      {/* SECTION 1 — empty accounts (closing). Plain neutral surface so this
          section reads as the "safe / implemented" path. */}
      <SubHeader
        label="Empty token accounts (closing)"
        right={`${scan.emptyTokenAccounts.length} · reclaim ${fmtSol(scan.totals.estimatedReclaimSol)} SOL`}
      />
      {scan.emptyTokenAccounts.length === 0 ? (
        <EmptyHint>No empty token accounts.</EmptyHint>
      ) : (
        <EmptyAccountsTable rows={scan.emptyTokenAccounts} />
      )}

      {/* SECTION 2 — burn candidates. Visually quarantined inside a red-tinted
          card so it reads as a separate, dangerous, NOT-implemented surface.
          Sits inside the same details panel but with its own border, header,
          warning row, and footer note. */}
      <div className="m-3 overflow-hidden rounded-md border-2 border-red-500/40 bg-red-500/[0.04]">
        <div className="flex items-baseline justify-between border-b border-red-500/30 bg-red-500/10 px-3 py-1.5">
          <span className="text-[10px] font-bold uppercase tracking-wider text-red-300">
            Burn candidates · destructive · not implemented
          </span>
          <span className="text-[11px] tabular-nums text-red-300/80">
            {burn.count} · est. reclaim {fmtSol(burn.totalEstimatedReclaimSol)} SOL
          </span>
        </div>
        <div className="border-b border-red-500/20 bg-red-500/5 px-3 py-2 text-[11px] font-semibold text-red-300">
          ⚠ Burning tokens is destructive and not implemented yet.
        </div>
        {burn.warning && (
          <div className="border-b border-red-500/15 bg-amber-500/5 px-3 py-1.5 text-[11px] text-amber-300">
            ⚠ {burn.warning}
          </div>
        )}
        {burn.candidates.length === 0 ? (
          <EmptyHint>No fungible burn candidates.</EmptyHint>
        ) : (
          <BurnCandidatesTable rows={burn.candidates} />
        )}
        <div className="border-t border-red-500/20 bg-neutral-950 px-3 py-2 text-center text-[11px] font-medium text-red-300/80">
          Manual review required. Never burn tokens automatically.
        </div>
      </div>
    </div>
  );
}

function SubHeader({ label, right }: { label: string; right?: string }) {
  return (
    <div className="flex items-baseline justify-between border-b border-neutral-800 px-3 py-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-300">
        {label}
      </span>
      {right && (
        <span className="text-[11px] tabular-nums text-neutral-400">{right}</span>
      )}
    </div>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 py-4 text-center text-xs text-neutral-500">{children}</div>
  );
}

function EmptyAccountsTable({ rows }: { rows: ScannedTokenAccount[] }) {
  return (
    <div>
      <div className="grid grid-cols-12 gap-3 border-b border-neutral-800 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
        <div className="col-span-5">Token account</div>
        <div className="col-span-5">Mint</div>
        <div className="col-span-2 text-right">Reclaim SOL</div>
      </div>
      <div>
        {rows.map((r) => (
          <div
            key={r.tokenAccount}
            className="grid grid-cols-12 items-center gap-3 border-b border-neutral-800 px-3 py-1.5 text-xs last:border-b-0"
          >
            <div className="col-span-5 truncate font-mono text-neutral-100">
              {shortAddr(r.tokenAccount, 6, 6)}
            </div>
            <div className="col-span-5 truncate font-mono text-neutral-300">
              {shortAddr(r.mint, 6, 6)}
            </div>
            <div className="col-span-2 text-right font-semibold tabular-nums text-emerald-300">
              {fmtSol(r.estimatedReclaimSol)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function BurnCandidatesTable({ rows }: { rows: BurnCandidate[] }) {
  return (
    <div>
      <div className="grid grid-cols-12 gap-3 border-b border-red-500/20 bg-red-500/[0.03] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-red-300/80">
        <div className="col-span-3">Token</div>
        <div className="col-span-2">Mint</div>
        <div className="col-span-2 text-right">Amount</div>
        <div className="col-span-1 text-right">Dec.</div>
        <div className="col-span-2 text-right">Reclaim (burn+close)</div>
        <div className="col-span-1">Risk</div>
        <div className="col-span-1">Burn?</div>
      </div>
      <div>
        {rows.map((r) => {
          const tokenLabel = r.symbol ?? r.name ?? null;
          // Rows where burnRecommended=false get a stronger visual: red strip
          // background + red badge in the last column, so the user can't miss
          // that this token needs manual review before any (future) burn.
          const rowTint = r.burnRecommended ? "" : "bg-red-500/[0.06]";
          return (
            <div
              key={r.tokenAccount}
              className={`grid grid-cols-12 items-center gap-3 border-b border-red-500/15 px-3 py-1.5 text-xs last:border-b-0 ${rowTint}`}
            >
              <div className="col-span-3 min-w-0">
                {tokenLabel ? (
                  <>
                    <div className="truncate font-semibold text-neutral-100">
                      {r.symbol ?? "—"}
                    </div>
                    {r.name && (
                      <div className="truncate text-[10px] text-neutral-400">
                        {r.name}
                      </div>
                    )}
                  </>
                ) : (
                  <span className="text-[11px] italic text-neutral-500">
                    unknown token
                  </span>
                )}
              </div>
              <div className="col-span-2 truncate font-mono text-[11px] text-neutral-300">
                {shortAddr(r.mint, 4, 4)}
              </div>
              <div className="col-span-2 text-right tabular-nums text-neutral-100">
                {fmtNumber(r.uiAmount)}
              </div>
              <div className="col-span-1 text-right tabular-nums text-neutral-400">
                {r.decimals}
              </div>
              <div className="col-span-2 text-right font-semibold tabular-nums text-emerald-300/90">
                {fmtSol(r.estimatedReclaimSolAfterBurnAndClose)}
              </div>
              <div className="col-span-1">
                <Badge variant={r.riskLevel === "unknown" ? "warn" : "neutral"}>
                  {r.riskLevel}
                </Badge>
              </div>
              <div className="col-span-1">
                {r.burnRecommended ? (
                  <Badge variant="buy">Yes</Badge>
                ) : (
                  <Badge variant="sell">No</Badge>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

