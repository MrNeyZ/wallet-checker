// Resolves a token's logo URL from its mint address.
//
// Default source: Jupiter strict token list (the same source most Solana
// dashboards use, including major aggregators). It's a public CDN — no API
// key, no rate limits in practice. Fallback to a neutral placeholder if a
// mint isn't in the list.
//
// Override via env if you host your own mirror:
//   NEXT_PUBLIC_TOKEN_ICON_BASE=https://your-cdn/tokens

const BASE =
  (typeof process !== 'undefined' &&
    process.env?.NEXT_PUBLIC_TOKEN_ICON_BASE) ||
  'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';

export function tokenIconUrl(mint: string): string {
  return `${BASE}/${mint}/logo.png`;
}

// Convenience helper for use inside <img onError>: swap to a generic circle
// if the icon 404s. Avoids broken-image icons in the table.
export function fallbackIconDataUri(): string {
  return (
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
         <circle cx="16" cy="16" r="16" fill="#27272A"/>
         <circle cx="16" cy="16" r="6"  fill="#3F3F46"/>
       </svg>`,
    )
  );
}
