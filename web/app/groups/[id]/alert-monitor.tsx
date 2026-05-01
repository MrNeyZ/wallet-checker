"use client";

import { useState, useTransition } from "react";
import { startAlertsAction, stopAlertsAction } from "../actions";
import { Card } from "@/ui-kit/components/Card";
import { SectionHeader } from "@/ui-kit/components/SectionHeader";
import { btnVlPrimary, btnVlGhost } from "@/lib/buttonStyles";

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
      <div className="mb-2 flex items-baseline justify-between">
        <SectionHeader tone="vl" className="mb-0">Alert monitor</SectionHeader>
        <span className="text-[11px] text-[color:var(--vl-fg-3)]">
          polling · Telegram dedup
        </span>
      </div>
      <Card tone="vl" className="p-3">
        <div className="flex items-center gap-3 text-sm">
          {running ? (
            <span className="ui-live-dot" />
          ) : (
            <span className="inline-block h-2 w-2 rounded-full bg-[color:var(--vl-fg-4)]" />
          )}
          <span className="font-medium text-white">
            {running ? "Running" : "Not running"}
          </span>
          {running && intervalMs !== null && (
            <span className="text-xs text-[color:var(--vl-fg-3)] tabular-nums">
              every {(intervalMs / 1000).toFixed(0)}s
            </span>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="flex flex-col text-[10px] uppercase tracking-wider text-[color:var(--vl-fg-3)]">
            Interval (ms)
            <input
              type="number"
              min="5000"
              max="3600000"
              step="1000"
              value={interval}
              onChange={(e) => setInterval(e.target.value)}
              disabled={running || pending}
              className="vl-text-input mt-1 w-32 disabled:opacity-50"
            />
          </label>
          <div className="flex gap-2 pb-[1px]">
            <button
              type="button"
              onClick={handleStart}
              disabled={running || pending}
              className={btnVlPrimary}
            >
              {pending && !running ? "Starting…" : "Start monitor"}
            </button>
            <button
              type="button"
              onClick={handleStop}
              disabled={!running || pending}
              className={btnVlGhost}
            >
              {pending && running ? "Stopping…" : "Stop monitor"}
            </button>
          </div>
        </div>

        {error && (
          <div className="mt-3 rounded-md border border-[rgba(239,120,120,0.30)] bg-[rgba(239,120,120,0.08)] px-3 py-2 text-xs text-[color:var(--vl-red)]">
            {error}
          </div>
        )}
      </Card>
    </section>
  );
}
