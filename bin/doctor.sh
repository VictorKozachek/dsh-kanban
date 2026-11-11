#!/bin/bash
# Проверка установки и первых шагов (см. bin/doctor.mjs).
#
#   bin/doctor.sh                  # текущий проект
#   bin/doctor.sh --project DIR    # другой проект
#   bin/doctor.sh --json           # машинный отчёт
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$("$ROOT/bin/node.sh" --which)"
exec "$NODE" "$ROOT/bin/doctor.mjs" "$@"
