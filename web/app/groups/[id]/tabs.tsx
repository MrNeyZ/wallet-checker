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
    // `.vl-tabstrip` provides the bottom border; `.vl-tab` + `.is-active`
    // ship the typography, hover, and the purple bottom-rail active state.
    // No content-component touches.
    <nav role="tablist" aria-label="Group sections" className="vl-tabstrip">
      {TABS.map((t) => {
        const isActive = active === t.id;
        return (
          <Link
            key={t.id}
            href={buildHref(t.id)}
            scroll={false}
            role="tab"
            aria-selected={isActive}
            className={`vl-tab ${isActive ? "is-active" : ""}`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
