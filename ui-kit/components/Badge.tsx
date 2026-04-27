import { ReactNode } from 'react';

type Variant = 'neutral' | 'buy' | 'sell' | 'warn' | 'info';

const variants: Record<Variant, string> = {
  neutral: 'bg-neutral-800 text-neutral-300 ring-1 ring-neutral-700',
  buy: 'bg-emerald-500/10 text-emerald-400 ring-1 ring-emerald-500/30',
  sell: 'bg-red-500/10 text-red-400 ring-1 ring-red-500/30',
  warn: 'bg-amber-500/10 text-amber-400 ring-1 ring-amber-500/30',
  info: 'bg-blue-500/10 text-blue-400 ring-1 ring-blue-500/30',
};

type Props = {
  children: ReactNode;
  variant?: Variant;
  className?: string;
};

export function Badge({ children, variant = 'neutral', className = '' }: Props) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 text-[11px] font-medium rounded-md ${variants[variant]} ${className}`}
    >
      {children}
    </span>
  );
}
