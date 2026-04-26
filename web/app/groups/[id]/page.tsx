import Link from "next/link";
import { api, type Dashboard } from "@/lib/api";
import { fmtUsd, fmtPercent, fmtNumber, fmtTime, shortAddr } from "@/lib/format";
import { addWalletAction, removeWalletAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function GroupDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let dashboard: Dashboard | null = null;
  let wallets: Awaited<ReturnType<typeof api.getGroupWallets>>["wallets"] = [];
  let error: string | null = null;

  try {
    const [d, w] = await Promise.all([api.getDashboard(id), api.getGroupWallets(id)]);
    dashboard = d;
    wallets = w.wallets;
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load";
  }

  if (error) {
    return (
      <div className="space-y-4">
        <Link href="/groups" className="text-sm text-zinc-600 hover:text-zinc-900">
          ← Back to groups
        </Link>
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      </div>
    );
  }

  if (!dashboard) return null;

  const addWallet = addWalletAction.bind(null, id);

  return (
    <div className="space-y-8">
      <div>
        <Link href="/groups" className="text-sm text-zinc-600 hover:text-zinc-900">
          ← Back to groups
        </Link>
        <div className="mt-2 flex items-baseline justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">{dashboard.groupName}</h1>
          <span className="text-xs text-zinc-500">
            {dashboard.walletsCount} wallet{dashboard.walletsCount === 1 ? "" : "s"}
          </span>
        </div>
      </div>

      {dashboard.warnings.length > 0 && (
        <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <div className="font-medium">Warnings</div>
          <ul className="mt-1 list-inside list-disc space-y-0.5">
            {dashboard.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <WalletsSection groupId={id} wallets={wallets} addAction={addWallet} />

      <PnlOverviewSection data={dashboard.pnlOverview} />

      <PortfolioSection data={dashboard.portfolioSummary} />

      <TokenActivitySection data={dashboard.tokenActivitySummary} />

      <RecentTradesSection data={dashboard.recentTrades} />
    </div>
  );
}

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-3 flex items-baseline justify-between">
      <h2 className="text-sm font-medium uppercase tracking-wider text-zinc-500">{title}</h2>
      {subtitle && <span className="text-xs text-zinc-400">{subtitle}</span>}
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="rounded border border-zinc-200 bg-white p-4">{children}</div>;
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded border border-dashed border-zinc-300 px-3 py-6 text-center text-sm text-zinc-500">
      {children}
    </div>
  );
}

function WalletsSection({
  groupId,
  wallets,
  addAction,
}: {
  groupId: string;
  wallets: { address: string; label: string | null; addedAt: string }[];
  addAction: (formData: FormData) => Promise<void>;
}) {
  return (
    <section>
      <SectionHeader title="Wallets" subtitle={`${wallets.length} total`} />
      <Card>
        <form action={addAction} className="flex flex-wrap gap-2">
          <input
            name="wallet"
            required
            placeholder="Solana wallet address"
            className="flex-1 min-w-[280px] rounded border border-zinc-300 bg-white px-3 py-2 text-sm font-mono focus:border-zinc-500 focus:outline-none"
          />
          <input
            name="label"
            placeholder="label (optional)"
            className="w-40 rounded border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
          />
          <button
            type="submit"
            className="rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700"
          >
            Add wallet
          </button>
        </form>

        {wallets.length === 0 ? (
          <p className="mt-3 text-xs text-zinc-500">No wallets yet.</p>
        ) : (
          <ul className="mt-4 divide-y divide-zinc-100 text-sm">
            {wallets.map((w) => (
              <li key={w.address} className="flex items-center justify-between py-2">
                <div>
                  <div className="font-mono text-xs">{w.address}</div>
                  {w.label && <div className="text-xs text-zinc-500">{w.label}</div>}
                </div>
                <form
                  action={async () => {
                    "use server";
                    await removeWalletAction(groupId, w.address);
                  }}
                >
                  <button className="text-xs text-zinc-500 hover:text-red-600">Remove</button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}

function PnlOverviewSection({ data }: { data: Dashboard["pnlOverview"] }) {
  if (!data) {
    return (
      <section>
        <SectionHeader title="PnL overview" />
        <EmptyHint>Section unavailable.</EmptyHint>
      </section>
    );
  }
  const t = data.totals;
  return (
    <section>
      <SectionHeader title="PnL overview" subtitle={`${data.ok} ok · ${data.failed} failed`} />
      <Card>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
          <Metric label="Total PnL" value={fmtUsd(t.totalPnlUsd)} signed={t.totalPnlUsd ?? null} />
          <Metric label="Realized" value={fmtUsd(t.realizedPnlUsd)} signed={t.realizedPnlUsd ?? null} />
          <Metric label="Unrealized" value={fmtUsd(t.unrealizedPnlUsd)} signed={t.unrealizedPnlUsd ?? null} />
          <Metric label="Trades" value={fmtNumber(t.totalTrades)} />
          <Metric label="Tokens" value={fmtNumber(t.tokensCount)} />
        </div>

        {data.results.length > 0 && (
          <table className="mt-4 w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-zinc-500">
              <tr>
                <th className="py-1">Wallet</th>
                <th>Total</th>
                <th>Realized</th>
                <th>Win rate</th>
                <th>Trades</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {data.results.map((r) => (
                <tr key={r.wallet}>
                  <td className="py-2">
                    <div className="font-mono text-xs">{shortAddr(r.wallet)}</div>
                    {r.label && <div className="text-xs text-zinc-500">{r.label}</div>}
                  </td>
                  {r.ok && r.summary ? (
                    <>
                      <td className={pnlClass(r.summary.totalPnlUsd)}>{fmtUsd(r.summary.totalPnlUsd)}</td>
                      <td className={pnlClass(r.summary.realizedPnlUsd)}>{fmtUsd(r.summary.realizedPnlUsd)}</td>
                      <td>{fmtPercent(r.summary.winRate)}</td>
                      <td>{fmtNumber(r.summary.totalTrades)}</td>
                    </>
                  ) : (
                    <td colSpan={4} className="text-xs text-red-600">
                      {r.error ?? "failed"}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </section>
  );
}

function Metric({
  label,
  value,
  signed,
}: {
  label: string;
  value: string;
  signed?: number | null;
}) {
  const cls =
    typeof signed === "number" && signed > 0
      ? "text-green-600"
      : typeof signed === "number" && signed < 0
      ? "text-red-600"
      : "text-zinc-900";
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-zinc-500">{label}</div>
      <div className={`mt-0.5 text-lg font-semibold ${cls}`}>{value}</div>
    </div>
  );
}

function pnlClass(v: number | null | undefined): string {
  if (typeof v !== "number") return "";
  if (v > 0) return "text-green-600";
  if (v < 0) return "text-red-600";
  return "";
}

function PortfolioSection({ data }: { data: Dashboard["portfolioSummary"] }) {
  if (!data) {
    return (
      <section>
        <SectionHeader title="Portfolio" />
        <EmptyHint>Section unavailable.</EmptyHint>
      </section>
    );
  }
  const top = data.tokens.slice(0, 10);
  return (
    <section>
      <SectionHeader
        title="Portfolio"
        subtitle={`${fmtUsd(data.totalUsd)} · ${fmtNumber(data.totalSol)} SOL · ${data.tokens.length} tokens`}
      />
      <Card>
        {top.length === 0 ? (
          <EmptyHint>No holdings.</EmptyHint>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-zinc-500">
              <tr>
                <th className="py-1">Token</th>
                <th>Balance</th>
                <th>Value</th>
                <th>Wallets</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {top.map((tk) => (
                <tr key={tk.mint}>
                  <td className="py-2">
                    <div className="font-medium">{tk.symbol ?? shortAddr(tk.mint)}</div>
                    {tk.name && <div className="text-xs text-zinc-500">{tk.name}</div>}
                  </td>
                  <td>{fmtNumber(tk.totalBalance)}</td>
                  <td className="font-medium">{fmtUsd(tk.totalValueUsd)}</td>
                  <td>{tk.walletsCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </section>
  );
}

function TokenActivitySection({ data }: { data: Dashboard["tokenActivitySummary"] }) {
  if (!data) {
    return (
      <section>
        <SectionHeader title="Token activity" />
        <EmptyHint>Section unavailable.</EmptyHint>
      </section>
    );
  }
  const top = data.tokens.slice(0, 10);
  return (
    <section>
      <SectionHeader
        title="Token activity"
        subtitle={`${data.tokens.length} tokens · perWalletLimit ${data.perWalletLimit}`}
      />
      <Card>
        {top.length === 0 ? (
          <EmptyHint>No swap activity.</EmptyHint>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-zinc-500">
              <tr>
                <th className="py-1">Token</th>
                <th>Buys</th>
                <th>Sells</th>
                <th>Buy USD</th>
                <th>Sell USD</th>
                <th>Net</th>
                <th>Wallets</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {top.map((tk) => (
                <tr key={tk.mint}>
                  <td className="py-2">
                    <div className="font-medium">{tk.symbol ?? shortAddr(tk.mint)}</div>
                    {tk.name && <div className="text-xs text-zinc-500">{tk.name}</div>}
                  </td>
                  <td>{tk.buysCount}</td>
                  <td>{tk.sellsCount}</td>
                  <td>{fmtUsd(tk.totalBuyUsd)}</td>
                  <td>{fmtUsd(tk.totalSellUsd)}</td>
                  <td className={pnlClass(tk.netUsd)}>{fmtUsd(tk.netUsd)}</td>
                  <td>{tk.walletsCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </section>
  );
}

function RecentTradesSection({ data }: { data: Dashboard["recentTrades"] }) {
  if (!data) {
    return (
      <section>
        <SectionHeader title="Recent trades" />
        <EmptyHint>Section unavailable.</EmptyHint>
      </section>
    );
  }
  return (
    <section>
      <SectionHeader title="Recent trades" subtitle={`latest ${data.limit}`} />
      <Card>
        {data.trades.length === 0 ? (
          <EmptyHint>No recent trades.</EmptyHint>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-zinc-500">
              <tr>
                <th className="py-1">Time</th>
                <th>Wallet</th>
                <th>From</th>
                <th>To</th>
                <th>USD</th>
                <th>DEX</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {data.trades.map((t) => (
                <tr key={t.tx}>
                  <td className="py-2 whitespace-nowrap text-xs text-zinc-600">{fmtTime(t.time)}</td>
                  <td className="text-xs">
                    <div>{t.label ?? shortAddr(t.wallet)}</div>
                  </td>
                  <td>
                    <span className="text-xs text-zinc-600">
                      {fmtNumber(t.from.amount)} {t.from.token.symbol}
                    </span>
                  </td>
                  <td>
                    <span className="text-xs text-zinc-600">
                      {fmtNumber(t.to.amount)} {t.to.token.symbol}
                    </span>
                  </td>
                  <td className="font-medium">{fmtUsd(t.volume.usd)}</td>
                  <td className="text-xs text-zinc-500">{t.program}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </section>
  );
}
