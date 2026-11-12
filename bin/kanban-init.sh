#!/usr/bin/env bash
#
# Развернуть протокол доски в проекте: скопировать bin/, AGENTS.md и .kanban.
#
#   bin/kanban-init.sh <проект> [--force] [--print]
#
# Без --force существующие файлы не перезаписываются (идемпотентно).
# --print только показывает план, ничего не пишет.
#
# Что копируется: минимальный набор скриптов (задачи, доска, doctor), AGENTS.md,
# формат карточек, board.json, .gitignore-блок и dsh-kanban/lib/watcher-core.js
# (его использует bin/board-status). Плагин и пресеты остаются глобальными —
# их ставит bin/install-kanban.sh.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET=""
FORCE=0
PRINT=0

usage() {
  sed -n '3,/^set -euo pipefail/p' "$0" | sed -e 's/^# \{0,1\}//' -e '$d'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    --print|--dry-run) PRINT=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "неизвестная опция: $1" >&2; usage >&2; exit 2 ;;
    *)
      if [[ -z "$TARGET" ]]; then TARGET="$1"; else echo "лишний аргумент: $1" >&2; exit 2; fi
      shift
      ;;
  esac
done

if [[ -z "$TARGET" ]]; then
  echo "укажите проект: bin/kanban-init.sh <путь>" >&2
  usage >&2
  exit 2
fi
TARGET="$(cd "$TARGET" 2>/dev/null && pwd || true)"
if [[ -z "$TARGET" || ! -d "$TARGET" ]]; then
  echo "нет такого каталога: $1" >&2
  exit 1
fi

BIN_FILES=(
  task-new.sh task-move.sh task-assign.sh task-commit.sh spec-new.sh
  backlog-fill.sh board-sync.sh board-children.sh board-status.sh board-status.mjs
  node.sh doctor.sh doctor.mjs
)

copied=0
skipped=0
copy_file() {
  local src="$1" dst="$2"
  if [[ ! -f "$src" ]]; then
    echo "нет исходника: $src" >&2
    exit 1
  fi
  if [[ -f "$dst" && $FORCE -eq 0 ]]; then
    skipped=$((skipped + 1))
    return 0
  fi
  if [[ $PRINT -eq 1 ]]; then
    echo "  + ${dst#"$TARGET"/}"
  else
    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst"
  fi
  copied=$((copied + 1))
}

if [[ $PRINT -eq 0 ]]; then
  mkdir -p "$TARGET/bin" "$TARGET/.kanban/tasks" "$TARGET/.kanban/specs" "$TARGET/dsh-kanban/lib"
fi

for name in "${BIN_FILES[@]}"; do
  copy_file "$ROOT/bin/$name" "$TARGET/bin/$name"
done
copy_file "$ROOT/AGENTS.md" "$TARGET/AGENTS.md"
copy_file "$ROOT/.kanban/tasks/README.md" "$TARGET/.kanban/tasks/README.md"
copy_file "$ROOT/dsh-kanban/lib/watcher-core.js" "$TARGET/dsh-kanban/lib/watcher-core.js"

if [[ ! -f "$TARGET/.kanban/board.json" ]]; then
  if [[ $PRINT -eq 1 ]]; then
    echo "  + .kanban/board.json"
  else
    printf '{ "minTodo": 3 }\n' > "$TARGET/.kanban/board.json"
  fi
  copied=$((copied + 1))
else
  skipped=$((skipped + 1))
fi

# .gitignore: служебные файлы доски и worktree
if [[ -f "$TARGET/.gitignore" ]] && grep -q 'worktrees/' "$TARGET/.gitignore"; then
  skipped=$((skipped + 1))
else
  if [[ $PRINT -eq 1 ]]; then
    echo "  + .gitignore (блок доски)"
  else
    mkdir -p "$TARGET"
    {
      printf '\n# Доска kanban: служебное состояние и рабочие деревья задач.\n'
      printf '.kanban/.watcher-state.json\n.kanban/.watcher-roles.json\n'
      printf '.kanban/.watcher-pending.json\n.kanban/.watcher-resume.json\n.kanban/.watcher-stale.json\n.kanban/.workers.json\n.kanban/worktrees.json\n'
      printf 'worktrees/\n.worktrees/\n'
    } >> "$TARGET/.gitignore"
    if [[ ! -s "$TARGET/.gitignore" ]]; then :; fi
  fi
  copied=$((copied + 1))
fi

echo "kanban-init: $TARGET"
echo "  скопировано: $copied, пропущено (уже есть): $skipped"
if [[ $PRINT -eq 1 ]]; then
  echo "  (--print: ничего не записано)"
  exit 0
fi

if ! git -C "$TARGET" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo
  echo "внимание: $TARGET не git-репозиторий — worktree-задачи работать не будут."
  echo "  git init && git add -A && git commit -m 'kanban: протокол задач'"
fi

cat <<MSG

Дальше:
1. Пропишите проект в ~/.dsh/cordis.patch.yml (boards) и перезапустите DSH.
2. Проверьте: bin/doctor.sh
3. Создайте сессии с пресетами dispatcher, worker, reviewer, verifier
   и откройте вкладку «Канбан».
4. Первая карточка: bin/task-new.sh "Починить экспорт QR"

Подробнее: docs/onboarding.ru.md
MSG
