"use client";

import { useState, useTransition } from "react";
import type { AlertRule } from "@/lib/api";
import {
  createAlertRuleAction,
  deleteAlertRuleAction,
  evaluateAlertsAction,
  toggleAlertRuleAction,
} from "../actions";

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
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-medium uppercase tracking-wider text-zinc-500">
          Server alerts
        </h2>
        <span className="text-xs text-zinc-400">
          persisted · evaluated server-side · sends Telegram
        </span>
      </div>

      <div className="rounded border border-zinc-200 bg-white p-4">
        <form
          action={handleCreate}
          className="flex flex-wrap items-end gap-2 border-b border-zinc-100 pb-4"
        >
          <Field label="Name">
            <input
              name="name"
              required
              maxLength={100}
              placeholder="Big jupiter buys"
              className="w-56 rounded border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
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
              className="w-28 rounded border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
            />
          </Field>
          <Field label="Token">
            <input
              name="token"
              placeholder="optional"
              className="w-40 rounded border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
            />
          </Field>
          <Field label="Side">
            <select
              name="side"
              defaultValue=""
              className="rounded border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
            >
              <option value="">All</option>
              <option value="buy">Buy</option>
              <option value="sell">Sell</option>
            </select>
          </Field>
          <Field label="Program">
            <input
              name="program"
              placeholder="optional"
              className="w-32 rounded border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
            />
          </Field>
          <label className="flex items-center gap-2 pb-[10px] text-xs text-zinc-700">
            <input type="checkbox" name="enabled" defaultChecked className="h-4 w-4" />
            enabled
          </label>
          <div className="flex gap-2 pb-[1px]">
            <button
              type="submit"
              disabled={pending}
              className="rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50"
            >
              Add rule
            </button>
            <button
              type="button"
              onClick={handleEvaluate}
              disabled={pending}
              className="rounded border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
            >
              Evaluate now
            </button>
          </div>
        </form>

        {error && (
          <div className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}
        {info && !error && (
          <div className="mt-3 rounded border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-700">
            {info}
          </div>
        )}

        {rules.length === 0 ? (
          <p className="mt-4 text-xs text-zinc-500">No server-side rules yet.</p>
        ) : (
          <table className="mt-4 w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-zinc-500">
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
            <tbody className="divide-y divide-zinc-100">
              {rules.map((r) => (
                <tr key={r.id}>
                  <td className="py-2">
                    <div className="font-medium">{r.name}</div>
                    <div className="font-mono text-xs text-zinc-400">{r.id.slice(0, 8)}…</div>
                  </td>
                  <td>${r.minUsd.toFixed(2)}</td>
                  <td>{r.token ?? <span className="text-zinc-400">—</span>}</td>
                  <td>{r.side ?? <span className="text-zinc-400">any</span>}</td>
                  <td>{r.program ?? <span className="text-zinc-400">any</span>}</td>
                  <td className="whitespace-nowrap text-xs text-zinc-500">
                    {new Date(r.createdAt).toISOString().slice(0, 10)}
                  </td>
                  <td>
                    <span
                      className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${
                        r.enabled ? "bg-green-100 text-green-800" : "bg-zinc-100 text-zinc-600"
                      }`}
                    >
                      {r.enabled ? "Enabled" : "Disabled"}
                    </span>
                  </td>
                  <td>
                    <div className="flex gap-2 text-xs">
                      <button
                        type="button"
                        onClick={() => handleToggle(r.id, !r.enabled)}
                        disabled={pending}
                        className="text-zinc-700 hover:underline disabled:opacity-50"
                      >
                        {r.enabled ? "Disable" : "Enable"}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(r.id)}
                        disabled={pending}
                        className="text-red-600 hover:underline disabled:opacity-50"
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
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col text-xs uppercase tracking-wider text-zinc-500">
      {label}
      <div className="mt-1">{children}</div>
    </label>
  );
}
