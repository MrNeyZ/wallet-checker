import { ReactNode } from 'react';

type Props = {
  children: ReactNode;
  className?: string;
};

// Tiny uppercase tracker — used to label every section/group on a dashboard.
// Always 11px, neutral-500, wide tracking. Consistency is the point.
export function SectionHeader({ children, className = '' }: Props) {
  return (
    <h3
      className={`text-[11px] font-semibold uppercase tracking-wider text-neutral-300 mb-2 ${className}`}
    >
      {children}
    </h3>
  );
}
