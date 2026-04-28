"use client";

// Sortable wallet comparison table. Lives in its own client module so the
// rest of sections.tsx stays server-renderable; imports cleanly from there.
// Reuses computeWalletScores so the "Winner / Loser / Neutral" badges line
// up with the Top Wallets section above it.

import { useMemo, useState } from "react";
import type { OverviewResultItem } from "@/lib/api";
import { computeWalletScores } from "./sections";
import { fmtNumber, fmtPercent, fmtUsd } from "@/lib/format";
import { WalletLink } from "@/ui-kit/components/WalletLink";

type SortKey = "score" | "pnl" | "winRate" | "trades";
type SortDir = "asc" | "desc";

interface ComparisonRow {
  wallet: string;
  label: string | null;
  score: number;
  totalPnlUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  winRate: number;
  trades: number;
  tokens: number;
  status: "winner" | "loser" | "neutral";
}

const SORT_BUTTONS: { key: SortKey; label: string }[] = [
  { key: "score", label: "Score" },
  { key: "pnl", label: "PnL" },
  { key: "winRate", label: "Win rate" },
  { key: "trades", label: "Trades" },
];

function buildRows(results: OverviewResultItem[]): ComparisonRow[] {
  const scored = computeWalletScores(results);
  if (scored.length === 0) return [];

  // Top 20%, min 3, capped at total — same gate as Top Wallets / Smart signals.
  const winnerCutoff = Math.max(3, Math.ceil(scored.length * 0.2));
  const winnerSet = new Set(
    scored.slice(0, Math.min(winnerCutoff, scored.length)).map((s) => s.wallet),
  );

  const scoredByWallet = new Map(scored.map((s) => [s.wallet, s]));

  const rows: ComparisonRow[] = [];
  for (const r of results) {
    if (!r.ok || !r.summary) continue;
    const sc = scoredByWallet.get(r.wallet);
    const totalPnlUsd = r.summary.totalPnlUsd ?? 0;
    const realizedPnlUsd = r.summary.realizedPnlUsd ?? 0;
    const unrealizedPnlUsd = r.summary.unrealizedPnlUsd ?? 0;
    const winRate = r.summary.winRate ?? 0;
    const trades = r.summary.totalTrades ?? 0;
    const tokens = r.summary.tokensCount ?? 0;
    const status: ComparisonRow["status"] = winnerSet.has(r.wallet)
      ? "winner"
      : totalPnlUsd < 0 && winRate < 0.4
      ? "loser"
      : "neutral";
    rows.push({
      wallet: r.wallet,
      label: r.label,
      score: sc?.score ?? 0,
      totalPnlUsd,
      realizedPnlUsd,
      unrealizedPnlUsd,
      winRate,
      trades,
      tokens,
      status,
    });
  }
  return rows;
}

function sortRows(rows: ComparisonRow[], key: SortKey, dir: SortDir): ComparisonRow[] {
  const valueOf = (r: ComparisonRow) => {
    switch (key) {
      case "score":
        return r.score;
      case "pnl":
        return r.totalPnlUsd;
      case "winRate":
        return r.winRate;
      case "trades":
        return r.trades;
    }
  };
  const out = [...rows];
  out.sort((a, b) => {
    const av = valueOf(a);
    const bv = valueOf(b);
    return dir === "desc" ? bv - av : av - bv;
  });
  return out;
}

function StatusBadge({ status }: { status: ComparisonRow["status"] }) {
  const cls =
    "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold ring-1";
  if (status === "winner") {
    return (
      <span
        className={`${cls} bg-emerald-500/15 text-emerald-300 ring-emerald-500/30`}
        title="Top 20% by score"
      >
        Winner
      </span>
    );
  }
  if (status === "loser") {
    return (
      <span
        className={`${cls} bg-red-500/15 text-red-300 ring-red-500/30`}
        title="Negative PnL and win rate < 40%"
      >
        Loser
      </span>
    );
  }
  return (
    <span
      className={`${cls} bg-neutral-700/30 text-neutral-400 ring-neutral-600/40`}
    >
      Neutral
    </span>
  );
}

// CSV cell escape per RFC 4180: wrap fields containing comma / quote /
// newline in double-quotes and double-up any embedded quotes.
function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function buildCsv(rows: ComparisonRow[]): string {
  const header = [
    "wallet",
    "label",
    "score",
    "totalPnlUsd",
    "realizedPnlUsd",
    "unrealizedPnlUsd",
    "winRate",
    "totalTrades",
    "tokensCount",
    "status",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        csvEscape(r.wallet),
        csvEscape(r.label ?? ""),
        String(r.score),
        String(r.totalPnlUsd),
        String(r.realizedPnlUsd),
        String(r.unrealizedPnlUsd),
        String(r.winRate),
        String(r.trades),
        String(r.tokens),
        r.status,
      ].join(","),
    );
  }
  // CRLF line endings — broader compatibility with Excel.
  return lines.join("\r\n");
}

function downloadCsv(rows: ComparisonRow[]): void {
  if (typeof window === "undefined") return;
  const csv = buildCsv(rows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const today = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `wallet-comparison-${today}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function pnlClass(v: number | null | undefined): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "text-neutral-200";
  if (v > 0) return "text-emerald-300";
  if (v < 0) return "text-red-300";
  return "text-neutral-200";
}

export function WalletComparisonView({
  results,
}: {
  results: OverviewResultItem[];
}) {
  const rows = useMemo(() => buildRows(results), [results]);
  const [sortKey, setSortKey] = useState<SortKey>("score");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const sorted = useMemo(
    () => sortRows(rows, sortKey, sortDir),
    [rows, sortKey, sortDir],
  );

  if (rows.length === 0) return null;

  function clickSort(k: SortKey) {
    if (k === sortKey) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(k);
      setSortDir("desc");
    }
  }

  return (
    <div className="overflow-hidden rounded-md border border-neutral-700 bg-neutral-900">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-700 px-3 py-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-300">
          Wallet comparison
        </span>
        <span className="inline-flex flex-wrap items-center gap-1">
          <span className="text-[10px] uppercase tracking-wider text-neutral-500">
            Sort
          </span>
          {SORT_BUTTONS.map((b) => {
            const active = b.key === sortKey;
            const arrow = active ? (sortDir === "desc" ? " ↓" : " ↑") : "";
            const cls = active
              ? "rounded border border-violet-500/60 bg-violet-500/15 px-2 py-0.5 text-[10px] font-bold text-violet-200"
              : "rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-[10px] font-semibold text-neutral-300 hover:border-neutral-500 hover:bg-neutral-800 hover:text-white";
            return (
              <button
                key={b.key}
                type="button"
                onClick={() => clickSort(b.key)}
                aria-pressed={active}
                className={cls + " transition-colors duration-100"}
              >
                {b.label}
                {arrow}
              </button>
            );
          })}
          <span className="ml-1 text-neutral-700">·</span>
          <button
            type="button"
            onClick={() => downloadCsv(sorted)}
            title="Download visible rows as CSV"
            aria-label="Export wallet comparison as CSV"
            className="rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-[10px] font-semibold text-neutral-300 transition-colors duration-100 hover:border-emerald-500/60 hover:bg-emerald-500/10 hover:text-emerald-200"
          >
            Export CSV ↓
          </button>
        </span>
      </div>
      <div className="grid grid-cols-12 gap-3 border-b border-neutral-800 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
        <div className="col-span-3">Wallet</div>
        <div className="col-span-1 text-right">Score</div>
        <div className="col-span-1 text-right">Total</div>
        <div className="col-span-1 text-right">Realized</div>
        <div className="col-span-1 text-right">Unrealized</div>
        <div className="col-span-1 text-right">Win rate</div>
        <div className="col-span-1 text-right">Trades</div>
        <div className="col-span-1 text-right">Tokens</div>
        <div className="col-span-2 text-right">Status</div>
      </div>
      <ul className="divide-y divide-neutral-800">
        {sorted.map((r) => (
          <li
            key={r.wallet}
            className="grid grid-cols-12 items-center gap-3 px-3 py-1.5 text-xs transition-colors duration-100 hover:bg-neutral-800/60"
          >
            <div className="col-span-3 min-w-0">
              {r.label ? (
                <div className="truncate text-sm font-semibold text-white">
                  {r.label}
                </div>
              ) : null}
              <WalletLink address={r.wallet} chars={4} className="text-[11px]" />
            </div>
            <div className="col-span-1 text-right">
              <span className="font-bold tabular-nums text-white">
                {r.score}
              </span>
            </div>
            <div
              className={`col-span-1 text-right font-semibold tabular-nums ${pnlClass(r.totalPnlUsd)}`}
            >
              {fmtUsd(r.totalPnlUsd)}
            </div>
            <div
              className={`col-span-1 text-right font-semibold tabular-nums ${pnlClass(r.realizedPnlUsd)}`}
            >
              {fmtUsd(r.realizedPnlUsd)}
            </div>
            <div
              className={`col-span-1 text-right font-semibold tabular-nums ${pnlClass(r.unrealizedPnlUsd)}`}
            >
              {fmtUsd(r.unrealizedPnlUsd)}
            </div>
            <div className="col-span-1 text-right tabular-nums text-white">
              {fmtPercent(r.winRate)}
            </div>
            <div className="col-span-1 text-right tabular-nums text-white">
              {fmtNumber(r.trades)}
            </div>
            <div className="col-span-1 text-right tabular-nums text-white">
              {fmtNumber(r.tokens)}
            </div>
            <div className="col-span-2 flex justify-end">
              <StatusBadge status={r.status} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
