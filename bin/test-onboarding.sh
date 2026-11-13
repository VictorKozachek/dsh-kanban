#!/usr/bin/env bash
#
# Онбординг-инструменты: kanban-init разворачивает протокол, доска работает.
#
#   bash bin/test-onboarding.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/kanban-onboarding.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

pass=0
fail=0
ok() {
  pass=$((pass + 1))
  printf '   ok: %s\n' "$1"
}
bad() {
  fail=$((fail + 1))
  printf '   ПРОВАЛ: %s\n      %s\n' "$1" "${2:-}"
}

TARGET="$WORK/project"
mkdir -p "$TARGET"
git -C "$TARGET" init -q
git -C "$TARGET" config user.email onboarding@test
git -C "$TARGET" config user.name onboarding
printf 'project\n' > "$TARGET/README.md"
git -C "$TARGET" add -A
git -C "$TARGET" commit -qm init

echo "== kanban-init: разворачивание протокола в проект"
if "$ROOT/bin/kanban-init.sh" "$TARGET" >/dev/null 2>&1; then
  ok "kanban-init завершился успешно"
else
  bad "kanban-init завершился успешно" "код возврата не 0"
fi

for file in bin/task-new.sh bin/task-move.sh bin/task-commit.sh bin/board-status.sh \
  bin/node.sh bin/doctor.sh AGENTS.md .kanban/tasks/README.md \
  dsh-kanban/lib/watcher-core.js .kanban/board.json \
  .agents/skills/write-tests/SKILL.md .agents/skills/review-compat/SKILL.md; do
  if [[ -f "$TARGET/$file" ]]; then ok "скопирован $file"; else bad "скопирован $file"; fi
done

if python3 - "$TARGET/.kanban/board.json" <<'PY'
import json, sys
value = json.load(open(sys.argv[1]))
assert value.get("minTodo") == 3
PY
then ok "board.json валиден и minTodo=3"; else bad "board.json валиден и minTodo=3"; fi

if grep -q 'worktrees/' "$TARGET/.gitignore" && grep -q '.kanban/.watcher-state.json' "$TARGET/.gitignore"; then
  ok ".gitignore закрывает worktrees и состояние сторожа"
else
  bad ".gitignore закрывает worktrees и состояние сторожа"
fi

if out="$("$ROOT/bin/kanban-init.sh" "$TARGET" 2>&1)" && grep -q 'скопировано: 0' <<<"$out"; then
  ok "повторный запуск идемпотентен"
else
  bad "повторный запуск идемпотентен" "${out:-нет вывода}"
fi

DRY="$WORK/dry"
mkdir -p "$DRY"
if "$ROOT/bin/kanban-init.sh" "$DRY" --print >/dev/null 2>&1 && [[ ! -e "$DRY/bin/task-new.sh" ]]; then
  ok "--print ничего не записывает"
else
  bad "--print ничего не записывает"
fi

echo "== первая карточка в проекте после init"
if (cd "$TARGET" && bin/task-new.sh "Проба онбординга" --backlog --no-worktree >/dev/null 2>&1); then
  if [[ -f "$TARGET/.kanban/tasks/001.md" ]]; then ok "task-new создал карточку 001"; else bad "task-new создал карточку 001"; fi
else
  bad "task-new создал карточку 001" "task-new упал"
fi

if (cd "$TARGET" && bin/board-status.sh 2>/dev/null | grep -q '001'); then
  ok "board-status видит карточку"
else
  bad "board-status видит карточку"
fi

echo
echo "всего: $pass ok, $fail провал(ов)"
[[ $fail -eq 0 ]]
