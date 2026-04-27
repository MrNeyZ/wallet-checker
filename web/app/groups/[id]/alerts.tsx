"use client";

import { useState } from "react";
import type { TradeItem } from "@/lib/api";
import { fmtUsd } from "@/lib/format";
import { Card } from "@/ui-kit/components/Card";
import { SectionHeader } from "@/ui-kit/components/SectionHeader";
import { Badge } from "@/ui-kit/components/Badge";
import { btnPrimary, btnDangerLink } from "@/lib/buttonStyles";

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
      <div className="mb-2 flex items-baseline justify-between">
        <SectionHeader className="mb-0">Local preview alerts</SectionHeader>
        <span className="text-[11px] text-neutral-500">
          frontend-only
        </span>
      </div>

      <Card className="p-2.5">
        <form onSubmit={handleAdd} className="flex flex-wrap gap-2">
          <input
            name="minUsd"
            type="number"
            step="0.01"
            min="0"
            required
            placeholder="min USD threshold"
            className="w-44 rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-white placeholder:text-neutral-500 transition-colors duration-100 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500/30"
          />
          <input
            name="token"
            placeholder="token (symbol/name/mint, optional)"
            className="w-72 rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-white placeholder:text-neutral-500 transition-colors duration-100 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500/30"
          />
          <button type="submit" className={btnPrimary}>
            Add alert
          </button>
        </form>

        {alerts.length === 0 ? (
          <p className="mt-3 text-xs text-neutral-500">
            No alerts configured. Set a USD threshold to flag matching trades.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {alerts.map((a) => {
              const matches = trades.filter(
                (t) =>
                  (t.volume?.usd ?? 0) >= a.minUsd &&
                  (!a.token || tokenMatches(t, a.token)),
              );
              return (
                <li key={a.id} className="rounded-md border border-neutral-800 bg-neutral-900 p-2.5">
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2">
                      <Badge variant="info">≥ {fmtUsd(a.minUsd)}</Badge>
                      {a.token && (
                        <span className="font-mono text-neutral-400">on {a.token}</span>
                      )}
                      <span className="text-neutral-500">
                        {matches.length} match{matches.length === 1 ? "" : "es"}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRemove(a.id)}
                      className={btnDangerLink}
                      aria-label="Remove alert"
                    >
                      Remove
                    </button>
                  </div>
                  {matches.length > 0 && (
                    <ul className="mt-2 space-y-1 text-xs text-amber-300">
                      {matches.map((t) => (
                        <li key={t.tx}>
                          ⚠ Large trade: {fmtUsd(t.volume.usd)} on {nonQuoteSymbol(t)}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </section>
  );
}
