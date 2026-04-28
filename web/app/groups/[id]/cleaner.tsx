"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import type {
  BuildBurnAndCloseTxResult,
  BuildCloseEmptyTxResult,
  BuildCoreBurnTxResult,
  BuildLegacyNftBurnTxResult,
  BuildPnftBurnTxResult,
  BurnCandidate,
  BurnCandidatesResult,
  CleanupScanResult,
  CoreBurnIncludedEntry,
  CoreBurnSkippedEntry,
  LegacyNftBurnIncludedEntry,
  LegacyNftBurnSkippedEntry,
  PnftBurnIncludedEntry,
  PnftBurnSkippedEntry,
  ScannedTokenAccount,
} from "@/lib/api";
import { fmtNumber, fmtSol, shortAddr } from "@/lib/format";
import {
  buildBurnAndCloseTxAction,
  buildCloseEmptyTxAction,
  buildCoreBurnTxAction,
  buildLegacyNftBurnTxAction,
  buildPnftBurnTxAction,
  scanCleanupAction,
} from "../actions";
import { Badge } from "@/ui-kit/components/Badge";
import { WalletLink } from "@/ui-kit/components/WalletLink";
import { btnPrimary, btnSecondary } from "@/lib/buttonStyles";
import {
  auditBurnAndCloseTx,
  auditCloseEmptyTx,
  auditLegacyNftBurnTx,
  decodeBase64Transaction,
  getProvider,
  solscanTxUrl,
  type BurnAuditResult,
  type InstructionAuditResult,
  type LegacyNftAuditResult,
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
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-700 px-3 py-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-300">
          Group cleaner overview
        </span>
        <span className="inline-flex items-center gap-2">
          {scanned < totalWallets && (
            <span className="text-[11px] text-neutral-500">
              {totalWallets - scanned} wallet
              {totalWallets - scanned === 1 ? "" : "s"} not scanned yet
            </span>
          )}
          <button
            type="button"
            onClick={() => exportCleanerOverviewCsv(wallets, scans)}
            disabled={scanned === 0}
            title={
              scanned === 0
                ? "Scan at least one wallet first"
                : "Download scanned wallets as CSV"
            }
            aria-label="Export cleaner overview as CSV"
            className="rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-[10px] font-semibold text-neutral-300 transition-colors duration-100 hover:border-emerald-500/60 hover:bg-emerald-500/10 hover:text-emerald-200 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-neutral-700 disabled:hover:bg-neutral-900 disabled:hover:text-neutral-300"
          >
            Export CSV ↓
          </button>
        </span>
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
        <CleanerDetails
          scan={state.scan}
          burn={state.burn}
          walletAddress={wallet.address}
        />
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
    if (!canSend || result.transactionBase64 === null) return;
    const provider = getProvider();
    if (!provider) {
      setSend({ status: "error", error: "No wallet provider available." });
      return;
    }
    setSend({ status: "signing" });
    try {
      const tx = decodeBase64Transaction(result.transactionBase64);
      const res = await provider.signAndSendTransaction(tx);
      setSend({ status: "sent", signature: res.signature });
      onSent(res.signature);
    } catch (err) {
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
// sentence. The UI never shows raw provider stack traces.
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

type BurnBuildState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; result: BuildBurnAndCloseTxResult }
  | { status: "error"; error: string };

// =============================================================================
// Unified Cleaner reclaim summary — read-only roll-up of every cleanup/burn
// path. Each burn section (legacy NFT, pNFT, Core) drops its discovery
// result into this context via `useReportReclaim`; the parent renders a
// compact panel at the top of CleanerDetails. Close-empty + SPL-burn values
// are seeded synchronously from the scan / burn-candidates response that
// CleanerDetails already receives as props.
//
// Status semantics (per row):
//   - "ready":    discovery succeeded; `value` is the estimated reclaim SOL.
//   - "loading":  discovery in flight.
//   - "error":    discovery failed.
//   - "empty":    no eligible items in this category.
//   - "rejected": preflight simulation rejected the entire batch (pNFT, Core).
//                 Excluded from the running total per the spec.
// =============================================================================

type ReclaimStatus = "loading" | "ready" | "error" | "empty" | "rejected";
type ReclaimEntry = { value: number | null; status: ReclaimStatus };
type ReclaimKey = "closeEmpty" | "splBurn" | "legacyNft" | "pnft" | "core";
type ReclaimSummaryState = Record<ReclaimKey, ReclaimEntry>;

const ReclaimSummaryCtx = createContext<{
  report: (key: ReclaimKey, entry: ReclaimEntry) => void;
} | null>(null);

function useReportReclaim(key: ReclaimKey, entry: ReclaimEntry): void {
  const ctx = useContext(ReclaimSummaryCtx);
  // Stringify so a fresh object literal each render with the same content
  // doesn't trigger a no-op state update on the parent.
  const entryKey = `${entry.status}:${entry.value ?? "null"}`;
  useEffect(() => {
    if (!ctx) return;
    ctx.report(key, entry);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, key, entryKey]);
}

function CleanerDetails({
  scan,
  burn,
  walletAddress,
}: {
  scan: CleanupScanResult;
  burn: BurnCandidatesResult;
  walletAddress: string;
}) {
  // Selected mints across the burn-candidates table. Mint is the discriminator
  // because the backend uses it as the allowlist key in the build request.
  const [selectedMints, setSelectedMints] = useState<Set<string>>(new Set());
  const [burnBuild, setBurnBuild] = useState<BurnBuildState>({ status: "idle" });
  const [burnPending, startBurnTransition] = useTransition();

  // Reclaim summary state. Close-empty + SPL come straight from the props
  // (synchronously available once CleanerDetails mounts). The three burn
  // sections seed themselves to "loading" and report on discovery via the
  // context below.
  const [summary, setSummary] = useState<ReclaimSummaryState>({
    closeEmpty: {
      value: scan.totals.estimatedReclaimSol,
      status: scan.emptyTokenAccounts.length === 0 ? "empty" : "ready",
    },
    splBurn: {
      value: burn.totalEstimatedReclaimSol,
      status: burn.candidates.length === 0 ? "empty" : "ready",
    },
    legacyNft: { value: null, status: "loading" },
    pnft: { value: null, status: "loading" },
    core: { value: null, status: "loading" },
  });
  const reportReclaim = useCallback(
    (key: ReclaimKey, entry: ReclaimEntry) => {
      setSummary((prev) => {
        const cur = prev[key];
        if (cur.status === entry.status && cur.value === entry.value) return prev;
        return { ...prev, [key]: entry };
      });
    },
    [],
  );
  const reclaimCtx = useMemo(() => ({ report: reportReclaim }), [reportReclaim]);

  function toggleSelected(mint: string): void {
    setSelectedMints((prev) => {
      const next = new Set(prev);
      if (next.has(mint)) next.delete(mint);
      else next.add(mint);
      return next;
    });
  }

  function handleBuildBurnTx(): void {
    if (selectedMints.size === 0) return;
    setBurnBuild({ status: "loading" });
    const mints = Array.from(selectedMints);
    startBurnTransition(async () => {
      const res = await buildBurnAndCloseTxAction(walletAddress, mints);
      if (res.ok) setBurnBuild({ status: "ready", result: res.result });
      else setBurnBuild({ status: "error", error: res.error });
    });
  }

  const canBuild =
    selectedMints.size > 0 &&
    burnBuild.status !== "loading" &&
    !burnPending;

  return (
    <ReclaimSummaryCtx.Provider value={reclaimCtx}>
    <div className="border-t border-neutral-800 bg-neutral-950">
      {/* SECTION 0 — Unified reclaim summary. Read-only roll-up of every
          cleanup/burn path's discovery result. Auto-build/sign is never
          triggered from here. */}
      <ReclaimSummary summary={summary} />

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
          card so it reads as a separate, dangerous surface. Preview-only:
          this UI builds an unsigned tx via the backend and renders it; sign +
          send for burns is intentionally NOT wired to the close-empty
          Sign & send button. */}
      <div className="m-3 overflow-hidden rounded-md border-2 border-red-500/40 bg-red-500/[0.04]">
        <div className="flex items-baseline justify-between border-b border-red-500/30 bg-red-500/10 px-3 py-1.5">
          <span className="text-[10px] font-bold uppercase tracking-wider text-red-300">
            Burn candidates · destructive · preview only
          </span>
          <span className="text-[11px] tabular-nums text-red-300/80">
            {burn.count} · est. reclaim {fmtSol(burn.totalEstimatedReclaimSol)} SOL
          </span>
        </div>
        <div className="border-b border-red-500/20 bg-red-500/5 px-3 py-2 text-[11px] font-semibold text-red-300">
          ⚠ Burning tokens is destructive and irreversible.
        </div>
        {burn.warning && (
          <div className="border-b border-red-500/15 bg-amber-500/5 px-3 py-1.5 text-[11px] text-amber-300">
            ⚠ {burn.warning}
          </div>
        )}
        {burn.candidates.length === 0 ? (
          <EmptyHint>No fungible burn candidates.</EmptyHint>
        ) : (
          <>
            <BurnCandidatesTable
              rows={burn.candidates}
              selected={selectedMints}
              onToggle={toggleSelected}
            />
            <div className="flex flex-wrap items-center gap-2 border-t border-red-500/20 px-3 py-2">
              <button
                type="button"
                onClick={handleBuildBurnTx}
                disabled={!canBuild}
                title={
                  selectedMints.size === 0
                    ? "Select at least one candidate above"
                    : undefined
                }
                aria-label="Build burn transaction"
                className={
                  canBuild
                    ? "inline-flex items-center rounded-lg border-2 border-red-500/60 bg-red-600 px-4 py-2 text-sm font-bold text-white shadow shadow-red-500/30 transition-colors duration-100 hover:bg-red-500"
                    : "inline-flex items-center rounded-lg border-2 border-red-500/30 bg-red-900/30 px-4 py-2 text-sm font-bold text-red-300/60 cursor-not-allowed"
                }
              >
                {burnBuild.status === "loading" || burnPending
                  ? "Building…"
                  : burnBuild.status === "ready"
                  ? "Rebuild burn transaction"
                  : "Build burn transaction"}
              </button>
              <span className="text-[11px] text-red-200/70">
                {selectedMints.size === 0
                  ? "Select at least one candidate to build"
                  : `${selectedMints.size} selected`}
              </span>
            </div>
            {burnBuild.status === "error" && (
              <div className="border-t border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                Build failed: {burnBuild.error}
              </div>
            )}
            {burnBuild.status === "ready" && (
              <BurnTxPreview result={burnBuild.result} />
            )}
          </>
        )}
        <div className="border-t border-red-500/20 bg-neutral-950 px-3 py-2 text-center text-[11px] font-medium text-red-300/80">
          Manual review required. Never burn tokens automatically. Sign + send
          for burns is intentionally not implemented in this UI.
        </div>
      </div>

      {/* SECTION 3 — Legacy Metaplex NFT burn (Milestone 1).
          Distinct red-quarantined card from the SPL fungible burn above.
          Backend BurnV1 reclaims token + metadata + master edition rent. */}
      <LegacyNftBurnSection
        walletAddress={walletAddress}
        nftAccountCount={scan.nftTokenAccounts.length}
      />

      {/* SECTION 4 — Programmable NFT (pNFT) burn (Milestone 2).
          Adds token-record + collection-metadata + auth-rules accounts and
          a backend preflight simulation gate. Visually distinct from the
          legacy NFT card — a slightly deeper red border so the user can't
          confuse the two flows. */}
      <PnftBurnSection
        walletAddress={walletAddress}
        nftAccountCount={scan.nftTokenAccounts.length}
      />

      {/* SECTION 5 — Metaplex Core asset burn (Milestone 3).
          Core assets are NOT held in SPL token accounts — they're standalone
          Core program accounts owned by the wallet. The cleanup-scan above
          doesn't see them, so this section always probes the chain on mount
          (no nftAccountCount gate). Reclaims the Core asset account rent via
          Core BurnV1 and gates on a backend preflight simulation. */}
      <CoreBurnSection walletAddress={walletAddress} />
    </div>
    </ReclaimSummaryCtx.Provider>
  );
}

// Compact reclaim-summary panel rendered at the very top of CleanerDetails.
// Read-only: never triggers a build / sign / select. Per spec:
//   - Show "—" while a section is still loading.
//   - "rejected" status (preflight simulation failed) is excluded from the
//     running total.
//   - "empty" / "error" rows contribute 0 to the total but render a hint so
//     the user knows the value isn't missing data.
function ReclaimSummary({ summary }: { summary: ReclaimSummaryState }) {
  const rows: { key: ReclaimKey; label: string }[] = [
    { key: "closeEmpty", label: "Close empty" },
    { key: "splBurn", label: "SPL burn" },
    { key: "legacyNft", label: "Legacy NFT" },
    { key: "pnft", label: "pNFT" },
    { key: "core", label: "Core" },
  ];

  // Sum all rows where status === "ready". loading / rejected / error /
  // empty all contribute 0.
  let total = 0;
  let anyLoading = false;
  for (const r of rows) {
    const e = summary[r.key];
    if (e.status === "ready" && e.value !== null) total += e.value;
    if (e.status === "loading") anyLoading = true;
  }

  function renderValue(e: ReclaimEntry): React.ReactNode {
    if (e.status === "loading") {
      return <span className="text-neutral-500">—</span>;
    }
    if (e.status === "error") {
      return (
        <span className="text-amber-400/80" title="discovery failed">
          err
        </span>
      );
    }
    if (e.status === "rejected") {
      return (
        <span
          className="text-red-300/80"
          title="preflight simulation rejected — excluded from total"
        >
          rejected
        </span>
      );
    }
    if (e.status === "empty" || e.value === null) {
      return <span className="tabular-nums text-neutral-400">0</span>;
    }
    return (
      <span className="tabular-nums font-semibold text-emerald-300">
        {fmtSol(e.value)}
      </span>
    );
  }

  return (
    <div className="border-b border-neutral-800 bg-neutral-900/60 px-3 py-2">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[10px] font-bold uppercase tracking-wider text-neutral-300">
          Total possible reclaim
        </span>
        <span className="text-[11px] tabular-nums text-neutral-400">
          {anyLoading && <span className="mr-1.5 italic">scanning…</span>}
          <span className="font-bold text-emerald-300">
            {fmtSol(total)}
          </span>{" "}
          SOL
        </span>
      </div>
      <ul className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] sm:grid-cols-3 md:grid-cols-5">
        {rows.map((r) => (
          <li
            key={r.key}
            className="flex items-baseline justify-between gap-2"
          >
            <span className="text-neutral-400">{r.label}</span>
            <span>{renderValue(summary[r.key])}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Burn-specific safety checklist. Renders the audit results plus the
// destructive-action acknowledgement checkbox. Doesn't gate any sign/send
// (none wired yet); kept visible so the user — and any future Sign/Send
// implementation — can read the live status of every contract.
function BurnSafetyChecklist({
  result,
  audit,
  ackDestructive,
  onToggleAck,
}: {
  result: BuildBurnAndCloseTxResult;
  audit: BurnAuditResult | null;
  ackDestructive: boolean;
  onToggleAck: () => void;
}) {
  // When there's no tx (empty branch), don't render the checklist — the
  // top-level "no candidates" state already covers it.
  if (audit === null) return null;

  // burnsPaired covers "every burn followed by close on same account",
  // !hasInvalidTokenOpcode + !hasUnknownProgram covers "only burn + close
  // (and ComputeBudget) instructions". We split them into discrete bullets
  // per spec.
  const onlyBurnClose =
    !audit.hasInvalidTokenOpcode &&
    !audit.hasUnknownProgram &&
    audit.burnsPaired &&
    audit.burnCount > 0 &&
    audit.closeCount > 0;
  const noTransfers = !audit.hasTransfers;
  const burnMatches = audit.burnCount === result.burnCount;
  const closeMatches = audit.closeCount === result.burnCount;

  const items: { ok: boolean; label: React.ReactNode; failHint?: string }[] = [
    {
      ok: onlyBurnClose,
      label: "Only Burn + CloseAccount instructions (plus ComputeBudget)",
      failHint: audit.reason ?? undefined,
    },
    {
      ok: noTransfers,
      label: "No Transfer instructions",
      failHint: audit.hasTransfers ? "Transfer detected — destructive tx is off-spec" : undefined,
    },
    {
      ok: burnMatches,
      label: (
        <>
          Burn count matches preview ({audit.burnCount} ≡ {result.burnCount})
        </>
      ),
      failHint: !burnMatches
        ? `Tx has ${audit.burnCount} burn ix(s) but preview claims ${result.burnCount}`
        : undefined,
    },
    {
      ok: closeMatches,
      label: (
        <>
          CloseAccount count matches preview ({audit.closeCount} ≡{" "}
          {result.burnCount})
        </>
      ),
      failHint: !closeMatches
        ? `Tx has ${audit.closeCount} close ix(s) but preview claims ${result.burnCount}`
        : undefined,
    },
    {
      ok: ackDestructive,
      label: "Destructive action acknowledged (manual)",
    },
  ];

  return (
    <div className="border-b border-red-500/20 bg-red-500/[0.04] px-3 py-2">
      <div className="text-[10px] font-bold uppercase tracking-wider text-red-200">
        Burn safety checklist
      </div>
      <ul className="mt-1 divide-y divide-red-500/10">
        {items.map((item, i) => {
          const isAckRow = i === items.length - 1;
          return (
            <li
              key={i}
              className="flex items-start gap-2 py-1.5 text-[11px]"
            >
              {isAckRow ? (
                <input
                  type="checkbox"
                  checked={ackDestructive}
                  onChange={onToggleAck}
                  aria-label="Acknowledge destructive burn action"
                  className="mt-[2px] h-3.5 w-3.5 cursor-pointer accent-red-500"
                />
              ) : (
                <span
                  aria-hidden
                  className={`mt-[2px] inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full font-bold leading-none ${
                    item.ok
                      ? "bg-emerald-500/20 text-emerald-300"
                      : "bg-red-500/25 text-red-200"
                  }`}
                >
                  {item.ok ? "✓" : "✕"}
                </span>
              )}
              <span
                className={`min-w-0 flex-1 ${
                  item.ok ? "text-neutral-200" : "text-red-200"
                }`}
              >
                {item.label}
                {!item.ok && item.failHint && (
                  <span className="ml-1 text-red-300/80">— {item.failHint}</span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// Read-only preview for the burn-and-close transaction. Visually red /
// destructive — distinct from the violet close-empty preview so the user
// can never confuse the two flows. Crucially: NO sign/send button. The
// existing close-empty Sign & send is also unrelated; reusing it would
// re-broadcast a CloseAccount tx, not a burn.
function BurnTxPreview({ result }: { result: BuildBurnAndCloseTxResult }) {
  // Audit the actual bytes the backend produced. The check is memoised on
  // the base64 string so the panel doesn't redo the deserialize on every
  // re-render of the parent (which happens every checkbox toggle).
  const audit: BurnAuditResult | null = useMemo(() => {
    if (result.transactionBase64 === null) return null;
    return auditBurnAndCloseTx(result.transactionBase64);
  }, [result.transactionBase64]);

  // The acknowledgement checkbox is a per-preview UI gate that doesn't
  // gate any action (no sign/send is wired here yet) but is part of the
  // safety checklist contract per the task spec.
  const [ackDestructive, setAckDestructive] = useState(false);
  const tx = result.transactionBase64;
  const txShort =
    tx === null
      ? "—"
      : tx.length > 80
      ? `${tx.slice(0, 40)}…${tx.slice(-20)} (${tx.length} chars)`
      : tx;
  const rows: { label: string; value: React.ReactNode; mono?: boolean }[] = [
    {
      label: "Burn count",
      value: (
        <span className="font-bold text-red-200">
          {result.burnCount}
          <span className="ml-1 text-red-300/70">
            / {result.totalBurnable} candidate
            {result.totalBurnable === 1 ? "" : "s"}
          </span>
        </span>
      ),
    },
    {
      label: "Included accounts",
      value: (
        <span className="font-bold text-white">
          {result.includedAccounts.length}
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
              (limit {result.maxAccountsPerTx} per tx)
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
    <div className="border-t border-red-500/30 bg-red-950/30">
      <div className="flex items-center justify-between border-b border-red-500/30 bg-red-600/15 px-3 py-1.5">
        <span className="text-[10px] font-bold uppercase tracking-wider text-red-200">
          🔥 Burn + close transaction preview
        </span>
        <Badge variant="sell">unsigned · destructive</Badge>
      </div>
      <div className="border-b border-red-500/20 bg-red-500/10 px-3 py-2 text-[11px] font-semibold text-red-200">
        ⚠ Burning tokens is destructive and irreversible.
      </div>
      {result.warning && (
        <div className="border-b border-red-500/15 bg-amber-500/5 px-3 py-1.5 text-[11px] text-amber-300">
          ⚠ {result.warning}
        </div>
      )}
      <BurnSafetyChecklist
        result={result}
        audit={audit}
        ackDestructive={ackDestructive}
        onToggleAck={() => setAckDestructive((v) => !v)}
      />
      <dl className="divide-y divide-red-500/15">
        {rows.map((r) => (
          <div
            key={r.label}
            className="grid grid-cols-12 items-center gap-3 px-3 py-1.5 text-xs"
          >
            <dt className="col-span-4 text-red-300/80">{r.label}</dt>
            <dd
              className={`col-span-8 min-w-0 break-all ${
                r.mono
                  ? "font-mono text-[11px] text-neutral-100"
                  : "text-neutral-100"
              }`}
            >
              {r.value}
            </dd>
          </div>
        ))}
      </dl>
      <div className="border-t border-red-500/30 bg-neutral-950 px-3 py-2 text-center text-[11px] font-medium text-red-300/80">
        Preview only. Sign + send for burns is intentionally not wired in this UI.
      </div>
    </div>
  );
}

// =============================================================================
// Legacy Metaplex NFT burn — Milestone 1 preview UI.
// Two-phase: (1) discovery call with no mints filter on mount populates the
// candidate list; (2) build call with selected mints produces the actual
// preview tx. Both calls hit POST /legacy-nft-burn-tx. NO sign/send wired.
// =============================================================================

type LegacyDiscoverState =
  | { status: "loading" }
  | { status: "ready"; result: BuildLegacyNftBurnTxResult }
  | { status: "error"; error: string }
  | { status: "empty" }; // no NFT accounts at all

type LegacyBuildState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; result: BuildLegacyNftBurnTxResult }
  | { status: "error"; error: string };

function LegacyNftBurnSection({
  walletAddress,
  nftAccountCount,
}: {
  walletAddress: string;
  nftAccountCount: number;
}) {
  const [discover, setDiscover] = useState<LegacyDiscoverState>(
    nftAccountCount === 0 ? { status: "empty" } : { status: "loading" },
  );
  const [build, setBuild] = useState<LegacyBuildState>({ status: "idle" });
  const [buildPending, startBuildTransition] = useTransition();
  const [selectedMints, setSelectedMints] = useState<Set<string>>(new Set());

  // Discovery: one call with no mints on mount. Captures the candidate list
  // (includedNfts have full metadata; cap-skipped entries surface mint only).
  // We deliberately ignore the discovery call's `transactionBase64` — that's
  // a side-effect of the backend always building a tx for the first ≤3
  // burnable NFTs. The user's *real* preview comes from the Build phase.
  useEffect(() => {
    if (nftAccountCount === 0) return;
    let cancelled = false;
    (async () => {
      const res = await buildLegacyNftBurnTxAction(walletAddress, []);
      if (cancelled) return;
      if (res.ok) setDiscover({ status: "ready", result: res.result });
      else setDiscover({ status: "error", error: res.error });
    })();
    return () => {
      cancelled = true;
    };
  }, [walletAddress, nftAccountCount]);

  // Report this section's discovery to the parent reclaim-summary panel.
  // We use per-NFT × totalBurnable as the upper bound (matches this card's
  // own header). Legacy BurnV1 has no preflight gate, so there's no
  // "rejected" path here.
  const legacyEntry: ReclaimEntry = (() => {
    if (discover.status === "loading")
      return { value: null, status: "loading" };
    if (discover.status === "error")
      return { value: null, status: "error" };
    if (discover.status === "empty")
      return { value: 0, status: "empty" };
    const r = discover.result;
    if (r.totalBurnable === 0) return { value: 0, status: "empty" };
    const per = r.includedNfts[0]?.estimatedGrossReclaimSol ?? 0;
    return { value: per * r.totalBurnable, status: "ready" };
  })();
  useReportReclaim("legacyNft", legacyEntry);

  // Burnable candidates surfaced by discovery: includedNfts (with full
  // metadata) + skippedNfts whose reason indicates batch overflow (these
  // are also burnable, just didn't fit this batch). Non-burnable skipped
  // entries are shown separately, grouped by reason.
  const candidates = useMemo(() => {
    if (discover.status !== "ready") return null;
    const named = discover.result.includedNfts.map((n) => ({
      mint: n.mint,
      tokenAccount: n.tokenAccount,
      name: n.name,
      symbol: n.symbol,
      estimatedGrossReclaimSol: n.estimatedGrossReclaimSol,
    }));
    const overflow = discover.result.skippedNfts
      .filter(
        (s) =>
          s.reason.startsWith("Cap of") || s.reason.startsWith("Trimmed to fit"),
      )
      .map((s) => ({
        mint: s.mint,
        tokenAccount: s.tokenAccount,
        name: null as string | null,
        symbol: null as string | null,
        estimatedGrossReclaimSol: null as number | null,
      }));
    const nonBurnable = discover.result.skippedNfts.filter(
      (s) =>
        !(s.reason.startsWith("Cap of") || s.reason.startsWith("Trimmed to fit")),
    );
    return { burnable: [...named, ...overflow], nonBurnable };
  }, [discover]);

  function toggleSelected(mint: string): void {
    setSelectedMints((prev) => {
      const next = new Set(prev);
      if (next.has(mint)) next.delete(mint);
      else next.add(mint);
      return next;
    });
  }

  function handleBuild(): void {
    if (selectedMints.size === 0) return;
    setBuild({ status: "loading" });
    const mints = Array.from(selectedMints);
    startBuildTransition(async () => {
      const res = await buildLegacyNftBurnTxAction(walletAddress, mints);
      if (res.ok) setBuild({ status: "ready", result: res.result });
      else setBuild({ status: "error", error: res.error });
    });
  }

  const canBuild =
    selectedMints.size > 0 &&
    build.status !== "loading" &&
    !buildPending;

  return (
    <div className="m-3 overflow-hidden rounded-md border-2 border-red-500/40 bg-red-500/[0.04]">
      <div className="flex items-baseline justify-between border-b border-red-500/30 bg-red-500/10 px-3 py-1.5">
        <span className="text-[10px] font-bold uppercase tracking-wider text-red-300">
          Legacy NFT burn · max reclaim
        </span>
        <span className="text-[11px] tabular-nums text-red-300/80">
          {discover.status === "ready"
            ? `${discover.result.totalBurnable} burnable · est. ${fmtSol(
                (discover.result.includedNfts[0]?.estimatedGrossReclaimSol ?? 0) *
                  discover.result.totalBurnable,
              )} SOL`
            : discover.status === "loading"
            ? "scanning…"
            : ""}
        </span>
      </div>
      <div className="border-b border-red-500/20 bg-red-500/5 px-3 py-2 text-[11px] font-semibold text-red-300">
        ⚠ Burning NFTs is destructive and irreversible.
      </div>
      <div className="border-b border-red-500/15 bg-red-950/30 px-3 py-1.5 text-[11px] text-red-200/80">
        ℹ Uses Metaplex BurnV1 and reclaims token account + metadata + master
        edition rent.
      </div>

      {discover.status === "empty" && (
        <EmptyHint>No NFT-shaped token accounts found in this wallet.</EmptyHint>
      )}

      {discover.status === "loading" && (
        <EmptyHint>Discovering legacy NFTs…</EmptyHint>
      )}

      {discover.status === "error" && (
        <div className="bg-red-500/10 px-3 py-2 text-xs text-red-300">
          Discovery failed: {discover.error}
        </div>
      )}

      {discover.status === "ready" && candidates && (
        <>
          {candidates.burnable.length === 0 ? (
            <EmptyHint>
              No legacy Metaplex NFTs eligible for BurnV1. See skipped reasons
              below for non-burnable items.
            </EmptyHint>
          ) : (
            <>
              <LegacyNftCandidatesTable
                rows={candidates.burnable}
                selected={selectedMints}
                onToggle={toggleSelected}
              />
              <div className="flex flex-wrap items-center gap-2 border-t border-red-500/20 px-3 py-2">
                <button
                  type="button"
                  onClick={handleBuild}
                  disabled={!canBuild}
                  title={
                    selectedMints.size === 0
                      ? "Select at least one NFT above"
                      : undefined
                  }
                  aria-label="Build legacy NFT burn transaction"
                  className={
                    canBuild
                      ? "inline-flex items-center rounded-lg border-2 border-red-500/60 bg-red-600 px-4 py-2 text-sm font-bold text-white shadow shadow-red-500/30 transition-colors duration-100 hover:bg-red-500"
                      : "inline-flex items-center rounded-lg border-2 border-red-500/30 bg-red-900/30 px-4 py-2 text-sm font-bold text-red-300/60 cursor-not-allowed"
                  }
                >
                  {build.status === "loading" || buildPending
                    ? "Building…"
                    : build.status === "ready"
                    ? "Rebuild legacy NFT burn"
                    : "Build legacy NFT burn"}
                </button>
                <span className="text-[11px] text-red-200/70">
                  {selectedMints.size === 0
                    ? "Select at least one NFT to build"
                    : `${selectedMints.size} selected · backend caps at 3 per tx`}
                </span>
              </div>
              {build.status === "error" && (
                <div className="border-t border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                  Build failed: {build.error}
                </div>
              )}
              {build.status === "ready" && (
                <LegacyNftBurnPreview result={build.result} />
              )}
            </>
          )}
          {candidates.nonBurnable.length > 0 && (
            <NonBurnableNftSummary entries={candidates.nonBurnable} />
          )}
        </>
      )}

      <div className="border-t border-red-500/20 bg-neutral-950 px-3 py-2 text-center text-[11px] font-medium text-red-300/80">
        Manual review required. Sign + send for legacy NFT burn is not yet
        wired in this UI.
      </div>
    </div>
  );
}

function LegacyNftCandidatesTable({
  rows,
  selected,
  onToggle,
}: {
  rows: {
    mint: string;
    tokenAccount: string;
    name: string | null;
    symbol: string | null;
    estimatedGrossReclaimSol: number | null;
  }[];
  selected: Set<string>;
  onToggle: (mint: string) => void;
}) {
  return (
    <div>
      <div className="grid grid-cols-12 gap-3 border-b border-red-500/20 bg-red-500/[0.03] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-red-300/80">
        <div className="col-span-1">Burn</div>
        <div className="col-span-5">Name</div>
        <div className="col-span-2">Symbol</div>
        <div className="col-span-2">Mint</div>
        <div className="col-span-2 text-right">Reclaim</div>
      </div>
      <div>
        {rows.map((r) => {
          const isChecked = selected.has(r.mint);
          const isBatchOverflow = r.estimatedGrossReclaimSol === null;
          return (
            <label
              key={r.tokenAccount}
              className={`grid cursor-pointer grid-cols-12 items-center gap-3 border-b border-red-500/15 px-3 py-1.5 text-xs last:border-b-0 transition-colors duration-100 hover:bg-red-500/[0.08] ${
                isChecked ? "bg-red-500/[0.06] ring-1 ring-inset ring-red-400/40" : ""
              }`}
            >
              <div className="col-span-1">
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => onToggle(r.mint)}
                  aria-label={`Select ${r.name ?? "NFT"} for burn`}
                  className="h-3.5 w-3.5 cursor-pointer accent-red-500"
                />
              </div>
              <div className="col-span-5 min-w-0">
                {r.name ? (
                  <div className="truncate font-semibold text-neutral-100">
                    {r.name}
                  </div>
                ) : (
                  <span className="text-[11px] italic text-neutral-500">
                    metadata not yet loaded — select to include in next batch
                  </span>
                )}
              </div>
              <div className="col-span-2 truncate text-[11px] text-neutral-300">
                {r.symbol ?? "—"}
              </div>
              <div className="col-span-2 truncate font-mono text-[11px] text-neutral-300">
                {shortAddr(r.mint, 4, 4)}
              </div>
              <div className="col-span-2 text-right font-semibold tabular-nums text-emerald-300/90">
                {isBatchOverflow ? "—" : fmtSol(r.estimatedGrossReclaimSol!)}
              </div>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function NonBurnableNftSummary({
  entries,
}: {
  entries: { reason: string }[];
}) {
  // Group by reason for compact display — typically 200+ entries on a real
  // wallet, dominated by pNFTs.
  const byReason = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of entries) m.set(e.reason, (m.get(e.reason) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [entries]);
  return (
    <div className="border-t border-red-500/20 bg-red-950/20 px-3 py-2">
      <div className="text-[10px] font-bold uppercase tracking-wider text-red-300/80">
        Skipped (not burnable in Milestone 1)
      </div>
      <ul className="mt-1 space-y-0.5 text-[11px] text-red-200/70">
        {byReason.map(([reason, count]) => (
          <li key={reason}>
            <span className="font-semibold text-red-200">{count}×</span>{" "}
            {reason}
          </li>
        ))}
      </ul>
    </div>
  );
}

// Legacy-NFT-specific safety checklist. Mirrors the SPL fungible
// BurnSafetyChecklist visually but checks the legacy-NFT contract: BurnV1
// is the only Metaplex op, no top-level SPL Token Burn / Transfer, audit's
// burnV1Count matches the preview's burnCount, and the user has explicitly
// acknowledged destructiveness via the inline checkbox.
function LegacyNftSafetyChecklist({
  result,
  audit,
  ackDestructive,
  onToggleAck,
}: {
  result: BuildLegacyNftBurnTxResult;
  audit: LegacyNftAuditResult | null;
  ackDestructive: boolean;
  onToggleAck: () => void;
}) {
  if (audit === null) return null;

  const usesBurnV1 =
    audit.burnV1Count > 0 && !audit.hasUnknownProgram && !audit.hasSplTokenBurn;
  const noSplTokenBurn = !audit.hasSplTokenBurn;
  const noTransfers = !audit.hasTransfers;
  const burnMatches = audit.burnV1Count === result.burnCount;

  const items: { ok: boolean; label: React.ReactNode; failHint?: string }[] = [
    {
      ok: usesBurnV1,
      label: "Uses Metaplex BurnV1 (no other Metaplex ix)",
      failHint: !usesBurnV1
        ? audit.reason ?? "BurnV1 not detected"
        : undefined,
    },
    {
      ok: noSplTokenBurn,
      label: "No top-level SPL Token Burn instruction",
      failHint: audit.hasSplTokenBurn
        ? "Top-level SPL Token Burn detected — legacy NFT burn must use Metaplex BurnV1"
        : undefined,
    },
    {
      ok: noTransfers,
      label: "No Transfer instructions",
      failHint: audit.hasTransfers ? "Top-level token Transfer detected" : undefined,
    },
    {
      ok: burnMatches,
      label: (
        <>
          Burn count matches preview ({audit.burnV1Count} ≡ {result.burnCount})
        </>
      ),
      failHint: !burnMatches
        ? `Tx has ${audit.burnV1Count} BurnV1 ix(s) but preview claims ${result.burnCount}`
        : undefined,
    },
    {
      ok: ackDestructive,
      label: "Destructive action acknowledged (manual)",
    },
  ];

  return (
    <div className="border-b border-red-500/20 bg-red-500/[0.04] px-3 py-2">
      <div className="text-[10px] font-bold uppercase tracking-wider text-red-200">
        Legacy NFT burn safety checklist
      </div>
      <ul className="mt-1 divide-y divide-red-500/10">
        {items.map((item, i) => {
          const isAckRow = i === items.length - 1;
          return (
            <li
              key={i}
              className="flex items-start gap-2 py-1.5 text-[11px]"
            >
              {isAckRow ? (
                <input
                  type="checkbox"
                  checked={ackDestructive}
                  onChange={onToggleAck}
                  aria-label="Acknowledge destructive legacy NFT burn"
                  className="mt-[2px] h-3.5 w-3.5 cursor-pointer accent-red-500"
                />
              ) : (
                <span
                  aria-hidden
                  className={`mt-[2px] inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full font-bold leading-none ${
                    item.ok
                      ? "bg-emerald-500/20 text-emerald-300"
                      : "bg-red-500/25 text-red-200"
                  }`}
                >
                  {item.ok ? "✓" : "✕"}
                </span>
              )}
              <span
                className={`min-w-0 flex-1 ${
                  item.ok ? "text-neutral-200" : "text-red-200"
                }`}
              >
                {item.label}
                {!item.ok && item.failHint && (
                  <span className="ml-1 text-red-300/80">— {item.failHint}</span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function LegacyNftBurnPreview({
  result,
}: {
  result: BuildLegacyNftBurnTxResult;
}) {
  // Audit the actual produced bytes. Memoised on the base64 string so the
  // ack-checkbox toggle doesn't redo the deserialize on every render.
  const audit: LegacyNftAuditResult | null = useMemo(() => {
    if (result.transactionBase64 === null) return null;
    return auditLegacyNftBurnTx(result.transactionBase64);
  }, [result.transactionBase64]);
  const [ackDestructive, setAckDestructive] = useState(false);

  const tx = result.transactionBase64;
  const txShort =
    tx === null
      ? "—"
      : tx.length > 80
      ? `${tx.slice(0, 40)}…${tx.slice(-20)} (${tx.length} chars)`
      : tx;

  const rows: { label: string; value: React.ReactNode; mono?: boolean }[] = [
    {
      label: "Burn count",
      value: (
        <span className="font-bold text-red-200">
          {result.burnCount}
          <span className="ml-1 text-red-300/70">
            / {result.totalBurnable} eligible
          </span>
        </span>
      ),
    },
    {
      label: "Gross reclaim",
      value: (
        <span className="font-bold text-emerald-300">
          {fmtSol(result.estimatedGrossReclaimSol)} SOL
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
    <div className="border-t border-red-500/30 bg-red-950/30">
      <div className="flex items-center justify-between border-b border-red-500/30 bg-red-600/15 px-3 py-1.5">
        <span className="text-[10px] font-bold uppercase tracking-wider text-red-200">
          🔥 Legacy NFT burn preview
        </span>
        <Badge variant="sell">unsigned · destructive</Badge>
      </div>
      <div className="border-b border-red-500/20 bg-red-500/10 px-3 py-2 text-[11px] font-semibold text-red-200">
        ⚠ Burning NFTs is destructive and irreversible.
      </div>
      {result.warning && (
        <div className="border-b border-red-500/15 bg-amber-500/5 px-3 py-1.5 text-[11px] text-amber-300">
          ⚠ {result.warning}
        </div>
      )}
      <LegacyNftSafetyChecklist
        result={result}
        audit={audit}
        ackDestructive={ackDestructive}
        onToggleAck={() => setAckDestructive((v) => !v)}
      />
      {result.includedNfts.length > 0 && (
        <ul className="divide-y divide-red-500/15 border-b border-red-500/15">
          {result.includedNfts.map((n: LegacyNftBurnIncludedEntry) => (
            <li
              key={n.tokenAccount}
              className="grid grid-cols-12 items-center gap-3 px-3 py-1.5 text-xs"
            >
              <div className="col-span-5 min-w-0">
                <div className="truncate font-semibold text-neutral-100">
                  {n.name ?? "—"}
                </div>
                <div className="truncate font-mono text-[10px] text-neutral-400">
                  {shortAddr(n.mint, 4, 4)}
                </div>
              </div>
              <div className="col-span-2 truncate text-[11px] text-neutral-300">
                {n.symbol ?? "—"}
              </div>
              <div className="col-span-2 truncate text-[10px] text-neutral-500">
                {n.reason}
              </div>
              <div className="col-span-3 text-right font-semibold tabular-nums text-emerald-300/90">
                {fmtSol(n.estimatedGrossReclaimSol)} SOL
              </div>
            </li>
          ))}
        </ul>
      )}
      {result.skippedNfts.length > 0 && (
        <NonBurnableNftSummary entries={result.skippedNfts} />
      )}
      <dl className="divide-y divide-red-500/15">
        {rows.map((r) => (
          <div
            key={r.label}
            className="grid grid-cols-12 items-center gap-3 px-3 py-1.5 text-xs"
          >
            <dt className="col-span-4 text-red-300/80">{r.label}</dt>
            <dd
              className={`col-span-8 min-w-0 break-all ${
                r.mono
                  ? "font-mono text-[11px] text-neutral-100"
                  : "text-neutral-100"
              }`}
            >
              {r.value}
            </dd>
          </div>
        ))}
      </dl>
      <div className="border-t border-red-500/30 bg-neutral-950 px-3 py-2 text-center text-[11px] font-medium text-red-300/80">
        Preview only. Sign + send for legacy NFT burn is intentionally not
        wired in this UI.
      </div>
    </div>
  );
}

// =============================================================================
// pNFT burn — Milestone 2 preview UI.
// Same two-phase pattern as LegacyNftBurnSection. Differs in:
//   - Backend response shape (includedPnfts / skippedPnfts / simulationOk).
//   - Adds a preflight simulation badge (Ok / Failed with reason).
//   - Slightly deeper red border so the section is visually distinct from
//     the legacy NFT card just above it.
// =============================================================================

type PnftDiscoverState =
  | { status: "loading" }
  | { status: "ready"; result: BuildPnftBurnTxResult }
  | { status: "error"; error: string }
  | { status: "empty" };

type PnftBuildState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; result: BuildPnftBurnTxResult }
  | { status: "error"; error: string };

function PnftBurnSection({
  walletAddress,
  nftAccountCount,
}: {
  walletAddress: string;
  nftAccountCount: number;
}) {
  const [discover, setDiscover] = useState<PnftDiscoverState>(
    nftAccountCount === 0 ? { status: "empty" } : { status: "loading" },
  );
  const [build, setBuild] = useState<PnftBuildState>({ status: "idle" });
  const [buildPending, startBuildTransition] = useTransition();
  const [selectedMints, setSelectedMints] = useState<Set<string>>(new Set());

  // Discovery: one no-mints call on mount. Returns up to N pNFTs in
  // includedPnfts (with full metadata) plus the rest in skippedPnfts.
  // We ignore the discovery call's transactionBase64 — that's a tx for a
  // default 2-pNFT batch the user didn't choose. The build phase fires the
  // user's actual selection.
  useEffect(() => {
    if (nftAccountCount === 0) return;
    let cancelled = false;
    (async () => {
      const res = await buildPnftBurnTxAction(walletAddress, []);
      if (cancelled) return;
      if (res.ok) setDiscover({ status: "ready", result: res.result });
      else setDiscover({ status: "error", error: res.error });
    })();
    return () => {
      cancelled = true;
    };
  }, [walletAddress, nftAccountCount]);

  // Report this section's discovery to the parent reclaim-summary panel.
  // pNFT has a preflight simulation gate — if discovery's simulationOk is
  // false, the entire batch is currently un-burnable. Per the spec, do not
  // include rejected items in the running total.
  const pnftEntry: ReclaimEntry = (() => {
    if (discover.status === "loading")
      return { value: null, status: "loading" };
    if (discover.status === "error")
      return { value: null, status: "error" };
    if (discover.status === "empty")
      return { value: 0, status: "empty" };
    const r = discover.result;
    if (r.totalBurnable === 0) return { value: 0, status: "empty" };
    if (!r.simulationOk) return { value: null, status: "rejected" };
    const per = r.includedPnfts[0]?.estimatedGrossReclaimSol ?? 0;
    return { value: per * r.totalBurnable, status: "ready" };
  })();
  useReportReclaim("pnft", pnftEntry);

  // Burnable candidates surfaced by discovery: includedPnfts (with full
  // metadata) + skippedPnfts whose reason indicates batch overflow. The
  // overflow rows don't carry name/symbol — backend's skip envelope is
  // mint-only — but the user can still pick them; build phase resolves
  // metadata for the selected set.
  const candidates = useMemo(() => {
    if (discover.status !== "ready") return null;
    const named = discover.result.includedPnfts.map((n) => ({
      mint: n.mint,
      tokenAccount: n.tokenAccount,
      name: n.name,
      symbol: n.symbol,
      estimatedGrossReclaimSol: n.estimatedGrossReclaimSol,
    }));
    const overflow = discover.result.skippedPnfts
      .filter(
        (s) =>
          s.reason.startsWith("Cap of") || s.reason.startsWith("Trimmed to fit"),
      )
      .map((s) => ({
        mint: s.mint,
        tokenAccount: s.tokenAccount,
        name: null as string | null,
        symbol: null as string | null,
        estimatedGrossReclaimSol: null as number | null,
      }));
    const nonBurnable = discover.result.skippedPnfts.filter(
      (s) =>
        !(s.reason.startsWith("Cap of") || s.reason.startsWith("Trimmed to fit")),
    );
    return { burnable: [...named, ...overflow], nonBurnable };
  }, [discover]);

  function toggleSelected(mint: string): void {
    setSelectedMints((prev) => {
      const next = new Set(prev);
      if (next.has(mint)) next.delete(mint);
      else next.add(mint);
      return next;
    });
  }

  function handleBuild(): void {
    if (selectedMints.size === 0) return;
    setBuild({ status: "loading" });
    const mints = Array.from(selectedMints);
    startBuildTransition(async () => {
      const res = await buildPnftBurnTxAction(walletAddress, mints);
      if (res.ok) setBuild({ status: "ready", result: res.result });
      else setBuild({ status: "error", error: res.error });
    });
  }

  const canBuild =
    selectedMints.size > 0 &&
    build.status !== "loading" &&
    !buildPending;

  return (
    <div className="m-3 overflow-hidden rounded-md border-2 border-red-600/50 bg-red-500/[0.05]">
      <div className="flex items-baseline justify-between border-b border-red-600/40 bg-red-600/15 px-3 py-1.5">
        <span className="text-[10px] font-bold uppercase tracking-wider text-red-200">
          pNFT burn · max reclaim
        </span>
        <span className="text-[11px] tabular-nums text-red-200/80">
          {discover.status === "ready"
            ? `${discover.result.totalBurnable} burnable · est. ${fmtSol(
                (discover.result.includedPnfts[0]?.estimatedGrossReclaimSol ?? 0) *
                  discover.result.totalBurnable,
              )} SOL`
            : discover.status === "loading"
            ? "scanning…"
            : ""}
        </span>
      </div>
      <div className="border-b border-red-500/20 bg-red-500/10 px-3 py-2 text-[11px] font-semibold text-red-200">
        ⚠ Burning pNFTs is destructive and irreversible.
      </div>
      <div className="border-b border-red-500/15 bg-red-950/30 px-3 py-1.5 text-[11px] text-red-200/80">
        ℹ Uses Metaplex BurnV1 with token record, collection metadata, and
        auth-rules when required.
      </div>

      {discover.status === "empty" && (
        <EmptyHint>No NFT-shaped token accounts found in this wallet.</EmptyHint>
      )}
      {discover.status === "loading" && (
        <EmptyHint>Discovering pNFTs…</EmptyHint>
      )}
      {discover.status === "error" && (
        <div className="bg-red-500/10 px-3 py-2 text-xs text-red-300">
          Discovery failed: {discover.error}
        </div>
      )}

      {discover.status === "ready" && candidates && (
        <>
          {candidates.burnable.length === 0 ? (
            <EmptyHint>
              No pNFTs eligible for BurnV1 in this wallet. See skipped reasons
              below — pNFTs with missing token records or unsupported standards
              don't qualify in this milestone.
            </EmptyHint>
          ) : (
            <>
              <PnftCandidatesTable
                rows={candidates.burnable}
                selected={selectedMints}
                onToggle={toggleSelected}
              />
              <div className="flex flex-wrap items-center gap-2 border-t border-red-500/20 px-3 py-2">
                <button
                  type="button"
                  onClick={handleBuild}
                  disabled={!canBuild}
                  title={
                    selectedMints.size === 0
                      ? "Select at least one pNFT above"
                      : undefined
                  }
                  aria-label="Build pNFT burn transaction"
                  className={
                    canBuild
                      ? "inline-flex items-center rounded-lg border-2 border-red-600/70 bg-red-700 px-4 py-2 text-sm font-bold text-white shadow shadow-red-700/40 transition-colors duration-100 hover:bg-red-600"
                      : "inline-flex items-center rounded-lg border-2 border-red-500/30 bg-red-900/30 px-4 py-2 text-sm font-bold text-red-300/60 cursor-not-allowed"
                  }
                >
                  {build.status === "loading" || buildPending
                    ? "Building…"
                    : build.status === "ready"
                    ? "Rebuild pNFT burn"
                    : "Build pNFT burn"}
                </button>
                <span className="text-[11px] text-red-200/70">
                  {selectedMints.size === 0
                    ? "Select at least one pNFT to build"
                    : `${selectedMints.size} selected · backend caps at 2 per tx`}
                </span>
              </div>
              {build.status === "error" && (
                <div className="border-t border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                  Build failed: {build.error}
                </div>
              )}
              {build.status === "ready" && (
                <PnftBurnPreview result={build.result} />
              )}
            </>
          )}
          {candidates.nonBurnable.length > 0 && (
            <NonBurnableNftSummary entries={candidates.nonBurnable} />
          )}
        </>
      )}

      <div className="border-t border-red-500/20 bg-neutral-950 px-3 py-2 text-center text-[11px] font-medium text-red-300/80">
        Manual review required. Sign + send for pNFT burn is not yet wired in
        this UI.
      </div>
    </div>
  );
}

function PnftCandidatesTable({
  rows,
  selected,
  onToggle,
}: {
  rows: {
    mint: string;
    tokenAccount: string;
    name: string | null;
    symbol: string | null;
    estimatedGrossReclaimSol: number | null;
  }[];
  selected: Set<string>;
  onToggle: (mint: string) => void;
}) {
  return (
    <div>
      <div className="grid grid-cols-12 gap-3 border-b border-red-600/20 bg-red-600/[0.05] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-red-200/80">
        <div className="col-span-1">Burn</div>
        <div className="col-span-5">Name</div>
        <div className="col-span-2">Symbol</div>
        <div className="col-span-2">Mint</div>
        <div className="col-span-2 text-right">Reclaim</div>
      </div>
      <div>
        {rows.map((r) => {
          const isChecked = selected.has(r.mint);
          const isBatchOverflow = r.estimatedGrossReclaimSol === null;
          return (
            <label
              key={r.tokenAccount}
              className={`grid cursor-pointer grid-cols-12 items-center gap-3 border-b border-red-600/15 px-3 py-1.5 text-xs last:border-b-0 transition-colors duration-100 hover:bg-red-600/[0.10] ${
                isChecked ? "bg-red-600/[0.10] ring-1 ring-inset ring-red-400/40" : ""
              }`}
            >
              <div className="col-span-1">
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => onToggle(r.mint)}
                  aria-label={`Select ${r.name ?? "pNFT"} for burn`}
                  className="h-3.5 w-3.5 cursor-pointer accent-red-600"
                />
              </div>
              <div className="col-span-5 min-w-0">
                {r.name ? (
                  <div className="truncate font-semibold text-neutral-100">
                    {r.name}
                  </div>
                ) : (
                  <span className="text-[11px] italic text-neutral-500">
                    metadata not yet loaded — select to include in next batch
                  </span>
                )}
              </div>
              <div className="col-span-2 truncate text-[11px] text-neutral-300">
                {r.symbol ?? "—"}
              </div>
              <div className="col-span-2 truncate font-mono text-[11px] text-neutral-300">
                {shortAddr(r.mint, 4, 4)}
              </div>
              <div className="col-span-2 text-right font-semibold tabular-nums text-emerald-300/90">
                {isBatchOverflow ? "—" : fmtSol(r.estimatedGrossReclaimSol!)}
              </div>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function PnftBurnPreview({ result }: { result: BuildPnftBurnTxResult }) {
  const tx = result.transactionBase64;
  const txShort =
    tx === null
      ? "—"
      : tx.length > 80
      ? `${tx.slice(0, 40)}…${tx.slice(-20)} (${tx.length} chars)`
      : tx;

  const rows: { label: string; value: React.ReactNode; mono?: boolean }[] = [
    {
      label: "Burn count",
      value: (
        <span className="font-bold text-red-200">
          {result.burnCount}
          <span className="ml-1 text-red-300/70">
            / {result.totalBurnable} eligible
          </span>
        </span>
      ),
    },
    {
      label: "Preflight simulation",
      value: result.simulationOk ? (
        <span className="inline-flex items-center gap-1.5 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] font-bold text-emerald-300 ring-1 ring-emerald-500/30">
          ✓ Passed
        </span>
      ) : (
        <span className="inline-flex flex-col gap-0.5">
          <span className="inline-flex w-fit items-center gap-1.5 rounded bg-red-500/15 px-1.5 py-0.5 text-[11px] font-bold text-red-300 ring-1 ring-red-500/30">
            ✕ Rejected
          </span>
          {result.simulationError && (
            <span className="text-[10px] text-red-300/80">
              {result.simulationError}
            </span>
          )}
        </span>
      ),
    },
    {
      label: "Gross reclaim",
      value: (
        <span className="font-bold text-emerald-300">
          {fmtSol(result.estimatedGrossReclaimSol)} SOL
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
    <div className="border-t border-red-600/30 bg-red-950/35">
      <div className="flex items-center justify-between border-b border-red-600/40 bg-red-700/20 px-3 py-1.5">
        <span className="text-[10px] font-bold uppercase tracking-wider text-red-200">
          🔥 pNFT burn preview
        </span>
        <Badge variant="sell">unsigned · destructive</Badge>
      </div>
      <div className="border-b border-red-500/20 bg-red-500/10 px-3 py-2 text-[11px] font-semibold text-red-200">
        ⚠ Burning pNFTs is destructive and irreversible.
      </div>
      {result.warning && (
        <div className="border-b border-red-500/15 bg-amber-500/5 px-3 py-1.5 text-[11px] text-amber-300">
          ⚠ {result.warning}
        </div>
      )}
      {result.includedPnfts.length > 0 && (
        <ul className="divide-y divide-red-600/15 border-b border-red-600/15">
          {result.includedPnfts.map((n: PnftBurnIncludedEntry) => (
            <li
              key={n.tokenAccount}
              className="grid grid-cols-12 items-center gap-3 px-3 py-1.5 text-xs"
            >
              <div className="col-span-5 min-w-0">
                <div className="truncate font-semibold text-neutral-100">
                  {n.name ?? "—"}
                </div>
                <div className="truncate font-mono text-[10px] text-neutral-400">
                  {shortAddr(n.mint, 4, 4)}
                </div>
              </div>
              <div className="col-span-2 truncate text-[11px] text-neutral-300">
                {n.symbol ?? "—"}
              </div>
              <div className="col-span-2 truncate text-[10px] text-neutral-500">
                {n.reason}
              </div>
              <div className="col-span-3 text-right font-semibold tabular-nums text-emerald-300/90">
                {fmtSol(n.estimatedGrossReclaimSol)} SOL
              </div>
            </li>
          ))}
        </ul>
      )}
      {result.skippedPnfts.length > 0 && (
        <NonBurnableNftSummary
          entries={result.skippedPnfts as PnftBurnSkippedEntry[]}
        />
      )}
      <dl className="divide-y divide-red-600/15">
        {rows.map((r) => (
          <div
            key={r.label}
            className="grid grid-cols-12 items-center gap-3 px-3 py-1.5 text-xs"
          >
            <dt className="col-span-4 text-red-300/80">{r.label}</dt>
            <dd
              className={`col-span-8 min-w-0 break-all ${
                r.mono
                  ? "font-mono text-[11px] text-neutral-100"
                  : "text-neutral-100"
              }`}
            >
              {r.value}
            </dd>
          </div>
        ))}
      </dl>
      <div className="border-t border-red-600/30 bg-neutral-950 px-3 py-2 text-center text-[11px] font-medium text-red-300/80">
        Preview only. Sign + send for pNFT burn is intentionally not wired in
        this UI.
      </div>
    </div>
  );
}

// =============================================================================
// Metaplex Core asset burn — Milestone 3 preview UI.
// Same two-phase pattern as PnftBurnSection. Differs in:
//   - Discovers via Core program (getProgramAccounts) — independent of
//     scan.nftTokenAccounts, which only enumerates SPL token accounts.
//   - Selection key is the Core asset address (no SPL "mint" for Core).
//   - Backend body uses `assetIds`, response uses `includedAssets` /
//     `skippedAssets`.
//   - Slightly deeper red (red-700) border so the section is visually
//     distinct from the pNFT (red-600) and legacy NFT (red-500) cards above.
// =============================================================================

type CoreDiscoverState =
  | { status: "loading" }
  | { status: "ready"; result: BuildCoreBurnTxResult }
  | { status: "error"; error: string };

type CoreBuildState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; result: BuildCoreBurnTxResult }
  | { status: "error"; error: string };

function CoreBurnSection({ walletAddress }: { walletAddress: string }) {
  const [discover, setDiscover] = useState<CoreDiscoverState>({
    status: "loading",
  });
  const [build, setBuild] = useState<CoreBuildState>({ status: "idle" });
  const [buildPending, startBuildTransition] = useTransition();
  const [selectedAssets, setSelectedAssets] = useState<Set<string>>(new Set());

  // Discovery: one no-assetIds call on mount. Backend probes the Core
  // program for AssetV1 accounts owned by the wallet and returns up to N
  // burnable in includedAssets, with the rest in skippedAssets. The
  // discovery tx is for a default batch — we ignore it and rebuild against
  // the user's selection in the build phase.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await buildCoreBurnTxAction(walletAddress, []);
      if (cancelled) return;
      if (res.ok) setDiscover({ status: "ready", result: res.result });
      else setDiscover({ status: "error", error: res.error });
    })();
    return () => {
      cancelled = true;
    };
  }, [walletAddress]);

  // Report this section's discovery to the parent reclaim-summary panel.
  // Core also has a preflight simulation gate (Permanent Freeze /
  // Burn-Delegate plugins, etc.). If simulationOk is false, exclude this
  // section's value from the running total per spec.
  const coreEntry: ReclaimEntry = (() => {
    if (discover.status === "loading")
      return { value: null, status: "loading" };
    if (discover.status === "error")
      return { value: null, status: "error" };
    const r = discover.result;
    if (r.totalBurnable === 0) return { value: 0, status: "empty" };
    if (!r.simulationOk) return { value: null, status: "rejected" };
    const per = r.includedAssets[0]?.estimatedGrossReclaimSol ?? 0;
    return { value: per * r.totalBurnable, status: "ready" };
  })();
  useReportReclaim("core", coreEntry);

  // Burnable candidates: includedAssets (full metadata) + skippedAssets
  // whose reason indicates batch overflow (the user can select them; build
  // phase will resolve metadata for the chosen set).
  const candidates = useMemo(() => {
    if (discover.status !== "ready") return null;
    const named = discover.result.includedAssets.map((a) => ({
      asset: a.asset,
      collection: a.collection,
      name: a.name,
      uri: a.uri,
      estimatedGrossReclaimSol: a.estimatedGrossReclaimSol,
    }));
    const overflow = discover.result.skippedAssets
      .filter(
        (s) =>
          s.reason.startsWith("Cap of") || s.reason.startsWith("Trimmed to fit"),
      )
      .map((s) => ({
        asset: s.asset,
        collection: null as string | null,
        name: null as string | null,
        uri: null as string | null,
        estimatedGrossReclaimSol: null as number | null,
      }));
    const nonBurnable = discover.result.skippedAssets.filter(
      (s) =>
        !(s.reason.startsWith("Cap of") || s.reason.startsWith("Trimmed to fit")),
    );
    return { burnable: [...named, ...overflow], nonBurnable };
  }, [discover]);

  function toggleSelected(asset: string): void {
    setSelectedAssets((prev) => {
      const next = new Set(prev);
      if (next.has(asset)) next.delete(asset);
      else next.add(asset);
      return next;
    });
  }

  function handleBuild(): void {
    if (selectedAssets.size === 0) return;
    setBuild({ status: "loading" });
    const assetIds = Array.from(selectedAssets);
    startBuildTransition(async () => {
      const res = await buildCoreBurnTxAction(walletAddress, assetIds);
      if (res.ok) setBuild({ status: "ready", result: res.result });
      else setBuild({ status: "error", error: res.error });
    });
  }

  const canBuild =
    selectedAssets.size > 0 &&
    build.status !== "loading" &&
    !buildPending;

  return (
    <div className="m-3 overflow-hidden rounded-md border-2 border-red-700/60 bg-red-700/[0.06]">
      <div className="flex items-baseline justify-between border-b border-red-700/50 bg-red-700/20 px-3 py-1.5">
        <span className="text-[10px] font-bold uppercase tracking-wider text-red-200">
          Core asset burn · max reclaim
        </span>
        <span className="text-[11px] tabular-nums text-red-200/80">
          {discover.status === "ready"
            ? `${discover.result.totalBurnable} burnable`
            : discover.status === "loading"
            ? "scanning…"
            : ""}
        </span>
      </div>
      <div className="border-b border-red-600/25 bg-red-600/10 px-3 py-2 text-[11px] font-semibold text-red-200">
        ⚠ Burning Core assets is destructive and irreversible.
      </div>
      <div className="border-b border-red-600/20 bg-red-950/30 px-3 py-1.5 text-[11px] text-red-200/80">
        ℹ Uses Metaplex Core BurnV1 and reclaims the Core asset account rent.
      </div>

      {discover.status === "loading" && (
        <EmptyHint>Discovering Core assets…</EmptyHint>
      )}
      {discover.status === "error" && (
        <div className="bg-red-600/10 px-3 py-2 text-xs text-red-300">
          Discovery failed: {discover.error}
        </div>
      )}

      {discover.status === "ready" && candidates && (
        <>
          {candidates.burnable.length === 0 &&
          candidates.nonBurnable.length === 0 ? (
            <EmptyHint>
              No Metaplex Core assets found in this wallet.
            </EmptyHint>
          ) : candidates.burnable.length === 0 ? (
            <EmptyHint>
              No Core assets eligible for BurnV1 in this wallet. See skipped
              reasons below — assets with permanent freeze/burn delegates or
              unsupported plugins are not burnable here.
            </EmptyHint>
          ) : (
            <>
              <CoreCandidatesTable
                rows={candidates.burnable}
                selected={selectedAssets}
                onToggle={toggleSelected}
              />
              <div className="flex flex-wrap items-center gap-2 border-t border-red-600/25 px-3 py-2">
                <button
                  type="button"
                  onClick={handleBuild}
                  disabled={!canBuild}
                  title={
                    selectedAssets.size === 0
                      ? "Select at least one Core asset above"
                      : undefined
                  }
                  aria-label="Build Core asset burn transaction"
                  className={
                    canBuild
                      ? "inline-flex items-center rounded-lg border-2 border-red-700/80 bg-red-800 px-4 py-2 text-sm font-bold text-white shadow shadow-red-800/40 transition-colors duration-100 hover:bg-red-700"
                      : "inline-flex items-center rounded-lg border-2 border-red-600/30 bg-red-900/30 px-4 py-2 text-sm font-bold text-red-300/60 cursor-not-allowed"
                  }
                >
                  {build.status === "loading" || buildPending
                    ? "Building…"
                    : build.status === "ready"
                    ? "Rebuild Core burn"
                    : "Build Core burn"}
                </button>
                <span className="text-[11px] text-red-200/70">
                  {selectedAssets.size === 0
                    ? "Select at least one Core asset to build"
                    : `${selectedAssets.size} selected · backend caps per tx`}
                </span>
              </div>
              {build.status === "error" && (
                <div className="border-t border-red-600/30 bg-red-600/10 px-3 py-2 text-xs text-red-300">
                  Build failed: {build.error}
                </div>
              )}
              {build.status === "ready" && (
                <CoreBurnPreview result={build.result} />
              )}
            </>
          )}
          {candidates.nonBurnable.length > 0 && (
            <NonBurnableNftSummary entries={candidates.nonBurnable} />
          )}
        </>
      )}

      <div className="border-t border-red-600/25 bg-neutral-950 px-3 py-2 text-center text-[11px] font-medium text-red-300/80">
        Manual review required. Sign + send for Core asset burn is not yet
        wired in this UI.
      </div>
    </div>
  );
}

function CoreCandidatesTable({
  rows,
  selected,
  onToggle,
}: {
  rows: {
    asset: string;
    collection: string | null;
    name: string | null;
    uri: string | null;
    estimatedGrossReclaimSol: number | null;
  }[];
  selected: Set<string>;
  onToggle: (asset: string) => void;
}) {
  return (
    <div>
      <div className="grid grid-cols-12 gap-3 border-b border-red-700/25 bg-red-700/[0.06] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-red-200/80">
        <div className="col-span-1">Burn</div>
        <div className="col-span-6">Name</div>
        <div className="col-span-3">Asset</div>
        <div className="col-span-2 text-right">Reclaim</div>
      </div>
      <div>
        {rows.map((r) => {
          const isChecked = selected.has(r.asset);
          const isBatchOverflow = r.estimatedGrossReclaimSol === null;
          return (
            <label
              key={r.asset}
              className={`grid cursor-pointer grid-cols-12 items-center gap-3 border-b border-red-700/20 px-3 py-1.5 text-xs last:border-b-0 transition-colors duration-100 hover:bg-red-700/[0.10] ${
                isChecked
                  ? "bg-red-700/[0.10] ring-1 ring-inset ring-red-400/40"
                  : ""
              }`}
            >
              <div className="col-span-1">
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => onToggle(r.asset)}
                  aria-label={`Select ${r.name ?? "Core asset"} for burn`}
                  className="h-3.5 w-3.5 cursor-pointer accent-red-700"
                />
              </div>
              <div className="col-span-6 min-w-0">
                {r.name ? (
                  <>
                    <div className="truncate font-semibold text-neutral-100">
                      {r.name}
                    </div>
                    {r.collection && (
                      <div className="truncate font-mono text-[10px] text-neutral-400">
                        coll {shortAddr(r.collection, 4, 4)}
                      </div>
                    )}
                  </>
                ) : (
                  <span className="text-[11px] italic text-neutral-500">
                    metadata not yet loaded — select to include in next batch
                  </span>
                )}
              </div>
              <div className="col-span-3 truncate font-mono text-[11px] text-neutral-300">
                {shortAddr(r.asset, 4, 4)}
              </div>
              <div className="col-span-2 text-right font-semibold tabular-nums text-emerald-300/90">
                {isBatchOverflow ? "—" : fmtSol(r.estimatedGrossReclaimSol!)}
              </div>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function CoreBurnPreview({ result }: { result: BuildCoreBurnTxResult }) {
  const tx = result.transactionBase64;
  const txShort =
    tx === null
      ? "—"
      : tx.length > 80
      ? `${tx.slice(0, 40)}…${tx.slice(-20)} (${tx.length} chars)`
      : tx;

  const rows: { label: string; value: React.ReactNode; mono?: boolean }[] = [
    {
      label: "Burn count",
      value: (
        <span className="font-bold text-red-200">
          {result.burnCount}
          <span className="ml-1 text-red-300/70">
            / {result.totalBurnable} eligible
          </span>
        </span>
      ),
    },
    {
      label: "Preflight simulation",
      value: result.simulationOk ? (
        <span className="inline-flex items-center gap-1.5 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] font-bold text-emerald-300 ring-1 ring-emerald-500/30">
          ✓ Passed
        </span>
      ) : (
        <span className="inline-flex flex-col gap-0.5">
          <span className="inline-flex w-fit items-center gap-1.5 rounded bg-red-500/15 px-1.5 py-0.5 text-[11px] font-bold text-red-300 ring-1 ring-red-500/30">
            ✕ Rejected
          </span>
          {result.simulationError && (
            <span className="text-[10px] text-red-300/80">
              {result.simulationError}
            </span>
          )}
        </span>
      ),
    },
    {
      label: "Gross reclaim",
      value: (
        <span className="font-bold text-emerald-300">
          {fmtSol(result.estimatedGrossReclaimSol)} SOL
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
    <div className="border-t border-red-700/40 bg-red-950/40">
      <div className="flex items-center justify-between border-b border-red-700/50 bg-red-800/25 px-3 py-1.5">
        <span className="text-[10px] font-bold uppercase tracking-wider text-red-200">
          🔥 Core asset burn preview
        </span>
        <Badge variant="sell">unsigned · destructive</Badge>
      </div>
      <div className="border-b border-red-600/25 bg-red-600/10 px-3 py-2 text-[11px] font-semibold text-red-200">
        ⚠ Burning Core assets is destructive and irreversible.
      </div>
      {result.warning && (
        <div className="border-b border-red-600/20 bg-amber-500/5 px-3 py-1.5 text-[11px] text-amber-300">
          ⚠ {result.warning}
        </div>
      )}
      {result.includedAssets.length > 0 && (
        <ul className="divide-y divide-red-700/20 border-b border-red-700/20">
          {result.includedAssets.map((a: CoreBurnIncludedEntry) => (
            <li
              key={a.asset}
              className="grid grid-cols-12 items-center gap-3 px-3 py-1.5 text-xs"
            >
              <div className="col-span-5 min-w-0">
                <div className="truncate font-semibold text-neutral-100">
                  {a.name ?? "—"}
                </div>
                <div className="truncate font-mono text-[10px] text-neutral-400">
                  {shortAddr(a.asset, 4, 4)}
                </div>
              </div>
              <div className="col-span-2 truncate font-mono text-[11px] text-neutral-300">
                {a.collection ? shortAddr(a.collection, 4, 4) : "—"}
              </div>
              <div className="col-span-2 truncate text-[10px] text-neutral-500">
                {a.reason}
              </div>
              <div className="col-span-3 text-right font-semibold tabular-nums text-emerald-300/90">
                {fmtSol(a.estimatedGrossReclaimSol)} SOL
              </div>
            </li>
          ))}
        </ul>
      )}
      {result.skippedAssets.length > 0 && (
        <NonBurnableNftSummary
          entries={result.skippedAssets as CoreBurnSkippedEntry[]}
        />
      )}
      <dl className="divide-y divide-red-700/20">
        {rows.map((r) => (
          <div
            key={r.label}
            className="grid grid-cols-12 items-center gap-3 px-3 py-1.5 text-xs"
          >
            <dt className="col-span-4 text-red-300/80">{r.label}</dt>
            <dd
              className={`col-span-8 min-w-0 break-all ${
                r.mono
                  ? "font-mono text-[11px] text-neutral-100"
                  : "text-neutral-100"
              }`}
            >
              {r.value}
            </dd>
          </div>
        ))}
      </dl>
      <div className="border-t border-red-700/40 bg-neutral-950 px-3 py-2 text-center text-[11px] font-medium text-red-300/80">
        Preview only. Sign + send for Core asset burn is intentionally not
        wired in this UI.
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

function BurnCandidatesTable({
  rows,
  selected,
  onToggle,
}: {
  rows: BurnCandidate[];
  selected: Set<string>;
  onToggle: (mint: string) => void;
}) {
  return (
    <div>
      <div className="grid grid-cols-12 gap-3 border-b border-red-500/20 bg-red-500/[0.03] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-red-300/80">
        <div className="col-span-1">Burn</div>
        <div className="col-span-2">Token</div>
        <div className="col-span-2">Mint</div>
        <div className="col-span-2 text-right">Amount</div>
        <div className="col-span-1 text-right">Dec.</div>
        <div className="col-span-2 text-right">Reclaim (burn+close)</div>
        <div className="col-span-1">Risk</div>
        <div className="col-span-1">Rec?</div>
      </div>
      <div>
        {rows.map((r) => {
          const tokenLabel = r.symbol ?? r.name ?? null;
          // Rows where burnRecommended=false get a stronger visual: red strip
          // background + red badge in the last column, so the user can't miss
          // that this token needs manual review before any (future) burn.
          const rowTint = r.burnRecommended ? "" : "bg-red-500/[0.06]";
          const isChecked = selected.has(r.mint);
          return (
            <label
              key={r.tokenAccount}
              className={`grid cursor-pointer grid-cols-12 items-center gap-3 border-b border-red-500/15 px-3 py-1.5 text-xs last:border-b-0 transition-colors duration-100 hover:bg-red-500/[0.08] ${rowTint} ${isChecked ? "ring-1 ring-inset ring-red-400/40" : ""}`}
            >
              <div className="col-span-1">
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => onToggle(r.mint)}
                  aria-label={`Select ${tokenLabel ?? "unknown token"} for burn`}
                  className="h-3.5 w-3.5 cursor-pointer accent-red-500"
                />
              </div>
              <div className="col-span-2 min-w-0">
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
            </label>
          );
        })}
      </div>
    </div>
  );
}


// ============================================================================
// CSV export for the Group Cleaner overview.
// Builds rows from the ScanRegistry (only scanned wallets), pulls labels
// from the WalletEntry list, escapes per RFC 4180, and triggers a browser
// download. No new deps — pure Blob + URL.createObjectURL + <a download>.
// ============================================================================

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function exportCleanerOverviewCsv(
  wallets: WalletEntry[],
  scans: Record<string, ScanSummary>,
): void {
  if (typeof window === "undefined") return;

  const header = [
    "wallet",
    "label",
    "emptyAccounts",
    "grossReclaimSol",
    "burnCandidates",
    "nfts",
  ];
  const lines = [header.join(",")];
  // Walk wallets in display order, but only include those that have been
  // scanned. Keeps the file aligned with the rows the user actually sees.
  for (const w of wallets) {
    const s = scans[w.address];
    if (!s) continue;
    lines.push(
      [
        csvEscape(w.address),
        csvEscape(w.label ?? ""),
        String(s.empty),
        String(s.reclaimSol),
        String(s.fungible),
        String(s.nft),
      ].join(","),
    );
  }
  // CRLF for broader Excel compatibility.
  const csv = lines.join("\r\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const today = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `cleaner-overview-${today}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
