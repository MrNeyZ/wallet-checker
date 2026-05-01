"use client";

import { useState, useTransition } from "react";
import type { AlertRule } from "@/lib/api";
import {
  createAlertRuleAction,
  deleteAlertRuleAction,
  evaluateAlertsAction,
  toggleAlertRuleAction,
} from "../actions";
import { Card } from "@/ui-kit/components/Card";
import { SectionHeader } from "@/ui-kit/components/SectionHeader";
import { Badge } from "@/ui-kit/components/Badge";
import { btnVlPrimary, btnVlGhost, btnDangerLink, btnLink } from "@/lib/buttonStyles";

export function ServerAlerts({
  groupId,
  rules,
}: {
  groupId: string;
  rules: AlertRule[];
}) {
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleCreate(formData: FormData) {
    setError(null);
    setInfo(null);
    startTransition(async () => {
      const res = await createAlertRuleAction(groupId, formData);
      if (!res.ok) setError(res.error ?? "Create failed");
    });
  }

  function handleToggle(alertId: string, enabled: boolean) {
    setError(null);
    setInfo(null);
    startTransition(async () => {
      const res = await toggleAlertRuleAction(groupId, alertId, enabled);
      if (!res.ok) setError(res.error ?? "Patch failed");
    });
  }

  function handleDelete(alertId: string) {
    setError(null);
    setInfo(null);
    startTransition(async () => {
      const res = await deleteAlertRuleAction(groupId, alertId);
      if (!res.ok) setError(res.error ?? "Delete failed");
    });
  }

  function handleEvaluate() {
    setError(null);
    setInfo(null);
    startTransition(async () => {
      const res = await evaluateAlertsAction(groupId);
      if (!res.ok) {
        setError(res.error ?? "Evaluate failed");
      } else {
        setInfo(
          `Evaluated. ${res.matches ?? 0} match${res.matches === 1 ? "" : "es"} (Telegram dedup applies)`,
        );
      }
    });
  }

  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between">
        <SectionHeader tone="vl" className="mb-0">Server alerts</SectionHeader>
        <span className="text-[11px] text-[color:var(--vl-fg-3)]">
          persisted · sends Telegram
        </span>
      </div>

      <Card tone="vl" className="p-3">
        <form
          action={handleCreate}
          className="flex flex-wrap items-end gap-2 border-b border-[color:var(--vl-border)] pb-3"
        >
          <Field label="Name">
            <input
              name="name"
              required
              maxLength={100}
              placeholder="Big jupiter buys"
              className="vl-text-input w-56"
            />
          </Field>
          <Field label="Min USD">
            <input
              name="minUsd"
              type="number"
              step="0.01"
              min="0"
              required
              placeholder="50"
              className="vl-text-input w-28"
            />
          </Field>
          <Field label="Token">
            <input
              name="token"
              placeholder="optional"
              className="vl-text-input w-40"
            />
          </Field>
          <Field label="Side">
            <select name="side" defaultValue="" className="vl-text-input">
              <option value="">All</option>
              <option value="buy">Buy</option>
              <option value="sell">Sell</option>
            </select>
          </Field>
          <Field label="Program">
            <input
              name="program"
              placeholder="optional"
              className="vl-text-input w-32"
            />
          </Field>
          <label className="flex items-center gap-2 pb-[10px] text-xs text-[color:var(--vl-fg-2)]">
            <input
              type="checkbox"
              name="enabled"
              defaultChecked
              className="h-4 w-4 rounded border-[color:var(--vl-border)] bg-[color:var(--vl-surface-2)] text-[color:var(--vl-purple)] focus:ring-[var(--vl-purple-soft)]"
            />
            enabled
          </label>
          <div className="flex gap-2 pb-[1px]">
            <button type="submit" disabled={pending} className={btnVlPrimary}>
              Add rule
            </button>
            <button
              type="button"
              onClick={handleEvaluate}
              disabled={pending}
              className={btnVlGhost}
            >
              Evaluate now
            </button>
          </div>
        </form>

        {error && (
          <div className="mt-3 rounded-md border border-[rgba(239,120,120,0.30)] bg-[rgba(239,120,120,0.08)] px-3 py-2 text-xs text-[color:var(--vl-red)]">
            {error}
          </div>
        )}
        {info && !error && (
          <div className="mt-3 rounded-md border border-[color:var(--vl-border)] bg-[rgba(168,144,232,0.06)] px-3 py-2 text-xs text-[color:var(--vl-fg-2)]">
            {info}
          </div>
        )}

        {rules.length === 0 ? (
          <p className="mt-4 text-xs text-[color:var(--vl-fg-3)]">No server-side rules yet.</p>
        ) : (
          <table className="mt-3 w-full text-sm">
            <thead className="text-left text-[11px] font-semibold uppercase tracking-wider text-[color:var(--vl-fg-3)]">
              <tr>
                <th className="py-1">Name</th>
                <th>Min USD</th>
                <th>Token</th>
                <th>Side</th>
                <th>Program</th>
                <th>Created</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--vl-border)]">
              {rules.map((r) => (
                <tr
                  key={r.id}
                  className="transition-colors duration-[var(--vl-motion,180ms)] hover:bg-[rgba(168,144,232,0.06)]"
                >
                  <td className="py-1">
                    <div className="font-semibold text-white">{r.name}</div>
                    <div className="font-mono text-xs text-[color:var(--vl-fg-3)]">{r.id.slice(0, 8)}…</div>
                  </td>
                  <td className="font-semibold text-white tabular-nums">${r.minUsd.toFixed(2)}</td>
                  <td className="font-medium text-white">
                    {r.token ?? <span className="font-normal text-[color:var(--vl-fg-3)]">—</span>}
                  </td>
                  <td className="font-medium text-white">
                    {r.side ?? <span className="font-normal text-[color:var(--vl-fg-3)]">any</span>}
                  </td>
                  <td className="font-medium text-white">
                    {r.program ?? <span className="font-normal text-[color:var(--vl-fg-3)]">any</span>}
                  </td>
                  <td className="whitespace-nowrap text-xs text-[color:var(--vl-fg-2)]">
                    {new Date(r.createdAt).toISOString().slice(0, 10)}
                  </td>
                  <td>
                    <Badge variant={r.enabled ? "vlGreen" : "vlNeutral"}>
                      {r.enabled ? "Enabled" : "Disabled"}
                    </Badge>
                  </td>
                  <td>
                    <div className="flex gap-3">
                      <button
                        type="button"
                        onClick={() => handleToggle(r.id, !r.enabled)}
                        disabled={pending}
                        className={btnLink}
                      >
                        {r.enabled ? "Disable" : "Enable"}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(r.id)}
                        disabled={pending}
                        className={btnDangerLink}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col text-[10px] uppercase tracking-wider text-[color:var(--vl-fg-3)]">
      {label}
      <div className="mt-1">{children}</div>
    </label>
  );
}
