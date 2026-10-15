#!/usr/bin/env bash
#
# Перенести набор в текущий проект из проекта-источника — или проверить, что копии совпадают.
#
#   bin/sync-from-awg.sh              # скопировать набор из источника
#   bin/sync-from-awg.sh --check      # только сверить и сказать, что разошлось
#
# Сверка сравнивает приёмник с зафиксированным состоянием источника (HEAD), поэтому
# незакоммиченная работа в источнике не выглядит расхождением набора — о ней сообщается
# отдельной строкой. Перенос по-прежнему копирует рабочее дерево источника.
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
      if [[ "$2" == -* ]]; then
        echo "--from: значение начинается с «-» — похоже, путь забыт." >&2
        echo "если путь правда начинается с дефиса, пишите --from=ПУТЬ" >&2
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

# Сверяемся с зафиксированным состоянием источника: незакоммиченная работа другой
# сессии — это процесс, а не расхождение набора (её ловили в #027 и #030). Перенос
# по-прежнему берёт рабочее дерево: он и нужен, чтобы забрать текущее содержимое.
compare_from="$FROM"
source_dirty=""
if (( CHECK == 1 )) && git -C "$FROM" rev-parse --git-dir >/dev/null 2>&1; then
  committed="$(mktemp -d)"
  trap 'rm -rf "$committed"' EXIT
  # Берём только те пути, что есть в HEAD: у набора бывают частичные копии.
  in_head=()
  for path in "${PATHS[@]}"; do
    if git -C "$FROM" cat-file -e "HEAD:$path" 2>/dev/null; then
      in_head+=("$path")
    fi
  done
  if (( ${#in_head[@]} > 0 )) && git -C "$FROM" archive HEAD -- "${in_head[@]}" 2>/dev/null | tar -x -C "$committed" 2>/dev/null; then
    compare_from="$committed"
    dirty_count="$(git -C "$FROM" status --porcelain -- "${PATHS[@]}" 2>/dev/null | wc -l | tr -d ' ')"
    if [[ "$dirty_count" != "0" ]]; then
      source_dirty="$dirty_count"
    fi
  else
    echo "предупреждение: не прочитал зафиксированное состояние источника — сверяю рабочее дерево" >&2
  fi
fi

diverged=""
for path in "${PATHS[@]}"; do
  if [[ ! -e "$compare_from/$path" ]]; then
    continue
  fi
  if (( CHECK == 1 )); then
    if [[ -d "$compare_from/$path" ]]; then
      [[ -d "$ROOT/$path" ]] && diff -rq "$compare_from/$path" "$ROOT/$path" >/dev/null 2>&1 || diverged="$diverged $path"
    else
      cmp -s "$compare_from/$path" "$ROOT/$path" || diverged="$diverged $path"
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
  if [[ -n "$source_dirty" ]]; then
    echo "набор совпадает с источником $FROM (сверялось зафиксированное состояние)"
    echo "  у источника $source_dirty незакоммиченных путей — это работа в процессе, не расхождение"
  else
    echo "набор совпадает с источником: $FROM"
  fi
  exit 0
fi

echo "набор перенесён из $FROM"
