"use client";

import { useState, useTransition } from "react";
import type {
  BurnCandidate,
  BurnCandidatesResult,
  CleanupScanResult,
  ScannedTokenAccount,
} from "@/lib/api";
import { fmtNumber, shortAddr } from "@/lib/format";
import { scanCleanupAction } from "../actions";
import { Badge } from "@/ui-kit/components/Badge";
import { WalletLink } from "@/ui-kit/components/WalletLink";
import { btnPrimary, btnSecondary } from "@/lib/buttonStyles";

type ScanState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "scanned"; scan: CleanupScanResult; burn: BurnCandidatesResult }
  | { status: "error"; error: string };

interface WalletEntry {
  address: string;
  label: string | null;
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
    <div className="space-y-3">
      <div className="rounded-md border border-neutral-700 bg-neutral-900 p-3 text-xs text-neutral-300">
        <span className="font-semibold text-white">Wallet Cleaner</span>
        <span className="ml-2 text-neutral-500">
          Scans report empty SPL token accounts (rent reclaimable) and fungible
          burn candidates. No transactions are sent — signing flow is not built
          yet.
        </span>
      </div>
      {wallets.map((w) => (
        <CleanerRow key={w.address} wallet={w} />
      ))}
    </div>
  );
}

function CleanerRow({ wallet }: { wallet: WalletEntry }) {
  const [state, setState] = useState<ScanState>({ status: "idle" });
  const [showDetails, setShowDetails] = useState(false);
  const [pending, startTransition] = useTransition();

  function handleScan() {
    setState({ status: "loading" });
    startTransition(async () => {
      const res = await scanCleanupAction(wallet.address);
      if (res.ok) {
        setState({ status: "scanned", scan: res.scan, burn: res.burn });
        setShowDetails(true);
      } else {
        setState({ status: "error", error: res.error });
      }
    });
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
            {summary ? fmtNumber(summary.reclaimSol) : "—"}
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

        <div className="col-span-2 flex justify-end gap-2">
          <button type="button" onClick={handleScan} disabled={pending} className={btnPrimary}>
            {state.status === "loading" || pending ? "Scanning…" : state.status === "scanned" ? "Rescan" : "Scan"}
          </button>
          {state.status === "scanned" && (
            <button
              type="button"
              onClick={() => setShowDetails((v) => !v)}
              className={btnSecondary}
            >
              {showDetails ? "Hide" : "View details"}
            </button>
          )}
        </div>
      </div>

      {state.status === "error" && (
        <div className="border-t border-neutral-800 bg-red-500/5 px-3 py-2 text-xs text-red-400">
          {state.error}
        </div>
      )}

      {state.status === "scanned" && showDetails && (
        <CleanerDetails scan={state.scan} burn={state.burn} />
      )}
    </div>
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
      <SubHeader label="Empty token accounts" right={`${scan.emptyTokenAccounts.length} · reclaim ${fmtNumber(scan.totals.estimatedReclaimSol)} SOL`} />
      {scan.emptyTokenAccounts.length === 0 ? (
        <EmptyHint>No empty token accounts.</EmptyHint>
      ) : (
        <EmptyAccountsTable rows={scan.emptyTokenAccounts} />
      )}

      <SubHeader
        label="Burn candidates"
        right={`${burn.count} · est. reclaim ${fmtNumber(burn.totalEstimatedReclaimSol)} SOL`}
      />
      <div className="border-b border-neutral-800 bg-amber-500/5 px-3 py-1.5 text-[11px] text-amber-300">
        ⚠ {burn.warning}
      </div>
      {burn.candidates.length === 0 ? (
        <EmptyHint>No fungible burn candidates.</EmptyHint>
      ) : (
        <BurnCandidatesTable rows={burn.candidates} />
      )}
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
              {fmtNumber(r.estimatedReclaimSol)}
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
      <div className="grid grid-cols-12 gap-3 border-b border-neutral-800 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
        <div className="col-span-3">Mint</div>
        <div className="col-span-2 text-right">Amount</div>
        <div className="col-span-1 text-right">Decimals</div>
        <div className="col-span-2 text-right">Reclaim SOL</div>
        <div className="col-span-2">Risk</div>
        <div className="col-span-2">Recommended</div>
      </div>
      <div>
        {rows.map((r) => (
          <div
            key={r.tokenAccount}
            className="grid grid-cols-12 items-center gap-3 border-b border-neutral-800 px-3 py-1.5 text-xs last:border-b-0"
          >
            <div className="col-span-3 min-w-0">
              <div className="truncate font-mono text-neutral-100">
                {r.symbol ?? shortAddr(r.mint, 4, 4)}
              </div>
              <div className="truncate font-mono text-[10px] text-neutral-500">
                {shortAddr(r.mint, 4, 4)}
              </div>
            </div>
            <div className="col-span-2 text-right tabular-nums text-neutral-100">
              {fmtNumber(r.uiAmount)}
            </div>
            <div className="col-span-1 text-right tabular-nums text-neutral-400">
              {r.decimals}
            </div>
            <div className="col-span-2 text-right font-semibold tabular-nums text-emerald-300">
              {fmtNumber(r.estimatedReclaimSolAfterBurnAndClose)}
            </div>
            <div className="col-span-2">
              <Badge variant={r.riskLevel === "unknown" ? "warn" : "neutral"}>
                {r.riskLevel}
              </Badge>
            </div>
            <div className="col-span-2 text-neutral-300">
              {r.burnRecommended ? (
                <Badge variant="buy">Yes</Badge>
              ) : (
                <span className="text-neutral-500">No (manual review)</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

