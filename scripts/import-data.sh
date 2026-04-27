#!/usr/bin/env bash
# Restore wallet-checker state files from a backup created by export-data.sh.
# Usage: ./scripts/import-data.sh <backup-file>
# Before extracting, current data/ is snapshotted to backups/pre-import-<timestamp>.tar.gz.

set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <backup-file>" >&2
  echo "Available backups:" >&2
  ls -1t backups/*.tar.gz 2>/dev/null | head -10 >&2 || echo "  (none)" >&2
  exit 1
fi

BACKUP="$1"
if [ ! -f "$BACKUP" ]; then
  echo "Backup file not found: $BACKUP" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="$REPO_ROOT/data"
BACKUPS_DIR="$REPO_ROOT/backups"
TS="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$DATA_DIR" "$BACKUPS_DIR"

# Snapshot current state first so import is reversible.
SNAPSHOT_FILES=()
for name in groups.json alerts.json alert-sent.json; do
  if [ -f "$DATA_DIR/$name" ]; then
    SNAPSHOT_FILES+=("data/$name")
  fi
done
if [ "${#SNAPSHOT_FILES[@]}" -gt 0 ]; then
  SNAPSHOT="$BACKUPS_DIR/pre-import-$TS.tar.gz"
  tar -C "$REPO_ROOT" -czf "$SNAPSHOT" "${SNAPSHOT_FILES[@]}"
  echo "Pre-import snapshot: $SNAPSHOT"
fi

echo "Restoring from: $BACKUP"
tar -C "$REPO_ROOT" -xzf "$BACKUP"

echo
echo "Restored files:"
tar -tzf "$BACKUP"
