"use client";

import { useState } from "react";
import type { TradeItem } from "@/lib/api";
import { fmtUsd } from "@/lib/format";

interface Alert {
  id: string;
  minUsd: number;
  token?: string;
}

const QUOTE_SYMBOLS = new Set(["SOL", "WSOL", "USDC", "USDT"]);

function nonQuoteSymbol(trade: TradeItem): string {
  const fromSym = trade.from?.token?.symbol ?? "";
  const toSym = trade.to?.token?.symbol ?? "";
  if (toSym && !QUOTE_SYMBOLS.has(toSym)) return toSym;
  if (fromSym && !QUOTE_SYMBOLS.has(fromSym)) return fromSym;
  return toSym || fromSym || "?";
}

function tokenMatches(trade: TradeItem, query: string): boolean {
  const q = query.toLowerCase();
  for (const leg of [trade.from, trade.to]) {
    if (!leg) continue;
    if (leg.address === query) return true;
    if (leg.token?.symbol?.toLowerCase() === q) return true;
    if (leg.token?.name?.toLowerCase() === q) return true;
  }
  return false;
}

export function AlertsSection({ trades }: { trades: TradeItem[] }) {
  const [alerts, setAlerts] = useState<Alert[]>([]);

  function handleAdd(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const minUsd = Number(fd.get("minUsd"));
    if (!Number.isFinite(minUsd) || minUsd <= 0) return;
    const tokenRaw = String(fd.get("token") ?? "").trim();
    const token = tokenRaw || undefined;
    setAlerts((prev) => [
      ...prev,
      { id: Math.random().toString(36).slice(2), minUsd, token },
    ]);
    form.reset();
  }

  function handleRemove(id: string) {
    setAlerts((prev) => prev.filter((a) => a.id !== id));
  }

  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-medium uppercase tracking-wider text-zinc-500">Alerts</h2>
        <span className="text-xs text-zinc-400">
          frontend-only · evaluated against the trades shown above
        </span>
      </div>

      <div className="rounded border border-zinc-200 bg-white p-4">
        <form onSubmit={handleAdd} className="flex flex-wrap gap-2">
          <input
            name="minUsd"
            type="number"
            step="0.01"
            min="0"
            required
            placeholder="min USD threshold"
            className="w-44 rounded border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
          />
          <input
            name="token"
            placeholder="token (symbol/name/mint, optional)"
            className="w-72 rounded border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
          />
          <button
            type="submit"
            className="rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700"
          >
            Add alert
          </button>
        </form>

        {alerts.length === 0 ? (
          <p className="mt-3 text-xs text-zinc-500">
            No alerts configured. Set a USD threshold to flag matching trades.
          </p>
        ) : (
          <ul className="mt-4 space-y-3">
            {alerts.map((a) => {
              const matches = trades.filter(
                (t) =>
                  (t.volume?.usd ?? 0) >= a.minUsd &&
                  (!a.token || tokenMatches(t, a.token)),
              );
              return (
                <li key={a.id} className="rounded border border-zinc-100 p-3">
                  <div className="flex items-center justify-between text-xs">
                    <div className="font-medium">
                      Alert: trades ≥ {fmtUsd(a.minUsd)}
                      {a.token ? <> on <code>{a.token}</code></> : null}
                      <span className="ml-2 text-zinc-500">
                        ({matches.length} match{matches.length === 1 ? "" : "es"})
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRemove(a.id)}
                      className="text-zinc-400 hover:text-red-600"
                      aria-label="Remove alert"
                    >
                      Remove
                    </button>
                  </div>
                  {matches.length > 0 && (
                    <ul className="mt-2 space-y-1 text-xs text-amber-800">
                      {matches.map((t) => (
                        <li key={t.tx}>
                          ⚠ Large trade detected: {fmtUsd(t.volume.usd)} on {nonQuoteSymbol(t)}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
