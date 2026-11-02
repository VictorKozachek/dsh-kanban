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

function stateKeys(board) {
  const file = path.join(board, ".kanban", ".watcher-state.json");
  if (!fs.existsSync(file)) return [];
  return Object.keys(JSON.parse(fs.readFileSync(file, "utf8")));
}

console.log("== доставка наряда (поддельный сервис сессий)");

await check("стартовый обход объявляет карточку, которая уже ждёт роль", async () => {
  const board = makeBoard([
    ["001", "in-progress", { owner: "sess-worker" }],
    ["002", "in-review", { owner: "sess-worker" }]
  ]);
  const calls = [];
  apply(makeCtx(calls), { boards: [board], roles: { reviewer: "sess-reviewer" }, catchUpMs: 20 });
  assert.ok(await waitFor(() => calls.length > 0), "наряд не отправлен");
  assert.equal(calls.length, 1, "должен быть ровно один наряд");
  assert.equal(calls[0].sessionId, "sess-reviewer");
  assert.equal(calls[0].mode, "queue");
  assert.equal(calls[0].content[0].type, "text");
  assert.match(calls[0].content[0].text, /#002/);
  assert.ok(calls[0].requestId, "у наряда нет requestId");
});

await check("карточку в работе сторож не объявляет", async () => {
  const board = makeBoard([["003", "in-progress", { owner: "sess-worker" }]]);
  const calls = [];
  apply(makeCtx(calls), { boards: [board], roles: { reviewer: "sess-reviewer" }, catchUpMs: 20 });
  await sleep(300);
  assert.equal(calls.length, 0, "в работе будить некого");
});

await check("наряд записан в файл состояния и не повторяется при следующем запуске", async () => {
  const board = makeBoard([["004", "in-review", { owner: "sess-worker" }]]);
  const calls = [];
  apply(makeCtx(calls), { boards: [board], roles: { reviewer: "sess-reviewer" }, catchUpMs: 20 });
  assert.ok(await waitFor(() => calls.length > 0), "первый наряд не отправлен");
  assert.ok(
    await waitFor(() => stateKeys(board).some((key) => key.startsWith("004:in-review:"))),
    "в файле состояния нет ключа с версией карточки"
  );
  const again = [];
  apply(makeCtx(again), { boards: [board], roles: { reviewer: "sess-reviewer" }, catchUpMs: 20 });
  await sleep(300);
  assert.equal(again.length, 0, "повторный запуск объявил ту же версию снова");
});

await check("переход по файлу объявляется один раз", async () => {
  const board = makeBoard([["005", "in-progress", { owner: "sess-worker" }]]);
  const calls = [];
  apply(makeCtx(calls), { boards: [board], roles: { reviewer: "sess-reviewer" }, catchUpMs: 5000, debounceMs: 20 });
  await sleep(150);
  writeCard(board, "005", "in-review", { owner: "sess-worker", updated: "2026-10-14T16:00:00Z" });
  assert.ok(await waitFor(() => calls.length > 0), "переход не объявлен");
  await sleep(200);
  assert.equal(calls.length, 1, "наряд должен уйти ровно один раз");
  assert.equal(calls[0].sessionId, "sess-reviewer");
});

await check("недоставленный наряд не помечается доставленным", async () => {
  const board = makeBoard([["006", "in-review", { owner: "sess-worker" }]]);
  apply(makeCtx([], "session/agent-busy"), { boards: [board], roles: { reviewer: "sess-reviewer" }, catchUpMs: 20 });
  await sleep(400);
  assert.deepEqual(stateKeys(board), [], "недоставленный наряд записали как доставленный");
});

await check("без настроенных ролей сторож молчит", async () => {
  const board = makeBoard([["007", "in-review", { owner: "sess-worker" }]]);
  const calls = [];
  apply(makeCtx(calls), { boards: [board], catchUpMs: 20 });
  await sleep(300);
  assert.equal(calls.length, 0, "нарядов быть не должно");
});

await check("неизвестная сессия не роняет сторож", async () => {
  const board = makeBoard([["008", "in-review", { owner: "sess-worker" }]]);
  const calls = [];
  apply(makeCtx(calls, "session/not-found"), { boards: [board], roles: { reviewer: "sess-reviewer" }, catchUpMs: 20 });
  await sleep(400);
  assert.deepEqual(stateKeys(board), [], "ключ записали, хотя наряд не доставлен");
});

// Роли сторожа можно закрепить и по событию выбора пресета, а не только конфигом.
// Эти проверки идут через стартовый обход: он детерминирован, а fs.watch под
// нагрузкой набора иногда опаздывает.

await check("роль закрепляется событием выбора пресета", async () => {
  const board = makeBoard([["002", "in-review", { owner: "sess-worker" }]]);
  const calls = [];
  const ctx = makeCtx(calls);
  apply(ctx, { boards: [board], catchUpMs: 30, debounceMs: 20 });
  ctx.pick("agent-preset/selected")("sess-reviewer-auto", "reviewer");
  await waitFor(() => calls.length > 0);
  assert.equal(calls.length, 1, `нарядов ${calls.length}`);
  assert.equal(calls[0].sessionId, "sess-reviewer-auto");
  ctx.pick("dispose")();
});

await check("ручной id в конфиге главнее автокарты", async () => {
  const board = makeBoard([["002", "in-review", { owner: "sess-worker" }]]);
  const calls = [];
  const ctx = makeCtx(calls);
  apply(ctx, { boards: [board], roles: { reviewer: "sess-config" }, catchUpMs: 30, debounceMs: 20 });
  ctx.pick("agent-preset/selected")("sess-auto", "reviewer");
  await waitFor(() => calls.length > 0);
  assert.equal(calls[0]?.sessionId, "sess-config");
  ctx.pick("dispose")();
});

await check("чужой пресет роль не закрепляет", async () => {
  const board = makeBoard([["002", "in-review", { owner: "sess-worker" }]]);
  const calls = [];
  const ctx = makeCtx(calls);
  apply(ctx, { boards: [board], catchUpMs: 30, debounceMs: 20 });
  ctx.pick("agent-preset/selected")("sess-somebody", "standard");
  await sleep(200);
  assert.equal(calls.length, 0, "наряд ушёл в чужую сессию");
  ctx.pick("dispose")();
});

await check("карта ролей переживает перезапуск профиля", async () => {
  const board = makeBoard([["002", "in-review", { owner: "sess-worker" }]]);
  const first = makeCtx([]);
  // Стартовый обход первого сторожа отодвинут: он нужен только чтобы запомнить роль.
  apply(first, { boards: [board], catchUpMs: 5000, debounceMs: 20 });
  first.pick("agent-preset/selected")("sess-remembered", "reviewer");
  first.pick("dispose")();
  const calls = [];
  const second = makeCtx(calls);
  apply(second, { boards: [board], catchUpMs: 30, debounceMs: 20 });
  await waitFor(() => calls.length > 0);
  assert.equal(calls[0]?.sessionId, "sess-remembered");
  second.pick("dispose")();
});

await check("префикс preset- в id пресета распознаётся", async () => {
  const board = makeBoard([["002", "testing", { owner: "sess-worker" }]]);
  const calls = [];
  const ctx = makeCtx(calls);
  apply(ctx, { boards: [board], catchUpMs: 30, debounceMs: 20 });
  ctx.pick("agent-preset/selected")("sess-verifier", "preset-verifier");
  await waitFor(() => calls.length > 0);
  assert.equal(calls[0]?.sessionId, "sess-verifier");
  ctx.pick("dispose")();
});

await check("карточка, ждущая роль, объявляется при появлении роли", async () => {
  const board = makeBoard([["005", "testing", { owner: "sess-worker" }]]);
  const calls = [];
  const ctx = makeCtx(calls);
  apply(ctx, { boards: [board], catchUpMs: 30, debounceMs: 20 });
  await sleep(150);
  assert.equal(calls.length, 0, "без роли наряда быть не должно");
  ctx.pick("agent-preset/selected")("S-LATE", "verifier");
  await waitFor(() => calls.length > 0);
  assert.equal(calls[0]?.sessionId, "S-LATE");
  // Повторное событие по той же роли не должно слать наряд второй раз.
  ctx.pick("agent-preset/selected")("S-LATE", "verifier");
  await sleep(150);
  assert.equal(calls.length, 1, `нарядов ${calls.length}`);
  ctx.pick("dispose")();
});

await check("недоставленный наряд повторяется при следующем запуске", async () => {
  const board = makeBoard([["002", "in-review", { owner: "sess-worker" }]]);
  const failing = makeCtx([], "session/agent-busy");
  apply(failing, { boards: [board], roles: { reviewer: "sess-reviewer" }, catchUpMs: 30, debounceMs: 20 });
  const pendingFile = path.join(board, ".kanban", ".watcher-pending.json");
  await waitFor(() => fs.existsSync(pendingFile));
  assert.deepEqual(stateKeys(board), [], "недоставленное не помечается доставленным");
  failing.pick("dispose")();

  const calls = [];
  const good = makeCtx(calls);
  apply(good, { boards: [board], roles: { reviewer: "sess-reviewer" }, catchUpMs: 30, debounceMs: 20 });
  await waitFor(() => calls.length > 0);
  assert.equal(calls[0]?.sessionId, "sess-reviewer");
  await waitFor(() => stateKeys(board).length > 0);
  good.pick("dispose")();

  // Третий запуск: наряд доставлен и записан — повторять нечего.
  const againCalls = [];
  const again = makeCtx(againCalls);
  apply(again, { boards: [board], roles: { reviewer: "sess-reviewer" }, catchUpMs: 30, debounceMs: 20 });
  await sleep(250);
  assert.equal(againCalls.length, 0, `наряд ушёл повторно: ${againCalls.length}`);
  again.pick("dispose")();
});

await check("медленная доставка и обход по роли не дублируют наряд", async () => {
  const board = makeBoard([["005", "testing", { owner: "sess-worker" }]]);
  const calls = [];
  const ctx = makeCtx(calls, null, 200);
  apply(ctx, { boards: [board], catchUpMs: 60, debounceMs: 20 });
  // Событие приходит раньше стартового обхода — как при старте профиля.
  ctx.pick("agent-preset/selected")("S-RACE", "verifier");
  await sleep(500);
  assert.equal(calls.length, 1, `нарядов ${calls.length}`);
  assert.equal(calls[0]?.sessionId, "S-RACE");
  ctx.pick("dispose")();
});

await check("стартовый обход и повтор недоставленного не дублируют наряд", async () => {
  const board = makeBoard([["006", "testing", { owner: "sess-worker" }]]);
  const failing = makeCtx([], "session/agent-busy");
  apply(failing, { boards: [board], roles: { verifier: "sess-verifier" }, catchUpMs: 30, debounceMs: 20 });
  const pendingFile = path.join(board, ".kanban", ".watcher-pending.json");
  await waitFor(() => fs.existsSync(pendingFile));
  failing.pick("dispose")();

  const calls = [];
  const good = makeCtx(calls);
  apply(good, { boards: [board], roles: { verifier: "sess-verifier" }, catchUpMs: 30, debounceMs: 20 });
  await sleep(250);
  assert.equal(calls.length, 1, `нарядов ${calls.length}`);
  good.pick("dispose")();
});

await check("устаревший след не отправляется и снимается", async () => {
  const board = makeBoard([["002", "in-review", { owner: "sess-worker" }]]);
  // След от прошлого запуска: тогда карточка была в testing, потом уехала дальше.
  fs.writeFileSync(
    path.join(board, ".kanban", ".watcher-pending.json"),
    JSON.stringify({
      "002:testing:2026-10-14T10:00:00Z": {
        cardId: "002",
        status: "testing",
        sessionId: "sess-old",
        text: "старый наряд",
        at: "2026-10-14T10:00:00Z"
      }
    }, null, 2)
  );
  const calls = [];
  const ctx = makeCtx(calls);
  apply(ctx, { boards: [board], roles: { verifier: "sess-verifier" }, catchUpMs: 30, debounceMs: 20 });
  await sleep(250);
  assert.equal(calls.length, 0, `нарядов ${calls.length}`);
  const left = JSON.parse(fs.readFileSync(path.join(board, ".kanban", ".watcher-pending.json"), "utf8"));
  assert.deepEqual(Object.keys(left), [], "устаревший след остался в файле");
  ctx.pick("dispose")();
});

console.log(`\nвсего: ${passed} ok, ${failed} провал(ов)`);
process.exit(failed > 0 ? 1 : 0);
