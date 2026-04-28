"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card } from "@/ui-kit/components/Card";
import { SectionHeader } from "@/ui-kit/components/SectionHeader";
import { btnPrimary, btnSecondary } from "@/lib/buttonStyles";

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
        <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
          Presets
        </span>
        {TRADE_FILTER_PRESETS.map((p) => {
          const active = isPresetActive(filters, p.params);
          const cls = active
            ? "rounded border border-violet-500/60 bg-violet-500/15 px-2 py-0.5 text-[11px] font-bold text-violet-200 transition-colors duration-100"
            : "rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-[11px] font-semibold text-neutral-300 transition-colors duration-100 hover:border-neutral-500 hover:bg-neutral-800 hover:text-white";
          return (
            <Link
              key={p.label}
              href={buildPresetUrl(groupId, p.params)}
              scroll={false}
              aria-pressed={active}
              className={cls}
            >
              {p.label}
            </Link>
          );
        })}
      </div>
      <div className="mb-2 flex items-baseline justify-between">
        <SectionHeader className="mb-0">Trade filters</SectionHeader>
        <span className="text-[11px] text-neutral-500">{hasAny ? "filters active" : "optional"}</span>
      </div>
      <Card className="p-2.5">
        <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-2">
          <Field label="Min USD">
            <input
              type="number"
              step="0.01"
              min="0"
              name="minUsd"
              defaultValue={filters.minUsd ?? ""}
              placeholder="50"
              className={inputClass + " w-32"}
            />
          </Field>
          <Field label="Token">
            <input
              type="text"
              name="token"
              defaultValue={filters.token ?? ""}
              placeholder="symbol / name / mint"
              className={inputClass + " w-56"}
            />
          </Field>
          <Field label="Side">
            <select
              name="side"
              defaultValue={filters.side ?? ""}
              className={inputClass}
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
              className={inputClass + " w-40"}
            />
          </Field>
          <div className="flex gap-2 pb-[1px]">
            <button type="submit" className={btnPrimary}>
              Apply
            </button>
            <button type="button" onClick={handleReset} className={btnSecondary}>
              Reset
            </button>
          </div>
        </form>
      </Card>
    </section>
  );
}

const inputClass =
  "rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-white placeholder:text-neutral-500 transition-colors duration-100 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500/30";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col text-[10px] uppercase tracking-wider text-neutral-500">
      {label}
      <div className="mt-1">{children}</div>
    </label>
  );
}
