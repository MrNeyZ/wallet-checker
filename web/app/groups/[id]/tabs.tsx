"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { TabId } from "./tab-types";

export type { TabId };

const TABS: { id: TabId; label: string }[] = [
  { id: "positions", label: "Positions" },
  { id: "activity", label: "Activity" },
  { id: "alerts", label: "Alerts" },
  { id: "cleaner", label: "Cleaner" },
  { id: "settings", label: "Settings" },
];

export function Tabs({ active, groupId }: { active: TabId; groupId: string }) {
  const sp = useSearchParams();

  function buildHref(tabId: TabId): string {
    const params = new URLSearchParams(sp?.toString() ?? "");
    params.set("tab", tabId);
    return `/groups/${groupId}?${params.toString()}`;
  }

  return (
    <nav
      role="tablist"
      aria-label="Group sections"
      className="flex gap-1 border-b border-neutral-800"
    >
      {TABS.map((t) => {
        const isActive = active === t.id;
        return (
          <Link
            key={t.id}
            href={buildHref(t.id)}
            scroll={false}
            role="tab"
            aria-selected={isActive}
            className={[
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors duration-100",
              isActive
                ? "border-violet-500 text-white"
                : "border-transparent text-neutral-400 hover:text-white",
            ].join(" ")}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
