"use client";

import { useRouter } from "next/navigation";
import { Card } from "@/ui-kit/components/Card";
import { SectionHeader } from "@/ui-kit/components/SectionHeader";
import { btnPrimary, btnSecondary } from "@/lib/buttonStyles";

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
