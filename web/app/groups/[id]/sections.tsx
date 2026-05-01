// Pure render section components shared between the server page and the
// client-side lazy wrappers in `lazy.tsx`. No "use client" — these can render
// in either context. Data comes in as props; no fetching here.

import { fmtUsd, fmtPercent, fmtNumber, fmtTime, shortAddr } from "@/lib/format";
import type {
  AirdropsState,
  GroupLpResponse,
  GroupTradesResponse,
  LpPosition,
  OverviewResponse,
  OverviewResultItem,
  PortfolioResponse,
  TokenActivityResponse,
  TradeItem,
} from "@/lib/api";
import { WalletComparisonView } from "./wallet-comparison";
import { Card } from "@/ui-kit/components/Card";
import { Badge } from "@/ui-kit/components/Badge";
import { SectionHeader } from "@/ui-kit/components/SectionHeader";
import { Table, type Column } from "@/ui-kit/components/Table";
import { TokenCell } from "@/ui-kit/components/TokenCell";
import { WalletLink } from "@/ui-kit/components/WalletLink";
import { TxLink } from "@/ui-kit/components/TxLink";

export const HIGHLIGHT_TRADE_USD = 50;
export const TOP_ACCUMULATED_COUNT = 3;

export function pnlClass(v: number | null | undefined): string {
  if (typeof v !== "number") return "text-neutral-200";
  if (v > 0) return "text-emerald-300";
  if (v < 0) return "text-red-300";
  return "text-neutral-200";
}

// Shared section wrapper. Switched to <Card tone="vl"> so every panel that
// uses it (PnL, portfolio, LP, airdrops, token activity, trades, etc.)
// inherits the polish-pass surface (opaque + lavender border + shadow lift)
// in one shot — no per-section structural rewrite.
export function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card tone="vl" className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-[color:var(--vl-border)] px-3 py-1.5">
        <SectionHeader tone="vl" className="mb-0">{title}</SectionHeader>
        {subtitle && (
          <span className="text-xs text-[color:var(--vl-fg-2)] tabular-nums">{subtitle}</span>
        )}
      </div>
      {children}
    </Card>
  );
}

export function PnlOverviewView({
  data,
  headerRight,
}: {
  data: OverviewResponse;
  headerRight?: React.ReactNode;
}) {
  const t = data.totals;
  const numericResults = data.results.filter(
    (r) => r.ok && typeof r.summary?.totalPnlUsd === "number" && Number.isFinite(r.summary.totalPnlUsd),
  );
  let bestWallet: string | null = null;
  let worstWallet: string | null = null;
  if (numericResults.length > 0) {
    const sorted = [...numericResults].sort(
      (a, b) => (b.summary!.totalPnlUsd as number) - (a.summary!.totalPnlUsd as number),
    );
    bestWallet = sorted[0].wallet;
    if (sorted.length > 1) worstWallet = sorted[sorted.length - 1].wallet;
  }

  const metrics = [
    { label: "Total PnL", value: fmtUsd(t.totalPnlUsd), signed: t.totalPnlUsd },
    { label: "Realized", value: fmtUsd(t.realizedPnlUsd), signed: t.realizedPnlUsd },
    { label: "Unrealized", value: fmtUsd(t.unrealizedPnlUsd), signed: t.unrealizedPnlUsd },
    { label: "Trades", value: fmtNumber(t.totalTrades), signed: null },
    { label: "Tokens", value: fmtNumber(t.tokensCount), signed: null },
  ];

  return (
    <section className="space-y-2">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {metrics.map((m) => (
          <div key={m.label} className="vl-card p-3">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--vl-fg-3)]">
              {m.label}
            </div>
            <div
              className={`mt-0.5 text-lg font-bold tabular-nums ${
                typeof m.signed === "number" ? pnlClass(m.signed) : "text-white"
              }`}
            >
              {m.value}
            </div>
          </div>
        ))}
      </div>

      <TopWalletsView results={numericResults} />
      <WalletComparisonView results={numericResults} />

      <Panel
        title="PnL overview"
        subtitle={
          <span className="inline-flex items-center gap-2">
            <span>{`${data.ok} ok · ${data.failed} failed`}</span>
            {headerRight}
          </span>
        }
      >
        {data.results.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-neutral-500">
            No PnL data available.
          </div>
        ) : (
          <>
          <div className="grid grid-cols-12 gap-3 border-b border-neutral-800 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-neutral-300">
            <div className="col-span-4">Wallet</div>
            <div className="col-span-2 text-right">Total</div>
            <div className="col-span-2 text-right">Realized</div>
            <div className="col-span-2 text-right">Win rate</div>
            <div className="col-span-2 text-right">Trades</div>
          </div>
          <div>
            {data.results.map((r) => (
              <div
                key={r.wallet}
                className="grid grid-cols-12 items-center gap-3 border-b border-neutral-800 px-3 py-1.5 transition-colors duration-100 last:border-b-0 hover:bg-neutral-800/60"
              >
                <div className="col-span-4 min-w-0">
                  <div className="flex items-center gap-2">
                    <WalletLink address={r.wallet} chars={4} />
                    {r.wallet === bestWallet && <Badge variant="buy">Best</Badge>}
                    {r.wallet === worstWallet && <Badge variant="sell">Worst</Badge>}
                  </div>
                  {r.label && (
                    <div className="text-xs font-medium text-neutral-300">{r.label}</div>
                  )}
                </div>
                {r.ok && r.summary ? (
                  <>
                    <div className={`col-span-2 text-right text-sm font-semibold tabular-nums ${pnlClass(r.summary.totalPnlUsd)}`}>
                      {fmtUsd(r.summary.totalPnlUsd)}
                    </div>
                    <div className={`col-span-2 text-right text-sm font-semibold tabular-nums ${pnlClass(r.summary.realizedPnlUsd)}`}>
                      {fmtUsd(r.summary.realizedPnlUsd)}
                    </div>
                    <div className="col-span-2 text-right text-sm font-semibold tabular-nums text-white">
                      {fmtPercent(r.summary.winRate)}
                    </div>
                    <div className="col-span-2 text-right text-sm font-semibold tabular-nums text-white">
                      {fmtNumber(r.summary.totalTrades)}
                    </div>
                  </>
                ) : (
                  <div className="col-span-8 text-right text-xs text-red-300">
                    {r.error ?? "failed"}
                  </div>
                )}
              </div>
            ))}
          </div>
          </>
        )}
      </Panel>
    </section>
  );
}

// ============================================================================
// Top wallets — wallet scoring v1
// ----------------------------------------------------------------------------
// Ranks wallets by a composite score derived from existing OverviewResponse
// fields. The spec calls for pnl + winRate + volumeUsd + recentActivityBoost,
// but the OverviewResponse doesn't carry per-wallet volume or last-trade
// timestamp. To keep "no new API calls" we substitute totalTrades as a proxy
// for both volume and activity in v1; if/when overview gains volume + recency
// fields we can plug them in here without touching the consumer UI.
// ============================================================================

const SCORE_WEIGHTS = {
  pnl: 0.6,
  winRate: 0.2,
  // Activity proxy. Spec splits this into volumeUsd*0.1 + recencyBoost*0.1
  // but we only have trade count, so we collapse both 0.1 weights into one
  // 0.2 weight applied to the trade-count term.
  activity: 0.2,
} as const;

export interface ScoredWallet {
  wallet: string;
  label: string | null;
  score: number; // 0–100
  pnlUsd: number;
  winRate: number; // 0–1
  trades: number;
}

export function computeWalletScores(
  results: OverviewResultItem[],
): ScoredWallet[] {
  // Filter again here so the function is robust if called with raw results.
  const usable = results.filter(
    (r) =>
      r.ok &&
      r.summary &&
      typeof r.summary.totalPnlUsd === "number" &&
      Number.isFinite(r.summary.totalPnlUsd),
  );
  if (usable.length === 0) return [];

  const pnls = usable.map((r) => r.summary!.totalPnlUsd as number);
  const trades = usable.map((r) => r.summary!.totalTrades ?? 0);

  // Min-max normalize. When all values match, every wallet gets 0.5 for that
  // term — they're equal on that axis, so they don't differentiate the score.
  const norm = (v: number, arr: number[]) => {
    const min = Math.min(...arr);
    const max = Math.max(...arr);
    if (max === min) return 0.5;
    return (v - min) / (max - min);
  };

  return usable
    .map((r) => {
      const s = r.summary!;
      const pnlUsd = (s.totalPnlUsd as number) ?? 0;
      // winRate is already 0–1 (or null for wallets with no trades).
      const winRate = typeof s.winRate === "number" && Number.isFinite(s.winRate)
        ? s.winRate
        : 0;
      const t = s.totalTrades ?? 0;
      const score01 =
        norm(pnlUsd, pnls) * SCORE_WEIGHTS.pnl +
        winRate * SCORE_WEIGHTS.winRate +
        norm(t, trades) * SCORE_WEIGHTS.activity;
      return {
        wallet: r.wallet,
        label: r.label,
        score: Math.round(Math.max(0, Math.min(1, score01)) * 100),
        pnlUsd,
        winRate,
        trades: t,
      };
    })
    .sort((a, b) => b.score - a.score);
}

function TopWalletsView({ results }: { results: OverviewResultItem[] }) {
  const ranked = computeWalletScores(results);
  if (ranked.length === 0) return null;

  return (
    <Panel
      title="Top wallets"
      subtitle={
        <span className="text-[11px] text-neutral-400">
          Score 0–100 · pnl × {SCORE_WEIGHTS.pnl}, win rate × {SCORE_WEIGHTS.winRate}, activity × {SCORE_WEIGHTS.activity}
        </span>
      }
    >
      <div className="grid grid-cols-1 gap-px bg-neutral-800 sm:grid-cols-2 xl:grid-cols-3">
        {ranked.map((w, i) => (
          <TopWalletCard key={w.wallet} rank={i + 1} wallet={w} />
        ))}
      </div>
    </Panel>
  );
}

const RANK_STYLES: Record<number, { tint: string; medal: string; medalText: string; ring: string }> = {
  1: {
    tint: "bg-amber-500/[0.05]",
    medal: "bg-amber-400 text-neutral-950",
    medalText: "🥇",
    ring: "border-l-2 border-amber-400/70",
  },
  2: {
    tint: "bg-neutral-400/[0.04]",
    medal: "bg-neutral-300 text-neutral-950",
    medalText: "🥈",
    ring: "border-l-2 border-neutral-300/70",
  },
  3: {
    tint: "bg-orange-500/[0.05]",
    medal: "bg-orange-400 text-neutral-950",
    medalText: "🥉",
    ring: "border-l-2 border-orange-400/70",
  },
};

function TopWalletCard({ rank, wallet }: { rank: number; wallet: ScoredWallet }) {
  const podium = RANK_STYLES[rank];
  return (
    <div
      className={`flex flex-col gap-1.5 px-3 py-2.5 transition-colors duration-100 hover:bg-neutral-800/80 ${
        podium ? `${podium.tint} ${podium.ring}` : "border-l-2 border-transparent bg-neutral-900"
      }`}
    >
      {/* row 1: rank + wallet */}
      <div className="flex items-center gap-2">
        {podium ? (
          <span
            className={`inline-flex h-5 min-w-[28px] items-center justify-center rounded-md px-1.5 text-[11px] font-bold tabular-nums ${podium.medal}`}
            aria-label={`Rank ${rank}`}
          >
            #{rank}
          </span>
        ) : (
          <span
            className="inline-flex h-5 min-w-[28px] items-center justify-center rounded-md bg-neutral-800 px-1.5 text-[11px] font-bold tabular-nums text-neutral-400"
            aria-label={`Rank ${rank}`}
          >
            #{rank}
          </span>
        )}
        <div className="min-w-0 flex-1">
          {wallet.label ? (
            <div className="truncate text-sm font-bold text-white">
              {wallet.label}
            </div>
          ) : null}
          <div className={wallet.label ? "text-[11px]" : "text-sm font-bold text-white"}>
            <WalletLink address={wallet.wallet} chars={4} />
          </div>
        </div>
        {podium && (
          <span aria-hidden className="text-base leading-none">
            {podium.medalText}
          </span>
        )}
      </div>
      {/* row 2: score + pnl */}
      <div className="flex items-baseline justify-between">
        <span className="text-2xl font-bold tabular-nums text-white">
          {wallet.score}
          <span className="ml-0.5 text-[11px] font-medium text-neutral-500">
            / 100
          </span>
        </span>
        <span
          className={`text-sm font-semibold tabular-nums ${pnlClass(wallet.pnlUsd)}`}
        >
          {wallet.pnlUsd > 0 ? "+" : ""}
          {fmtUsd(wallet.pnlUsd)}
        </span>
      </div>
      {/* row 3: meta */}
      <div className="flex items-baseline justify-between text-[11px] text-neutral-400">
        <span>
          <span className="text-neutral-500">Win rate</span>{" "}
          <span className="font-semibold tabular-nums text-white">
            {fmtPercent(wallet.winRate)}
          </span>
        </span>
        <span>
          <span className="text-neutral-500">Trades</span>{" "}
          <span className="font-semibold tabular-nums text-white">
            {fmtNumber(wallet.trades)}
          </span>
        </span>
      </div>
    </div>
  );
}

export function PortfolioView({
  data,
  headerRight,
}: {
  data: PortfolioResponse;
  headerRight?: React.ReactNode;
}) {
  const top = data.tokens.slice(0, 10);
  const filtered = data.filteredTokensCount ?? 0;

  type Row = (typeof top)[number];
  const cols: Column<Row>[] = [
    {
      key: "token",
      label: "Token",
      span: 6,
      render: (r) => (
        <TokenCell
          mint={r.mint}
          symbol={r.symbol ?? shortAddr(r.mint)}
          name={r.name ?? undefined}
        />
      ),
    },
    {
      key: "balance",
      label: "Balance",
      span: 2,
      align: "right",
      render: (r) => (
        <span className="tabular-nums font-semibold text-white">{fmtNumber(r.totalBalance)}</span>
      ),
    },
    {
      key: "value",
      label: "Value",
      span: 2,
      align: "right",
      render: (r) => (
        <span className="tabular-nums font-bold text-white">{fmtUsd(r.totalValueUsd)}</span>
      ),
    },
    {
      key: "wallets",
      label: "Wallets",
      span: 2,
      align: "right",
      render: (r) => <span className="tabular-nums font-medium text-white">{r.walletsCount}</span>,
    },
  ];

  const subtitle = (
    <span className="inline-flex items-center gap-2">
      <span>
        <span className="font-semibold text-white">{fmtUsd(data.totalUsd)}</span>
        <span className="text-neutral-500"> · </span>
        {fmtNumber(data.totalSol)} SOL
        <span className="text-neutral-500"> · </span>
        {data.tokens.length} tokens
      </span>
      {headerRight}
    </span>
  );
  return (
    <Panel title="Portfolio" subtitle={subtitle}>
      {filtered > 0 && (
        <div className="border-b border-neutral-800 px-4 py-1.5 text-xs text-amber-400">
          ⚠ {filtered} suspicious token{filtered === 1 ? "" : "s"} hidden
        </div>
      )}
      <Table
        columns={cols}
        rows={top}
        rowKey={(r) => r.mint}
        empty="No holdings."
      />
    </Panel>
  );
}

export function TokenActivityView({ data }: { data: TokenActivityResponse }) {
  const top = data.tokens.slice(0, 10);
  const accumulatedMints = new Set(
    [...data.tokens]
      .filter((tk) => tk.netUsd > 0)
      .sort((a, b) => b.netUsd - a.netUsd)
      .slice(0, TOP_ACCUMULATED_COUNT)
      .map((tk) => tk.mint),
  );

  type Row = (typeof top)[number];
  const cols: Column<Row>[] = [
    {
      key: "token",
      label: "Token",
      span: 4,
      render: (r) => (
        <div className="flex items-center gap-2 min-w-0">
          <TokenCell
            mint={r.mint}
            symbol={r.symbol ?? shortAddr(r.mint)}
            name={r.name ?? undefined}
            size={28}
          />
          {accumulatedMints.has(r.mint) && (
            <Badge variant="info">Hot</Badge>
          )}
        </div>
      ),
    },
    {
      key: "buys",
      label: "Buys",
      span: 1,
      align: "right",
      render: (r) => <span className="tabular-nums font-semibold text-emerald-300">{r.buysCount}</span>,
    },
    {
      key: "sells",
      label: "Sells",
      span: 1,
      align: "right",
      render: (r) => <span className="tabular-nums font-semibold text-red-300">{r.sellsCount}</span>,
    },
    {
      key: "buyUsd",
      label: "Buy USD",
      span: 2,
      align: "right",
      render: (r) => <span className="tabular-nums font-semibold text-white">{fmtUsd(r.totalBuyUsd)}</span>,
    },
    {
      key: "sellUsd",
      label: "Sell USD",
      span: 2,
      align: "right",
      render: (r) => <span className="tabular-nums font-semibold text-white">{fmtUsd(r.totalSellUsd)}</span>,
    },
    {
      key: "net",
      label: "Net",
      span: 1,
      align: "right",
      render: (r) => (
        <span className={`tabular-nums font-bold ${pnlClass(r.netUsd)}`}>
          {fmtUsd(r.netUsd)}
        </span>
      ),
    },
    {
      key: "wallets",
      label: "Wallets",
      span: 1,
      align: "right",
      render: (r) => <span className="tabular-nums font-medium text-white">{r.walletsCount}</span>,
    },
  ];

  return (
    <Panel
      title="Token activity"
      subtitle={`${data.tokens.length} tokens · perWalletLimit ${data.perWalletLimit}`}
    >
      <Table columns={cols} rows={top} rowKey={(r) => r.mint} empty="No swap activity." />
    </Panel>
  );
}

export function AirdropsView({ state }: { state: AirdropsState }) {
  if (state.state === "not_configured") {
    return (
      <Panel title="Airdrops">
        <div className="px-4 py-6 text-sm text-neutral-500">
          Airdrop checker is not configured.
          <span className="ml-1 text-neutral-600">
            Set <code className="rounded bg-neutral-800 px-1 py-0.5 text-xs">DROPS_BOT_API_KEY</code> in <code className="rounded bg-neutral-800 px-1 py-0.5 text-xs">.env</code>.
          </span>
        </div>
      </Panel>
    );
  }

  if (state.state === "error") {
    return (
      <Panel title="Airdrops">
        <div className="px-4 py-3 text-sm text-red-400">{state.message}</div>
      </Panel>
    );
  }

  const { data } = state;
  const subtitle = (
    <>
      <span className="font-semibold text-white">{fmtUsd(data.totalValueUsd)}</span>
      <span className="text-neutral-500"> · </span>
      {data.totalAirdropsCount} airdrop{data.totalAirdropsCount === 1 ? "" : "s"}
      {data.unknownValueWallets > 0 && (
        <>
          <span className="text-neutral-500"> · </span>
          <span className="text-amber-300">{data.unknownValueWallets} unknown-value</span>
        </>
      )}
    </>
  );

  return (
    <Panel title="Airdrops" subtitle={subtitle}>
      {data.failedWallets.length > 0 && (
        <div className="border-b border-neutral-800 px-3 py-1.5 text-xs text-amber-400">
          ⚠ {data.failedWallets.length} wallet
          {data.failedWallets.length === 1 ? "" : "s"} failed to load
        </div>
      )}
      {data.wallets.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-neutral-500">
          No airdrop data for any wallet in this group.
        </div>
      ) : (
        <div>
          <div className="grid grid-cols-12 gap-3 border-b border-neutral-800 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-neutral-300">
            <div className="col-span-4">Wallet</div>
            <div className="col-span-2 text-right">Count</div>
            <div className="col-span-3 text-right">Value</div>
            <div className="col-span-2 text-right">Unknown</div>
            <div className="col-span-1 text-right">Link</div>
          </div>
          <div>
            {data.wallets.map((w) => (
              <div
                key={w.wallet}
                className="grid grid-cols-12 items-center gap-3 border-b border-neutral-800 px-3 py-1.5 transition-colors duration-100 last:border-b-0 hover:bg-neutral-800/60"
              >
                <div className="col-span-4 min-w-0">
                  {w.label ? (
                    <span className="text-xs font-semibold text-white">{w.label}</span>
                  ) : (
                    <WalletLink address={w.wallet} chars={4} />
                  )}
                  {w.label && (
                    <div className="font-mono text-[10px] text-neutral-500">
                      {shortAddr(w.wallet)}
                    </div>
                  )}
                </div>
                <div className="col-span-2 text-right text-sm font-semibold tabular-nums text-white">
                  {w.airdropsCount}
                </div>
                <div className="col-span-3 text-right text-sm font-bold tabular-nums text-white">
                  {w.totalValueUsdFormatted ?? fmtUsd(w.totalValueUsd)}
                </div>
                <div className="col-span-2 text-right">
                  {w.isUnknownUsdValue ? (
                    <Badge variant="warn">Yes</Badge>
                  ) : (
                    <span className="text-xs text-neutral-500">—</span>
                  )}
                </div>
                <div className="col-span-1 text-right">
                  {w.addressUrl ? (
                    <a
                      href={w.addressUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs font-semibold text-violet-300 transition-colors duration-100 hover:text-violet-200"
                    >
                      View ↗
                    </a>
                  ) : (
                    <span className="text-xs text-neutral-500">—</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}

// ============================================================================
// LP Positions dashboard
// ----------------------------------------------------------------------------
// Card-based layout with three summary tiles, positions grouped by pair, and
// per-position cards that emphasise value / fees / PnL like a real DeFi
// dashboard rather than a generic data table.
// ============================================================================

interface LpPairGroup {
  key: string;
  label: string;
  tokenX: LpPosition["tokenX"];
  tokenY: LpPosition["tokenY"];
  positions: LpPosition[];
  totalValue: number;
  totalFees: number;
  totalPnl: number;
}

function groupLpPositionsByPair(positions: LpPosition[]): LpPairGroup[] {
  const groups = new Map<string, LpPairGroup>();
  for (const p of positions) {
    // Stable key: prefer sorted symbols (so SOL/USDC and USDC/SOL collapse),
    // fall back to mints when a leg has no symbol.
    const xSym = p.tokenX.symbol;
    const ySym = p.tokenY.symbol;
    const key =
      xSym && ySym
        ? [xSym, ySym].sort().join("/")
        : `${p.tokenX.mint}/${p.tokenY.mint}`;
    const label = p.pairName ?? `${xSym ?? "?"}/${ySym ?? "?"}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        label,
        tokenX: p.tokenX,
        tokenY: p.tokenY,
        positions: [],
        totalValue: 0,
        totalFees: 0,
        totalPnl: 0,
      };
      groups.set(key, g);
    }
    g.positions.push(p);
    g.totalValue += p.valueUsd;
    g.totalFees += p.unclaimedFeesUsd;
    g.totalPnl += p.unrealizedPnlUsd;
  }
  // Largest group first, then by descending PnL within same value tier.
  return [...groups.values()].sort(
    (a, b) => b.totalValue - a.totalValue || b.totalPnl - a.totalPnl,
  );
}

export function LpView({ data }: { data: GroupLpResponse }) {
  const totalPnl = data.positions.reduce((s, p) => s + p.unrealizedPnlUsd, 0);
  const groups = groupLpPositionsByPair(data.positions);
  const subtitle = (
    <>
      <span className="font-semibold text-white">{fmtUsd(data.totalValueUsd)}</span>
      <span className="text-neutral-500"> · </span>
      {data.totalPositions} position{data.totalPositions === 1 ? "" : "s"}
      <span className="text-neutral-500"> · </span>
      <span className="text-emerald-300">{fmtUsd(data.totalUnclaimedFeesUsd)}</span>
      <span className="text-neutral-500"> fees</span>
    </>
  );

  return (
    <Panel title="LP Positions" subtitle={subtitle}>
      {data.failedWallets.length > 0 && (
        <div className="border-b border-neutral-800 px-3 py-1.5 text-xs text-amber-400">
          ⚠ {data.failedWallets.length} wallet
          {data.failedWallets.length === 1 ? "" : "s"} failed to load
        </div>
      )}
      {data.positions.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-neutral-500">
          No active Meteora DLMM positions found.
        </div>
      ) : (
        <>
          <LpSummaryTiles
            totalValue={data.totalValueUsd}
            totalFees={data.totalUnclaimedFeesUsd}
            totalPnl={totalPnl}
          />
          <div className="divide-y divide-neutral-800">
            {groups.map((g) => (
              <LpPairGroupBlock key={g.key} group={g} />
            ))}
          </div>
        </>
      )}
    </Panel>
  );
}

function LpSummaryTiles({
  totalValue,
  totalFees,
  totalPnl,
}: {
  totalValue: number;
  totalFees: number;
  totalPnl: number;
}) {
  const tiles = [
    {
      label: "Total LP value",
      value: <span className="text-white">{fmtUsd(totalValue)}</span>,
    },
    {
      label: "Total unclaimed fees",
      value: <span className="text-emerald-300">{fmtUsd(totalFees)}</span>,
    },
    {
      label: "Total PnL",
      value: (
        <span className={pnlClass(totalPnl)}>
          {totalPnl > 0 ? "+" : ""}
          {fmtUsd(totalPnl)}
        </span>
      ),
    },
  ];
  return (
    <div className="grid grid-cols-3 gap-px border-b border-neutral-800 bg-neutral-800">
      {tiles.map((t) => (
        <div key={t.label} className="bg-neutral-900 px-3 py-2.5">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
            {t.label}
          </div>
          <div className="mt-0.5 text-xl font-bold tabular-nums">{t.value}</div>
        </div>
      ))}
    </div>
  );
}

function LpPairGroupBlock({ group }: { group: LpPairGroup }) {
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2 bg-neutral-950/40 px-3 py-1.5">
        <div className="flex items-center gap-2">
          <PairIcons tokenX={group.tokenX} tokenY={group.tokenY} size={18} />
          <span className="text-sm font-bold text-white">{group.label}</span>
          <Badge variant="info">{group.positions.length}</Badge>
        </div>
        <span className="text-[11px] tabular-nums text-neutral-400">
          <span className="font-semibold text-white">
            {fmtUsd(group.totalValue)}
          </span>
          <span className="text-neutral-500"> · </span>
          <span className="text-emerald-300">{fmtUsd(group.totalFees)}</span>
          <span className="text-neutral-500"> fees</span>
          <span className="text-neutral-500"> · </span>
          <span className={pnlClass(group.totalPnl)}>
            {group.totalPnl > 0 ? "+" : ""}
            {fmtUsd(group.totalPnl)}
          </span>
          <span className="text-neutral-500"> PnL</span>
        </span>
      </div>
      <div className="grid grid-cols-1 gap-px bg-neutral-800 sm:grid-cols-2 xl:grid-cols-3">
        {group.positions.map((p) => (
          <LpPositionCard key={p.positionAddress} position={p} />
        ))}
      </div>
    </div>
  );
}

function LpPositionCard({ position: p }: { position: LpPosition }) {
  const pair = p.pairName ?? `${p.tokenX.symbol ?? "?"}/${p.tokenY.symbol ?? "?"}`;
  const profitable = p.unrealizedPnlUsd > 0;
  const range =
    p.lowerBinId !== null && p.upperBinId !== null
      ? `${p.lowerBinId}…${p.upperBinId}`
      : "—";
  const created = p.createdAt
    ? new Date(p.createdAt * 1000).toISOString().slice(0, 10)
    : null;
  return (
    <div
      className={`relative flex flex-col gap-1.5 bg-neutral-900 px-3 py-2.5 transition-colors duration-100 hover:bg-neutral-800/80 ${
        profitable ? "border-l-2 border-emerald-500/50" : "border-l-2 border-transparent"
      }`}
    >
      {/* row 1: pair + protocol */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <PairIcons tokenX={p.tokenX} tokenY={p.tokenY} size={20} />
          <span className="truncate text-sm font-bold text-white">{pair}</span>
        </div>
        <Badge variant="info">DLMM</Badge>
      </div>
      {/* row 2: value (large) + PnL */}
      <div className="flex items-baseline justify-between">
        <span className="text-xl font-bold tabular-nums text-white">
          {fmtUsd(p.valueUsd)}
        </span>
        <span
          className={`text-sm font-semibold tabular-nums ${pnlClass(p.unrealizedPnlUsd)}`}
        >
          {p.unrealizedPnlUsd > 0 ? "+" : ""}
          {fmtUsd(p.unrealizedPnlUsd)}
          {Number.isFinite(p.unrealizedPnlPct) && (
            <span className="ml-1 text-[10px]">
              ({(p.unrealizedPnlPct * 100).toFixed(1)}%)
            </span>
          )}
        </span>
      </div>
      {/* row 3: fees + range */}
      <div className="flex items-baseline justify-between text-[11px]">
        <span>
          <span className="text-neutral-500">Fees</span>{" "}
          <span className="font-semibold tabular-nums text-emerald-300">
            {fmtUsd(p.unclaimedFeesUsd)}
          </span>
        </span>
        <span className="font-mono text-neutral-300">{range}</span>
      </div>
      {/* row 4: meta */}
      <div className="flex items-baseline justify-between text-[10px] text-neutral-500">
        <span className="truncate">
          {p.label ?? shortAddr(p.wallet, 4, 4)}
        </span>
        {created && <span className="font-mono">{created}</span>}
      </div>
    </div>
  );
}

// Stacked token-icon pair display. Falls back to the in-app tokenIconUrl
// if the LP provider didn't supply an icon URL; final fallback is a colored
// placeholder. Uses native <img> rather than next/image to avoid configuring
// every CDN domain in next.config.
function PairIcons({
  tokenX,
  tokenY,
  size = 20,
}: {
  tokenX: LpPosition["tokenX"];
  tokenY: LpPosition["tokenY"];
  size?: number;
}) {
  const overlap = Math.round(size * 0.4);
  const containerWidth = size * 2 - overlap;
  return (
    <span
      className="relative inline-flex shrink-0 items-center"
      style={{ width: containerWidth, height: size }}
    >
      <PairIcon token={tokenX} size={size} style={{ left: 0, zIndex: 2 }} />
      <PairIcon
        token={tokenY}
        size={size}
        style={{ left: size - overlap, zIndex: 1 }}
      />
    </span>
  );
}

function PairIcon({
  token,
  size,
  style,
}: {
  token: LpPosition["tokenX"];
  size: number;
  style: React.CSSProperties;
}) {
  // Deterministic fallback: small inline SVG with the token's first two
  // characters, used when the provider didn't supply an icon URL. We don't
  // attach an onError handler here — that would force a "use client" boundary
  // on this server-renderable module. If a provider URL ever returns 404
  // the broken-image glyph is fine for a leg of a pair display.
  const placeholder = `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><circle cx='12' cy='12' r='12' fill='%23262626'/><text x='50%' y='55%' font-size='10' text-anchor='middle' fill='%23a3a3a3' font-family='sans-serif'>${(token.symbol ?? "?").slice(0, 2)}</text></svg>`,
  )}`;
  const src = token.icon ?? placeholder;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={token.symbol ?? token.mint}
      width={size}
      height={size}
      className="absolute rounded-full bg-neutral-800 ring-2 ring-neutral-900"
      style={{ width: size, height: size, ...style }}
    />
  );
}

export function TradesTable({
  title,
  subtitle,
  trades,
  headerRight,
}: {
  title: string;
  subtitle?: React.ReactNode;
  trades: TradeItem[];
  headerRight?: React.ReactNode;
}) {
  type Row = (typeof trades)[number];
  const cols: Column<Row>[] = [
    {
      key: "time",
      label: "Time",
      span: 2,
      render: (t) => (
        <span className="whitespace-nowrap font-mono text-xs text-neutral-300">
          {fmtTime(t.time)}
        </span>
      ),
    },
    {
      key: "wallet",
      label: "Wallet",
      span: 2,
      render: (t) => (
        <div className="min-w-0">
          {t.label ? (
            <span className="text-xs font-semibold text-white">{t.label}</span>
          ) : (
            <WalletLink address={t.wallet} />
          )}
        </div>
      ),
    },
    {
      key: "from",
      label: "From",
      span: 2,
      render: (t) => (
        <span className="text-xs tabular-nums font-semibold text-white">
          {fmtNumber(t.from.amount)} <span className="font-normal text-neutral-300">{t.from.token.symbol}</span>
        </span>
      ),
    },
    {
      key: "to",
      label: "To",
      span: 2,
      render: (t) => (
        <span className="text-xs tabular-nums font-semibold text-white">
          {fmtNumber(t.to.amount)} <span className="font-normal text-neutral-300">{t.to.token.symbol}</span>
        </span>
      ),
    },
    {
      key: "usd",
      label: "USD",
      span: 1,
      align: "right",
      render: (t) => (
        <span className="tabular-nums font-bold text-white">{fmtUsd(t.volume.usd)}</span>
      ),
    },
    {
      key: "dex",
      label: "DEX",
      span: 2,
      align: "right",
      render: (t) => <Badge variant="neutral">{t.program}</Badge>,
    },
    {
      key: "tx",
      label: "Tx",
      span: 1,
      align: "right",
      render: (t) => <TxLink signature={t.tx} />,
    },
  ];

  const composedSubtitle =
    subtitle || headerRight ? (
      <span className="inline-flex items-center gap-2">
        {subtitle && <span>{subtitle}</span>}
        {headerRight}
      </span>
    ) : undefined;
  return (
    <Panel title={title} subtitle={composedSubtitle}>
      <Table
        columns={cols}
        rows={trades}
        rowKey={(t) => t.tx}
        rowClassName={(t) =>
          (t.volume?.usd ?? 0) > HIGHLIGHT_TRADE_USD ? "bg-amber-500/5" : ""
        }
        empty="No recent trades."
      />
    </Panel>
  );
}

export function RecentTradesView({
  data,
  headerRight,
}: {
  data: GroupTradesResponse;
  headerRight?: React.ReactNode;
}) {
  return (
    <TradesTable
      title="Recent trades"
      subtitle={`latest ${data.limit}`}
      trades={data.trades}
      headerRight={headerRight}
    />
  );
}

export function FilteredTradesView({
  trades,
  error,
  filters,
  headerRight,
}: {
  trades: TradeItem[] | null;
  error: string | null;
  filters: { minUsd?: string; token?: string; side?: "buy" | "sell"; program?: string };
  headerRight?: React.ReactNode;
}) {
  const summary = [
    filters.minUsd ? `≥ $${filters.minUsd}` : null,
    filters.token ? `token=${filters.token}` : null,
    filters.side ? `side=${filters.side}` : null,
    filters.program ? `program=${filters.program}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  if (error) {
    return (
      <Panel title="Recent trades" subtitle={headerRight}>
        <div className="px-4 py-3 text-sm text-red-400">{error}</div>
      </Panel>
    );
  }
  if (!trades || trades.length === 0) {
    const anyFilter = Boolean(
      filters.minUsd || filters.token || filters.side || filters.program,
    );
    return (
      <Panel
        title="Recent trades"
        subtitle={
          <span className="inline-flex items-center gap-2">
            {summary && <span>{summary}</span>}
            {headerRight}
          </span>
        }
      >
        <div className="px-4 py-8 text-center text-sm text-neutral-500">
          {anyFilter ? (
            <>
              No trades match the current filters.
              <div className="mt-1 text-xs text-neutral-500">
                Clear filters above to see all recent trades.
              </div>
            </>
          ) : (
            <>
              No trades yet for this group.
              <div className="mt-1 text-xs text-neutral-500">
                Trades from the past few hours appear here automatically once
                wallets transact.
              </div>
            </>
          )}
        </div>
      </Panel>
    );
  }
  return (
    <TradesTable
      title="Recent trades"
      subtitle={summary}
      trades={trades}
      headerRight={headerRight}
    />
  );
}

// Trade-row shaped skeleton with provider-named caption. Used during initial
// cold load when no cached trades are available yet.
export function TradesLoadingSkeleton() {
  return (
    <Panel
      title="Recent trades"
      subtitle={
        <span className="inline-flex items-center gap-1.5 text-violet-300">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-violet-400" />
          Loading trades from SolanaTracker…
        </span>
      }
    >
      <div className="grid grid-cols-12 gap-3 border-b border-neutral-800 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-neutral-300">
        <div className="col-span-2">Time</div>
        <div className="col-span-2">Wallet</div>
        <div className="col-span-2">From</div>
        <div className="col-span-2">To</div>
        <div className="col-span-1 text-right">USD</div>
        <div className="col-span-2 text-right">DEX</div>
        <div className="col-span-1 text-right">Tx</div>
      </div>
      <div className="divide-y divide-neutral-800">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="grid grid-cols-12 items-center gap-3 px-3 py-2 animate-pulse"
            style={{ animationDelay: `${i * 70}ms` }}
          >
            <div className="col-span-2 h-3 w-20 rounded bg-neutral-800" />
            <div className="col-span-2 h-3 w-24 rounded bg-neutral-800" />
            <div className="col-span-2 h-3 w-20 rounded bg-neutral-800" />
            <div className="col-span-2 h-3 w-20 rounded bg-neutral-800" />
            <div className="col-span-1 flex justify-end">
              <div className="h-3 w-14 rounded bg-neutral-800" />
            </div>
            <div className="col-span-2 flex justify-end">
              <div className="h-3 w-16 rounded bg-neutral-800" />
            </div>
            <div className="col-span-1 flex justify-end">
              <div className="h-3 w-8 rounded bg-neutral-800" />
            </div>
          </div>
        ))}
      </div>
      <div className="border-t border-neutral-800 bg-neutral-950/60 px-3 py-2 text-center text-[11px] text-neutral-400">
        SolanaTracker may rate-limit; retries happen automatically.
      </div>
    </Panel>
  );
}

// Skeleton/loading/error helpers shared with the lazy wrappers ----------------

export function PanelSkeleton({ title, lines = 4 }: { title: string; lines?: number }) {
  return (
    <Panel
      title={title}
      subtitle={
        <span className="inline-flex items-center gap-1.5 text-violet-300">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-violet-400" />
          Loading…
        </span>
      }
    >
      <div className="divide-y divide-neutral-800">
        {Array.from({ length: lines }).map((_, i) => (
          <div
            key={i}
            className="grid grid-cols-12 items-center gap-3 px-3 py-2 animate-pulse"
          >
            <div className="col-span-4 h-3 rounded bg-neutral-800" />
            <div className="col-span-2 h-3 rounded bg-neutral-800" />
            <div className="col-span-2 h-3 rounded bg-neutral-800" />
            <div className="col-span-2 h-3 rounded bg-neutral-800" />
            <div className="col-span-2 h-3 rounded bg-neutral-800" />
          </div>
        ))}
      </div>
    </Panel>
  );
}

export function PanelError({
  title,
  error,
  onRetry,
}: {
  title: string;
  error: string;
  onRetry: () => void;
}) {
  return (
    <Panel title={title}>
      <div className="flex items-center justify-between gap-3 px-3 py-3">
        <div className="text-sm text-[color:var(--vl-red)]">{error}</div>
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md border border-[color:var(--vl-border)] bg-transparent px-2.5 py-1 text-xs font-semibold text-[color:var(--vl-fg)] transition-all duration-[var(--vl-motion,180ms)] hover:border-[var(--vl-purple)] hover:bg-[rgba(168,144,232,0.08)] hover:text-[color:var(--vl-purple-2)]"
        >
          Retry
        </button>
      </div>
    </Panel>
  );
}

// PnL-overview-specific skeleton: 5 metric tiles + wallet-row table shape with
// a SolanaTracker caption. Used during initial cold load.
export function PnlOverviewLoadingSkeleton() {
  return (
    <section className="space-y-2">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="vl-card p-3 animate-pulse"
            style={{ animationDelay: `${i * 60}ms` }}
          >
            <div className="h-2 w-16 rounded bg-[color:var(--vl-surface-2)]" />
            <div className="mt-2 h-5 w-24 rounded bg-[color:var(--vl-surface-2)]" />
          </div>
        ))}
      </div>
      <Panel
        title="PnL overview"
        subtitle={
          <span className="inline-flex items-center gap-1.5 text-violet-300">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-violet-400" />
            Loading PnL from SolanaTracker…
          </span>
        }
      >
        <div className="grid grid-cols-12 gap-3 border-b border-neutral-800 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-neutral-300">
          <div className="col-span-4">Wallet</div>
          <div className="col-span-2 text-right">Total</div>
          <div className="col-span-2 text-right">Realized</div>
          <div className="col-span-2 text-right">Win rate</div>
          <div className="col-span-2 text-right">Trades</div>
        </div>
        <div className="divide-y divide-neutral-800">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="grid grid-cols-12 items-center gap-3 px-3 py-2 animate-pulse"
              style={{ animationDelay: `${i * 70}ms` }}
            >
              <div className="col-span-4 h-3 w-32 rounded bg-neutral-800" />
              <div className="col-span-2 flex justify-end">
                <div className="h-3 w-16 rounded bg-neutral-800" />
              </div>
              <div className="col-span-2 flex justify-end">
                <div className="h-3 w-16 rounded bg-neutral-800" />
              </div>
              <div className="col-span-2 flex justify-end">
                <div className="h-3 w-12 rounded bg-neutral-800" />
              </div>
              <div className="col-span-2 flex justify-end">
                <div className="h-3 w-10 rounded bg-neutral-800" />
              </div>
            </div>
          ))}
        </div>
        <div className="border-t border-neutral-800 bg-neutral-950/60 px-3 py-2 text-center text-[11px] text-neutral-400">
          SolanaTracker may rate-limit; retries happen automatically.
        </div>
      </Panel>
    </section>
  );
}

// Portfolio-specific skeleton: token-row shape (avatar + name + values) and a
// clear caption naming the upstream provider. Used during initial cold load.
export function PortfolioLoadingSkeleton() {
  return (
    <Panel
      title="Portfolio"
      subtitle={
        <span className="inline-flex items-center gap-1.5 text-violet-300">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-violet-400" />
          Loading portfolio from Helius…
        </span>
      }
    >
      <div className="grid grid-cols-12 gap-3 border-b border-neutral-800 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-neutral-300">
        <div className="col-span-6">Token</div>
        <div className="col-span-2 text-right">Balance</div>
        <div className="col-span-2 text-right">Value</div>
        <div className="col-span-2 text-right">Wallets</div>
      </div>
      <div className="divide-y divide-neutral-800">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="grid grid-cols-12 items-center gap-3 px-3 py-2 animate-pulse"
            style={{ animationDelay: `${i * 80}ms` }}
          >
            <div className="col-span-6 flex items-center gap-2">
              <div className="h-7 w-7 shrink-0 rounded-full bg-neutral-800" />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="h-3 w-24 rounded bg-neutral-800" />
                <div className="h-2 w-32 rounded bg-neutral-800/60" />
              </div>
            </div>
            <div className="col-span-2 flex justify-end">
              <div className="h-3 w-16 rounded bg-neutral-800" />
            </div>
            <div className="col-span-2 flex justify-end">
              <div className="h-3 w-20 rounded bg-neutral-800" />
            </div>
            <div className="col-span-2 flex justify-end">
              <div className="h-3 w-8 rounded bg-neutral-800" />
            </div>
          </div>
        ))}
      </div>
      <div className="border-t border-neutral-800 bg-neutral-950/60 px-3 py-2 text-center text-[11px] text-neutral-400">
        Cold loads can take a few seconds while Helius aggregates balances across wallets.
      </div>
    </Panel>
  );
}

export function SectionFallback({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <SectionHeader>{title}</SectionHeader>
      <Card className="p-4 text-sm text-neutral-500">{children}</Card>
    </section>
  );
}
