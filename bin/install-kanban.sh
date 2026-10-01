#!/usr/bin/env bash
#
# Поставить доску в профиль DSH.
#
#   bin/install-kanban.sh [профиль] [--takeover]
#
#   профиль     имя профиля DSH; по умолчанию web
#   --takeover  убрать ручной ряд ui-kanban из cordis.patch.yml профиля и
#               перейти на штатную установку бандлом
#
# Штатный путь: пакет объявляет dsh.bundle, поэтому `dsh plugin add` дописывает
# его в dsh.profile.bundles профиля, а cordis.patch.yml пакета вставляет
# Loader-ряд. Руками править cordis.patch.yml профиля не нужно.
#
# Профиль `desktop` управляется Electron-приложением: `dsh plugin` для него
# отказывается работать, поэтому скрипт делает то же самое сам — зависимость
# link:<путь>, запись в dsh.profile.bundles и симлинк в node_modules профиля.
#
# Двойной ряд ui-kanban (бандл плюс ручная вставка) — ошибка: плагин смонтируется
# дважды. Поэтому при ручном ряде скрипт останавливается и предлагает --takeover.
#
# Новый пакет читается при старте профиля: DSH Web перезапускают (`dsh web`),
# приложение — закрывают и открывают заново.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="$ROOT/dsh-kanban"
PROFILE="web"
TAKEOVER=0

usage() {
  sed -n '3,/^set -euo pipefail/p' "$0" | sed -e 's/^# \{0,1\}//' -e '$d'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --takeover) TAKEOVER=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "неизвестная опция: $1" >&2; usage >&2; exit 2 ;;
    *) PROFILE="$1"; shift ;;
  esac
done

HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$HOME_DIR/profiles/$PROFILE"
MANIFEST="$PROFILE_DIR/package.json"
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"

if [[ ! -f "$PLUGIN_DIR/package.json" ]]; then
  echo "не найден пакет плагина: $PLUGIN_DIR" >&2
  exit 1
fi
if [[ ! -f "$MANIFEST" ]]; then
  echo "профиль '$PROFILE' не инициализирован: нет $MANIFEST" >&2
  echo "запустите профиль один раз или создайте его через 'dsh plugin --profile $PROFILE add <пакет>'" >&2
  exit 1
fi

# --- уже объявлен зависимостью и бандлом? -----------------------------------
already=0
if python3 - "$MANIFEST" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    manifest = json.load(handle)
deps = manifest.get("dependencies") or {}
bundles = ((manifest.get("dsh") or {}).get("profile") or {}).get("bundles") or []
sys.exit(0 if "dsh-kanban" in deps and "dsh-kanban" in bundles else 1)
PY
then
  already=1
fi

# --- ручной ряд в патч-слое профиля? ----------------------------------------
if [[ -f "$PATCH_FILE" ]] && grep -q 'ui-kanban' "$PATCH_FILE"; then
  if (( TAKEOVER == 0 )); then
    cat >&2 <<'MSG'
в cordis.patch.yml профиля уже есть ряд ui-kanban — он вставлен вручную.

Штатная установка добавит второй ряд (из бандла), и плагин смонтируется дважды:
две копии таба, две регистрации. Выберите одно:

  * оставить ручную установку — тогда ничего не делайте;
  * перейти на штатную — bin/install-kanban.sh <профиль> --takeover
    (скрипт уберёт ручной ряд и объявит пакет зависимостью профиля).
MSG
    exit 1
  fi
  echo "убираю ручной ряд ui-kanban из $PATCH_FILE"
  python3 - "$PATCH_FILE" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
lines = path.read_text(encoding="utf-8").splitlines()
out = []
index = 0
removed = 0
while index < len(lines):
    line = lines[index]
    if line.strip() == "- insert:":
        block = [line]
        index += 1
        # Тело блока — вложенные строки и пустые разделители.
        while index < len(lines) and (lines[index].startswith("    ") or lines[index].strip() == ""):
            block.append(lines[index])
            index += 1
        if any("ui-kanban" in item for item in block):
            removed += 1
            # Заодно убираем комментарий, который относился к этому ряду.
            while out and out[-1].lstrip().startswith("#") and (
                "kanban" in out[-1].lower() or "канбан" in out[-1].lower()
            ):
                out.pop()
            while out and out[-1].strip() == "":
                out.pop()
            continue
        out.extend(block)
        continue
    out.append(line)
    index += 1

if removed == 0:
    sys.exit("ручной ряд ui-kanban не найден построчно — правьте файл руками")

text = "\n".join(out)
path.write_text(text if text.endswith("\n") or text == "" else text + "\n", encoding="utf-8")
print(f"удалено блоков: {removed}")
PY
fi

# --- установка ---------------------------------------------------------------
if (( already == 1 )); then
  echo "пакет уже объявлен зависимостью и бандлом профиля '$PROFILE' — установку пропускаю"
else
  manual=0
  if command -v dsh >/dev/null 2>&1; then
    err=""
    if err="$(dsh plugin --profile "$PROFILE" add "$PLUGIN_DIR" 2>&1)"; then
      printf '%s\n' "$err"
    elif [[ "$err" == *"managed exclusively"* ]]; then
      echo "профиль '$PROFILE' управляется приложением — ставлю пакет сам"
      manual=1
    else
      printf '%s\n' "$err" >&2
      echo "не удалось: dsh plugin завершился с ошибкой" >&2
      exit 1
    fi
  else
    echo "команда dsh не найдена в PATH — ставлю пакет сам"
    manual=1
  fi

  if (( manual == 1 )); then
    mkdir -p "$PROFILE_DIR/node_modules"
    ln -sfn "$PLUGIN_DIR" "$PROFILE_DIR/node_modules/dsh-kanban"
    python3 - "$MANIFEST" "$PLUGIN_DIR" <<'PY'
import json
import sys
from pathlib import Path

manifest_path, plugin_dir = Path(sys.argv[1]), sys.argv[2]
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
dependencies = manifest.setdefault("dependencies", {})
dependencies["dsh-kanban"] = f"link:{plugin_dir}"
profile = manifest.setdefault("dsh", {}).setdefault("profile", {})
bundles = profile.setdefault("bundles", [])
if "dsh-kanban" not in bundles:
    bundles.append("dsh-kanban")
# Тот же формат, что пишет сам DSH: два пробела, перевод строки в конце.
manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print("манифест профиля обновлён: зависимость link: и бандл dsh-kanban")
PY
  fi
fi

echo
if command -v dsh >/dev/null 2>&1 && dsh --profile "$PROFILE" --dump-config 2>/dev/null | grep -q kanban; then
  echo "ряд ui-kanban виден в собранном дереве профиля."
else
  echo "проверьте ряд после перезапуска профиля:"
  echo "  dsh --profile $PROFILE --dump-config | grep -n kanban"
fi

cat <<EOF

Готово. Дальше:
  1. перезапустите профиль — новый пакет читается при старте:
       DSH Web:   dsh web
       приложение: закрыть и открыть заново
  2. откройте правый сайдбар (кнопка в шапке разговора) и добавьте таб «Канбан»;
     либо через «+» → страница-гид → «Канбан»
  3. доска читает <рабочая директория сессии>/.kanban/tasks/*.md

Если pnpm не смог поставить локальный пакет (например, нет сети для peer-зависимостей),
добавьте зависимость вручную:
  cd $PROFILE_DIR && pnpm add "link:$PLUGIN_DIR"
EOF
