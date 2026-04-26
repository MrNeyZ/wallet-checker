# wallet-checker

Solana Wallet Ops backend for scanning wallets, tracking cleanup opportunities, building unsigned cleanup transactions, and aggregating PnL / trade / portfolio data across groups of wallets via SolanaTracker.

The server is a thin Express + TypeScript app. SolanaTracker is the primary data provider for PnL, trades, and portfolio. SPL data (token accounts, classification, CloseAccount transaction building) goes through `@solana/web3.js` and `@solana/spl-token` directly. There is no database yet — group state is persisted to a local JSON file.

## Setup

Requirements: Node.js 20+ and a SolanaTracker API key.

```bash
cp .env.example .env
# edit .env to set SOLANATRACKER_API_KEY (and optionally SOLANA_RPC_URL)

npm install
npm run dev    # tsx watch on src/index.ts
```

Build and run a production-style start:

```bash
npm run build
npm start
```

## Environment variables

All variables are validated by zod at startup ([src/config/env.ts](src/config/env.ts)). Invalid config exits the process.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PORT` | no | `3000` | HTTP listen port |
| `NODE_ENV` | no | `development` | one of `development \| production \| test` |
| `SOLANA_RPC_URL` | no | `https://api.mainnet-beta.solana.com` | Solana JSON-RPC endpoint for token-account scans |
| `SOLANA_CLUSTER` | no | `mainnet-beta` | one of `mainnet-beta \| devnet \| testnet` |
| `SOLANATRACKER_API_KEY` | required for PnL/trades/portfolio endpoints | — | sent as `x-api-key` to `https://data.solanatracker.io` |

If `SOLANATRACKER_API_KEY` is unset, PnL/trades/portfolio routes return `503` with a clear error. The server still boots.

## Persistence

In-memory state survives restarts via:
- `data/groups.json` — group definitions and wallet membership (synchronous write after every mutation; loaded once at startup; corrupt JSON → console warning, start empty).

Caches are in-process Maps (cleared on restart):
- PnL: 5 min per wallet
- Portfolio: 5 min per wallet
- Trades: 60 s per `(wallet, cursor, limit)` tuple

Failed responses are never cached.

## API

Base URL: `http://localhost:3000`. All bodies are JSON.

### Health

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | returns `{ ok: true }` |

```bash
curl http://localhost:3000/health
```

### Wallet cleanup

Scans SPL Token + Token-2022 accounts for a single wallet and builds an unsigned transaction that closes empty accounts.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/wallet/:address/cleanup-scan` | classifies token accounts: empty / fungible / NFT / unknown; reports reclaimable rent |
| GET | `/api/wallet/:address/burn-candidates` | non-SOL fungible token accounts that could later be burned + closed; carries `riskLevel:"unknown"` and `burnRecommended:false` (burn flow not implemented) |
| POST | `/api/wallet/:address/close-empty-tx` | builds a legacy `Transaction` with up to 10 `CloseAccount` instructions; returns base64-serialized **unsigned** tx with `recentBlockhash` and `feePayer` set; signing is client-side |

```bash
# scan a wallet
curl http://localhost:3000/api/wallet/F7BDq8YsYs69JsMxJJhARTTTZNcKu5h2GohLbe8cYQwE/cleanup-scan

# burn candidates (informational only)
curl http://localhost:3000/api/wallet/F7BDq8YsYs69JsMxJJhARTTTZNcKu5h2GohLbe8cYQwE/burn-candidates

# build close-empty unsigned tx
curl -X POST http://localhost:3000/api/wallet/F7BDq8YsYs69JsMxJJhARTTTZNcKu5h2GohLbe8cYQwE/close-empty-tx
```

The close-empty endpoint defends in depth: only accounts with `amount === "0"` and `owner === wallet` are included; NFT/fungible/unknown buckets cannot leak in.

### Wallet PnL / trades (SolanaTracker)

Single-wallet endpoints proxy SolanaTracker with caching, normalization, and clean error mapping (missing key → 503; provider 4xx/5xx → 502 with `providerStatus`).

| Method | Path | Notes |
|---|---|---|
| GET | `/api/wallet/:address/pnl` | passes through provider `data` plus a normalized `summary { totalPnlUsd, realizedPnlUsd, unrealizedPnlUsd, winRate, totalTrades, tokensCount }`, defensive against shape changes |
| GET | `/api/wallet/:address/trades?cursor=&limit=` | recent swaps; `limit` 1..100 default 50; cursor-paginated via provider |
| POST | `/api/wallets/pnl` | batch PnL (max 50 wallets, concurrency 5) |

```bash
# single PnL (cached 5 min)
curl http://localhost:3000/api/wallet/F7BDq8YsYs69JsMxJJhARTTTZNcKu5h2GohLbe8cYQwE/pnl

# trades (cached 60 s per cursor+limit)
curl "http://localhost:3000/api/wallet/F7BDq8YsYs69JsMxJJhARTTTZNcKu5h2GohLbe8cYQwE/trades?limit=10"

# batch PnL
curl -X POST -H "Content-Type: application/json" \
  -d '{"wallets":["F7BDq8YsYs69JsMxJJhARTTTZNcKu5h2GohLbe8cYQwE","vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg"]}' \
  http://localhost:3000/api/wallets/pnl
```

### Groups (CRUD)

In-memory groups with file-backed persistence. Wallet addresses validated via `@solana/web3.js` `PublicKey`.

| Method | Path | Notes |
|---|---|---|
| POST | `/api/groups` | body `{ "name": string }`; returns 201 |
| GET | `/api/groups` | list all groups |
| POST | `/api/groups/:groupId/wallets` | body `{ "wallet": string, "label"?: string }`; 409 on duplicate, 404 on missing group |
| GET | `/api/groups/:groupId/wallets` | list wallets in a group |
| DELETE | `/api/groups/:groupId/wallets/:wallet` | 204 on success, 404 on either missing |

```bash
# create group
GID=$(curl -s -X POST -H "Content-Type: application/json" \
  -d '{"name":"Whales"}' http://localhost:3000/api/groups | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")

# add wallet
curl -X POST -H "Content-Type: application/json" \
  -d '{"wallet":"F7BDq8YsYs69JsMxJJhARTTTZNcKu5h2GohLbe8cYQwE","label":"trader"}' \
  http://localhost:3000/api/groups/$GID/wallets

# remove wallet
curl -X DELETE http://localhost:3000/api/groups/$GID/wallets/F7BDq8YsYs69JsMxJJhARTTTZNcKu5h2GohLbe8cYQwE
```

### Group analytics

All group analytics endpoints fan out to SolanaTracker with **concurrency 5** and per-wallet error isolation: a single failed wallet never fails the whole request — it shows up in `failedWallets` (or `warnings` on the dashboard).

| Method | Path | Notes |
|---|---|---|
| GET | `/api/groups/:groupId/overview` | PnL overview; sums non-null normalized summary fields across wallets; results sorted by `totalPnlUsd` desc (numeric first, null next, failed last) |
| GET | `/api/groups/:groupId/pnl` | raw per-wallet PnL data + normalized summary |
| GET | `/api/groups/:groupId/trades?limit=&perWalletLimit=&minUsd=&program=&side=&token=` | merged trade feed, sorted by time desc, sliced to `limit`. Filters: USD floor, DEX program, buy/sell side (heuristic on quote mints WSOL/USDC/USDT), token by mint/symbol/name |
| GET | `/api/groups/:groupId/token-summary?perWalletLimit=&minUsd=` | per-token activity summary (buys/sells counts and USD totals, net USD, contributing wallets); sorted by `\|netUsd\|` desc |
| GET | `/api/groups/:groupId/portfolio-summary` | current holdings aggregated across the group via SolanaTracker `/wallet/{wallet}`; per-token totals + per-wallet breakdown; sorted by `totalValueUsd` desc |
| GET | `/api/groups/:groupId/dashboard` | unified compact view: `pnlOverview`, `portfolioSummary`, `tokenActivitySummary`, `recentTrades`, plus `warnings[]`. Trades fetched once per wallet (`perWalletLimit=50`) and reused for both `tokenActivitySummary` and `recentTrades` (top 20). |

```bash
# group dashboard (compact, 5 sections)
curl http://localhost:3000/api/groups/$GID/dashboard

# group trades — recent jupiter buys ≥ $15
curl "http://localhost:3000/api/groups/$GID/trades?limit=20&perWalletLimit=20&program=jupiter&side=buy&minUsd=15"

# group token activity — top tokens by |netUsd|
curl "http://localhost:3000/api/groups/$GID/token-summary?perWalletLimit=50&minUsd=10"

# group portfolio — aggregated holdings
curl http://localhost:3000/api/groups/$GID/portfolio-summary
```

## Project layout

```
src/
├── index.ts                              # Express bootstrap
├── config/env.ts                         # zod env validation
├── lib/
│   ├── solana.ts                         # shared Connection
│   ├── scanner.ts                        # SPL + Token-2022 scanner / classifier
│   ├── txBuilder.ts                      # CloseAccount tx builder (max 10 ix)
│   ├── groupsStore.ts                    # in-memory groups + JSON persistence
│   └── concurrency.ts                    # runWithConcurrency helper
├── routes/
│   ├── health.ts
│   ├── wallet.ts                         # /api/wallet/:address/...
│   ├── wallets.ts                        # /api/wallets/pnl (batch)
│   └── groups.ts                         # /api/groups/...
└── services/
    ├── pnl/solanaTrackerProvider.ts      # /pnl/{wallet} + 5-min cache + summary
    ├── pnl/normalizePnl.ts               # defensive PnL summary normalizer
    ├── trades/solanaTrackerTrades.ts     # /wallet/{wallet}/trades + 60s cache
    ├── portfolio/solanaTrackerPortfolio.ts  # /wallet/{wallet} holdings + 5-min cache
    └── groups/                           # group analytics (PnL, trades, portfolio, dashboard)
```

## What's not built

- No burn / send / sign transactions yet. `close-empty-tx` returns an unsigned tx; the client signs and submits.
- No database. Groups persist to JSON, caches do not persist at all.
- No frontend.
- No Helius, no manual transaction parsing.
