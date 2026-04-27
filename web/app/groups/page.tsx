import Link from "next/link";
import { api, type SystemStatus } from "@/lib/api";
import { createGroupAction } from "./actions";

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
    <div className="space-y-8">
      <section>
        <h1 className="mb-2 text-2xl font-semibold tracking-tight">Groups</h1>
        <p className="text-sm text-zinc-600">
          Wallet groups are stored in-memory + persisted to{" "}
          <code className="text-xs">data/groups.json</code> on the backend.
        </p>
      </section>

      <SystemStatusSection status={status} />

      <section>
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-zinc-500">
          Create group
        </h2>
        <form action={createGroupAction} className="flex gap-2">
          <input
            type="text"
            name="name"
            required
            placeholder="e.g. Whales"
            className="flex-1 rounded border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
          />
          <button
            type="submit"
            className="rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700"
          >
            Create
          </button>
        </form>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-zinc-500">
          All groups ({groups.length})
        </h2>
        {error ? (
          <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        ) : groups.length === 0 ? (
          <div className="rounded border border-dashed border-zinc-300 px-3 py-8 text-center text-sm text-zinc-500">
            No groups yet — create one above.
          </div>
        ) : (
          <ul className="divide-y divide-zinc-200 rounded border border-zinc-200 bg-white">
            {groups.map((g) => (
              <li key={g.id}>
                <Link
                  href={`/groups/${g.id}`}
                  className="flex items-center justify-between px-4 py-3 hover:bg-zinc-50"
                >
                  <div>
                    <div className="font-medium">{g.name}</div>
                    <div className="text-xs text-zinc-500">
                      {g.wallets.length} wallet{g.wallets.length === 1 ? "" : "s"} ·{" "}
                      created {new Date(g.createdAt).toISOString().slice(0, 10)}
                    </div>
                  </div>
                  <span className="text-xs text-zinc-400">{g.id.slice(0, 8)}…</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function SystemStatusSection({ status }: { status: SystemStatus | null }) {
  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-medium uppercase tracking-wider text-zinc-500">
          System status
        </h2>
        {status && (
          <span className="text-xs text-zinc-400">
            {status.pollers.runningCount} poller
            {status.pollers.runningCount === 1 ? "" : "s"} running
          </span>
        )}
      </div>
      {!status ? (
        <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Backend status unavailable.
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 rounded border border-zinc-200 bg-white p-4 sm:grid-cols-4">
          <StatusItem label="SolanaTracker" on={status.env.solanaTrackerConfigured} />
          <StatusItem label="Helius" on={status.env.heliusConfigured} />
          <StatusItem label="Telegram" on={status.env.telegramConfigured} />
          <StatusItem label="API auth" on={status.env.appAuthEnabled} />
        </div>
      )}
    </section>
  );
}

function StatusItem({ label, on }: { label: string; on: boolean }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span
        className={`inline-block h-2 w-2 rounded-full ${
          on ? "bg-green-500" : "bg-zinc-300"
        }`}
        aria-hidden
      />
      <span className="font-medium">{label}</span>
      <span className="text-xs text-zinc-500">{on ? "configured" : "not configured"}</span>
    </div>
  );
}
