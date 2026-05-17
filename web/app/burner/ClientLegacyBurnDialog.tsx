"use client";

// Experimental client-built Legacy NFT burn — minimal progress dialog.
// Visually distinct from the production BulkBurnDialog so the user can
// never confuse this prototype with the shipping bulk-burn flow.

import type { ClientLegacyBurnState } from "./useClientLegacyBurnPrototype";

function shortAddr(s: string): string {
  if (s.length <= 12) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

export function ClientLegacyBurnDialog({
  state,
  onStart,
  onClose,
}: {
  state: ClientLegacyBurnState;
  onStart: () => void;
  onClose: () => void;
}) {
  const isTerminal = state.status === "confirmed" || state.status === "failed";
  const inFlight =
    state.status !== "idle" && !isTerminal;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Experimental client-built legacy burn"
      className="fixed inset-0 z-[125] flex items-center justify-center bg-black/70 backdrop-blur-sm"
    >
      <div className="vl-card max-w-md w-[min(520px,92vw)] max-h-[85vh] flex flex-col overflow-hidden border-2 border-amber-500/60">
        {/* HEADER — amber border + 🧪 chip make this visually distinct */}
        <div className="px-5 py-4 border-b border-[color:var(--vl-border)] flex items-center gap-3 bg-amber-900/15">
          <div className="text-[18px]" aria-hidden>
            🧪
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-base font-semibold leading-tight">
              Experimental: client-built legacy burn
            </div>
            <div className="mt-0.5 text-[11px] uppercase tracking-wide text-amber-300">
              Prototype — frontend builds the BurnV1 ix, no backend tx bytes
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={inFlight}
            className="vl-btn vl-btn-ghost is-sm"
          >
            {isTerminal ? "Close" : "Cancel"}
          </button>
        </div>

        {/* TARGET */}
        <div className="px-5 py-3 border-b border-[color:var(--vl-border)] text-[12px]">
          <div className="text-[10px] uppercase tracking-wide text-[color:var(--vl-fg-3)]">
            Target NFT
          </div>
          <div className="mt-0.5 text-[13px] font-medium leading-tight">
            {state.targetName ?? "(unnamed)"}
          </div>
          {state.targetMint && (
            <div className="mt-0.5 mono text-[11px] text-[color:var(--vl-fg-3)] truncate">
              {shortAddr(state.targetMint)}
            </div>
          )}
        </div>

        {/* STATE */}
        <div className="px-5 py-3 border-b border-[color:var(--vl-border)] text-[12px]">
          <div className="flex items-center gap-2">
            <span
              className={`inline-block w-2 h-2 rounded-full ${
                state.status === "confirmed"
                  ? "bg-emerald-400"
                  : state.status === "failed"
                    ? "bg-red-400"
                    : state.status === "idle"
                      ? "bg-[color:var(--vl-fg-3)]"
                      : "bg-amber-400 animate-pulse"
              }`}
              aria-hidden
            />
            <span className="font-medium">
              {state.status === "idle" ? "ready" : state.status}
            </span>
            {state.step && (
              <span className="text-[color:var(--vl-fg-3)]">· {state.step}</span>
            )}
          </div>
          {state.builtIxCount !== null && (
            <div className="mt-1 text-[11px] text-[color:var(--vl-fg-3)]">
              built {state.builtIxCount} ix locally · blockhash{" "}
              {state.blockhash ? shortAddr(state.blockhash) : "—"}
            </div>
          )}
          {state.signature && (
            <div className="mt-1 mono text-[11px] text-[color:var(--vl-fg-3)] truncate">
              tx {shortAddr(state.signature)}
            </div>
          )}
          {state.error && (
            <div className="mt-2 text-[12px] text-red-300">{state.error}</div>
          )}
        </div>

        {/* ACTIONS */}
        <div className="px-5 py-3 flex items-center gap-3">
          {state.status === "idle" && (
            <button
              type="button"
              onClick={onStart}
              className="vl-btn vl-btn-burn is-sm"
            >
              Build &amp; sign locally
            </button>
          )}
          {state.status === "confirmed" && state.signature && (
            <a
              href={`https://solscan.io/tx/${state.signature}`}
              target="_blank"
              rel="noopener noreferrer"
              className="vl-btn vl-btn-ghost is-sm"
            >
              View on Solscan
            </a>
          )}
          {state.status === "failed" && (
            <button
              type="button"
              onClick={onStart}
              className="vl-btn vl-btn-ghost is-sm"
            >
              Retry
            </button>
          )}
          <div className="ml-auto text-[10px] text-[color:var(--vl-fg-3)]">
            phase B — proto only
          </div>
        </div>
      </div>
    </div>
  );
}
