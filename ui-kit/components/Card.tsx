import { ReactNode } from 'react';

type Props = {
  children: ReactNode;
  className?: string;
  hover?: boolean;
};

// Frosted-glass surface used as the default container for everything: metric
// cards, table wrappers, modals. Subtle border + translucent fill + backdrop
// blur reads as "elevated" without being heavy.
export function Card({ children, className = '', hover = false }: Props) {
  return (
    <div
      className={[
        'rounded-xl border border-neutral-800 bg-neutral-900/40 backdrop-blur-md',
        hover ? 'transition-colors hover:bg-neutral-900/60' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </div>
  );
}
