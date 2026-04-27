import { ReactNode } from 'react';

type Props = {
  children: ReactNode;
  className?: string;
  hover?: boolean;
};

// Frosted-glass surface used as the default container for everything: metric
// cards, table wrappers, modals. Subtle border + translucent fill + backdrop
// blur reads as "elevated" without being heavy.
//
// Every card has a 150ms transition baked in. By default the border subtly
// lifts on hover (very light — just enough to feel alive). Pass `hover` for
// stronger feedback (background + shadow) on cards that act like links.
export function Card({ children, className = '', hover = false }: Props) {
  return (
    <div
      className={[
        'rounded-md border border-neutral-700 bg-neutral-900',
        'transition-colors duration-100 hover:border-neutral-600',
        hover ? 'hover:bg-neutral-900/80' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </div>
  );
}
