#!/usr/bin/env bash
#
# Пополнить `todo` из `backlog`: выдать нарезанные задачи свободным исполнителям.
#
#   bin/backlog-fill.sh              # выдать, пока todo не доберёт до minTodo
#   bin/backlog-fill.sh --dry-run    # показать план, ничего не меняя
#   bin/backlog-fill.sh --min N      # переопределить минимум на этот запуск
#
# Запускает оркестратор (полуавтомат: «задачу выдаёт оркестратор», см. AGENTS.md).
#
# Конфиг минимума — `.kanban/board.json` (tracked): `{ "minTodo": 2 }`. Файла нет —
# минимум 1; битый JSON или нечисловое значение — внятная ошибка и код 1.
#
# Пул исполнителей — `.kanban/.workers.json` (в `.gitignore`): упорядоченный
# массив id сессий, порядок = приоритет выдачи. Файла нет — берётся `worker` из
# `.kanban/.watcher-roles.json`. Свободен тот, у кого нет карточки `in-progress`;
# только что выданная в этом прогоне задача тоже считается занятостью — иначе
# обе карточки уехали бы первому исполнителю.
#
# Карточки берутся из `backlog` по возрастанию id (FIFO) и выдаются переходом
# `backlog → todo --owner <id>` через `bin/task-move.sh`: правила протокола
# остаются в одном месте.
#
# Коды возврата: 0 — ок (в том числе «пополнять нечего»); 1 — ошибка конфига или
# доски; 3 — выдать не удалось: backlog пуст или нет свободных исполнителей.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TASKS_DIR="$ROOT/.kanban/tasks"
BOARD_FILE="$ROOT/.kanban/board.json"
WORKERS_FILE="$ROOT/.kanban/.workers.json"
ROLES_FILE="$ROOT/.kanban/.watcher-roles.json"
DEFAULT_MIN_TODO=1

usage() {
  cat <<'EOF'
Использование:
  bin/backlog-fill.sh [--dry-run] [--min N]

Выдаёт карточки из backlog в todo, пока в todo не наберётся минимум (minTodo из
.kanban/board.json, по умолчанию 1), закрепляя их за свободными исполнителями из
.kanban/.workers.json (fallback — worker из .kanban/.watcher-roles.json).

  --dry-run   показать план и ничего не менять
  --min N     минимум на этот запуск

Коды возврата: 0 — ок (включая «пополнять нечего»); 1 — ошибка конфига/доски;
3 — выдать не удалось (backlog пуст или нет свободных исполнителей). --dry-run
возвращает те же коды, что и обычный запуск: по нему видно, чем кончилось бы дело.
EOF
}

DRY_RUN=0
MIN_OVERRIDE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --min)
      if (( $# < 2 )) || [[ -z "${2:-}" ]]; then
        echo "--min требует значения: --min N" >&2
        exit 2
      fi
      MIN_OVERRIDE="$2"; shift 2 ;;
    --min=*) MIN_OVERRIDE="${1#*=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "неизвестный аргумент: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# Значение поля front matter карточки (первый блок между `---`).
card_field() {
  awk -v key="$2" '
    NR == 1 && $0 == "---" { infm = 1; next }
    infm == 1 && $0 == "---" { exit }
    infm == 1 && index($0, key ":") == 1 {
      sub("^" key ":[[:space:]]*", "");
      gsub(/^"|"$/, "");
      sub(/[[:space:]]+$/, "");
      print;
      exit
    }' "$1"
}

# Статус карточки в том же виде, в каком его понимает доска: без регистра,
# кавычек и лишних пробелов.
card_status() {
  card_field "$1" status | tr '[:upper:]' '[:lower:]' | tr -s ' ' '-'
}

die_config() {
  echo "$*" >&2
  exit 1
}

# Минимум карточек в todo: аргумент, board.json или значение по умолчанию.
read_min_todo() {
  local value="$1"
  if [[ -z "$value" ]]; then
    if [[ ! -f "$BOARD_FILE" ]]; then
      printf '%s' "$DEFAULT_MIN_TODO"
      return 0
    fi
    local body
    body="$(tr -d '[:space:]' < "$BOARD_FILE" 2>/dev/null || true)"
    case "$body" in
      \{*\}) ;;
      *) die_config "битый JSON в $BOARD_FILE: ожидался объект { \"minTodo\": <число> }" ;;
    esac
    value="$(printf '%s' "$body" | sed -n 's/.*"minTodo"[[:space:]]*:[[:space:]]*\([^,}]*\).*/\1/p')"
    if [[ -z "$value" ]]; then
      die_config "в $BOARD_FILE нет целого minTodo: ожидалось { \"minTodo\": <число> }"
    fi
  fi
  if [[ ! "$value" =~ ^[0-9]+$ ]]; then
    die_config "минимум должен быть целым неотрицательным числом: $value"
  fi
  printf '%s' "$((10#$value))"
}

# Пул исполнителей: .workers.json, иначе единственный worker из .watcher-roles.json.
WORKERS=()
read_workers() {
  if [[ -f "$WORKERS_FILE" ]]; then
    local body rest id
    body="$(tr -d '[:space:]' < "$WORKERS_FILE" 2>/dev/null || true)"
    case "$body" in
      \[*\]) ;;
      *) die_config "битый JSON в $WORKERS_FILE: ожидался массив [\"session-id\", ...]" ;;
    esac
    # Кроме строк с id в массиве ничего быть не должно: после вырезания строк
    # остаются только скобки и запятые.
    rest="$(printf '%s' "$body" | sed 's/"[^"]*"//g')"
    if [[ ! "$rest" =~ ^\[,*\]$ ]]; then
      die_config "битый JSON в $WORKERS_FILE: элементы массива — строки в кавычках"
    fi
    while IFS= read -r id; do
      [[ -n "$id" ]] && WORKERS+=("$id")
    done < <(printf '%s' "$body" | grep -o '"[^"]*"' | tr -d '"' || true)
    return 0
  fi
  if [[ -f "$ROLES_FILE" ]]; then
    local worker
    worker="$(sed -n 's/.*"worker"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROLES_FILE" | head -1)"
    if [[ -n "$worker" ]]; then
      WORKERS+=("$worker")
    fi
  fi
}

# Занят ли исполнитель: у него есть карточка в работе.
worker_busy() {
  local who="$1" file
  for file in "$TASKS_DIR"/[0-9]*.md; do
    [[ -e "$file" ]] || continue
    [[ "$(card_status "$file")" == "in-progress" ]] || continue
    [[ "$(card_field "$file" owner)" == "$who" ]] && return 0
  done
  return 1
}

count_status() {
  local want="$1" file count=0
  for file in "$TASKS_DIR"/[0-9]*.md; do
    [[ -e "$file" ]] || continue
    [[ "$(card_status "$file")" == "$want" ]] && count=$((count + 1))
  done
  printf '%s' "$count"
}

if [[ ! -d "$TASKS_DIR" ]]; then
  die_config "нет каталога карточек: $TASKS_DIR"
fi

MIN="$(read_min_todo "$MIN_OVERRIDE")"
read_workers

todo_now="$(count_status todo)"
if (( todo_now >= MIN )); then
  echo "todo: $todo_now, минимум $MIN — пополнять нечего"
  exit 0
fi

need=$((MIN - todo_now))
assigned=0
why=""
taken=" "
ids=""
owners=""

# Один проход по backlog в порядке возрастания id (FIFO): глоб сортирует имена
# файлов, а они у задач — `%03d.md`.
for file in "$TASKS_DIR"/[0-9]*.md; do
  [[ -e "$file" ]] || continue
  (( assigned < need )) || break
  [[ "$(card_status "$file")" == "backlog" ]] || continue

  id="$(card_field "$file" id)"
  [[ -n "$id" ]] || id="$(basename "$file" .md)"

  owner=""
  for candidate in ${WORKERS[@]+"${WORKERS[@]}"}; do
    case "$taken" in *" $candidate "*) continue ;; esac
    if ! worker_busy "$candidate"; then
      owner="$candidate"
      break
    fi
  done
  if [[ -z "$owner" ]]; then
    why="нет свободных исполнителей"
    break
  fi

  if (( DRY_RUN == 1 )); then
    echo "выдал бы #$id → $owner"
  else
    if ! "$ROOT/bin/task-move.sh" "$id" todo --owner "$owner" >/dev/null 2>&1; then
      why="bin/task-move.sh отказал в выдаче #$id"
      break
    fi
    echo "выдано: #$id → $owner"
  fi

  taken="$taken$owner "
  ids="$ids $id"
  owners="$owners $owner"
  assigned=$((assigned + 1))
done

if (( assigned == 0 )) && [[ -z "$why" ]]; then
  why="backlog пуст"
fi

final_todo=$((todo_now + assigned))
if (( DRY_RUN == 1 )); then
  echo "план: todo $todo_now → $final_todo (минимум $MIN), выдано $assigned из $need нужных"
else
  echo "итого: todo $todo_now → $final_todo (минимум $MIN), выдано $assigned из $need нужных"
fi
if [[ -n "$why" ]]; then
  echo "остановка: $why"
fi

if (( assigned < need )); then
  exit 3
fi
exit 0
