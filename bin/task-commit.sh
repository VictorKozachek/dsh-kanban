#!/usr/bin/env bash
#
# Закоммитить готовую задачу в основную ветку — единственный путь в статус merged.
#
# Мержит только оркестратор, и только через этот скрипт: task-move.sh переход
# ready → merged не разрешает. Сообщение коммита собирается по правилу проекта
# (скил commit, .agents/skills/commit/SKILL.md):
#
#   [{SHORT_BRANCH_NAME}] Message
#
# Короткое имя берётся из ветки задачи: ключ трекера, если он есть в имени
# (release/NJ-001 → NJ-001), иначе последний сегмент (task/007 → 007).
#
# Пуш не делает никто из агентов: git push — ручная операция человека, когда все
# задачи готовы и закоммичены. Скрипт только мержит и коммитит локально.
#
# Использование:
#   bin/task-commit.sh <id> [--message ТЕКСТ] [--branch ВЕТКА] [--dry-run]
#   bin/task-commit.sh <id> --no-merge --reason "почему слияния нет" [--dry-run]
#
# Режим --no-merge — для задачи, работа по которой уже в основной ветке (например,
# инфраструктура набора: правки шли прямо в main, ветки task/<id> не было). Он
# закрывает карточку в merged БЕЗ слияния, но требует причину: она пишется в
# карточку, чтобы «закрыто без слияния» нельзя было сделать молча. Если ветка
# задачи существует, режим отказывает: это обычное слияние.
#
# Запускается из ОСНОВНОГО чекаута: слияние ветки задачи делается там.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  # Весь заголовочный комментарий, кроме shebang и строки `set -euo pipefail`.
  sed -n '3,/^set -euo pipefail/p' "$0" | sed -e 's/^# \{0,1\}//' -e '$d'
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then usage; exit 0; fi
if [[ $# -lt 1 ]]; then usage >&2; exit 2; fi

id="${1#\#}"; shift
MESSAGE=""; BRANCH=""; DRY_RUN=0; NO_MERGE=0; REASON=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --message) MESSAGE="${2:?--message требует значения}"; shift 2 ;;
    --message=*) MESSAGE="${1#*=}"; shift ;;
    --branch) BRANCH="${2:?--branch требует значения}"; shift 2 ;;
    --branch=*) BRANCH="${1#*=}"; shift ;;
    --no-merge) NO_MERGE=1; shift ;;
    --reason) REASON="${2:?--reason требует значения}"; shift 2 ;;
    --reason=*) REASON="${1#*=}"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "неизвестная опция: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if ! git -C "$ROOT" rev-parse --show-toplevel >/dev/null 2>&1; then
  echo "не git-репозиторий: коммитить нечего" >&2
  exit 1
fi

# Основной чекаут — ПЕРВАЯ запись `git worktree list`; из рабочего дерева задачи
# rev-parse --show-toplevel вернёт само это дерево, и мержить было бы некуда.
main_root="$(git -C "$ROOT" worktree list --porcelain | awk '/^worktree /{print $2; exit}')"
root_physical="$(cd "$ROOT" 2>/dev/null && pwd -P || printf '%s' "$ROOT")"
main_physical="$(cd "$main_root" 2>/dev/null && pwd -P || printf '%s' "$main_root")"
if [[ -z "$main_root" || "$root_physical" != "$main_physical" ]]; then
  cat >&2 <<'MSG'
task-commit.sh запускается только из ОСНОВНОГО чекаута: он мержит ветку задачи в
основную ветку проекта. Из рабочего дерева задачи это делать нельзя.

  cd "$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')"
  bin/task-commit.sh <id>
MSG
  exit 1
fi

[[ -n "$BRANCH" ]] || BRANCH="task/$id"

# Рабочее дерево задачи по её ветке — в нём карточка и живёт до слияния.
worktree_for_branch() {
  local want="$1" wt="" br=""
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      worktree\ *) wt="${line#worktree }" ;;
      branch\ *)
        br="${line#branch }"
        if [[ "$br" == "refs/heads/$want" ]]; then printf '%s' "$wt"; return 0; fi
        ;;
    esac
  done < <(git -C "$ROOT" worktree list --porcelain)
  return 0
}

# Карточка открытой задачи живёт в ветке задачи, а не в основном чекауте: читаем
# сначала рабочее дерево, потом ветку, и только потом основной каталог.
read_card() {
  local path
  for path in \
    "$ROOT/${KANBAN_WORKTREES_DIR:-worktrees}/$id/.kanban/tasks/$id.md" \
    "$(worktree_for_branch "$BRANCH")/.kanban/tasks/$id.md" \
    "$ROOT/.kanban/tasks/$id.md"; do
    if [[ -n "$path" && -f "$path" ]]; then cat "$path"; return 0; fi
  done
  git -C "$ROOT" show "$BRANCH:.kanban/tasks/$id.md" 2>/dev/null && return 0
  return 1
}

# Значение ключа из front matter (первый блок между `---`).
field_of() {
  local key="$1"
  awk -v key="$key" '
    NR == 1 && $0 == "---" { infm = 1; next }
    infm == 1 && $0 == "---" { exit }
    infm == 1 && index($0, key ":") == 1 {
      sub("^" key ":[[:space:]]*", "");
      gsub(/^"|"$/, "");
      print;
      exit
    }'
}

# Короткое имя ветки: ключ трекера, если он есть, иначе последний сегмент.
short_branch_name() {
  local branch="$1" key
  key="$(printf '%s' "$branch" | sed -n 's|.*[^A-Za-z0-9]\([A-Z][A-Z0-9]*-[0-9][0-9]*\).*|\1|p' | head -1)"
  if [[ -n "$key" ]]; then printf '%s' "$key"; else printf '%s' "${branch##*/}"; fi
}

card="$(read_card)" || {
  echo "карточка задачи $id не найдена ни в рабочем дереве, ни в ветке $BRANCH" >&2
  exit 1
}

# Ветка задачи: обычному режиму она нужна, режиму --no-merge — наоборот, мешает.
branch_exists() {
  git -C "$ROOT" show-ref --verify --quiet "refs/heads/$BRANCH" || [[ -n "$(worktree_for_branch "$BRANCH")" ]]
}

if (( NO_MERGE == 1 )); then
  if [[ -z "$REASON" ]]; then
    cat >&2 <<'MSG'
--no-merge требует --reason: режим закрывает карточку, работа по которой уже в
основной ветке, и причина нужна в карточке — иначе это молчаливый обход слияния.

  bin/task-commit.sh <id> --no-merge --reason "почему слияния нет"
MSG
    exit 2
  fi
  if branch_exists; then
    echo "ветка $BRANCH существует: это обычное слияние, а не «работа уже в main»" >&2
    echo "уберите --no-merge и слейте как обычно" >&2
    exit 1
  fi
elif ! branch_exists; then
  echo "ветки $BRANCH нет: сливать нечего" >&2
  echo "если работа по задаче уже в основной ветке, закройте карточку так:" >&2
  echo "  bin/task-commit.sh $id --no-merge --reason \"почему слияния нет\"" >&2
  exit 1
fi

main_card="$ROOT/.kanban/tasks/$id.md"
if [[ -f "$main_card" ]] && [[ "$(field_of status < "$main_card")" == "merged" ]]; then
  echo "задача $id уже влита (карточка в основном чекауте в статусе merged)" >&2
  exit 1
fi

current="$(printf '%s\n' "$card" | field_of status)"
if [[ "$current" != "ready" ]]; then
  echo "задача $id не в статусе ready, а в «${current:-<пусто>}»: сливать нечего" >&2
  echo "коммит делает оркестратор после того, как тестировщик перевёл карточку в ready" >&2
  exit 1
fi

if [[ -z "$MESSAGE" ]]; then
  MESSAGE="$(printf '%s\n' "$card" | field_of title)"
fi
if [[ -z "$MESSAGE" ]]; then
  echo "не удалось взять сообщение из карточки: передайте --message" >&2
  exit 1
fi
# Сообщение коммита — одна строка.
MESSAGE="$(printf '%s' "$MESSAGE" | tr '\n' ' ' | sed -e 's/[[:space:]]\{1,\}/ /g' -e 's/^ //' -e 's/ $//')"

short="$(short_branch_name "$BRANCH")"
subject="[$short] $MESSAGE"
body="Card: $id (kanban, branch $BRANCH)"
target="$(git -C "$ROOT" symbolic-ref --short -q HEAD || echo main)"

if (( DRY_RUN == 1 )); then
  echo "ветка задачи: $BRANCH"
  if (( NO_MERGE == 1 )); then
    echo "режим: --no-merge, слияния не будет (ветки нет)"
    echo "причина: $REASON"
  else
    echo "режим: слияние в $target"
  fi
  echo "короткое имя: $short"
  echo "целевая ветка: $target"
  echo "сообщение коммита:"
  echo "  $subject"
  echo "  $body"
  exit 0
fi

if (( NO_MERGE == 0 )) && [[ -n "$(git -C "$ROOT" status --porcelain)" ]]; then
  echo "рабочий каталог не чист: слияние может запутаться. Закоммитьте или уберите изменения:" >&2
  git -C "$ROOT" status --short >&2
  exit 1
fi

if (( NO_MERGE == 0 )) && ! git -C "$ROOT" merge --no-ff "$BRANCH" -m "$subject" -m "$body"; then
  echo "слияние не прошло: развязывайте конфликт вручную, карточка осталась в ready" >&2
  exit 1
fi

# Статус карточки меняется после слияния: карточка уже в основной ветке, и
# task-move.sh коммитит только её. --force здесь штатный: переход ready → merged
# разрешён ровно одному вызывающему — этому скрипту.
move_args=("$id" merged --role dispatcher --force)
if (( NO_MERGE == 1 )); then
  move_args+=(--note "закрыто без слияния: $REASON")
fi
if ! "$ROOT/bin/task-move.sh" "${move_args[@]}"; then
  echo "статус merged не записан: поставьте его вручную" >&2
  exit 1
fi

echo
if (( NO_MERGE == 1 )); then
  echo "задача $id закрыта без слияния: $REASON"
  echo "ветки $BRANCH не было — в основную ветку ничего не вливалось, коммита нет."
else
  echo "задача $id: $subject"
  echo "пуш делает человек, когда все задачи готовы и закоммичены:"
  echo "  git push <remote> $target"
fi
