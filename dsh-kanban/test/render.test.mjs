/**
 * Интеграционный тест доски без браузера: плагин регистрируется в поддельном
 * cordis-контексте, а компонент тела слота рендерится мини-рендерером React
 * (useState/useRef/useEffect с настоящим порядком хуков и выполнением эффектов).
 *
 * Так проверяется вся цепочка, которую иначе видно только в живом GUI:
 * apply → регистрация типа таба, словарей и тела слота → props → загрузка
 * данных через Remote → карточки и колонки в готовом дереве.
 *
 * Запуск: node dsh-kanban/test/render.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// ── мини-рендерер React ──────────────────────────────────────────────────────

function createMiniReact() {
  const cells = [];
  let cursor = 0;
  let effects = [];
  let cleanups = [];
  let dirty = false;

  function useState(initial) {
    const index = cursor++;
    if (!(index in cells)) cells[index] = typeof initial === "function" ? initial() : initial;
    const setState = (next) => {
      const value = typeof next === "function" ? next(cells[index]) : next;
      if (value !== cells[index]) {
        cells[index] = value;
        dirty = true;
      }
    };
    return [cells[index], setState];
  }

  function useRef(initial) {
    const index = cursor++;
    if (!(index in cells)) cells[index] = { current: initial };
    return cells[index];
  }

  function useEffect(fn, deps) {
    const index = cursor++;
    const previous = cells[index];
    const changed =
      !previous ||
      !deps ||
      !previous.deps ||
      deps.length !== previous.deps.length ||
      deps.some((value, i) => !Object.is(value, previous.deps[i]));
    cells[index] = { deps };
    if (changed) effects.push(fn);
  }

  return {
    react: {
      createElement: (type, props, ...children) =>
        ({ type, props: Object.assign({}, props, { children: children.length > 1 ? children : children[0] }) }),
      useState,
      useRef,
      useEffect,
      useCallback: (fn) => fn,
      useMemo: (fn) => fn()
    },
    begin() {
      cursor = 0;
      effects = [];
      dirty = false;
    },
    /** Свежий монтаж: в React у нового экземпляра компонента своё состояние. */
    reset() {
      cells.length = 0;
      cleanups.splice(0);
    },
    runEffects() {
      const pending = effects;
      effects = [];
      for (const fn of pending) {
        const cleanup = fn();
        if (typeof cleanup === "function") cleanups.push(cleanup);
      }
    },
    cleanup() {
      for (const fn of cleanups.splice(0)) fn();
    },
    isDirty: () => dirty
  };
}

/** Развернуть дерево элементов в плоскую структуру, вызывая компоненты. */
function resolve(node) {
  if (node === null || node === undefined || typeof node === "boolean") return null;
  if (Array.isArray(node)) return node.map(resolve).filter((child) => child !== null);
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (typeof node.type === "function") return resolve(node.type(node.props));
  return {
    type: node.type,
    props: node.props,
    children: resolve(node.props ? node.props.children : undefined)
  };
}

/** Собрать весь текст дерева. */
function collectText(node, out = []) {
  if (node === null || node === undefined) return out;
  if (typeof node === "string") {
    out.push(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  collectText(node.children, out);
  return out;
}

/** Собрать значения атрибутов data-* — по ним удобно проверять структуру. */
function collectAttrs(node, name, out = []) {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    if (Array.isArray(node)) for (const child of node) collectAttrs(child, name, out);
    return out;
  }
  const value = node.props ? node.props[name] : undefined;
  if (value !== undefined) out.push(String(value));
  collectAttrs(node.children, name, out);
  return out;
}

// ── загрузка плагина ─────────────────────────────────────────────────────────

const source = fs.readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
let entry = null;
const sandbox = {
  window: { __ModuleLoader__: { load: (value) => { entry = value; } } },
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  AbortController,
  JSON
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: "client.js" });

const mini = createMiniReact();
const plugin = entry.factory((name) => {
  if (name === "react") return mini.react;
  throw new Error("неожиданный require: " + name);
});

// ── поддельный cordis-контекст ───────────────────────────────────────────────

const TASKS = {
  ".kanban/worktrees.json": JSON.stringify({ version: 1, cards: ["/tmp/awg-t002/.kanban/tasks/002.md"] }),
  ".kanban/tasks/001.md": "---\nid: 001\ntitle: Скелет плагина\nstatus: merged\nupdated: 2026-09-23T14:00:00Z\n---\n",
  ".kanban/tasks/003.md": "---\nid: 003\ntitle: Пресеты агентов\nstatus: in-progress\nupdated: 2026-09-23T15:12:00Z\n---\n",
  ".kanban/tasks/005.md":
    "---\nid: 005\ntitle: Инсталлятор пресетов\nstatus: ready\nowner: session-1a2b3c4d-77f0\nrole: reviewer\ntokens: 6000\ntokens_reviewer: 6000\nbranch: task/005\nupdated: 2026-09-23T15:31:00Z\n" +
    "note: \"" + "Длинный отчёт о прогоне. ".repeat(20) + "\"\n---\n",
  "/tmp/awg-t002/.kanban/tasks/002.md":
    "---\nid: 002\ntitle: Колонки и карточки\nstatus: in-progress\nowner: session-71bd0c3e-4a92\nbranch: task/002\nupdated: 2026-09-23T15:40:00Z\n---\n"
};

function makeRemote(overrides = {}) {
  return {
    workspaceFiles: {
      list: async () => ({
        ok: true,
        value: {
          path: ".kanban/tasks",
          truncated: false,
          entries: [
            { name: "001.md", type: "file", size: 100 },
            { name: "005.md", type: "file", size: 120 },
            { name: "003.md", type: "file", size: 110 }
          ]
        }
      }),
      read: async (_sessionId, path) =>
        path in TASKS
          ? { ok: true, value: { text: TASKS[path], lines: 6, eof: true, version: "v1" } }
          : { ok: false, error: { code: "workspace-file/not-found" } },
      ...overrides
    }
  };
}

function makeContext(remote) {
  const captured = { tabTypes: [], dicts: {}, bodies: {}, titles: [] };
  const ctx = {
    locale: {
      register: (namespace, tables) => {
        captured.dicts[namespace] = tables;
        return () => {};
      },
      bind: (namespace) => (key) => {
        const tables = captured.dicts[namespace] || {};
        return (tables.ru && tables.ru[key]) || (tables.en && tables.en[key]) || key;
      }
    },
    sidebarRightTabs: {
      register: (definition) => {
        captured.tabTypes.push(definition);
        return () => {};
      }
    },
    slots: {
      inject: (name, callback) => {
        callback();
        return () => {};
      },
      register: (options, component) => {
        if (options.name === "sidebar.right.pane.tab") captured.bodies[options.key] = component;
        if (options.name === "sidebar.right.pane.tab.title") captured.titles.push({ key: options.key, component });
        return () => {};
      }
    },
    remote,
    effect: (fn) => {
      fn();
      return () => {};
    }
  };
  return { ctx, captured };
}

/** Отрендерить компонент с выполнением эффектов до стабилизации состояния. */
async function render(component, props, passes = 8) {
  mini.reset();
  let tree = null;
  for (let pass = 0; pass < passes; pass++) {
    mini.begin();
    tree = resolve(mini.react.createElement(component, props));
    mini.runEffects();
    await new Promise((done) => setTimeout(done, 0));
    if (!mini.isDirty()) break;
  }
  mini.cleanup();
  return tree;
}

async function renderBoard(remote) {
  const { ctx, captured } = makeContext(remote);
  plugin.apply(ctx);
  const body = captured.bodies["dsh-kanban"];
  assert.ok(body, "тело таба не зарегистрировано под ключом dsh-kanban");
  const props = {
    sessionId: "session-1",
    t: ctx.locale.bind("kanban"),
    useSessions: (selector) => selector({ byId: { "session-1": { cwd: "/Users/victor/projects/awg" } } }),
    loadBoard: (signal) => plugin.__internals.createLoader(remote)("session-1", signal)
  };
  const tree = await render(body, props);
  return { captured, tree, text: collectText(tree).join(" | ") };
}

// ── проверки ─────────────────────────────────────────────────────────────────

const { captured, tree, text } = await renderBoard(makeRemote());

// Регистрация в контексте
assert.equal(captured.tabTypes.length, 1, "должен регистрироваться ровно один тип таба");
const tabType = captured.tabTypes[0];
assert.equal(tabType.id, "dsh-kanban");
assert.equal(tabType.kind, "kanban");
assert.equal(tabType.priority, "extension");
assert.equal(typeof tabType.title, "function");
assert.equal(tabType.title(""), "Канбан");
assert.equal(tabType.guide.length, 1, "тип таба должен предлагать себя на странице-гиде");
assert.ok(captured.dicts.kanban && captured.dicts.kanban.ru, "словари ru/en должны регистрироваться");
assert.equal(captured.titles.length, 1, "заголовок таба должен регистрироваться");
assert.equal(captured.titles[0].key, "dsh-kanban");

// Отрисовка
assert.match(text, /Канбан/, "в дереве есть заголовок доски");
assert.match(text, /awg · 4 карточек/, "в подписи — имя рабочей директории и число карточек");
for (const label of ["Нужно сделать", "В работе", "Тестирование", "Готово к слиянию", "Влито", "Заблокировано"]) {
  assert.ok(text.includes(label), `нет колонки «${label}»`);
}
assert.ok(text.includes("#001") && text.includes("Скелет плагина"), "карточка из основного чекаута не отрисована");
assert.ok(text.includes("#002") && text.includes("Колонки и карточки"), "карточка из worktree не отрисована");
assert.ok(text.includes("#005"), "третья карточка не отрисована");
assert.ok(text.includes("в ветке"), "нет значка «в ветке» у карточек из worktree");
assert.ok(text.includes("ревьювер"), "нет подписи роли на карточке");
assert.ok(text.includes("токенов: 6,0k"), "нет строки расхода токенов");
assert.ok(!text.includes("в ветке | #001") && !text.includes("#001 | в ветке"), "слитая карточка не должна иметь значок");
assert.ok(text.includes("session-71bd…"), "чип владельца не отрисован или не обрезан по правилу");
// Порядок в дереве — по колонкам, внутри колонки — по id.
assert.equal(
  collectAttrs(tree, "data-kanban-card").join(","),
  "002,003,005,001",
  "карточки идут по колонкам, внутри колонки — по id"
);
// Длинная заметка обрезается в видимом тексте, но целиком остаётся в title.
const fullNote = "Длинный отчёт о прогоне. ".repeat(20);
assert.ok(!text.includes(fullNote), "полная заметка не должна выводиться в тексте карточки");
assert.ok(text.includes("…"), "обрезанная заметка должна оканчиваться многоточием");
assert.ok(JSON.stringify(tree).includes(fullNote), "полный текст заметки должен остаться в title");

assert.equal(
  collectAttrs(tree, "data-kanban-status").join(","),
  "in-progress,in-progress,ready,merged",
  "статусы карточек соответствуют своим колонкам"
);

// Пустая доска — подсказка, а не пустота.
const empty = await renderBoard({
  workspaceFiles: {
    list: async () => ({ ok: true, value: { entries: [], truncated: false } }),
    read: async () => ({ ok: false, error: { code: "workspace-file/not-found" } })
  }
});
assert.match(empty.text, /Карточек пока нет/);
assert.match(empty.text, /bin\/task-new\.sh/);

// Ошибка Remote — баннер, а не пустой экран.
const failed = await renderBoard({
  workspaceFiles: {
    list: async () => ({ ok: false, error: { code: "workspace-file/outside-workspace" } }),
    read: async () => ({ ok: false, error: { code: "workspace-file/not-found" } })
  }
});
assert.match(failed.text, /Ошибка чтения доски/);
assert.match(failed.text, /workspace-file\/outside-workspace/);

console.log("render.test.mjs: все проверки прошли");
