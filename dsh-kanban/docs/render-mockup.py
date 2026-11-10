#!/usr/bin/env python3
"""
Рендер макета доски в PNG без браузера (headless Chrome под песочницей DSH не
работает). Размеры, отступы и цвета доски берутся из НАСТОЯЩЕЙ таблицы стилей
плагина: dump-styles.mjs отдаёт `styles` из lib/client.js, здесь они
интерпретируются (px, отступы, color-mix с currentColor).

Рамка приложения (сайдбар, разговор, полоса табов) нарисована отдельно — она не
часть плагина и нужна только для наглядности.

Запуск: bin/render-mockup.sh   или   python3 dsh-kanban/docs/render-mockup.py
"""

import json
import os
import re
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SCALE = 2

FONT_REGULAR = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"
FONT_MONO = "/System/Library/Fonts/Supplemental/Courier New.ttf"
if not os.path.exists(FONT_MONO):
    FONT_MONO = FONT_REGULAR

PALETTE = {
    "dark": {
        "bg": "#17181c", "panel": "#1c1e23", "panel2": "#212429",
        "line": "rgba(255,255,255,.09)", "text": "#e6e8eb",
        "dim": "rgba(230,232,235,.6)", "accent": "#3b82f6",
    },
    "light": {
        "bg": "#ffffff", "panel": "#f7f8fa", "panel2": "#eef0f4",
        "line": "rgba(15,20,30,.12)", "text": "#1b1d21",
        "dim": "rgba(27,29,33,.6)", "accent": "#2563eb",
    },
}

COLUMN_LABELS = {
    "backlog": "Бэклог",
    "todo": "Нужно сделать",
    "in-progress": "В работе",
    "in-review": "На ревью",
    "testing": "Тестирование",
    "ready": "Готово к слиянию",
    "merged": "Влито",
    "blocked": "Заблокировано",
}

# Подписи ролей: те же слова, что в словаре плагина (ru).
ROLE_LABELS = {
    "worker": "исполнитель",
    "reviewer": "ревьювер",
    "verifier": "тестировщик",
    "dispatcher": "оркестратор",
}


def role_label_of(card):
    role = str(card.get("role") or "").strip().lower()
    if not role:
        return ""
    return ROLE_LABELS.get(role, role)


def parse_tokens(value):
    """Разбор расхода как в JS: Number() понимает `1e3` и `0x10`, int() — нет."""
    text = str(value if value is not None else "").strip()
    if not text:
        return None
    try:
        if re.fullmatch(r"[+-]?0[xX][0-9a-fA-F]+", text):
            return float(int(text, 16))
        return float(text)
    except ValueError:
        return None


def js_number(value):
    """Запись числа как в JS: целое без «.0»."""
    number = float(value)
    return str(int(number)) if number.is_integer() else str(number)


def has_tokens(card):
    """Есть ли расход: ноль и пустое значение — это отсутствие данных."""
    number = parse_tokens(card.get("tokens"))
    return number is not None and number > 0


def format_tokens(value):
    """Компактная запись числа — как formatTokens в плагине."""
    number = parse_tokens(value)
    if number is None:
        return str(value)
    if number < 1000:
        return js_number(number)
    for limit, suffix in ((1000000000, "G"), (1000000, "M"), (1000, "k")):
        if number >= limit:
            scaled = number / limit
            text = f"{scaled:.1f}" if scaled < 10 else f"{scaled:.0f}"
            return text.replace(".", ",") + suffix
    return str(number)

CARDS = json.loads(open(os.path.join(HERE, "demo-cards.json"), encoding="utf-8").read())


# ── утилиты ──────────────────────────────────────────────────────────────────

def num(value, default=0.0):
    if isinstance(value, (int, float)):
        return float(value)
    if not isinstance(value, str):
        return default
    match = re.search(r"-?\d+(?:\.\d+)?", value)
    return float(match.group()) if match else default


def spacing(value):
    """CSS-сокращение отступов → (вертикаль, горизонталь)."""
    if isinstance(value, (int, float)):
        return float(value), float(value)
    if not isinstance(value, str):
        return 0.0, 0.0
    parts = [float(m.group()) for m in re.finditer(r"\d+(?:\.\d+)?", value)]
    if not parts:
        return 0.0, 0.0
    if len(parts) == 1:
        return parts[0], parts[0]
    return parts[0], parts[1]


def hex_rgb(value):
    value = value.lstrip("#")
    if len(value) == 3:
        value = "".join(ch * 2 for ch in value)
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))


def rgba_rgb(value):
    match = re.match(r"rgba?\(([^)]+)\)", value)
    if not match:
        return None
    parts = [p.strip() for p in match.group(1).split(",")]
    rgb = tuple(int(float(p)) for p in parts[:3])
    alpha = float(parts[3]) if len(parts) > 3 else 1.0
    return rgb, alpha


def composite(fg, alpha, bg):
    return tuple(int(round(fg[i] * alpha + bg[i] * (1 - alpha))) for i in range(3))


def resolve(color, bg, text):
    """Строка CSS-цвета → RGB, с разрешением color-mix(... currentColor N% ...)."""
    if not isinstance(color, str) or color in ("", "transparent", "none"):
        return bg
    if color.startswith("color-mix"):
        match = re.search(r"currentColor\s+(\d+(?:\.\d+)?)%", color)
        if match:
            return composite(text, float(match.group(1)) / 100.0, bg)
        return bg
    if color.startswith("#"):
        return hex_rgb(color)
    parsed = rgba_rgb(color)
    if parsed:
        rgb, alpha = parsed
        return composite(rgb, alpha, bg)
    return text


def border_of(style, bg, text):
    """`border: "1px solid X"` → (толщина, цвет)."""
    value = style.get("border")
    if isinstance(value, str) and "solid" in value:
        return num(value, 0.0), resolve(value.split("solid", 1)[1].strip(), bg, text)
    return 0.0, bg


class Canvas:
    """Рисование в координатах CSS-пикселей с учётом SCALE."""

    def __init__(self, width, height, bg):
        self.image = Image.new("RGB", (int(width * SCALE), int(height * SCALE)), bg)
        self.draw = ImageDraw.Draw(self.image)
        self.width = width
        self.height = height

    def rect(self, x, y, w, h, radius=0, fill=None, outline=None, line=1):
        if w <= 0 or h <= 0:
            return
        radius = max(0.0, min(radius, min(w, h) / 2))
        self.draw.rounded_rectangle(
            [x * SCALE, y * SCALE, (x + w) * SCALE, (y + h) * SCALE],
            radius=radius * SCALE,
            fill=fill,
            outline=outline,
            width=max(1, int(round(line * SCALE))) if outline else 0,
        )

    def text(self, x, y, value, fnt, fill, anchor="la"):
        self.draw.text((x * SCALE, y * SCALE), value, font=fnt, fill=fill, anchor=anchor)

    def line(self, x0, y0, x1, y1, fill, width=1):
        self.draw.line([x0 * SCALE, y0 * SCALE, x1 * SCALE, y1 * SCALE], fill=fill,
                       width=max(1, int(round(width * SCALE))))


def font(size, mono=False):
    return ImageFont.truetype(FONT_MONO if mono else FONT_REGULAR, int(round(size * SCALE)))


def measure(draw, value, fnt):
    return draw.textlength(value, font=fnt) / SCALE


def ellipsize(draw, value, fnt, max_width):
    """Обрезать однострочный текст по ширине с многоточием."""
    if measure(draw, value, fnt) <= max_width:
        return value
    cut = value
    while cut and measure(draw, cut + "…", fnt) > max_width:
        cut = cut[:-1]
    return cut + "…"


def wrap(draw, value, fnt, max_width, max_lines):
    """Перенос по словам с обрезкой и многоточием."""
    words = value.split()
    lines, current = [], ""
    index = 0
    while index < len(words):
        candidate = (current + " " + words[index]).strip()
        if measure(draw, candidate, fnt) <= max_width or not current:
            current = candidate
            index += 1
            if len(lines) == max_lines - 1 and index < len(words):
                break
        else:
            lines.append(current)
            current = ""
            if len(lines) == max_lines:
                break
    if current and len(lines) < max_lines:
        lines.append(current)
    consumed = " ".join(lines).split()
    if len(consumed) < len(words) and lines:
        last = lines[-1]
        while last and measure(draw, last + "…", fnt) > max_width:
            last = last[:-1]
        lines[-1] = last + "…"
    return lines or [""]


LINE_FACTOR = 1.45


# ── доска ────────────────────────────────────────────────────────────────────

def build_board(styles, columns, theme, cards, header_width):
    palette = PALETTE[theme]
    panel_bg = hex_rgb(palette["panel"])
    text = hex_rgb(palette["text"])

    base = num(styles["root"].get("fontSize"), 12)
    header_font = font(base * 0.95, mono=False)
    meta_font = font(num(styles["headerMeta"].get("fontSize"), 11))
    col_font = font(num(styles["columnHeader"].get("fontSize"), 11))
    card_id_font = font(num(styles["cardId"].get("fontSize"), 11))
    card_title_font = font(num(styles["cardTitle"].get("fontSize"), 12))
    small_font = font(num(styles["meta"].get("fontSize"), 10))
    note_font = font(num(styles["note"].get("fontSize"), 10))
    count_font = font(num(styles["count"].get("fontSize"), 11))

    column_w = num(styles["column"].get("width"), 232)
    board_pad = spacing(styles["board"].get("padding"))[1]
    board_gap = num(styles["board"].get("gap"), 8)

    header_pad_x = spacing(styles["header"].get("padding"))[1]
    header_pad_y = spacing(styles["header"].get("padding"))[0]
    header_h = header_pad_y * 2 + base * LINE_FACTOR + 1

    col_head_pad = spacing(styles["columnHeader"].get("padding"))
    col_head_h = col_head_pad[0] * 2 + col_font.size / SCALE * LINE_FACTOR + 1

    body_pad = spacing(styles["columnBody"].get("padding"))[0]
    body_gap = num(styles["columnBody"].get("gap"), 6)
    inner_w = column_w - body_pad * 2

    card_pad = spacing(styles["card"].get("padding"))
    card_gap = num(styles["card"].get("gap"), 3)
    card_text_w = inner_w - card_pad[1] * 2 - 2

    scratch = ImageDraw.Draw(Image.new("RGB", (10, 10)))

    def owner_chip_width(owner):
        return measure(scratch, owner, small_font) + 12

    def ellipsize(label, max_width):
        """Обрезать подпись по доступной ширине — как ellipsis у чипа в плагине."""
        if max_width <= 0:
            return ""
        if measure(scratch, label, small_font) <= max_width:
            return label
        cut = label
        while cut and measure(scratch, cut + "…", small_font) > max_width:
            cut = cut[:-1]
        return (cut + "…") if cut else ""

    def card_height(card):
        height = card_pad[0] * 2 + 2
        height += max(card_id_font.size / SCALE * LINE_FACTOR, small_font.size / SCALE * LINE_FACTOR + 4)
        title_lines = wrap(scratch, card["title"], card_title_font, card_text_w, 2)
        height += card_gap + len(title_lines) * card_title_font.size / SCALE * LINE_FACTOR
        if card.get("branch"):
            height += card_gap + small_font.size / SCALE * LINE_FACTOR
        if has_tokens(card):
            height += card_gap + small_font.size / SCALE * LINE_FACTOR
        if card.get("note"):
            note_lines = wrap(scratch, card["note"], note_font, card_text_w, 2)
            height += card_gap + len(note_lines) * note_font.size / SCALE * LINE_FACTOR
        if card.get("updated"):
            height += card_gap + small_font.size / SCALE * LINE_FACTOR
        return height

    grouped = []
    for column in columns:
        items = [c for c in cards if c["status"] == column["id"]]
        heights = [card_height(c) for c in items]
        grouped.append((column, items, heights))

    tallest = max(
        (col_head_h + body_pad * 2 + sum(heights) + body_gap * max(0, len(heights) - 1))
        for _, _, heights in grouped
    )
    board_w = board_pad * 2 + column_w * len(columns) + board_gap * (len(columns) - 1)
    board_h = header_h + tallest + board_pad
    if not header_width:
        header_width = board_w

    canvas = Canvas(board_w, board_h, panel_bg)
    draw = canvas.draw

    # шапка доски
    canvas.text(header_pad_x, header_pad_y + 1, "Канбан", header_font, text)
    title_w = measure(draw, "Канбан", header_font)
    canvas.text(header_pad_x + title_w + 10, header_pad_y + 2,
                f"demo-project · {len(cards)} карточек", meta_font, composite(text, 0.6, panel_bg))
    button_w, button_h = 26, base * LINE_FACTOR
    border_w, border_c = border_of(styles["refresh"], panel_bg, text)
    canvas.rect(header_width - header_pad_x - button_w, header_pad_y, button_w, button_h,
                radius=6, outline=border_c, line=border_w)
    canvas.text(header_width - header_pad_x - button_w / 2, header_pad_y + button_h / 2 - 1, "↻",
                meta_font, composite(text, 0.75, panel_bg), anchor="mm")
    canvas.line(0, header_h, min(header_width, board_w), header_h, composite(text, 0.12, panel_bg), 1)

    # колонки
    x = board_pad
    for column, items, heights in grouped:
        y = header_h + board_pad / 2
        column_h = col_head_h + body_pad * 2 + sum(heights) + body_gap * max(0, len(heights) - 1)
        col_border_w, col_border_c = border_of(styles["column"], panel_bg, text)
        col_bg = resolve(styles["column"].get("background"), panel_bg, text)
        canvas.rect(x, y, column_w, column_h, radius=10, fill=col_bg, outline=col_border_c, line=col_border_w)

        # заголовок колонки
        dot = num(styles["dot"].get("width"), 8)
        canvas.rect(x + col_head_pad[1], y + col_head_pad[0] + (col_font.size / SCALE * LINE_FACTOR - dot) / 2,
                    dot, dot, radius=dot / 2, fill=hex_rgb(column["color"]))
        canvas.text(x + col_head_pad[1] + dot + 6, y + col_head_pad[0],
                    COLUMN_LABELS[column["id"]].upper(), col_font, composite(text, 0.85, col_bg))
        canvas.text(x + column_w - col_head_pad[1], y + col_head_pad[0], str(len(items)), count_font,
                    composite(text, 0.6, col_bg), anchor="ra")
        canvas.line(x, y + col_head_h, x + column_w, y + col_head_h, composite(text, 0.10, col_bg), 1)

        # карточки
        cy = y + col_head_h + body_pad
        for card, height in zip(items, heights):
            side = hex_rgb(column["color"])
            card_border_w, card_border_c = border_of(styles["card"], col_bg, text)
            card_bg = resolve(styles["card"].get("background"), col_bg, text)
            canvas.rect(x + body_pad, cy, inner_w, height, radius=8, fill=card_bg, outline=card_border_c, line=card_border_w)
            canvas.rect(x + body_pad, cy, 3, height, radius=1.5, fill=side)

            tx = x + body_pad + card_pad[1]
            ty = cy + card_pad[0]

            canvas.text(tx, ty, "#" + card["id"], card_id_font, composite(text, 0.6, card_bg))
            cursor = tx + measure(draw, "#" + card["id"], card_id_font) + 6
            if card.get("source") == "worktree":
                badge = styles.get("branchBadge", {})
                badge_font = font(num(badge.get("fontSize"), 10))
                badge_pad = spacing(badge.get("padding"))
                label = "в ветке"
                badge_w = measure(draw, label, badge_font) + badge_pad[1] * 2
                badge_h = badge_font.size / SCALE * LINE_FACTOR + badge_pad[0] * 2
                canvas.rect(cursor, ty + 1, badge_w, badge_h,
                            radius=num(badge.get("borderRadius"), badge_h / 2),
                            fill=composite(text, 0.14, card_bg))
                canvas.text(cursor + badge_w / 2, ty + 1 + badge_h / 2 - 1, label, badge_font,
                            composite(text, 0.85, card_bg), anchor="mm")
                cursor += badge_w + 6
            role_label = role_label_of(card)
            if role_label:
                chip_h = small_font.size / SCALE * LINE_FACTOR + 4
                chip_w = owner_chip_width(role_label)
                canvas.rect(cursor, ty - 1, chip_w, chip_h, radius=chip_h / 2,
                            outline=composite(text, 0.18, card_bg), line=1)
                canvas.text(cursor + chip_w / 2, ty + chip_h / 2 - 1, role_label, small_font,
                            composite(text, 0.9, card_bg), anchor="mm")
                cursor += chip_w + 6
            if card.get("owner"):
                label = card["owner"][:12] + "…" if len(card["owner"]) > 14 else card["owner"]
                right = x + body_pad + inner_w - card_pad[1]
                # В плагине чип владельца ужимает flex (max-width плюс ellipsis).
                # Здесь считаем остаток строки и тот же предел, что у плагина:
                # measure() и раскладка — в CSS-пикселях, SCALE применяется только
                # при отрисовке, поэтому множить предел на SCALE нельзя.
                owner_max = num(styles["owner"].get("maxWidth"), 110) - 12
                label = ellipsize(label, min(right - cursor - 12, owner_max))
                if label:
                    chip_w = owner_chip_width(label)
                    chip_h = small_font.size / SCALE * LINE_FACTOR + 4
                    canvas.rect(right - chip_w, ty - 1, chip_w, chip_h,
                                radius=chip_h / 2, outline=composite(text, 0.18, card_bg), line=1)
                    canvas.text(right - chip_w / 2, ty + chip_h / 2 - 1,
                                label, small_font, composite(text, 0.9, card_bg), anchor="mm")
            else:
                # Плагин в этом слоте показывает «не назначено» (ownerEmpty):
                # подпись прижата вправо и приглушена — макет повторяет доску.
                label = "не назначено"
                right = x + body_pad + inner_w - card_pad[1]
                label_w = measure(draw, label, small_font)
                if label_w <= right - cursor:
                    canvas.text(right - label_w, ty + 1, label, small_font,
                                composite(text, 0.45, card_bg))
            ty += max(card_id_font.size / SCALE * LINE_FACTOR, small_font.size / SCALE * LINE_FACTOR + 4) + card_gap

            merged = card.get("status") == "merged"
            for line in wrap(scratch, card["title"], card_title_font, card_text_w, 2):
                canvas.text(tx, ty, line, card_title_font, text)
                if merged:
                    # Зачёркивание, как у cardTitleMerged в плагине.
                    strike_y = ty + card_title_font.size / SCALE * 0.42
                    canvas.line(tx, strike_y,
                                tx + measure(scratch, line, card_title_font), strike_y,
                                composite(text, 0.7, card_bg), 1)
                ty += card_title_font.size / SCALE * LINE_FACTOR
            if card.get("branch"):
                ty += card_gap
                canvas.text(tx, ty, card["branch"], small_font, composite(text, 0.6, card_bg))
                ty += small_font.size / SCALE * LINE_FACTOR
            if has_tokens(card):
                ty += card_gap
                canvas.text(tx, ty, "токенов: " + format_tokens(card["tokens"]), small_font,
                            composite(text, 0.6, card_bg))
                ty += small_font.size / SCALE * LINE_FACTOR
            if card.get("note"):
                ty += card_gap
                for line in wrap(scratch, card["note"], note_font, card_text_w, 2):
                    canvas.text(tx, ty, line, note_font, hex_rgb("#f97316"))
                    ty += note_font.size / SCALE * LINE_FACTOR
            if card.get("updated"):
                ty += card_gap
                canvas.text(tx, ty, card["updated"], small_font, composite(text, 0.6, card_bg))
            cy += height + body_gap
        x += column_w + board_gap

    return canvas.image, board_w, board_h


# ── рамка приложения ─────────────────────────────────────────────────────────

def build_frame(board, board_w, board_h, view, theme):
    palette = PALETTE[theme]
    bg = hex_rgb(palette["bg"])
    panel = hex_rgb(palette["panel"])
    panel2 = hex_rgb(palette["panel2"])
    text = hex_rgb(palette["text"])
    dim = composite(text, 0.55, bg)
    line = resolve(palette["line"], bg, text)

    f12 = font(12.5)
    f11 = font(11)
    f10 = font(10.5)
    f13 = font(13)

    if view == "full":
        width, height = board_w + 32, board_h + 78
        canvas = Canvas(width, height, panel)
        strip_h = 40
        canvas.line(0, strip_h, width, strip_h, line, 1)
        canvas.text(12, 12, "Файлы", f12, composite(text, 0.55, panel))
        canvas.rect(68, 7, 78, 26, radius=7, fill=panel2)
        canvas.text(107, 12, "Канбан", f12, text, anchor="ma")
        canvas.text(width - 20, 12, "↗", f13, composite(text, 0.45, panel), anchor="ra")
        canvas.image.paste(board, (16 * SCALE, (strip_h + 12) * SCALE))
        canvas.text(width / 2, height - 22,
                    "Макет доски: размеры и цвета взяты из таблицы стилей плагина",
                    f10, composite(text, 0.38, panel), anchor="ma")
        return canvas.image

    width, height = 1680, 900
    left_w, right_w = 236, 1010
    conv_w = width - left_w - right_w
    canvas = Canvas(width, height, bg)

    # левый сайдбар
    canvas.rect(0, 0, left_w, height, fill=panel)
    canvas.line(left_w, 0, left_w, height, line, 1)
    # логотип и название
    canvas.rect(14, 16, 13, 13, radius=7, fill=composite(text, 0.9, panel))
    canvas.text(33, 11, "DeepSeek", f12, text)
    canvas.rect(96, 13, 47, 14, radius=3, outline=line, line=1)
    canvas.text(119, 15, "HARNESS", font(8), composite(text, 0.65, panel), anchor="ma")

    # New Session
    canvas.rect(8, 38, left_w - 16, 30, radius=8, fill=panel2, outline=line, line=1)
    canvas.text(left_w / 2, 45, "✦  New Session", f12, composite(text, 0.92, panel), anchor="ma")

    # меню
    y = 80
    for icon, name in [("⧉", "Plugins"), ("◷", "Automation tasks"), ("⊞", "More")]:
        canvas.text(16, y + 2, icon, font(11), composite(text, 0.55, panel))
        canvas.text(34, y, name, f12, composite(text, 0.88, panel))
        y += 26

    # Workspaces + дерево
    y += 8
    canvas.text(12, y, "WORKSPACES", f10, composite(text, 0.45, panel))
    canvas.text(left_w - 16, y + 1, "⌕ ⑂ ＋", font(10), composite(text, 0.6, panel), anchor="ra")
    y += 22

    def tree_workspace(name):
        nonlocal_holder = None
        return name

    rows = [
        ("ws", "demo-project"),
        ("s", "#f59e0b", "Оркестратор", "6min", True),
        ("s", "#0ea5e9", "Исполнитель", "5min", False),
        ("s", "#8b5cf6", "Ревьювер", "17h", False),
        ("s", "#94a3b8", "Тестировщик", "17h", False),
        ("ws", "demo-agents"),
        ("s", "#22c55e", "Исполнитель агентов", "1d", False),
        ("s", "#94a3b8", "Ревьювер агентов", "1d", False),
    ]
    for row in rows:
        if row[0] == "ws":
            canvas.text(14, y + 2, "▾", font(9), composite(text, 0.6, panel))
            canvas.rect(26, y + 6, 9, 7, radius=1, outline=composite(text, 0.55, panel), line=1)
            canvas.text(42, y, row[1], f12, text)
            y += 26
        else:
            _, color, name, rel, active = row
            if active:
                canvas.rect(8, y - 3, left_w - 16, 24, radius=7, fill=panel2)
            canvas.rect(30, y + 6, 7, 7, radius=4, fill=hex_rgb(color))
            canvas.text(44, y, name, f12, composite(text, 0.86, panel))
            canvas.text(left_w - 16, y + 1, rel, f10, composite(text, 0.5, panel), anchor="ra")
            y += 24

    # разговор
    cx = left_w
    canvas.rect(cx, 0, conv_w, height, fill=bg)
    canvas.line(cx + conv_w, 0, cx + conv_w, height, line, 1)
    canvas.line(cx, 40, cx + conv_w, 40, line, 1)
    canvas.text(cx + 14, 12, "Диспетчер", f12, text)
    canvas.rect(cx + 82, 10, 74, 20, radius=10, outline=line, line=1)
    canvas.text(cx + 119, 14, "dispatcher", f10, composite(text, 0.75, bg), anchor="ma")
    canvas.text(cx + conv_w - 16, 13, "⇱", f13, composite(text, 0.45, bg), anchor="ra")

    bubble = canvas.rect
    def message(text_value, y0, is_user, width_ratio=0.9):
        fnt = f12
        lines = wrap(canvas.draw, text_value, fnt, (conv_w - 60) * width_ratio, 4)
        w = max(measure(canvas.draw, l, fnt) for l in lines) + 20
        h = len(lines) * 12.5 * LINE_FACTOR + 16
        x0 = cx + conv_w - 18 - w if is_user else cx + 18
        if is_user:
            bubble(x0, y0, w, h, radius=10, fill=panel2, outline=line, line=1)
        for i, l in enumerate(lines):
            canvas.text(x0 + 10, y0 + 8 + i * 12.5 * LINE_FACTOR, l, fnt, text if is_user else composite(text, 0.85, bg))
        return y0 + h + 12

    my = 60
    my = message("Разбей работу по доске на задачи и раздай воркерам: плагин, пресеты, тесты.", my, True)
    my = message("Завёл карточки 002–005 и три worktree. Воркеры в работе, четвёртая задача ждёт верификатора.", my, False)
    mono = font(11.5, mono=True)
    for tool in ['$ bin/task-new.sh "Колонки, карточки и опрос .kanban/tasks"',
                 "задача 002: .kanban/tasks/002.md · worktree demo-t002 (task/002)"]:
        box_w = conv_w - 36
        canvas.rect(cx + 18, my, box_w, 26, radius=8, fill=panel, outline=line, line=1)
        canvas.text(cx + 27, my + 6, ellipsize(canvas.draw, tool, mono, box_w - 18), mono,
                    composite(text, 0.8, panel))
        my += 34
    my = message("Слежу за доской: как только карточка уйдёт в review — проверю и слью ветку.", my, False)
    canvas.rect(cx + 18, height - 66, conv_w - 36, 44, radius=10, outline=line, line=1)
    canvas.text(cx + 32, height - 52, "Написать сообщение…", f12, composite(text, 0.5, bg))

    # правая панель с доской
    px = left_w + conv_w
    canvas.rect(px, 0, right_w, height, fill=panel)
    canvas.line(px, 0, px, height, line, 1)
    canvas.rect(px + 8, 7, right_w - 16, 26, radius=0, fill=None)
    canvas.rect(px + 10, 7, 74, 26, radius=7, fill=None)
    canvas.text(px + 22, 12, "Файлы", f12, composite(text, 0.55, panel))
    canvas.rect(px + 92, 7, 84, 26, radius=7, fill=panel2)
    canvas.text(px + 134, 12, "Канбан", f12, text, anchor="ma")
    canvas.text(px + right_w - 34, 12, "↗", f13, composite(text, 0.45, panel), anchor="ra")
    canvas.text(px + right_w - 14, 12, "✕", f13, composite(text, 0.45, panel), anchor="ra")
    canvas.line(px, 40, px + right_w, 40, line, 1)

    # доска обрезается по ширине панели — как при горизонтальной прокрутке
    visible_w = right_w
    board_crop = board.crop((0, 0, int(visible_w * SCALE), min(board.height, int((height - 40) * SCALE))))
    canvas.image.paste(board_crop, (px * SCALE, 40 * SCALE))

    canvas.text(width / 2, height - 16,
                "Макет: рамка приложения нарисована приблизительно, доска — размерами и цветами плагина",
                f10, composite(text, 0.35, panel), anchor="ma")
    return canvas.image


def status_of(card, columns):
    status = card["status"].strip().lower().replace(" ", "-")
    aliases = {"in_progress": "in-progress", "review": "testing", "done": "ready"}
    status = aliases.get(status, status)
    known = [c["id"] for c in columns]
    return status if status in known else "todo"


def main():
    payload = json.loads(subprocess.check_output(["node", os.path.join(HERE, "dump-styles.mjs")], cwd=ROOT))
    styles, columns = payload["styles"], payload["columns"]
    for card in CARDS:
        card["status"] = status_of(card, columns)

    outputs = []
    for theme in ("dark", "light"):
        for view in ("panel", "full"):
            board, board_w, board_h = build_board(styles, columns, theme, CARDS,
                                                  1010 if view == "panel" else 0)
            image = build_frame(board, board_w, board_h, view, theme)
            path = os.path.join(HERE, f"board-mockup-{view}-{theme}.png")
            image.save(path)
            outputs.append(path)
            print("готово:", os.path.relpath(path, ROOT))
    return outputs


if __name__ == "__main__":
    main()
