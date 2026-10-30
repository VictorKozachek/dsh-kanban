/**
 * Генератор макета доски: собирает HTML из НАСТОЯЩЕЙ таблицы стилей плагина.
 *
 * Бандл `lib/client.js` грузится в песочницу (React подменяется заглушкой), из
 * `__internals` берутся `styles` и `COLUMNS` — поэтому макет не разъедется с
 * кодом: поменяли отступ в плагине, перегенерировали макет.
 *
 * Рамка приложения (левый сайдбар, разговор, полоса табов) нарисована здесь
 * отдельно: она не часть плагина и служит только для наглядности.
 *
 * Запуск:  node dsh-kanban/docs/build-mockup.mjs
 * Выход:   dsh-kanban/docs/board-mockup-<вид>-<тема>.html
 *          (bin/render-mockup.sh делает из него PNG)
 */
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "..", "lib", "client.js"), "utf8");

let entry = null;
const sandbox = {
  window: { __ModuleLoader__: { load: (value) => { entry = value; } } },
  console
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: "client.js" });
const plugin = entry.factory((name) => {
  if (name === "react") return { createElement: () => null };
  throw new Error("неожиданный require: " + name);
});
const { styles, COLUMNS } = plugin.__internals;

/** camelCase → kebab-case, чтобы отдать объект стилей в inline-атрибут. */
const kebab = (name) => name.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase());

/** Свойства, у которых число не требует единиц измерения. */
const UNITLESS = new Set([
  "lineHeight",
  "opacity",
  "zIndex",
  "flex",
  "flexGrow",
  "flexShrink",
  "order",
  "fontWeight",
  "zoom"
]);

/** Объект инлайн-стилей → строка для атрибута style. */
function css(style) {
  return Object.entries(style || {})
    .map(([key, value]) => {
      // В таблице стилей плагина числа значат пиксели (width: 232, gap: 3), а в
      // атрибуте style без единиц они невалидны: браузер такие свойства отбросит.
      const pixels = typeof value === "number" && !UNITLESS.has(key);
      return `${kebab(key)}:${pixels ? `${value}px` : value}`;
    })
    .join(";");
}

const escapeHtml = (text) =>
  String(text).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));

/** Демонстрационные карточки: правдоподобная работа по этому же проекту. */
// Общий список демонстрационных карточек: тот же файл читает painter.
const PROJECT_NAME = "demo-project";

const CARDS = JSON.parse(fs.readFileSync(path.join(here, "demo-cards.json"), "utf8"));

const normalizeStatus = plugin.__internals.normalizeStatus;
const shortOwner = (owner) => (owner.length > 14 ? owner.slice(0, 12) + "…" : owner);

const ROLE_LABELS = {
  worker: "исполнитель",
  reviewer: "ревьювер",
  verifier: "тестировщик",
  dispatcher: "оркестратор"
};
const roleLabelOf = (card) => {
  const role = String(card.role || "").trim().toLowerCase();
  return role ? ROLE_LABELS[role] || role : "";
};

/** Компактная запись числа — как formatTokens в плагине. */
function formatTokens(value) {
  const number = Number(String(value).replace(/\s+/g, ""));
  if (!isFinite(number) || number <= 0) return String(value);
  const short = (scaled, suffix) => (scaled < 10 ? scaled.toFixed(1) : scaled.toFixed(0)).replace(".", ",") + suffix;
  if (number < 1000) return String(number);
  if (number < 1000000) return short(number / 1000, "k");
  if (number < 1000000000) return short(number / 1000000, "M");
  return short(number / 1000000000, "G");
}

/** Есть ли расход: ноль и пустое значение — это отсутствие данных. */
function hasTokens(card) {
  return Number(String(card.tokens ?? "").replace(/\s+/g, "")) > 0;
}

/** Разметка одной карточки — структура повторяет компонент Card из плагина. */
function cardHtml(card) {
  const column = COLUMNS.find((item) => item.id === normalizeStatus(card.status)) || COLUMNS[0];
  const cardStyle = Object.assign({}, styles.card, { borderLeftColor: column.color });
  const role = roleLabelOf(card);
  const parts = [
    `<div style="${css(styles.cardTop)}">`,
    `<span style="${css(styles.cardId)}">#${escapeHtml(card.id)}</span>`,
    card.source === "worktree"
      ? `<span style="${css(styles.branchBadge)}" title="${escapeHtml(card.path || "")}">в ветке</span>`
      : "",
    role
      ? `<span style="${css(styles.roleBadge)}" title="${escapeHtml(
          card.since ? `${card.role} · с ${card.since}` : card.role
        )}">${escapeHtml(role)}</span>`
      : "",
    card.owner
      ? `<span style="${css(styles.owner)}" title="${escapeHtml(card.owner)}">${escapeHtml(shortOwner(card.owner))}</span>`
      : `<span style="${css(styles.ownerEmpty)}">не назначено</span>`,
    `</div>`,
    `<div style="${css(
      card.status === "merged" ? Object.assign({}, styles.cardTitle, styles.cardTitleMerged) : styles.cardTitle
    )}">${escapeHtml(card.title)}</div>`
  ];
  if (card.branch) parts.push(`<div style="${css(styles.meta)}">${escapeHtml(card.branch)}</div>`);
  if (hasTokens(card)) {
    parts.push(
      `<div style="${css(styles.meta)}" title="${escapeHtml(String(card.tokens))}">токенов: ${escapeHtml(formatTokens(card.tokens))}</div>`
    );
  }
  if (card.note) parts.push(`<div style="${css(styles.note)}">${escapeHtml(card.note)}</div>`);
  if (card.updated) parts.push(`<div style="${css(styles.meta)}">${escapeHtml(card.updated)}</div>`);
  return `<article style="${css(cardStyle)}" title=".kanban/tasks/${escapeHtml(card.id)}.md">${parts.join("")}</article>`;
}

/** Разметка доски целиком — структура повторяет компонент KanbanBody. */
function boardHtml() {
  const columns = COLUMNS.map((column) => ({
    column,
    items: CARDS.filter((card) => normalizeStatus(card.status) === column.id)
  }));
  const header = [
    `<div style="${css(styles.header)}">`,
    `<span style="${css(styles.headerTitle)}">Канбан</span>`,
    `<span style="${css(styles.headerMeta)}">${PROJECT_NAME} · ${CARDS.length} карточек</span>`,
    `<button style="${css(styles.refresh)}" title="Обновить сейчас">⟳</button>`,
    `</div>`
  ].join("");

  const body = columns
    .map(({ column, items }) => {
      const cards = items.length === 0
        ? `<div style="opacity:.35;font-size:11px">—</div>`
        : items.map(cardHtml).join("");
      return [
        `<section style="${css(styles.column)}">`,
        `<header style="${css(styles.columnHeader)}">`,
        `<span style="${css(Object.assign({}, styles.dot, { background: column.color }))}"></span>`,
        `<span>${escapeHtml(columnLabel(column.id))}</span>`,
        `<span style="${css(styles.count)}">${items.length}</span>`,
        `</header>`,
        `<div style="${css(styles.columnBody)}">${cards}</div>`,
        `</section>`
      ].join("");
    })
    .join("");

  return `<div style="${css(styles.root)}">${header}<div style="${css(styles.board)}">${body}</div></div>`;
}

const COLUMN_LABELS = {
  backlog: "Бэклог",
  todo: "Нужно сделать",
  "in-progress": "В работе",
  "in-review": "На ревью",
  review: "Тестирование",
  ready: "Готово к слиянию",
  merged: "Влито",
  blocked: "Заблокировано"
};
const columnLabel = (id) => COLUMN_LABELS[id] || id;

const params = new URLSearchParams(process.argv[2] || "");
const view = params.get("view") === "full" ? "full" : "panel";
const theme = params.get("theme") === "light" ? "light" : "dark";

const PALETTE = {
  dark: { bg: "#17181c", panel: "#1c1e23", panel2: "#212429", line: "rgba(255,255,255,.09)", text: "#e6e8eb", dim: "rgba(230,232,235,.6)", accent: "#3b82f6" },
  light: { bg: "#ffffff", panel: "#f7f8fa", panel2: "#eef0f4", line: "rgba(15,20,30,.12)", text: "#1b1d21", dim: "rgba(27,29,33,.6)", accent: "#2563eb" }
}[theme];

const FRAME_CSS = `
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; }
  body {
    background: ${PALETTE.bg}; color: ${PALETTE.text};
    font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .app { display: flex; height: 100vh; }
  .left { width: 236px; flex: 0 0 auto; background: ${PALETTE.panel}; border-right: 1px solid ${PALETTE.line}; padding: 10px 8px; }
  .brand { font-weight: 600; font-size: 12px; letter-spacing: .02em; padding: 6px 8px 10px; opacity: .9; }
  .ws { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; opacity: .45; padding: 10px 8px 4px; }
  .row { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 7px; font-size: 12.5px; }
  .row.active { background: ${PALETTE.panel2}; }
  .row .meta { margin-left: auto; font-size: 10.5px; opacity: .5; }
  .dot { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto; }
  .conv { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; border-right: 1px solid ${PALETTE.line}; }
  .convHead { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid ${PALETTE.line}; font-size: 12.5px; }
  .pill { font-size: 11px; padding: 2px 8px; border: 1px solid ${PALETTE.line}; border-radius: 999px; opacity: .75; }
  .msgs { flex: 1 1 auto; padding: 16px 18px; display: flex; flex-direction: column; gap: 14px; overflow: hidden; }
  .msg { max-width: 92%; font-size: 12.5px; }
  .msg.user { align-self: flex-end; background: ${PALETTE.panel2}; border: 1px solid ${PALETTE.line}; padding: 8px 10px; border-radius: 10px; }
  .msg.bot { opacity: .85; }
  .tool { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; border: 1px solid ${PALETTE.line}; border-radius: 8px; padding: 6px 8px; background: ${PALETTE.panel}; opacity: .8; }
  .composer { margin: 0 18px 16px; border: 1px solid ${PALETTE.line}; border-radius: 10px; padding: 10px 12px; font-size: 12.5px; opacity: .55; }
  .right { flex: 0 0 auto; display: flex; flex-direction: column; background: ${PALETTE.panel}; }
  .tabs { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid ${PALETTE.line}; }
  .tab { font-size: 12px; padding: 4px 10px; border-radius: 7px; opacity: .6; }
  .tab.active { background: ${PALETTE.panel2}; opacity: 1; }
  .tabs .spacer { flex: 1; }
  .ctrl { opacity: .45; font-size: 13px; }
  .host { flex: 1 1 auto; min-height: 0; overflow: hidden; }
  .caption { position: fixed; left: 50%; transform: translateX(-50%); bottom: 8px; font-size: 11px; opacity: .38; }
`;

const frame = view === "panel"
  ? `
  <div class="app">
    <aside class="left">
      <div class="brand">DeepSeek Harness</div>
      <div class="ws">Проекты</div>
      <div class="row active"><span class="dot" style="background:#22c55e"></span>${PROJECT_NAME}<span class="meta">2</span></div>
      <div class="row"><span class="dot" style="background:#3b82f6"></span>demo-t002<span class="meta">1</span></div>
      <div class="row"><span class="dot" style="background:#3b82f6"></span>demo-t003<span class="meta">1</span></div>
      <div class="ws">Сессии · ${PROJECT_NAME}</div>
      <div class="row active"><span class="dot" style="background:#f59e0b"></span>Диспетчер<span class="meta">сейчас</span></div>
      <div class="row"><span class="dot" style="background:#94a3b8"></span>Верификатор</div>
    </aside>
    <main class="conv">
      <div class="convHead">
        <strong>Диспетчер</strong>
        <span class="pill">dispatcher</span>
        <span class="spacer" style="flex:1"></span>
        <span class="ctrl">⇱</span>
      </div>
      <div class="msgs">
        <div class="msg user">Разбей работу по доске на задачи и раздай воркерам: плагин, пресеты, тесты.</div>
        <div class="msg bot">Завёл карточки 002–005 и три worktree. Воркеры уже в работе; четвертая задача ждёт верификатора.</div>
        <div class="tool">$ bin/task-new.sh "Колонки, карточки и опрос .kanban/tasks"</div>
        <div class="tool">задача 002: .kanban/tasks/002.md · worktree: ~/projects/demo-t002 (ветка task/002)</div>
        <div class="msg bot">Слежу за доской: как только карточка уйдёт в review — проверю и слью ветку.</div>
      </div>
      <div class="composer">Написать сообщение…</div>
    </main>
    <section class="right" style="width:1010px">
      <div class="tabs">
        <span class="tab">Файлы</span>
        <span class="tab active">Канбан</span>
        <span class="spacer"></span>
        <span class="ctrl">⤢</span>
        <span class="ctrl">✕</span>
      </div>
      <div class="host">${boardHtml()}</div>
    </section>
  </div>
  <div class="caption">Макет: рамка приложения нарисована приблизительно, доска — реальными стилями плагина</div>
  `
  : `
  <div class="app">
    <section class="right" style="width:100%">
      <div class="tabs">
        <span class="tab">Файлы</span>
        <span class="tab active">Канбан</span>
        <span class="spacer"></span>
        <span class="ctrl">⤢</span>
      </div>
      <div class="host">${boardHtml()}</div>
    </section>
  </div>
  `;

const html = `<!doctype html>
<html lang="ru" data-theme="${theme}">
<head>
<meta charset="utf-8">
<title>dsh-kanban — макет доски (${view}, ${theme})</title>
<style>${FRAME_CSS}</style>
</head>
<body>
${frame}
</body>
</html>
`;

const out = path.join(here, `board-mockup-${view}-${theme}.html`);
fs.writeFileSync(out, html, "utf8");
console.log("написан " + path.relative(process.cwd(), out));
