#!/usr/bin/env bash
#
# Собрать макет доски в PNG (и по желанию — в HTML).
#
#   bin/render-mockup.sh          # PNG: dsh-kanban/docs/board-mockup-*.png
#   bin/render-mockup.sh --html   # дополнительно HTML-версии для браузера
#
# Выход: dsh-kanban/docs/board-mockup-<вид>-<тема>.{png,html}
#   вид:  panel — доска в правом сайдбаре вместе с рамкой приложения;
#         full  — только доска, все семь колонок целиком;
#   тема: dark | light.
#
# Размеры, отступы и цвета доски берутся из настоящей таблицы стилей плагина
# (dsh-kanban/lib/client.js → __internals.styles), поэтому макет не разъезжается
# с кодом: поменяли стиль в плагине — перегенерировали макет.
#
# PNG рисуется через PIL, а не headless Chrome: под файловой песочницей DSH
# Chrome не стартует (зависает), а PIL и Arial Unicode с кириллицей есть в системе.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${1:-}" == "--html" ]]; then
  for view in panel full; do
    for theme in dark light; do
      (cd "$ROOT" && "$ROOT/bin/node.sh" dsh-kanban/docs/build-mockup.mjs "view=${view}&theme=${theme}")
    done
  done
  echo
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "нужен python3 с Pillow (pip install pillow)" >&2
  exit 1
fi

# Painter зовёт `node` из PATH, чтобы достать стили плагина: подкладываем
# найденный Node первым в PATH — PATH сессии урезан и Homebrew-ноды в нём нет.
NODE_DIR="$(dirname "$("$ROOT/bin/node.sh" --which)")"
PATH="$NODE_DIR:$PATH" python3 "$ROOT/dsh-kanban/docs/render-mockup.py"
