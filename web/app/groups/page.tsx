import Link from "next/link";
import { api, type SystemStatus } from "@/lib/api";
import { createGroupAction } from "./actions";
import { Card } from "@/ui-kit/components/Card";
import { SectionHeader } from "@/ui-kit/components/SectionHeader";
import { Badge } from "@/ui-kit/components/Badge";
import { btnPrimary } from "@/lib/buttonStyles";

export const dynamic = "force-dynamic";

export default async function GroupsPage() {
  let groups: Awaited<ReturnType<typeof api.listGroups>>["groups"] = [];
  let status: SystemStatus | null = null;
  let error: string | null = null;
  try {
    const [g, s] = await Promise.all([
      api.listGroups(),
      api.getStatus().catch(() => null),
    ]);
    groups = g.groups;
    status = s;
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load";
  }

  return (
    <div className="space-y-4 ui-fade-in">
      <section>
        <SectionHeader>Wallet groups</SectionHeader>
        <h1 className="text-3xl font-bold tracking-tight text-white">Groups</h1>
        <p className="mt-1 text-sm text-neutral-300">
          State persists to{" "}
          <code className="rounded bg-neutral-900 px-1 py-0.5 text-xs text-neutral-200">
            data/groups.json
          </code>{" "}
          on the backend.
        </p>
      </section>

      <SystemStatusSection status={status} />

      <section>
        <SectionHeader>Create group</SectionHeader>
        <Card className="p-2.5">
          <form action={createGroupAction} className="flex gap-2">
            <input
              type="text"
              name="name"
              required
              placeholder="e.g. Whales"
              className="flex-1 rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-white placeholder:text-neutral-500 transition-colors duration-100 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500/30"
            />
            <button type="submit" className={btnPrimary}>
              Create
            </button>
          </form>
        </Card>
      </section>

      <section>
        <div className="mb-2 flex items-baseline justify-between">
          <SectionHeader className="mb-0">All groups</SectionHeader>
          <Badge>{groups.length}</Badge>
        </div>
        {error ? (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
            {error}
          </div>
        ) : groups.length === 0 ? (
          <Card className="p-8 text-center text-sm text-neutral-500">
            No groups yet — create one above.
          </Card>
        ) : (
          <Card className="overflow-hidden">
            <ul className="divide-y divide-neutral-800">
              {groups.map((g) => (
                <li key={g.id}>
                  <Link
                    href={`/groups/${g.id}`}
                    className="flex items-center justify-between px-4 py-3 transition-colors duration-100 hover:bg-neutral-800/60"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-white">{g.name}</div>
                      <div className="mt-0.5 text-xs text-neutral-300">
                        {g.wallets.length} wallet{g.wallets.length === 1 ? "" : "s"} ·
                        created {new Date(g.createdAt).toISOString().slice(0, 10)}
                      </div>
                    </div>
                    <span className="font-mono text-xs text-neutral-300">
                      {g.id.slice(0, 8)}…
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>
    </div>
  );
}

function SystemStatusSection({ status }: { status: SystemStatus | null }) {
  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between">
        <SectionHeader className="mb-0">System status</SectionHeader>
        {status && (
          <span className="text-xs text-neutral-500">
            <span className="ui-live-dot mr-2" />
            {status.pollers.runningCount} poller
            {status.pollers.runningCount === 1 ? "" : "s"} running
          </span>
        )}
      </div>
      {!status ? (
        <Card className="p-3 text-xs text-amber-400">
          Backend status unavailable.
        </Card>
      ) : (
        <Card className="p-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatusItem label="SolanaTracker" on={status.env.solanaTrackerConfigured} />
            <StatusItem label="Helius" on={status.env.heliusConfigured} />
            <StatusItem label="Telegram" on={status.env.telegramConfigured} />
            <StatusItem label="API auth" on={status.env.appAuthEnabled} />
          </div>
        </Card>
      )}
    </section>
  );
}

function StatusItem({ label, on }: { label: string; on: boolean }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span
        className={`inline-block h-2 w-2 rounded-full ${on ? "bg-emerald-500" : "bg-neutral-700"}`}
        aria-hidden
      />
      <span className="font-semibold text-white">{label}</span>
      <span className={`text-xs ${on ? "text-emerald-300" : "text-neutral-500"}`}>{on ? "on" : "off"}</span>
    </div>
  );
}
