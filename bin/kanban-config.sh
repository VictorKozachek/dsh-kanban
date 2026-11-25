#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec "$("$ROOT/bin/node.sh" --which)" "$ROOT/bin/kanban-config.mjs" "$@"
