#!/bin/bash
# Вечерний /checkout. См. bin/checkout.mjs.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$("$ROOT/bin/node.sh" --which)"
exec "$NODE" "$ROOT/bin/checkout.mjs" "$@"
