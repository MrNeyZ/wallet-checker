// Reference page that wires every component of the kit together.
// Drop into `app/preview/page.tsx` (App Router) or
// `pages/preview.tsx` (Pages Router) to see the kit in isolation.

import { Card } from '../components/Card';
import { Table, Column } from '../components/Table';
import { Badge } from '../components/Badge';
import { TokenCell } from '../components/TokenCell';
import { SectionHeader } from '../components/SectionHeader';
import { WalletLink } from '../components/WalletLink';
import { TxLink } from '../components/TxLink';

type Position = {
  mint: string;
  symbol: string;
  name: string;
  amount: number;
  valueUsd: number;
  pnlPct: number;
};

const sample: Position[] = [
  {
    mint: 'So11111111111111111111111111111111111111112',
    symbol: 'SOL',
    name: 'Solana',
    amount: 12.4,
    valueUsd: 2480.32,
    pnlPct: 4.2,
  },
  {
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    symbol: 'USDC',
    name: 'USD Coin',
    amount: 1500.0,
    valueUsd: 1500.0,
    pnlPct: 0.0,
  },
  {
    mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    symbol: 'JUP',
    name: 'Jupiter',
    amount: 950,
    valueUsd: 712.5,
    pnlPct: -3.1,
  },
];

const columns: Column<Position>[] = [
  {
    key: 'token',
    label: 'Token',
    span: 5,
    render: (r) => (
      <TokenCell mint={r.mint} symbol={r.symbol} name={r.name} />
    ),
  },
  {
    key: 'amount',
    label: 'Amount',
    span: 3,
    align: 'right',
    render: (r) => (
      <span className="tabular-nums text-neutral-300">{r.amount}</span>
    ),
  },
  {
    key: 'value',
    label: 'Value',
    span: 2,
    align: 'right',
    render: (r) => (
      <span className="tabular-nums">${r.valueUsd.toLocaleString()}</span>
    ),
  },
  {
    key: 'pnl',
    label: 'PnL',
    span: 2,
    align: 'right',
    render: (r) => (
      <Badge variant={r.pnlPct >= 0 ? 'buy' : 'sell'}>
        {r.pnlPct >= 0 ? '+' : ''}
        {r.pnlPct.toFixed(2)}%
      </Badge>
    ),
  },
];

export default function DashboardPreview() {
  const wallet = 'F7BDq8YsYs69JsMxJJhARTTTZNcKu5h2GohLbe8cYQwE';

  return (
    <div className="min-h-screen bg-neutral-950 text-white p-8 font-sans">
      <div className="max-w-6xl mx-auto space-y-8">
        {/* hero */}
        <div className="ui-fade-in">
          <SectionHeader>Wallet</SectionHeader>
          <div className="flex items-baseline justify-between gap-4 flex-wrap">
            <h1 className="text-5xl md:text-6xl font-bold tabular-nums tracking-tight">
              $4,692.82
            </h1>
            <WalletLink address={wallet} />
          </div>
          <div className="flex items-center gap-2 mt-3">
            <span className="ui-live-dot" />
            <span className="text-xs text-neutral-400">Live</span>
            <Badge variant="buy">+12.4% 24h</Badge>
          </div>
        </div>

        {/* metric cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 ui-stagger">
          {[
            { label: 'Net Worth', value: '$4,692.82' },
            { label: '24h PnL', value: '+$182.10' },
            { label: 'Positions', value: '3' },
            { label: 'Win Rate', value: '64%' },
          ].map((m) => (
            <Card key={m.label} className="p-5 ui-slide-up">
              <div className="text-xs uppercase tracking-wider text-neutral-500">
                {m.label}
              </div>
              <div className="mt-2 text-2xl font-semibold tabular-nums">
                {m.value}
              </div>
            </Card>
          ))}
        </div>

        {/* positions table */}
        <Card className="overflow-hidden">
          <div className="px-6 py-4 border-b border-neutral-800 flex items-center justify-between">
            <SectionHeader className="mb-0">Positions</SectionHeader>
            <Badge>{sample.length}</Badge>
          </div>
          <Table
            columns={columns}
            rows={sample}
            rowKey={(r) => r.mint}
          />
        </Card>

        {/* activity sample */}
        <Card className="p-5 space-y-3">
          <SectionHeader className="mb-0">Latest activity</SectionHeader>
          <div className="text-sm flex items-center justify-between ui-flash-green rounded-md px-2">
            <span className="text-neutral-200">
              <span className="text-emerald-400">Bought</span> 12 SOL
            </span>
            <TxLink signature="3ZyQwL8VqXq5JpvZmM3KVkCDJtMz9LyL4n2BDC6oeXBpwJjVmL5MqhJpL2Rd" />
          </div>
          <div className="text-sm flex items-center justify-between rounded-md px-2">
            <span className="text-neutral-200">
              <span className="text-red-400">Sold</span> 200 JUP
            </span>
            <TxLink signature="5KqPvR2hYz9LdT4bWmK7nXvE8sFpQ3jM6oNyCdL8aGtRfV2eBxJqM4kPhA9wRzN" />
          </div>
        </Card>

        {/* skeleton sample */}
        <Card className="p-5 space-y-3">
          <SectionHeader className="mb-0">Loading state</SectionHeader>
          <div className="ui-skeleton h-4 w-32" />
          <div className="ui-skeleton h-4 w-48" />
          <div className="ui-skeleton h-4 w-24" />
        </Card>
      </div>
    </div>
  );
}
