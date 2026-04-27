"use client";

import { useState, useTransition } from "react";
import { startAlertsAction, stopAlertsAction } from "../actions";

interface Status {
  running: boolean;
  intervalMs: number | null;
}

export function AlertMonitor({
  groupId,
  initialStatus,
}: {
  groupId: string;
  initialStatus: Status;
}) {
  const [interval, setInterval] = useState<string>("60000");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleStart() {
    setError(null);
    const ms = Number(interval);
    if (!Number.isFinite(ms) || ms < 5000) {
      setError("Interval must be ≥ 5000 ms");
      return;
    }
    startTransition(async () => {
      const res = await startAlertsAction(groupId, ms);
      if (!res.ok) setError(res.error ?? "Start failed");
    });
  }

  function handleStop() {
    setError(null);
    startTransition(async () => {
      const res = await stopAlertsAction(groupId);
      if (!res.ok) setError(res.error ?? "Stop failed");
    });
  }

  const running = initialStatus.running;
  const intervalMs = initialStatus.intervalMs;

  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-medium uppercase tracking-wider text-zinc-500">
          Alert monitor
        </h2>
        <span className="text-xs text-zinc-400">
          server-side polling · Telegram dedup via alert-sent.json
        </span>
      </div>
      <div className="rounded border border-zinc-200 bg-white p-4">
        <div className="flex items-center gap-3 text-sm">
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              running ? "bg-green-500" : "bg-zinc-300"
            }`}
            aria-hidden
          />
          <span className="font-medium">{running ? "Running" : "Not running"}</span>
          {running && intervalMs !== null && (
            <span className="text-xs text-zinc-500">
              every {(intervalMs / 1000).toFixed(0)}s
            </span>
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-2">
          <label className="flex flex-col text-xs uppercase tracking-wider text-zinc-500">
            Interval (ms)
            <input
              type="number"
              min="5000"
              max="3600000"
              step="1000"
              value={interval}
              onChange={(e) => setInterval(e.target.value)}
              disabled={running || pending}
              className="mt-1 w-32 rounded border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none disabled:bg-zinc-100"
            />
          </label>
          <div className="flex gap-2 pb-[1px]">
            <button
              type="button"
              onClick={handleStart}
              disabled={running || pending}
              className="rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50"
            >
              {pending && !running ? "Starting…" : "Start monitor"}
            </button>
            <button
              type="button"
              onClick={handleStop}
              disabled={!running || pending}
              className="rounded border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
            >
              {pending && running ? "Stopping…" : "Stop monitor"}
            </button>
          </div>
        </div>

        {error && (
          <div className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}
      </div>
    </section>
  );
}
