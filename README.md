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
| `WEB_PASSWORD` | no | — | when set, all UI routes require login at `/login`. The submitted password is hashed (SHA-256) and stored in an `httpOnly`, `sameSite=lax`, secure-in-production cookie `wallet_checker_session` (1-week expiry). Unset = auth disabled (local dev). Logout button appears in the header only when this is set |

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

## Deploy on VPS (Ubuntu + PM2 + Nginx)

End-to-end deployment to a single Ubuntu host. No Docker, no orchestrator, no DB.

> **Before you start** — quick checklist of the things that are easy to get wrong:
>
> | Topic | Required |
> |---|---|
> | Backend port | **3002** (PM2 sets this from `ecosystem.config.cjs`) |
> | Frontend port | **3003** (PM2 sets this from `ecosystem.config.cjs`) |
> | Auth pairing | `APP_API_KEY` (`.env`) **must equal** `BACKEND_APP_API_KEY` (`web/.env`) — the frontend forwards the latter as `x-app-key` and the backend rejects mismatches with `401 Unauthorized` |
> | UI auth | Set `WEB_PASSWORD` in `web/.env` so `/login` is required (otherwise the dashboard is open to anyone who knows the URL) |
> | Secrets | **Never commit real `.env` or `web/.env`.** Both files are gitignored — keep it that way and edit only on the VPS |

### 1. Install Node.js

Pick one. nvm is simpler if you want to control the Node version per-shell:

```bash
# nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 20

# or apt (Ubuntu 22.04+)
sudo apt update
sudo apt install -y nodejs npm
node --version    # expect v20+
```

### 2. Install PM2

```bash
sudo npm i -g pm2
pm2 --version
```

### 3. Clone the repo

```bash
git clone <your-fork-url> wallet-checker
cd wallet-checker
```

### 4. Configure environment

Backend (`./.env`):

```bash
cp .env.example .env
# edit .env and set:
#   APP_API_KEY=<random secret>            # protect API
#   SOLANATRACKER_API_KEY=...
#   HELIUS_API_KEY=...
#   TELEGRAM_BOT_TOKEN=...
#   TELEGRAM_CHAT_ID=...
```

Frontend (`./web/.env`):

```bash
cp web/.env.example web/.env
# edit web/.env and set:
#   BACKEND_URL=http://localhost:3002
#   BACKEND_APP_API_KEY=<same as backend APP_API_KEY>
#   WEB_PASSWORD=<dashboard password>      # protect UI
```

The two API-key vars **must match** — the frontend forwards `BACKEND_APP_API_KEY` as `x-app-key` to the backend, which compares it to `APP_API_KEY`.

### 5. Install + build

```bash
npm install
npm run build
cd web && npm install && npm run build && cd ..
```

### 6. Start with PM2

```bash
pm2 start ecosystem.config.cjs
pm2 save                              # persist process list across reboot
pm2 startup                           # generate the systemd unit; follow the printed sudo line
pm2 status                            # current state
```

Both apps now run:
- `wallet-checker-backend` on port **3002**
- `wallet-checker-web` on port **3003**

### 7. Check logs

```bash
pm2 logs                                            # tail both apps (Ctrl+C to detach)
pm2 logs wallet-checker-backend --lines 200         # last 200 lines of the backend
pm2 logs wallet-checker-web      --lines 200         # last 200 lines of the frontend
pm2 monit                                           # live CPU / memory / log stream
```

The on-disk log files PM2 writes to are listed by `pm2 info wallet-checker-backend` (look for `out log path` / `error log path`).

Quick sanity probes once both are up:

```bash
curl -s http://127.0.0.1:3002/health           # → {"ok":true,...}
curl -s -o /dev/null -w "%{http_code}\n" \
  http://127.0.0.1:3003/                       # → 200 (or 307 → /login if WEB_PASSWORD set)
```

### 8. Nginx reverse proxy (optional)

Expose only the frontend publicly; route `/api/*` to the backend on the same domain so the browser never sees port 3002.

`/etc/nginx/sites-available/wallet-checker`:

```nginx
server {
    listen 80;
    server_name your-domain.example.com;

    # API: proxy /api/* to backend
    location /api/ {
        proxy_pass http://127.0.0.1:3002;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }

    # Backend health (for external monitors)
    location = /health {
        proxy_pass http://127.0.0.1:3002/health;
    }

    # Everything else: frontend
    location / {
        proxy_pass http://127.0.0.1:3003;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

Enable + reload:

```bash
sudo ln -s /etc/nginx/sites-available/wallet-checker /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

If you front the API via Nginx, point the frontend at the public URL too so server-side fetches use the proxy:

```bash
# in web/.env
BACKEND_URL=https://your-domain.example.com
```

(Set this only if your Nginx proxies `/api/` to the backend; with a separate API host, point `BACKEND_URL` to that host instead.) After editing `web/.env`, restart the frontend so it picks up the new value: `pm2 restart wallet-checker-web`.

### 9. HTTPS with certbot (Let's Encrypt)

DNS first: point an A record for `your-domain.example.com` at the VPS public IP, and verify it resolves before requesting a cert (Let's Encrypt validates over HTTP).

Open the firewall to ports 80 + 443:

```bash
sudo ufw allow 'Nginx Full'           # 80 + 443
sudo ufw status                        # verify
```

Install certbot and request the certificate:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.example.com
```

Certbot rewrites the Nginx server block to listen on 443, redirects 80 → 443, and installs an auto-renew systemd timer. Verify both:

```bash
sudo certbot certificates              # cert paths + expiry
sudo systemctl list-timers | grep certbot
sudo certbot renew --dry-run           # full dry-run of the renewal pipeline
```

After HTTPS is in place, the frontend `BACKEND_URL` should use `https://` (see step 8) and you can confirm end-to-end with `curl -sI https://your-domain.example.com/health`.

### 10. Updating

```bash
cd wallet-checker
git pull
npm install && npm run build
cd web && npm install && npm run build && cd ..
pm2 restart ecosystem.config.cjs
```

State files in `data/` and any backups in `backups/` are preserved across deploys.

## Preflight before deploy

[`scripts/preflight.sh`](scripts/preflight.sh) runs a battery of safety checks before pushing to GitHub or deploying to a VPS. Pure bash + `git` + `npm`.

```bash
./scripts/preflight.sh
```

Checks performed:

1. **Env files** — `.env` and `web/.env` exist.
2. **Env templates** — `.env.example` and `web/.env.example` exist; every key declared in the template is also present in the actual env file (catches drift after a new variable is added to a template).
3. **Gitignore coverage** — `.env`, `web/.env`, `data/`, `backups/` are all ignored. Secrets and state will not be pushed accidentally.
4. **Deploy config warnings** — non-fatal warnings if `APP_API_KEY` or `WEB_PASSWORD` are empty (open API or open UI), or if `APP_API_KEY` (.env) doesn't match `BACKEND_APP_API_KEY` (web/.env).
5. **Builds** — `npm run build` succeeds in both root and `web/`.
6. **Smoke test** — runs `scripts/smoke-test.sh` against `BASE_URL` (default `http://localhost:3002`).

Exit code `0` only when every check passes (warnings allowed). Run this before `git push` and before any `pm2 restart` on a VPS.

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
