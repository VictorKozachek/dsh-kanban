#!/usr/bin/env bash
#
# Сгенерировать пресеты ролей из встроенного пресета `standard`.
#
#   bin/gen-role-presets.sh [--standard ФАЙЛ] [--personas DIR] [--out ФАЙЛ] [--json ФАЙЛ]
#
# Зачем: в DSH 0.1.7 пресет — это СТРОКА композиции профиля
# (`@deepseek-ai/dsh-agent-preset` с config.id/order/plugins), а не каталог
# `~/.dsh/.agent-presets` (тот формат понимали прежние версии, и приложение его
# просто не читает). Поэтому роли собираются так: берём встроенный
# `standard.patch.yml`, клонируем его строку на каждую роль и подменяем персону
# из `agent-presets/<роль>/persona.txt`, а имя и описание — из `preset.yml`.
#
# Источник standard.patch.yml ищется так:
#   1. --standard <файл>;
#   2. <dshHome>/profiles[/<профиль>]/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml;
#   3. внутри приложения DSH (asar) — его же Node в режиме Node.
#
# Результаты по умолчанию:
#   presets/role-presets.patch.yml — legacy-слой профиля (ставится
#     bin/install-presets.sh; остаётся для совместимости);
#   dsh-kanban/presets/role-presets.json — определения ролей для самолечения
#     плагина (#062): их регистрирует host-половина при старте, поэтому
#     обновление профиля больше не «снимает» пресеты. Артефакт лежит ВНУТРИ
#     пакета плагина — только так он едет вместе с плагином в любой профиль.
#     YAML-тег `!!js expr` в JSON — узел {"__jsExpr": "expr"}: реестр пресетов
#     интерполирует его так же.
# Для JSON нужен python3 с PyYAML (без него — понятная ошибка с подсказкой).
# Перегенерировать после обновления DSH.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STANDARD=""
PERSONAS="$ROOT/agent-presets"
OUT="$ROOT/presets/role-presets.patch.yml"
JSON_OUT=""

usage() {
  sed -n '3,/^set -euo pipefail/p' "$0" | sed -e 's/^# \{0,1\}//' -e '$d'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --standard) STANDARD="${2:?--standard требует значения}"; shift 2 ;;
    --standard=*) STANDARD="${1#*=}"; shift ;;
    --personas) PERSONAS="${2:?--personas требует значения}"; shift 2 ;;
    --personas=*) PERSONAS="${1#*=}"; shift ;;
    --out) OUT="${2:?--out требует значения}"; shift 2 ;;
    --out=*) OUT="${1#*=}"; shift ;;
    --json) JSON_OUT="${2:?--json требует значения}"; shift 2 ;;
    --json=*) JSON_OUT="${1#*=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "неизвестная опция: $1" >&2; usage >&2; exit 2 ;;
  esac
done

HOME_DIR="${DSH_HOME:-$HOME/.dsh}"

if [[ -z "$STANDARD" ]]; then
  for candidate in \
    "$HOME_DIR/profiles/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml" \
    "$HOME_DIR"/profiles/*/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml; do
    if [[ -f "$candidate" ]]; then STANDARD="$candidate"; break; fi
  done
fi

TEMP_STANDARD=""
if [[ -z "$STANDARD" ]]; then
  # Приложение держит пакеты внутри asar: читаем файл его же Node (Electron в
  # режиме Node умеет читать asar, обычный node — нет).
  APP_BIN="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
  ASAR_FILE="/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml"
  if [[ -x "$APP_BIN" ]]; then
    TEMP_STANDARD="$(mktemp "${TMPDIR:-/tmp}/standard.patch.XXXXXX.yml")"
    if ELECTRON_RUN_AS_NODE=1 "$APP_BIN" -e \
      'const fs=require("fs"); fs.writeFileSync(process.argv[1], fs.readFileSync(process.argv[2]))' \
      "$TEMP_STANDARD" "$ASAR_FILE" 2>/dev/null; then
      STANDARD="$TEMP_STANDARD"
    fi
  fi
fi

if [[ -z "$STANDARD" || ! -f "$STANDARD" ]]; then
  cat >&2 <<'MSG'
не нашёл встроенный standard.patch.yml.

Укажите его явно (лежит в пакете @deepseek-ai/dsh-web-app/presets/):
  bin/gen-role-presets.sh --standard /путь/к/standard.patch.yml
MSG
  exit 1
fi

command -v python3 >/dev/null 2>&1 || { echo "нужен python3" >&2; exit 1; }
mkdir -p "$(dirname "$OUT")"

# JSON живёт в пакете плагина: host-половина читает его от import.meta.url, и
# только внутри пакета он переживает установку/обновление профиля. Тесты и
# стенды передают --json явно во временный каталог и репозиторный артефакт не
# перезаписывают.
if [[ -z "$JSON_OUT" ]]; then
  if [[ "$OUT" == "$ROOT/presets/role-presets.patch.yml" ]]; then
    JSON_OUT="$ROOT/dsh-kanban/presets/role-presets.json"
  else
    JSON_OUT="$(dirname "$OUT")/role-presets.json"
  fi
fi

STANDARD="$STANDARD" PERSONAS="$PERSONAS" OUT="$OUT" JSON_OUT="$JSON_OUT" python3 - <<'PY'
import json
import os
import re
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    sys.exit(
        "для JSON-артефакта нужен PyYAML: python3 -m pip install --user pyyaml "
        "(или системный python3 с PyYAML); без него собирается только YAML"
    )

ROLES = [("dispatcher", 10), ("worker", 11), ("reviewer", 12), ("verifier", 13)]
PREFIX_LINE = re.compile(r"^(?P<indent> +)prefix: .*$", re.M)

standard = Path(os.environ["STANDARD"])
personas = Path(os.environ["PERSONAS"])
out_path = Path(os.environ["OUT"])
json_path = Path(os.environ["JSON_OUT"])

body = standard.read_text(encoding="utf-8")

# Форма шаблона проверяется явно: генератор клонирует РОВНО одну строку пресета с
# одной персоной. Если во встроенном файле появится второй блок или вторая
# персона, честнее остановиться, чем собрать пресеты с чужим содержимым.
inserts = body.count("- insert:")
if inserts != 1:
    sys.exit(f"в {standard} блоков '- insert:' — {inserts}, а генератор рассчитан на один: форма шаблона изменилась")
start = body.find("- insert:")
body = body[start:]
personas_found = list(PREFIX_LINE.finditer(body))
if len(personas_found) != 1:
    sys.exit(f"в {standard} строк 'prefix:' у персоны — {len(personas_found)}, а нужна одна: форма шаблона изменилась")


def read_meta(directory: Path) -> tuple:
    name = description = ""
    preset = directory / "preset.yml"
    if preset.exists():
        for line in preset.read_text(encoding="utf-8").splitlines():
            if line.startswith("name:"):
                name = line.split(":", 1)[1].strip()
            elif line.startswith("description:"):
                description = line.split(":", 1)[1].strip()
    return name, description


def build_role(role: str, order: int, name: str, description: str) -> str:
    text = body
    for old, new in (
        ("- id: preset-standard", f"- id: preset-{role}"),
        ("\n        id: standard\n", f"\n        id: {role}\n"),
        ("\n        order: 1\n", f"\n        order: {order}\n"),
    ):
        if text.count(old) != 1:
            sys.exit(f"в шаблоне не одно вхождение: {old!r}")
        text = text.replace(old, new)
    extra = ""
    if name:
        extra += f'\n        name: "{name}"'
    if description:
        extra += f'\n        description: "{description}"'
    if extra:
        text = text.replace(f"\n        order: {order}\n", f"\n        order: {order}{extra}\n")

    match = PREFIX_LINE.search(text)
    if match is None:
        sys.exit(f"в {standard} нет строки prefix: у персоны")
    indent = match.group("indent")
    persona_lines = [
        f'{indent}  {line}'.rstrip()
        for line in (personas / role / "persona.txt").read_text(encoding="utf-8").strip().splitlines()
    ]
    text = text[: match.start()] + "\n".join([f"{indent}prefix: >-", *persona_lines]) + text[match.end():]
    return text.strip("\n") + "\n"


header = (
    "# Пресеты ролей для DSH: собраны из встроенного `standard` (подменена только\n"
    "# персона). Файл генерируется: bin/gen-role-presets.sh\n"
    "# Ставится в патч-слой профиля: bin/install-presets.sh --profile desktop\n"
)
chunks = [header]
for role, order in ROLES:
    if not (personas / role / "persona.txt").exists():
        sys.exit(f"нет персоны: {personas / role / 'persona.txt'}")
    name, description = read_meta(personas / role)
    chunks.append(build_role(role, order, name, description))

text = "\n".join(chunks)
out_path.write_text(text, encoding="utf-8")

# ── JSON-артефакт: те же определения, форма реестра пресетов ─────────────────
# YAML-тег `!!js expr` в JSON становится узлом {"__jsExpr": "expr"} — это
# штатная форма диалекта entry-list: реестр пресетов интерполирует её
# рекурсивно (dsh-agent-preset-registry, isJsExpr/evaluateExpression).
class PresetLoader(yaml.SafeLoader):
    pass


def js_constructor(loader, node):
    return {"__jsExpr": loader.construct_scalar(node)}


PresetLoader.add_constructor("tag:yaml.org,2002:js", js_constructor)

parsed = yaml.load(text, Loader=PresetLoader)
definitions = []
for entry in parsed or []:
    rows = entry.get("insert") if isinstance(entry, dict) else None
    if not rows:
        continue
    for row in rows:
        config = row.get("config") if isinstance(row, dict) else None
        if isinstance(config, dict):
            definitions.append(config)

if len(definitions) != len(ROLES):
    sys.exit(f"в YAML-артефакте {len(definitions)} определений, а ролей {len(ROLES)}")
for (role, order), definition in zip(ROLES, definitions):
    if definition.get("id") != role or definition.get("order") != order:
        sys.exit(f"JSON: роль {role} с order {order} не совпала с YAML ({definition.get('id')}/{definition.get('order')})")
    if not definition.get("plugins"):
        sys.exit(f"JSON: у роли {role} пустой список plugins")

json_path.parent.mkdir(parents=True, exist_ok=True)
json_path.write_text(json.dumps(definitions, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"готово: {out_path} (роли: {', '.join(role for role, _ in ROLES)})")
print(f"готово: {json_path} (определения: {len(definitions)})")
PY

if [[ -n "$TEMP_STANDARD" ]]; then rm -f "$TEMP_STANDARD"; fi
