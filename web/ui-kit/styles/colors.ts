// Design tokens — dark theme tuned for crypto/portfolio dashboards.
// Mirrors Tailwind's neutral / emerald / red / violet scales so you can
// switch between these tokens and Tailwind utility classes interchangeably.

export const colors = {
  // surfaces
  bg: '#0A0A0B',
  surface: '#111114',
  surfaceMuted: '#15151A',
  border: '#1E1E25',

  // text
  fg: '#FAFAFA',
  fgMuted: '#A1A1AA',
  fgSubtle: '#71717A',

  // PnL / trade direction
  buy: '#10B981',
  buyDim: '#065F46',
  sell: '#EF4444',
  sellDim: '#7F1D1D',

  // brand accent
  primary: '#8B5CF6',
  primaryDim: '#5B21B6',

  // status
  warning: '#F59E0B',
  info: '#3B82F6',
} as const;

export type ColorToken = keyof typeof colors;

// ── VictoryLabs palette (additive) ────────────────────────────────────────
// Sourced from nft-live-feed/shared.tsx + the Burner.html mock. Mirrors the
// CSS custom properties in app/globals.css (`--vl-*`) so JS-side consumers
// (inline style, computed colors, charts) read from the same source as the
// stylesheet. Existing `colors.*` exports above are unchanged so any code
// still importing them keeps the original Tailwind-aligned palette.
//
// Semantics:
//   purple — primary accent (active nav, primary CTA, selection)
//   green  — "ready / safe / live" only (status pills, reclaim deltas)
//   red    — destructive / error only (burn CTA, audit-fail)
//   amber  — caution / pNFT pill / soft warning
export const vlColors = {
  bg: '#07060e',
  bg2: '#0d0b1a',
  page: '#1a162e',                       // outer panel surface
  surface: '#231e3d',                    // elevated card base (opaque)
  surface2: '#2c2649',
  // Borders are lavender alphas, not gray hex — gives the soft purple
  // border feel of the polish-pass design.
  border: 'rgba(168,144,232,0.30)',
  borderH: 'rgba(168,144,232,0.50)',

  fg: '#f2eeff',
  fg2: '#a59fc4',
  fg3: '#7a7497',
  fg4: '#524d6e',

  purple: '#a890e8',
  purple2: '#d0c8e4',
  purpleSoft: 'rgba(168,144,232,0.14)',
  purpleBorder: 'rgba(168,144,232,0.40)',

  green: '#4fb67d',
  red: '#ef7878',
  amber: '#fbbf24',
} as const;

export type VlColorToken = keyof typeof vlColors;
