"use client";

import { tokenIconUrl, fallbackIconDataUri } from '../tokens/tokenIcons';

type Props = {
  mint: string;
  symbol: string;
  name?: string;
  size?: number;
  className?: string;
};

// Standard "icon + symbol/name" cell used in token tables.
// Truncates long names instead of breaking the row layout.
export function TokenCell({
  mint,
  symbol,
  name,
  size = 24,
  className = '',
}: Props) {
  return (
    <div className={`flex items-center gap-2 min-w-0 ${className}`}>
      <img
        src={tokenIconUrl(mint)}
        alt={symbol}
        width={size}
        height={size}
        className="rounded-full bg-neutral-800 ring-1 ring-neutral-700 shrink-0"
        onError={(e) => {
          const img = e.currentTarget;
          if (img.src !== fallbackIconDataUri()) img.src = fallbackIconDataUri();
        }}
      />
      <div className="min-w-0">
        <div className="text-sm font-semibold text-white truncate">{symbol}</div>
        {name && (
          <div className="text-xs text-neutral-300 truncate">{name}</div>
        )}
      </div>
    </div>
  );
}
