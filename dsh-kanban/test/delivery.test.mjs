/**
 * Тесты доставки наряда: сторож и поддельный сервис сессий.
 *
 * Проверяют то, что не видно в тестах ядра: стартовый обход, отправку через
 * `sessionController.prompt`, файл состояния (один наряд на версию карточки) и
 * поведение при недоставленном наряде.
 *
 * Запуск: node dsh-kanban/test/delivery.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { apply } from "../lib/index.js";

let passed = 0;
let failed = 0;

function report(name, error) {
  if (error) {
    failed += 1;
    console.log(`   ПРОВАЛ: ${name}\n      ${error.message}`);
    return;
  }
  passed += 1;
  console.log(`   ok: ${name}`);
}

async function check(name, fn) {
  try {
    await fn();
    report(name);
  } catch (error) {
    report(name, error);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeout = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return true;
    await sleep(20);
  }
  return predicate();
}

function writeCard(board, id, status, extra = {}) {
  const text = [
    "---",
    `id: "${id}"`,
    `title: Задача ${id}`,
    `status: ${status}`,
    `owner: "${extra.owner ?? ""}"`,
    `updated: "${extra.updated ?? "2026-10-14T15:00:00Z"}"`,
    "---",
    ""
  ].join("\n");
  fs.writeFileSync(path.join(board, ".kanban", "tasks", `${id}.md`), text);
}

function makeBoard(cards) {
  const board = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-delivery-"));
  fs.mkdirSync(path.join(board, ".kanban", "tasks"), { recursive: true });
  for (const [id, status, extra] of cards) writeCard(board, id, status, extra);
  return board;
}

function makeCtx(calls, failure = null, delayMs = 0) {
  const handlers = new Map();
  return {
    logger: () => ({ info: () => {}, warn: () => {} }),
    on: (name, handler) => { handlers.set(name, handler); },
    pick: (name) => handlers.get(name),
    sessionController: {
      prompt: async (request) => {
        if (delayMs) await sleep(delayMs);
        if (failure) throw new Error(failure);
        calls.push(request);
        return { accepted: true };
      }
    },
    // Плагин инжектит реестр пресетов (#062): без него apply не стартует.
    agentPresets: { register: async () => async () => {} }
  };
}

/** Файл состояния сторожа: появляется после стартового обхода доски. */
function stateFile(board) {
  return path.join(board, ".kanban", ".watcher-state.json");
}

function stateKeys(board) {
  const file = path.join(board, ".kanban", ".watcher-state.json");
  if (!fs.existsSync(file)) return [];
  return Object.keys(JSON.parse(fs.readFileSync(file, "utf8")));
}

await check("наряд для subagent-owned сессии не остаётся в pending", async () => {
  const board = makeBoard([["010", "testing", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]]);
  const calls = [];
  const ctx = makeCtx(calls, "is owned by subagent routing");
  apply(ctx, { boards: [board], roles: { verifier: "session-1a7e1a7e-0000-4000-8000-000000000001" }, catchUpMs: 20, debounceMs: 10 });
  await sleep(400);
  const pendingFile = path.join(board, ".kanban", ".watcher-pending.json");
  const pending = fs.existsSync(pendingFile) ? JSON.parse(fs.readFileSync(pendingFile, "utf8")) : {};
  assert.deepEqual(Object.keys(pending), [], "permanent-ошибка осталась в pending: " + JSON.stringify(pending));
  ctx.pick("dispose")();
});

console.log("== доставка наряда (поддельный сервис сессий)");

await check("стартовый обход объявляет карточку, которая уже ждёт роль", async () => {
  const board = makeBoard([
    ["001", "in-progress", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }],
    ["002", "in-review", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]
  ]);
  const calls = [];
  apply(makeCtx(calls), { boards: [board], roles: { reviewer: "session-8cce3644-b81e-4783-8ee2-04d8c0d0569e" }, catchUpMs: 20 });
  assert.ok(await waitFor(() => calls.length > 0), "наряд не отправлен");
  assert.equal(calls.length, 1, "должен быть ровно один наряд");
  assert.equal(calls[0].sessionId, "session-8cce3644-b81e-4783-8ee2-04d8c0d0569e");
  assert.equal(calls[0].mode, "queue");
  assert.equal(calls[0].content[0].type, "text");
  assert.match(calls[0].content[0].text, /#002/);
  assert.ok(calls[0].requestId, "у наряда нет requestId");
});

await check("карточку в работе сторож не объявляет", async () => {
  const board = makeBoard([["003", "in-progress", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]]);
  const calls = [];
  apply(makeCtx(calls), { boards: [board], roles: { reviewer: "session-8cce3644-b81e-4783-8ee2-04d8c0d0569e" }, catchUpMs: 20 });
  await sleep(300);
  assert.equal(calls.length, 0, "в работе будить некого");
});

await check("наряд записан в файл состояния и не повторяется при следующем запуске", async () => {
  const board = makeBoard([["004", "in-review", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]]);
  const calls = [];
  apply(makeCtx(calls), { boards: [board], roles: { reviewer: "session-8cce3644-b81e-4783-8ee2-04d8c0d0569e" }, catchUpMs: 20 });
  assert.ok(await waitFor(() => calls.length > 0), "первый наряд не отправлен");
  assert.ok(
    await waitFor(() => stateKeys(board).some((key) => key.startsWith("004:in-review:"))),
    "в файле состояния нет ключа с версией карточки"
  );
  const again = [];
  apply(makeCtx(again), { boards: [board], roles: { reviewer: "session-8cce3644-b81e-4783-8ee2-04d8c0d0569e" }, catchUpMs: 20 });
  await sleep(300);
  assert.equal(again.length, 0, "повторный запуск объявил ту же версию снова");
});

await check("переход по файлу объявляется один раз", async () => {
  const board = makeBoard([["005", "in-progress", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]]);
  const calls = [];
  // Раньше здесь стоял фиксированный sleep(150) до записи карточки: на загруженной
  // машине `fs.watch` не успевал встать, и переход «терялся» — флейк, а не
  // поведение сторожа. Теперь запись перехода повторяется, пока сторож её не
  // увидит. Версия карточки (`updated`) не меняется, поэтому ключ доставки тот
  // же — повторные записи не должны давать второй наряд, и это проверяется ниже.
  apply(makeCtx(calls), { boards: [board], roles: { reviewer: "session-8cce3644-b81e-4783-8ee2-04d8c0d0569e" }, catchUpMs: 20, debounceMs: 20 });
  const deadline = Date.now() + 5000;
  while (calls.length === 0 && Date.now() < deadline) {
    writeCard(board, "005", "in-review", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030", updated: "2026-10-14T16:00:00Z" });
    await sleep(50);
  }
  assert.ok(calls.length > 0, "переход не объявлен");
  await sleep(200);
  assert.equal(calls.length, 1, "наряд должен уйти ровно один раз");
  assert.equal(calls[0].sessionId, "session-8cce3644-b81e-4783-8ee2-04d8c0d0569e");
});

await check("недоставленный наряд не помечается доставленным", async () => {
  const board = makeBoard([["006", "in-review", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]]);
  apply(makeCtx([], "session/agent-busy"), { boards: [board], roles: { reviewer: "session-8cce3644-b81e-4783-8ee2-04d8c0d0569e" }, catchUpMs: 20 });
  await sleep(400);
  assert.deepEqual(stateKeys(board), [], "недоставленный наряд записали как доставленный");
});

await check("без настроенных ролей сторож молчит", async () => {
  const board = makeBoard([["007", "in-review", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]]);
  const calls = [];
  apply(makeCtx(calls), { boards: [board], catchUpMs: 20 });
  await sleep(300);
  assert.equal(calls.length, 0, "нарядов быть не должно");
});

await check("неизвестная сессия не роняет сторож", async () => {
  const board = makeBoard([["008", "in-review", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]]);
  const calls = [];
  apply(makeCtx(calls, "session/not-found"), { boards: [board], roles: { reviewer: "session-8cce3644-b81e-4783-8ee2-04d8c0d0569e" }, catchUpMs: 20 });
  await sleep(400);
  assert.deepEqual(stateKeys(board), [], "ключ записали, хотя наряд не доставлен");
});

// Роли сторожа можно закрепить и по событию выбора пресета, а не только конфигом.
// Эти проверки идут через стартовый обход: он детерминирован, а fs.watch под
// нагрузкой набора иногда опаздывает.

await check("роль закрепляется событием выбора пресета", async () => {
  const board = makeBoard([["002", "in-review", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]]);
  const calls = [];
  const ctx = makeCtx(calls);
  apply(ctx, { boards: [board], catchUpMs: 30, debounceMs: 20 });
  ctx.pick("agent-preset/selected")("session-4e9a1918-e1d1-4864-8384-9fc487ce267c", "reviewer");
  await waitFor(() => calls.length > 0);
  assert.equal(calls.length, 1, `нарядов ${calls.length}`);
  assert.equal(calls[0].sessionId, "session-4e9a1918-e1d1-4864-8384-9fc487ce267c");
  ctx.pick("dispose")();
});

await check("ручной id в конфиге главнее автокарты", async () => {
  const board = makeBoard([["002", "in-review", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]]);
  const calls = [];
  const ctx = makeCtx(calls);
  apply(ctx, { boards: [board], roles: { reviewer: "session-b14984fe-b1d3-4675-8d74-358b829ac2ab" }, catchUpMs: 30, debounceMs: 20 });
  ctx.pick("agent-preset/selected")("session-40a799f1-d4c6-4a81-85ff-54211d87c3a3", "reviewer");
  await waitFor(() => calls.length > 0);
  assert.equal(calls[0]?.sessionId, "session-b14984fe-b1d3-4675-8d74-358b829ac2ab");
  ctx.pick("dispose")();
});

await check("чужой пресет роль не закрепляет", async () => {
  const board = makeBoard([["002", "in-review", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]]);
  const calls = [];
  const ctx = makeCtx(calls);
  apply(ctx, { boards: [board], catchUpMs: 30, debounceMs: 20 });
  ctx.pick("agent-preset/selected")("session-e062e77c-43ce-445b-8a42-8a0b138d2cf2", "standard");
  await sleep(200);
  assert.equal(calls.length, 0, "наряд ушёл в чужую сессию");
  ctx.pick("dispose")();
});

await check("карта ролей переживает перезапуск профиля", async () => {
  const board = makeBoard([["002", "in-review", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]]);
  const first = makeCtx([]);
  // Стартовый обход первого сторожа отодвинут: он нужен только чтобы запомнить роль.
  apply(first, { boards: [board], catchUpMs: 5000, debounceMs: 20 });
  first.pick("agent-preset/selected")("session-29ef9620-27b4-40eb-893d-9f1d6bf2764b", "reviewer");
  first.pick("dispose")();
  const calls = [];
  const second = makeCtx(calls);
  apply(second, { boards: [board], catchUpMs: 30, debounceMs: 20 });
  await waitFor(() => calls.length > 0);
  assert.equal(calls[0]?.sessionId, "session-29ef9620-27b4-40eb-893d-9f1d6bf2764b");
  second.pick("dispose")();
});

await check("префикс preset- в id пресета распознаётся", async () => {
  const board = makeBoard([["002", "testing", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]]);
  const calls = [];
  const ctx = makeCtx(calls);
  apply(ctx, { boards: [board], catchUpMs: 30, debounceMs: 20 });
  ctx.pick("agent-preset/selected")("session-03d032c7-b73e-4ed5-82de-4cbb49138180", "preset-verifier");
  await waitFor(() => calls.length > 0);
  assert.equal(calls[0]?.sessionId, "session-03d032c7-b73e-4ed5-82de-4cbb49138180");
  ctx.pick("dispose")();
});

await check("карточка, ждущая роль, объявляется при появлении роли", async () => {
  const board = makeBoard([["005", "testing", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]]);
  const calls = [];
  const ctx = makeCtx(calls);
  apply(ctx, { boards: [board], catchUpMs: 30, debounceMs: 20 });
  await sleep(150);
  assert.equal(calls.length, 0, "без роли наряда быть не должно");
  ctx.pick("agent-preset/selected")("session-1a7e1a7e-0000-4000-8000-000000000001", "verifier");
  await waitFor(() => calls.length > 0);
  assert.equal(calls[0]?.sessionId, "session-1a7e1a7e-0000-4000-8000-000000000001");
  // Повторное событие по той же роли не должно слать наряд второй раз.
  ctx.pick("agent-preset/selected")("session-1a7e1a7e-0000-4000-8000-000000000001", "verifier");
  await sleep(150);
  assert.equal(calls.length, 1, `нарядов ${calls.length}`);
  ctx.pick("dispose")();
});

await check("недоставленный наряд повторяется при следующем запуске", async () => {
  const board = makeBoard([["002", "in-review", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]]);
  const failing = makeCtx([], "session/agent-busy");
  apply(failing, { boards: [board], roles: { reviewer: "session-8cce3644-b81e-4783-8ee2-04d8c0d0569e" }, catchUpMs: 30, debounceMs: 20 });
  const pendingFile = path.join(board, ".kanban", ".watcher-pending.json");
  await waitFor(() => fs.existsSync(pendingFile));
  assert.deepEqual(stateKeys(board), [], "недоставленное не помечается доставленным");
  failing.pick("dispose")();

  const calls = [];
  const good = makeCtx(calls);
  apply(good, { boards: [board], roles: { reviewer: "session-8cce3644-b81e-4783-8ee2-04d8c0d0569e" }, catchUpMs: 30, debounceMs: 20 });
  await waitFor(() => calls.length > 0);
  assert.equal(calls[0]?.sessionId, "session-8cce3644-b81e-4783-8ee2-04d8c0d0569e");
  await waitFor(() => stateKeys(board).length > 0);
  good.pick("dispose")();

  // Третий запуск: наряд доставлен и записан — повторять нечего.
  const againCalls = [];
  const again = makeCtx(againCalls);
  apply(again, { boards: [board], roles: { reviewer: "session-8cce3644-b81e-4783-8ee2-04d8c0d0569e" }, catchUpMs: 30, debounceMs: 20 });
  await sleep(250);
  assert.equal(againCalls.length, 0, `наряд ушёл повторно: ${againCalls.length}`);
  again.pick("dispose")();
});

await check("медленная доставка и обход по роли не дублируют наряд", async () => {
  const board = makeBoard([["005", "testing", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]]);
  const calls = [];
  const ctx = makeCtx(calls, null, 200);
  apply(ctx, { boards: [board], catchUpMs: 60, debounceMs: 20 });
  // Событие приходит раньше стартового обхода — как при старте профиля.
  ctx.pick("agent-preset/selected")("session-2b8f2b8f-0000-4000-8000-000000000002", "verifier");
  await sleep(500);
  assert.equal(calls.length, 1, `нарядов ${calls.length}`);
  assert.equal(calls[0]?.sessionId, "session-2b8f2b8f-0000-4000-8000-000000000002");
  ctx.pick("dispose")();
});

await check("стартовый обход и повтор недоставленного не дублируют наряд", async () => {
  const board = makeBoard([["006", "testing", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]]);
  const failing = makeCtx([], "session/agent-busy");
  apply(failing, { boards: [board], roles: { verifier: "session-03d032c7-b73e-4ed5-82de-4cbb49138180" }, catchUpMs: 30, debounceMs: 20 });
  const pendingFile = path.join(board, ".kanban", ".watcher-pending.json");
  await waitFor(() => fs.existsSync(pendingFile));
  failing.pick("dispose")();

  const calls = [];
  const good = makeCtx(calls);
  apply(good, { boards: [board], roles: { verifier: "session-03d032c7-b73e-4ed5-82de-4cbb49138180" }, catchUpMs: 30, debounceMs: 20 });
  await sleep(250);
  assert.equal(calls.length, 1, `нарядов ${calls.length}`);
  good.pick("dispose")();
});

await check("устаревший след не отправляется и снимается", async () => {
  const board = makeBoard([["002", "in-review", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]]);
  // След от прошлого запуска: тогда карточка была в testing, потом уехала дальше.
  fs.writeFileSync(
    path.join(board, ".kanban", ".watcher-pending.json"),
    JSON.stringify({
      "002:testing:2026-10-14T10:00:00Z": {
        cardId: "002",
        status: "testing",
        sessionId: "session-81c95966-ee71-4ac7-8cb2-8952eaf97ae9",
        text: "старый наряд",
        at: "2026-10-14T10:00:00Z"
      }
    }, null, 2)
  );
  const calls = [];
  const ctx = makeCtx(calls);
  apply(ctx, { boards: [board], roles: { verifier: "session-03d032c7-b73e-4ed5-82de-4cbb49138180" }, catchUpMs: 30, debounceMs: 20 });
  await sleep(250);
  assert.equal(calls.length, 0, `нарядов ${calls.length}`);
  const left = JSON.parse(fs.readFileSync(path.join(board, ".kanban", ".watcher-pending.json"), "utf8"));
  assert.deepEqual(Object.keys(left), [], "устаревший след остался в файле");
  ctx.pick("dispose")();
});

await check("heartbeat диагностики не падает без dispose", async () => {
  const board = makeBoard([["011", "backlog", { owner: "" }]]);
  const ctx = makeCtx([]);
  apply(ctx, { boards: [board], catchUpMs: 10, debounceMs: 10, heartbeatMs: 5 });
  // Старый баг (7bdcd86) ронял процесс необработанным ReferenceError: disposed.
  await sleep(40);
  assert.ok(true, "процесс жив");
  ctx.pick("dispose")();
});

await check("prompt, который не отвечает, уходит в pending по таймауту", async () => {
  const board = makeBoard([["020", "in-review", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]]);
  const ctx = makeCtx([]);
  ctx.sessionController.prompt = () => new Promise(() => {});
  apply(ctx, { boards: [board], roles: { reviewer: "session-1a7e1a7e-0000-4000-8000-000000000001" }, catchUpMs: 10, debounceMs: 10, deliverTimeoutMs: 20 });
  const pendingFile = path.join(board, ".kanban", ".watcher-pending.json");
  assert.ok(await waitFor(() => fs.existsSync(pendingFile)), "pending не появился после таймаута");
  const pending = JSON.parse(fs.readFileSync(pendingFile, "utf8"));
  assert.ok(Object.keys(pending).length > 0, "наряд не сохранён в pending");
  ctx.pick("dispose")();
});

await check("зависший cwd сессии не отправляет prompt и пишет pending", async () => {
  const board = makeBoard([["021", "in-review", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]]);
  const calls = [];
  const ctx = makeCtx(calls);
  ctx.get = (name) => (name === "sessionQuery" ? { observeSession: () => new Promise(() => {}) } : undefined);
  apply(ctx, { boards: [board], roles: { reviewer: "session-1a7e1a7e-0000-4000-8000-000000000001" }, catchUpMs: 10, debounceMs: 10, cwdTimeoutMs: 20 });
  const pendingFile = path.join(board, ".kanban", ".watcher-pending.json");
  assert.ok(await waitFor(() => fs.existsSync(pendingFile)), "pending не появился после таймаута cwd");
  assert.equal(calls.length, 0, "prompt вызван без подтверждённого cwd");
  ctx.pick("dispose")();
});

await check("вложенная доска: наряд уходит сессии дочерней доски, а не пропускается", async () => {
  const parent = makeBoard([]);
  const child = path.join(parent, "component");
  fs.mkdirSync(path.join(child, ".kanban", "tasks"), { recursive: true });
  const owner = "session-6af8ff46-f3e7-4640-8a2d-045543fbc030";
  writeCard(child, "031", "todo", { owner });
  const calls = [];
  const ctx = makeCtx(calls);
  ctx.get = (name) => (name === "sessionQuery" ? { observeSession: async () => ({ header: { cwd: child } }) } : undefined);
  apply(ctx, { boards: [], roots: [parent], catchUpMs: 20, debounceMs: 10 });
  assert.ok(await waitFor(() => calls.length > 0), "наряд дочерней доски не доставлен");
  assert.equal(calls[0].sessionId, owner);
  ctx.pick("dispose")();
});

await check("человекочитаемый owner не зовёт prompt и не пишет pending", async () => {
  const board = makeBoard([["032", "todo", { owner: "executor-skills (DSH)" }]]);
  const calls = [];
  const ctx = makeCtx(calls);
  ctx.get = (name) => (name === "sessionQuery" ? { observeSession: async () => ({ header: { cwd: board } }) } : undefined);
  apply(ctx, { boards: [board], catchUpMs: 20, debounceMs: 10 });
  await sleep(300);
  assert.equal(calls.length, 0, "prompt вызван для невалидного owner");
  const pendingFile = path.join(board, ".kanban", ".watcher-pending.json");
  const pending = fs.existsSync(pendingFile) ? JSON.parse(fs.readFileSync(pendingFile, "utf8")) : {};
  assert.deepEqual(Object.keys(pending), [], "невалидный owner осел в pending");
  ctx.pick("dispose")();
});

await check("доска рабочего дерева не считается отдельной доской", async () => {
  const root = makeBoard([]);
  const tree = path.join(root, "worktrees", "001");
  fs.mkdirSync(path.join(tree, ".kanban", "tasks"), { recursive: true });
  writeCard(tree, "033", "todo", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" });
  const calls = [];
  const ctx = makeCtx(calls);
  ctx.get = (name) => (name === "sessionQuery" ? { observeSession: async () => ({ header: { cwd: tree } }) } : undefined);
  apply(ctx, { boards: [], roots: [root], catchUpMs: 20, debounceMs: 10 });
  await sleep(300);
  assert.equal(calls.length, 0, "worktree стал отдельной доской и получил наряд");
  ctx.pick("dispose")();
});

console.log(`\nвсего: ${passed} ok, ${failed} провал(ов)`);
process.exit(failed > 0 ? 1 : 0);
