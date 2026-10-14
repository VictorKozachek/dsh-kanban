#!/usr/bin/env bash
#
# Перенести набор в текущий проект из проекта-источника — или проверить, что копии совпадают.
#
#   bin/sync-from-awg.sh              # скопировать набор из источника
#   bin/sync-from-awg.sh --check      # только сверить и сказать, что разошлось
#   bin/sync-from-awg.sh --from DIR   # другой источник (по умолчанию ~/projects/awg)
#
# Лишнее в приёмнике убирает rsync (--delete). Если rsync нет, скрипт предупреждает
# и копирует без удаления: перенос остаётся безопасным, но приёмник может сохранить
# файлы, которых в источнике уже нет.
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
    --from)
      if (( $# < 2 )) || [[ -z "$2" ]]; then
        echo "--from требует значения: --from DIR (по умолчанию ~/projects/awg)" >&2
        exit 2
      fi
      FROM="$2"; shift 2 ;;
    --from=*)
      FROM="${1#*=}"
      if [[ -z "$FROM" ]]; then
        echo "--from требует значения: --from DIR (по умолчанию ~/projects/awg)" >&2
        exit 2
      fi
      shift ;;
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
    # rsync убирает и то, что удалили в источнике. Если он не справился — это отказ,
    # а не повод тихо скопировать без удалений: расхождение осталось бы незамеченным.
    if command -v rsync >/dev/null 2>&1; then
      if ! rsync -a --delete "$FROM/$path/" "$ROOT/$path/"; then
        echo "rsync не справился с $path: перенос прерван" >&2
        exit 1
      fi
    else
      echo "предупреждение: rsync не найден — копирую $path без удаления лишнего" >&2
      cp -R "$FROM/$path/." "$ROOT/$path/"
    fi
  else
    # Файл может лежать в каталоге, которого в приёмнике ещё нет.
    mkdir -p "$(dirname "$ROOT/$path")"
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
