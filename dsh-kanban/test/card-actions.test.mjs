/**
 * Тесты командного канала клиент→хост: `backlog ↔ todo` из GUI (#047).
 *
 * Как `delivery.test.mjs`, поднимаем всё без DSH: контекст поддельный, доска —
 * временный каталог, `bin/task-assign.sh` подменяется записывающей заглушкой.
 * Отдельно проверяется форма Remote-службы, которую ждёт Gateway в SRC-режиме:
 * `typertRemote`-binding и маркеры методов на прототипе.
 *
 * Запуск: node dsh-kanban/test/card-actions.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { snapshotCards } from "../lib/watcher-core.js";
import {
  CARD_ID_PATTERN,
  NAMESPACE,
  REMOTE_METHODS_KEY,
  SERVICE_KEY,
  createCardActions,
  findBoardRoot,
  markRemoteMethod,
  registerCardActionsService,
  runAssignScript,
  sessionCwdFromContext,
  validateRequest,
} from "../lib/card-actions.js";

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

// ── стенд: временная доска и заглушка скрипта ────────────────────────────────

const work = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-card-actions-"));

function cardText(id, status, owner = "") {
  return [
    "---",
    `id: "${id}"`,
    `title: "Задача ${id}"`,
    `status: ${status}`,
    `owner: ${owner ? `"${owner}"` : '""'}`,
    "---",
    "",
    "## Задача",
    "Тестовая карточка.",
    "",
  ].join("\n");
}

function writeCard(root, id, status, owner = "") {
  const dir = path.join(root, ".kanban", "tasks");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.md`), cardText(id, status, owner));
}

function fileSnapshot(root) {
  const dir = path.join(root, ".kanban", "tasks");
  if (!fs.existsSync(dir)) return null;
  const entries = fs
    .readdirSync(dir)
    .filter((name) => /\.md$/i.test(name) && !/^readme\.md$/i.test(name))
    .map((name) => [name, fs.readFileSync(path.join(dir, name), "utf8")]);
  return snapshotCards(entries);
}

/** Доска с одной карточкой `047` и «сессией», которая живёт в её рабочем дереве. */
function makeBoard(name, status = "backlog") {
  const root = path.join(work, name);
  writeCard(root, "047", status);
  fs.mkdirSync(path.join(root, "worktrees", "047"), { recursive: true });
  // Канал нормализует корень проекта через realpath (macOS: /var → /private/var),
  // поэтому и стенд возвращает нормализованный путь.
  return fs.realpathSync.native(root);
}

const calls = [];

/** Заглушка `bin/task-assign.sh`: запоминает вызов и переводит карточку. */
function fakeRunner(root, snapshot) {
  return async (options) => {
    calls.push({ root: options.root, args: [...options.args] });
    const terminal = options.args.includes("--unassign") ? "backlog" : "todo";
    const owner = terminal === "todo" ? "sess-free" : "";
    writeCard(options.root, options.args[0], terminal, owner);
    return { ok: true, code: 0, stdout: "assay done", stderr: "" };
  };
}

function makeActions(root, options = {}) {
  calls.length = 0;
  return createCardActions({
    boards: [root],
    snapshot: fileSnapshot,
    resolveSessionCwd: async () => path.join(root, "worktrees", "047"),
    runScript: options.runScript ?? fakeRunner(root),
    log: () => {},
  });
}

// ── проверки запроса ─────────────────────────────────────────────────────────

console.log("== проверка запроса: только sessionId и cardId");

check("корректный запрос принимается", () => {
  const checked = validateRequest({ sessionId: "session-abc", cardId: "047" });
  assert.equal(checked.ok, true);
  assert.deepEqual(checked.value, { sessionId: "session-abc", cardId: "047" });
});
check("cardId: только номер из трёх и более цифр", () => {
  for (const bad of ["1", "12", "../047", "047.md", "047a", "/etc/passwd", "", 47, null]) {
    assert.equal(validateRequest({ sessionId: "session-abc", cardId: bad }).ok, false, `приняли ${JSON.stringify(bad)}`);
  }
  assert.equal(CARD_ID_PATTERN.test("047"), true);
  assert.equal(CARD_ID_PATTERN.test("1234"), true);
});
check("sessionId: идентификатор, а не произвольная строка", () => {
  for (const bad of ["", " ", "a b", "../x", "x;rm -rf /", "я", null]) {
    assert.equal(validateRequest({ sessionId: bad, cardId: "047" }).ok, false, `приняли ${JSON.stringify(bad)}`);
  }
});
check("лишние поля в запросе отвергаются (никаких команд и путей)", () => {
  const checked = validateRequest({ sessionId: "session-abc", cardId: "047", command: "rm -rf /" });
  assert.equal(checked.ok, false);
  assert.match(checked.message, /лишние поля/);
});
check("не объект — отказ, а не падение", () => {
  for (const bad of [null, undefined, "047", ["047"], 42]) {
    assert.equal(validateRequest(bad).ok, false, `приняли ${JSON.stringify(bad)}`);
  }
});

// ── корень доски по каталогу сессии ──────────────────────────────────────────

console.log("== корень проекта по каталогу сессии");

check("каталог сессии в корне проекта", () => {
  const root = path.join(work, "board-a");
  assert.equal(findBoardRoot([root], root), root);
});
check("каталог сессии в рабочем дереве внутри проекта", () => {
  const root = path.join(work, "board-a");
  assert.equal(findBoardRoot([root], path.join(root, "worktrees", "047")), root);
  assert.equal(findBoardRoot([root], path.join(root, "worktrees", "047", ".kanban")), root);
});
check("чужая доска и мусорный каталог — null", () => {
  assert.equal(findBoardRoot(["/tmp/nowhere"], "/tmp/nowhere-else/project"), null);
  assert.equal(findBoardRoot([path.join(work, "board-a")], work), null);
  assert.equal(findBoardRoot([], work), null);
  assert.equal(findBoardRoot([path.join(work, "board-a")], ""), null);
});

// ── асайн ────────────────────────────────────────────────────────────────────

console.log("== асайн: backlog → todo");

await checkAsync("асайн вызывает bin/task-assign.sh с номером карточки и отдаёт новый статус", async () => {
  const root = makeBoard("assign-ok");
  const actions = makeActions(root);
  const result = await actions.assign({ sessionId: "session-abc", cardId: "047" });
  assert.deepEqual(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, "todo");
  assert.equal(result.owner, "sess-free");
  assert.match(result.message, /#047/);
  assert.deepEqual(calls, [{ root, args: ["047"] }], "скрипт должен получить только номер карточки");
});
await checkAsync("карточка не в backlog — отказ, скрипт не запускается", async () => {
  const root = makeBoard("assign-wrong", "todo");
  const actions = makeActions(root);
  const result = await actions.assign({ sessionId: "session-abc", cardId: "047" });
  assert.equal(result.ok, false);
  assert.equal(result.status, "todo");
  assert.match(result.message, /только из backlog/);
  assert.deepEqual(calls, []);
});
await checkAsync("карточки нет на доске — отказ", async () => {
  const root = makeBoard("assign-missing", "backlog");
  const actions = makeActions(root);
  const result = await actions.assign({ sessionId: "session-abc", cardId: "999" });
  assert.equal(result.ok, false);
  assert.match(result.message, /не найдена/);
  assert.deepEqual(calls, []);
});
await checkAsync("неизвестная сессия — отказ", async () => {
  const root = makeBoard("assign-session");
  const actions = createCardActions({
    boards: [root],
    snapshot: fileSnapshot,
    resolveSessionCwd: async () => null,
    runScript: fakeRunner(root),
    log: () => {},
  });
  const result = await actions.assign({ sessionId: "session-abc", cardId: "047" });
  assert.equal(result.ok, false);
  assert.match(result.message, /сессия не найдена/);
  assert.deepEqual(calls, []);
});
await checkAsync("сессия вне досок конфига — отказ", async () => {
  const root = makeBoard("assign-other-board");
  const actions = createCardActions({
    boards: [path.join(work, "another-board")],
    snapshot: fileSnapshot,
    resolveSessionCwd: async () => path.join(root, "worktrees", "047"),
    runScript: fakeRunner(root),
    log: () => {},
  });
  const result = await actions.assign({ sessionId: "session-abc", cardId: "047" });
  assert.equal(result.ok, false);
  assert.match(result.message, /не привязана/);
  assert.deepEqual(calls, []);
});
await checkAsync("все заняты (код 4) — отказ с текстом скрипта, карточка остаётся в backlog", async () => {
  const root = makeBoard("assign-busy");
  const actions = makeActions(root, {
    runScript: async () => {
      calls.push({ root, args: ["047"] });
      return { ok: false, code: 4, stdout: "все заняты\n", stderr: "" };
    },
  });
  const result = await actions.assign({ sessionId: "session-abc", cardId: "047" });
  assert.equal(result.ok, false);
  assert.equal(result.status, "backlog");
  assert.match(result.message, /все исполнители заняты/);
  assert.equal(fileSnapshot(root).get("047").status, "backlog");
});
await checkAsync("скрипта асайна ещё нет — понятный отказ", async () => {
  const root = makeBoard("assign-missing-script");
  const actions = makeActions(root, {
    runScript: async () => ({ ok: false, code: "missing", stdout: "", stderr: "" }),
  });
  const result = await actions.assign({ sessionId: "session-abc", cardId: "047" });
  assert.equal(result.ok, false);
  assert.match(result.message, /bin\/task-assign\.sh/);
});
await checkAsync("падение самого канала не роняет ответ", async () => {
  const root = makeBoard("assign-throw");
  const actions = makeActions(root, {
    runScript: async () => {
      throw new Error("ENOENT: bin/task-assign.sh");
    },
  });
  const result = await actions.assign({ sessionId: "session-abc", cardId: "047" });
  assert.equal(result.ok, false);
  assert.match(result.message, /канал асайна упал/);
});

// ── возврат в очередь ────────────────────────────────────────────────────────

console.log("== возврат: todo → backlog");

await checkAsync("возврат из todo снимает владельца и запускает скрипт с --unassign", async () => {
  const root = makeBoard("unassign-ok", "todo");
  writeCard(root, "047", "todo", "sess-worker");
  const actions = makeActions(root);
  const result = await actions.unassign({ sessionId: "session-abc", cardId: "047" });
  assert.equal(result.ok, true);
  assert.equal(result.status, "backlog");
  assert.deepEqual(calls, [{ root, args: ["047", "--unassign"] }]);
  assert.equal(fileSnapshot(root).get("047").owner, "");
});
await checkAsync("из in-progress вернуть нельзя — карточку двигают агенты", async () => {
  const root = makeBoard("unassign-progress", "in-progress");
  const actions = makeActions(root);
  const result = await actions.unassign({ sessionId: "session-abc", cardId: "047" });
  assert.equal(result.ok, false);
  assert.equal(result.status, "in-progress");
  assert.match(result.message, /только из todo/);
  assert.deepEqual(calls, []);
});
await checkAsync("из backlog возврат отклоняется (карточка уже в очереди)", async () => {
  const root = makeBoard("unassign-backlog", "backlog");
  const actions = makeActions(root);
  const result = await actions.unassign({ sessionId: "session-abc", cardId: "047" });
  assert.equal(result.ok, false);
  assert.match(result.message, /только из todo/);
  assert.deepEqual(calls, []);
});

// ── порядок вызовов ──────────────────────────────────────────────────────────

console.log("== два асайна одновременно не должны обгонять друг друга");

await checkAsync("запросы канала выполняются последовательно", async () => {
  const root = makeBoard("queue-a", "backlog");
  writeCard(root, "048", "backlog");
  const log = [];
  const actions = createCardActions({
    boards: [root],
    snapshot: fileSnapshot,
    resolveSessionCwd: async () => root,
    log: () => {},
    runScript: async (options) => {
      log.push(`start ${options.args[0]}`);
      await new Promise((done) => setTimeout(done, 10));
      log.push(`end ${options.args[0]}`);
      writeCard(root, options.args[0], "todo", "sess-free");
      return { ok: true, code: 0, stdout: "", stderr: "" };
    },
  });
  const [first, second] = await Promise.all([
    actions.assign({ sessionId: "session-abc", cardId: "047" }),
    actions.assign({ sessionId: "session-abc", cardId: "048" }),
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(log, ["start 047", "end 047", "start 048", "end 048"], log.join(" | "));
});

// ── форма Remote-службы ──────────────────────────────────────────────────────

console.log("== форма службы для Gateway (SRC-режим)");

check("binding и маркеры методов — как ждёт Gateway", () => {
  const root = makeBoard("service-shape");
  const provided = new Map();
  const ctx = {
    provide: (name, value) => {
      provided.set(name, value);
      return async () => provided.delete(name);
    },
    get: (name) => provided.get(name),
  };
  registerCardActionsService(ctx, {
    boards: [root],
    snapshot: fileSnapshot,
    resolveSessionCwd: async () => root,
    runScript: fakeRunner(root),
    log: () => {},
  });
  const service = ctx.get(SERVICE_KEY);
  assert.ok(service, `служба ${SERVICE_KEY} не зарегистрирована`);
  const binding = service.typertRemote;
  assert.equal(binding.service, service, "binding.service должен указывать на саму службу");
  assert.equal(binding.serviceKey, SERVICE_KEY);
  assert.equal(binding.namespace, NAMESPACE);
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(service), REMOTE_METHODS_KEY);
  assert.ok(descriptor, "на прототипе нет дескриптора Remote-методов");
  assert.equal(descriptor.value.version, 1);
  assert.deepEqual(
    descriptor.value.methods.map((method) => [method.method, method.invocation.kind]),
    [
      ["assign", "direct"],
      ["unassign", "direct"],
    ],
    "маркеры должны объявлять assign/unassign как direct-методы"
  );
});

check("методы службы возвращают результат, а не бросают", async () => {
  const root = makeBoard("service-call", "backlog");
  const provided = new Map();
  const ctx = {
    provide: (name, value) => {
      provided.set(name, value);
      return async () => provided.delete(name);
    },
    get: (name) => provided.get(name),
  };
  registerCardActionsService(ctx, {
    boards: [root],
    snapshot: fileSnapshot,
    resolveSessionCwd: async () => root,
    runScript: fakeRunner(root),
    log: () => {},
  });
  const service = ctx.get(SERVICE_KEY);
  const result = await service.assign({ sessionId: "session-abc", cardId: "047" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, "todo");
  // SRC-режим разбирает имена параметров из исходника метода: деструктуризация,
  // значения по умолчанию и rest запрещены.
  const source = Function.prototype.toString.call(service.assign);
  assert.match(source, /^async assign\(request\)/);
  const unassignSource = Function.prototype.toString.call(service.unassign);
  assert.match(unassignSource, /^async unassign\(request\)/);
});

check("markRemoteMethod идемпотентен", () => {
  class Sample {
    async assign(request) {
      return request;
    }
  }
  markRemoteMethod(Sample.prototype, "assign");
  markRemoteMethod(Sample.prototype, "assign");
  const descriptor = Object.getOwnPropertyDescriptor(Sample.prototype, REMOTE_METHODS_KEY).value;
  assert.equal(descriptor.methods.length, 1);
});

// ── настоящий запуск скрипта ─────────────────────────────────────────────────

console.log("== запуск bin/task-assign.sh: аргументы массивом, без шелла");

await checkAsync("скрипт запускается из корня доски и получает аргументы массивом", async () => {
  const root = path.join(work, "script-root");
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  const script = path.join(root, "bin", "task-assign.sh");
  fs.writeFileSync(script, '#!/usr/bin/env bash\nprintf "cwd=%s args=%s\\n" "$PWD" "$*"\n');
  fs.chmodSync(script, 0o755);
  const outcome = await runAssignScript({ root, args: ["047", "--unassign"] });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.code, 0);
  const realRoot = fs.realpathSync.native(root);
  assert.match(outcome.stdout, new RegExp(`cwd=${realRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(outcome.stdout, /args=047 --unassign/);
});
await checkAsync("нет скрипта — код missing, без исключения", async () => {
  const outcome = await runAssignScript({ root: path.join(work, "no-script"), args: ["047"] });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "missing");
});
await checkAsync("нечисловой код возврата скрипта не теряется", async () => {
  const root = path.join(work, "script-exit");
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  const script = path.join(root, "bin", "task-assign.sh");
  fs.writeFileSync(script, "#!/usr/bin/env bash\nexit 4\n");
  fs.chmodSync(script, 0o755);
  const outcome = await runAssignScript({ root, args: ["047"] });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 4);
});

// ── сессия → каталог ─────────────────────────────────────────────────────────

console.log("== каталог сессии через host-службу sessionQuery");

await checkAsync("lease освобождается, cwd читается", async () => {
  let disposed = 0;
  const ctx = {
    get: (name) =>
      name === "sessionQuery"
        ? {
            observeSession: async () => ({
              header: { id: "session-abc", cwd: "/tmp/project" },
              [Symbol.dispose]: () => {
                disposed += 1;
              },
            }),
          }
        : undefined,
  };
  assert.equal(await sessionCwdFromContext(ctx, "session-abc"), "/tmp/project");
  assert.equal(disposed, 1, "lease не освобождён");
});
await checkAsync("без службы sessionQuery — null", async () => {
  assert.equal(await sessionCwdFromContext({ get: () => undefined }, "session-abc"), null);
});
await checkAsync("неизвестная сессия — исключение, его переводит в отказ вызывающий", async () => {
  const ctx = {
    get: () => ({
      observeSession: async () => {
        throw new Error("session not found");
      },
    }),
  };
  await assert.rejects(() => sessionCwdFromContext(ctx, "session-abc"), /session not found/);
});

fs.rmSync(work, { recursive: true, force: true });

console.log(`\nвсего: ${passed} ok, ${failed} провал(ов)`);
process.exit(failed > 0 ? 1 : 0);
