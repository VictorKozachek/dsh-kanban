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

/** Найти первый узел, подходящий под условие. */
function findNode(node, predicate) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findNode(child, predicate);
      if (found) return found;
    }
    return null;
  }
  if (node.props && predicate(node)) return node;
  return findNode(node.children, predicate);
}

/** Собрать объекты стилей узлов: по ним проверяем оформление. */
function collectStyles(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) collectStyles(child, out);
    return out;
  }
  if (node.props && node.props.style && typeof node.props.style === "object") out.push(node.props.style);
  collectStyles(node.children, out);
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
  ".kanban/worktrees.json": JSON.stringify({ version: 1, cards: ["/tmp/demo-t002/.kanban/tasks/002.md"] }),
  ".kanban/tasks/001.md": "---\nid: 001\ntitle: Скелет плагина\nstatus: merged\nupdated: 2026-09-23T14:00:00Z\n---\n",
  ".kanban/tasks/003.md": "---\nid: 003\ntitle: Пресеты агентов\nstatus: in-progress\ntokens: \"0\"\nupdated: 2026-09-23T15:12:00Z\n---\n",
  ".kanban/tasks/005.md":
    "---\nid: 005\ntitle: Инсталлятор пресетов\nstatus: ready\nowner: session-1a2b3c4d-77f0\nrole: reviewer\ntokens: 6000\ntokens_reviewer: 6000\nbranch: task/005\nsince: 2026-09-23T15:31:00Z\nupdated: 2026-09-23T15:31:00Z\n" +
    "note: \"" + "Длинный отчёт о прогоне. ".repeat(20) + "\"\n---\n",
  // Карточка из бэклога: статус свой, владельца нет — подпись «не назначено».
  ".kanban/tasks/007.md":
    "---\nid: 007\ntitle: Спека бэклога\nstatus: backlog\nowner: \"\"\nupdated: 2026-09-23T15:45:00Z\n---\n",
  "/tmp/demo-t002/.kanban/tasks/002.md":
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
            { name: "003.md", type: "file", size: 110 },
            { name: "007.md", type: "file", size: 90 }
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
    useSessions: (selector) => selector({ byId: { "session-1": { cwd: "/home/user/projects/demo-workspace" } } }),
    loadBoard: (signal) => plugin.__internals.createLoader(remote)("session-1", signal)
  };
  const tree = await render(body, props);
  return { captured, tree, text: collectText(tree).join(" | "), body, props };
}

// ── проверки ─────────────────────────────────────────────────────────────────

const { captured, tree, text, body, props } = await renderBoard(makeRemote());

// Регистрация в контексте
// Плагин регистрирует две вкладки: «Канбан» (#047) и «Дочерние доски» (#059).
// Вторая проверяется в children-render.test.mjs, здесь — только что первая цела.
assert.equal(captured.tabTypes.length, 2, "должны регистрироваться два типа табов");
const tabType = captured.tabTypes.find((type) => type.id === "dsh-kanban");
assert.ok(tabType, "нет типа таба dsh-kanban");
assert.equal(captured.tabTypes.find((type) => type.id === "dsh-kanban-children")?.kind, "kanban-children");
assert.equal(tabType.id, "dsh-kanban");
assert.equal(tabType.kind, "kanban");
assert.equal(tabType.priority, "extension");
assert.equal(typeof tabType.title, "function");
assert.equal(tabType.title(""), "Канбан");
assert.equal(tabType.guide.length, 1, "тип таба должен предлагать себя на странице-гиде");
assert.ok(captured.dicts.kanban && captured.dicts.kanban.ru, "словари ru/en должны регистрироваться");
assert.equal(captured.titles.length, 2, "у каждой из двух вкладок свой заголовок");
assert.ok(captured.titles.some((item) => item.key === "dsh-kanban"), "нет заголовка вкладки «Канбан»");

// Закрытые задачи: название зачёркнуто, и только у них (в фикстурах merged один).
// Панель деталей: содержимое карточки с описанием и комментариями.
const detailCard = plugin.__internals.parseCard(
  "900.md",
  [
    "---",
    'id: "900"',
    "title: Панель деталей",
    "status: in-review",
    "owner: session-abcdefghijkl",
    "role: reviewer",
    'spec: "001"',
    'tokens: "6000"',
    'tokens_reviewer: "6000"',
    "---",
    "",
    "## Задача",
    "Показать детали по клику.",
    "",
    "## Заметки",
    "",
    "- 2026-10-15T10:00:00Z [in-progress]",
    "  взял в работу",
    "",
    "- 2026-10-15T11:30:00Z [in-review]",
    "  ревью без замечаний",
    ""
  ].join("\n")
);
const detailsTree = await render(plugin.__internals.CardDetails, {
  card: detailCard,
  t: (key) => key,
  onClose: () => {}
});
const detailsText = collectText(detailsTree).join(" | ");
assert.ok(detailsText.includes("Панель деталей"), "в панели должно быть название задачи: " + detailsText);
assert.ok(detailsText.includes("Показать детали по клику."), "в панели должно быть описание");
assert.ok(detailsText.includes("взял в работу"), "в панели должен быть первый комментарий");
assert.ok(detailsText.includes("ревью без замечаний"), "в панели должен быть второй комментарий");
assert.ok(detailsText.includes("2026-10-15T10:00:00Z"), "у комментария должна быть дата");
assert.ok(detailsText.includes("in-progress"), "у комментария должен быть статус");
assert.ok(detailsText.includes("tokens"), "в панели должен быть расход: " + detailsText);
// Поле spec в карточке: ссылка на спецификацию видна в панели деталей.
assert.deepEqual(collectAttrs(detailsTree, "data-kanban-spec"), ["001"], "панель должна показывать поле spec");
assert.ok(detailsText.includes(".kanban/specs/001.md"), "в панели должна быть ссылка на спеку: " + detailsText);
assert.equal(collectAttrs(detailsTree, "data-kanban-comment").length, 2, "должны быть оба комментария");
assert.deepEqual(
  collectAttrs(detailsTree, "data-kanban-comment"),
  ["0", "1"],
  "комментарии должны идти в порядке появления"
);
assert.ok(
  detailsText.indexOf("взял в работу") < detailsText.indexOf("ревью без замечаний"),
  "первый комментарий должен стоять раньше второго: " + detailsText
);
assert.equal(collectAttrs(detailsTree, "data-kanban-details")[0], "900", "панель должна знать свою карточку");

// Карточки должны быть кликабельны: у каждой обработчик выбора.
function countHandlers(node, name) {
  if (!node || typeof node !== "object") return 0;
  if (Array.isArray(node)) return node.reduce((sum, child) => sum + countHandlers(child, name), 0);
  const own = node.props && typeof node.props[name] === "function" ? 1 : 0;
  return own + countHandlers(node.children, name);
}
assert.ok(
  countHandlers(tree, "onClick") >= 4,
  "у карточек должен быть обработчик клика: " + countHandlers(tree, "onClick")
);

// Клик по карточке: панель открывается, переключается и закрывается. Гоняем таб
// вручную, потому что render() сбрасывает состояние и клик не переживёт.
async function clickSequence(picks) {
  mini.reset();
  let result = null;
  let index = 0;
  // Проходы крутим до тишины: после последнего клика нужен ещё один рендер.
  for (let pass = 0; pass < 24; pass += 1) {
    mini.begin();
    result = resolve(mini.react.createElement(body, props));
    mini.runEffects();
    await new Promise((done) => setTimeout(done, 0));
    if (index < picks.length) {
      const node = findNode(result, picks[index]);
      if (node) {
        assert.equal(typeof node.props.onClick, "function", "у выбранного узла должен быть обработчик клика");
        index += 1;
        node.props.onClick();
        continue;
      }
    } else if (!mini.isDirty()) {
      break;
    }
  }
  mini.cleanup();
  assert.equal(index, picks.length, `не нашлись узлы для кликов: ${picks.length - index}`);
  return result;
}

const cardPicker = (id) => (node) => node.props["data-kanban-card"] === id;
const closePicker = (node) => node.props.type === "button" && node.props.title === props.t("close");

const afterFirstClick = await clickSequence([cardPicker("005")]);
assert.deepEqual(
  collectAttrs(afterFirstClick, "data-kanban-details"),
  ["005"],
  "после клика панель должна открыться на выбранной карточке"
);
assert.ok(
  collectText(afterFirstClick).join(" | ").includes("Инсталлятор пресетов"),
  "в панели должна быть карточка 005"
);

const afterSwitch = await clickSequence([cardPicker("005"), cardPicker("002")]);
assert.deepEqual(
  collectAttrs(afterSwitch, "data-kanban-details"),
  ["002"],
  "клик по другой карточке должен переключить панель"
);

const afterClose = await clickSequence([cardPicker("005"), closePicker]);
assert.deepEqual(
  collectAttrs(afterClose, "data-kanban-details"),
  [],
  "закрытие должно убрать панель"
);

// Панель должна прокручиваться: высота ограничена высотой доски, иначе её обрезает
// доска с overflowY: hidden, и вниз не доехать.
const panelNode = findNode(afterFirstClick, (node) => node.props["data-kanban-details"] === "005");
assert.ok(panelNode, "панель деталей должна быть найдена после клика");
assert.equal(panelNode.props.style.overflowY, "auto", "у панели должна быть своя прокрутка");
assert.equal(panelNode.props.style.alignSelf, "stretch", "панель должна растягиваться по высоте доски");
assert.equal(panelNode.props.style.position, "sticky", "панель должна оставаться у правого края");

const struck = collectStyles(tree).filter((style) => style.textDecoration === "line-through");
assert.equal(struck.length, 1, "зачёркнутым должно быть ровно название карточки в merged");
assert.ok(captured.titles.some((item) => item.key === "dsh-kanban"));

// Отрисовка
assert.match(text, /Канбан/, "в дереве есть заголовок доски");
assert.match(text, /demo-workspace · 5 карточек/, "в подписи — имя рабочей директории и число карточек");
for (const label of ["Бэклог", "Нужно сделать", "В работе", "Тестирование", "Готово к слиянию", "Влито", "Заблокировано"]) {
  assert.ok(text.includes(label), `нет колонки «${label}»`);
}
// Колонка backlog — первая, и карточка без владельца подписана «не назначено».
assert.equal(
  collectAttrs(tree, "data-kanban-column")[0],
  "backlog",
  "первая колонка доски — backlog"
);
assert.ok(text.includes("не назначено"), "у карточки без владельца должна быть подпись «не назначено»");
assert.ok(text.includes("#007") && text.includes("Спека бэклога"), "карточка из бэклога не отрисована");
assert.ok(text.includes("#001") && text.includes("Скелет плагина"), "карточка из основного чекаута не отрисована");
assert.ok(text.includes("#002") && text.includes("Колонки и карточки"), "карточка из worktree не отрисована");
assert.ok(text.includes("#005"), "третья карточка не отрисована");
assert.ok(text.includes("в ветке"), "нет значка «в ветке» у карточек из worktree");
assert.ok(text.includes("ревьювер"), "нет подписи роли на карточке");
assert.ok(text.includes("токенов: 6,0k"), "нет строки расхода токенов");
assert.ok(
  JSON.stringify(tree).includes("reviewer · с 2026-09-23T15:31:00Z"),
  "в подсказке чипа роли нет времени роли"
);
assert.ok(!text.includes("токенов: 0"), "нулевой расход не должен давать строку «токенов: 0»");
assert.ok(!text.includes("в ветке | #001") && !text.includes("#001 | в ветке"), "слитая карточка не должна иметь значок");
assert.ok(text.includes("session-71bd…"), "чип владельца не отрисован или не обрезан по правилу");
// Порядок в дереве — по колонкам, внутри колонки — по id.
assert.equal(
  collectAttrs(tree, "data-kanban-card").join(","),
  "007,002,003,005,001",
  "карточки идут по колонкам (backlog первой), внутри колонки — по id"
);
// Длинная заметка обрезается в видимом тексте, но целиком остаётся в title.
const fullNote = "Длинный отчёт о прогоне. ".repeat(20);
assert.ok(!text.includes(fullNote), "полная заметка не должна выводиться в тексте карточки");
assert.ok(text.includes("…"), "обрезанная заметка должна оканчиваться многоточием");
assert.ok(JSON.stringify(tree).includes(fullNote), "полный текст заметки должен остаться в title");

assert.equal(
  collectAttrs(tree, "data-kanban-status").join(","),
  "backlog,in-progress,in-progress,ready,merged",
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

// ── перенос карточки backlog ↔ todo (host-канал #047) ────────────────────────

const moveCards = {
  ".kanban/tasks/100.md": "---\nid: 100\ntitle: Черновик в бэклоге\nstatus: backlog\nowner: \"\"\nupdated: 2026-10-22T10:00:00Z\n---\n",
  ".kanban/tasks/101.md": "---\nid: 101\ntitle: Ждёт в очереди\nstatus: todo\nowner: session-abc\nrole: worker\nupdated: 2026-10-22T10:00:00Z\n---\n",
  ".kanban/tasks/102.md": "---\nid: 102\ntitle: Уже в работе\nstatus: in-progress\nowner: session-abc\nrole: worker\nupdated: 2026-10-22T10:00:00Z\n---\n",
  ".kanban/tasks/103.md": "---\nid: 103\ntitle: Слитая задача\nstatus: merged\nowner: \"\"\nupdated: 2026-10-22T10:00:00Z\n---\n"
};

/** Доска для переносов: три колонки с карточками, Remote только читает. */
function makeMoveRemote() {
  return {
    workspaceFiles: {
      list: async (_sessionId, dir) =>
        dir === ".kanban/tasks"
          ? {
              ok: true,
              value: {
                path: dir,
                truncated: false,
                entries: Object.keys(moveCards).map((path) => ({ name: path.split("/").pop(), type: "file", size: 10 }))
              }
            }
          : { ok: false, error: { code: "workspace-file/not-found" } },
      read: async (_sessionId, path) =>
        path in moveCards
          ? { ok: true, value: { text: moveCards[path], lines: 6, eof: true, version: "v1" } }
          : { ok: false, error: { code: "workspace-file/not-found" } }
    }
  };
}

/**
 * Доска с поддельным каналом: `responses` — ответы `connection.rpc.call` по
 * очереди (последний повторяется), плюс журнал вызовов.
 */
async function makeMoveBoard(responses, options = {}) {
  const remote = makeMoveRemote();
  const { ctx, captured } = makeContext(remote);
  const calls = [];
  if (options.connection !== false) {
    ctx.connection = {
      rpc: {
        call: async (api, endpoint, payload, signal) => {
          calls.push({ api, endpoint, payload, signal: Boolean(signal) });
          const next = responses.length > 1 ? responses.shift() : responses[0];
          return typeof next === "function" ? next(payload) : next;
        }
      }
    };
  }
  plugin.apply(ctx);
  const body = captured.bodies["dsh-kanban"];
  const mover = plugin.__internals.createCardMover(ctx.connection);
  const props = {
    sessionId: "session-1",
    t: ctx.locale.bind("kanban"),
    useSessions: (selector) => selector({ byId: { "session-1": { cwd: "/tmp/project" } } }),
    loadBoard: (signal) => plugin.__internals.createLoader(remote)("session-1", signal),
    moveCard: (action, cardId, signal) => mover("session-1", action, cardId, signal)
  };
  return { ctx, captured, calls, body, props };
}

/** Событие перетаскивания: браузерных dataTransfer и preventDefault хватает. */
function dragEvent() {
  const store = {};
  return {
    dataTransfer: {
      setData(type, value) {
        store[type] = value;
      },
      getData(type) {
        return store[type] || "";
      },
      effectAllowed: "",
      dropEffect: ""
    },
    prevented: 0,
    preventDefault() {
      this.prevented += 1;
    }
  };
}

function clickEvent() {
  return {
    stopped: 0,
    stopPropagation() {
      this.stopped += 1;
    }
  };
}

const pickCard = (id) => (node) => node.props["data-kanban-card"] === id;
const pickColumn = (id) => (node) => node.props["data-kanban-column"] === id;
const pickAction = (id, action) => (node) =>
  node.props["data-kanban-action-card"] === id && node.props["data-kanban-action"] === action;

/**
 * Прогнать доску через шаги: шаг получает готовое дерево и возвращает `true`,
 * когда обработчик вызван. Между шагами доска перерисовывается и ждёт промисы —
 * так проверяется вся цепочка «обработчик → канал → состояние → перерисовка».
 */
async function drive(board, steps) {
  mini.reset();
  let tree = null;
  let index = 0;
  for (let pass = 0; pass < 48; pass += 1) {
    mini.begin();
    tree = resolve(mini.react.createElement(board.body, board.props));
    mini.runEffects();
    await new Promise((done) => setTimeout(done, 0));
    if (index < steps.length) {
      const done = await steps[index](tree);
      if (done) {
        index += 1;
        continue;
      }
    } else if (!mini.isDirty()) {
      break;
    }
  }
  mini.cleanup();
  assert.equal(index, steps.length, `шаги не отработали: ${steps.length - index}`);
  return tree;
}

// Карточки бэклога и очереди можно тащить, остальные — нет; кнопки-дубли есть
// только у них, и колонками-целями объявлены только backlog и todo.
const dragBoard = await makeMoveBoard([{ ok: true, value: { ok: true, status: "todo", owner: "session-free", message: "" } }]);
const dragged = await drive(dragBoard, []);
assert.equal(findNode(dragged, pickCard("100")).props["data-kanban-draggable"], "1", "карточка бэклога должна тащиться");
assert.equal(findNode(dragged, pickCard("100")).props.draggable, "true", "нужен HTML-атрибут draggable");
assert.equal(findNode(dragged, pickCard("101")).props["data-kanban-draggable"], "1", "карточка очереди должна тащиться");
assert.equal(findNode(dragged, pickCard("102")).props["data-kanban-draggable"], undefined, "карточку в работе не тащат");
assert.equal(findNode(dragged, pickCard("103")).props["data-kanban-draggable"], undefined, "слитую карточку не тащат");
assert.deepEqual(collectAttrs(dragged, "data-kanban-action-card").sort(), ["100", "101"], "кнопки-дубли только у подвижных карточек");
assert.equal(findNode(dragged, pickColumn("todo")).props["data-kanban-drop"], "1", "todo — дроп-зона");
assert.equal(findNode(dragged, pickColumn("backlog")).props["data-kanban-drop"], "1", "backlog — дроп-зона");
assert.equal(findNode(dragged, pickColumn("in-progress")).props["data-kanban-drop"], undefined, "in-progress — не дроп-зона");
assert.equal(findNode(dragged, pickColumn("merged")).props["data-kanban-drop"], undefined, "merged — не дроп-зона");
const dragText = collectText(dragged).join(" | ");
assert.ok(dragText.includes("→ В работу"), "нет кнопки асайна: " + dragText);
assert.ok(dragText.includes("← В backlog"), "нет кнопки возврата: " + dragText);

// Дроп backlog → todo: асайн через host-команду с id карточки и сессией.
const assignBoard = await makeMoveBoard([{ ok: true, value: { ok: true, status: "todo", owner: "session-free", message: "" } }]);
const afterAssign = await drive(assignBoard, [
  (current) => {
    const card = findNode(current, pickCard("100"));
    if (!card) return false;
    const event = dragEvent();
    card.props.onDragStart(event);
    assert.equal(event.dataTransfer.getData("text/plain"), "100", "в dataTransfer должен уехать id карточки");
    return true;
  },
  (current) => {
    const column = findNode(current, pickColumn("todo"));
    if (!column) return false;
    const event = dragEvent();
    column.props.onDragOver(event);
    column.props.onDrop(event);
    return true;
  }
]);
assert.equal(
  JSON.stringify(assignBoard.calls.map((call) => [call.api, call.endpoint, call.payload])),
  JSON.stringify([["/api", "kanbanCardActions/assign", { args: { request: { sessionId: "session-1", cardId: "100" } } }]]),
  "дроп в todo должен звать assign для карточки 100"
);
assert.ok(assignBoard.calls[0].signal, "в канал должен уходить signal отмены");
assert.deepEqual(collectAttrs(afterAssign, "data-kanban-move-notice"), ["ok"], "успех показывается зелёным баннером");
assert.ok(collectText(afterAssign).join(" | ").includes("session-free"), "в баннере успеха — выбранный исполнитель");

// Дроп todo → backlog: возврат через unassign.
const unassignBoard = await makeMoveBoard([{ ok: true, value: { ok: true, status: "backlog", message: "" } }]);
await drive(unassignBoard, [
  (current) => {
    const card = findNode(current, pickCard("101"));
    if (!card) return false;
    card.props.onDragStart(dragEvent());
    return true;
  },
  (current) => {
    const column = findNode(current, pickColumn("backlog"));
    if (!column) return false;
    const event = dragEvent();
    column.props.onDragOver(event);
    column.props.onDrop(event);
    return true;
  }
]);
assert.equal(
  JSON.stringify(unassignBoard.calls.map((call) => [call.endpoint, call.payload.args.request.cardId])),
  JSON.stringify([["kanbanCardActions/unassign", "101"]]),
  "дроп в backlog должен звать unassign для карточки 101"
);

// Отказ хоста («все заняты») — баннер с текстом хоста, карточка остаётся на месте.
const refuseText = "все заняты: у каждого исполнителя есть карточка in-progress";
const refuseBoard = await makeMoveBoard([{ ok: true, value: { ok: false, status: "backlog", message: refuseText } }]);
const afterRefusal = await drive(refuseBoard, [
  (current) => {
    const card = findNode(current, pickCard("100"));
    if (!card) return false;
    card.props.onDragStart(dragEvent());
    return true;
  },
  (current) => {
    const column = findNode(current, pickColumn("todo"));
    if (!column) return false;
    column.props.onDrop(dragEvent());
    return true;
  }
]);
assert.deepEqual(collectAttrs(afterRefusal, "data-kanban-move-notice"), ["error"], "отказ хоста — баннер ошибки");
assert.ok(collectText(afterRefusal).join(" | ").includes("все заняты"), "в баннере должен быть текст хоста");
assert.equal(findNode(afterRefusal, pickCard("100")).props["data-kanban-status"], "backlog", "после отказа карточка осталась в бэклоге");

// Сбой канала — тоже баннер, а не молчание.
const brokenBoard = await makeMoveBoard([{ ok: false, error: { code: "transport/offline", message: "нет соединения" } }]);
const afterBroken = await drive(brokenBoard, [
  (current) => {
    const card = findNode(current, pickCard("100"));
    if (!card) return false;
    card.props.onDragStart(dragEvent());
    return true;
  },
  (current) => {
    const column = findNode(current, pickColumn("todo"));
    if (!column) return false;
    column.props.onDrop(dragEvent());
    return true;
  }
]);
assert.deepEqual(collectAttrs(afterBroken, "data-kanban-move-notice"), ["error"]);
assert.ok(collectText(afterBroken).join(" | ").includes("нет соединения"), "в баннере должна быть причина сбоя канала");

// Нет соединения вовсе — подсказка про канал, а не тихий отказ.
const offlineBoard = await makeMoveBoard([], { connection: false });
const afterOffline = await drive(offlineBoard, [
  (current) => {
    const button = findNode(current, pickAction("100", "assign"));
    if (!button) return false;
    button.props.onClick(clickEvent());
    return true;
  }
]);
assert.ok(
  collectText(afterOffline).join(" | ").includes("канал недоступен"),
  "без соединения кнопка должна объяснить, что канал недоступен"
);

// Дроп в чужую колонку — подсказка «двигают только агенты» и ни одного запроса.
const hintBoard = await makeMoveBoard([{ ok: true, value: { ok: true, status: "todo", owner: "w", message: "" } }]);
const afterHint = await drive(hintBoard, [
  (current) => {
    const card = findNode(current, pickCard("100"));
    if (!card) return false;
    card.props.onDragStart(dragEvent());
    return true;
  },
  (current) => {
    const column = findNode(current, pickColumn("in-progress"));
    if (!column) return false;
    column.props.onDrop(dragEvent());
    return true;
  }
]);
assert.equal(hintBoard.calls.length, 0, "в чужую колонку запросов быть не должно");
assert.ok(collectText(afterHint).join(" | ").includes("только агенты"), "нужна подсказка про агентов");

// Дроп на свою колонку — тишина: это не перенос.
const sameBoard = await makeMoveBoard([{ ok: true, value: { ok: true, status: "todo", owner: "w", message: "" } }]);
const afterSame = await drive(sameBoard, [
  (current) => {
    const card = findNode(current, pickCard("100"));
    if (!card) return false;
    card.props.onDragStart(dragEvent());
    return true;
  },
  (current) => {
    const column = findNode(current, pickColumn("backlog"));
    if (!column) return false;
    column.props.onDrop(dragEvent());
    return true;
  }
]);
assert.equal(sameBoard.calls.length, 0, "дроп на свою колонку не должен ничего двигать");
assert.deepEqual(collectAttrs(afterSame, "data-kanban-move-notice"), [], "подсказка на свою колонку не нужна");

// Кнопка-дубль делает то же, что дроп, и не открывает панель деталей.
const buttonBoard = await makeMoveBoard([{ ok: true, value: { ok: true, status: "todo", owner: "session-free", message: "" } }]);
const afterButton = await drive(buttonBoard, [
  (current) => {
    const button = findNode(current, pickAction("100", "assign"));
    if (!button) return false;
    const event = clickEvent();
    button.props.onClick(event);
    assert.equal(event.stopped, 1, "клик по кнопке не должен всплывать в панель деталей");
    return true;
  }
]);
assert.equal(
  JSON.stringify(buttonBoard.calls.map((call) => [call.endpoint, call.payload.args.request.cardId])),
  JSON.stringify([["kanbanCardActions/assign", "100"]]),
  "кнопка асайна должна звать канал"
);
assert.deepEqual(collectAttrs(afterButton, "data-kanban-details"), [], "клик по кнопке не открывает панель");

// Пока канал не ответил, кнопка неактивна и показывает «переношу…».
const gate = {};
gate.promise = new Promise((resolve) => {
  gate.release = resolve;
});
const busyBoard = await makeMoveBoard([gate.promise]);
mini.reset();
let busyTree = null;
const busyProps = busyBoard.props;
const busyBody = busyBoard.body;
for (let pass = 0; pass < 12; pass += 1) {
  mini.begin();
  busyTree = resolve(mini.react.createElement(busyBody, busyProps));
  mini.runEffects();
  await new Promise((done) => setTimeout(done, 0));
  if (findNode(busyTree, pickAction("100", "assign"))) break;
}
const busyButton = findNode(busyTree, pickAction("100", "assign"));
assert.ok(busyButton, "кнопка асайна должна быть до клика");
busyButton.props.onClick(clickEvent());
mini.begin();
busyTree = resolve(mini.react.createElement(busyBody, busyProps));
mini.runEffects();
await new Promise((done) => setTimeout(done, 0));
const busyAfter = findNode(busyTree, pickAction("100", "assign"));
assert.ok(busyAfter, "кнопка должна остаться на месте во время запроса");
assert.equal(busyAfter.props.disabled, true, "пока канал не ответил, кнопка неактивна");
assert.ok(collectText(busyTree).join(" | ").includes("переношу"), "во время запроса кнопка показывает «переношу…»");
gate.release({ ok: true, value: { ok: true, status: "todo", owner: "session-free", message: "" } });
await new Promise((done) => setTimeout(done, 0));
mini.cleanup();

console.log("render.test.mjs: все проверки прошли");
