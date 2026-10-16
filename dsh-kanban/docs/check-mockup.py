#!/usr/bin/env python3
"""Проверки painter'а макета: то, что раньше держалось на ручных замерах.

Запуск (из bin/test-scripts.sh, где PATH уже содержит найденный Node):
    python3 dsh-kanban/docs/check-mockup.py

Проверяем поведение, а не исходник: высота карточки с нулевым расходом и предел
ширины чипа владельца. Обе правки раунда 2 по #007 ловятся откатом.
"""

import copy
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent

failures = 0


ok_names = []


def check(name, ok, detail=""):
    global failures
    if ok:
        ok_names.append(name)
        print(f"   ok: {name}")
    else:
        failures += 1
        print(f"   ПРОВАЛ: {name}" + (f" — {detail}" if detail else ""))


def load_painter():
    spec = importlib.util.spec_from_file_location("render_mockup", HERE / "render-mockup.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_styles():
    payload = json.loads(subprocess.check_output(["node", str(HERE / "dump-styles.mjs")], cwd=ROOT))
    return payload["styles"], payload["columns"]


def card(card_id, **extra):
    base = {
        "id": card_id,
        "title": f"Задача {card_id}",
        "status": "in-progress",
        "owner": "sess-worker",
        "role": "worker",
        "updated": "2026-10-14T16:00:00Z",
    }
    base.update(extra)
    return base


def board_height(painter, styles, columns, cards):
    _board, _width, height = painter.build_board(styles, columns, "dark", cards, 0)
    return height


def drawn_texts(painter, styles, columns, cards):
    """Все строки, которые painter нарисовал: (текст, шрифт)."""
    captured = []
    original = painter.Canvas.text

    def spy(self, x, y, value, fnt, fill, anchor="la"):
        captured.append((value, fnt))
        return original(self, x, y, value, fnt, fill, anchor)

    painter.Canvas.text = spy
    try:
        painter.build_board(styles, columns, "dark", cards, 0)
    finally:
        painter.Canvas.text = original
    return captured


painter = load_painter()
styles, columns = load_styles()

# 1. Нулевой расход — это отсутствие данных, а не пустая строка в карточке.
plain = [card("900"), card("901")]
with_zero = [card("900"), card("901", tokens="0")]
with_blank = [card("900"), card("901", tokens="")]
height_plain = board_height(painter, styles, columns, plain)
check(
    "карточка с tokens: 0 не выше карточки без расхода",
    board_height(painter, styles, columns, with_zero) == height_plain,
    f"с нулём {board_height(painter, styles, columns, with_zero)}, без ключа {height_plain}",
)
check(
    "карточка с пустым расходом не выше карточки без расхода",
    board_height(painter, styles, columns, with_blank) == height_plain,
)
positive = [card("900"), card("901", tokens="6000")]
check(
    "карточка с расходом выше — строка рисуется",
    board_height(painter, styles, columns, positive) > height_plain,
)

# 2. Предел чипа владельца: maxWidth из стилей плагина, в CSS-пикселях, без SCALE.
# Предел берём заведомо узкий: на живых данных подпись владельца укорачивается до
# 12 символов и в предел не упирается, поэтому проверить его иначе нечем.
def is_owner_label(value, owner):
    if not isinstance(value, str) or not value:
        return False
    core = value[:-1] if value.endswith("\u2026") else value
    return bool(core) and owner.startswith(core)


narrow_styles = copy.deepcopy(styles)
narrow_styles["column"]["width"] = 600
narrow_styles["owner"]["maxWidth"] = 40
long_owner = "session-abcdefghijklmnopqrstuvwxyz0123456789"
captured = drawn_texts(painter, narrow_styles, columns, [card("902", owner=long_owner)])
owner_labels = [(value, fnt) for value, fnt in captured if is_owner_label(value, long_owner)]
if not owner_labels:
    check("чип владельца рисуется", False, "подпись владельца не найдена среди нарисованного")
else:
    label, fnt = owner_labels[0]
    draw = painter.ImageDraw.Draw(painter.Image.new("RGB", (8, 8)))
    label_width = painter.measure(draw, label, fnt)
    cap = float(narrow_styles["owner"]["maxWidth"]) - 12
    check(
        "чип владельца не шире плагинного предела",
        label_width <= cap + 1,
        f"подпись «{label}» {label_width:.1f} px при пределе {cap:.0f}",
    )
    check("предел действительно обрезает подпись", label != "session-abcd\u2026")

# 3. Общий список карточек и разбор расхода, как в JS.
demo = json.loads((HERE / "demo-cards.json").read_text(encoding="utf-8"))
# Сверяем ИМЕННО список painter'а: иначе проверка стережёт переданный ей аргумент,
# а не то, что painter читает общий файл.
check("painter читает общий список, а не свой", painter.CARDS == demo)
drawn = [value for value, _fnt in drawn_texts(painter, styles, columns, painter.CARDS) if isinstance(value, str)]
missing = [item["id"] for item in demo if f"#{item['id']}" not in drawn]
check("painter рисует все карточки общего списка", not missing, ", ".join(missing))

parsed = [painter.format_tokens(value) for value in ("1e3", "1.5", "0x10", "1e9")]
check("разбор расхода совпадает с JS", parsed == ["1,0k", "1.5", "16", "1,0G"], str(parsed))

# 4. Макет должен повторять доску: у слитой карточки название зачёркнуто.
def count_lines(cards):
    seen = []
    original = painter.Canvas.line

    def spy(self, x0, y0, x1, y1, fill, width=1):
        seen.append((x0, y0, x1, y1))
        return original(self, x0, y0, x1, y1, fill, width)

    painter.Canvas.line = spy
    try:
        painter.build_board(styles, columns, "dark", cards, 0)
    finally:
        painter.Canvas.line = original
    return len(seen)


demo_cards = json.loads((HERE / "demo-cards.json").read_text(encoding="utf-8"))
without_merged = [dict(item, status="ready" if item["status"] == "merged" else item["status"]) for item in demo_cards]
check(
    "painter зачёркивает название слитой карточки",
    count_lines(demo_cards) > count_lines(without_merged),
    f"с merged {count_lines(demo_cards)} линий, без merged {count_lines(without_merged)}",
)

print(f"\nпроверок painter'а: {len(ok_names)} ок, провалов {failures}")
sys.exit(1 if failures else 0)
