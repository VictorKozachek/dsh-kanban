/**
 * Smoke-тесты браузерной половины плагина: бандл грузится в песочницу как
 * классический скрипт, React подменяется заглушкой, дальше проверяются
 * разбор карточек и читатель доски на фейковом Remote.
 *
 * Запуск: node dsh-kanban/test/parse.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

let entry = null;
const sandbox = {
  window: {
    __ModuleLoader__: {
      load: (value) => {
        entry = value;
      }
    }
  },
  console
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: "client.js" });

assert.ok(entry, "бандл не зарегистрировался через window.__ModuleLoader__.load");
assert.equal(entry.id, "dsh-kanban", "id бандла должен совпадать с именем пакета");

const reactStub = {
  createElement: () => null,
  useState: () => [null, () => {}],
  useRef: () => ({ current: null }),
  useEffect: () => {}
};
const plugin = entry.factory((name) => {
  if (name === "react") return reactStub;
  throw new Error("неожиданный require: " + name);
});

assert.equal(typeof plugin.apply, "function", "нет exports.apply");
assert.ok(Array.isArray(plugin.inject), "нет exports.inject");
assert.ok(plugin.inject.includes("slots"), "в inject нет сервиса slots");
assert.ok(plugin.inject.includes("sidebarRightTabs"), "в inject нет сервиса sidebarRightTabs");

const { parseCard, normalizeStatus, createLoader, COLUMNS } = plugin.__internals;

// --- статусы ----------------------------------------------------------------
// Тело карточки: описание и комментарии ролей для панели деталей.
const withNotes = [
  "---",
  'id: "900"',
  "title: С комментариями",
  "status: in-review",
  "---",
  "",
  "## Задача",
  "Сделать панель деталей.",
  "",
  "## Критерии готовности",
  "- [ ] панель открывается",
  "",
  "## Заметки",
  "",
  "- 2026-10-15T10:00:00Z [in-progress]",
  "  взял в работу, смотрю код",
  "",
  "- 2026-10-15T11:30:00Z [in-review]",
  "  ревью: замечаний нет",
  ""
].join("\n");
const parsedCard = plugin.__internals.parseCard("900.md", withNotes);
assert.equal(parsedCard.description, "Сделать панель деталей.", "описание должно браться из раздела «Задача»");
assert.equal(parsedCard.comments.length, 2, "должны найтись оба комментария");
assert.equal(parsedCard.comments[0].at, "2026-10-15T10:00:00Z");
assert.equal(parsedCard.comments[0].status, "in-progress");
assert.equal(parsedCard.comments[0].text, "взял в работу, смотрю код");
assert.equal(parsedCard.comments[1].status, "in-review");
assert.equal(parsedCard.comments[1].text, "ревью: замечаний нет");
assert.equal(plugin.__internals.splitCardBody("").comments.length, 0, "пустое тело — без комментариев");

// Многострочные описания и комментарии не должны обрезаться (находка тестировщика:
// при флаге m знак $ совпадал с концом строки и ленивая группа рвалась).
const multiline = [
  "---",
  'id: "901"',
  "title: Многострочная",
  "status: testing",
  "---",
  "",
  "## Задача",
  "Первая строка описания.",
  "Вторая строка описания.",
  "Третья строка описания.",
  "",
  "## Заметки",
  "",
  "- 2026-10-15T12:00:00Z [testing]",
  "  Первый абзац комментария.",
  "  ",
  "  Второй абзац комментария.",
  "",
  "- 2026-10-15T13:00:00Z [ready]",
  "  Короткий второй комментарий.",
  ""
].join("\n");
const multiCard = plugin.__internals.parseCard("901.md", multiline);
assert.equal(
  multiCard.description,
  "Первая строка описания.\nВторая строка описания.\nТретья строка описания.",
  "описание должно доехать целиком"
);
assert.equal(multiCard.comments.length, 2, "должны быть оба комментария");
assert.equal(
  multiCard.comments[0].text,
  "Первый абзац комментария.\n\nВторой абзац комментария.",
  "комментарий из двух абзацев должен доехать целиком"
);
assert.equal(multiCard.comments[1].text, "Короткий второй комментарий.");
assert.equal(multiCard.comments[1].status, "ready");

// Раздел между записями не должен вклеиваться в комментарий (находка ревьювера:
// блок тянулся до следующей записи и вбирал отчёты, 15% записей на доске).
const withSection = [
  "---",
  'id: "902"',
  "title: С разделом",
  "status: in-review",
  "---",
  "",
  "## Задача",
  "Описание.",
  "",
  "## Заметки",
  "",
  "- 2026-10-15T12:00:00Z [in-review]",
  "  Комментарий роли.",
  "",
  "## Сделано",
  "Отчёт исполнителя, к комментарию не относится.",
  ""
].join("\n");
const sectionCard = plugin.__internals.parseCard("902.md", withSection);
assert.equal(sectionCard.comments.length, 1, "должен быть один комментарий");
assert.equal(sectionCard.comments[0].text, "Комментарий роли.", "раздел не должен попадать в комментарий");
// Проза карточки без заголовка и без отступа тоже не должна попадать в комментарий.
const withProse = [
  "---",
  'id: "903"',
  "title: С прозой",
  "status: in-review",
  "---",
  "",
  "## Заметки",
  "",
  "- 2026-10-15T14:00:00Z [in-review]",
  "  Комментарий роли с отступом.",
  "",
  "Исходные заметки:",
  "  - старая строка карточки",
  ""
].join("\n");
const proseCard = plugin.__internals.parseCard("903.md", withProse);
assert.equal(proseCard.comments.length, 1, "должен быть один комментарий");
assert.equal(proseCard.comments[0].text, "Комментарий роли с отступом.", "проза без отступа не должна вклеиваться");

assert.ok(
  !sectionCard.comments[0].text.includes("Отчёт исполнителя"),
  "текст раздела не должен вклеиваться в комментарий"
);

assert.equal(normalizeStatus(""), "todo");
assert.equal(normalizeStatus("in_progress"), "in-progress");
assert.equal(normalizeStatus("In Progress"), "in-progress");
assert.equal(normalizeStatus("testing"), "testing");
assert.equal(normalizeStatus("review"), "in-review", "короткое имя ведёт в код-ревью");
assert.equal(normalizeStatus("in-review"), "in-review", "статус код-ревью");
assert.equal(normalizeStatus("In Review"), "in-review", "регистр и пробел нормализуются");
assert.equal(normalizeStatus("на ревью"), "in-review", "русский синоним");
assert.ok(
  COLUMNS.some((column) => column.id === "in-review"),
  "в списке колонок нет in-review"
);
assert.equal(
  COLUMNS.map((column) => column.id).join(","),
  "backlog,todo,in-progress,in-review,testing,ready,merged,blocked",
  "порядок колонок: бэклог первым, дальше очередь, работа, ревью, тесты, слияние, блокировка"
);

// backlog — не синоним todo: своя колонка в начале доски.
assert.equal(normalizeStatus("backlog"), "backlog", "backlog должен остаться своим статусом");
assert.equal(normalizeStatus(" Backlog "), "backlog", "регистр и пробелы нормализуются");
assert.notEqual(normalizeStatus("backlog"), "todo", "backlog больше не алиас todo");
assert.equal(COLUMNS[0].id, "backlog", "первая колонка доски — бэклог");
const card9 = parseCard(
  "009.md",
  "---\nid: 009\ntitle: Из ревью\nstatus: in-review\nrole: reviewer\n"
  + "tokens: 6000\ntokens_reviewer: 6000\nsince: 2026-10-01T10:00:00Z\n---\n"
);
assert.equal(card9.role, "reviewer", "роль читается из front matter");
assert.equal(card9.tokens, "6000", "суммарный расход читается");
assert.equal(card9.usage.reviewer, "6000", "расход по роли собирается из tokens_<роль>");
assert.equal(card9.since, "2026-10-01T10:00:00Z", "метка «с какого времени» читается");
assert.equal(normalizeStatus("ready-to-merge"), "ready");
assert.equal(normalizeStatus("done"), "ready");
assert.equal(normalizeStatus("merged"), "merged");
assert.equal(normalizeStatus("заблокировано"), "blocked");
assert.equal(normalizeStatus("что-то своё"), "todo", "неизвестный статус должен падать в todo");

// --- разбор карточки --------------------------------------------------------
const card = parseCard(
  "007.md",
  [
    "---",
    'id: "007"',
    'title: "QR для нового клиента"',
    "status: testing",
    'owner: "session-abc"',
    'branch: "task/007"',
    'worktree: "/tmp/awg-t007"',
    'note: "тесты 12/12"',
    "---",
    "",
    "## Задача",
    "Сделать QR."
  ].join("\n")
);
assert.equal(card.id, "007");
assert.equal(card.title, "QR для нового клиента");
assert.equal(card.status, "testing");
assert.equal(card.owner, "session-abc");
assert.equal(card.branch, "task/007");
assert.equal(card.note, "тесты 12/12");
assert.equal(card.file, ".kanban/tasks/007.md");

// Карточка из бэклога: статус собственный, владельца нет.
const backlogCard = parseCard(
  "010.md",
  '---\nid: "010"\ntitle: Из бэклога\nstatus: backlog\nowner: ""\n---\n'
);
assert.equal(backlogCard.status, "backlog", "статус backlog читается как backlog");
assert.equal(backlogCard.owner, "", "у карточки в бэклоге владельца нет");

// Карточка без front matter: id из имени файла, статус из тела.
const bare = parseCard("012.md", "# Починить сборку\n\nСтатус: in-progress\n");
assert.equal(bare.id, "012");
assert.equal(bare.title, "Починить сборку");
assert.equal(bare.status, "in-progress");

// --- читатель доски ---------------------------------------------------------
const listing = {
  ok: true,
  value: {
    path: ".kanban/tasks",
    truncated: false,
    entries: [
      { name: "007.md", type: "file", size: 120 },
      { name: "001.md", type: "file", size: 90 },
      { name: "README.md", type: "file", size: 10 },
      { name: "notes.txt", type: "file", size: 10 },
      { name: "sub", type: "directory" }
    ]
  }
};
const readText = {
  "007.md": "---\nid: 007\ntitle: Седьмая\nstatus: in_progress\nowner: s-1\n---\n\n## Задача\nX\n",
  "001.md": "---\nid: 001\ntitle: Первая\nstatus: todo\n---\n\n## Задача\nY\n"
};
const remote = {
  workspaceFiles: {
    list: async () => listing,
    read: async (_sessionId, path) => {
      const name = path.replace(".kanban/tasks/", "");
      if (!(name in readText)) return { ok: false, error: { code: "workspace-file/not-found", message: "нет файла" } };
      return { ok: true, value: { text: readText[name], lines: 5, eof: true, version: "v1" } };
    }
  }
};

const loadBoard = createLoader(remote);
const result = await loadBoard("session-1");
assert.equal(result.ok, true);
assert.equal(result.value.cards.length, 2, "README.md и notes.txt не должны попадать на доску");
assert.deepEqual(
  [...result.value.cards.map((item) => item.id)],
  ["001", "007"],
  "карточки должны идти по имени файла"
);
assert.equal(result.value.cards[1].status, "in-progress");
assert.deepEqual([...result.value.problems], []);

// Ошибка листинга доходит до вызывающего как код ошибки.
const failing = createLoader({
  workspaceFiles: {
    list: async () => ({ ok: false, error: { code: "workspace-file/not-found" } }),
    read: async () => ({ ok: true, value: { text: "" } })
  }
});
const failed = await failing("session-1");
assert.equal(failed.ok, false);
assert.equal(failed.error, "workspace-file/not-found");

// Исключение внутри Remote не роняет читателя.
const throwing = createLoader({
  workspaceFiles: {
    list: async () => {
      throw new Error("сеть отвалилась");
    },
    read: async () => ({ ok: true, value: { text: "" } })
  }
});
const thrown = await throwing("session-1");
assert.equal(thrown.ok, false);
assert.match(thrown.error, /сеть отвалилась/);

// --- слияние с карточками из worktree (манифест) ----------------------------
const { isNewer, readManifest } = plugin.__internals;

const manifest = {
  version: 1,
  updated: "2026-09-23T16:00:00Z",
  cards: [
    "/tmp/awg-t007/.kanban/tasks/007.md",
    "/tmp/awg-t009/.kanban/tasks/009.md",
    "/tmp/awg-t010/.kanban/tasks/010.md",
    "/tmp/awg-t011/.kanban/tasks/011.md"
  ]
};
const files = {
  ".kanban/worktrees.json": JSON.stringify(manifest),
  ".kanban/tasks/007.md": "---\nid: 007\ntitle: Седьмая (старая копия)\nstatus: todo\nupdated: 2026-09-23T15:00:00Z\n---\n",
  ".kanban/tasks/001.md": readText["001.md"],
  // из ветки приходит более свежий статус той же задачи
  "/tmp/awg-t007/.kanban/tasks/007.md": "---\nid: 007\ntitle: Седьмая\nstatus: in-progress\nowner: sess-7\nbranch: task/007\nupdated: 2026-09-23T16:10:00Z\n---\n",
  // новая задача, которой в основном чекауте ещё нет
  "/tmp/awg-t009/.kanban/tasks/009.md": "---\nid: 009\ntitle: Девятая из ветки\nstatus: testing\nupdated: 2026-09-23T16:20:00Z\n---\n"
};
const mergeRemote = {
  workspaceFiles: {
    list: async () => ({
      ok: true,
      value: {
        path: ".kanban/tasks",
        truncated: false,
        entries: [
          { name: "001.md", type: "file", size: 90 },
          { name: "007.md", type: "file", size: 100 }
        ]
      }
    }),
    read: async (_sessionId, path) => {
      if (path in files) return { ok: true, value: { text: files[path], lines: 5, eof: true } };
      if (path === "/tmp/awg-t010/.kanban/tasks/010.md") {
        return { ok: false, error: { code: "workspace-file/not-found" } };
      }
      return { ok: false, error: { code: "workspace-file/too-large", message: "файл слишком большой" } };
    }
  }
};

const merged = await createLoader(mergeRemote)("session-1");
assert.equal(merged.ok, true);
const byId = Object.fromEntries(merged.value.cards.map((item) => [item.id, item]));
assert.deepEqual([...Object.keys(byId)].sort(), ["001", "007", "009"], "должны остаться 001, 007 и 009");
assert.equal(byId["007"].status, "in-progress", "из ветки приходит более свежий статус");
assert.equal(byId["007"].owner, "sess-7");
assert.equal(byId["007"].source, "worktree");
assert.equal(byId["007"].path, "/tmp/awg-t007/.kanban/tasks/007.md");
assert.equal(byId["001"].source, "main");
assert.equal(byId["009"].source, "worktree");
assert.deepEqual(
  [...merged.value.problems],
  ["/tmp/awg-t011/.kanban/tasks/011.md: workspace-file/too-large: файл слишком большой"],
  "исчезнувший worktree (not-found) молчит, настоящая ошибка видна"
);
assert.ok(!("010" in byId), "карточка из исчезнувшего worktree не появляется");
assert.deepEqual(
  [...merged.value.cards.map((item) => item.id)],
  ["001", "007", "009"],
  "порядок по id"
);

// Локальная карточка свежее копии в ветке — выигрывает основная.
const localWins = {
  workspaceFiles: {
    list: async () => ({ ok: true, value: { entries: [{ name: "007.md", type: "file" }], truncated: false } }),
    read: async (_sessionId, path) =>
      path === ".kanban/worktrees.json"
        ? { ok: true, value: { text: JSON.stringify({ cards: ["/tmp/wt/007.md"] }) } }
        : path === "/tmp/wt/007.md"
          ? { ok: true, value: { text: "---\nid: 007\nstatus: ready\nupdated: 2026-09-23T15:00:00Z\n---\n" } }
          : { ok: true, value: { text: "---\nid: 007\nstatus: merged\nupdated: 2026-09-23T17:00:00Z\n---\n" } }
  }
};
const localResult = await createLoader(localWins)("session-1");
assert.equal(localResult.value.cards[0].status, "merged");
assert.equal(localResult.value.cards[0].source, "main");

// Битый манифест — не ошибка: доска просто показывает то, что есть.
const brokenManifest = {
  workspaceFiles: {
    list: async () => ({ ok: true, value: { entries: [{ name: "001.md", type: "file" }], truncated: false } }),
    read: async (_sessionId, path) =>
      path === ".kanban/worktrees.json"
        ? { ok: true, value: { text: "{ это не json" } }
        : { ok: true, value: { text: readText["001.md"] } }
  }
};
const brokenResult = await createLoader(brokenManifest)("session-1");
assert.equal(brokenResult.ok, true);
assert.equal(brokenResult.value.cards.length, 1);
assert.deepEqual([...brokenResult.value.problems], []);

// readManifest: читает список путей, а при отсутствии/ошибке файла отдаёт пустой список.
assert.deepEqual(
  [...(await readManifest(mergeRemote, "session-1", undefined))],
  manifest.cards,
  "readManifest возвращает пути из манифеста"
);
const noManifest = { workspaceFiles: { read: async () => ({ ok: false, error: { code: "workspace-file/not-found" } }) } };
assert.deepEqual(
  [...(await readManifest(noManifest, "session-1", undefined))],
  [],
  "нет манифеста — пустой список, а не ошибка"
);

// isNewer: без updated выигрывает ветка, с updated — более свежая запись.
assert.equal(isNewer({ updated: "", source: "worktree" }, { updated: "", source: "main" }), true);
assert.equal(isNewer({ updated: "2026-01-01T00:00:00Z", source: "main" }, { updated: "2026-01-02T00:00:00Z", source: "worktree" }), false);
assert.equal(isNewer({ updated: "2026-01-02T00:00:00Z", source: "main" }, { updated: "2026-01-02T00:00:00Z", source: "worktree" }), false);

// --- карточки из рабочих деревьев внутри проекта (обход .worktrees) --------
let externalReads = 0;
const scanRemote = {
  workspaceFiles: {
    list: async (_sessionId, path) => {
      if (path === ".kanban/tasks") {
        return { ok: true, value: { entries: [{ name: "001.md", type: "file" }], truncated: false } };
      }
      if (path === ".worktrees") {
        return {
          ok: true,
          value: {
            entries: [
              { name: "002", type: "directory" },
              { name: "003", type: "directory" },
              { name: "README.md", type: "file" }
            ],
            truncated: false
          }
        };
      }
      if (path === ".worktrees/002/.kanban/tasks") {
        return {
          ok: true,
          value: {
            entries: [
              { name: "001.md", type: "file" },
              { name: "002.md", type: "file" },
              { name: "README.md", type: "file" }
            ],
            truncated: false
          }
        };
      }
      // У 003 нет каталога задач — обычная ситуация, доска молчит.
      return { ok: false, error: { code: "workspace-file/not-found" } };
    },
    read: async (_sessionId, path) => {
      if (path === ".kanban/tasks/001.md") return { ok: true, value: { text: readText["001.md"] } };
      if (path === ".worktrees/002/.kanban/tasks/002.md") {
        externalReads += 1;
        return {
          ok: true,
          value: { text: "---\nid: 002\ntitle: Из рабочего дерева\nstatus: testing\nowner: sess-2\nupdated: 2026-09-23T16:30:00Z\n---\n" }
        };
      }
      return { ok: false, error: { code: "workspace-file/not-found" } };
    }
  }
};

const scanned = await createLoader(scanRemote)("session-1");
assert.equal(scanned.ok, true);
const scannedById = Object.fromEntries(scanned.value.cards.map((item) => [item.id, item]));
assert.deepEqual([...Object.keys(scannedById)].sort(), ["001", "002"], "карточка из .worktrees должна находиться без манифеста");
assert.equal(scannedById["002"].status, "testing");
assert.equal(scannedById["002"].source, "worktree");
assert.deepEqual([...scanned.value.problems], [], "отсутствие каталога задач в worktree — не ошибка");
assert.equal(externalReads, 1, "карточка из worktree читается один раз");
assert.equal(
  scanned.value.cards.filter((card) => card.id === "001").length,
  1,
  "наследованная копия карточки 001 из worktree не должна дублироваться"
);
assert.equal(
  scanned.value.cards.find((card) => card.id === "001").source,
  "main",
  "карточка 001 должна остаться записью из основного чекаута"
);

// Тот же путь приходит и из манифеста — читаем один раз, не два.
const bothSources = {
  workspaceFiles: {
    list: scanRemote.workspaceFiles.list,
    read: async (sessionId, path) => {
      if (path === ".kanban/worktrees.json") {
        return { ok: true, value: { text: JSON.stringify({ cards: [".worktrees/002/.kanban/tasks/002.md"] }) } };
      }
      return scanRemote.workspaceFiles.read(sessionId, path);
    }
  }
};
externalReads = 0;
const deduped = await createLoader(bothSources)("session-1");
assert.equal(deduped.ok, true);
assert.equal(externalReads, 1, "дубликат из манифеста не приводит к повторному чтению");
assert.equal(deduped.value.cards.filter((card) => card.id === "002").length, 1);

console.log("parse.test.mjs: все проверки прошли");
