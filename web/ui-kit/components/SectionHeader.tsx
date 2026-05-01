import { ReactNode } from 'react';

type Tone = 'default' | 'vl';

type Props = {
  children: ReactNode;
  className?: string;
  // `tone="vl"` swaps the typography to the VictoryLabs mono section
  // tracker (defined by `.vl-section-header` in app/globals.css). Default
  // keeps the original 11px neutral-300 styling so legacy call sites stay
  // pixel-stable.
  tone?: Tone;
};

// Tiny uppercase tracker — used to label every section/group on a dashboard.
// Always 11px, neutral-300, wide tracking. Consistency is the point.
export function SectionHeader({ children, className = '', tone = 'default' }: Props) {
  if (tone === 'vl') {
    return (
      <h3 className={`vl-section-header mb-2 ${className}`.trim()}>
        {children}
      </h3>
    );
  }
  return (
    <h3
      className={`text-[11px] font-semibold uppercase tracking-wider text-neutral-300 mb-2 ${className}`}
    >
      {children}
    </h3>
  );
}
