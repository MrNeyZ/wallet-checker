import { ReactNode } from 'react';

// `vlPurple` / `vlAmber` / `vlGreen` / `vlRed` map to the .vl-badge-* utility
// classes in app/globals.css. The original Tailwind variants (neutral / buy /
// sell / warn / info) remain unchanged for back-compat; existing call sites
// keep their look. New/migrated surfaces opt into the VictoryLabs palette.
type Variant =
  | 'neutral'
  | 'buy'
  | 'sell'
  | 'warn'
  | 'info'
  | 'vlPurple'
  | 'vlGreen'
  | 'vlRed'
  | 'vlAmber'
  | 'vlNeutral';

const variants: Record<Variant, string> = {
  neutral: 'bg-neutral-800 text-neutral-300 ring-1 ring-neutral-700',
  buy: 'bg-emerald-500/10 text-emerald-400 ring-1 ring-emerald-500/30',
  sell: 'bg-red-500/10 text-red-400 ring-1 ring-red-500/30',
  warn: 'bg-amber-500/10 text-amber-400 ring-1 ring-amber-500/30',
  info: 'bg-blue-500/10 text-blue-400 ring-1 ring-blue-500/30',
  vlPurple: 'vl-badge vl-badge-purple',
  vlGreen: 'vl-badge vl-badge-green',
  vlRed: 'vl-badge vl-badge-red',
  vlAmber: 'vl-badge vl-badge-amber',
  vlNeutral: 'vl-badge vl-badge-neutral',
};

// Variants prefixed with `vl` carry their own padding/typography (defined
// in .vl-badge); the legacy variants keep the original Tailwind sizing.
const isVl = (v: Variant) => v.startsWith('vl');

type Props = {
  children: ReactNode;
  variant?: Variant;
  className?: string;
};

export function Badge({ children, variant = 'neutral', className = '' }: Props) {
  const base = isVl(variant)
    ? ''
    : 'inline-flex items-center px-2 py-0.5 text-[11px] font-medium rounded-md';
  return (
    <span className={`${base} ${variants[variant]} ${className}`.trim()}>
      {children}
    </span>
  );
}
