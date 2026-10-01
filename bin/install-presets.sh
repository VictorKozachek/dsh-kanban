#!/usr/bin/env bash
#
# Поставить пресеты агентов dispatcher / worker / reviewer / verifier в
# пользовательский корень DSH (~/.dsh/.agent-presets).
#
#   bin/install-presets.sh [--force] [--target DIR] [--standard DIR]
#
# Композиция берётся из поставляемого пресета `standard` установленного DSH —
# так она гарантированно совпадает с версией рантайма — и меняется только
# персональная часть (persona): тексты лежат в agent-presets/<роль>/persona.txt.
#
# Существующие пресеты не перезаписываются без --force.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORCE=0
TARGET="${DSH_HOME:-$HOME/.dsh}/.agent-presets"
STANDARD=""
ROLES=(dispatcher worker reviewer verifier)

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    --target) TARGET="${2:?}"; shift 2 ;;
    --target=*) TARGET="${1#*=}"; shift ;;
    --standard) STANDARD="${2:?}"; shift 2 ;;
    --standard=*) STANDARD="${1#*=}"; shift ;;
    -h|--help) sed -n '3,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "неизвестная опция: $1" >&2; exit 2 ;;
  esac
done

# --- где лежит поставляемый standard ---------------------------------------
# Ищем по известным местам, НЕ полагаясь на PATH: `dsh` может быть алиасом
# (`alias dsh='npx ...'`) или отсутствовать в неинтерактивном шелле, и тогда
# `command -v dsh` не даёт пути к файлу.
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
SEARCHED=()

candidate() {
  local dir="$1"
  [[ -n "$dir" ]] || return 1
  SEARCHED+=("$dir")
  [[ -f "$dir/agent.cordis.yml" ]]
}

if [[ -z "$STANDARD" ]]; then
  # 1. Профиль DSH: сюда пакеты кладёт сам dsh, PATH не нужен.
  candidate "$DSH_HOME_DIR/profiles/node_modules/@deepseek-ai/dsh-agent-presets/presets/standard" && STANDARD="$DSH_HOME_DIR/profiles/node_modules/@deepseek-ai/dsh-agent-presets/presets/standard"
fi

if [[ -z "$STANDARD" ]]; then
  # 2. Любой профиль внутри $DSH_HOME.
  for dir in "$DSH_HOME_DIR"/profiles/*/node_modules/@deepseek-ai/dsh-agent-presets/presets/standard; do
    candidate "$dir" && { STANDARD="$dir"; break; }
  done
fi

if [[ -z "$STANDARD" ]]; then
  # 3. Путь к самому dsh — но только если это настоящий файл, а не алиас.
  DSH_BIN="$(command -v dsh 2>/dev/null || true)"
  if [[ -n "$DSH_BIN" && -f "$DSH_BIN" ]]; then
    REAL="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$DSH_BIN" 2>/dev/null || readlink -f "$DSH_BIN" 2>/dev/null || true)"
    if [[ -n "$REAL" ]]; then
      BASE="$(dirname "$REAL")"
      for up in "@deepseek-ai/dsh-agent-presets" "../@deepseek-ai/dsh-agent-presets" "../../@deepseek-ai/dsh-agent-presets"; do
        candidate "$BASE/$up/presets/standard" && { STANDARD="$BASE/$up/presets/standard"; break; }
      done
    fi
  fi
fi

if [[ -z "$STANDARD" ]]; then
  # 4. Кэш npx и глобальные установки.
  for dir in "$HOME"/.npm/_npx/*/node_modules/@deepseek-ai/dsh-agent-presets/presets/standard; do
    candidate "$dir" && { STANDARD="$dir"; break; }
  done
fi

if [[ -z "$STANDARD" ]]; then
  for root in "$(npm root -g 2>/dev/null || true)" "$(pnpm root -g 2>/dev/null || true)"; do
    [[ -n "$root" ]] || continue
    candidate "$root/@deepseek-ai/dsh-agent-presets/presets/standard" && { STANDARD="$root/@deepseek-ai/dsh-agent-presets/presets/standard"; break; }
  done
fi

if [[ -z "$STANDARD" || ! -f "$STANDARD/agent.cordis.yml" ]]; then
  echo "не нашёл поставляемый пресет standard." >&2
  echo "искал здесь:" >&2
  # Пустой массив под `set -u` в bash 3.2 (штатный macOS) — фатальная ошибка,
  # поэтому разворачиваем его только при непустом списке.
  if (( ${#SEARCHED[@]} > 0 )); then
    for dir in "${SEARCHED[@]}"; do echo "  $dir" >&2; done
  fi
  echo >&2
  echo "найдите его сами:  find ~ -maxdepth 6 -type d -name dsh-agent-presets 2>/dev/null" >&2
  echo "и передайте путь:  bin/install-presets.sh --standard <...>/presets/standard" >&2
  exit 1
fi

echo "композиция-образец: $STANDARD"

command -v python3 >/dev/null 2>&1 || {
  echo "нужен python3, чтобы подменить блок persona в agent.cordis.yml" >&2
  exit 1
}

mkdir -p "$TARGET"

for role in "${ROLES[@]}"; do
  src="$ROOT/agent-presets/$role"
  dst="$TARGET/$role"

  if [[ ! -f "$src/persona.txt" || ! -f "$src/preset.yml" ]]; then
    echo "пропускаю $role: нет $src/persona.txt или preset.yml" >&2
    continue
  fi

  if [[ -d "$dst" && "$FORCE" -ne 1 ]]; then
    echo "пропускаю $role: $dst уже существует (--force перезапишет)"
    continue
  fi

  mkdir -p "$dst"
  cp "$STANDARD/agent.cordis.yml" "$dst/agent.cordis.yml"
  cp "$src/preset.yml" "$dst/preset.yml"

  python3 - "$dst/agent.cordis.yml" "$src/persona.txt" <<'PY'
import sys

target, persona_path = sys.argv[1], sys.argv[2]
with open(target, encoding='utf-8') as handle:
    lines = handle.read().splitlines()
with open(persona_path, encoding='utf-8') as handle:
    persona = handle.read().strip().splitlines()

out = []
index = 0
patched = False
while index < len(lines):
    line = lines[index]
    out.append(line)
    if line.strip() != '- id: persona':
        index += 1
        continue

    # Копируем строки строки персоны до `prefix:` включительно.
    index += 1
    while index < len(lines) and not lines[index].strip().startswith('prefix:'):
        out.append(lines[index])
        index += 1
    if index >= len(lines):
        raise SystemExit('в agent.cordis.yml нет строки prefix: у персоны')

    prefix_line = lines[index]
    out.append(prefix_line)
    base_indent = len(prefix_line) - len(prefix_line.lstrip())
    index += 1

    # Выбрасываем старое тело блочного скаляра: всё, что отступлено глубже.
    while index < len(lines) and (lines[index].strip() == '' or (len(lines[index]) - len(lines[index].lstrip())) > base_indent):
        index += 1

    for persona_line in persona:
        out.append((' ' * (base_indent + 2) + persona_line) if persona_line.strip() else '')
    out.append('')
    patched = True

if not patched:
    raise SystemExit('в agent.cordis.yml не нашлась строка "- id: persona"')

with open(target, 'w', encoding='utf-8') as handle:
    handle.write('\n'.join(out) + '\n')
PY

  if ! grep -qF "$(head -n 1 "$src/persona.txt" | cut -c1-24)" "$dst/agent.cordis.yml"; then
    echo "ошибка: текст персоны не попал в $dst/agent.cordis.yml" >&2
    exit 1
  fi

  echo "поставлен пресет $role → $dst"
done

echo
echo "проверка: dsh --profile web --dump-config | grep -n agent-presets"
echo "в GUI пресет выбирается при создании сессии; сменить пресет можно только у пустой сессии."
