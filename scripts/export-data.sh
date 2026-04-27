#!/usr/bin/env bash
# Export wallet-checker state files to a timestamped tarball.
# Usage: ./scripts/export-data.sh
# Output: backups/wallet-checker-<YYYYMMDD-HHMMSS>.tar.gz

set -euo pipefail

# Resolve repo root from this script's location so it works from any cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DATA_DIR="$REPO_ROOT/data"
BACKUPS_DIR="$REPO_ROOT/backups"
TS="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUPS_DIR/wallet-checker-$TS.tar.gz"

mkdir -p "$BACKUPS_DIR"

FILES=()
for name in groups.json alerts.json alert-sent.json; do
  if [ -f "$DATA_DIR/$name" ]; then
    FILES+=("data/$name")
  fi
done

if [ "${#FILES[@]}" -eq 0 ]; then
  echo "No data files found in $DATA_DIR — nothing to export." >&2
  exit 1
fi

echo "Including:"
for f in "${FILES[@]}"; do
  echo "  $f"
done

tar -C "$REPO_ROOT" -czf "$OUT" "${FILES[@]}"

echo
echo "Wrote backup: $OUT"
echo "Size: $(du -h "$OUT" | awk '{print $1}')"
