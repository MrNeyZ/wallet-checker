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
  PortfolioResponse,
  TokenActivityResponse,
  TradeItem,
} from "@/lib/api";
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
    <div className="overflow-hidden rounded-md border border-neutral-700 bg-neutral-900">
      <div className="flex items-center justify-between border-b border-neutral-700 px-3 py-1.5">
        <SectionHeader className="mb-0">{title}</SectionHeader>
        {subtitle && (
          <span className="text-xs text-neutral-300 tabular-nums">{subtitle}</span>
        )}
      </div>
      {children}
    </div>
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
          <div key={m.label} className="rounded-md border border-neutral-800 bg-neutral-900 p-2.5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-neutral-300">
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

export function LpView({ data }: { data: GroupLpResponse }) {
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
        <div>
          <div className="grid grid-cols-12 gap-3 border-b border-neutral-800 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-neutral-300">
            <div className="col-span-2">Wallet</div>
            <div className="col-span-1">Protocol</div>
            <div className="col-span-2">Pair</div>
            <div className="col-span-2 text-right">Value</div>
            <div className="col-span-1 text-right">Fees</div>
            <div className="col-span-2 text-right">PnL</div>
            <div className="col-span-1 text-right">Range</div>
            <div className="col-span-1 text-right">Created</div>
          </div>
          <div>
            {data.positions.map((p) => (
              <LpRow key={p.positionAddress} position={p} />
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}

function LpRow({ position: p }: { position: LpPosition }) {
  const pair = p.pairName ?? `${p.tokenX.symbol ?? "?"}-${p.tokenY.symbol ?? "?"}`;
  const range =
    p.lowerBinId !== null && p.upperBinId !== null
      ? `${p.lowerBinId}…${p.upperBinId}`
      : "—";
  const created = p.createdAt
    ? new Date(p.createdAt * 1000).toISOString().slice(0, 10)
    : "—";
  return (
    <div className="grid grid-cols-12 items-center gap-3 border-b border-neutral-800 px-3 py-1.5 transition-colors duration-100 last:border-b-0 hover:bg-neutral-800/60">
      <div className="col-span-2 min-w-0">
        {p.label ? (
          <span className="text-xs font-semibold text-white">{p.label}</span>
        ) : (
          <WalletLink address={p.wallet} chars={4} />
        )}
      </div>
      <div className="col-span-1">
        <Badge variant="info">DLMM</Badge>
      </div>
      <div className="col-span-2 min-w-0">
        <div className="truncate text-sm font-semibold text-white">{pair}</div>
      </div>
      <div className="col-span-2 text-right text-sm font-bold tabular-nums text-white">
        {fmtUsd(p.valueUsd)}
      </div>
      <div className="col-span-1 text-right text-sm font-semibold tabular-nums text-emerald-300">
        {fmtUsd(p.unclaimedFeesUsd)}
      </div>
      <div className="col-span-2 text-right">
        <span
          className={`text-sm font-semibold tabular-nums ${pnlClass(p.unrealizedPnlUsd)}`}
        >
          {fmtUsd(p.unrealizedPnlUsd)}
        </span>
        {Number.isFinite(p.unrealizedPnlPct) && (
          <span className={`ml-1 text-[10px] tabular-nums ${pnlClass(p.unrealizedPnlUsd)}`}>
            ({(p.unrealizedPnlPct * 100).toFixed(1)}%)
          </span>
        )}
      </div>
      <div className="col-span-1 text-right font-mono text-xs text-neutral-300">{range}</div>
      <div className="col-span-1 text-right font-mono text-xs text-neutral-300">{created}</div>
    </div>
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
          No trades found for current filters.
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
        <div className="text-sm text-red-400">{error}</div>
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md border border-neutral-700 bg-neutral-900 px-2.5 py-1 text-xs font-semibold text-white transition-colors duration-100 hover:bg-neutral-800"
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
            className="rounded-md border border-neutral-800 bg-neutral-900 p-2.5 animate-pulse"
            style={{ animationDelay: `${i * 60}ms` }}
          >
            <div className="h-2 w-16 rounded bg-neutral-800" />
            <div className="mt-2 h-5 w-24 rounded bg-neutral-800" />
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
