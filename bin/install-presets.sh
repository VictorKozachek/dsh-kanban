#!/usr/bin/env bash
#
# Поставить пресеты ролей в патч-слой профиля DSH.
#
#   bin/install-presets.sh [--profile ИМЯ] [--profiles-dir DIR] [--rows ФАЙЛ] [--dry-run]
#
# Почему так: в DSH 0.1.7 пресет — это строка композиции профиля
# (`@deepseek-ai/dsh-agent-preset`), и персональные пресеты Web-редактор пишет
# именно в патч-слой профиля (`~/.dsh/profiles/<профиль>/cordis.patch.yml`).
# Старый формат каталогом `~/.dsh/.agent-presets` эта версия не читает — в GUI
# такие пресеты не появляются.
#
# Строки берутся из presets/role-presets.patch.yml (генерируется
# bin/gen-role-presets.sh). Блок в патч-слое помечен маркерами и перезаписывается
# целиком, поэтому повторный запуск ничего не дублирует.
#
# По умолчанию: профиль desktop, каталог профилей $DSH_HOME/profiles.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="desktop"
ROWS="$ROOT/presets/role-presets.patch.yml"
PROFILES_DIR="${DSH_HOME:-$HOME/.dsh}/profiles"
DRY_RUN=0

usage() {
  sed -n '3,/^set -euo pipefail/p' "$0" | sed -e 's/^# \{0,1\}//' -e '$d'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="${2:?--profile требует значения}"; shift 2 ;;
    --profile=*) PROFILE="${1#*=}"; shift ;;
    --profiles-dir) PROFILES_DIR="${2:?--profiles-dir требует значения}"; shift 2 ;;
    --profiles-dir=*) PROFILES_DIR="${1#*=}"; shift ;;
    --rows) ROWS="${2:?--rows требует значения}"; shift 2 ;;
    --rows=*) ROWS="${1#*=}"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "неизвестная опция: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ ! -f "$ROWS" ]]; then
  cat >&2 <<MSG
нет файла со строками пресетов: $ROWS

сначала сгенерируйте его из встроенного стандарта:
  bin/gen-role-presets.sh
MSG
  exit 1
fi

PROFILE_DIR="$PROFILES_DIR/$PROFILE"
if [[ ! -d "$PROFILE_DIR" ]]; then
  echo "профиль '$PROFILE' не инициализирован: нет $PROFILE_DIR" >&2
  echo "запустите профиль один раз (или укажите --profiles-dir)" >&2
  exit 1
fi

PATCH="$PROFILE_DIR/cordis.patch.yml"

if (( DRY_RUN == 1 )); then
  echo "профиль: $PROFILE"
  echo "патч-слой: $PATCH"
  echo "строки пресетов: $ROWS"
  grep -c 'id: preset-' "$ROWS" | sed 's/^/строк в файле: /'
  exit 0
fi

command -v python3 >/dev/null 2>&1 || { echo "нужен python3" >&2; exit 1; }

ROWS="$ROWS" PATCH="$PATCH" python3 - <<'PY'
import os
import re
import sys
from pathlib import Path

BEGIN = "# >>> пресеты ролей (bin/install-presets.sh) — не правьте вручную"
END = "# <<< пресеты ролей"

rows = Path(os.environ["ROWS"]).read_text(encoding="utf-8")
body = "\n".join(line for line in rows.splitlines() if not line.startswith("#")).strip("\n")
block = f"{BEGIN}\n{body}\n{END}\n"

patch = Path(os.environ["PATCH"])
text = patch.read_text(encoding="utf-8") if patch.exists() else ""
pattern = re.compile(re.escape(BEGIN) + r".*?" + re.escape(END) + r"\n?", re.S)

if pattern.search(text):
    text = pattern.sub(block, text)
    action = "обновлён"
else:
    rest = "\n".join(
        line for line in text.splitlines() if not line.strip().startswith("#")
    ).strip()
    if rest in ("", "[]"):
        # пустой слой: подсказки-комментарии сохраняем, содержимое заменяем блоком
        header = "\n".join(line for line in text.splitlines() if line.strip().startswith("#"))
        text = (header + "\n\n" if header else "") + block
    else:
        if not text.endswith("\n"):
            text += "\n"
        text += "\n" + block
    action = "добавлен"

try:
    patch.write_text(text, encoding="utf-8")
except OSError as error:
    print(f"не удалось записать патч-слой {patch}: {error}", file=sys.stderr)
    print(
        "профиль лежит вне рабочей директории сессии: запустите установщик из сессии, "
        "чья рабочая директория — этот профиль, либо с полными правами",
        file=sys.stderr,
    )
    sys.exit(1)
print(f"{action} блок пресетов ролей: {patch}")
PY

cat <<MSG

Готово. Дальше:
  1. перезапустите профиль, если пресеты не появились сразу — патч-слой
     применяется живьём, но список пресетов клиент читает при открытии окна:
       приложение: закрыть и открыть; DSH Web: перезапустить
  2. пресет выбирается при создании сессии (у пустой сессии его ещё можно сменить)
MSG
