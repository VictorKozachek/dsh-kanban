#!/usr/bin/env bash
#
# Замок карточки/worktree (issue #4): второй писатель не проходит.
#
#   bash bin/test-locks.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/kanban-locks.XXXXXX")"
HOME_DIR="$WORK/home"
PROJECT="$WORK/project"
A="6af8ff46-f3e7-4640-8a2d-045543fbc030"
B="1a7e1a7e-1111-4000-8000-000000000002"
DEAD="2b7e2b7e-2222-4000-8000-000000000003"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

pass=0
fail=0
ok() { pass=$((pass + 1)); printf '   ok: %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '   ПРОВАЛ: %s\n      %s\n' "$1" "${2:-}"; }

mkdir -p "$PROJECT/bin" "$PROJECT/.kanban/tasks" "$HOME_DIR/sessions/--project--/$A" "$HOME_DIR/sessions/--project--/$B"
cp "$ROOT/bin/task-move.sh" "$PROJECT/bin/"
cd "$PROJECT"
git init -q
git config user.email locks@test
git config user.name locks
printf 'project\n' > README.md
cat > .kanban/tasks/001.md <<EOF
---
id: "001"
title: "Проба замка"
status: todo
owner: "$A"
role: worker
updated: "2026-11-12T15:00:00Z"
---
EOF
git add -A
git commit -qm init

move() { DSH_HOME="$HOME_DIR" DSH_SESSION_ID="$1" ./bin/task-move.sh 001 "$2" --no-commit "${@:3}" 2>&1; }

echo "== замок: первый писатель берёт карточку"
if out="$(move "$A" in-progress --owner "$A")" && grep -q 'замок задачи' <<<"$out"; then
  ok "A взял in-progress, замок создан"
else
  bad "A взял in-progress, замок создан" "$out"
fi
if [[ -f .kanban/.locks/001.json ]] && grep -q "$A" .kanban/.locks/001.json; then
  ok "lock-файл указывает на A"
else
  bad "lock-файл указывает на A"
fi

# Дублирующая выдача: карточка снова в todo, но владелец уже B, а замок A жив.
python3 - <<'PY'
import pathlib
import re

p = pathlib.Path(".kanban/tasks/001.md")
text = p.read_text().replace("status: in-progress", "status: todo")
text = re.sub(r"^owner:.*$", 'owner: "1a7e1a7e-1111-4000-8000-000000000002"', text, flags=re.M)
p.write_text(text)
PY
echo "== замок: второй писатель не проходит"
set +e
out="$(move "$B" in-progress --owner "$B")"
code=$?
set -e
if [[ $code -ne 0 ]] && grep -q 'держит' <<<"$out"; then
  ok "B получил отказ «карточка занята»"
else
  bad "B получил отказ «карточка занята»" "код $code: $out"
fi
if grep -q 'status: todo' .kanban/tasks/001.md; then ok "карточка осталась в todo"; else bad "карточка осталась в todo"; fi

echo "== замок: --force перехватывает"
if out="$(move "$B" in-progress --owner "$B" --force)" && grep -q "$B" .kanban/.locks/001.json; then
  ok "B перехватил замок по --force"
else
  bad "B перехватил замок по --force" "$out"
fi

echo "== замок: уход из in-progress снимает замок"
if move "$B" in-review --role worker >/dev/null 2>&1; then
  if [[ ! -f .kanban/.locks/001.json ]]; then ok "замок снят после in-review"; else bad "замок снят после in-review"; fi
else
  bad "замок снят после in-review" "переход не прошёл"
fi

echo "== замок: мёртвая сессия перехватывается без --force"
python3 - "$DEAD" <<'PY'
import json
import pathlib
import sys
import time

path = pathlib.Path(".kanban/.locks/001.json")
path.parent.mkdir(parents=True, exist_ok=True)
now = int(time.time() * 1000)
path.write_text(json.dumps({"sessionId": sys.argv[1], "worktree": str(pathlib.Path.cwd()), "since": now, "heartbeat": now - 10_000}))
PY
python3 - <<'PY'
import pathlib
p = pathlib.Path(".kanban/tasks/001.md")
p.write_text(p.read_text().replace("status: in-review", "status: todo"))
PY
if out="$(move "$B" in-progress --owner "$B")" && grep -q 'мертва' <<<"$out"; then
  ok "мёртвый замок перехвачен с предупреждением"
else
  bad "мёртвый замок перехвачен с предупреждением" "$out"
fi

echo
echo "всего: $pass ok, $fail провал(ов)"
[[ $fail -eq 0 ]]
