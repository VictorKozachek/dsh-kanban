#!/usr/bin/env python3
"""
Анимированный GIF «как работает доска» для README.

Рисует тот же тёмный стиль, что и статичные макеты (docs/render-mockup.py):
сайдбар с четырьмя ролями, доска с колонками и карточка, которая проходит путь
backlog → todo → in-progress → in-review → testing → ready, а в углу появляется
наряд роли. Никакого браузера: только Pillow.

Запуск: python3 dsh-kanban/docs/make-onboarding-demo.py
Результат: dsh-kanban/docs/onboarding-demo.gif
"""

import os

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "onboarding-demo.gif")

W, H = 1200, 640
SIDEBAR = 230

FONT_REGULAR = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"
FONT_MONO = "/System/Library/Fonts/Supplemental/Courier New.ttf"
if not os.path.exists(FONT_MONO):
    FONT_MONO = FONT_REGULAR

BG = "#17181c"
PANEL = "#1c1e23"
PANEL2 = "#212429"
LINE = "#3a3d45"
TEXT = "#e6e8eb"
DIM = "#9aa0aa"
ACCENT = "#3b82f6"
GREEN = "#22c55e"
ORANGE = "#f59e0b"
PURPLE = "#8b5cf6"
GRAY = "#94a3b8"

COLUMNS = [
    ("БЭКЛОГ", "#8b5cf6"),
    ("НУЖНО СДЕЛАТЬ", "#22c55e"),
    ("В РАБОТЕ", "#0ea5e9"),
    ("НА РЕВЬЮ", "#f59e0b"),
    ("ТЕСТИРОВАНИЕ", "#a855f7"),
    ("ГОТОВО", "#94a3b8"),
]

STEPS = [
    ("1. Карточка создана", "bin/task-new.sh «Экспорт QR в CSV»"),
    ("2. Асайн: карточка ждёт исполнителя", "GUI: backlog → todo, либо bin/task-move.sh"),
    ("3. Исполнитель взял в работу", "bin/task-move.sh 001 in-progress"),
    ("4. Готово, на ревью", "bin/task-move.sh 001 in-review"),
    ("5. Независимая проверка", "bin/task-move.sh 001 testing → ready"),
    ("6. Слияние в основную ветку", "bin/task-commit.sh 001"),
]

CARD_TITLE = "Экспорт QR в CSV"
CARD_ID = "#001"
CARD_OWNER = "Исполнитель"


def font(size, mono=False):
    return ImageFont.truetype(FONT_MONO if mono else FONT_REGULAR, int(size))


def mix(color, alpha):
    """CSS-цвет в RGB + прозрачность для композита поверх фона."""
    color = color.strip()
    if color.startswith("rgba("):
        parts = [p.strip() for p in color[5:-1].split(",")]
        r, g, b = int(parts[0]), int(parts[1]), int(parts[2])
        return (r, g, b, int(float(parts[3]) * 255 * alpha))
    if color.startswith("#"):
        value = color[1:]
        if len(value) == 3:
            value = "".join(ch * 2 for ch in value)
        r, g, b = int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16)
        return (r, g, b, int(255 * alpha))
    return (200, 200, 200, int(255 * alpha))


def text(draw, xy, value, size, color=TEXT, anchor="la", mono=False):
    draw.text(xy, value, font=font(size, mono), fill=mix(color, 1.0), anchor=anchor)


def rounded(draw, box, radius, fill=None, outline=None, width=1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def draw_sidebar(draw, active_role):
    draw.rectangle([0, 0, SIDEBAR, H], fill=PANEL)
    draw.line([SIDEBAR, 0, SIDEBAR, H], fill=LINE)
    # логотип
    draw.ellipse([14, 16, 27, 29], fill=TEXT)
    text(draw, (33, 14), "DeepSeek", 12.5)
    draw.rounded_rectangle([96, 16, 143, 30], radius=3, outline=LINE)
    text(draw, (119, 18), "HARNESS", 8, DIM, anchor="ma")
    # New Session
    rounded(draw, [8, 38, SIDEBAR - 8, 68], 8, fill=PANEL2, outline=LINE)
    text(draw, (SIDEBAR / 2, 45), "✦  New Session", 12, anchor="ma")
    for i, (icon, label) in enumerate([("⧉", "Plugins"), ("◷", "Automation tasks"), ("⊞", "More")]):
        y = 82 + i * 26
        text(draw, (16, y), icon, 10.5, DIM)
        text(draw, (34, y), label, 12, "#cfd3da")
    # Workspaces
    y = 168
    text(draw, (12, y), "WORKSPACES", 9.5, "#8b8f98")
    text(draw, (SIDEBAR - 14, y), "⌕ ⑂ ＋", 9, "#8b8f98", anchor="ra")
    y += 22
    draw.text((14, y + 1), "▾", font=font(8.5), fill=mix(DIM, 1))
    draw.rectangle([25, y + 4, 33, y + 10], outline=mix(DIM, 1), width=1)
    text(draw, (40, y - 1), "demo-project", 11.5)
    y += 26
    roles = [
        ("Оркестратор", ORANGE, True),
        ("Исполнитель", "#0ea5e9", False),
        ("Ревьювер", PURPLE, False),
        ("Тестировщик", GRAY, False),
    ]
    for name, color, active in roles:
        if active or (active_role == "worker" and name == "Исполнитель") or (
            active_role == "reviewer" and name == "Ревьювер"
        ) or (active_role == "verifier" and name == "Тестировщик"):
            rounded(draw, [8, y - 3, SIDEBAR - 8, y + 21], 7, fill=PANEL2)
        draw.ellipse([29, y + 6, 36, y + 13], fill=mix(color, 1))
        text(draw, (43, y), name, 11.5, "#cfd3da")
        text(draw, (SIDEBAR - 12, y + 1), "5min", 9, "#7d838d", anchor="ra")
        y += 24


def draw_header(draw):
    draw.rectangle([SIDEBAR, 0, W, 36], fill=PANEL)
    draw.line([SIDEBAR, 36, W, 36], fill=LINE)
    text(draw, (SIDEBAR + 14, 8), "Диспетчер", 11.5)
    draw.rounded_rectangle([SIDEBAR + 82, 7, SIDEBAR + 156, 27], radius=10, outline=LINE)
    text(draw, (SIDEBAR + 119, 10), "dispatcher", 9, DIM, anchor="ma")
    # табы
    tab_x = SIDEBAR + 200
    text(draw, (tab_x, 10), "Файлы", 10.5, DIM)
    draw.rounded_rectangle([tab_x + 54, 5, tab_x + 124, 31], radius=7, fill=PANEL2, outline=LINE)
    text(draw, (tab_x + 89, 9), "Канбан", 10.5, TEXT, anchor="ma")


def draw_board(draw, card_col, caption, caption_sub, progress, toast=None, alpha=1.0):
    draw.rectangle([SIDEBAR, 36, W, H], fill=BG)
    text(draw, (SIDEBAR + 16, 47), "Канбан", 13)
    text(draw, (SIDEBAR + 72, 49), "demo-project · 9 карточек", 9.5, DIM)

    board_x = SIDEBAR + 16
    board_y = 76
    gap = 9
    col_w = (W - board_x - 18 - gap * (len(COLUMNS) - 1)) / len(COLUMNS)
    col_h = 430

    # колонки
    for index, (title, color) in enumerate(COLUMNS):
        x = board_x + index * (col_w + gap)
        rounded(draw, [x, board_y, x + col_w, board_y + col_h], 9, fill=PANEL)
        draw.rectangle([x, board_y, x + 3, board_y + col_h], fill=mix(color, 1))
        draw.ellipse([x + 12, board_y + 12, x + 19, board_y + 19], fill=mix(color, 1))
        text(draw, (x + 24, board_y + 8), title, 9, "#9ba0a9")
        text(draw, (x + col_w - 10, board_y + 8), str(index + (0 if index == 0 else 1)), 9, "#7d838d", anchor="ra")
        # подсказка-плейсхолдер
        if index != card_col:
            for line_index in range(2):
                lx = x + 12
                ly = board_y + 56 + line_index * 46
                rounded(draw, [lx, ly, x + col_w - 12, ly + 34], 7, fill="#1f2228")
                draw.rounded_rectangle([lx + 8, ly + 8, lx + 46, ly + 16], radius=3, fill="#2b2f36")
                draw.rounded_rectangle([lx + 8, ly + 21, x + col_w - 20, ly + 27], radius=3, fill="#272b32")

    # карточка
    col_x = board_x + card_col * (col_w + gap)
    card_w = col_w - 14
    card_h = 66
    card_x = board_x + card_col * (col_w + gap) + 7
    card_y = board_y + 36
    bubble = Image.new("RGBA", (int(card_w), card_h), (0, 0, 0, 0))
    bdraw = ImageDraw.Draw(bubble)
    bdraw.rounded_rectangle([0, 0, card_w - 1, card_h - 1], radius=7, fill="#262a31", outline="#3d424c")
    bdraw.rounded_rectangle([8, 8, 44, 17], radius=3, fill="#333944")
    bdraw.text((11, 9), CARD_ID, font=font(7.5), fill=mix(TEXT, 1))
    bdraw.text((8, 24), "Экспорт QR", font=font(10.5), fill=mix(TEXT, 1))
    bdraw.text((8, 38), "в CSV", font=font(10.5), fill=mix(TEXT, 1))
    if card_col >= 1:
        bdraw.rounded_rectangle([8, 54, 88, 63], radius=4, outline="#3d424c")
        bdraw.text((11, 54), CARD_OWNER, font=font(8), fill=mix(DIM, 1))
    draw._image.paste(bubble, (int(card_x), int(card_y)), bubble)

    # подпись шага
    text(draw, (board_x, H - 92), f"{progress + 1}/6", 10, DIM, mono=True)
    text(draw, (board_x + 40, H - 98), caption, 14.5)
    text(draw, (board_x + 40, H - 78), caption_sub, 10, "#8b9099", mono=True)
    # точки прогресса
    for i in range(6):
        x = board_x + 36 + i * 16
        draw.ellipse([x, H - 60, x + 7, H - 53], fill=mix(ACCENT if i <= progress else "#3a3d45", 1))

    # наряд-тост
    if toast:
        title, role, color = toast
        tw = 320
        th = 58
        tx = W - tw - 18
        ty = H - 150
        layer = Image.new("RGBA", (tw, th), (0, 0, 0, 0))
        ldraw = ImageDraw.Draw(layer)
        ldraw.rounded_rectangle([0, 0, tw - 1, th - 1], radius=9, fill=mix(PANEL2, 0.98), outline=mix(color, 0.9), width=1)
        ldraw.ellipse([12, 14, 22, 24], fill=mix(color, 1))
        ldraw.text((30, 8), title, font=font(9.5), fill=mix(TEXT, 1))
        ldraw.text((30, 24), role, font=font(12), fill=mix(color, 1))
        ldraw.text((30, 42), "sessionController.prompt · queue", font=font(8, mono=True), fill=mix(DIM, 1))
        draw._image.paste(layer, (tx, ty), layer)


def frames():
    output = []
    # карточка гостит в колонках 0..5; переходы анимируем по 4 кадра
    for step, (caption, sub) in enumerate(STEPS):
        for sub_frame in range(5):
            # карточка плавно едет из предыдущей колонки в текущую
            if step == 0:
                col = 0.0
            else:
                t = (sub_frame + 1) / 5
                col = (step - 1) + t
            image = Image.new("RGB", (W, H), BG)
            draw = ImageDraw.Draw(image)
            draw._image = image
            active = ["dispatcher", "worker", "worker", "reviewer", "verifier", "dispatcher"][step]
            draw_sidebar(draw, active)
            draw_header(draw)
            toast = None
            if step in (1, 2):
                toast = ("Наряд отправлен", "Исполнитель", "#0ea5e9")
            elif step == 3:
                toast = ("Наряд отправлен", "Ревьювер", PURPLE)
            elif step == 4:
                toast = ("Наряд отправлен", "Тестировщик", GRAY)
            elif step == 5:
                toast = ("Ветка готова", "Диспетчер", ORANGE)
            draw_board(draw, col, caption, sub, step, toast)
            output.append(image)
        # пауза на финальной позиции шага
        image = Image.new("RGB", (W, H), BG)
        draw = ImageDraw.Draw(image)
        draw._image = image
        active = ["dispatcher", "worker", "worker", "reviewer", "verifier", "dispatcher"][step]
        draw_sidebar(draw, active)
        draw_header(draw)
        toast = None
        if step == 1:
            toast = ("Наряд отправлен", "Исполнитель", "#0ea5e9")
        elif step == 2:
            toast = ("Наряд отправлен", "Исполнитель", "#0ea5e9")
        elif step == 3:
            toast = ("Наряд отправлен", "Ревьювер", PURPLE)
        elif step == 4:
            toast = ("Наряд отправлен", "Тестировщик", GRAY)
        elif step == 5:
            toast = ("Ветка готова", "Диспетчер", ORANGE)
        draw_board(draw, step, caption, sub, step, toast)
        output.append(image)
    return output


def main():
    images = frames()
    converted = [image.convert("P", palette=Image.Palette.ADAPTIVE, colors=128) for image in images]
    converted[0].save(
        OUT,
        save_all=True,
        append_images=converted[1:],
        duration=150,
        loop=0,
        optimize=True,
    )
    size = os.path.getsize(OUT)
    print(f"готово: {OUT} ({len(converted)} кадров, {size / 1024:.0f} КБ)")


if __name__ == "__main__":
    main()
