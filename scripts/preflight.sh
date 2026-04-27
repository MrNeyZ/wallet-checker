#!/usr/bin/env bash
# Preflight checks before deploying wallet-checker to a VPS.
# Verifies .env files, builds, runs the smoke test, and warns about weak deploy config.
# Usage: ./scripts/preflight.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

PASS=0
FAIL=0
WARN=0

red()    { printf "\033[31m%s\033[0m" "$1"; }
green()  { printf "\033[32m%s\033[0m" "$1"; }
yellow() { printf "\033[33m%s\033[0m" "$1"; }

ok()   { green "  PASS"; echo " — $1"; PASS=$((PASS+1)); }
fail() { red   "  FAIL"; echo " — $1"; FAIL=$((FAIL+1)); }
warn() { yellow "  WARN"; echo " — $1"; WARN=$((WARN+1)); }

# get_env_value FILE KEY → echoes the value (after =), or empty
get_env_value() {
  local file="$1" key="$2"
  if [ ! -f "$file" ]; then echo ""; return; fi
  awk -F= -v k="$key" '$1 == k { sub(/^[^=]*=/,""); print; exit }' "$file"
}

# require_keys FILE TEMPLATE → fail for any KEY in TEMPLATE missing from FILE
require_keys() {
  local file="$1" template="$2"
  local missing=()
  if [ ! -f "$template" ]; then
    fail "$template missing"
    return
  fi
  while IFS= read -r line; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ -z "$line" ]] && continue
    local key="${line%%=*}"
    [ -z "$key" ] && continue
    if ! grep -q "^${key}=" "$file" 2>/dev/null; then
      missing+=("$key")
    fi
  done < "$template"
  if [ "${#missing[@]}" -eq 0 ]; then
    ok "$file declares all keys from $template"
  else
    fail "$file missing keys: ${missing[*]}"
  fi
}

echo "=== preflight ==="
echo "repo: $REPO_ROOT"
echo

# --- 1. env files exist ---
echo "[1] env files"
[ -f "$REPO_ROOT/.env" ] && ok "root .env exists" || fail "root .env missing (cp .env.example .env)"
[ -f "$REPO_ROOT/web/.env" ] && ok "web/.env exists" || fail "web/.env missing (cp web/.env.example web/.env)"

# --- 2. env templates exist + all keys declared in actual env ---
echo
echo "[2] env templates"
[ -f "$REPO_ROOT/.env.example" ] && ok "root .env.example exists" || fail "root .env.example missing"
[ -f "$REPO_ROOT/web/.env.example" ] && ok "web/.env.example exists" || fail "web/.env.example missing"
require_keys "$REPO_ROOT/.env" "$REPO_ROOT/.env.example"
require_keys "$REPO_ROOT/web/.env" "$REPO_ROOT/web/.env.example"

# --- 3. .gitignore covers secrets and state ---
echo
echo "[3] .gitignore coverage"
for path in .env web/.env data/ backups/; do
  if git check-ignore "$path" >/dev/null 2>&1 || \
     git status --ignored --porcelain 2>/dev/null | grep -qE "^!! ${path%/}/?$"; then
    ok "$path is gitignored"
  else
    fail "$path is NOT gitignored — fix .gitignore before pushing"
  fi
done

# --- 4. deploy-key warnings ---
echo
echo "[4] deploy config"
if [ -z "$(get_env_value "$REPO_ROOT/.env" APP_API_KEY)" ]; then
  warn "APP_API_KEY is empty — backend API will be open to anyone reachable on the network"
else
  ok "APP_API_KEY is set"
fi
if [ -z "$(get_env_value "$REPO_ROOT/web/.env" WEB_PASSWORD)" ]; then
  warn "WEB_PASSWORD is empty — dashboard UI will be public"
else
  ok "WEB_PASSWORD is set"
fi
BACKEND_KEY="$(get_env_value "$REPO_ROOT/.env" APP_API_KEY)"
WEB_BACKEND_KEY="$(get_env_value "$REPO_ROOT/web/.env" BACKEND_APP_API_KEY)"
if [ -n "$BACKEND_KEY" ] && [ "$BACKEND_KEY" != "$WEB_BACKEND_KEY" ]; then
  warn "APP_API_KEY (.env) does not match BACKEND_APP_API_KEY (web/.env) — frontend will get 401s"
fi

# --- 5. builds ---
echo
echo "[5] builds"
if (cd "$REPO_ROOT" && npm run build >/tmp/preflight-build-root.log 2>&1); then
  ok "npm run build (root) succeeded"
else
  fail "npm run build (root) failed — see /tmp/preflight-build-root.log"
  tail -n 20 /tmp/preflight-build-root.log | sed 's/^/    /'
fi
if (cd "$REPO_ROOT/web" && npm run build >/tmp/preflight-build-web.log 2>&1); then
  ok "npm run build (web) succeeded"
else
  fail "npm run build (web) failed — see /tmp/preflight-build-web.log"
  tail -n 20 /tmp/preflight-build-web.log | sed 's/^/    /'
fi

# --- 6. smoke test ---
echo
echo "[6] smoke test"
SMOKE_BASE_URL="${BASE_URL:-http://localhost:3002}"
if BASE_URL="$SMOKE_BASE_URL" "$SCRIPT_DIR/smoke-test.sh" >/tmp/preflight-smoke.log 2>&1; then
  ok "smoke test passed against $SMOKE_BASE_URL"
else
  fail "smoke test failed against $SMOKE_BASE_URL — see /tmp/preflight-smoke.log"
  tail -n 20 /tmp/preflight-smoke.log | sed 's/^/    /'
fi

echo
echo "=== Result: $PASS passed, $WARN warnings, $FAIL failures ==="
[ "$FAIL" -eq 0 ]
