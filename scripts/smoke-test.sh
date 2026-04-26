#!/usr/bin/env bash
# Smoke test for wallet-checker. Exits non-zero on any failure.
# Usage: BASE_URL=http://localhost:3000 ./scripts/smoke-test.sh

set -u
BASE_URL="${BASE_URL:-http://localhost:3000}"
WALLET="${WALLET:-F7BDq8YsYs69JsMxJJhARTTTZNcKu5h2GohLbe8cYQwE}"

PASS=0
FAIL=0

red()   { printf "\033[31m%s\033[0m" "$1"; }
green() { printf "\033[32m%s\033[0m" "$1"; }

ok()   { green "  PASS"; echo " — $1"; PASS=$((PASS+1)); }
fail() { red   "  FAIL"; echo " — $1"; FAIL=$((FAIL+1)); }

# expect_status NAME EXPECTED_CODE METHOD URL [DATA]
expect_status() {
  local name="$1" expected="$2" method="$3" url="$4" data="${5:-}"
  local code
  if [ -n "$data" ]; then
    code=$(curl -s -o /tmp/smoke_body -w "%{http_code}" -X "$method" \
      -H "Content-Type: application/json" -d "$data" "$url")
  else
    code=$(curl -s -o /tmp/smoke_body -w "%{http_code}" -X "$method" "$url")
  fi
  if [ "$code" = "$expected" ]; then
    ok "$name (HTTP $code)"
  else
    fail "$name expected HTTP $expected, got $code"
    echo "    body: $(head -c 200 /tmp/smoke_body)"
  fi
}

# expect_body_contains NAME METHOD URL EXPECTED_SUBSTRING [DATA]
expect_body_contains() {
  local name="$1" method="$2" url="$3" needle="$4" data="${5:-}"
  if [ -n "$data" ]; then
    curl -s -o /tmp/smoke_body -X "$method" -H "Content-Type: application/json" -d "$data" "$url"
  else
    curl -s -o /tmp/smoke_body -X "$method" "$url"
  fi
  if grep -q "$needle" /tmp/smoke_body; then
    ok "$name (body contains '$needle')"
  else
    fail "$name body missing '$needle'"
    echo "    body: $(head -c 200 /tmp/smoke_body)"
  fi
}

echo "=== wallet-checker smoke test ==="
echo "BASE_URL=$BASE_URL"
echo "WALLET=$WALLET"
echo

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

curl -s -o /tmp/smoke_body -X POST -H "Content-Type: application/json" \
  -d "$CREATE_BODY" "$BASE_URL/api/groups" > /dev/null

# extract id without jq: pull the first UUID-looking value
GID=$(grep -oE '"id":"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"' /tmp/smoke_body \
  | head -n1 | sed 's/.*"\([0-9a-f-]*\)"/\1/')

if [ -n "$GID" ]; then
  ok "POST /api/groups created group $GID"
else
  fail "POST /api/groups did not return a UUID id"
  echo "    body: $(head -c 200 /tmp/smoke_body)"
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
