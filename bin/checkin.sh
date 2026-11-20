#!/bin/bash
# Утренний отчёт /checkin. См. bin/checkin.mjs.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$("$ROOT/bin/node.sh" --which)"
exec "$NODE" "$ROOT/bin/checkin.mjs" "$@"
