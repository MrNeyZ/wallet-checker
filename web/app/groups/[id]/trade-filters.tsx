"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card } from "@/ui-kit/components/Card";
import { SectionHeader } from "@/ui-kit/components/SectionHeader";
import { btnVlPrimary, btnVlGhost } from "@/lib/buttonStyles";

// Quick preset filters. Each entry maps to a fixed set of URL params; the
// "Clear all" preset has empty params and reads as active when no filters
// are set. Order matches the user's spec.
const TRADE_FILTER_PRESETS: {
  label: string;
  params: Partial<TradeFilterValues>;
}[] = [
  { label: "Big buys", params: { side: "buy", minUsd: "50" } },
  { label: "Dumps", params: { side: "sell", minUsd: "50" } },
  {
    label: "Jupiter buys",
    params: { side: "buy", program: "jupiter", minUsd: "20" },
  },
  { label: "Clear all", params: {} },
];

function buildPresetUrl(
  groupId: string,
  params: Partial<TradeFilterValues>,
): string {
  const sp = new URLSearchParams();
  sp.set("tab", "activity");
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") sp.set(k, String(v));
  }
  return `/groups/${groupId}?${sp.toString()}`;
}

function isPresetActive(
  filters: TradeFilterValues,
  params: Partial<TradeFilterValues>,
): boolean {
  const presetKeys = Object.keys(params) as (keyof TradeFilterValues)[];
  const filterKeys = Object.keys(filters) as (keyof TradeFilterValues)[];
  // "Clear all" preset → active iff no filters are set.
  if (presetKeys.length === 0) return filterKeys.length === 0;
  for (const k of presetKeys) {
    if (String(filters[k] ?? "") !== String(params[k] ?? "")) return false;
  }
  // Reject if filter has extras beyond preset (e.g. preset matches but a
  // stale ?token=… is also set — Clear all instead).
  for (const k of filterKeys) {
    if (!(k in params)) return false;
  }
  return true;
}

export interface TradeFilterValues {
  minUsd?: string;
  token?: string;
  side?: "buy" | "sell";
  program?: string;
}

// Preset pill class strings — VL-flavored. Active state uses the same
// purple-soft fill the topnav active tab uses; idle state matches the
// vl-toolbar-btn ghost look.
const presetActiveCls =
  "rounded-md border border-[var(--vl-purple-border)] bg-[var(--vl-purple-soft)] px-2.5 py-1 text-[11px] font-bold text-[color:var(--vl-purple-2)] transition-all duration-[var(--vl-motion,180ms)]";
const presetIdleCls =
  "rounded-md border border-[var(--vl-border)] bg-transparent px-2.5 py-1 text-[11px] font-semibold text-[color:var(--vl-fg-2)] transition-all duration-[var(--vl-motion,180ms)] hover:border-[var(--vl-purple)] hover:text-[color:var(--vl-purple-2)] hover:bg-[rgba(168,144,232,0.08)]";

export function TradeFilters({
  groupId,
  filters,
}: {
  groupId: string;
  filters: TradeFilterValues;
}) {
  const router = useRouter();
  const hasAny = Object.keys(filters).length > 0;

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const params = new URLSearchParams();
    const minUsd = String(fd.get("minUsd") ?? "").trim();
    const token = String(fd.get("token") ?? "").trim();
    const side = String(fd.get("side") ?? "");
    const program = String(fd.get("program") ?? "").trim();
    if (minUsd) params.set("minUsd", minUsd);
    if (token) params.set("token", token);
    if (side === "buy" || side === "sell") params.set("side", side);
    if (program) params.set("program", program);
    const qs = params.toString();
    router.push(qs ? `/groups/${groupId}?${qs}` : `/groups/${groupId}`);
  }

  function handleReset() {
    router.push(`/groups/${groupId}`);
  }

  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--vl-fg-3)]">
          Presets
        </span>
        {TRADE_FILTER_PRESETS.map((p) => {
          const active = isPresetActive(filters, p.params);
          return (
            <Link
              key={p.label}
              href={buildPresetUrl(groupId, p.params)}
              scroll={false}
              aria-pressed={active}
              className={active ? presetActiveCls : presetIdleCls}
            >
              {p.label}
            </Link>
          );
        })}
      </div>
      <div className="mb-2 flex items-baseline justify-between">
        <SectionHeader tone="vl" className="mb-0">Trade filters</SectionHeader>
        <span className="text-[11px] text-[color:var(--vl-fg-3)]">{hasAny ? "filters active" : "optional"}</span>
      </div>
      <Card tone="vl" className="p-3">
        <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-2">
          <Field label="Min USD">
            <input
              type="number"
              step="0.01"
              min="0"
              name="minUsd"
              defaultValue={filters.minUsd ?? ""}
              placeholder="50"
              className="vl-text-input w-32"
            />
          </Field>
          <Field label="Token">
            <input
              type="text"
              name="token"
              defaultValue={filters.token ?? ""}
              placeholder="symbol / name / mint"
              className="vl-text-input w-56"
            />
          </Field>
          <Field label="Side">
            <select
              name="side"
              defaultValue={filters.side ?? ""}
              className="vl-text-input"
            >
              <option value="">All</option>
              <option value="buy">Buy</option>
              <option value="sell">Sell</option>
            </select>
          </Field>
          <Field label="Program">
            <input
              type="text"
              name="program"
              defaultValue={filters.program ?? ""}
              placeholder="jupiter"
              className="vl-text-input w-40"
            />
          </Field>
          <div className="flex gap-2 pb-[1px]">
            <button type="submit" className={btnVlPrimary}>
              Apply
            </button>
            <button type="button" onClick={handleReset} className={btnVlGhost}>
              Reset
            </button>
          </div>
        </form>
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
