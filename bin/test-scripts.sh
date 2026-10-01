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
    "$ROOT/bin/task-commit.sh" "$ROOT/bin/task-usage.sh" bin/ &&
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
