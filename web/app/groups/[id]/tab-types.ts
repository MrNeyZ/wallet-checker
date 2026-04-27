// Plain (non-"use client") module so that both server components and the
// client tab nav can import these constants. Putting them in tabs.tsx made
// them client references that don't carry runtime methods like Array.includes.
export const TAB_IDS = ["positions", "activity", "alerts", "cleaner", "settings"] as const;
export type TabId = (typeof TAB_IDS)[number];
