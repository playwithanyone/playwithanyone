#!/usr/bin/env bash
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Resolve exactly the same validated target as the source synchronizer. This
# option reads only local configuration and never opens an SSH connection.
REMOTE_SETTINGS="$(bash "$PROJECT_ROOT/scripts/remote-sync.sh" --print-config)"
REMOTE_HOST="${REMOTE_SETTINGS%%$'\n'*}"
REMOTE_DIR="${REMOTE_SETTINGS#*$'\n'}"
PWA_REMOTE_HOST="$REMOTE_HOST" PWA_REMOTE_DIR="$REMOTE_DIR" bash "$PROJECT_ROOT/scripts/remote-sync.sh"
mkdir -p "$PROJECT_ROOT/artifacts/p1"
RUN_STATUS=0
# One build, serial test execution. No daemons, browser launches or system changes.
ssh -o BatchMode=yes -o ConnectTimeout=8 "$REMOTE_HOST" "cd '$REMOTE_DIR' && node scripts/install.mjs && npm run verify" > "$PROJECT_ROOT/artifacts/p1/remote-run.log" 2>&1 || RUN_STATUS=$?
cat "$PROJECT_ROOT/artifacts/p1/remote-run.log"
cp "$PROJECT_ROOT/artifacts/p1/remote-run.log" "$PROJECT_ROOT/artifacts/p1/remote-run-$(date -u +%Y%m%dT%H%M%SZ).log"
scp -q "$REMOTE_HOST:$REMOTE_DIR/artifacts/p1/latest.json" "$PROJECT_ROOT/artifacts/p1/latest.json" || RUN_STATUS=1
scp -q "$REMOTE_HOST:$REMOTE_DIR/artifacts/p1/latest.tap" "$PROJECT_ROOT/artifacts/p1/latest.tap" || RUN_STATUS=1
exit "$RUN_STATUS"
