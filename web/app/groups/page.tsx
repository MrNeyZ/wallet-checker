import { api, type Group, type SystemStatus } from "@/lib/api";
import { createGroupAction } from "./actions";
import { GroupsListClient } from "./groups-list-client";
import { Card } from "@/ui-kit/components/Card";
import { SectionHeader } from "@/ui-kit/components/SectionHeader";
import { btnVlPrimary } from "@/lib/buttonStyles";

export const dynamic = "force-dynamic";

// Server component renders the page chrome + does the initial data
// fetch for fast first paint. Refresh / retry / polling are handled by
// the GroupsListClient sub-tree (which re-fetches via loadGroupsAction).
export default async function GroupsPage() {
  let groups: Group[] = [];
  let status: SystemStatus | null = null;
  let initialError: string | null = null;
  try {
    const [g, s] = await Promise.all([
      api.listGroups(),
      api.getStatus().catch(() => null),
    ]);
    groups = g.groups;
    status = s;
  } catch (err) {
    initialError = err instanceof Error ? err.message : "Failed to load";
  }

  return (
    <div className="space-y-4 ui-fade-in">
      <section>
        <SectionHeader tone="vl">Wallet groups</SectionHeader>
        <h1 className="text-3xl font-bold tracking-tight text-white">Groups</h1>
        <p className="mt-1 text-sm text-[color:var(--vl-fg-2)]">
          State persists to{" "}
          <code className="rounded bg-[color:var(--vl-bg-2)] px-1 py-0.5 text-xs text-[color:var(--vl-fg)]">
            data/groups.json
          </code>{" "}
          on the backend.
        </p>
      </section>

      <SystemStatusSection status={status} />

      <section>
        <SectionHeader tone="vl">Create group</SectionHeader>
        <Card tone="vl" className="p-3">
          <form action={createGroupAction} className="flex gap-2">
            <input
              type="text"
              name="name"
              required
              placeholder="e.g. Whales"
              className="vl-text-input flex-1"
            />
            <button type="submit" className={btnVlPrimary}>
              Create
            </button>
          </form>
        </Card>
      </section>

      <GroupsListClient
        initialGroups={groups}
        initialStatus={status}
        initialError={initialError}
      />
    </div>
  );
}

function SystemStatusSection({ status }: { status: SystemStatus | null }) {
  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between">
        <SectionHeader tone="vl" className="mb-0">System status</SectionHeader>
        {status && (
          <span className="text-xs text-[color:var(--vl-fg-3)]">
            <span className="ui-live-dot mr-2" />
            {status.pollers.runningCount} poller
            {status.pollers.runningCount === 1 ? "" : "s"} running
          </span>
        )}
      </div>
      {!status ? (
        <Card tone="vl" className="p-3 text-xs text-[color:var(--vl-amber)]">
          Backend status unavailable.
        </Card>
      ) : (
        <Card tone="vl" className="p-4">
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
        className={`inline-block h-2 w-2 rounded-full ${
          on ? "bg-[color:var(--vl-green)] shadow-[0_0_6px_var(--vl-green)]" : "bg-[color:var(--vl-fg-4)]"
        }`}
        aria-hidden
      />
      <span className="font-semibold text-white">{label}</span>
      <span className={`text-xs ${on ? "text-[color:var(--vl-green)]" : "text-[color:var(--vl-fg-3)]"}`}>
        {on ? "on" : "off"}
      </span>
    </div>
  );
}
