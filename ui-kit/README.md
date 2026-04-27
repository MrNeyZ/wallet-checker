# UI Kit

Design system for Solana wallet/portfolio dashboards. Drop-in for **Next.js + Tailwind CSS** projects. No third-party runtime dependencies.

## Layout

```
ui-kit/
├── styles/
│   ├── colors.ts          design tokens — surfaces, text, PnL colors
│   ├── spacing.ts         spacing + radius scale
│   └── typography.ts      font stacks, size/weight scale
├── components/
│   ├── Card.tsx           frosted-glass surface
│   ├── Table.tsx          12-col grid table
│   ├── Badge.tsx          status/PnL pill (neutral/buy/sell/warn/info)
│   ├── TokenCell.tsx      icon + symbol + name cell
│   ├── SectionHeader.tsx  small uppercase label
│   ├── WalletLink.tsx     truncated address → explorer
│   └── TxLink.tsx         truncated signature → explorer
├── animations/
│   ├── transitions.css    fade-in, slide-up, pop, stagger
│   └── flash.css          live-dot, flash-green/red, skeleton, tint
├── tokens/
│   └── tokenIcons.ts      Jupiter token-list icon resolver + fallback
├── examples/
│   └── dashboard-preview.tsx  full reference page
└── README.md
```

## Install

1. **Copy the folder** into your project, e.g. `web/src/ui-kit/`.

2. **Import the animation CSS once** at the app root.
   - App Router: `app/layout.tsx`
   - Pages Router: `pages/_app.tsx`
   ```tsx
   import './ui-kit/animations/transitions.css';
   import './ui-kit/animations/flash.css';
   ```

3. **Use components.** All paths are relative inside the kit, so it works with any path alias setup.
   ```tsx
   import { Card } from '@/ui-kit/components/Card';
   import { Badge } from '@/ui-kit/components/Badge';
   import { Table } from '@/ui-kit/components/Table';
   ```

## Requirements

- React 18+
- Next.js 13+ (App Router or Pages Router)
- Tailwind CSS 3+
- Inter loaded via `next/font` or `<link>` to Google Fonts (recommended)

## Conventions

- **Numbers always use `tabular-nums`.** Stable column widths when values change. The kit hardcodes this in `TokenCell`, `Table`, and the example — keep doing it elsewhere.
- **Dark theme by default.** Background `bg-neutral-950`, surface `bg-neutral-900/40` (with backdrop blur), borders `border-neutral-800`.
- **Buy / PnL+ → emerald-500.** Sell / PnL− → red-500. Neutral → neutral-300/500.
- **Animations are short.** 300–600ms. Easing `cubic-bezier(.22, 1, .36, 1)` for the "soft out" feel. Don't loop forever unless it's a status indicator.

## Animation classes — cheat sheet

| Class | Use |
|---|---|
| `.ui-fade-in` | Element fades in on mount |
| `.ui-slide-up` | Slides up + fades in |
| `.ui-slide-down` | Slides down + fades in |
| `.ui-pop` | Scale-pop (confirmations) |
| `.ui-stagger` (parent) | Children animate with 50ms stagger (up to 10 children) |
| `.ui-live-dot` | Pulsing green status dot (`--red`, `--amber` modifiers) |
| `.ui-flash-green` | One-shot green bg flash on a row (new buy) |
| `.ui-flash-red` | One-shot red bg flash (new sell) |
| `.ui-tint-up` | Number text briefly tints green |
| `.ui-tint-down` | Number text briefly tints red |
| `.ui-skeleton` | Loading shimmer placeholder |

## Customizing

- **Colors:** edit `styles/colors.ts`. If you also want Tailwind classes to follow, mirror them in `tailwind.config.ts` under `theme.extend.colors`.
- **Typography:** the kit assumes Inter. Swap via Tailwind's `font-sans` or by editing `typography.ts`.
- **Components:** every component takes a `className` prop for overrides. No Tailwind class is hardcoded in a way that prevents extension.

## Why no dependencies

- Easier to drop into any project. No `npm install` step.
- No version conflicts with the host project.
- The components are intentionally small (< 100 lines each) — read the source if you need to bend behavior.

If you want charts, add **`recharts`** separately (`npm i recharts`). It's the de-facto standard for React + Tailwind dashboards.

## Reference page

`examples/dashboard-preview.tsx` shows hero, metric grid, positions table, activity feed, and skeleton states wired together. Copy it into a route to render the kit end-to-end as a sanity check.
