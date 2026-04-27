// Type scale. Inter as the primary face — it has the best tabular-num support
// of the free options and is what most Solana-ecosystem dashboards converge on.

export const typography = {
  fontSans: 'Inter, ui-sans-serif, system-ui, sans-serif',
  fontMono:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',

  size: {
    xs: '0.75rem',     // 12
    sm: '0.875rem',    // 14
    base: '1rem',      // 16
    lg: '1.125rem',    // 18
    xl: '1.25rem',     // 20
    '2xl': '1.5rem',   // 24
    '3xl': '1.875rem', // 30
    '4xl': '2.25rem',  // 36
    '5xl': '3rem',     // 48
    '6xl': '3.75rem',  // 60
  },

  weight: {
    normal: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
  },

  // Apply to any element that displays numeric data (prices, balances, counts).
  // Keeps column widths stable when values change — feels professional.
  numberClass: 'tabular-nums tracking-tight',
} as const;
