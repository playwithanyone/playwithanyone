#!/usr/bin/env bash
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ "$#" -gt 1 || ( "${1:-}" != '' && "${1:-}" != '--dry-run' && "${1:-}" != '--print-config' ) ]]; then
  echo 'Usage: bash scripts/remote-sync.sh [--dry-run|--print-config]' >&2
  exit 2
fi
REMOTE_SETTINGS="$(node --input-type=module - "$PROJECT_ROOT" <<'JS'
import { readFile } from 'node:fs/promises';
import path from 'node:path';
try {
  let local = {};
  if (!process.env.PWA_REMOTE_HOST || !process.env.PWA_REMOTE_DIR) {
    try { local = JSON.parse(await readFile(path.join(process.argv[2], 'configs/remote.local.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('REMOTE_CONFIG_INVALID'); }
    if (Object.keys(local).length && (local.schemaVersion !== 1 || Object.keys(local).some(key => !['schemaVersion', 'host', 'directory'].includes(key)))) throw new Error('REMOTE_CONFIG_INVALID');
  }
  const host = process.env.PWA_REMOTE_HOST || local.host;
  const directory = process.env.PWA_REMOTE_DIR || local.directory;
  if (typeof host !== 'string' || typeof directory !== 'string') throw new Error('REMOTE_CONFIG_REQUIRED: set PWA_REMOTE_HOST/PWA_REMOTE_DIR or create ignored configs/remote.local.json from configs/remote.example.json');
  // SSH aliases, DNS names and optional user@host are accepted; flags, shell
  // metacharacters and whitespace are not. Use an SSH alias for IPv6/ports.
  if (!/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}@)?[A-Za-z0-9][A-Za-z0-9_.-]{0,252}$/.test(host)) throw new Error('REMOTE_HOST_INVALID');
  // A conservative path alphabet makes both the SSH command and rsync's
  // remote path safe without eval or remote-shell interpolation.
  if (!/^\/[A-Za-z0-9._/-]+$/.test(directory) || directory.endsWith('/') || directory.includes('//')) throw new Error('REMOTE_DIRECTORY_INVALID');
  const segments = directory.split('/').slice(1);
  if (segments.length < 2 || segments.some(item => item === '.' || item === '..') || (['Users', 'home'].includes(segments[0]) && segments.length < 3)) throw new Error('REMOTE_PROJECT_DIRECTORY_REQUIRED');
  console.log(host + '\n' + directory);
} catch (error) {
  console.error(error.message.startsWith('REMOTE_') ? error.message : 'REMOTE_CONFIG_INVALID');
  process.exitCode = 2;
}
JS
)"
REMOTE_HOST="${REMOTE_SETTINGS%%$'\n'*}"
REMOTE_DIR="${REMOTE_SETTINGS#*$'\n'}"
if [[ "${1:-}" == '--print-config' ]]; then
  printf '%s\n%s\n' "$REMOTE_HOST" "$REMOTE_DIR"
  exit 0
fi
ssh -o BatchMode=yes -o ConnectTimeout=8 "$REMOTE_HOST" "mkdir -p '$REMOTE_DIR'"
RSYNC_FLAGS=(-az --itemize-changes --stats --include='.env.example' --include='.dev.vars.example' --exclude-from="$PROJECT_ROOT/.remote-sync.exclude")
if [[ "${1:-}" == '--dry-run' ]]; then RSYNC_FLAGS+=(--dry-run); fi
# Deliberately omit --delete to protect remote caches and task output.
rsync "${RSYNC_FLAGS[@]}" -e 'ssh -o BatchMode=yes -o ConnectTimeout=8' "$PROJECT_ROOT/" "$REMOTE_HOST:$REMOTE_DIR/"
