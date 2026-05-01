// Centralized button class strings — three tiers + disabled state.
// Imported by every page that renders buttons; keeps the visual hierarchy
// consistent in one place. No logic, no JSX — just Tailwind class strings.

// Instant feel: 100ms color/transform transitions. Press-down on `active`
// gives tactile feedback without delay.
const base =
  "inline-flex items-center justify-center rounded-md " +
  "transition-colors duration-100 " +
  "active:scale-[0.98] " +
  "focus:outline-none disabled:opacity-40 disabled:cursor-not-allowed " +
  "disabled:active:scale-100";

export const btnPrimary =
  `${base} px-4 py-2 text-sm font-semibold text-white ` +
  "bg-violet-500 shadow-sm shadow-violet-500/20 " +
  "hover:bg-violet-400 hover:shadow-violet-500/40 " +
  "focus:ring-2 focus:ring-violet-500/40";

export const btnPrimaryEmerald =
  `${base} px-4 py-2 text-sm font-semibold text-white ` +
  "bg-emerald-500 shadow-sm shadow-emerald-500/20 " +
  "hover:bg-emerald-400 hover:shadow-emerald-500/40 " +
  "focus:ring-2 focus:ring-emerald-500/40";

export const btnSecondary =
  `${base} px-4 py-2 text-sm font-medium text-neutral-200 ` +
  "border border-neutral-700 bg-neutral-900 " +
  "hover:border-neutral-600 hover:bg-neutral-800 hover:text-white " +
  "focus:ring-2 focus:ring-neutral-700/60";

export const btnDanger =
  `${base} px-3 py-1.5 text-xs font-semibold text-red-300 ` +
  "bg-red-500/10 ring-1 ring-red-500/30 " +
  "hover:bg-red-500 hover:text-white hover:ring-red-500 " +
  "focus:ring-2 focus:ring-red-500/40";

// Inline text link variant for dense rows ("Delete" / "Remove" inside a table).
// Same red-300 base color so it reads as the same hierarchy as btnDanger
// without adding visual weight to row layouts.
export const btnDangerLink =
  "text-xs font-semibold text-red-300 transition-colors duration-100 " +
  "hover:text-red-200 disabled:opacity-40 disabled:cursor-not-allowed";

// Inline text link for non-destructive secondary row actions (e.g. Disable/Enable).
export const btnLink =
  "text-xs font-semibold text-neutral-200 transition-colors duration-100 " +
  "hover:text-white disabled:opacity-40 disabled:cursor-not-allowed";

// ── VictoryLabs button variants (additive) ───────────────────────────────
// Map onto the .vl-btn / .vl-btn-primary / .vl-btn-burn / .vl-btn-ghost
// utility classes defined in app/globals.css. Existing pages that use
// btnPrimary / btnSecondary / btnDanger keep their current styling; new or
// migrated surfaces opt in via these tokens.
export const btnVlPrimary = "vl-btn vl-btn-primary";
export const btnVlBurn = "vl-btn vl-btn-burn";
export const btnVlGhost = "vl-btn vl-btn-ghost";
