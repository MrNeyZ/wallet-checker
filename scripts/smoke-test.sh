#!/usr/bin/env bash
# Smoke test for wallet-checker. Exits non-zero on any failure.
# Usage: BASE_URL=http://localhost:3002 ./scripts/smoke-test.sh

set -u
BASE_URL="${BASE_URL:-http://localhost:3002}"
WALLET="${WALLET:-F7BDq8YsYs69JsMxJJhARTTTZNcKu5h2GohLbe8cYQwE}"

PASS=0
FAIL=0

red()   { printf "\033[31m%s\033[0m" "$1"; }
green() { printf "\033[32m%s\033[0m" "$1"; }

ok()   { green "  PASS"; echo " — $1"; PASS=$((PASS+1)); }
fail() { red   "  FAIL"; echo " — $1"; FAIL=$((FAIL+1)); }

# Run a curl call and split body/status using a sentinel-newline pattern.
# Sets globals: SMOKE_BODY, SMOKE_STATUS.
do_curl() {
  local method="$1" url="$2" data="${3:-}"
  local response
  if [ -n "$data" ]; then
    response=$(curl -s -w "\n%{http_code}" -X "$method" \
      -H "Content-Type: application/json" -d "$data" "$url" || true)
  else
    response=$(curl -s -w "\n%{http_code}" -X "$method" "$url" || true)
  fi
  SMOKE_BODY=$(printf "%s" "$response" | sed '$d')
  SMOKE_STATUS=$(printf "%s" "$response" | tail -n1)
}

# expect_status NAME EXPECTED_CODE METHOD URL [DATA]
expect_status() {
  local name="$1" expected="$2" method="$3" url="$4" data="${5:-}"
  do_curl "$method" "$url" "$data"
  if [ "$SMOKE_STATUS" = "000" ]; then
    fail "$name — server unreachable at $url"
    return
  fi
  if [ "$SMOKE_STATUS" = "$expected" ]; then
    ok "$name (HTTP $SMOKE_STATUS)"
  else
    fail "$name expected HTTP $expected, got $SMOKE_STATUS"
    echo "    body: $(printf "%s" "$SMOKE_BODY" | head -c 200)"
  fi
}

# expect_body_contains NAME METHOD URL EXPECTED_SUBSTRING [DATA]
expect_body_contains() {
  local name="$1" method="$2" url="$3" needle="$4" data="${5:-}"
  do_curl "$method" "$url" "$data"
  if [ "$SMOKE_STATUS" = "000" ]; then
    fail "$name — server unreachable at $url"
    return
  fi
  if printf "%s" "$SMOKE_BODY" | grep -q "$needle"; then
    ok "$name (body contains '$needle')"
  else
    fail "$name body missing '$needle'"
    echo "    body: $(printf "%s" "$SMOKE_BODY" | head -c 200)"
  fi
}

echo "=== wallet-checker smoke test ==="
echo "BASE_URL=$BASE_URL"
echo "WALLET=$WALLET"
echo

# Reachability probe — fail fast with a clear message if the server is down,
# rather than emitting a wall of curl failures.
do_curl GET "$BASE_URL/health"
if [ "$SMOKE_STATUS" = "000" ]; then
  red "ABORT"; echo " — Server unreachable at $BASE_URL"
  echo "Hint: start the backend with 'npm run dev' (root) or check BASE_URL."
  exit 2
fi

echo "[1] health"
expect_status "GET /health returns 200" 200 GET "$BASE_URL/health"
expect_body_contains "GET /health returns ok:true" GET "$BASE_URL/health" '"ok":true'

echo
echo "[2] wallet cleanup validation"
expect_status "GET /api/wallet/<bogus>/cleanup-scan returns 400" \
  400 GET "$BASE_URL/api/wallet/not-a-real-address/cleanup-scan"

echo
echo "[3] groups CRUD"
TS=$(date +%s)
GROUP_NAME="smoke-test-$TS"
CREATE_BODY="{\"name\":\"$GROUP_NAME\"}"

do_curl POST "$BASE_URL/api/groups" "$CREATE_BODY"

# extract id without jq: pull the first UUID-looking value from the response body
GID=$(printf "%s" "$SMOKE_BODY" \
  | grep -oE '"id":"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"' \
  | head -n1 | sed 's/.*"\([0-9a-f-]*\)"/\1/')

if [ -n "$GID" ]; then
  ok "POST /api/groups created group $GID"
else
  fail "POST /api/groups did not return a UUID id"
  echo "    body: $(printf "%s" "$SMOKE_BODY" | head -c 200)"
  echo
  echo "Result: $PASS passed, $FAIL failed"
  exit 1
fi

ADD_BODY="{\"wallet\":\"$WALLET\",\"label\":\"smoke\"}"
expect_status "POST /api/groups/:id/wallets returns 201" \
  201 POST "$BASE_URL/api/groups/$GID/wallets" "$ADD_BODY"

expect_body_contains "GET /api/groups/:id/wallets contains wallet" \
  GET "$BASE_URL/api/groups/$GID/wallets" "$WALLET"

echo
echo "[4] group overview"
expect_status "GET /api/groups/:id/overview returns 200" \
  200 GET "$BASE_URL/api/groups/$GID/overview"
expect_body_contains "overview body contains 'totals'" \
  GET "$BASE_URL/api/groups/$GID/overview" '"totals"'

echo
echo "[5] group dashboard"
expect_status "GET /api/groups/:id/dashboard returns 200" \
  200 GET "$BASE_URL/api/groups/$GID/dashboard"
expect_body_contains "dashboard body contains 'pnlOverview'" \
  GET "$BASE_URL/api/groups/$GID/dashboard" '"pnlOverview"'
expect_body_contains "dashboard body contains 'portfolioSummary'" \
  GET "$BASE_URL/api/groups/$GID/dashboard" '"portfolioSummary"'
expect_body_contains "dashboard body contains 'recentTrades'" \
  GET "$BASE_URL/api/groups/$GID/dashboard" '"recentTrades"'

echo
echo "=== Result: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
