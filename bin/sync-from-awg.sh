#!/usr/bin/env bash
#
# Перенести набор в текущий проект из проекта-источника — или проверить, что копии совпадают.
#
#   bin/sync-from-awg.sh              # скопировать набор из источника
#   bin/sync-from-awg.sh --check      # только сверить и сказать, что разошлось
#   bin/sync-from-awg.sh --from DIR   # другой источник (по умолчанию ~/projects/awg)
#
# Источник набора — awg: скрипты, скилы, пресеты и плагин правятся там, оттуда
# переносятся в проекты, где живёт доска. Карточки не переносятся: у каждого
# проекта они свои, поэтому из `.kanban/tasks` синхронизируется только README.
#
# `--check` встроен в `bin/test.sh`: расхождение копий видно сразу, а не «когда
# вспомним». Если источника нет (чужое окружение), проверка считается пройденной.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FROM="${DSH_KANBAN_SOURCE:-$HOME/projects/awg}"
CHECK=0

# Что считается набором. Пути — от корня проекта.
PATHS=(bin .agents agent-presets presets dsh-kanban test AGENTS.md KANBAN.md .kanban/tasks/README.md)

usage() {
  sed -n '3,/^set -euo pipefail/p' "$0" | sed -e 's/^# \{0,1\}//' -e '$d'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) CHECK=1; shift ;;
    --from) FROM="${2:?--from требует значения}"; shift 2 ;;
    --from=*) FROM="${1#*=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "неизвестная опция: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ ! -d "$FROM" ]]; then
  echo "источник набора не найден: $FROM — пропускаю"
  exit 0
fi

from_physical="$(cd "$FROM" && pwd -P)"
root_physical="$(cd "$ROOT" && pwd -P)"
if [[ "$from_physical" == "$root_physical" ]]; then
  echo "источник и текущий проект — один каталог: $FROM"
  exit 0
fi

diverged=""
for path in "${PATHS[@]}"; do
  if [[ ! -e "$FROM/$path" ]]; then
    continue
  fi
  if (( CHECK == 1 )); then
    if [[ -d "$FROM/$path" ]]; then
      [[ -d "$ROOT/$path" ]] && diff -rq "$FROM/$path" "$ROOT/$path" >/dev/null 2>&1 || diverged="$diverged $path"
    else
      cmp -s "$FROM/$path" "$ROOT/$path" || diverged="$diverged $path"
    fi
  elif [[ -d "$FROM/$path" ]]; then
    mkdir -p "$ROOT/$path"
    # rsync убирает и то, что удалили в источнике; если его нет — просто копируем.
    rsync -a --delete "$FROM/$path/" "$ROOT/$path/" 2>/dev/null || cp -R "$FROM/$path/." "$ROOT/$path/"
  else
    cp -p "$FROM/$path" "$ROOT/$path"
  fi
done

if (( CHECK == 1 )); then
  if [[ -n "$diverged" ]]; then
    echo "набор расходится с источником $FROM:" >&2
    for path in $diverged; do
      echo "  $path" >&2
    done
    echo "перенесите правки: bin/sync-from-awg.sh" >&2
    exit 1
  fi
  echo "набор совпадает с источником: $FROM"
  exit 0
fi

echo "набор перенесён из $FROM"
