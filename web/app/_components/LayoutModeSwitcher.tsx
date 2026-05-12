"use client";

// Layout-mode controller + compact floating switcher.
//
// The WC v2 CSS layer (globals.css) gates a lot of responsive behavior on
// `html[data-layout="pc|laptop|phone"]` — the NFT grid column count (6/4/2),
// the burn-table column collapse, the `.vl-layout` max-width per mode, the
// stat-strip 2x2 phone collapse, etc. Nothing was setting that attribute,
// so all of it was inert. This component is the minimal wiring that turns it
// on: it resolves the persisted mode, applies it to `<html>`, and renders a
// small fixed pill so the operator can switch. Mirrors the nft-live-feed
// FloatingLayoutModeSwitcher behavior (same `vl.layoutMode` storage key).
//
// Default = laptop (the design target). The actual pre-paint application is
// done by a tiny inline <script> in layout.tsx so pc/phone users don't flash
// the laptop layout on first paint; this component reconciles React state +
// re-applies on mount (covering the case where localStorage is unavailable
// and the inline script no-op'd).
//
// Nothing here touches backend / scanner / signing code. Pure UI + a
// localStorage key + a dataset attribute.

import { useEffect, useState } from "react";

export type LayoutMode = "pc" | "laptop" | "phone";

const STORAGE_KEY = "vl.layoutMode";
const DEFAULT_MODE: LayoutMode = "laptop";
const MODES: { key: LayoutMode; label: string }[] = [
  { key: "pc", label: "PC" },
  { key: "laptop", label: "Laptop" },
  { key: "phone", label: "Phone" },
];

function isMode(v: unknown): v is LayoutMode {
  return v === "pc" || v === "laptop" || v === "phone";
}

function readMode(): LayoutMode {
  if (typeof window === "undefined") return DEFAULT_MODE;
  try {
    const m = window.localStorage.getItem(STORAGE_KEY);
    if (isMode(m)) return m;
  } catch {
    /* private mode / disabled storage — fall through to default */
  }
  return DEFAULT_MODE;
}

function applyMode(m: LayoutMode): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.layout = m;
}

export function LayoutModeSwitcher() {
  const [mode, setMode] = useState<LayoutMode>(DEFAULT_MODE);

  // Reconcile on mount: the inline script in layout.tsx has (in the common
  // case) already set `data-layout`, but we re-read + re-apply here so React
  // state matches and the attribute is correct even if the inline script was
  // unable to run (storage exception).
  useEffect(() => {
    const m = readMode();
    setMode(m);
    applyMode(m);
  }, []);

  const choose = (m: LayoutMode) => {
    setMode(m);
    applyMode(m);
    try {
      window.localStorage.setItem(STORAGE_KEY, m);
    } catch {
      /* persistence is best-effort */
    }
  };

  return (
    <div
      role="group"
      aria-label="Layout mode"
      style={{
        position: "fixed",
        right: 12,
        bottom: 12,
        zIndex: 80,
        display: "flex",
        gap: 2,
        padding: 3,
        borderRadius: 8,
        background: "rgba(13,11,26,0.85)",
        border: "1px solid var(--vl-border, rgba(168,144,232,0.18))",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
        fontFamily: "var(--vl-font-mono, ui-monospace, monospace)",
        fontSize: 10,
        letterSpacing: "0.3px",
        userSelect: "none",
      }}
    >
      {MODES.map((m) => {
        const active = mode === m.key;
        return (
          <button
            key={m.key}
            type="button"
            onClick={() => choose(m.key)}
            aria-pressed={active}
            title={`${m.label} layout`}
            style={{
              padding: "3px 8px",
              borderRadius: 6,
              border:
                "1px solid " +
                (active
                  ? "var(--vl-purple-border, rgba(168,144,232,0.42))"
                  : "transparent"),
              background: active
                ? "var(--vl-purple-soft, rgba(168,144,232,0.14))"
                : "transparent",
              color: active
                ? "var(--vl-purple-2, #cfc4f3)"
                : "var(--vl-fg-3, #837db0)",
              fontWeight: 600,
              textTransform: "uppercase",
              cursor: "pointer",
              fontFamily: "inherit",
              fontSize: "inherit",
              letterSpacing: "inherit",
              transition: "color var(--vl-motion, 0.16s), background var(--vl-motion, 0.16s), border-color var(--vl-motion, 0.16s)",
            }}
          >
            {m.label}
          </button>
        );
      })}
    </div>
  );
}
