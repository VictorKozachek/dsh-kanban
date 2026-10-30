/**
 * Тест вкладки «Дочерние доски» (#059, спека 004) без браузера.
 *
 * По образцу `render.test.mjs`: плагин регистрируется в поддельном cordis-контексте,
 * тело слота рендерится мини-рендерером React. Проверяется то, что иначе видно
 * только в живом GUI: вторая вкладка зарегистрирована, сводка строится деревом,
 * drill-down открывает доску ребёнка, пустые состояния объясняют, что делать,
 * и — главное — во вкладке нет ни одного элемента переноса.
 *
 * Запуск: node dsh-kanban/test/children-render.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// ── мини-рендерер React (useState/useRef/useEffect с настоящим порядком) ─────

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

function resolve(node) {
  if (node === null || node === undefined || typeof node === "boolean") return null;
  if (Array.isArray(node)) return node.map(resolve).filter((child) => child !== null);
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (typeof node.type === "function") return resolve(node.type(node.props));
  return { type: node.type, props: node.props, children: resolve(node.props ? node.props.children : undefined) };
}

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

/** Все узлы, у которых есть атрибут `name`. */
function nodesWith(node, name, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) nodesWith(child, name, out);
    return out;
  }
  if (node.props && node.props[name] !== undefined) out.push(node);
  nodesWith(node.children, name, out);
  return out;
}

/** Все значения атрибутов `name`. */
function attrValues(node, name) {
  return nodesWith(node, name).map((item) => String(item.props[name]));
}

/** Все узлы `type` (по имени тега) — например, все кнопки. */
function nodesOfType(node, type, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) nodesOfType(child, type, out);
    return out;
  }
  if (node.type === type) out.push(node);
  nodesOfType(node.children, type, out);
  return out;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

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

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`   ok: ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`   ПРОВАЛ: ${name}\n      ${error.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`   ok: ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`   ПРОВАЛ: ${name}\n      ${error.message}`);
  }
}

// ── поддельный cordis-контекст ───────────────────────────────────────────────

function makeContext(connection) {
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
        if (options.name === "sidebar.right.pane.tab") captured.bodies[options.key] = { component, options };
        if (options.name === "sidebar.right.pane.tab.title") captured.titles.push({ key: options.key, component });
        return () => {};
      }
    },
    remote: { workspaceFiles: {} },
    connection,
    effect: (fn) => {
      fn();
      return () => {};
    }
  };
  return { ctx, captured };
}

/**
 * Смонтировать компонент и вернуть управление: `click(attr)` нажимает на узел с
 * этим атрибутом, `text()` — весь текст дерева.
 */
async function mount(component, props, passes = 8) {
  mini.reset();
  let tree = null;
  const step = async () => {
    for (let pass = 0; pass < passes; pass += 1) {
      mini.begin();
      tree = resolve(mini.react.createElement(component, props));
      mini.runEffects();
      await sleep(0);
      if (!mini.isDirty()) break;
    }
  };
  await step();
  return {
    get tree() {
      return tree;
    },
    text: () => collectText(tree).join(" | "),
    has: (attr) => nodesWith(tree, attr).length > 0,
    attrs: (attr) => attrValues(tree, attr),
    async click(attr) {
      const nodes = nodesWith(tree, attr);
      assert.ok(nodes.length > 0, `нет узла с атрибутом ${attr}`);
      nodes[0].props.onClick();
      await step();
    },
    async clickValue(attr, value) {
      const nodes = nodesWith(tree, attr).filter((item) => String(item.props[attr]) === String(value));
      assert.ok(nodes.length > 0, `нет узла ${attr}=${value}`);
      nodes[0].props.onClick();
      await step();
    },
    async clickNode(node) {
      node.props.onClick();
      await step();
    },
    cleanup: () => mini.cleanup()
  };
}

// ── поддельный обзор ─────────────────────────────────────────────────────────

const OVERVIEW = {
  boards: [
    {
      path: "aif-project",
      absPath: "/ws/aif-project",
      title: "aif-project",
      counts: { backlog: 1, todo: 0, "in-progress": 1, "in-review": 0, testing: 0, ready: 1, blocked: 0 },
      inProgress: [
        { id: "003", title: "Колонки", owner: "sess-71bd0c3e-4a92", role: "worker", updated: "2026-10-30T12:00:00Z" }
      ],
      cards: [
        { id: "003", title: "Колонки", status: "in-progress", owner: "sess-71bd0c3e-4a92", role: "worker", updated: "2026-10-30T12:00:00Z", source: "worktree", tokens: 6000, usage: { worker: 6000 }, spec: "004", description: "Первый абзац задачи." },
        { id: "007", title: "Спека", status: "backlog", owner: "", updated: "2026-10-30T10:00:00Z" }
      ],
      problems: [],
      missing: false
    },
    {
      path: "aif-project/infra",
      absPath: "/ws/aif-project/infra",
      title: "infra",
      counts: { backlog: 0, todo: 1, "in-progress": 0, "in-review": 0, testing: 0, ready: 0, blocked: 0 },
      inProgress: [],
      cards: [{ id: "010", title: "Кластер", status: "todo", owner: "", updated: "2026-10-30T09:00:00Z" }],
      problems: [],
      missing: false
    },
    {
      path: "outside/gone",
      absPath: "/ws/outside/gone",
      title: "gone",
      counts: { backlog: 0, todo: 0, "in-progress": 0, "in-review": 0, testing: 0, ready: 0, blocked: 0 },
      inProgress: [],
      cards: [],
      problems: ["доска не найдена"],
      missing: true
    }
  ],
  problems: [],
  manifest: "ok"
};

/** Канал с одним методом `kanbanChildren/read`: отдаём заданный ответ. */
function makeConnection(response) {
  const calls = [];
  return {
    calls,
    rpc: {
      call: async (namespace, method, params, signal) => {
        calls.push({ namespace, method, params, signal });
        if (typeof response === "function") return response(namespace, method, params);
        return response;
      }
    }
  };
}

const okEnvelope = { ok: true, value: { ok: true, value: OVERVIEW } };

/** Отрисовать вкладку «Дочерние доски» на заданном канале. */
async function renderChildren(connection) {
  const { ctx, captured } = makeContext(connection);
  plugin.apply(ctx);
  const body = captured.bodies[plugin.__internals.CHILDREN_ID];
  assert.ok(body, "тело вкладки «Дочерние доски» не зарегистрировано");
  const t = ctx.locale.bind("kanban");
  const view = await mount(body.component, Object.assign({ sessionId: "session-1", t }, body.options.inject("session-1")));
  return { captured, view, t };
}

console.log("== регистрация второй вкладки");

check("плагин регистрирует две вкладки: «Канбан» и «Дочерние доски»", () => {
  const { captured } = { captured: null };
  void captured;
  const connection = makeConnection(okEnvelope);
  const made = makeContext(connection);
  plugin.apply(made.ctx);
  const types = made.captured.tabTypes;
  assert.equal(types.length, 2, `типов табов: ${types.length}`);
  const kanban = types.find((type) => type.id === "dsh-kanban");
  const children = types.find((type) => type.id === "dsh-kanban-children");
  assert.ok(kanban, "нет типа «Канбан»");
  assert.ok(children, "нет типа «Дочерние доски»");
  assert.equal(children.kind, "kanban-children");
  assert.equal(children.priority, "extension");
  const guide = children.guide[0];
  assert.ok(guide.title().length > 0, "пустой заголовок в гиде");
  assert.match(guide.description(), /children\.json/);
  assert.ok(made.captured.titles.some((item) => item.key === "dsh-kanban-children"), "нет заголовка второй вкладки");
});

console.log("== сводка по дереву");

const { view, captured, t } = await renderChildren(makeConnection(okEnvelope));
const text = view.text();

await checkAsync("список досок — деревом: заголовки, пути и отступ по уровням", async () => {
  assert.equal(view.has("data-kanban-children-tree"), true, "нет дерева досок");
  assert.deepEqual(view.attrs("data-kanban-children-board"), ["aif-project", "aif-project/infra", "outside/gone"]);
  const depths = view.attrs("data-kanban-children-depth").map(Number);
  assert.deepEqual(depths, [0, 1, 1], `отступы уровней: ${depths.join(",")}`);
  assert.ok(text.includes("aif-project"), "нет заголовка корневой доски");
  assert.ok(text.includes("infra"), "нет заголовка дочерней доски");
});

await checkAsync("счётчики по статусам и карточки «в работе» видны в сводке", async () => {
  const counts = view.attrs("data-kanban-children-count");
  assert.ok(counts.includes("backlog"), "нет счётчика backlog");
  assert.ok(counts.includes("in-progress"), "нет счётчика in-progress");
  assert.ok(counts.includes("todo"), "нет счётчика todo");
  assert.deepEqual(view.attrs("data-kanban-children-inprogress"), ["003"]);
  assert.ok(text.includes("Колонки"), "нет названия карточки в работе");
  assert.ok(/sess-71bd0c3e/.test(text), "нет владельца карточки в работе");
});

await checkAsync("ошибка доски — отдельной строкой, остальные доски на месте", async () => {
  assert.ok(text.includes("доска не найдена"), "нет проблемы доски");
  assert.ok(text.includes("нет доски"), "нет значка отсутствующей доски");
  assert.equal(view.attrs("data-kanban-children-board").length, 3, "пропали доски из-за ошибки одной");
});

await checkAsync("вкладка только для чтения: нет перетаскивания, кнопок перевода и тоста", async () => {
  for (const attr of ["draggable", "onDragStart", "data-kanban-move", "data-kanban-move-notice", "data-kanban-drop"]) {
    assert.equal(view.has(attr), false, `во вкладке есть ${attr}`);
  }
  const buttons = nodesOfType(view.tree, "button");
  assert.equal(buttons.length, 1, `кнопок должно быть одна (⟳), а не ${buttons.length}`);
  assert.equal(buttons[0].props["data-kanban-children-refresh"], "1");
  assert.equal(text.includes("переношу"), false, "в тексте есть тост переноса");
});

console.log("== drill-down: доска ребёнка только для чтения");

await view.click("data-kanban-children-board");

await checkAsync("клик по доске открывает её колонки с карточками", async () => {
  assert.equal(view.has("data-kanban-children-open"), true, "drill-down не открылся");
  assert.deepEqual(view.attrs("data-kanban-children-open"), ["aif-project"]);
  const columns = view.attrs("data-kanban-children-column");
  assert.ok(columns.includes("backlog") && columns.includes("in-progress"), `колонки: ${columns.join(",")}`);
  assert.deepEqual(view.attrs("data-kanban-children-card-id").sort(), ["003", "007"]);
});

await checkAsync("колонки drill-down тоже без переноса и без кнопок перевода", async () => {
  assert.equal(view.has("draggable"), false, "карточки доски ребёнка перетаскиваются");
  const buttons = nodesOfType(view.tree, "button");
  const labels = buttons.map((button) => String(button.props["data-kanban-children-back"] || "refresh"));
  assert.deepEqual(labels, ["refresh", "1"], `кнопки: ${labels.join(",")}`);
});

await view.clickValue("data-kanban-children-card-id", "003");

await checkAsync("клик по карточке показывает детали: описание, расход, spec", async () => {
  assert.deepEqual(view.attrs("data-kanban-children-details"), ["003"]);
  const detailsText = collectText(nodesWith(view.tree, "data-kanban-children-details")[0]).join(" | ");
  assert.ok(detailsText.includes("Первый абзац задачи."), "нет описания");
  assert.match(detailsText, /6,0k|6000/, "нет расхода");
  assert.ok(detailsText.includes(".kanban/specs/004.md"), "нет ссылки на спеку");
});

await view.click("data-kanban-children-back");

await checkAsync("кнопка «к списку досок» возвращает сводку", async () => {
  assert.equal(view.has("data-kanban-children-open"), false, "drill-down не закрылся");
  assert.equal(view.has("data-kanban-children-tree"), true, "дерево не вернулось");
});

view.cleanup();

console.log("== ⟳ обновляет то, что нарисовано, а не только счётчики");

/**
 * Канал, который отдаёт сначала OVERVIEW, а потом — ту же сводку с изменёнными
 * полями карточек: владелец и название меняются, а счётчики по статусам и число
 * карточек «в работе» остаются прежними. Ровно этот случай ревью и поймало.
 */
function changedOverview() {
  const next = JSON.parse(JSON.stringify(OVERVIEW));
  const card = next.boards[0].cards.find((item) => item.id === "003");
  card.owner = "sess-NEW-OWNER";
  card.title = "Колонки (переименовано)";
  card.updated = "2026-10-30T18:00:00Z";
  next.boards[0].inProgress[0] = {
    id: "003",
    title: "Колонки (переименовано)",
    owner: "sess-NEW-OWNER",
    role: "worker",
    updated: "2026-10-30T18:00:00Z"
  };
  return next;
}

await checkAsync("смена владельца/названия без смены счётчиков доезжает по ⟳", async () => {
  const calls = [];
  const connection = makeConnection((namespace, method) => {
    calls.push(method);
    const payload = calls.length === 1 ? OVERVIEW : changedOverview();
    return { ok: true, value: { ok: true, value: payload } };
  });
  const fresh = await renderChildren(connection);
  assert.equal(calls.length, 1, "первый тик не спросил обзор");
  assert.equal(fresh.view.text().includes("sess-NEW-OWNER"), false, "новые данные появились до ⟳");
  // Счётчики и число карточек в работе не меняются — подпись старой проверки была бы той же.
  assert.deepEqual(
    fresh.view.attrs("data-kanban-children-count").sort(),
    ["backlog", "in-progress", "ready", "todo"],
    "в фикстуре изменились счётчики — сценарий не проверяет подпись"
  );
  await fresh.view.click("data-kanban-children-refresh");
  assert.ok(calls.length >= 2, "⟳ не перезапросил обзор");
  const text = fresh.view.text();
  assert.ok(text.includes("sess-NEW-OWNER"), `после ⟳ нет нового владельца: ${text.slice(0, 300)}`);
  assert.ok(text.includes("Колонки (переименовано)"), "после ⟳ нет нового названия");
  assert.ok(text.includes("2026-10-30T18:00:00Z"), "после ⟳ нет нового updated");
  fresh.view.cleanup();
});

await checkAsync("⟳ обновляет и drill-down с панелью деталей", async () => {
  const calls = [];
  const connection = makeConnection((namespace, method) => {
    calls.push(method);
    const payload = calls.length === 1 ? OVERVIEW : changedOverview();
    return { ok: true, value: { ok: true, value: payload } };
  });
  const fresh = await renderChildren(connection);
  await fresh.view.click("data-kanban-children-board");
  await fresh.view.clickValue("data-kanban-children-card-id", "003");
  const before = collectText(nodesWith(fresh.view.tree, "data-kanban-children-details")[0]).join(" | ");
  assert.equal(before.includes("sess-NEW-OWNER"), false, "новые данные появились до ⟳");
  await fresh.view.click("data-kanban-children-refresh");
  const after = collectText(nodesWith(fresh.view.tree, "data-kanban-children-details")[0]).join(" | ");
  assert.ok(after.includes("sess-NEW-OWNER"), `в панели деталей нет нового владельца: ${after.slice(0, 300)}`);
  fresh.view.cleanup();
});

console.log("== пустые состояния и ошибки канала");

await checkAsync("нет манифеста — подсказка с командой bin/board-children.sh", async () => {
  const connection = makeConnection({ ok: true, value: { ok: true, value: { boards: [], problems: ["манифеста нет"], manifest: "missing" } } });
  const empty = await renderChildren(connection);
  assert.deepEqual(empty.view.attrs("data-kanban-children-empty"), ["manifest"]);
  assert.ok(empty.view.text().includes("bin/board-children.sh --root"), "нет команды в подсказке");
  empty.view.cleanup();
});

await checkAsync("битый манифест и пустой список досок — разные пустые состояния", async () => {
  const broken = await renderChildren(
    makeConnection({ ok: true, value: { ok: true, value: { boards: [], problems: ["манифест не разобран"], manifest: "broken" } } })
  );
  assert.deepEqual(broken.view.attrs("data-kanban-children-empty"), ["broken"]);
  broken.view.cleanup();
  const none = await renderChildren(
    makeConnection({ ok: true, value: { ok: true, value: { boards: [], problems: [], manifest: "ok" } } })
  );
  assert.deepEqual(none.view.attrs("data-kanban-children-empty"), ["boards"]);
  none.view.cleanup();
});

await checkAsync("отказ службы — баннер с текстом, а не пустая вкладка", async () => {
  const refused = await renderChildren(
    makeConnection({ ok: true, value: { ok: false, message: "не удалось определить каталог сессии" } })
  );
  assert.equal(refused.view.has("data-kanban-children-error"), true, "нет баннера ошибки");
  assert.ok(refused.view.text().includes("не удалось определить каталог сессии"), refused.view.text());
  refused.view.cleanup();
});

await checkAsync("нет канала — «канал обзора недоступен», а не «обзор не прочитан»", async () => {
  const offline = await renderChildren(undefined);
  assert.equal(offline.view.has("data-kanban-children-error"), true);
  assert.ok(offline.view.text().includes("канал обзора недоступен"), offline.view.text());
  offline.view.cleanup();
});

console.log("== читатель канала");

check("читатель шлёт kanbanChildren/read с одним аргументом sessionId", async () => {
  const connection = makeConnection(okEnvelope);
  const read = plugin.__internals.createChildrenReader(connection);
  const result = await read("session-1");
  assert.equal(result.ok, true);
  assert.equal(result.value.boards.length, 3);
  assert.equal(connection.calls.length, 1);
  assert.equal(connection.calls[0].method, "kanbanChildren/read");
  assert.deepEqual(connection.calls[0].params, { args: { request: { sessionId: "session-1" } } });
});

check("читатель различает отказ транспорта, отказ службы и отсутствие канала", async () => {
  const transport = plugin.__internals.createChildrenReader(makeConnection({ ok: false, error: { code: "x", message: "boom" } }));
  const first = await transport("session-1");
  assert.equal(first.ok, false);
  assert.match(first.error, /boom/);
  const refused = plugin.__internals.createChildrenReader(makeConnection({ ok: true, value: { ok: false, message: "нет сессии" } }));
  const second = await refused("session-1");
  assert.equal(second.ok, false);
  assert.equal(second.error, "нет сессии");
  const offline = plugin.__internals.createChildrenReader(undefined);
  const third = await offline("session-1");
  assert.equal(third.ok, false);
  assert.equal(third.offline, true);
});

console.log("== каркас вкладки не сломал доску");

check("первая вкладка по-прежнему зарегистрирована под своим ключом и с канбан-словарём", () => {
  const made = makeContext(makeConnection(okEnvelope));
  plugin.apply(made.ctx);
  assert.ok(made.captured.bodies["dsh-kanban"], "нет тела первой вкладки");
  assert.ok(made.captured.dicts["kanban"], "нет словаря");
  assert.ok(made.captured.dicts["kanban"].ru["children.title"], "нет словаря второй вкладки");
  assert.equal(made.captured.dicts["kanban"].ru["children.title"], "Дочерние доски");
  assert.equal(made.captured.dicts["kanban"].en["children.title"], "Child boards");
  void t;
  void captured;
  void view;
});

console.log(`\nвсего: ${passed} ok, ${failed} провал(ов)`);
process.exit(failed > 0 ? 1 : 0);
