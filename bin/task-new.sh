#!/usr/bin/env bash
#
# Завести задачу: worktree + ветка + карточка ВНУТРИ ветки задачи.
#
# Worktree создаётся ВНУТРИ проекта (<проект>/worktrees/<id>), а не рядом с ним:
# песочница сессии разрешает запись только в свою рабочую директорию, поэтому
# соседний каталог агент создать не может — а заводить задачи должен именно агент.
#
# Каталог намеренно НЕ скрытый: его путь выбирают руками в диалоге выбора папки,
# а скрытые каталоги там не видны без системного сочетания клавиш. Переопределить
# имя можно переменной KANBAN_WORKTREES_DIR.
#
# Карточка коммитится в ветку `task/<id>` — иначе исполнитель в своём worktree её не
# увидит (запись за пределы рабочей директории запрещена песочницей сессии).
# В основной чекаут карточка попадает слиянием ветки.
#
# Использование:
#   bin/task-new.sh "Название задачи" [--owner ID] [--no-worktree]
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  sed -n '3,11p' "$0" | sed 's/^# \{0,1\}//'
}

TITLE=""
OWNER=""
WITH_WORKTREE=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-worktree) WITH_WORKTREE=0; shift ;;
    --owner) OWNER="${2:?--owner требует значения}"; shift 2 ;;
    --owner=*) OWNER="${1#*=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "неизвестная опция: $1" >&2; usage >&2; exit 2 ;;
    *)
      if [[ -z "$TITLE" ]]; then TITLE="$1"; else echo "лишний аргумент: $1" >&2; exit 2; fi
      shift
      ;;
  esac
done

if [[ -z "$TITLE" ]]; then
  echo "нужно название задачи" >&2
  usage >&2
  exit 2
fi

is_git() { git -C "$ROOT" rev-parse --show-toplevel >/dev/null 2>&1; }

# Следующий свободный номер: смотрим и основной чекаут, и уже созданные ветки.
next=1
for file in "$ROOT"/.kanban/tasks/[0-9]*.md; do
  [[ -e "$file" ]] || continue
  number="$(basename "$file" .md)"
  [[ "$number" =~ ^[0-9]+$ ]] || continue
  if (( 10#$number >= next )); then next=$(( 10#$number + 1 )); fi
done
if is_git; then
  while IFS= read -r branch; do
    number="${branch##*task/}"
    [[ "$number" =~ ^[0-9]+$ ]] || continue
    if (( 10#$number >= next )); then next=$(( 10#$number + 1 )); fi
  done < <(git -C "$ROOT" for-each-ref --format='%(refname:short)' 'refs/heads/task/*' 2>/dev/null || true)
fi

id="$(printf '%03d' "$next")"
branch="task/$id"
worktrees_dir_name="${KANBAN_WORKTREES_DIR:-worktrees}"
worktree="$ROOT/$worktrees_dir_name/$id"
stamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

write_card() {
  local path="$1" wt="$2" br="$3"
  mkdir -p "$(dirname "$path")"
  {
    printf -- '---\n'
    printf 'id: "%s"\n' "$id"
    printf 'title: "%s"\n' "${TITLE//\"/\\\"}"
    printf 'status: todo\n'
    if [[ -n "$OWNER" ]]; then printf 'owner: "%s"\n' "$OWNER"; else printf 'owner: ""\n'; fi
    printf 'role: ""\n'
    printf 'tokens: ""\n'
    printf 'since: ""\n'
    if [[ -n "$br" ]]; then printf 'branch: "%s"\n' "$br"; else printf 'branch: ""\n'; fi
    if [[ -n "$wt" ]]; then printf 'worktree: "%s"\n' "$wt"; else printf 'worktree: ""\n'; fi
    printf 'updated: "%s"\n' "$stamp"
    printf -- '---\n\n'
    printf '## Задача\n%s\n\n' "$TITLE"
    printf '## Критерии готовности\n- [ ] \n\n'
    printf '## Заметки\n'
  } > "$path"
}

# --- worktree ---------------------------------------------------------------
created_worktree=0
if (( WITH_WORKTREE == 1 )); then
  if ! is_git; then
    echo "предупреждение: $ROOT не git-репозиторий; создаю карточку в текущей директории" >&2
  elif ! git -C "$ROOT" rev-parse HEAD >/dev/null 2>&1; then
    echo "предупреждение: в репозитории нет ни одного коммита; создаю карточку в текущей директории" >&2
  elif [[ -e "$worktree" ]]; then
    echo "предупреждение: $worktree уже существует, worktree не создаю" >&2
  else
    base="$(git -C "$ROOT" symbolic-ref --short -q HEAD || echo main)"
    if git -C "$ROOT" worktree add -b "$branch" "$worktree" "$base" >/dev/null 2>&1; then
      created_worktree=1
    else
      echo "предупреждение: git worktree add не удался; создаю карточку в текущей директории" >&2
    fi
  fi
fi

if (( created_worktree == 1 )); then
  card="$worktree/.kanban/tasks/$id.md"
  write_card "$card" "$worktree" "$branch"
  committed=0
  if git -C "$worktree" add -- ".kanban/tasks/$id.md" >/dev/null 2>&1 &&
     git -C "$worktree" commit -q -m "kanban($id): постановка задачи" -- ".kanban/tasks/$id.md" >/dev/null 2>&1; then
    committed=1
  else
    echo "предупреждение: карточку не удалось закоммитить в ветку (нет git identity?)" >&2
    echo "             карточка всё равно видна исполнителю, но в слияние попадёт только после коммита" >&2
  fi
  echo "задача $id: $card"
  echo "worktree: $worktree (ветка $branch, карточка закоммичена: $([[ $committed -eq 1 ]] && echo да || echo нет))"
  echo
  echo "дальше:"
  echo "  1. в DSH Web добавьте Workspace «${worktree}» и создайте в нём сессию с пресетом worker"
  echo "  2. закрепите задачу за этой сессией: bin/task-move.sh $id todo --owner <session-id>"
  echo "  3. в сессии: bin/task-move.sh $id in-progress --owner \"\$DSH_SESSION_ID\" --role worker"
  echo "  4. доска сама читает карточки из $worktrees_dir_name/ — board-sync.sh нужен только для worktree вне проекта"
else
  card="$ROOT/.kanban/tasks/$id.md"
  if [[ -e "$card" ]]; then
    echo "карточка $card уже существует" >&2
    exit 1
  fi
  write_card "$card" "" ""
  echo "задача $id: $card"
  echo "worktree не создан: работайте в текущей рабочей директории"
fi
