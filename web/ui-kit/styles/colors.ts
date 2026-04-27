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
