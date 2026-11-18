#!/bin/bash
# Синхронизация доски с kanban-hub (см. bin/kanban-sync.mjs).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$("$ROOT/bin/node.sh" --which)"
exec "$NODE" "$ROOT/bin/kanban-sync.mjs" "$@"
