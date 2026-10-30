/**
 * Тесты host-логики обзора дочерних досок (#059, спека 004).
 *
 * Обзор — это чтение: манифест `.kanban/children.json` в каталоге сессии, по нему
 * снимки досок детей (основная доска + доски рабочих деревьев, слияние по
 * `updated`). Поэтому тесты поднимают временное дерево на диске и проверяют
 * ровно то, что увидит клиент: доски, счётчики, карточки «в работе», проблемы.
 *
 * Отдельно фиксируется главное обещание службы — **только чтение**: содержимое
 * дерева до и после обзора совпадает, а в исходнике `children.js` нет вызовов
 * записи.
 *
 * Запуск: node dsh-kanban/test/children.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { REMOTE_METHODS_KEY } from "../lib/card-actions.js";
import {
  MANIFEST_FILE,
  SERVICE_KEY,
  boardTitle,
  cardExtras,
  createChildrenActions,
  parseManifest,
  readOverview,
  registerChildrenService,
  resolveBoardPath,
  summarizeCards,
  validateRequest,
} from "../lib/children.js";

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

/** Карточка в формате доски; `extra` добавляется в front matter строками. */
function writeCard(dir, id, status, fields = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const lines = [`---`, `id: "${id}"`, `title: Задача ${id}`, `status: ${status}`];
  for (const [key, value] of Object.entries(fields)) lines.push(`${key}: ${value}`);
  lines.push(`updated: ${fields.updated ?? "2026-10-30T10:00:00Z"}`, `---`, "", `Первый абзац карточки ${id}.`, "");
  fs.writeFileSync(path.join(dir, `${id}.md`), lines.join("\n"));
}

function makeBoard(root) {
  fs.mkdirSync(path.join(root, ".kanban", "tasks"), { recursive: true });
  return root;
}

/** Снимок дерева: путь → размер и время. По нему видно, что обзор ничего не писал. */
function treeStamp(root) {
  const stamp = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stamp.set(full, "dir");
        walk(full);
      } else {
        const stats = fs.statSync(full);
        stamp.set(full, `${stats.size}:${stats.mtimeMs}:${fs.readFileSync(full, "utf8")}`);
      }
    }
  };
  walk(root);
  return stamp;
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-children-"));
const treeRoot = path.join(work, "ws");
fs.mkdirSync(treeRoot, { recursive: true });

// ── разбор манифеста ─────────────────────────────────────────────────────────

console.log("== манифест: относительные и абсолютные пути, заголовки");

check("относительный путь резолвится от cwd, абсолютный остаётся как есть", () => {
  assert.equal(resolveBoardPath("/ws", "aif-project/infra"), "/ws/aif-project/infra");
  assert.equal(resolveBoardPath("/ws", "/Users/victor/projects/other"), "/Users/victor/projects/other");
  assert.equal(resolveBoardPath("/ws", ""), "");
});

check("заголовок: title из манифеста, иначе последний сегмент, хвостовой слэш не мешает", () => {
  assert.equal(boardTitle("aif-project/infra", ""), "infra");
  assert.equal(boardTitle("aif-project/infra/", undefined), "infra");
  assert.equal(boardTitle("/Users/victor/projects/other-project", "Другой проект"), "Другой проект");
  assert.equal(boardTitle("/", ""), ".");
});

check("манифест: path обязателен, записи с пустым path попадают в problems, дубли схлопываются", () => {
  const parsed = parseManifest(
    JSON.stringify({
      version: 1,
      boards: [{ path: "a" }, { path: "a" }, { path: "" }, { path: "b", title: "Б" }, "c"],
    }),
  );
  assert.deepEqual(
    parsed.boards.map((board) => [board.path, board.title]),
    [
      ["a", "a"],
      ["b", "Б"],
      ["c", "c"],
    ],
  );
  assert.equal(parsed.problems.length, 1, `problems: ${JSON.stringify(parsed.problems)}`);
  assert.match(parsed.problems[0], /без path/);
});

check("манифест: битый JSON, не объект и отсутствие boards дают понятные problems", () => {
  assert.match(parseManifest("{").problems[0], /не разобран/);
  assert.match(parseManifest("[]").problems[0], /объектом/);
  assert.match(parseManifest('{"version":1}').problems[0], /нет массива boards/);
});

// ── обзор на временном дереве ────────────────────────────────────────────────

console.log("== обзор: снимки досок, слияние с worktree, изоляция ошибок");

const infra = path.join(treeRoot, "aif-project", "infra");
makeBoard(infra);
writeCard(path.join(infra, ".kanban", "tasks"), "001", "backlog");
writeCard(path.join(infra, ".kanban", "tasks"), "002", "todo");
writeCard(path.join(infra, ".kanban", "tasks"), "003", "in-progress", { owner: "sess-worker", role: "worker" });
writeCard(path.join(infra, ".kanban", "tasks"), "004", "in-review", { owner: "sess-worker" });
writeCard(path.join(infra, ".kanban", "tasks"), "005", "ready", { spec: "004" });

// Карточка 003 живёт ещё и в рабочем дереве доски: копия свежее и она побеждает.
writeCard(path.join(infra, "worktrees", "003", ".kanban", "tasks"), "003", "in-progress", {
  owner: "sess-worker",
  role: "worker",
  branch: "task/003",
  updated: "2026-10-30T12:00:00Z",
});
// Файл с чужим id внутри дерева — испорченная копия, к доске не относится.
fs.writeFileSync(
  path.join(infra, "worktrees", "003", ".kanban", "tasks", "999.md"),
  '---\nid: "999"\ntitle: Чужая\nstatus: todo\nupdated: 2026-10-30T13:00:00Z\n---\n',
);
// Равенство updated: выигрывает дерево.
makeBoard(path.join(infra, "worktrees", "006", ".kanban", ".."));
writeCard(path.join(infra, ".kanban", "tasks"), "006", "todo", { updated: "2026-10-30T14:00:00Z" });
writeCard(path.join(infra, "worktrees", "006", ".kanban", "tasks"), "006", "in-progress", {
  owner: "sess-tie",
  updated: "2026-10-30T14:00:00Z",
});

// Вторая доска — вне дерева, абсолютным путём.
const external = makeBoard(path.join(work, "other-project"));
writeCard(path.join(external, ".kanban", "tasks"), "010", "testing", { owner: "sess-q" });

// Третья запись манифеста указывает в никуда — ошибка должна остаться её own.
fs.mkdirSync(path.join(treeRoot, ".kanban"), { recursive: true });

const manifest = {
  version: 1,
  boards: [
    { path: "aif-project/infra", title: "infra" },
    { path: external },
    { path: "aif-project/missing" },
    { path: "aif-project/empty", title: "Пустая" },
    { path: "aif-project/zerno", title: "Пустой каталог" },
  ],
};
// Каталог есть, а `.kanban/tasks` в нём нет — доска «пустая» и это missing.
fs.mkdirSync(path.join(treeRoot, "aif-project", "empty"), { recursive: true });
// А здесь каталог карточек есть, просто без файлов: доска живая, счётчики нулевые.
makeBoard(path.join(treeRoot, "aif-project", "zerno"));
fs.writeFileSync(path.join(treeRoot, MANIFEST_FILE), JSON.stringify(manifest, null, 2));

const before = treeStamp(treeRoot);
const overview = readOverview({ cwd: treeRoot });
const after = treeStamp(treeRoot);

check("манифест прочитан, досок столько же, порядок сохранён", () => {
  assert.equal(overview.manifest, "ok");
  assert.equal(overview.boards.length, 5);
  assert.deepEqual(
    overview.boards.map((board) => board.path),
    ["aif-project/infra", external, "aif-project/missing", "aif-project/empty", "aif-project/zerno"],
  );
});

check("относительный путь резолвлен от cwd, абсолютный — как есть", () => {
  assert.equal(overview.boards[0].absPath, infra);
  assert.equal(overview.boards[1].absPath, external);
  assert.equal(overview.boards[1].title, "other-project");
});

check("счётчики по статусам и карточки «в работе» с владельцем и ролью", () => {
  const infraBoard = overview.boards[0];
  assert.equal(infraBoard.counts["in-progress"], 2, JSON.stringify(infraBoard.counts));
  assert.equal(infraBoard.counts.backlog, 1);
  assert.equal(infraBoard.counts.todo, 1);
  assert.equal(infraBoard.counts["in-review"], 1);
  assert.equal(infraBoard.counts.ready, 1);
  assert.equal(infraBoard.counts.testing, 0);
  assert.deepEqual(
    infraBoard.inProgress.map((card) => card.id),
    ["003", "006"],
  );
  assert.equal(infraBoard.inProgress[0].owner, "sess-worker");
  assert.equal(infraBoard.inProgress[0].role, "worker");
  assert.ok(infraBoard.inProgress[0].updated);
});

check("копия из рабочего дерева побеждает по свежести, при равенстве — тоже", () => {
  const infraBoard = overview.boards[0];
  const three = infraBoard.cards.find((card) => card.id === "003");
  const six = infraBoard.cards.find((card) => card.id === "006");
  assert.equal(three.source, "worktree");
  assert.equal(three.worktree, "worktrees/003");
  assert.equal(three.branch, "task/003");
  assert.equal(six.source, "worktree", "при равном updated побеждает дерево");
  assert.equal(six.owner, "sess-tie");
});

check("файл с чужим id в рабочем дереве не приписан к доске", () => {
  const infraBoard = overview.boards[0];
  assert.equal(infraBoard.cards.some((card) => card.id === "999"), false);
});

check("карточки отсортированы по id, extras (расход, spec, описание) на месте", () => {
  const infraBoard = overview.boards[0];
  assert.deepEqual(
    infraBoard.cards.map((card) => card.id),
    ["001", "002", "003", "004", "005", "006"],
  );
  const five = infraBoard.cards.find((card) => card.id === "005");
  assert.equal(five.spec, "004");
  assert.equal(five.description, "Первый абзац карточки 005.");
});

check("ошибка одной доски изолирована: «не найдена» и «нет каталога карточек»", () => {
  const [infraBoard, externalBoard, missingBoard, emptyBoard, zerno] = overview.boards;
  assert.equal(infraBoard.missing, false);
  assert.deepEqual(infraBoard.problems, []);
  assert.equal(externalBoard.counts.testing, 1);
  assert.equal(externalBoard.missing, false);
  assert.equal(missingBoard.missing, true);
  assert.match(missingBoard.problems[0], /не найдена/);
  assert.equal(emptyBoard.missing, true);
  assert.match(emptyBoard.problems[0], /нет каталога карточек/);
  assert.equal(zerno.missing, false, "каталог карточек есть — доска живая, пусть и без карточек");
  assert.equal(zerno.counts.todo, 0);
  assert.deepEqual(zerno.problems, []);
});

check("обзор ничего не пишет: дерево до и после совпадает", () => {
  assert.deepEqual([...before.keys()].sort(), [...after.keys()].sort());
  for (const [file, value] of before) assert.equal(after.get(file), value, `изменился ${file}`);
});

check("в исходнике службы нет операций записи", () => {
  const source = fs.readFileSync(new URL("../lib/children.js", import.meta.url), "utf8");
  for (const api of ["writeFileSync", "appendFileSync", "mkdirSync", "renameSync", "rmSync", "unlinkSync", "copyFileSync", "createWriteStream"]) {
    assert.equal(source.includes(api), false, `в children.js есть ${api}`);
  }
});

check("нет манифеста — пустой список с подсказкой про bin/board-children.sh", () => {
  const dire = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-children-none-"));
  const result = readOverview({ cwd: dire });
  assert.equal(result.manifest, "missing");
  assert.deepEqual(result.boards, []);
  assert.match(result.problems.join(" "), /bin\/board-children\.sh/);
  fs.rmSync(dire, { recursive: true, force: true });
});

check("битый манифест — пустой список, проблемы и manifest: broken", () => {
  const broken = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-children-broken-"));
  fs.mkdirSync(path.join(broken, ".kanban"), { recursive: true });
  fs.writeFileSync(path.join(broken, MANIFEST_FILE), "{ это не json");
  const result = readOverview({ cwd: broken });
  assert.equal(result.manifest, "broken");
  assert.equal(result.boards.length, 0);
  assert.match(result.problems[0], /не разобран/);
  fs.rmSync(broken, { recursive: true, force: true });
});

check("summarizeCards считает только известные статусы и собирает in-progress", () => {
  const result = summarizeCards([
    { id: "1", status: "in-progress", owner: "s" },
    { id: "2", status: "in-progress" },
    { id: "3", status: "merged" },
  ]);
  assert.equal(result.counts["in-progress"], 2);
  assert.equal(result.counts.merged, undefined, "merged в счётчиках не показываем");
  assert.equal(result.inProgress.length, 2);
});

check("cardExtras: расход по ролям, ветка, заметка и первый абзац тела", () => {
  const extras = cardExtras(
    "---\nid: 001\ntitle: Т\nstatus: in-progress\ntokens: 6000\ntokens_worker: 5000\ntokens_reviewer: 1000\nbranch: task/001\nnote: краткая заметка\n---\n\n## Задача\n\nПервый абзац.\n\nВторой абзац.\n",
  );
  assert.equal(extras.tokens, "6000");
  assert.deepEqual(extras.usage, { worker: "5000", reviewer: "1000" });
  assert.equal(extras.branch, "task/001");
  assert.equal(extras.note, "краткая заметка");
  assert.equal(extras.body, "Первый абзац.");
});

// ── служба: запрос, ответ, регистрация ──────────────────────────────────────

console.log("== служба kanbanChildren: только чтение, контракт ответа");

await checkAsync("read отвечает контрактом { ok, value: { boards, problems, manifest } }", async () => {
  const actions = createChildrenActions({ resolveSessionCwd: async () => treeRoot });
  const result = await actions.read({ sessionId: "session-1" });
  assert.equal(result.ok, true);
  assert.equal(result.value.manifest, "ok");
  assert.equal(result.value.boards.length, 5);
  for (const board of result.value.boards) {
    for (const key of ["path", "title", "cards", "problems", "missing", "counts", "inProgress"]) {
      assert.ok(key in board, `в доске нет поля ${key}`);
    }
  }
});

await checkAsync("запрос строгий: лишние поля и неверный sessionId отвергаются", async () => {
  const actions = createChildrenActions({ resolveSessionCwd: async () => treeRoot });
  const extra = await actions.read({ sessionId: "session-1", path: "/etc" });
  assert.equal(extra.ok, false);
  assert.match(extra.message, /лишние поля/);
  const bad = await actions.read({ sessionId: "../etc" });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /sessionId/);
  const empty = await actions.read({});
  assert.equal(empty.ok, false);
  assert.equal(validateRequest(null).ok, false);
});

await checkAsync("неизвестный каталог сессии — понятный отказ, а не исключение", async () => {
  const actions = createChildrenActions({ resolveSessionCwd: async () => null });
  const result = await actions.read({ sessionId: "session-1" });
  assert.equal(result.ok, false);
  assert.match(result.message, /каталог сессии/);
});

await checkAsync("сбой чтения обзора превращается в ok:false с подсказкой", async () => {
  const actions = createChildrenActions({
    resolveSessionCwd: async () => treeRoot,
    readOverview: () => {
      throw new Error("диск отвалился");
    },
  });
  const result = await actions.read({ sessionId: "session-1" });
  assert.equal(result.ok, false);
  assert.match(result.message, /манифест/);
});

check("регистрация в контексте: provide + typertRemote + маркер Remote-метода", () => {
  const provided = new Map();
  const ctx = {
    provide: (key, value) => {
      provided.set(key, value);
      return () => provided.delete(key);
    },
  };
  const { service, dispose } = registerChildrenService(ctx, { resolveSessionCwd: async () => treeRoot });
  assert.equal(provided.get(SERVICE_KEY), service);
  assert.equal(service.typertRemote.serviceKey, SERVICE_KEY);
  assert.equal(service.typertRemote.namespace, "kanbanChildren");
  const methods = service[REMOTE_METHODS_KEY] ?? Object.getPrototypeOf(service)[REMOTE_METHODS_KEY];
  assert.ok(methods, "на прототипе нет дескриптора Remote-методов");
  assert.deepEqual(
    methods.methods.map((entry) => entry.method),
    ["read"],
  );
  assert.equal(methods.methods[0].invocation.kind, "direct");
  dispose();
  assert.equal(provided.has(SERVICE_KEY), false, "dispose не снял службу");
});

fs.rmSync(work, { recursive: true, force: true });

console.log(`\nвсего: ${passed} ok, ${failed} провал(ов)`);
process.exit(failed > 0 ? 1 : 0);
