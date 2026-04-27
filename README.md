# wallet-checker

Solana wallet ops backend + minimal dashboard for scanning wallets, tracking cleanup opportunities, building unsigned cleanup transactions, and aggregating PnL / trades / portfolio across wallet groups. Includes server-side alert rules with Telegram delivery and persistent dedup.

The server is a thin Express + TypeScript app. SPL data (token accounts, classification, CloseAccount transaction building) goes through `@solana/web3.js` and `@solana/spl-token` directly. There is no database — group state and alert state are persisted to local JSON files.

## Providers

| Provider | Used for |
|---|---|
| **SolanaTracker** | wallet PnL, wallet trades, alert rule matching |
| **Helius** | wallet portfolio / balances |
| **Telegram** | alert notification delivery |

## Local run

Two processes — backend on `:3002`, frontend on `:3003`.

```bash
# 1. backend (repo root)
cp .env.example .env       # fill in API keys
npm install
npm run dev                # tsx watch on http://localhost:3002

# 2. frontend (separate terminal)
cd web
cp .env.example .env       # BACKEND_URL=http://localhost:3002
npm install
npm run dev                # http://localhost:3003
```

Production-style start for the backend: `npm run build && npm start`.

## Environment variables

Backend env validated by zod at startup ([src/config/env.ts](src/config/env.ts)). Invalid config exits the process; missing optional keys disable specific features but the server still boots.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PORT` | no | `3002` | HTTP listen port |
| `NODE_ENV` | no | `development` | one of `development \| production \| test` |
| `SOLANA_RPC_URL` | no | mainnet-beta | Solana JSON-RPC endpoint for SPL token-account scans |
| `SOLANA_CLUSTER` | no | `mainnet-beta` | one of `mainnet-beta \| devnet \| testnet` |
| `APP_API_KEY` | no | — | when set, all routes except `GET /health` require `x-app-key: <APP_API_KEY>` and return `401 {"error":"Unauthorized"}` otherwise. Unset = auth disabled (local dev) |
| `SOLANATRACKER_API_KEY` | for PnL/trades/alerts | — | sent as `x-api-key` to `https://data.solanatracker.io` |
| `HELIUS_API_KEY` | for portfolio | — | sent as `api-key` query param to `https://api.helius.xyz` |
| `TELEGRAM_BOT_TOKEN` | for alert delivery | — | from BotFather |
| `TELEGRAM_CHAT_ID` | for alert delivery | — | numeric chat id where alerts are posted |

Frontend env (`web/.env`):

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `BACKEND_URL` | no | `http://localhost:3002` | base URL for server-side API calls |
| `BACKEND_APP_API_KEY` | only if backend has `APP_API_KEY` set | — | sent as `x-app-key` on every backend call from the Next server |

When a key is unset, the affected route returns `503` cleanly with a self-explanatory message and the rest of the app keeps working.

## Persistence

In-process state survives restarts via local JSON files under `data/` (auto-created, gitignored):

- `data/groups.json` — group definitions and wallet membership.
- `data/alerts.json` — server-side alert rules.
- `data/alert-sent.json` — `(ruleId, tx)` pairs already pushed to Telegram (cross-request dedup).

All files use sync writes after every mutation; load once at startup; corrupt JSON → console warning + start empty.

In-memory caches (cleared on restart, never persist failures):
- PnL: 5 min per wallet
- Portfolio: 5 min per wallet
- Trades: 60 s per `(wallet, cursor, limit)` tuple

## API

Base URL: `http://localhost:3002`. All bodies are JSON.

### Health

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | returns `{ ok: true }` |

### Wallet cleanup

| Method | Path | Notes |
|---|---|---|
| GET | `/api/wallet/:address/cleanup-scan` | classifies SPL + Token-2022 accounts: empty / fungible / NFT / unknown; reports reclaimable rent |
| GET | `/api/wallet/:address/burn-candidates` | non-SOL fungible accounts (informational only — burn flow not implemented) |
| POST | `/api/wallet/:address/close-empty-tx` | builds an unsigned legacy `Transaction` with up to 10 `CloseAccount` instructions; returns base64 |

### Wallet PnL / trades (SolanaTracker)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/wallet/:address/pnl` | provider `data` + normalized `summary` (`totalPnlUsd, realizedPnlUsd, unrealizedPnlUsd, winRate, totalTrades, tokensCount`) |
| GET | `/api/wallet/:address/trades?cursor=&limit=` | swap feed; `limit` 1..100 default 50 |
| POST | `/api/wallets/pnl` | batch (max 50 wallets, concurrency 5) |

### Groups

| Method | Path | Notes |
|---|---|---|
| POST | `/api/groups` | `{ "name": string }` |
| GET | `/api/groups` | list |
| POST | `/api/groups/:groupId/wallets` | `{ "wallet": string, "label"?: string }` |
| GET | `/api/groups/:groupId/wallets` | list |
| DELETE | `/api/groups/:groupId/wallets/:wallet` | 204 on success |

### Group analytics

All group analytics endpoints fan out at concurrency 5 with per-wallet error isolation; failures land in `failedWallets[]` (or `warnings[]` on the dashboard).

| Method | Path | Notes |
|---|---|---|
| GET | `/api/groups/:groupId/overview` | PnL summary; sums non-null fields; results sorted by `totalPnlUsd` desc |
| GET | `/api/groups/:groupId/pnl` | raw per-wallet PnL data |
| GET | `/api/groups/:groupId/trades?limit=&perWalletLimit=&minUsd=&program=&side=&token=` | merged trade feed |
| GET | `/api/groups/:groupId/token-summary?perWalletLimit=&minUsd=` | per-token activity (buys/sells/net USD) |
| GET | `/api/groups/:groupId/portfolio-summary` | aggregated holdings via Helius; spam filter applied; surfaces `filteredTokensCount` |
| GET | `/api/groups/:groupId/dashboard` | unified compact view: PnL overview + portfolio summary + token activity + recent trades + warnings |

### Alerts

Server-side rules persisted to `data/alerts.json`; matches checked against recent trades via SolanaTracker; Telegram delivery with cross-request dedup via `data/alert-sent.json`.

| Method | Path | Notes |
|---|---|---|
| POST | `/api/groups/:groupId/alerts` | create rule (`name, minUsd, token?, side?, program?, enabled?`) |
| GET | `/api/groups/:groupId/alerts` | list rules |
| PATCH | `/api/groups/:groupId/alerts/:alertId` | partial update |
| DELETE | `/api/groups/:groupId/alerts/:alertId` | 204 |
| POST | `/api/groups/:groupId/alerts/evaluate` | manual evaluation; body `{ perWalletLimit? }` (default 20, range 5..100). Returns matches; sends Telegram for un-deduped matches |
| POST | `/api/groups/:groupId/alerts/start` | start in-memory poller (`{ intervalMs? }`, default 60000, range 5000..3600000) |
| POST | `/api/groups/:groupId/alerts/stop` | stop poller |
| GET | `/api/groups/:groupId/alerts/status` | `{ running, intervalMs }` |

### Telegram test

| Method | Path | Notes |
|---|---|---|
| POST | `/api/test/telegram` | `{ "message": string }` — sends a test message to the configured chat |

## Alert workflow

End-to-end flow for getting Telegram alerts on group activity:

1. **Create a rule** — define matching criteria for a group:
   ```bash
   curl -X POST -H "Content-Type: application/json" \
     -d '{"name":"Big jupiter buys","minUsd":50,"program":"jupiter","side":"buy"}' \
     http://localhost:3002/api/groups/$GID/alerts
   ```
   Or click **Add rule** in the **Server alerts** section of the group page.

2. **Evaluate now** (one-shot) — to verify the rule and warm the dedup file:
   ```bash
   curl -X POST http://localhost:3002/api/groups/$GID/alerts/evaluate
   ```
   Or click **Evaluate now**. Telegram messages fire for matches that aren't already in `data/alert-sent.json`.

3. **Start the monitor** (continuous) — runs `evaluate` every `intervalMs`:
   ```bash
   curl -X POST -H "Content-Type: application/json" \
     -d '{"intervalMs":60000}' http://localhost:3002/api/groups/$GID/alerts/start
   ```
   Or use the **Start monitor** button in the **Alert monitor** section. Status is visible at `GET /alerts/status`. Stop with `POST /alerts/stop`.

4. **Dedup** — every successful Telegram send appends a `${ruleId}|${tx}` key to `data/alert-sent.json`. Subsequent ticks skip already-sent matches but still return them in API responses, so polling is idempotent. Failed sends do **not** mark as sent — they retry next tick.

## Web UI

Minimal Next.js (App Router) dashboard in [web/](web). Server components fetch directly from the backend — no client-side keys, no CORS.

Pages:
- `/groups` — list groups, create new
- `/groups/[id]` — wallets management, alert monitor, server alerts CRUD, PnL overview, portfolio summary (with spam-filter indicator), token activity, recent trades (with filters), local-preview alerts

## Production run (PM2)

[`ecosystem.config.cjs`](ecosystem.config.cjs) defines two PM2 apps: `wallet-checker-backend` (root, port 3002) and `wallet-checker-web` (`./web`, port 3003). Both wrap `npm run start`.

```bash
# build both projects
npm run build
cd web && npm run build && cd ..

# start both via PM2
pm2 start ecosystem.config.cjs

# persist the running process list across reboots
pm2 save

# follow combined logs
pm2 logs

# follow just the backend / web
pm2 logs wallet-checker-backend
pm2 logs wallet-checker-web

# stop / restart
pm2 stop ecosystem.config.cjs
pm2 restart ecosystem.config.cjs
```

PM2 must be installed globally (`npm i -g pm2`) and `.env` files in repo root and `web/` must be populated. Ports come from the `env` block in the ecosystem config; the apps' `npm start` scripts also pin the same defaults, so running them outside PM2 still works.

## Backup and restore

State files (`data/groups.json`, `data/alerts.json`, `data/alert-sent.json`) are local JSON. Two scripts handle export/import as timestamped tarballs under `backups/` (gitignored):

```bash
# create a snapshot of current state
./scripts/export-data.sh
# → backups/wallet-checker-<YYYYMMDD-HHMMSS>.tar.gz

# restore from a backup file (snapshots current state first into backups/pre-import-<ts>.tar.gz)
./scripts/import-data.sh backups/wallet-checker-20260101-120000.tar.gz

# list available backups
ls -1t backups/*.tar.gz
```

Import is reversible: the script always snapshots the current state to `backups/pre-import-<timestamp>.tar.gz` before extracting, so a bad restore can be rolled back. The export skips files that don't exist, so a partial state still tars cleanly.

## Smoke test

[scripts/smoke-test.sh](scripts/smoke-test.sh) exercises basic wiring (health, address validation, group CRUD, overview, dashboard). Pure bash + `curl` + `grep`, no `jq`.

```bash
./scripts/smoke-test.sh
BASE_URL=http://localhost:3002 WALLET=<base58> ./scripts/smoke-test.sh
```

## Project layout

```
src/
├── index.ts                                # Express bootstrap
├── config/env.ts                           # zod env validation
├── lib/
│   ├── solana.ts                           # shared @solana/web3.js Connection
│   ├── scanner.ts                          # SPL + Token-2022 scanner / classifier
│   ├── txBuilder.ts                        # CloseAccount tx builder (≤10 ix)
│   ├── groupsStore.ts                      # groups + JSON persistence
│   ├── alertsStore.ts                      # alert rules + JSON persistence
│   ├── alertSentStore.ts                   # cross-request alert dedup
│   ├── alertPoller.ts                      # in-memory setInterval poller
│   └── concurrency.ts                      # runWithConcurrency helper
├── routes/
│   ├── health.ts
│   ├── wallet.ts                           # /api/wallet/:address/...
│   ├── wallets.ts                          # /api/wallets/pnl batch
│   ├── groups.ts                           # /api/groups/...
│   └── test.ts                             # /api/test/telegram
└── services/
    ├── pnl/solanaTrackerProvider.ts        # /pnl/{wallet} + 5-min cache + summary
    ├── pnl/normalizePnl.ts                 # defensive PnL summary normalizer
    ├── trades/solanaTrackerTrades.ts       # /wallet/{wallet}/trades + 60 s cache
    ├── portfolio/solanaTrackerPortfolio.ts # Helius /v1/wallet/{addr}/balances + 5-min cache
    ├── notifications/telegram.ts           # Telegram sendMessage with HTML + dedup support
    └── groups/                             # group analytics + alert evaluator + dashboard

web/
├── app/groups/                             # /groups + /groups/[id]
├── lib/api.ts                              # typed backend client
└── lib/format.ts
```

## Known limitations

- **SolanaTracker rate limits** — free-tier limits are tight. Heavy parallel calls hit 429s; cache layers (PnL 5 min, trades 60 s) absorb most of this, and polling defaults are tuned conservatively (`perWalletLimit=20`, 60-second tick), but a busy 100-wallet group on a free tier will still see partial failures surfaced as `failedWallets`.
- **Polling is in-memory** — `setInterval` per group, no persistence of running state. Restarting the backend stops all pollers; the operator must re-`POST /alerts/start`.
- **Local JSON files for state** — groups, alert rules, and dedup keys all live as flat JSON in `data/`. Concurrent processes would race on writes; this is a single-instance dev/MVP setup. Migration to Postgres/Redis is a future task.
- **Portfolio spam filter is heuristic** — based on substring matches (`reward`, `claim`, `airdrop`, `.io`) and a value-based outlier rule (`valueUsd > 1000` for non-quote tokens). Will produce false positives for legitimately named tokens and false negatives for novel airdrop patterns. Original raw response is preserved at the provider level; filtering applies only at the group aggregation layer.
- **No auth / no multi-tenancy** — single-user, local dev. Backend trusts every caller; frontend has no login.
- **No burn / send / sign** — `close-empty-tx` returns an unsigned tx; signing happens client-side outside this app.
