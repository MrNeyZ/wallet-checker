"use client";

import { useRouter } from "next/navigation";

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
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-medium uppercase tracking-wider text-zinc-500">
          Trade filters
        </h2>
        <span className="text-xs text-zinc-400">{hasAny ? "filters active" : "optional"}</span>
      </div>
      <div className="rounded border border-zinc-200 bg-white p-4">
        <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-2">
          <Field label="Min USD">
            <input
              type="number"
              step="0.01"
              min="0"
              name="minUsd"
              defaultValue={filters.minUsd ?? ""}
              placeholder="50"
              className="w-32 rounded border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
            />
          </Field>
          <Field label="Token">
            <input
              type="text"
              name="token"
              defaultValue={filters.token ?? ""}
              placeholder="symbol / name / mint"
              className="w-56 rounded border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
            />
          </Field>
          <Field label="Side">
            <select
              name="side"
              defaultValue={filters.side ?? ""}
              className="rounded border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
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
              className="w-40 rounded border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
            />
          </Field>
          <div className="flex gap-2 pb-[1px]">
            <button
              type="submit"
              className="rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700"
            >
              Apply
            </button>
            <button
              type="button"
              onClick={handleReset}
              className="rounded border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
            >
              Reset
            </button>
          </div>
        </form>
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
