"use client";

// Compact controls for the backend smart-signal poller. Mirrors AlertMonitor
// but targets /api/groups/:id/signals/* and uses the signals poller's tighter
// bounds (60s–60min). No frontend polling — the displayed status reflects
// whatever the page's initial fetch returned; clicking Start/Stop revalidates
// the route so the next render picks up fresh state.

import { useState, useTransition } from "react";
import {
  startSignalMonitorAction,
  stopSignalMonitorAction,
} from "../actions";
import { Card } from "@/ui-kit/components/Card";
import { SectionHeader } from "@/ui-kit/components/SectionHeader";
import { btnPrimaryEmerald, btnSecondary } from "@/lib/buttonStyles";

interface Status {
  running: boolean;
  intervalMs: number | null;
}

const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 3_600_000;

export function SignalMonitor({
  groupId,
  initialStatus,
}: {
  groupId: string;
  initialStatus: Status;
}) {
  const [interval, setInterval] = useState<string>("120000");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleStart() {
    setError(null);
    const ms = Number(interval);
    if (!Number.isFinite(ms) || ms < MIN_INTERVAL_MS) {
      setError(`Interval must be ≥ ${MIN_INTERVAL_MS} ms`);
      return;
    }
    if (ms > MAX_INTERVAL_MS) {
      setError(`Interval must be ≤ ${MAX_INTERVAL_MS} ms`);
      return;
    }
    startTransition(async () => {
      const res = await startSignalMonitorAction(groupId, ms);
      if (!res.ok) setError(res.error ?? "Start failed");
    });
  }

  function handleStop() {
    setError(null);
    startTransition(async () => {
      const res = await stopSignalMonitorAction(groupId);
      if (!res.ok) setError(res.error ?? "Stop failed");
    });
  }

  const running = initialStatus.running;
  const intervalMs = initialStatus.intervalMs;

  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between">
        <SectionHeader className="mb-0">Smart Signal Monitor</SectionHeader>
        <span className="text-[11px] text-neutral-500">
          backend polling · Telegram dedup
        </span>
      </div>
      <Card className="p-2.5">
        <div className="flex items-center gap-3 text-sm">
          {running ? (
            <span className="ui-live-dot" />
          ) : (
            <span className="inline-block h-2 w-2 rounded-full bg-neutral-700" />
          )}
          <span className="font-medium text-white">
            {running ? "Running" : "Not running"}
          </span>
          {running && intervalMs !== null && (
            <span className="text-xs text-neutral-500 tabular-nums">
              every {(intervalMs / 1000).toFixed(0)}s
            </span>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="flex flex-col text-[10px] uppercase tracking-wider text-neutral-500">
            Interval (ms)
            <input
              type="number"
              min={MIN_INTERVAL_MS}
              max={MAX_INTERVAL_MS}
              step="1000"
              value={interval}
              onChange={(e) => setInterval(e.target.value)}
              disabled={running || pending}
              className="mt-1 w-32 rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-white transition-colors duration-100 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500/30 disabled:bg-neutral-900 disabled:text-neutral-500"
            />
          </label>
          <div className="flex gap-2 pb-[1px]">
            <button
              type="button"
              onClick={handleStart}
              disabled={running || pending}
              className={btnPrimaryEmerald}
            >
              {pending && !running ? "Starting…" : "Start monitor"}
            </button>
            <button
              type="button"
              onClick={handleStop}
              disabled={!running || pending}
              className={btnSecondary}
            >
              {pending && running ? "Stopping…" : "Stop monitor"}
            </button>
          </div>
        </div>

        <p className="mt-3 text-[11px] text-neutral-500">
          Sends Telegram notifications for new backend smart signals only.
        </p>

        {error && (
          <div className="mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
            {error}
          </div>
        )}
      </Card>
    </section>
  );
}
