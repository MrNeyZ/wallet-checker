"use client";

// Phase 1 Bulk Burner — progress + summary modal.
//
// Render contract: render this anywhere; pass the session state. When
// session.status === "idle" we render nothing (no portal, no overlay).
// All Phantom popups happen via the parent's call to start() — this
// component is purely a status surface + a cancel button + a final
// summary. It never decides when to sign / submit / confirm.

import { useMemo } from "react";
import type {
  BulkBurnSessionState,
  BulkBurnWindowEntryResult,
} from "./useBulkBurnSession";

const PREVIEW_CAP = 50;

function shortAddr(s: string): string {
  if (s.length <= 12) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function categoryLabel(kind: BulkBurnWindowEntryResult["spec"]["kind"]): string {
  switch (kind) {
    case "closeEmpty":
      return "Empty closes";
    case "splBurn":
      return "SPL burn + close";
    case "legacyNft":
      return "Legacy NFT";
    case "core":
      return "Core NFT";
    case "pnft":
      return "pNFT";
  }
}

function statusBadge(s: BulkBurnWindowEntryResult["status"]): {
  text: string;
  cls: string;
} {
  switch (s) {
    case "building":
      return { text: "building…", cls: "bg-[color:var(--vl-bg-2)] text-[color:var(--vl-fg-2)]" };
    case "ready":
      return { text: "ready", cls: "bg-[color:var(--vl-bg-2)] text-[color:var(--vl-fg-1)]" };
    case "signed":
      return { text: "signed", cls: "bg-[color:var(--vl-bg-2)] text-[color:var(--vl-fg-1)]" };
    case "submitted":
      return { text: "submitting…", cls: "bg-[color:var(--vl-bg-2)] text-[color:var(--vl-fg-1)]" };
    case "confirmed":
      return { text: "confirmed", cls: "bg-emerald-900/40 text-emerald-300" };
    case "build-failed":
      return { text: "build failed", cls: "bg-red-900/40 text-red-300" };
    case "gate-failed":
      return { text: "skipped (gate)", cls: "bg-amber-900/40 text-amber-300" };
    case "sign-failed":
      return { text: "sign failed", cls: "bg-red-900/40 text-red-300" };
    case "submit-failed":
      return { text: "submit failed", cls: "bg-red-900/40 text-red-300" };
    case "confirm-failed":
      return { text: "confirm failed", cls: "bg-red-900/40 text-red-300" };
    case "skipped-stale":
      return { text: "skipped (stale)", cls: "bg-amber-900/40 text-amber-300" };
    case "skipped-cancel":
      return { text: "cancelled", cls: "bg-[color:var(--vl-bg-2)] text-[color:var(--vl-fg-3)]" };
  }
}

function stepLabel(step: BulkBurnSessionState["step"]): string {
  switch (step) {
    case "preparing":
      return "Preparing queue…";
    case "building":
      return "Building transactions…";
    case "signing":
      return "Awaiting wallet signature…";
    case "submitting":
      return "Submitting to network…";
    case "confirming":
      return "Confirming on-chain…";
    case "between-windows":
      return "Window complete — starting next window…";
    case null:
      return "";
  }
}

export function BulkBurnDialog({
  state,
  onCancel,
  onClose,
}: {
  state: BulkBurnSessionState;
  onCancel: () => void;
  onClose: () => void;
}) {
  // Aggregate summary — recomputed on every render but cheap (results
  // length is bounded by the user's selection).
  const summary = useMemo(() => {
    let confirmed = 0;
    let failed = 0;
    let skipped = 0;
    let assetsAffected = 0;
    for (const r of state.results) {
      if (r.status === "confirmed") {
        confirmed++;
        if (r.itemsAffected) assetsAffected += r.itemsAffected;
      } else if (
        r.status === "build-failed" ||
        r.status === "sign-failed" ||
        r.status === "submit-failed" ||
        r.status === "confirm-failed"
      ) {
        failed++;
      } else if (
        r.status === "gate-failed" ||
        r.status === "skipped-stale" ||
        r.status === "skipped-cancel"
      ) {
        skipped++;
      }
    }
    return { confirmed, failed, skipped, assetsAffected };
  }, [state.results]);

  if (state.status === "idle") return null;

  const preview = state.results.slice(0, PREVIEW_CAP);
  const overflow = Math.max(0, state.results.length - PREVIEW_CAP);
  const isTerminal =
    state.status === "done" ||
    state.status === "cancelled" ||
    state.status === "failed";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Bulk burn"
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 backdrop-blur-sm"
    >
      <div className="vl-card max-w-2xl w-[min(720px,92vw)] max-h-[85vh] flex flex-col overflow-hidden">
        {/* HEADER */}
        <div className="px-5 py-4 border-b border-[color:var(--vl-border)] flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-base font-semibold leading-tight flex items-center gap-2">
              <span>{state.status === "running" ? "Bulk burn in progress" : "Bulk burn"}</span>
              <span
                className={`text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded ${
                  state.mode === "fast"
                    ? "bg-red-900/40 text-red-300"
                    : "bg-[color:var(--vl-bg-2)] text-[color:var(--vl-fg-2)]"
                }`}
                aria-label={`signing mode: ${state.mode}`}
              >
                {state.mode}
              </span>
            </div>
            <div className="mt-0.5 text-[12px] text-[color:var(--vl-fg-3)]">
              {state.status === "running" ? (
                <>
                  Window {state.windowIndex + 1}/{state.totalWindows} ·{" "}
                  {stepLabel(state.step)}
                </>
              ) : state.status === "done" ? (
                "All done."
              ) : state.status === "cancelled" ? (
                "Cancelled by user. Already-submitted transactions will continue to confirm."
              ) : (
                state.topError ?? "Bulk burn failed."
              )}
            </div>
          </div>
          {state.status === "running" && (
            <button
              type="button"
              onClick={onCancel}
              className="vl-btn vl-btn-ghost is-sm"
              aria-label="Cancel bulk burn"
            >
              Cancel
            </button>
          )}
          {isTerminal && (
            <button
              type="button"
              onClick={onClose}
              className="vl-btn vl-btn-ghost is-sm"
              aria-label="Close summary"
            >
              Close
            </button>
          )}
        </div>

        {/* MODE NOTICES — different copy per active mode.
            Safe: explains why N approvals appear.
            Fast (real): warns about Phantom's "0 changes" batch UI.
            Fast (fell back): user requested fast but wallet doesn't
            support batched signing — show the safe-mode copy plus a
            one-line acknowledgement of the fallback. */}
        {state.mode === "safe" && (
          <div className="px-5 py-2 border-b border-[color:var(--vl-border)] bg-amber-900/20 text-[12px] text-amber-200">
            Safe mode: Phantom shows accurate NFT changes only when signing
            one transaction at a time. Bulk burn will open one approval per batch.
          </div>
        )}
        {state.mode === "fast" && !state.fellBackToSequential && (
          <div className="px-5 py-2 border-b border-[color:var(--vl-border)] bg-red-900/25 text-[12px] text-red-200">
            Fast mode uses one batched Phantom approval, but Phantom may
            show 0 changes / unsafe warning for NFT burns. Review the
            batch details below before signing.
          </div>
        )}
        {state.mode === "fast" && state.fellBackToSequential && (
          <div className="px-5 py-2 border-b border-[color:var(--vl-border)] bg-amber-900/20 text-[12px] text-amber-200">
            Fast mode requested but this wallet doesn&apos;t support batched
            signing — falling back to safe mode. One approval per batch.
          </div>
        )}

        {/* TOP-LEVEL TOTALS */}
        <div className="px-5 py-3 border-b border-[color:var(--vl-border)] grid grid-cols-4 gap-3 text-[12px]">
          <Stat label="Confirmed" value={summary.confirmed} accent="emerald" />
          <Stat label="Failed" value={summary.failed} accent="red" />
          <Stat label="Skipped" value={summary.skipped} accent="amber" />
          <Stat label="Assets" value={summary.assetsAffected} accent="default" />
        </div>

        {/* RESULT LIST */}
        <div className="flex-1 overflow-y-auto px-3 py-2">
          {preview.length === 0 ? (
            <div className="px-2 py-6 text-center text-[12px] text-[color:var(--vl-fg-3)]">
              No transactions queued.
            </div>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {preview.map((r, i) => {
                const badge = statusBadge(r.status);
                return (
                  <li
                    key={i}
                    className="flex items-center gap-3 px-2 py-1.5 rounded border border-[color:var(--vl-border)] bg-[color:var(--vl-bg-1)]"
                  >
                    <div className="text-[12px] text-[color:var(--vl-fg-3)] tabular-nums w-6 text-right">
                      {i + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-medium leading-tight truncate">
                        {categoryLabel(r.spec.kind)} · {r.spec.planLabel}
                      </div>
                      {r.error && (
                        <div className="mt-0.5 text-[11px] text-red-300 truncate">
                          {r.error}
                        </div>
                      )}
                      {r.note && !r.error && (
                        <div className="mt-0.5 text-[11px] text-amber-300">
                          {r.note}
                        </div>
                      )}
                      {r.signature && (
                        <div className="mt-0.5 text-[11px] text-[color:var(--vl-fg-3)] mono truncate">
                          tx {shortAddr(r.signature)}
                        </div>
                      )}
                    </div>
                    <span
                      className={`text-[11px] px-1.5 py-0.5 rounded ${badge.cls}`}
                    >
                      {badge.text}
                    </span>
                  </li>
                );
              })}
              {overflow > 0 && (
                <li className="text-[12px] text-[color:var(--vl-fg-3)] text-center py-2">
                  + {overflow} more (omitted from preview)
                </li>
              )}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent: "emerald" | "red" | "amber" | "default";
}) {
  const accentCls =
    accent === "emerald"
      ? "text-emerald-300"
      : accent === "red"
        ? "text-red-300"
        : accent === "amber"
          ? "text-amber-300"
          : "text-[color:var(--vl-fg-1)]";
  return (
    <div className="flex flex-col items-start">
      <div className="text-[10px] uppercase tracking-wide text-[color:var(--vl-fg-3)]">
        {label}
      </div>
      <div className={`text-base font-semibold tabular-nums ${accentCls}`}>
        {value}
      </div>
    </div>
  );
}
