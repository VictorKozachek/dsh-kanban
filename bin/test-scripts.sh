#!/usr/bin/env bash
#
# Регрессии на грабли оболочки и на пути отказа скриптов набора.
#
# Отдельно от bin/test.sh не для красоты: скрипты запускаются СИСТЕМНЫМ
# /bin/bash (на macOS это 3.2), потому что именно там ломаются вещи, которых не
# видно в bash 5: пустой массив под `set -u`, разворачивание `${arr[@]}`.
#
#   bin/test-scripts.sh
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYS_BASH=/bin/bash
[[ -x "$SYS_BASH" ]] || SYS_BASH="$(command -v bash)"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

failures=0
pass() { echo "   ok: $1"; }
fail() { echo "   ПРОВАЛ: $1" >&2; failures=$((failures + 1)); }

make_repo() {
  local dir="$1"
  mkdir -p "$dir/bin"
  ( cd "$dir" &&
    git init -q -b main . &&
    git config user.email test@example.com &&
    git config user.name test &&
    echo "app" > app.txt &&
    printf 'worktrees/\n' > .gitignore &&
    cp -p "$ROOT/bin/task-new.sh" "$ROOT/bin/task-move.sh" "$ROOT/bin/board-sync.sh" \
    "$ROOT/bin/task-commit.sh" "$ROOT/bin/task-usage.sh" \
    "$ROOT/bin/backlog-fill.sh" "$ROOT/bin/spec-new.sh" "$ROOT/bin/task-assign.sh" bin/ &&
    git add . &&
    git commit -qm init )
}

echo "== права и запуск так, как написано в документации"
for script in "$ROOT"/bin/*.sh; do
  name="$(basename "$script")"
  if [[ -x "$script" ]]; then pass "$name исполняемый"; else fail "$name НЕ исполняемый (а документация зовёт его напрямую)"; fi
done
if git -C "$ROOT" ls-files -s bin/ | awk '$1 != "100755" {print $4}' | grep -q .; then
  fail "часть bin/*.sh лежит в git без бита исполнения"
else
  pass "все bin/*.sh в git с битом исполнения (100755)"
fi

echo "== board-sync без worktree (пустой массив под set -u, bash 3.2)"
repo="$WORK/proj"
make_repo "$repo"
( cd "$repo" && ./bin/board-sync.sh >/dev/null 2>"$WORK/err1" )
if (( $? == 0 )); then pass "манифест собирается при нуле worktree"; else fail "board-sync упал: $(cat "$WORK/err1")"; fi
if python3 -c "
import json,sys
data = json.load(open('$repo/.kanban/worktrees.json'))
sys.exit(0 if data['cards'] == [] else 1)
"; then pass "манифест содержит пустой список карточек"; else fail "манифест не пуст"; fi
( cd "$repo" && ./bin/board-sync.sh --print >"$WORK/out2" 2>&1 )
if grep -q "открытых карточек в worktree нет" "$WORK/out2"; then pass "режим --print при нуле worktree"; else fail "--print не отработал: $(cat "$WORK/out2")"; fi

echo "== полный цикл карточки в ветке"
( cd "$repo" && ./bin/task-new.sh "Задача из теста" --owner sess-test >/dev/null 2>&1 )
if [[ -f "$repo/worktrees/001/.kanban/tasks/001.md" ]]; then
  pass "карточка создаётся внутри worktree (в проекте, не рядом)"
else
  fail "карточки нет в worktrees/001"
fi
if git -C "$repo" check-ignore -q worktrees/001; then pass "worktrees/ игнорируется git"; else fail "worktrees/ не в .gitignore"; fi
if ( cd "$repo/worktrees/001" && ./bin/task-move.sh 001 in-progress --owner sess-test --role worker >/dev/null 2>&1 ); then
  pass "исполнитель двигает карточку из своего worktree"
else
  fail "исполнитель не смог подвинуть карточку"
fi
if grep -q '^role: worker' "$repo/worktrees/001/.kanban/tasks/001.md"; then
  pass "роль записана в карточку"
else
  fail "role: $(grep '^role:' "$repo/worktrees/001/.kanban/tasks/001.md")"
fi
( cd "$repo" && ./bin/board-sync.sh >/dev/null 2>&1 )
if python3 -c "
import json,sys
data = json.load(open('$repo/.kanban/worktrees.json'))
sys.exit(0 if data['cards'] == ['worktrees/001/.kanban/tasks/001.md'] else 1)
"; then
  pass "манифест пишет относительный путь для worktree внутри проекта"
else
  fail "манифест: $(cat "$repo/.kanban/worktrees.json")"
fi
if ( cd "$repo" && git merge -q --no-ff task/001 -m merge >/dev/null 2>&1 ) &&
   grep -q '^status: in-progress' "$repo/.kanban/tasks/001.md"; then
  pass "после слияния статус приезжает в основной чекаут"
else
  fail "слияние не принесло карточку"
fi

echo "== board-sync из рабочего дерева задачи: громкий отказ, а не пустой манифест"
if ( cd "$repo/worktrees/001" && ./bin/board-sync.sh >"$WORK/out5" 2>&1 ); then
  fail "board-sync из worktree не должен завершаться успехом"
else
  if grep -q "только из ОСНОВНОГО чекаута" "$WORK/out5"; then
    pass "отказ с объяснением"
  else
    fail "непонятный отказ: $(cat "$WORK/out5")"
  fi
fi

echo "== многострочная заметка и права карточки"
card="$repo/worktrees/001/.kanban/tasks/001.md"
chmod 644 "$card"
if ( cd "$repo/worktrees/001" && ./bin/task-move.sh 001 in-review --note "$(printf 'первая строка\nвторая строка')" >"$WORK/out6" 2>&1 ); then
  pass "многострочная заметка принимается"
else
  fail "многострочный --note: $(cat "$WORK/out6")"
fi
if grep -q '^note: ' "$card" && [[ "$(grep -c '^note: ' "$card")" == "1" ]]; then
  pass "в front matter заметка однострочная"
else
  fail "front matter заметки: $(grep -c '^note: ' "$card") строк"
fi
if grep -q "вторая строка" "$card"; then pass "полный текст заметки сохранён в теле"; else fail "вторая строка потерялась"; fi
mode="$(stat -f '%Lp' "$card" 2>/dev/null || stat -c '%a' "$card")"
if [[ "$mode" == "644" ]]; then pass "права карточки сохранились (644)"; else fail "права стали $mode"; fi
if grep -q '^status: in-review' "$card"; then pass "статус in-review записан"; else fail "статус: $(grep '^status:' "$card")"; fi

echo "== протокол переходов: недопустимый отвергается, --force выполняет его"
if ( cd "$repo/worktrees/001" && ./bin/task-move.sh 001 merged --no-commit >"$WORK/out7" 2>&1 ); then
  fail "in-review → merged не должен проходить"
else
  if grep -q "task-commit.sh" "$WORK/out7"; then
    pass "отказ с указанием на task-commit.sh"
  else
    fail "непонятный отказ: $(cat "$WORK/out7")"
  fi
fi
if ( cd "$repo/worktrees/001" && ./bin/task-move.sh 001 testing --no-commit >/dev/null 2>&1 ); then
  pass "in-review → testing разрешён (ревьювер принял)"
else
  fail "разрешённый переход отклонён"
fi
if ( cd "$repo/worktrees/001" && ./bin/task-move.sh 001 ready --no-commit >/dev/null 2>&1 ); then
  pass "testing → ready разрешён (тестировщик принял)"
else
  fail "testing → ready отклонён"
fi
if ( cd "$repo/worktrees/001" && ./bin/task-move.sh 001 merged --force --no-commit >/dev/null 2>&1 ) &&
   grep -q '^status: merged' "$card"; then
  pass "--force выполняет недопустимый переход"
else
  fail "--force не сработал"
fi

echo "== бэклог: карточка без владельца, асайн в todo, запрет прыжка в работу"
backlog_repo="$WORK/backlog"
make_repo "$backlog_repo"
if ( cd "$backlog_repo" && ./bin/task-new.sh "Задача в бэклог" --no-worktree --backlog >"$WORK/backlog1" 2>&1 ); then
  pass "task-new.sh --backlog заводит карточку"
else
  fail "task-new.sh --backlog: $(cat "$WORK/backlog1")"
fi
backlog_card="$backlog_repo/.kanban/tasks/001.md"
if grep -q '^status: backlog' "$backlog_card" && grep -q '^owner: ""' "$backlog_card"; then
  pass "карточка в backlog без владельца"
else
  fail "карточка бэклога: $(grep -E '^(status|owner):' "$backlog_card")"
fi
if ( cd "$backlog_repo" && ./bin/task-new.sh "С владельцем" --no-worktree --backlog --owner sess-x >"$WORK/backlog2" 2>&1 ); then
  fail "--backlog с --owner должен отвергаться"
else
  pass "--backlog с --owner отвергается"
fi
if ( cd "$backlog_repo" && ./bin/task-move.sh 001 in-progress --owner sess-x >"$WORK/backlog3" 2>&1 ); then
  fail "backlog → in-progress должен быть запрещён"
else
  if grep -q "недопустимый переход" "$WORK/backlog3"; then
    pass "backlog → in-progress запрещён с объяснением"
  else
    fail "сообщение: $(cat "$WORK/backlog3")"
  fi
fi
if ( cd "$backlog_repo" && ./bin/task-move.sh 001 todo >"$WORK/backlog4" 2>&1 ); then
  fail "backlog → todo без --owner должен отвергаться"
else
  if grep -q "асайн" "$WORK/backlog4"; then
    pass "backlog → todo без --owner отвергается как асайн"
  else
    fail "сообщение: $(cat "$WORK/backlog4")"
  fi
fi
if ( cd "$backlog_repo" && ./bin/task-move.sh 001 todo --owner sess-worker >/dev/null 2>&1 ) &&
   grep -q '^status: todo' "$backlog_card" && grep -q '^owner: sess-worker' "$backlog_card"; then
  pass "backlog → todo --owner закрепляет задачу за исполнителем"
else
  fail "асайн не сработал: $(grep -E '^(status|owner):' "$backlog_card")"
fi
if ( cd "$backlog_repo" && ./bin/task-move.sh 001 backlog >/dev/null 2>&1 ) &&
   grep -q '^status: backlog' "$backlog_card" && grep -q '^owner: ""' "$backlog_card"; then
  pass "todo → backlog возвращает задачу в очередь без владельца"
else
  fail "возврат в очередь: $(grep -E '^(status|owner):' "$backlog_card")"
fi

echo "== спецификации: сквозной номер и поле spec в карточке"
spec_repo="$WORK/spec"
make_repo "$spec_repo"
if ( cd "$spec_repo" && ./bin/spec-new.sh "Первая спека" >"$WORK/spec1" 2>&1 ) &&
   [[ -f "$spec_repo/.kanban/specs/001.md" ]] &&
   grep -q '^# Спека 001:' "$spec_repo/.kanban/specs/001.md" &&
   grep -q '^Статус:' "$spec_repo/.kanban/specs/001.md" &&
   grep -q '^## Зачем' "$spec_repo/.kanban/specs/001.md" &&
   grep -q '^## Требования' "$spec_repo/.kanban/specs/001.md" &&
   grep -q '^## Вне скоупа' "$spec_repo/.kanban/specs/001.md"; then
  pass "spec-new.sh заводит первый файл по шаблону"
else
  fail "spec-new.sh: $(cat "$WORK/spec1" 2>/dev/null)"
fi
if ( cd "$spec_repo" && ./bin/spec-new.sh "Вторая спека" >/dev/null 2>&1 ) &&
   [[ -f "$spec_repo/.kanban/specs/002.md" ]]; then
  pass "spec-new.sh берёт следующий свободный номер"
else
  fail "второй номер: $(ls "$spec_repo/.kanban/specs" 2>/dev/null)"
fi
if ( cd "$spec_repo" && ./bin/task-new.sh "Задача из спеки" --no-worktree --spec 001 >/dev/null 2>&1 ) &&
   grep -q '^spec: "001"' "$spec_repo/.kanban/tasks/001.md"; then
  pass "task-new.sh --spec пишет поле spec"
else
  fail "spec в карточке: $(grep '^spec:' "$spec_repo/.kanban/tasks/001.md" 2>/dev/null)"
fi
if ( cd "$spec_repo" && ./bin/task-new.sh "Без спеки" --no-worktree >/dev/null 2>&1 ) &&
   grep -q '^spec: ""' "$spec_repo/.kanban/tasks/002.md"; then
  pass "без --spec поле spec пустое"
else
  fail "пустой spec: $(grep '^spec:' "$spec_repo/.kanban/tasks/002.md" 2>/dev/null)"
fi
if ( cd "$spec_repo" && ./bin/task-new.sh "Плохая ссылка" --no-worktree --spec 099 >"$WORK/spec2" 2>&1 ); then
  fail "task-new.sh --spec на несуществующую спеку должен отвергаться"
else
  pass "task-new.sh --spec на несуществующую спеку отвергается"
fi

echo "== спецификации: номер — числовой префикс имени (001-backlog.md занимает 001)"
slug_repo="$WORK/spec-slug"
make_repo "$slug_repo"
mkdir -p "$slug_repo/.kanban/specs"
printf '# Спека 001: бэклог\n\nСтатус: принята.\n' > "$slug_repo/.kanban/specs/001-backlog.md"
if ( cd "$slug_repo" && ./bin/spec-new.sh "Следующая" >"$WORK/spec3" 2>&1 ) &&
   [[ -f "$slug_repo/.kanban/specs/002.md" ]] &&
   [[ ! -e "$slug_repo/.kanban/specs/001.md" ]]; then
  pass "spec-new не выдаёт номер, занятый спекой со слагом"
else
  fail "slug-нумерация: $(cat "$WORK/spec3" 2>/dev/null); $(ls "$slug_repo/.kanban/specs" 2>/dev/null)"
fi
if ( cd "$slug_repo" && ./bin/task-new.sh "Задача из спеки со слагом" --no-worktree --spec 001 >/dev/null 2>&1 ) &&
   grep -q '^spec: "001"' "$slug_repo/.kanban/tasks/001.md"; then
  pass "task-new.sh --spec 001 работает при файле 001-backlog.md"
else
  fail "--spec по слагу: $(grep '^spec:' "$slug_repo/.kanban/tasks/001.md" 2>/dev/null)"
fi
# Дыра в нумерации: 001-backlog, 003 и 004-ещё — следующий свободный номер 002.
rm -f "$slug_repo/.kanban/specs/002.md"
printf '# Спека 003\n' > "$slug_repo/.kanban/specs/003.md"
printf '# Спека 004\n\nСтатус: черновик.\n' > "$slug_repo/.kanban/specs/004-ещё.md"
if ( cd "$slug_repo" && ./bin/spec-new.sh "В дыру" >"$WORK/spec4" 2>&1 ) &&
   [[ -f "$slug_repo/.kanban/specs/002.md" ]]; then
  pass "spec-new берёт первый свободный номер (002 в дыре 001/003/004)"
else
  fail "дыра в нумерации: $(ls "$slug_repo/.kanban/specs" 2>/dev/null)"
fi

echo "== выдача из бэклога: минимум todo, FIFO по id, пул исполнителей"
fill_repo="$WORK/fill"
make_repo "$fill_repo"
( cd "$fill_repo" && ./bin/task-new.sh "А" --backlog --no-worktree >/dev/null 2>&1 &&
  ./bin/task-new.sh "Б" --backlog --no-worktree >/dev/null 2>&1 &&
  ./bin/task-new.sh "В" --backlog --no-worktree >/dev/null 2>&1 )
mkdir -p "$fill_repo/.kanban"
printf '{\n  "minTodo": 2\n}\n' > "$fill_repo/.kanban/board.json"
printf '[\n  "sess-a",\n  "sess-b"\n]\n' > "$fill_repo/.kanban/.workers.json"

before="$( cd "$fill_repo" && git status --porcelain .kanban/tasks )"
if ( cd "$fill_repo" && ./bin/backlog-fill.sh --dry-run >"$WORK/fill1" 2>&1 ); then
  if grep -q "#001 → sess-a" "$WORK/fill1" && grep -q "#002 → sess-b" "$WORK/fill1"; then
    pass "--dry-run показывает план выдачи по FIFO"
  else
    fail "план dry-run: $(cat "$WORK/fill1")"
  fi
else
  fail "dry-run упал: $(cat "$WORK/fill1")"
fi
after="$( cd "$fill_repo" && git status --porcelain .kanban/tasks )"
if [[ "$before" == "$after" ]]; then
  pass "--dry-run не меняет файлы"
else
  fail "--dry-run изменил доску: $after"
fi

if ( cd "$fill_repo" && ./bin/backlog-fill.sh >"$WORK/fill2" 2>&1 ); then
  pass "backlog-fill выдаёт задачи при недоборе"
else
  fail "backlog-fill: $(cat "$WORK/fill2")"
fi
if grep -q '^status: todo' "$fill_repo/.kanban/tasks/001.md" && grep -q '^owner: sess-a' "$fill_repo/.kanban/tasks/001.md" &&
   grep -q '^status: todo' "$fill_repo/.kanban/tasks/002.md" && grep -q '^owner: sess-b' "$fill_repo/.kanban/tasks/002.md" &&
   grep -q '^status: backlog' "$fill_repo/.kanban/tasks/003.md"; then
  pass "первая карточка ушла первому свободному, вторая — следующему"
else
  fail "выдача: $(grep -H -E '^(status|owner):' "$fill_repo"/.kanban/tasks/*.md | tr '\n' ' ')"
fi
if ( cd "$fill_repo" && ./bin/backlog-fill.sh >"$WORK/fill3" 2>&1 ) && grep -q "пополнять нечего" "$WORK/fill3"; then
  pass "повторный запуск при полном todo ничего не меняет"
else
  fail "повторный запуск: $(cat "$WORK/fill3" 2>/dev/null)"
fi
( cd "$fill_repo" && ./bin/task-move.sh 001 in-progress --owner sess-a >/dev/null 2>&1 )
if ( cd "$fill_repo" && ./bin/backlog-fill.sh >"$WORK/fill4" 2>&1 ) &&
   grep -q '^status: todo' "$fill_repo/.kanban/tasks/003.md" &&
   grep -q '^owner: sess-b' "$fill_repo/.kanban/tasks/003.md"; then
  pass "занятой сессии задача не выдаётся"
else
  fail "выдача занятому: $(cat "$WORK/fill4" 2>/dev/null)"
fi

echo "== backlog-fill: отказы и fallback пула исполнителей"
edge_repo="$WORK/fill-edge"
make_repo "$edge_repo"
( cd "$edge_repo" && ./bin/task-new.sh "Занят 1" --no-worktree --owner sess-a >/dev/null 2>&1 &&
  ./bin/task-new.sh "Занят 2" --no-worktree --owner sess-b >/dev/null 2>&1 &&
  ./bin/task-new.sh "Ждёт" --backlog --no-worktree >/dev/null 2>&1 )
mkdir -p "$edge_repo/.kanban"
printf '{"minTodo": 2}\n' > "$edge_repo/.kanban/board.json"
printf '["sess-a","sess-b"]\n' > "$edge_repo/.kanban/.workers.json"
( cd "$edge_repo" && ./bin/task-move.sh 001 in-progress --owner sess-a >/dev/null 2>&1 &&
  ./bin/task-move.sh 002 in-progress --owner sess-b >/dev/null 2>&1 )
fill_code=0
( cd "$edge_repo" && ./bin/backlog-fill.sh >"$WORK/fill5" 2>&1 ) || fill_code=$?
if [[ "$fill_code" == "3" ]] && grep -q "нет свободных исполнителей" "$WORK/fill5"; then
  pass "нет свободных исполнителей — код 3 и объяснение"
else
  fail "нет свободных: код $fill_code, $(cat "$WORK/fill5" 2>/dev/null)"
fi
printf '{"minTodo": }\n' > "$edge_repo/.kanban/board.json"
fill_code=0
( cd "$edge_repo" && ./bin/backlog-fill.sh >"$WORK/fill6" 2>&1 ) || fill_code=$?
if [[ "$fill_code" == "1" ]] && grep -q "minTodo" "$WORK/fill6"; then
  pass "битый board.json — код 1 и объяснение"
else
  fail "битый конфиг: код $fill_code, $(cat "$WORK/fill6" 2>/dev/null)"
fi

# Синоним статуса как на доске: wip — это in-progress, исполнитель занят.
edge_card="$edge_repo/.kanban/tasks/001.md"
awk '{ if ($0 == "status: in-progress") print "status: wip"; else print }' "$edge_card" > "$edge_card.tmp" &&
  mv "$edge_card.tmp" "$edge_card"
printf '{"minTodo": 2}\n' > "$edge_repo/.kanban/board.json"
fill_code=0
( cd "$edge_repo" && ./bin/backlog-fill.sh >"$WORK/fill9" 2>&1 ) || fill_code=$?
if [[ "$fill_code" == "3" ]] && grep -q "нет свободных исполнителей" "$WORK/fill9" &&
   grep -q '^status: backlog' "$edge_repo/.kanban/tasks/003.md"; then
  pass "status wip считается работой: занятой сессии задача не идёт"
else
  fail "wip как in-progress: код $fill_code, $(cat "$WORK/fill9" 2>/dev/null)"
fi

# Пул без запятой — битый JSON, а не «две сессии».
printf '["sess-a" "sess-b"]\n' > "$edge_repo/.kanban/.workers.json"
fill_code=0
( cd "$edge_repo" && ./bin/backlog-fill.sh >"$WORK/fill10" 2>&1 ) || fill_code=$?
if [[ "$fill_code" == "1" ]] && grep -q "workers.json" "$WORK/fill10"; then
  pass "массив пула без запятой — код 1"
else
  fail "битый пул: код $fill_code, $(cat "$WORK/fill10" 2>/dev/null)"
fi
printf '["sess-a","sess-b"]\n' > "$edge_repo/.kanban/.workers.json"

# Ошибка использования --min — код 2, а не ошибка конфига.
fill_code=0
( cd "$edge_repo" && ./bin/backlog-fill.sh --min abc >"$WORK/fill11" 2>&1 ) || fill_code=$?
if [[ "$fill_code" == "2" ]] && grep -q -- "--min" "$WORK/fill11"; then
  pass "--min с мусором — код 2 (ошибка использования)"
else
  fail "--min abc: код $fill_code, $(cat "$WORK/fill11" 2>/dev/null)"
fi

empty_repo="$WORK/fill-empty"
make_repo "$empty_repo"
mkdir -p "$empty_repo/.kanban/tasks"
printf '{"minTodo": 2}\n' > "$empty_repo/.kanban/board.json"
fill_code=0
( cd "$empty_repo" && ./bin/backlog-fill.sh >"$WORK/fill7" 2>&1 ) || fill_code=$?
if [[ "$fill_code" == "3" ]] && grep -q "backlog пуст" "$WORK/fill7"; then
  pass "backlog пуст при недоборе — код 3"
else
  fail "пустой backlog: код $fill_code, $(cat "$WORK/fill7" 2>/dev/null)"
fi

fallback_repo="$WORK/fill-fallback"
make_repo "$fallback_repo"
( cd "$fallback_repo" && ./bin/task-new.sh "Из бэклога" --backlog --no-worktree >/dev/null 2>&1 )
mkdir -p "$fallback_repo/.kanban"
printf '{"minTodo": 1}\n' > "$fallback_repo/.kanban/board.json"
printf '{"worker":"sess-z","reviewer":"sess-r"}\n' > "$fallback_repo/.kanban/.watcher-roles.json"
if ( cd "$fallback_repo" && ./bin/backlog-fill.sh >"$WORK/fill8" 2>&1 ) &&
   grep -q '^owner: sess-z' "$fallback_repo/.kanban/tasks/001.md"; then
  pass "без .workers.json пул берётся из .watcher-roles.json"
else
  fail "fallback пула: $(cat "$WORK/fill8" 2>/dev/null)"
fi

echo "== backlog-fill: занятость исполнителя в рабочих деревьях"
# Карточка для стенда: критерий занятости — статус и owner, остальное не важно.
write_card() { # файл id статус владелец [updated] [role]
  printf -- '---\nid: "%s"\ntitle: Задача %s\nstatus: %s\nowner: "%s"\nrole: "%s"\nupdated: "%s"\n---\n' \
    "$2" "$2" "$3" "$4" "${6:-}" "${5:-2026-10-21T10:00:00Z}" > "$1"
}

# Кто записан во владельцах карточки: task-move пишет простое значение без кавычек.
written_owner() {
  awk 'NR > 1 && $0 == "---" { exit }
       /^owner:/ { sub(/^owner:[ \t]*/, ""); gsub(/"/, ""); sub(/[ \t]+$/, ""); print; exit }' "$1"
}

# Значение произвольного поля карточки без кавычек и хвостовых пробелов.
written_field() {
  awk -v key="$2" '
    NR > 1 && $0 == "---" { exit }
    index($0, key ":") == 1 {
      sub("^" key ":[ \t]*", "")
      gsub(/"/, "")
      sub(/[ \t]+$/, "")
      print
      exit
    }' "$1"
}

# Исполнитель держит задачу в работе внутри рабочего дерева (так выглядит задача,
# заведённая штатным task-new.sh) — он занят, задача уходит следующему.
tree_repo="$WORK/fill-tree"
make_repo "$tree_repo"
( cd "$tree_repo" && ./bin/task-new.sh "Ждёт выдачи" --backlog --no-worktree >/dev/null 2>&1 )
mkdir -p "$tree_repo/.kanban" "$tree_repo/worktrees/077/.kanban/tasks"
printf '{"minTodo": 1}\n' > "$tree_repo/.kanban/board.json"
printf '["sess-a","sess-b"]\n' > "$tree_repo/.kanban/.workers.json"
write_card "$tree_repo/worktrees/077/.kanban/tasks/077.md" 077 in-progress sess-a
fill_code=0
( cd "$tree_repo" && ./bin/backlog-fill.sh >"$WORK/fill12" 2>&1 ) || fill_code=$?
tree_owner="$(written_owner "$tree_repo/.kanban/tasks/001.md")"
if [[ "$fill_code" == "0" ]] && [[ "$tree_owner" == "sess-b" ]]; then
  pass "исполнитель с работой в дереве занят: задача ушла следующему свободному"
else
  fail "занятость в дереве: код $fill_code, owner '$tree_owner', $(cat "$WORK/fill12" 2>/dev/null)"
fi

# Унаследованная копия чужой карточки в дереве занятости не создаёт: из дерева
# берётся только одноимённая карточка.
inherit_repo="$WORK/fill-inherit"
make_repo "$inherit_repo"
( cd "$inherit_repo" && ./bin/task-new.sh "Ждёт выдачи" --backlog --no-worktree >/dev/null 2>&1 )
mkdir -p "$inherit_repo/.kanban" "$inherit_repo/worktrees/077/.kanban/tasks"
printf '{"minTodo": 1}\n' > "$inherit_repo/.kanban/board.json"
printf '["sess-a"]\n' > "$inherit_repo/.kanban/.workers.json"
write_card "$inherit_repo/worktrees/077/.kanban/tasks/001.md" 001 in-progress sess-a
fill_code=0
( cd "$inherit_repo" && ./bin/backlog-fill.sh >"$WORK/fill13" 2>&1 ) || fill_code=$?
inherit_owner="$(written_owner "$inherit_repo/.kanban/tasks/001.md")"
if [[ "$fill_code" == "0" ]] && [[ "$inherit_owner" == "sess-a" ]]; then
  pass "унаследованная копия чужой карточки в дереве занятости не создаёт"
else
  fail "унаследованная копия: код $fill_code, owner '$inherit_owner', $(cat "$WORK/fill13" 2>/dev/null)"
fi

# Битый и пустой каталог дерева не ломает подсчёт: карточка без front matter не
# считается карточкой, каталог без `.kanban/tasks` и файл в `worktrees/` — тоже.
broken_repo="$WORK/fill-broken"
make_repo "$broken_repo"
( cd "$broken_repo" && ./bin/task-new.sh "Ждёт выдачи" --backlog --no-worktree >/dev/null 2>&1 )
mkdir -p "$broken_repo/.kanban" "$broken_repo/worktrees/без-доски" \
  "$broken_repo/worktrees/078/.kanban/tasks"
printf '{"minTodo": 1}\n' > "$broken_repo/.kanban/board.json"
printf '["sess-a"]\n' > "$broken_repo/.kanban/.workers.json"
printf 'без front matter\n' > "$broken_repo/worktrees/078/.kanban/tasks/078.md"
printf 'не дерево\n' > "$broken_repo/worktrees/мусор"
fill_code=0
( cd "$broken_repo" && ./bin/backlog-fill.sh >"$WORK/fill14" 2>&1 ) || fill_code=$?
broken_owner="$(written_owner "$broken_repo/.kanban/tasks/001.md")"
if [[ "$fill_code" == "0" ]] && [[ "$broken_owner" == "sess-a" ]] &&
   grep -q 'выдано: #001' "$WORK/fill14"; then
  pass "битый и пустой каталог дерева не ломает подсчёт"
else
  fail "битые деревья: код $fill_code, owner '$broken_owner', $(cat "$WORK/fill14" 2>/dev/null)"
fi

# Частичный backlog: недобор 2, в очереди одна карточка — выдана одна, код 3 и
# честный итог с недобором.
partial_repo="$WORK/fill-partial"
make_repo "$partial_repo"
( cd "$partial_repo" && ./bin/task-new.sh "Единственная" --backlog --no-worktree >/dev/null 2>&1 )
mkdir -p "$partial_repo/.kanban"
printf '{"minTodo": 2}\n' > "$partial_repo/.kanban/board.json"
printf '["sess-a","sess-b"]\n' > "$partial_repo/.kanban/.workers.json"
fill_code=0
( cd "$partial_repo" && ./bin/backlog-fill.sh >"$WORK/fill15" 2>&1 ) || fill_code=$?
if [[ "$fill_code" == "3" ]] && grep -q "выдано 1 из 2" "$WORK/fill15" &&
   grep -q "backlog исчерпан" "$WORK/fill15" &&
   grep -q '^status: todo' "$partial_repo/.kanban/tasks/001.md"; then
  pass "частичный backlog: выдано 1 из 2, код 3 и «backlog исчерпан»"
else
  fail "частичный backlog: код $fill_code, $(cat "$WORK/fill15" 2>/dev/null)"
fi

echo "== backlog-fill: выдача из backlog, когда задача живёт в ветке"
# Карточка-кандидат в ветке задачи: рабочее дерево настоящее, со своей копией
# bin/task-move.sh (иначе выдача из дерева некуда идти).
branch_repo="$WORK/fill-branch"
make_repo "$branch_repo"
mkdir -p "$branch_repo/.kanban/tasks"
printf '{"minTodo": 2}\n' > "$branch_repo/.kanban/board.json"
printf '["sess-a","sess-b"]\n' > "$branch_repo/.kanban/.workers.json"
git -C "$branch_repo" worktree add -q -b task/010 "$branch_repo/worktrees/010" HEAD
mkdir -p "$branch_repo/worktrees/010/.kanban/tasks"
write_card "$branch_repo/worktrees/010/.kanban/tasks/010.md" 010 backlog ""
fill_code=0
( cd "$branch_repo" && ./bin/backlog-fill.sh >"$WORK/fill16" 2>&1 ) || fill_code=$?
branch_status="$(sed -n 's/^status: *//p' "$branch_repo/worktrees/010/.kanban/tasks/010.md" | head -1)"
branch_owner="$(written_owner "$branch_repo/worktrees/010/.kanban/tasks/010.md")"
if [[ "$fill_code" == "3" ]] && [[ "$branch_status" == "todo" ]] && [[ "$branch_owner" == "sess-a" ]] &&
   grep -q "выдано: #010" "$WORK/fill16" && [[ ! -e "$branch_repo/.kanban/tasks/010.md" ]]; then
  pass "карточка только в ветке задачи выдаётся свободному исполнителю"
else
  fail "выдача из ветки: код $fill_code, status '$branch_status', owner '$branch_owner', $(cat "$WORK/fill16" 2>/dev/null)"
fi
# Статус уехал в ветку задачи, а не в основной чекаут.
if git -C "$branch_repo/worktrees/010" log --oneline -1 | grep -q "kanban(010): todo"; then
  pass "выдача из ветки коммитится в ветку задачи"
else
  fail "коммит выдачи из ветки: $(git -C "$branch_repo/worktrees/010" log --oneline -1 2>&1)"
fi

# Устаревшая копия в main не выдаёт занятую карточку: слитый снимок видит
# in-progress из дерева, а следующий кандидат уходит второму исполнителю.
stale_repo="$WORK/fill-stale"
make_repo "$stale_repo"
mkdir -p "$stale_repo/.kanban/tasks" "$stale_repo/worktrees/010/.kanban/tasks"
printf '{"minTodo": 1}\n' > "$stale_repo/.kanban/board.json"
printf '["sess-a","sess-b"]\n' > "$stale_repo/.kanban/.workers.json"
write_card "$stale_repo/.kanban/tasks/010.md" 010 backlog "" "2026-10-21T10:00:00Z"
write_card "$stale_repo/.kanban/tasks/011.md" 011 backlog "" "2026-10-21T10:00:00Z"
write_card "$stale_repo/worktrees/010/.kanban/tasks/010.md" 010 in-progress sess-a "2026-10-21T11:00:00Z"
fill_code=0
( cd "$stale_repo" && ./bin/backlog-fill.sh >"$WORK/fill17" 2>&1 ) || fill_code=$?
stale_010_status="$(sed -n 's/^status: *//p' "$stale_repo/.kanban/tasks/010.md" | head -1)"
stale_011_owner="$(written_owner "$stale_repo/.kanban/tasks/011.md")"
if [[ "$fill_code" == "0" ]] && [[ "$stale_010_status" == "backlog" ]] &&
   [[ "$stale_011_owner" == "sess-b" ]] && grep -q "выдано: #011 → sess-b" "$WORK/fill17"; then
  pass "устаревшая копия в main не выдаёт занятую карточку: занятость видна из дерева"
else
  fail "устаревший main: код $fill_code, 010 '$stale_010_status', 011 owner '$stale_011_owner', $(cat "$WORK/fill17" 2>/dev/null)"
fi

# Порченый файл дерева с чужим id не подменяет чужую карточку.
bogus_repo="$WORK/fill-bogus"
make_repo "$bogus_repo"
mkdir -p "$bogus_repo/.kanban/tasks" "$bogus_repo/worktrees/077/.kanban/tasks"
printf '{"minTodo": 1}\n' > "$bogus_repo/.kanban/board.json"
printf '["sess-a"]\n' > "$bogus_repo/.kanban/.workers.json"
write_card "$bogus_repo/.kanban/tasks/001.md" 001 backlog ""
write_card "$bogus_repo/worktrees/077/.kanban/tasks/077.md" 001 in-progress sess-a
fill_code=0
( cd "$bogus_repo" && ./bin/backlog-fill.sh >"$WORK/fill18" 2>&1 ) || fill_code=$?
bogus_owner="$(written_owner "$bogus_repo/.kanban/tasks/001.md")"
if [[ "$fill_code" == "0" ]] && [[ "$bogus_owner" == "sess-a" ]] &&
   grep -q '^status: in-progress' "$bogus_repo/worktrees/077/.kanban/tasks/077.md"; then
  pass "порченый файл дерева с чужим id не подменяет карточку"
else
  fail "порченый файл дерева: код $fill_code, owner '$bogus_owner', $(cat "$WORK/fill18" 2>/dev/null)"
fi

# Свежая копия в дереве побеждает main: в main in-progress, в дереве backlog.
fresh_repo="$WORK/fill-fresh"
make_repo "$fresh_repo"
mkdir -p "$fresh_repo/.kanban/tasks"
printf '{"minTodo": 1}\n' > "$fresh_repo/.kanban/board.json"
printf '["sess-a"]\n' > "$fresh_repo/.kanban/.workers.json"
write_card "$fresh_repo/.kanban/tasks/010.md" 010 in-progress sess-a "2026-10-21T10:00:00Z"
git -C "$fresh_repo" worktree add -q -b task/010 "$fresh_repo/worktrees/010" HEAD
mkdir -p "$fresh_repo/worktrees/010/.kanban/tasks"
write_card "$fresh_repo/worktrees/010/.kanban/tasks/010.md" 010 backlog "" "2026-10-21T11:00:00Z"
fill_code=0
( cd "$fresh_repo" && ./bin/backlog-fill.sh >"$WORK/fill19" 2>&1 ) || fill_code=$?
fresh_status="$(sed -n 's/^status: *//p' "$fresh_repo/worktrees/010/.kanban/tasks/010.md" | head -1)"
fresh_owner="$(written_owner "$fresh_repo/worktrees/010/.kanban/tasks/010.md")"
if [[ "$fill_code" == "0" ]] && [[ "$fresh_status" == "todo" ]] && [[ "$fresh_owner" == "sess-a" ]] &&
   grep -q "выдано: #010" "$WORK/fill19"; then
  pass "свежая копия в дереве побеждает устаревшую в main"
else
  fail "свежая копия в дереве: код $fill_code, status '$fresh_status', owner '$fresh_owner', $(cat "$WORK/fill19" 2>/dev/null)"
fi

# Равенство updated — в пользу дерева: main in-progress, дерево backlog.
equal_repo="$WORK/fill-equal"
make_repo "$equal_repo"
mkdir -p "$equal_repo/.kanban/tasks"
printf '{"minTodo": 1}\n' > "$equal_repo/.kanban/board.json"
printf '["sess-a"]\n' > "$equal_repo/.kanban/.workers.json"
write_card "$equal_repo/.kanban/tasks/010.md" 010 in-progress sess-a "2026-10-21T10:00:00Z"
git -C "$equal_repo" worktree add -q -b task/010 "$equal_repo/worktrees/010" HEAD
mkdir -p "$equal_repo/worktrees/010/.kanban/tasks"
write_card "$equal_repo/worktrees/010/.kanban/tasks/010.md" 010 backlog "" "2026-10-21T10:00:00Z"
fill_code=0
( cd "$equal_repo" && ./bin/backlog-fill.sh >"$WORK/fill20" 2>&1 ) || fill_code=$?
equal_status="$(sed -n 's/^status: *//p' "$equal_repo/worktrees/010/.kanban/tasks/010.md" | head -1)"
equal_owner="$(written_owner "$equal_repo/worktrees/010/.kanban/tasks/010.md")"
if [[ "$fill_code" == "0" ]] && [[ "$equal_status" == "todo" ]] && [[ "$equal_owner" == "sess-a" ]] &&
   grep -q "выдано: #010" "$WORK/fill20"; then
  pass "при равном updated выигрывает копия из дерева"
else
  fail "равенство updated: код $fill_code, status '$equal_status', owner '$equal_owner', $(cat "$WORK/fill20" 2>/dev/null)"
fi

echo "== task-assign: асайн конкретной карточки самому свободному"

# Карточка асайна и «нагрузка» считаются по слитому снимку доски: у w1 две
# карточки в конвейере, у w2 ни одной — свободнее w2, хотя в пуле он второй.
assign_repo="$WORK/assign-load"
make_repo "$assign_repo"
mkdir -p "$assign_repo/.kanban/tasks"
printf '["w1","w2"]\n' > "$assign_repo/.kanban/.workers.json"
write_card "$assign_repo/.kanban/tasks/001.md" 001 in-review w1
write_card "$assign_repo/.kanban/tasks/002.md" 002 testing w1
write_card "$assign_repo/.kanban/tasks/010.md" 010 backlog ""
assign_code=0
( cd "$assign_repo" && ./bin/task-assign.sh 010 >"$WORK/assign1" 2>&1 ) || assign_code=$?
assign_owner="$(written_owner "$assign_repo/.kanban/tasks/010.md")"
if [[ "$assign_code" == "0" ]] && [[ "$assign_owner" == "w2" ]] &&
   grep -q "исполнитель: w2" "$WORK/assign1" && grep -q "нагрузки:" "$WORK/assign1"; then
  pass "самый свободный выбирается по нагрузке, а не по порядку пула"
else
  fail "нагрузка: код $assign_code, owner '$assign_owner', $(cat "$WORK/assign1" 2>/dev/null)"
fi

# Равенство нагрузки решает порядок пула: у обоих по одной карточке в конвейере.
tie_repo="$WORK/assign-tie"
make_repo "$tie_repo"
mkdir -p "$tie_repo/.kanban/tasks"
printf '["w1","w2"]\n' > "$tie_repo/.kanban/.workers.json"
write_card "$tie_repo/.kanban/tasks/001.md" 001 in-review w1
write_card "$tie_repo/.kanban/tasks/002.md" 002 testing w2
write_card "$tie_repo/.kanban/tasks/010.md" 010 backlog ""
assign_code=0
( cd "$tie_repo" && ./bin/task-assign.sh 010 >"$WORK/assign2" 2>&1 ) || assign_code=$?
tie_owner="$(written_owner "$tie_repo/.kanban/tasks/010.md")"
if [[ "$assign_code" == "0" ]] && [[ "$tie_owner" == "w1" ]]; then
  pass "при равной нагрузке асайн уходит первому по .workers.json"
else
  fail "равенство нагрузок: код $assign_code, owner '$tie_owner', $(cat "$WORK/assign2" 2>/dev/null)"
fi

# Занятый (есть in-progress) не выбирается, даже если нагрузка у него меньше:
# w1 занят (1 карточка в конвейере), w2 свободен, но нагружен (2) — асайн w2.
busy_repo="$WORK/assign-busy"
make_repo "$busy_repo"
mkdir -p "$busy_repo/.kanban/tasks"
printf '["w1","w2"]\n' > "$busy_repo/.kanban/.workers.json"
write_card "$busy_repo/.kanban/tasks/001.md" 001 in-progress w1
write_card "$busy_repo/.kanban/tasks/002.md" 002 in-review w2
write_card "$busy_repo/.kanban/tasks/003.md" 003 testing w2
write_card "$busy_repo/.kanban/tasks/010.md" 010 backlog ""
assign_code=0
( cd "$busy_repo" && ./bin/task-assign.sh 010 >"$WORK/assign3" 2>&1 ) || assign_code=$?
busy_owner="$(written_owner "$busy_repo/.kanban/tasks/010.md")"
if [[ "$assign_code" == "0" ]] && [[ "$busy_owner" == "w2" ]] &&
   grep -q "занят: есть in-progress" "$WORK/assign3"; then
  pass "занятый исполнитель не выбирается"
else
  fail "занятый: код $assign_code, owner '$busy_owner', $(cat "$WORK/assign3" 2>/dev/null)"
fi

# Все заняты — асайн отклоняется, карточка остаётся в backlog с пустым владельцем.
allbusy_repo="$WORK/assign-allbusy"
make_repo "$allbusy_repo"
mkdir -p "$allbusy_repo/.kanban/tasks"
printf '["w1","w2"]\n' > "$allbusy_repo/.kanban/.workers.json"
write_card "$allbusy_repo/.kanban/tasks/001.md" 001 in-progress w1
write_card "$allbusy_repo/.kanban/tasks/002.md" 002 in-progress w2
write_card "$allbusy_repo/.kanban/tasks/010.md" 010 backlog ""
assign_before="$(cksum "$allbusy_repo/.kanban/tasks/010.md")"
assign_code=0
( cd "$allbusy_repo" && ./bin/task-assign.sh 010 >"$WORK/assign4" 2>&1 ) || assign_code=$?
assign_after="$(cksum "$allbusy_repo/.kanban/tasks/010.md")"
if [[ "$assign_code" == "4" ]] && [[ "$assign_before" == "$assign_after" ]] &&
   grep -q "все заняты" "$WORK/assign4"; then
  pass "все заняты — код 4, карточка осталась в backlog"
else
  fail "все заняты: код $assign_code, $(cat "$WORK/assign4" 2>/dev/null)"
fi

# Пустой пул (нет ни .workers.json, ни .watcher-roles.json) — код 4 с подсказкой,
# даже когда в доске есть владельцы карточек: асайн не должен уходить им, а
# проверка занятости не должна молча отключаться.
emptypool_repo="$WORK/assign-emptypool"
make_repo "$emptypool_repo"
mkdir -p "$emptypool_repo/.kanban/tasks"
write_card "$emptypool_repo/.kanban/tasks/001.md" 001 in-progress w1
write_card "$emptypool_repo/.kanban/tasks/010.md" 010 backlog ""
pool_before="$(cksum "$emptypool_repo/.kanban/tasks/010.md")"
assign_code=0
( cd "$emptypool_repo" && ./bin/task-assign.sh 010 >"$WORK/assign14" 2>&1 ) || assign_code=$?
pool_after="$(cksum "$emptypool_repo/.kanban/tasks/010.md")"
if [[ "$assign_code" == "4" ]] && [[ "$pool_before" == "$pool_after" ]] &&
   grep -q "пул исполнителей пуст" "$WORK/assign14"; then
  pass "пустой пул — код 4, карточка не меняется"
else
  fail "пустой пул: код $assign_code, $(cat "$WORK/assign14" 2>/dev/null)"
fi
# Тот же случай, когда пул есть, но пустой: `.workers.json` = [].
printf '[]\n' > "$emptypool_repo/.kanban/.workers.json"
assign_code=0
( cd "$emptypool_repo" && ./bin/task-assign.sh 010 >"$WORK/assign15" 2>&1 ) || assign_code=$?
if [[ "$assign_code" == "4" ]] && grep -q "пул исполнителей пуст" "$WORK/assign15" &&
   [[ "$(written_owner "$emptypool_repo/.kanban/tasks/010.md")" == "" ]]; then
  pass "пустой .workers.json = [] — код 4, асайна занятому нет"
else
  fail "пустой []: код $assign_code, $(cat "$WORK/assign15" 2>/dev/null)"
fi

# Карточка в рабочем дереве: асайн и коммит уходят в ветку задачи, main не тронут.
tree_assign_repo="$WORK/assign-tree"
make_repo "$tree_assign_repo"
mkdir -p "$tree_assign_repo/.kanban/tasks"
printf '["w1"]\n' > "$tree_assign_repo/.kanban/.workers.json"
git -C "$tree_assign_repo" worktree add -q -b task/030 "$tree_assign_repo/worktrees/030" HEAD
mkdir -p "$tree_assign_repo/worktrees/030/.kanban/tasks"
write_card "$tree_assign_repo/worktrees/030/.kanban/tasks/030.md" 030 backlog ""
assign_code=0
( cd "$tree_assign_repo" && ./bin/task-assign.sh 030 >"$WORK/assign5" 2>&1 ) || assign_code=$?
tree_status="$(written_field "$tree_assign_repo/worktrees/030/.kanban/tasks/030.md" status)"
tree_owner="$(written_owner "$tree_assign_repo/worktrees/030/.kanban/tasks/030.md")"
if [[ "$assign_code" == "0" ]] && [[ "$tree_status" == "todo" ]] && [[ "$tree_owner" == "w1" ]] &&
   [[ ! -e "$tree_assign_repo/.kanban/tasks/030.md" ]] &&
   git -C "$tree_assign_repo/worktrees/030" log --oneline -1 | grep -q "kanban(030): todo"; then
  pass "карточка в рабочем дереве: асайн и коммит в ветке задачи"
else
  fail "асайн в дереве: код $assign_code, status '$tree_status', owner '$tree_owner', $(cat "$WORK/assign5" 2>/dev/null)"
fi

# --unassign: из todo возвращает в backlog и снимает владельца и роль.
unassign_repo="$WORK/assign-unassign"
make_repo "$unassign_repo"
mkdir -p "$unassign_repo/.kanban/tasks"
printf '["w1"]\n' > "$unassign_repo/.kanban/.workers.json"
write_card "$unassign_repo/.kanban/tasks/040.md" 040 todo w1 "" worker
assign_code=0
( cd "$unassign_repo" && ./bin/task-assign.sh 040 --unassign >"$WORK/assign6" 2>&1 ) || assign_code=$?
un_status="$(written_field "$unassign_repo/.kanban/tasks/040.md" status)"
un_owner="$(written_owner "$unassign_repo/.kanban/tasks/040.md")"
un_role="$(written_field "$unassign_repo/.kanban/tasks/040.md" role)"
if [[ "$assign_code" == "0" ]] && [[ "$un_status" == "backlog" ]] &&
   [[ "$un_owner" == "" ]] && [[ "$un_role" == "" ]]; then
  pass "--unassign возвращает карточку в backlog и снимает владельца и роль"
else
  fail "unassign: код $assign_code, status '$un_status', owner '$un_owner', role '$un_role'"
fi

# --unassign из in-progress — отказ, карточка не меняется.
write_card "$unassign_repo/.kanban/tasks/041.md" 041 in-progress w1 "" worker
un_before="$(cksum "$unassign_repo/.kanban/tasks/041.md")"
assign_code=0
( cd "$unassign_repo" && ./bin/task-assign.sh 041 --unassign >"$WORK/assign7" 2>&1 ) || assign_code=$?
un_after="$(cksum "$unassign_repo/.kanban/tasks/041.md")"
if [[ "$assign_code" == "3" ]] && [[ "$un_before" == "$un_after" ]] &&
   grep -q "уже взяли в работу" "$WORK/assign7"; then
  pass "--unassign из in-progress — код 3 и карточка не меняется"
else
  fail "unassign из in-progress: код $assign_code, $(cat "$WORK/assign7" 2>/dev/null)"
fi

# --dry-run ничего не меняет и печатает таблицу нагрузок.
dry_repo="$WORK/assign-dry"
make_repo "$dry_repo"
mkdir -p "$dry_repo/.kanban/tasks"
printf '["w1","w2"]\n' > "$dry_repo/.kanban/.workers.json"
write_card "$dry_repo/.kanban/tasks/001.md" 001 testing w1
write_card "$dry_repo/.kanban/tasks/050.md" 050 backlog ""
dry_before="$(cksum "$dry_repo/.kanban/tasks/050.md"; cd "$dry_repo" && git status --porcelain)"
assign_code=0
( cd "$dry_repo" && ./bin/task-assign.sh 050 --dry-run >"$WORK/assign8" 2>&1 ) || assign_code=$?
dry_after="$(cksum "$dry_repo/.kanban/tasks/050.md"; cd "$dry_repo" && git status --porcelain)"
if [[ "$assign_code" == "0" ]] && [[ "$dry_before" == "$dry_after" ]] &&
   grep -q "выдал бы: #050 → w2" "$WORK/assign8" && grep -q "w1: в конвейере 1" "$WORK/assign8"; then
  pass "--dry-run печатает таблицу нагрузок и ничего не меняет"
else
  fail "dry-run: код $assign_code, $(cat "$WORK/assign8" 2>/dev/null)"
fi

# Пул: fallback на .watcher-roles.json; битый .workers.json — код 1.
fallback_assign_repo="$WORK/assign-fallback"
make_repo "$fallback_assign_repo"
mkdir -p "$fallback_assign_repo/.kanban/tasks"
printf '{"worker":"w-z","reviewer":"r1"}\n' > "$fallback_assign_repo/.kanban/.watcher-roles.json"
write_card "$fallback_assign_repo/.kanban/tasks/060.md" 060 backlog ""
assign_code=0
( cd "$fallback_assign_repo" && ./bin/task-assign.sh 060 >"$WORK/assign9" 2>&1 ) || assign_code=$?
fallback_assign_owner="$(written_owner "$fallback_assign_repo/.kanban/tasks/060.md")"
if [[ "$assign_code" == "0" ]] && [[ "$fallback_assign_owner" == "w-z" ]]; then
  pass "без .workers.json асайн идёт worker из .watcher-roles.json"
else
  fail "fallback асайна: код $assign_code, owner '$fallback_assign_owner', $(cat "$WORK/assign9" 2>/dev/null)"
fi
printf '["w1" "w2"]\n' > "$fallback_assign_repo/.kanban/.workers.json"
write_card "$fallback_assign_repo/.kanban/tasks/061.md" 061 backlog ""
assign_code=0
( cd "$fallback_assign_repo" && ./bin/task-assign.sh 061 >"$WORK/assign10" 2>&1 ) || assign_code=$?
if [[ "$assign_code" == "1" ]] && grep -q "workers.json" "$WORK/assign10"; then
  pass "битый .workers.json — код 1"
else
  fail "битый пул асайна: код $assign_code, $(cat "$WORK/assign10" 2>/dev/null)"
fi

# Карточка не найдена и карточка не в backlog — код 3 с внятным текстом.
status_repo="$WORK/assign-status"
make_repo "$status_repo"
mkdir -p "$status_repo/.kanban/tasks"
printf '["w1"]\n' > "$status_repo/.kanban/.workers.json"
write_card "$status_repo/.kanban/tasks/070.md" 070 todo "" ""
assign_code=0
( cd "$status_repo" && ./bin/task-assign.sh 070 >"$WORK/assign11" 2>&1 ) || assign_code=$?
status_070_before="$(cksum "$status_repo/.kanban/tasks/070.md")"
assign_code2=0
( cd "$status_repo" && ./bin/task-assign.sh 999 >"$WORK/assign12" 2>&1 ) || assign_code2=$?
status_070_after="$(cksum "$status_repo/.kanban/tasks/070.md")"
if [[ "$assign_code" == "3" ]] && grep -q "только из backlog" "$WORK/assign11" &&
   [[ "$assign_code2" == "3" ]] && grep -q "не найдена" "$WORK/assign12" &&
   [[ "$status_070_before" == "$status_070_after" ]]; then
  pass "карточка не из backlog и несуществующая — код 3"
else
  fail "статусы асайна: код $assign_code/код $assign_code2, $(cat "$WORK/assign11" "$WORK/assign12" 2>/dev/null | tr '\n' ' ')"
fi

# Системный bash 3.2 (на macOS это /bin/bash): скрипт должен работать под ним.
write_card "$assign_repo/.kanban/tasks/011.md" 011 backlog ""
if [[ -x /bin/bash ]]; then
  assign_code=0
  ( cd "$assign_repo" && /bin/bash ./bin/task-assign.sh 011 --dry-run >"$WORK/assign13" 2>&1 ) || assign_code=$?
  if [[ "$assign_code" == "0" ]]; then
    pass "task-assign работает под системным /bin/bash"
  else
    fail "task-assign под /bin/bash: код $assign_code, $(cat "$WORK/assign13" 2>/dev/null)"
  fi
fi

echo "== локаль C.UTF-8: мультибайт рядом с переменной и код возврата"

# Класс бага #056: в локали C.UTF-8 системный bash 3.2 съедает мультибайт,
# стоящий сразу после небраced-переменной (пример: "$title" и сразу «), и
# падает с unbound variable. Сканируем статически: такого соседства в bin/*.sh
# быть не должно. Образец намеренно НЕ пишем в комментарии — иначе сканер
# поймает сам себя.
if LC_ALL=C grep -nE '\$([A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])[^ -~]' "$ROOT"/bin/*.sh >"$WORK/locale-scan" 2>&1; then
  fail "мультибайт сразу после небраced-переменной: $(tr '\n' ' ' < "$WORK/locale-scan")"
else
  pass "в bin/*.sh нет мультибайта сразу после небраced-переменной"
fi

# Один и тот же стенд прогоняем под C и C.UTF-8: код и вывод должны совпадать.
# До #056 под C.UTF-8 асайн падал на подписи карточки — и возвращал 0, потому
# что EXIT-ловушка затирала статус.
locale_repo="$WORK/assign-locale"
make_repo "$locale_repo"
mkdir -p "$locale_repo/.kanban/tasks"
printf '["w1","w2"]\n' > "$locale_repo/.kanban/.workers.json"
write_card "$locale_repo/.kanban/tasks/080.md" 080 backlog ""
# Название с «ёлочками»: подпись карточки собирается из заголовка, и раньше
# именно на ней ломался парсер.
awk 'BEGIN { done = 0 }
     done == 0 && /^title:/ { print "title: Задача «на выдачу»"; done = 1; next }
     { print }' "$locale_repo/.kanban/tasks/080.md" > "$locale_repo/.kanban/tasks/080.md.tmp"
mv "$locale_repo/.kanban/tasks/080.md.tmp" "$locale_repo/.kanban/tasks/080.md"
write_card "$locale_repo/.kanban/tasks/081.md" 081 todo ""
locale_busy="$WORK/assign-locale-busy"
make_repo "$locale_busy"
mkdir -p "$locale_busy/.kanban/tasks"
printf '["w1"]\n' > "$locale_busy/.kanban/.workers.json"
write_card "$locale_busy/.kanban/tasks/001.md" 001 in-progress w1
write_card "$locale_busy/.kanban/tasks/082.md" 082 backlog ""

locale_run() { # имя-варианта каталог локалl id [аргументы…]
  local label="$1" repo="$2" loc="$3" id="$4"
  shift 4
  local code=0
  ( cd "$repo" && LC_ALL="$loc" ./bin/task-assign.sh "$id" "$@" >"$WORK/locale-$label" 2>&1 ) || code=$?
  printf '%s' "$code"
}

locale_case() { # описание id ожидаемый-код каталог [аргументы…]
  local what="$1" id="$2" want="$3" repo="$4"
  shift 4
  local code_c code_utf
  code_c="$(locale_run "c-$id" "$repo" C "$id" "$@")"
  code_utf="$(locale_run "utf-$id" "$repo" C.UTF-8 "$id" "$@")"
  if [[ "$code_c" == "$want" ]] && [[ "$code_utf" == "$want" ]]; then
    pass "$what: код $want под C и C.UTF-8"
  else
    fail "$what: под C код $code_c, под C.UTF-8 код $code_utf (ждали $want)"
  fi
  if cmp -s "$WORK/locale-c-$id" "$WORK/locale-utf-$id"; then
    pass "$what: вывод под C и C.UTF-8 совпадает"
  else
    fail "$what: вывод под локалями разный: $(diff "$WORK/locale-c-$id" "$WORK/locale-utf-$id" 2>&1 | head -4 | tr '\n' ' ')"
  fi
}

locale_case "асайн --dry-run" 080 0 "$locale_repo" --dry-run
locale_case "карточка не в backlog" 081 3 "$locale_repo"
locale_case "несуществующая карточка" 999 3 "$locale_repo"
locale_case "все заняты" 082 4 "$locale_busy"

# Подпись карточки не потерялась: заголовок с «ёлочками» доходит до плана.
if grep -q "«на выдачу»" "$WORK/locale-utf-080"; then
  pass "подпись карточки с мультибайтом печатается под C.UTF-8"
else
  fail "подпись карточки под C.UTF-8: $(cat "$WORK/locale-utf-080" 2>/dev/null | tr '\n' ' ')"
fi

# Остальные скрипты набора под UTF-8 локалью: не падают и не врут кодом.
locale_ok() { # описание ожидаемый-код команда…
  local what="$1" want="$2"
  shift 2
  local code=0
  "$@" >"$WORK/locale-misc" 2>&1 || code=$?
  if [[ "$code" == "$want" ]]; then
    pass "$what под C.UTF-8: код $want"
  else
    fail "$what под C.UTF-8: код $code, $(head -3 "$WORK/locale-misc" 2>/dev/null | tr '\n' ' ')"
  fi
}

locale_ok "backlog-fill --dry-run" 0 env LC_ALL=C.UTF-8 bash -c 'cd "$1" && ./bin/backlog-fill.sh --dry-run' _ "$locale_repo"
locale_ok "backlog-fill с битым --min" 2 env LC_ALL=C.UTF-8 bash -c 'cd "$1" && ./bin/backlog-fill.sh --min abc' _ "$locale_repo"
locale_ok "task-assign --help" 0 env LC_ALL=C.UTF-8 "$ROOT/bin/task-assign.sh" --help
locale_ok "task-move --help" 0 env LC_ALL=C.UTF-8 "$ROOT/bin/task-move.sh" --help
locale_ok "task-new --help" 0 env LC_ALL=C.UTF-8 "$ROOT/bin/task-new.sh" --help
if [[ -x "$ROOT/bin/node.sh" ]]; then
  locale_ok "board-status" 0 env LC_ALL=C.UTF-8 bash -c 'cd "$1" && ./bin/board-status.sh' _ "$ROOT"
fi

echo "== .gitignore закрывает служебные файлы доски"
for path in .kanban/.watcher-state.json .kanban/.watcher-roles.json .kanban/.watcher-pending.json .kanban/.workers.json .kanban/worktrees.json worktrees/007; do
  if git -C "$ROOT" check-ignore -q "$path"; then
    pass "служебный путь игнорируется: $path"
  else
    fail "не игнорируется: $path"
  fi
done
for path in .kanban/board.json .kanban/specs/001-backlog.md .kanban/tasks/README.md; do
  if git -C "$ROOT" check-ignore -q "$path"; then
    fail "в .gitignore лишнее: $path"
  else
    pass "рабочий путь виден git: $path"
  fi
done

echo "== коммит задачи: правило сообщения, ключ трекера, закрытый ready → merged"
commit_repo="$WORK/commit"
make_repo "$commit_repo"
( cd "$commit_repo" && ./bin/task-new.sh "Починить экспорт QR" --owner sess-test >/dev/null 2>&1 )
for step in in-progress in-review testing ready; do
  ( cd "$commit_repo/worktrees/001" && ./bin/task-move.sh 001 "$step" --owner sess-test >/dev/null 2>&1 )
done
if grep -q '^status: ready' "$commit_repo/worktrees/001/.kanban/tasks/001.md"; then
  pass "карточка доведена до ready в ветке задачи"
else
  fail "статус в ветке: $(grep '^status:' "$commit_repo/worktrees/001/.kanban/tasks/001.md")"
fi
if ( cd "$commit_repo/worktrees/001" && ./bin/task-move.sh 001 merged >"$WORK/out10" 2>&1 ); then
  fail "task-move не должен пускать ready → merged"
else
  if grep -q "task-commit.sh" "$WORK/out10"; then
    pass "ready → merged закрыт и указывает на task-commit.sh"
  else
    fail "сообщение отказа: $(cat "$WORK/out10")"
  fi
fi
dry="$(cd "$commit_repo" && ./bin/task-commit.sh 001 --message "Починить экспорт QR" --dry-run 2>&1)"
if [[ "$dry" == *"[001] Починить экспорт QR"* ]]; then
  pass "ветка task/001 → короткое имя 001"
else
  fail "dry-run: $dry"
fi
( cd "$commit_repo" && git branch release/NJ-001 task/001 >/dev/null 2>&1 )
dry_key="$(cd "$commit_repo" && ./bin/task-commit.sh 001 --branch release/NJ-001 --dry-run 2>&1)"
if [[ "$dry_key" == *"[NJ-001] Починить экспорт QR"* ]]; then
  pass "ветка release/NJ-001 → короткое имя NJ-001"
else
  fail "dry-run по ключу трекера: $dry_key"
fi
if ( cd "$commit_repo" && ./bin/task-commit.sh 001 --message "Починить экспорт QR" >"$WORK/out11" 2>&1 ); then
  subject="$(git -C "$commit_repo" log --merges -1 --pretty=%s)"
  if [[ "$subject" == "[001] Починить экспорт QR" ]]; then
    pass "merge-коммит с сообщением по правилу"
  else
    fail "сообщение коммита: $subject"
  fi
  if grep -q '^status: merged' "$commit_repo/.kanban/tasks/001.md"; then
    pass "карточка в основном чекауте стала merged"
  else
    fail "статус: $(grep '^status:' "$commit_repo/.kanban/tasks/001.md")"
  fi
  if grep -q "пуш делает человек" "$WORK/out11"; then
    pass "скрипт напоминает, что пуш делает человек"
  else
    fail "нет напоминания про пуш"
  fi
else
  fail "task-commit упал: $(cat "$WORK/out11")"
fi
if ( cd "$commit_repo" && ./bin/task-commit.sh 001 >"$WORK/out12" 2>&1 ); then
  fail "повторный коммит уже влитой задачи не должен проходить"
else
  if grep -q "уже влита" "$WORK/out12"; then
    pass "повторный коммит отвергнут"
  else
    fail "сообщение: $(cat "$WORK/out12")"
  fi
fi

echo "== --no-merge: задача, работа по которой уже в main"
nomerge_repo="$WORK/nomerge"
make_repo "$nomerge_repo"
( cd "$nomerge_repo" && ./bin/task-new.sh "Работа прямо в main" --no-worktree --owner sess-test >/dev/null 2>&1 )
for step in in-progress in-review testing ready; do
  ( cd "$nomerge_repo" && ./bin/task-move.sh 001 "$step" --owner sess-test --role worker >/dev/null 2>&1 )
done
if ( cd "$nomerge_repo" && ./bin/task-commit.sh 001 >"$WORK/out25" 2>&1 ); then
  fail "слияние без ветки не должно проходить"
else
  if grep -q -- "--no-merge" "$WORK/out25"; then
    pass "отсутствие ветки подсказывает --no-merge"
  else
    fail "сообщение: $(cat "$WORK/out25")"
  fi
fi
if ( cd "$nomerge_repo" && ./bin/task-commit.sh 001 --no-merge >"$WORK/out26" 2>&1 ); then
  fail "--no-merge без причины не должен проходить"
else
  if grep -q "требует --reason" "$WORK/out26"; then
    pass "--no-merge требует причину"
  else
    fail "сообщение: $(cat "$WORK/out26")"
  fi
fi
# Забытое значение не должно съедать следующий флаг: --dry-run обязан остаться флагом.
if ( cd "$nomerge_repo" && ./bin/task-commit.sh 001 --no-merge --reason --dry-run >"$WORK/out33" 2>&1 ); then
  fail "забытое значение --reason не должно закрывать карточку"
else
  if grep -q "похоже, текст забыт" "$WORK/out33"; then
    pass "забытое значение --reason отвергнуто"
  else
    fail "сообщение: $(cat "$WORK/out33")"
  fi
fi
if grep -q '^status: ready' "$nomerge_repo/.kanban/tasks/001.md"; then
  pass "после отказа карточка осталась в ready"
else
  fail "статус: $(grep '^status:' "$nomerge_repo/.kanban/tasks/001.md")"
fi
if ( cd "$nomerge_repo" && ./bin/task-commit.sh 001 --message --dry-run >"$WORK/out34" 2>&1 ); then
  fail "--message с забытым значением не должен сливать"
else
  if grep -q "похоже, текст забыт" "$WORK/out34"; then
    pass "--message с забытым значением отвергнут"
  else
    fail "сообщение: $(cat "$WORK/out34")"
  fi
fi
# Контроль: форма ФЛАГ=ЗНАЧЕНИЕ пропускает значение, начинающееся с дефиса.
if ( cd "$nomerge_repo" && ./bin/task-commit.sh 001 --no-merge --reason=--dry-run --dry-run >"$WORK/out35" 2>&1 ); then
  if grep -q "слияния не будет" "$WORK/out35" && grep -q "причина: --dry-run" "$WORK/out35" &&
     grep -q '^status: ready' "$nomerge_repo/.kanban/tasks/001.md"; then
    pass "значение с дефисом проходит формой ФЛАГ=ЗНАЧЕНИЕ"
  else
    fail "контроль: $(cat "$WORK/out35")"
  fi
else
  fail "контроль упал: $(cat "$WORK/out35")"
fi

dry_nomerge="$(cd "$nomerge_repo" && ./bin/task-commit.sh 001 --no-merge --reason "работа уже в main" --dry-run 2>&1)"
if [[ "$dry_nomerge" == *"слияния не будет"* && "$dry_nomerge" == *"работа уже в main"* && "$dry_nomerge" != *"сообщение коммита"* ]]; then
  pass "dry-run честно говорит, что слияния не будет"
else
  fail "dry-run в режиме --no-merge: $dry_nomerge"
fi
if ( cd "$nomerge_repo" && ./bin/task-commit.sh 001 --no-merge --reason "работа уже в main: правки в 9c213a0" >"$WORK/out27" 2>&1 ); then
  if grep -q '^status: merged' "$nomerge_repo/.kanban/tasks/001.md" && grep -q "закрыто без слияния" "$nomerge_repo/.kanban/tasks/001.md"; then
    pass "--no-merge закрывает карточку и пишет причину"
  else
    fail "статус или причина в карточке не записаны"
  fi
  if [[ -z "$(git -C "$nomerge_repo" log --merges --oneline)" ]]; then
    pass "при --no-merge слияния не было"
  else
    fail "появился merge-коммит"
  fi
else
  fail "--no-merge упал: $(cat "$WORK/out27")"
fi

if ( cd "$nomerge_repo" && ./bin/task-commit.sh 001 --reason "не к месту" >"$WORK/out29" 2>&1 ); then
  fail "--reason без --no-merge не должен проходить"
else
  if grep -q "только с --no-merge" "$WORK/out29"; then
    pass "--reason без --no-merge отвергнут"
  else
    fail "сообщение: $(cat "$WORK/out29")"
  fi
fi
if ( cd "$nomerge_repo" && ./bin/task-commit.sh 001 --no-merge --reason "" >"$WORK/out30" 2>&1 ); then
  fail "пустая причина не должна проходить"
else
  if grep -q "требует --reason" "$WORK/out30"; then
    pass "пустая причина отвергнута без bash-ошибки"
  else
    fail "сообщение: $(cat "$WORK/out30")"
  fi
fi
if ( cd "$nomerge_repo" && ./bin/task-commit.sh 001 --no-merge --reason "   " >"$WORK/out31" 2>&1 ); then
  fail "причина из пробелов не должна проходить"
else
  if grep -q "требует --reason" "$WORK/out31"; then
    pass "причина из пробелов отвергнута"
  else
    fail "сообщение: $(cat "$WORK/out31")"
  fi
fi

# Пробельное сообщение не должно давать коммит с пустым subject.
blank_repo="$WORK/blankmessage"
make_repo "$blank_repo"
( cd "$blank_repo" && ./bin/task-new.sh "Заголовок из карточки" --owner sess-test >/dev/null 2>&1 )
for step in in-progress in-review testing ready; do
  ( cd "$blank_repo/worktrees/001" && ./bin/task-move.sh 001 "$step" --owner sess-test --role worker >/dev/null 2>&1 )
done
if ( cd "$blank_repo" && ./bin/task-commit.sh 001 --message="   " >"$WORK/out49" 2>&1 ); then
  fail "пробельное сообщение не должно сливать задачу"
else
  if grep -q "состоит из пробелов" "$WORK/out49"; then
    pass "пробельное --message отвергнуто, как и пробельная причина"
  else
    fail "сообщение: $(cat "$WORK/out49")"
  fi
fi
if ( cd "$blank_repo" && ./bin/task-commit.sh 001 --message="" >"$WORK/out52" 2>&1 ); then
  subject="$(git -C "$blank_repo" log --merges -1 --pretty=%s)"
  if [[ "$subject" == *"Заголовок из карточки"* ]]; then
    pass "пустое --message берёт заголовок карточки"
  else
    fail "subject: $subject"
  fi
else
  fail "task-commit упал на пустом сообщении: $(cat "$WORK/out52")"
fi

# Пробельный статус не должен мешать слиянию: task-move.sh его терпит, значит и
# task-commit.sh обязан (расхождение между скриптами и было предметом карточки).
trim_repo="$WORK/trimstatus"
make_repo "$trim_repo"
mkdir -p "$trim_repo/.kanban/tasks"
printf -- "---\nid: \"001\"\ntitle: Пробел в кавычках\nstatus: \"ready \"\n---\n" > "$trim_repo/.kanban/tasks/001.md"
printf -- "---\nid: \"002\"\ntitle: Пробел вне кавычек\nstatus: ready \n---\n" > "$trim_repo/.kanban/tasks/002.md"
if ( cd "$trim_repo" && ./bin/task-commit.sh 001 --no-merge --reason "проба" >"$WORK/out50" 2>&1 ); then
  if grep -q '^status: merged' "$trim_repo/.kanban/tasks/001.md"; then
    pass "статус ready с хвостовым пробелом в кавычках сливается"
  else
    fail "карточка не стала merged"
  fi
else
  fail "статус с пробелом в кавычках: $(head -1 "$WORK/out50")"
fi
if ( cd "$trim_repo" && ./bin/task-commit.sh 002 --no-merge --reason "проба" >"$WORK/out51" 2>&1 ); then
  if grep -q '^status: merged' "$trim_repo/.kanban/tasks/002.md"; then
    pass "статус ready с хвостовым пробелом вне кавычек сливается"
  else
    fail "карточка не стала merged"
  fi
else
  fail "статус с пробелом вне кавычек: $(head -1 "$WORK/out51")"
fi

# Ветка уже влита: слияния и коммита не будет, но карточка закрывается честно.
ancestor_repo="$WORK/ancestor"
make_repo "$ancestor_repo"
( cd "$ancestor_repo" && ./bin/task-new.sh "Уже влита" --owner sess-test >/dev/null 2>&1 )
( cd "$ancestor_repo/worktrees/001" && ./bin/task-move.sh 001 in-progress --owner sess-test --role worker >/dev/null 2>&1 )
for step in in-review testing ready; do
  ( cd "$ancestor_repo/worktrees/001" && ./bin/task-move.sh 001 "$step" >/dev/null 2>&1 )
done
git -C "$ancestor_repo" merge --no-ff task/001 -m "ручное слияние" >/dev/null 2>&1
if ( cd "$ancestor_repo" && ./bin/task-commit.sh 001 --dry-run >"$WORK/out53" 2>&1 ); then
  if grep -q "слияния не будет" "$WORK/out53" && ! grep -q "сообщение коммита" "$WORK/out53"; then
    pass "сухой прогон не обещает коммит для уже влитой ветки"
  else
    fail "dry-run: $(tr '\n' ' ' < "$WORK/out53")"
  fi
else
  fail "dry-run упал: $(cat "$WORK/out53")"
fi
# Коммит самой карточки при смене статуса — законный; слияния быть не должно.
before_merges="$(git -C "$ancestor_repo" log --merges --oneline | wc -l | tr -d ' ')"
if ( cd "$ancestor_repo" && ./bin/task-commit.sh 001 >"$WORK/out54" 2>&1 ); then
  after_merges="$(git -C "$ancestor_repo" log --merges --oneline | wc -l | tr -d ' ')"
  if [[ "$before_merges" == "$after_merges" ]] && grep -q '^status: merged' "$ancestor_repo/.kanban/tasks/001.md"; then
    pass "уже влитая ветка закрывает карточку без коммита-слияния"
  else
    fail "merge-коммитов $before_merges → $after_merges"
  fi
else
  fail "task-commit упал: $(cat "$WORK/out54")"
fi
if ( cd "$ancestor_repo" && ./bin/task-commit.sh 001 --no-merge --message "лишнее" --reason "проба" >"$WORK/out55" 2>&1 ); then
  fail "--message вместе с --no-merge принят молча"
else
  if grep -q "никуда не пойдёт" "$WORK/out55"; then
    pass "--message с --no-merge отвергнут"
  else
    fail "сообщение: $(cat "$WORK/out55")"
  fi
fi

branch_repo="$WORK/branchguess"
make_repo "$branch_repo"
( cd "$branch_repo" && ./bin/task-new.sh "Обычная задача с веткой" --owner sess-test >/dev/null 2>&1 )
for step in in-progress in-review testing ready; do
  ( cd "$branch_repo/worktrees/001" && ./bin/task-move.sh 001 "$step" --owner sess-test --role worker >/dev/null 2>&1 )
done
if ( cd "$branch_repo" && ./bin/task-commit.sh 001 --no-merge --reason "проверка" >"$WORK/out28" 2>&1 ); then
  fail "--no-merge не должен работать при существующей ветке"
else
  if grep -q "существует" "$WORK/out28"; then
    pass "--no-merge отвергает существующую ветку задачи"
  else
    fail "сообщение: $(cat "$WORK/out28")"
  fi
fi
# --branch не должен прятать нес слитую ветку задачи от проверки.
if ( cd "$branch_repo" && ./bin/task-commit.sh 001 --no-merge --reason "уже в main" --branch task/опечатка >"$WORK/out32" 2>&1 ); then
  fail "--branch не должен обходить проверку ветки задачи"
else
  if grep -q "task/001 существует" "$WORK/out32"; then
    pass "--no-merge видит ветку задачи и при чужом --branch"
  else
    fail "сообщение: $(cat "$WORK/out32")"
  fi
fi
dry_nomerge_branch="$(cd "$branch_repo" && ./bin/task-commit.sh 001 --no-merge --reason "проверка" --branch task/опечатка --dry-run 2>&1)"
if [[ "$dry_nomerge_branch" == *"task/001 существует"* ]]; then
  pass "dry-run тоже видит ветку задачи при чужом --branch"
else
  fail "dry-run: $dry_nomerge_branch"
fi

echo "== расход токенов и защита от перехвата задачи"
usage_home="$WORK/usage-home"
mkdir -p "$usage_home/storages/session_projcache/sessions"
for session_id in sess-test sess-owner sess-reviewer; do
  printf '%s\n' '{"version":1,"record":{"rows":{"tokenUsage":{"seq":7,"val":{"totals":{"uncachedInputTokens":1000,"outputTokens":2000,"cacheReadTokens":3000,"cacheWriteTokens":0}}}}}}' \
    > "$usage_home/storages/session_projcache/sessions/$session_id.json"
done
usage="$(DSH_HOME="$usage_home" "$ROOT/bin/task-usage.sh" sess-test 2>/dev/null)"
if [[ "$usage" == "6000" ]]; then
  pass "task-usage складывает счётчики (6000)"
else
  fail "task-usage вернул: $usage"
fi

guard_repo="$WORK/guard"
make_repo "$guard_repo"
( cd "$guard_repo" && ./bin/task-new.sh "Закреплённая задача" --owner sess-owner >/dev/null 2>&1 )
# Незакреплённую карточку не берут ни с чужой ролью, ни без имени вовсе.
( cd "$guard_repo" && ./bin/task-new.sh "Свободная задача" >/dev/null 2>&1 )
if ( cd "$guard_repo/worktrees/002" && env -u DSH_SESSION_ID ./bin/task-move.sh 002 in-progress >"$WORK/out19" 2>&1 ); then
  fail "без --owner задачу брать нельзя"
else
  if grep -q "не знаю, кто берёт" "$WORK/out19"; then
    pass "без имени исполнителя задача не берётся"
  else
    fail "сообщение: $(cat "$WORK/out19")"
  fi
fi
if ( cd "$guard_repo/worktrees/002" && ./bin/task-move.sh 002 in-progress --owner sess-anyone >"$WORK/out20" 2>&1 ); then
  fail "незакреплённую задачу брать нельзя"
else
  if grep -q "не закреплена" "$WORK/out20"; then
    pass "незакреплённая задача не берётся"
  else
    fail "сообщение: $(cat "$WORK/out20")"
  fi
  if grep -q -- "--owner" "$WORK/out20"; then
    fail "подсказка отказа печатает готовую команду и учит обходу"
  else
    pass "подсказка отказа не печатает команду"
  fi
fi
if ( cd "$guard_repo/worktrees/002" && ./bin/task-move.sh 002 in-progress --owner sess-anyone --force >/dev/null 2>&1 ); then
  pass "--force берёт незакреплённую задачу"
else
  fail "--force не сработал"
fi
# Возврат из ревью: чужая роль возвращает карточку без --force и без смены владельца.
assign_repo="$WORK/return"
make_repo "$assign_repo"
( cd "$assign_repo" && ./bin/task-new.sh "Задача на возврат" --owner sess-worker >/dev/null 2>&1 )
( cd "$assign_repo/worktrees/001" && ./bin/task-move.sh 001 in-progress --owner sess-worker --role worker >/dev/null 2>&1 )
( cd "$assign_repo/worktrees/001" && DSH_HOME="$usage_home" DSH_SESSION_ID=sess-worker \
    ./bin/task-move.sh 001 in-review --role worker --tokens auto >/dev/null 2>&1 )
return_card="$assign_repo/worktrees/001/.kanban/tasks/001.md"
if ( cd "$assign_repo/worktrees/001" && DSH_HOME="$usage_home" DSH_SESSION_ID=sess-reviewer \
     ./bin/task-move.sh 001 in-progress --role reviewer --tokens auto \
     --note "вернуть: пункт 1, пункт 2" >"$WORK/out22" 2>&1 ); then
  pass "ревьювер вернул карточку без --force"
else
  fail "возврат из ревью отклонён: $(cat "$WORK/out22")"
fi
if grep -q '^status: in-progress' "$return_card"; then pass "карточка вернулась в in-progress"; else fail "статус: $(grep '^status:' "$return_card")"; fi
if grep -q '^owner: sess-worker' "$return_card"; then pass "владелец остался исполнителем"; else fail "owner: $(grep '^owner:' "$return_card")"; fi
if grep -q '^role: worker' "$return_card"; then pass "роль снова worker"; else fail "role: $(grep '^role:' "$return_card")"; fi
if grep -q '^tokens_reviewer: ' "$return_card"; then pass "расход ревьювера записан"; else fail "нет tokens_reviewer"; fi

echo "== выдача задач: перезапись владельца, fallback и порядок проверок"
owner_repo="$WORK/owner"
make_repo "$owner_repo"
( cd "$owner_repo" && ./bin/task-new.sh "Закреплённая задача" --owner sess-owner >/dev/null 2>&1 )
if ( cd "$owner_repo/worktrees/001" && ./bin/task-move.sh 001 todo --owner sess-thief >"$WORK/out23" 2>&1 ); then
  fail "чужой владелец не должен переписываться"
else
  if grep -q "владелец меняется только" "$WORK/out23"; then
    pass "смена владельца чужой карточки отвергнута"
  else
    fail "сообщение: $(cat "$WORK/out23")"
  fi
fi
if ( cd "$owner_repo/worktrees/001" && ./bin/task-move.sh 001 todo --owner sess-owner >/dev/null 2>&1 ); then
  pass "владелец переписывает свой owner без --force"
else
  fail "владелец не смог переписать свой owner"
fi
if ( cd "$owner_repo/worktrees/001" && DSH_SESSION_ID=sess-owner ./bin/task-move.sh 001 in-progress >/dev/null 2>&1 ); then
  pass "взятие задачи по \$DSH_SESSION_ID без --owner"
else
  fail "fallback на \$DSH_SESSION_ID не сработал"
fi

quoted_repo="$WORK/quoted"
make_repo "$quoted_repo"
( cd "$quoted_repo" && ./bin/task-new.sh "Кавычка в owner" >/dev/null 2>&1 )
( cd "$quoted_repo/worktrees/001" && ./bin/task-move.sh 001 todo --owner 'a"b' >/dev/null 2>&1 )
if ( cd "$quoted_repo/worktrees/001" && ./bin/task-move.sh 001 in-progress --owner 'a"b' >/dev/null 2>&1 ); then
  pass "owner с кавычкой читается после снятия экранирования"
else
  fail "владелец с кавычкой не смог взять карточку"
fi

owner_repo="$WORK/ownerforms"
make_repo "$owner_repo"
mkdir -p "$owner_repo/.kanban/tasks"
printf -- "---\nid: \"001\"\ntitle: Одинарные кавычки\nstatus: todo\nowner: 'sess-A'\n---\n" > "$owner_repo/.kanban/tasks/001.md"
printf -- "---\nid: \"002\"\ntitle: Ведущий пробел\nstatus: todo\nowner: \"  sess-A\"\n---\n" > "$owner_repo/.kanban/tasks/002.md"
printf -- "---\nid: \"003\"\ntitle: В работе без владельца\nstatus: in-progress\nowner: \"\"\n---\n" > "$owner_repo/.kanban/tasks/003.md"
if ( cd "$owner_repo" && ./bin/task-move.sh 001 in-progress --owner sess-A >/dev/null 2>&1 ); then
  pass "owner в одинарных кавычках читается"
else
  fail "владелец в одинарных кавычках не смог взять карточку"
fi
if ( cd "$owner_repo" && ./bin/task-move.sh 002 in-progress --owner sess-A >/dev/null 2>&1 ); then
  pass "ведущий пробел в owner снимается"
else
  fail "владелец с ведущим пробелом не смог взять карточку"
fi
if ( cd "$owner_repo" && ./bin/task-move.sh 003 in-progress --owner sess-thief >"$WORK/out48" 2>&1 ); then
  fail "карточку в работе без владельца нельзя дописать себе"
else
  if grep -q "не закреплена" "$WORK/out48"; then
    pass "карточка в работе без владельца не дописывается чужаком"
  else
    fail "сообщение: $(cat "$WORK/out48")"
  fi
fi
if ( cd "$owner_repo" && ./bin/task-move.sh 003 in-progress --owner sess-owner --force >/dev/null 2>&1 ); then
  pass "--force берёт карточку в работе без владельца"
else
  fail "--force не сработал на карточке без владельца"
fi

reassign_repo="$WORK/reassign"
make_repo "$reassign_repo"
( cd "$reassign_repo" && ./bin/task-new.sh "Переназначение" --owner sess-A >/dev/null 2>&1 )
if ( cd "$reassign_repo/worktrees/001" && ./bin/task-move.sh 001 todo --owner sess-B >"$WORK/out25" 2>&1 ); then
  fail "переназначение без --force не должно проходить"
else
  if grep -q "владелец меняется только" "$WORK/out25"; then
    pass "переназначение без --force отвергнуто"
  else
    fail "сообщение: $(cat "$WORK/out25")"
  fi
fi
if ( cd "$reassign_repo/worktrees/001" && ./bin/task-move.sh 001 todo --owner sess-B --force >/dev/null 2>&1 ) &&
   grep -q '^owner: sess-B' "$reassign_repo/worktrees/001/.kanban/tasks/001.md"; then
  pass "--force переназначает задачу другой сессии"
else
  fail "переназначение через --force не сработало"
fi

blocked_repo="$WORK/blocked"
make_repo "$blocked_repo"
( cd "$blocked_repo" && ./bin/task-new.sh "Блокировка" --owner sess-owner >/dev/null 2>&1 )
( cd "$blocked_repo/worktrees/001" && ./bin/task-move.sh 001 in-progress --owner sess-owner --role worker >/dev/null 2>&1 )
( cd "$blocked_repo/worktrees/001" && ./bin/task-move.sh 001 blocked --note "ждём человека" >/dev/null 2>&1 )
if ( cd "$blocked_repo/worktrees/001" && ./bin/task-move.sh 001 in-progress --owner sess-thief >"$WORK/out26" 2>&1 ); then
  fail "чужак не должен снимать блокировку"
else
  if grep -q "закреплена за sess-owner" "$WORK/out26"; then
    pass "снятие чужой блокировки отвергнуто"
  else
    fail "сообщение: $(cat "$WORK/out26")"
  fi
fi
if ( cd "$blocked_repo/worktrees/001" && ./bin/task-move.sh 001 in-progress --owner sess-owner >/dev/null 2>&1 ); then
  pass "владелец снимает блокировку"
else
  fail "владелец не смог снять блокировку"
fi

space_repo="$WORK/space"
make_repo "$space_repo"
mkdir -p "$space_repo/.kanban/tasks"
printf -- '---\nid: "001"\ntitle: Пробел в статусе\nstatus: "todo "\nowner: sess-owner\nupdated: ""\n---\n' > "$space_repo/.kanban/tasks/001.md"
if ( cd "$space_repo" && ./bin/task-move.sh 001 in-progress --owner sess-thief >/dev/null 2>&1 ); then
  fail "статус с хвостовым пробелом не должен обходить guard"
else
  pass "хвостовой пробел в статусе больше не обходит guard"
fi

merged_repo="$WORK/merged"
make_repo "$merged_repo"
mkdir -p "$merged_repo/.kanban/tasks"
printf -- '---\nid: "001"\ntitle: Слитая\nstatus: merged\nowner: ""\nupdated: ""\n---\n' > "$merged_repo/.kanban/tasks/001.md"
if ( cd "$merged_repo" && ./bin/task-move.sh 001 in-progress >"$WORK/out24" 2>&1 ); then
  fail "merged → in-progress не должен проходить"
else
  if grep -q "недопустимый переход: merged → in-progress" "$WORK/out24"; then
    pass "сначала проверяется переход, потом владелец"
  else
    fail "сообщение: $(cat "$WORK/out24")"
  fi
fi
if ( cd "$guard_repo/worktrees/001" && ./bin/task-move.sh 001 in-progress --owner sess-other >"$WORK/out13" 2>&1 ); then
  fail "чужую закреплённую задачу брать нельзя"
else
  if grep -q "закреплена за sess-owner" "$WORK/out13"; then
    pass "перехват закреплённой задачи отвергнут"
  else
    fail "сообщение отказа: $(cat "$WORK/out13")"
  fi
fi
if ( cd "$guard_repo/worktrees/001" && DSH_HOME="$usage_home" DSH_SESSION_ID=sess-owner \
     ./bin/task-move.sh 001 in-progress --owner sess-owner --role worker --tokens auto >/dev/null 2>&1 ); then
  pass "владелец берёт свою задачу и пишет расход"
else
  fail "владелец не смог взять задачу"
fi
guard_card="$guard_repo/worktrees/001/.kanban/tasks/001.md"
if grep -q '^tokens_worker: 6000' "$guard_card"; then pass "расход роли записан"; else fail "tokens_worker: $(grep '^tokens' "$guard_card")"; fi
if grep -q '^tokens: 6000' "$guard_card"; then pass "суммарный расход посчитан"; else fail "tokens: $(grep '^tokens:' "$guard_card")"; fi
if grep -q '^since: ' "$guard_card"; then pass "метка since записана"; else fail "since не записан"; fi

echo "== синхронизация набора: перенос, удаление, --check"
sync_src="$WORK/sync-src"; sync_dst="$WORK/sync-dst"
mkdir -p "$sync_src/bin" "$sync_src/.kanban/tasks" "$sync_dst/bin"
cp "$ROOT/bin/sync-from-awg.sh" "$sync_src/bin/sync-from-awg.sh"
cp "$ROOT/bin/sync-from-awg.sh" "$sync_dst/bin/sync-from-awg.sh"
chmod +x "$sync_src/bin/sync-from-awg.sh" "$sync_dst/bin/sync-from-awg.sh"
printf 'one' > "$sync_src/bin/one.sh"
printf 'two' > "$sync_src/bin/two.sh"
printf 'readme' > "$sync_src/.kanban/tasks/README.md"
if ( cd "$sync_dst" && ./bin/sync-from-awg.sh --from "$sync_src" >"$WORK/out41" 2>&1 ); then
  if [[ -f "$sync_dst/bin/one.sh" && -f "$sync_dst/bin/two.sh" && -f "$sync_dst/.kanban/tasks/README.md" ]]; then
    pass "перенос из источника копирует файлы набора"
  else
    fail "после переноса не все файлы на месте"
  fi
else
  fail "перенос упал: $(cat "$WORK/out41")"
fi
printf 'лишний' > "$sync_dst/bin/only-here.sh"
rm "$sync_src/bin/two.sh"
# Удаление лишнего делает rsync --delete: без него скрипт предупреждает и копирует
# без удаления, поэтому проверка не имеет смысла, а не «падает».
if ! command -v rsync >/dev/null 2>&1; then
  echo "   пропуск: удаление лишнего и совпадение после него требуют rsync (его нет в PATH)"
else
  ( cd "$sync_dst" && ./bin/sync-from-awg.sh --from "$sync_src" >/dev/null 2>&1 )
  if [[ -f "$sync_dst/bin/two.sh" || -f "$sync_dst/bin/only-here.sh" ]]; then
    fail "перенос не убрал то, чего нет в источнике"
  else
    pass "перенос убирает то, чего нет в источнике"
  fi
  # Без rsync лишнее осталось бы в приёмнике, и --check честно сказал бы про
  # расхождение — поэтому и эта проверка относится к сценарию с удалением.
  if ( cd "$sync_dst" && ./bin/sync-from-awg.sh --from "$sync_src" --check >/dev/null 2>&1 ); then
    pass "после переноса --check видит совпадение"
  else
    fail "--check не видит совпадение сразу после переноса"
  fi
fi
printf 'правка' >> "$sync_dst/bin/one.sh"
if ( cd "$sync_dst" && ./bin/sync-from-awg.sh --from "$sync_src" --check >"$WORK/out42" 2>&1 ); then
  fail "--check не заметил расхождение"
else
  if grep -q "bin" "$WORK/out42"; then
    pass "--check называет разошедшийся путь"
  else
    fail "сообщение: $(cat "$WORK/out42")"
  fi
fi
if ( cd "$sync_dst" && ./bin/sync-from-awg.sh --from "$WORK/нет-такого" --check >"$WORK/out43" 2>&1 ); then
  pass "отсутствующий источник не ломает проверку"
else
  fail "отсутствующий источник дал ошибку: $(cat "$WORK/out43")"
fi

echo "== таблица файлов в KANBAN.md не врёт"
# Смотрим только таблицу раздела «Что лежит в проекте»: в других таблицах
# встречаются команды и голые имена файлов, и проверка путей к ним не относится.
missing=""; checked=0
while IFS= read -r row; do
  first="$(printf '%s' "$row" | sed -e 's/^| //' -e 's/ |.*$//')"
  for path in $(printf '%s' "$first" | grep -o '`[^`]*`' | tr -d '`'); do
    case "$path" in *"{"*|*"*"*) continue ;; esac
    checked=$((checked + 1))
    [[ -e "$ROOT/$path" ]] || missing="$missing $path"
  done
done < <(awk '/^## Что лежит в проекте/{inside=1; next} inside && /^## /{exit} inside && /^\| `/{print}' "$ROOT/KANBAN.md")
if (( checked == 0 )); then
  fail "проверка таблицы файлов извлекла 0 путей: она ничего не проверяет"
elif [[ -z "$missing" ]]; then
  pass "все пути из таблицы файлов существуют (проверено $checked)"
else
  fail "в таблице файлов есть несуществующие пути:$missing"
fi

code=0
( cd "$sync_dst" && ./bin/sync-from-awg.sh --from --check >"$WORK/out62" 2>&1 ) || code=$?
if [[ "$code" == "2" ]] && grep -q "начинается с «-»" "$WORK/out62"; then
  pass "--from --check отвергнут: путь забыт"
else
  fail "код $code, вывод: $(head -1 "$WORK/out62")"
fi
code=0
( cd "$sync_dst" && ./bin/sync-from-awg.sh --from=--check >"$WORK/out63" 2>&1 ) || code=$?
if [[ "$code" == "0" ]] && grep -q "источник набора не найден" "$WORK/out63"; then
  pass "--from=--check остаётся честным значением"
else
  fail "код $code, вывод: $(head -1 "$WORK/out63")"
fi
code=0
( cd "$sync_dst" && ./bin/sync-from-awg.sh --from= >"$WORK/out57" 2>&1 ) || code=$?
if [[ "$code" == "2" ]] && grep -q "требует значения" "$WORK/out57"; then
  pass "пустой --from= тоже отвергнут"
else
  fail "код $code, вывод: $(head -1 "$WORK/out57")"
fi
code=0
( cd "$sync_dst" && ./bin/sync-from-awg.sh --from >"$WORK/out56" 2>&1 ) || code=$?
if [[ "$code" == "2" ]] && grep -q "требует значения" "$WORK/out56"; then
  pass "--from без значения: код 2 и подсказка"
else
  fail "код $code, вывод: $(head -1 "$WORK/out56")"
fi

echo "== дамп доски"
if "$ROOT/bin/board-status.sh" >"$WORK/out58" 2>&1; then
  if grep -q "^доска:" "$WORK/out58" && grep -q "in-review" "$WORK/out58" && grep -q "^  #[0-9]" "$WORK/out58"; then
    pass "дамп доски печатает колонки и карточки"
  else
    fail "неожиданный вывод: $(head -3 "$WORK/out58")"
  fi
else
  fail "дамп доски упал: $(cat "$WORK/out58")"
fi
# Фикстура самодостаточна: карточка в main и одноимённая в работе — как в проекте.
dump_repo="$WORK/dumprepo"
mkdir -p "$dump_repo/.kanban/tasks" "$dump_repo/worktrees/001/.kanban/tasks"
printf -- "---\nid: \"001\"\nstatus: todo\ntitle: Карточка в ветке\n---\n" > "$dump_repo/.kanban/tasks/001.md"
printf -- "---\nid: \"001\"\nstatus: in-progress\ntitle: Карточка в ветке\nowner: sess-a\nrole: worker\n---\n" > "$dump_repo/worktrees/001/.kanban/tasks/001.md"
if "$ROOT/bin/board-status.sh" --root "$dump_repo" >"$WORK/out59" 2>&1 && grep -q "в ветке" "$WORK/out59" && grep -q "in-progress" "$WORK/out59"; then
  pass "карточка из worktree помечена «в ветке» и берётся её статус"
else
  fail "нет отметки ветки: $(head -3 "$WORK/out59")"
fi
# Работа уже в main, а worktree забыли убрать: свежая запись побеждает, как на доске.
printf -- "---\nid: \"001\"\nstatus: merged\ntitle: Карточка в ветке\nupdated: 2026-10-15T10:00:00Z\n---\n" > "$dump_repo/.kanban/tasks/001.md"
printf -- "---\nid: \"001\"\nstatus: in-progress\ntitle: Карточка в ветке\nupdated: 2026-10-14T10:00:00Z\n---\n" > "$dump_repo/worktrees/001/.kanban/tasks/001.md"
if "$ROOT/bin/board-status.sh" --root "$dump_repo" >"$WORK/out62" 2>&1 && grep -q "\[merged\]" "$WORK/out62"; then
  pass "старая копия из ветки не перебивает свежую карточку main"
else
  fail "статус взят из ветки: $(grep '#001' "$WORK/out62" | head -1)"
fi
if "$ROOT/bin/board-status.sh" --help >"$WORK/out63" 2>&1 && grep -q "bin/board-status.sh --root" "$WORK/out63"; then
  pass "у дампа есть справка"
else
  fail "справка: $(head -1 "$WORK/out63")"
fi
# Доска терпима к статусам: дамп обязан показывать те же колонки.
printf -- "---\nid: \"003\"\nstatus: \"ready \"\ntitle: Пробельный статус\n---\n" > "$dump_repo/.kanban/tasks/003.md"
printf -- "---\nid: \"004\"\nstatus: wip\ntitle: Синоним\n---\n" > "$dump_repo/.kanban/tasks/004.md"
if "$ROOT/bin/board-status.sh" --root "$dump_repo" --json >"$WORK/out64" 2>&1; then
  columns="$("$ROOT/bin/node.sh" -e "const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));const m={};for(const c of d.cards)m[c.id]=c.status;console.log([m['003'],m['004']].join(','))" "$WORK/out64")"
  if [[ "$columns" == "ready,in-progress" ]]; then
    pass "дамп нормализует статус как доска (ready с пробелом, wip)"
  else
    fail "колонки: $columns"
  fi
else
  fail "json упал: $(head -1 "$WORK/out64")"
fi
code=0
"$ROOT/bin/board-status.sh" --root --json >"$WORK/out65" 2>&1 || code=$?
if [[ "$code" == "2" ]] && grep -q "начинается с «-»" "$WORK/out65"; then
  pass "дефисное значение --root отвергнуто с подсказкой"
else
  fail "код $code, вывод: $(head -1 "$WORK/out65")"
fi
if "$ROOT/bin/board-status.sh" --json >"$WORK/out60" 2>&1 &&
  "$ROOT/bin/node.sh" -e "const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); if(!Array.isArray(d.cards)||!d.cards.length) process.exit(1)" "$WORK/out60"; then
  pass "--json отдаёт карточки машинно"
else
  fail "json: $(head -2 "$WORK/out60")"
fi
code=0
"$ROOT/bin/board-status.sh" --root >"$WORK/out61" 2>&1 || code=$?
if [[ "$code" == "2" ]] && grep -q "требует значения" "$WORK/out61"; then
  pass "--root без значения: код 2 и подсказка"
else
  fail "код $code, вывод: $(head -1 "$WORK/out61")"
fi

echo "== таблица файлов не отстаёт от набора"
# Проверяем те же строки таблицы, что и выше: файл набора, которого в ней нет, —
# такая же ошибка, как путь, которого нет на диске (#033). Внутренние проверки
# набора в таблицу не входят: их видно из bin/test.sh.
table="$(awk '/^## Что лежит в проекте/{inside=1; next} inside && /^## /{exit} inside{print}' "$ROOT/KANBAN.md")"
unlisted=""
for path in $(cd "$ROOT" && ls bin/* dsh-kanban/lib/*.js dsh-kanban/test/*.mjs dsh-kanban/docs/*.mjs dsh-kanban/docs/*.py 2>/dev/null); do
  case "$path" in
    bin/test-scripts.sh) continue ;;
  esac
  printf '%s' "$table" | grep -q "\`$path\`" || unlisted="$unlisted $path"
done
if [[ -z "$unlisted" ]]; then
  pass "каждый файл набора упомянут в таблице"
else
  fail "в таблице не упомянуты:$unlisted"
fi

# Сверка не должна краснеть из-за чужой незакоммиченной работы в источнике (#034).
dirty_src="$WORK/dirty-src"; dirty_dst="$WORK/dirty-dst"
for dir in "$dirty_src" "$dirty_dst"; do
  mkdir -p "$dir/bin"
  git -C "$dir" init -q >/dev/null 2>&1
  cp "$ROOT/bin/sync-from-awg.sh" "$dir/bin/sync-from-awg.sh"
  chmod +x "$dir/bin/sync-from-awg.sh"
done
printf 'версия 1\n' > "$dirty_src/bin/one.sh"
printf 'общий файл\n' > "$dirty_src/bin/two.sh"
git -C "$dirty_src" add -A >/dev/null 2>&1
if ! git -C "$dirty_src" -c user.email=t@t -c user.name=t commit -qm "версия 1" >/dev/null 2>&1; then
  fail "не удалось подготовить источник для проверки сверки"
fi
if ! git -C "$dirty_src" cat-file -e HEAD:bin/one.sh 2>/dev/null; then
  fail "в источнике нет зафиксированного bin/one.sh — проверка была бы ложной"
fi
cp "$dirty_src/bin/one.sh" "$dirty_dst/bin/one.sh"
cp "$dirty_src/bin/two.sh" "$dirty_dst/bin/two.sh"
printf 'незакоммиченная правка\n' > "$dirty_src/bin/one.sh"
if ( cd "$dirty_dst" && ./bin/sync-from-awg.sh --from "$dirty_src" --check >"$WORK/out66" 2>&1 ); then
  if grep -q "незакоммиченных" "$WORK/out66"; then
    pass "сверка не краснеет из-за незакоммиченной работы источника"
  else
    pass "сверка прошла (о незакоммиченном не сообщено)"
  fi
else
  fail "сверка покраснела: $(tr '\n' ' ' < "$WORK/out66")"
fi
# Расхождение проверяем на закоммиченном пути: незакоммиченный справедливо пропускается.
# Перенос из грязного источника, затем сверка: незакоммиченное у источника не шумит.
if ( cd "$dirty_dst" && ./bin/sync-from-awg.sh --from "$dirty_src" >/dev/null 2>&1 ) &&
   ( cd "$dirty_dst" && ./bin/sync-from-awg.sh --from "$dirty_src" --check >"$WORK/out68" 2>&1 ); then
  pass "после переноса из грязного источника сверка зелёная"
else
  fail "сверка после переноса: $(tr '\n' ' ' < "$WORK/out68")"
fi
printf 'версия 2\n' > "$dirty_dst/bin/two.sh"
code=0
( cd "$dirty_dst" && ./bin/sync-from-awg.sh --from "$dirty_src" --check >"$WORK/out67" 2>&1 ) || code=$?
if [[ "$code" == "1" ]] && grep -q "bin" "$WORK/out67"; then
  pass "настоящее расхождение по-прежнему ловится"
else
  fail "код $code, вывод: $(tr '\n' ' ' < "$WORK/out67")"
fi

echo "== набор совпадает с проектом-источником"
if "$ROOT/bin/sync-from-awg.sh" --check >"$WORK/out40" 2>&1; then
  pass "$(head -1 "$WORK/out40")"
else
  fail "$(tr '\n' '; ' < "$WORK/out40")"
fi

echo "== пресеты ролей: генерация строк и установка в патч-слой профиля"
preset_home="$WORK/preset-home"
mkdir -p "$preset_home/profiles/demo"
printf '[]\n' > "$preset_home/profiles/demo/cordis.patch.yml"
if "$ROOT/bin/gen-role-presets.sh" --standard "$ROOT/test/fixtures/standard.patch.yml" \
     --personas "$ROOT/agent-presets" --out "$WORK/role-presets.patch.yml" >"$WORK/out20" 2>&1; then
  rows=$(grep -c 'id: preset-' "$WORK/role-presets.patch.yml")
  if [[ "$rows" == "4" ]]; then pass "сгенерированы строки четырёх ролей"; else fail "строк пресетов: $rows"; fi
  if grep -q "Ты исполнитель" "$WORK/role-presets.patch.yml"; then
    pass "персона роли попала в строку"
  else
    fail "в строке нет персоны роли"
  fi
  if grep -q '!!js' "$WORK/role-presets.patch.yml"; then
    pass "js-условия шаблона сохранены"
  else
    fail "потеряны !!js-условия"
  fi
else
  fail "генерация пресетов упала: $(cat "$WORK/out20")"
fi
if "$ROOT/bin/gen-role-presets.sh" --standard "$ROOT/test/fixtures/standard-two-inserts.patch.yml" \
     --out "$WORK/bad-inserts.yml" >"$WORK/out44" 2>&1; then
  fail "шаблон с двумя блоками '- insert:' должен быть отвергнут"
else
  if grep -q "insert" "$WORK/out44"; then
    pass "шаблон с двумя блоками '- insert:' отвергнут"
  else
    fail "сообщение: $(cat "$WORK/out44")"
  fi
fi
if "$ROOT/bin/gen-role-presets.sh" --standard "$ROOT/test/fixtures/standard-two-prefixes.patch.yml" \
     --out "$WORK/bad-prefixes.yml" >"$WORK/out45" 2>&1; then
  fail "шаблон с двумя персонами должен быть отвергнут"
else
  if grep -q "prefix" "$WORK/out45"; then
    pass "шаблон с двумя персонами отвергнут"
  else
    fail "сообщение: $(cat "$WORK/out45")"
  fi
fi
if "$ROOT/bin/gen-role-presets.sh" --out "$WORK/role-presets-check.yml" >"$WORK/out46" 2>&1; then
  if cmp -s "$WORK/role-presets-check.yml" "$ROOT/presets/role-presets.patch.yml"; then
    pass "артефакт воспроизводится из встроенного шаблона"
  else
    fail "артефакт разошёлся со встроенным шаблоном: перегенерируйте bin/gen-role-presets.sh"
  fi
elif grep -q "не нашёл встроенный" "$WORK/out46"; then
  pass "встроенный шаблон недоступен — воспроизводимость не проверялась"
else
  fail "генератор упал: $(cat "$WORK/out46")"
fi
if "$ROOT/bin/install-presets.sh" --rows "$WORK/role-presets.patch.yml" \
     --profiles-dir "$preset_home/profiles" --profile demo >"$WORK/out21" 2>&1; then
  if grep -q "preset-worker" "$preset_home/profiles/demo/cordis.patch.yml"; then
    pass "строки установлены в патч-слой профиля"
  else
    fail "в патч-слое нет preset-worker"
  fi
else
  fail "установка пресетов упала: $(cat "$WORK/out21")"
fi
"$ROOT/bin/install-presets.sh" --rows "$WORK/role-presets.patch.yml" \
  --profiles-dir "$preset_home/profiles" --profile demo >/dev/null 2>&1
blocks=$(grep -c "пресеты ролей (bin/install-presets.sh)" "$preset_home/profiles/demo/cordis.patch.yml")
if [[ "$blocks" == "1" ]]; then pass "повторная установка идемпотентна"; else fail "блоков пресетов: $blocks"; fi
if "$ROOT/bin/install-presets.sh" --rows "$WORK/role-presets.patch.yml" \
     --profiles-dir "$preset_home/profiles" --profile ghost >/dev/null 2>&1; then
  fail "установка в несуществующий профиль должна падать"
else
  pass "несуществующий профиль даёт понятный отказ"
fi
# Недоступный патч-слой: понятное сообщение вместо трейсбека Python.
mkdir -p "$preset_home/profiles/readonly"
printf '[]\n' > "$preset_home/profiles/readonly/cordis.patch.yml"
chmod 444 "$preset_home/profiles/readonly/cordis.patch.yml"
if "$ROOT/bin/install-presets.sh" --rows "$WORK/role-presets.patch.yml" \
     --profiles-dir "$preset_home/profiles" --profile readonly >"$WORK/out47" 2>&1; then
  fail "запись в недоступный патч-слой не должна проходить"
else
  if grep -q "Traceback" "$WORK/out47"; then
    fail "установщик напечатал трейсбек вместо сообщения"
  else
    if grep -q "не удалось записать" "$WORK/out47"; then
      pass "недоступный патч-слой даёт понятное сообщение"
    else
      fail "сообщение: $(cat "$WORK/out47")"
    fi
  fi
fi
chmod 644 "$preset_home/profiles/readonly/cordis.patch.yml"

echo "== node без PATH: резолвер bin/node.sh"
if node_path="$(PATH=/usr/bin:/bin "$ROOT/bin/node.sh" --which 2>/dev/null)" && [[ -x "$node_path" ]]; then
  pass "node найден вне PATH: $node_path"
else
  fail "node.sh не нашёл Node при урезанном PATH"
fi
node_output="$(PATH=/usr/bin:/bin "$ROOT/bin/node.sh" -e 'process.stdout.write("ok")' 2>/dev/null || true)"
if [[ "$node_output" == "ok" ]]; then
  pass "node.sh выполняет код"
else
  fail "node.sh не выполнил код: $node_output"
fi
app_node="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node"
if [[ -x "$app_node" ]]; then
  chosen="$(DSH_NODE="$app_node" PATH=/usr/bin:/bin "$ROOT/bin/node.sh" --which 2>/dev/null)"
  if [[ "$chosen" == "$app_node" ]]; then
    pass "DSH_NODE имеет приоритет"
  else
    fail "DSH_NODE проигнорирован: $chosen"
  fi
fi
if DSH_NODE=/nonexistent "$ROOT/bin/node.sh" --which >"$WORK/out-node" 2>&1; then
  fail "несуществующий DSH_NODE должен приводить к отказу"
else
  if grep -q "DSH_NODE" "$WORK/out-node"; then
    pass "несуществующий DSH_NODE даёт понятный отказ"
  else
    fail "сообщение: $(cat "$WORK/out-node")"
  fi
fi

echo "== install-kanban: штатная установка и защита от двойного ряда"
kanban_home="$WORK/kanban-home"
mkdir -p "$kanban_home/profiles/demo"
printf '%s\n' '{"name":"dsh-profile-demo","private":true,"dependencies":{},"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base"]}}}' \
  > "$kanban_home/profiles/demo/package.json"
cat > "$kanban_home/profiles/demo/cordis.patch.yml" <<'YAML'
# Канбан-доска агентских задач (пакет dsh-kanban).
- insert:
    - id: ui-kanban
      name: 'dsh-kanban'
YAML
if DSH_HOME="$kanban_home" PATH="/usr/bin:/bin" "$ROOT/bin/install-kanban.sh" demo >"$WORK/out16" 2>&1; then
  fail "install-kanban не должен ставить бандл поверх ручного ряда"
else
  if grep -q "вставлен вручную" "$WORK/out16"; then
    pass "двойной ряд отвергнут с объяснением"
  else
    fail "сообщение: $(cat "$WORK/out16")"
  fi
fi
if DSH_HOME="$kanban_home" PATH="/usr/bin:/bin" "$ROOT/bin/install-kanban.sh" demo --takeover >"$WORK/out17" 2>&1; then
  manifest="$kanban_home/profiles/demo/package.json"
  if python3 - "$manifest" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    data = json.load(handle)
deps = data.get("dependencies") or {}
bundles = ((data.get("dsh") or {}).get("profile") or {}).get("bundles") or []
ok = str(deps.get("dsh-kanban", "")).startswith("link:") and "dsh-kanban" in bundles
sys.exit(0 if ok else 1)
PY
  then
    pass "зависимость link: и бандл записаны в манифест профиля"
  else
    fail "манифест: $(cat "$manifest")"
  fi
  if [[ -L "$kanban_home/profiles/demo/node_modules/dsh-kanban" ]]; then
    pass "симлинк на пакет создан"
  else
    fail "нет симлинка node_modules/dsh-kanban"
  fi
  if grep -q "ui-kanban" "$kanban_home/profiles/demo/cordis.patch.yml"; then
    fail "ручной ряд остался в cordis.patch.yml"
  else
    pass "ручной ряд убран из cordis.patch.yml"
  fi
else
  fail "install-kanban --takeover упал: $(cat "$WORK/out17")"
fi
if DSH_HOME="$kanban_home" PATH="/usr/bin:/bin" "$ROOT/bin/install-kanban.sh" demo >"$WORK/out18" 2>&1 &&
   grep -q "уже объявлен" "$WORK/out18"; then
  pass "повторная установка идемпотентна"
else
  fail "повторный запуск: $(cat "$WORK/out18")"
fi

echo
if (( failures == 0 )); then
  echo "scripts: все проверки прошли (оболочка: $("$SYS_BASH" --version | head -1))"
else
  echo "scripts: провалов $failures" >&2
  exit 1
fi
