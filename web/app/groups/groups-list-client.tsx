"use client";

// Client-side reload layer for /groups. Hydrates with SSR data so the
// first paint stays fast, then takes over the data lifecycle: manual
// Refresh button, auto-retry on fetch failure, 30s polling, and clean
// error UX. The list rendering is here because it's the part that
// changes on refresh; the page header / create form / system-status
// stay in the server component.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { deleteGroupAction, loadGroupsAction } from "./actions";
import { prettifyApiError } from "@/lib/prettifyError";
import { Card } from "@/ui-kit/components/Card";
import { Badge } from "@/ui-kit/components/Badge";
import { SectionHeader } from "@/ui-kit/components/SectionHeader";
import type { Group, SystemStatus } from "@/lib/api";

const RETRY_BACKOFFS_MS = [1000, 3000, 5000];
const POLL_INTERVAL_MS = 30_000;

type LoadState =
  | { kind: "idle" } // displaying current data
  | { kind: "loading" } // first load or manual refresh in flight
  | { kind: "retrying"; attempt: number; lastError: string }; // auto-retry chain

interface Props {
  initialGroups: Group[];
  initialStatus: SystemStatus | null;
  initialError: string | null;
}

export function GroupsListClient({
  initialGroups,
  initialStatus,
  initialError,
}: Props) {
  const [groups, setGroups] = useState<Group[]>(initialGroups);
  // We deliberately don't surface initialStatus changes to the rendered UI
  // here — the server component owns the system-status panel. Tracked
  // only so future refresh-driven status updates have a place to land.
  const [, setStatus] = useState<SystemStatus | null>(initialStatus);
  const [error, setError] = useState<string | null>(
    initialError ? prettifyApiError(initialError) : null,
  );
  const [load, setLoad] = useState<LoadState>({ kind: "idle" });
  const [lastUpdated, setLastUpdated] = useState<number | null>(
    initialError ? null : Date.now(),
  );

  // Cancel handle for any in-flight retry chain so manual refresh / unmount
  // doesn't leave stray timeouts.
  const cancelRef = useRef<(() => void) | null>(null);

  const reload = useCallback(async (opts?: { silent?: boolean }) => {
    cancelRef.current?.();
    let cancelled = false;
    cancelRef.current = () => {
      cancelled = true;
    };
    if (!opts?.silent) setLoad({ kind: "loading" });

    for (let attempt = 0; attempt <= RETRY_BACKOFFS_MS.length; attempt++) {
      if (cancelled) return;
      const res = await loadGroupsAction();
      if (cancelled) return;
      if (res.ok) {
        setGroups(res.groups);
        setStatus(res.status);
        setError(null);
        setLastUpdated(Date.now());
        setLoad({ kind: "idle" });
        return;
      }
      // Out of retries — surface the friendly error.
      if (attempt === RETRY_BACKOFFS_MS.length) {
        setError(prettifyApiError(res.error));
        setLoad({ kind: "idle" });
        return;
      }
      // Retry path: show the retry status and back off.
      const wait = RETRY_BACKOFFS_MS[attempt];
      setLoad({
        kind: "retrying",
        attempt: attempt + 1,
        lastError: prettifyApiError(res.error),
      });
      await new Promise((r) => setTimeout(r, wait));
    }
  }, []);

  // Initial fetch path: only fire if SSR couldn't deliver. SSR success
  // skips this so we don't double-fetch on every page open.
  const didInitialReloadRef = useRef(false);
  useEffect(() => {
    if (didInitialReloadRef.current) return;
    didInitialReloadRef.current = true;
    if (initialError) {
      void reload();
    }
  }, [initialError, reload]);

  // 30s polling. Silent (no spinner) so the page doesn't flicker every
  // 30s. Skips while the tab is hidden to avoid unnecessary backend load.
  useEffect(() => {
    const tick = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      void reload({ silent: true });
    };
    const id = setInterval(tick, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [reload]);

  // Cleanup any in-flight retry chain on unmount.
  useEffect(() => () => cancelRef.current?.(), []);

  return (
    <section>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex items-baseline gap-2">
          <SectionHeader className="mb-0">All groups</SectionHeader>
          <Badge>{groups.length}</Badge>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-neutral-400">
          <LoadStatusLine load={load} lastUpdated={lastUpdated} />
          <button
            type="button"
            onClick={() => void reload()}
            disabled={load.kind !== "idle"}
            className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-[11px] font-semibold text-white transition-colors duration-100 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-60"
            aria-label="Refresh groups"
          >
            {load.kind === "idle" ? "Refresh" : "Refreshing…"}
          </button>
        </div>
      </div>
      {error ? (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          <span className="font-semibold">Could not load groups:</span> {error}.
          Click Refresh to try again.
        </div>
      ) : groups.length === 0 ? (
        <Card className="p-8 text-center text-sm text-neutral-500">
          No groups yet — create one above.
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-neutral-800">
            {groups.map((g) => (
              <GroupRow
                key={g.id}
                group={g}
                onDeleted={(id) =>
                  setGroups((prev) => prev.filter((x) => x.id !== id))
                }
              />
            ))}
          </ul>
        </Card>
      )}
    </section>
  );
}

// One group entry. The clickable area opens the group; the right-hand
// side hosts the two-step Delete control. The link wraps just the
// metadata block so the delete button sits outside the anchor (avoids
// nested-interactive a11y issues).
function GroupRow({
  group,
  onDeleted,
}: {
  group: Group;
  onDeleted: (id: string) => void;
}) {
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-3 transition-colors duration-100 hover:bg-neutral-800/60">
      <Link
        href={`/groups/${group.id}`}
        className="flex min-w-0 flex-1 items-center justify-between gap-3"
      >
        <div className="min-w-0">
          <div className="text-sm font-semibold text-white">{group.name}</div>
          <div className="mt-0.5 text-xs text-neutral-300">
            {group.wallets.length} wallet
            {group.wallets.length === 1 ? "" : "s"} · created{" "}
            {new Date(group.createdAt).toISOString().slice(0, 10)}
          </div>
        </div>
        <span className="font-mono text-xs text-neutral-300">
          {group.id.slice(0, 8)}…
        </span>
      </Link>
      <GroupDeleteControl groupId={group.id} onDeleted={onDeleted} />
    </li>
  );
}

type DeleteState =
  | { kind: "idle" }
  | { kind: "confirming" }
  | { kind: "deleting" }
  | { kind: "error"; message: string };

// Two-step delete: first click expands to "Are you sure?" with explicit
// Cancel + Delete. Second click on Delete fires the server action and
// surfaces a friendly error on failure. Buttons are disabled while the
// request is in flight to prevent double-submit.
function GroupDeleteControl({
  groupId,
  onDeleted,
}: {
  groupId: string;
  onDeleted: (id: string) => void;
}) {
  const [state, setState] = useState<DeleteState>({ kind: "idle" });

  async function handleConfirm() {
    setState({ kind: "deleting" });
    const res = await deleteGroupAction(groupId);
    if (res.ok) {
      onDeleted(groupId);
      // Component unmounts when the parent removes the row; no further
      // setState needed (would warn about updating an unmounted component).
      return;
    }
    setState({
      kind: "error",
      message: prettifyApiError(res.error),
    });
  }

  if (state.kind === "idle") {
    return (
      <button
        type="button"
        onClick={() => setState({ kind: "confirming" })}
        aria-label="Delete group"
        className="rounded-md border border-neutral-800 bg-transparent px-2 py-1 text-[11px] font-semibold text-neutral-400 transition-colors duration-100 hover:border-red-500/60 hover:bg-red-500/10 hover:text-red-300"
      >
        Delete
      </button>
    );
  }
  if (state.kind === "confirming") {
    return (
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] text-red-300">Are you sure?</span>
        <button
          type="button"
          onClick={() => setState({ kind: "idle" })}
          className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-[11px] font-semibold text-neutral-300 transition-colors duration-100 hover:bg-neutral-800"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void handleConfirm()}
          aria-label="Confirm delete group"
          className="rounded-md border border-red-500/60 bg-red-600/90 px-2 py-1 text-[11px] font-semibold text-white transition-colors duration-100 hover:bg-red-600"
        >
          Delete
        </button>
      </div>
    );
  }
  if (state.kind === "deleting") {
    return (
      <span className="text-[11px] text-neutral-400" aria-live="polite">
        Deleting…
      </span>
    );
  }
  // error
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] text-red-300" title={state.message}>
        Failed to delete group. Try again.
      </span>
      <button
        type="button"
        onClick={() => setState({ kind: "confirming" })}
        className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-[11px] font-semibold text-neutral-300 transition-colors duration-100 hover:bg-neutral-800"
      >
        Retry
      </button>
    </div>
  );
}

function LoadStatusLine({
  load,
  lastUpdated,
}: {
  load: LoadState;
  lastUpdated: number | null;
}) {
  // Re-render every 10s so the "Last updated …s ago" stays fresh.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 10_000);
    return () => clearInterval(id);
  }, []);

  if (load.kind === "loading") {
    return <span>Loading groups…</span>;
  }
  if (load.kind === "retrying") {
    return (
      <span className="text-amber-300">
        Retrying ({load.attempt} / {RETRY_BACKOFFS_MS.length})…
      </span>
    );
  }
  if (lastUpdated === null) return null;
  const ageSec = Math.max(0, Math.floor((Date.now() - lastUpdated) / 1000));
  if (ageSec < 5) return <span>Last updated now</span>;
  if (ageSec < 60) return <span>Last updated {ageSec}s ago</span>;
  if (ageSec < 3600) return <span>Last updated {Math.floor(ageSec / 60)}m ago</span>;
  return <span>Last updated {Math.floor(ageSec / 3600)}h ago</span>;
}
