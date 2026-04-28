import Link from "next/link";
import { api } from "@/lib/api";
import { addWalletAction, removeWalletAction } from "../actions";
import { TradeFilters } from "./trade-filters";
import { AlertMonitor } from "./alert-monitor";
import { SignalMonitor } from "./signal-monitor";
import { ServerAlerts } from "./server-alerts";
import { CleanerSection } from "./cleaner";
import { Tabs } from "./tabs";
import { TAB_IDS, type TabId } from "./tab-types";
import {
  LazyAirdrops,
  LazyLp,
  LazyPnlOverview,
  LazyPortfolio,
  LazySmartSignals,
  LazyTokenActivity,
  LazyTrades,
} from "./lazy";
import type { AlertRule } from "@/lib/api";
import { Card } from "@/ui-kit/components/Card";
import { Badge } from "@/ui-kit/components/Badge";
import { SectionHeader } from "@/ui-kit/components/SectionHeader";
import { WalletLink } from "@/ui-kit/components/WalletLink";
import { btnPrimary, btnDangerLink } from "@/lib/buttonStyles";

export const dynamic = "force-dynamic";

interface PageSearchParams {
  minUsd?: string;
  token?: string;
  side?: string;
  program?: string;
  tab?: string;
}

function resolveTab(raw: string | undefined): TabId {
  return (TAB_IDS as readonly string[]).includes(raw ?? "")
    ? (raw as TabId)
    : "positions";
}

function normalizeFilters(sp: PageSearchParams) {
  const out: { minUsd?: string; token?: string; side?: "buy" | "sell"; program?: string } = {};
  if (sp.minUsd && sp.minUsd.trim() !== "") out.minUsd = sp.minUsd.trim();
  if (sp.token && sp.token.trim() !== "") out.token = sp.token.trim();
  if (sp.side === "buy" || sp.side === "sell") out.side = sp.side;
  if (sp.program && sp.program.trim() !== "") out.program = sp.program.trim();
  return out;
}

export default async function GroupDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<PageSearchParams>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const filters = normalizeFilters(sp);
  const hasFilters = Object.keys(filters).length > 0;
  const tab = resolveTab(sp.tab);

  // Initial server fetch is intentionally minimal:
  // group wallets + alert status + alert rules. All heavy provider-backed
  // sections (PnL, portfolio, LP, airdrops, token activity, trades) load on
  // the client when their tab is active.
  let wallets: Awaited<ReturnType<typeof api.getGroupWallets>>["wallets"] = [];
  let groupName = "Group";
  let alertStatus: { running: boolean; intervalMs: number | null } = {
    running: false,
    intervalMs: null,
  };
  let signalStatus: { running: boolean; intervalMs: number | null } = {
    running: false,
    intervalMs: null,
  };
  let alertRules: AlertRule[] = [];
  let error: string | null = null;

  try {
    const [w, s, sigStatus, ar, groups] = await Promise.all([
      api.getGroupWallets(id),
      api.getAlertStatus(id).catch(() => ({ running: false, intervalMs: null as number | null })),
      api
        .getSignalStatus(id)
        .catch(() => ({ running: false, intervalMs: null as number | null })),
      api.listAlertRules(id).catch(() => ({ groupId: id, alerts: [] as AlertRule[] })),
      // Cheap call: just gives us the group name without forcing any provider work.
      api.listGroups().catch(() => ({ groups: [] as { id: string; name: string }[] })),
    ]);
    wallets = w.wallets;
    alertStatus = { running: s.running, intervalMs: s.intervalMs };
    signalStatus = { running: sigStatus.running, intervalMs: sigStatus.intervalMs };
    alertRules = ar.alerts;
    const found = groups.groups.find((g) => g.id === id);
    if (found) groupName = found.name;
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load";
  }

  if (error) {
    return (
      <div className="space-y-4">
        <Link href="/groups" className="text-sm text-neutral-400 hover:text-white">
          ← Back to groups
        </Link>
        <Card className="p-2.5">
          <div className="text-sm text-red-400">{error}</div>
        </Card>
      </div>
    );
  }

  const addWallet = addWalletAction.bind(null, id);

  return (
    <div className="space-y-3">
      {/* full-width hero — group name + wallet count. PnL/portfolio totals
          are deferred to the lazy panels so the initial page load stays fast. */}
      <div className="ui-fade-in">
        <Link
          href="/groups"
          className="text-xs text-neutral-500 transition-colors duration-100 hover:text-white"
        >
          ← Back to groups
        </Link>
        <Hero groupName={groupName} walletsCount={wallets.length} />
      </div>

      <Tabs active={tab} groupId={id} />

      {tab === "positions" && (
        <div className="space-y-3">
          <LazyPnlOverview groupId={id} />
          <LazyPortfolio groupId={id} />
          <LazyLp groupId={id} />
          <LazyAirdrops groupId={id} />
        </div>
      )}

      {tab === "activity" && (
        <div className="space-y-3">
          <TradeFilters groupId={id} filters={filters} />
          <SignalMonitor groupId={id} initialStatus={signalStatus} />
          <LazySmartSignals groupId={id} />
          <LazyTokenActivity groupId={id} />
          <LazyTrades groupId={id} filters={filters} hasFilters={hasFilters} />
        </div>
      )}

      {tab === "alerts" && (
        <div className="space-y-3">
          <ServerAlerts groupId={id} rules={alertRules} />
          <AlertMonitor groupId={id} initialStatus={alertStatus} />
        </div>
      )}

      {tab === "cleaner" && (
        <div className="space-y-3">
          <CleanerSection
            wallets={wallets.map((w) => ({ address: w.address, label: w.label }))}
          />
        </div>
      )}

      {tab === "settings" && (
        <div className="space-y-3">
          <WalletsSection groupId={id} wallets={wallets} addAction={addWallet} />
          <DebugInfo
            groupId={id}
            walletsCount={wallets.length}
            alertsCount={alertRules.length}
            pollerRunning={alertStatus.running}
            pollerIntervalMs={alertStatus.intervalMs}
          />
        </div>
      )}
    </div>
  );
}

function DebugInfo({
  groupId,
  walletsCount,
  alertsCount,
  pollerRunning,
  pollerIntervalMs,
}: {
  groupId: string;
  walletsCount: number;
  alertsCount: number;
  pollerRunning: boolean;
  pollerIntervalMs: number | null;
}) {
  const rows: { label: string; value: string }[] = [
    { label: "Group ID", value: groupId },
    { label: "Wallets", value: String(walletsCount) },
    { label: "Server alert rules", value: String(alertsCount) },
    { label: "Alert poller", value: pollerRunning ? "running" : "idle" },
    {
      label: "Poller interval",
      value:
        pollerIntervalMs !== null ? `${(pollerIntervalMs / 1000).toFixed(0)}s` : "—",
    },
  ];
  return (
    <div className="overflow-hidden rounded-md border border-neutral-700 bg-neutral-900">
      <div className="flex items-center justify-between border-b border-neutral-700 px-3 py-1.5">
        <SectionHeader className="mb-0">Debug</SectionHeader>
      </div>
      <div className="divide-y divide-neutral-800">
        {rows.map((r) => (
          <div
            key={r.label}
            className="flex items-center justify-between px-3 py-1.5 text-xs"
          >
            <span className="text-neutral-300">{r.label}</span>
            <span className="font-mono text-white tabular-nums">{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Hero({
  groupName,
  walletsCount,
}: {
  groupName: string;
  walletsCount: number;
}) {
  return (
    <div className="mt-3 overflow-hidden rounded-md border border-neutral-700 bg-gradient-to-br from-violet-500/[0.06] via-transparent to-transparent">
      <div className="relative grid grid-cols-1 gap-4 px-4 py-3 sm:grid-cols-2 sm:px-5 sm:py-4">
        <div>
          <SectionHeader className="mb-1">Group</SectionHeader>
          <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
            {groupName}
          </h1>
          <div className="mt-2 text-xs font-medium text-neutral-300">
            {walletsCount} wallet{walletsCount === 1 ? "" : "s"}
          </div>
        </div>

        <div className="sm:text-right">
          <SectionHeader className="mb-2">Portfolio value</SectionHeader>
          <div className="text-4xl font-bold leading-none tracking-tight tabular-nums text-neutral-500 sm:text-5xl">
            —
          </div>
          <div className="mt-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
            shown on Positions tab
          </div>
        </div>
      </div>
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
      <div className="mb-2 flex items-baseline justify-between">
        <SectionHeader className="mb-0">Wallets</SectionHeader>
        <Badge>{wallets.length}</Badge>
      </div>
      <Card className="p-2.5">
        <form action={addAction} className="flex flex-wrap gap-2">
          <input
            name="wallet"
            required
            placeholder="Solana wallet address"
            className="flex-1 min-w-[200px] rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-xs font-mono text-white placeholder:text-neutral-500 transition-colors duration-100 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500/30"
          />
          <input
            name="label"
            placeholder="label"
            className="w-28 rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-xs text-white placeholder:text-neutral-500 transition-colors duration-100 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500/30"
          />
          <button type="submit" className={btnPrimary}>
            Add
          </button>
        </form>

        {wallets.length === 0 ? (
          <p className="mt-2 text-xs text-neutral-500">No wallets yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-neutral-800 text-sm">
            {wallets.map((w) => (
              <li key={w.address} className="flex items-center justify-between py-1.5">
                <div className="min-w-0">
                  <WalletLink address={w.address} chars={6} className="text-xs" />
                  {w.label && (
                    <div className="text-[11px] font-medium text-neutral-300">{w.label}</div>
                  )}
                </div>
                <form
                  action={async () => {
                    "use server";
                    await removeWalletAction(groupId, w.address);
                  }}
                >
                  <button className={btnDangerLink}>Remove</button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}
