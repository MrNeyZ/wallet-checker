"use client";

// Tiny app-wide context to lift Bulk Burner signing mode (Safe/Fast) out
// of `BulkBurnUiWired`'s local useState so the HUD bottom-nav can drive
// the same value as the inline pill above the bulk button. Mode is
// per-tab session state — defaults to "safe" on every page load,
// matches the destructive-action-aware default the bulk burner has
// always shipped.

import { createContext, useContext, useState, type ReactNode } from "react";
import type { BulkBurnMode } from "@/app/burner/useBulkBurnSession";

interface BurnerModeContextValue {
  mode: BulkBurnMode;
  setMode: (m: BulkBurnMode) => void;
}

const BurnerModeContext = createContext<BurnerModeContextValue | null>(null);

export function BurnerModeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<BulkBurnMode>("safe");
  return (
    <BurnerModeContext.Provider value={{ mode, setMode }}>
      {children}
    </BurnerModeContext.Provider>
  );
}

// Reader hook. Falls back to a stable no-op when no provider is mounted
// so callers that pre-date this lift (or render in a test harness) keep
// working without throwing.
export function useBurnerMode(): BurnerModeContextValue {
  const ctx = useContext(BurnerModeContext);
  if (ctx) return ctx;
  return { mode: "safe", setMode: () => {} };
}
