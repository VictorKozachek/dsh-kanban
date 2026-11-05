/**
 * Тесты новых нарядов сторожа: асайн из `backlog` и сигнал о недоборе `todo`.
 *
 * Стенд тот же, что в `delivery.test.mjs`: временная доска и поддельный
 * `sessionController`. Проверяется то, что не видно в чистых планировщиках:
 * живая доставка наряда в сессию, дедупликация по `.kanban/.watcher-state.json`
 * и сигнал о недоборе «по состоянию» (один наряд на недобор, а не на тик).
 *
 * Запуск: node dsh-kanban/test/assignment.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { apply } from "../lib/index.js";
import { parseMinTodo } from "../lib/backlog-notices.js";

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

/** Записать карточку; `updated` по умолчанию один и тот же — версия карточки. */
function writeCard(board, id, status, extra = {}) {
  const text = [
    "---",
    `id: "${id}"`,
    `title: Задача ${id}`,
    `status: ${status}`,
    `owner: "${extra.owner ?? ""}"`,
    `updated: "${extra.updated ?? "2026-10-21T10:00:00Z"}"`,
    "---",
    ""
  ].join("\n");
  fs.writeFileSync(path.join(board, ".kanban", "tasks", `${id}.md`), text);
}

/** Записать `.kanban/board.json`; `null` — не создавать файл. */
function writeBoardJson(board, value) {
  const file = path.join(board, ".kanban", "board.json");
  if (value === null) return;
  const text = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(file, text);
}

function makeBoard(cards, boardJson = null) {
  const board = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-assignment-"));
  fs.mkdirSync(path.join(board, ".kanban", "tasks"), { recursive: true });
  for (const [id, status, extra] of cards) writeCard(board, id, status, extra);
  writeBoardJson(board, boardJson);
  return board;
}

function makeCtx(calls) {
  const handlers = new Map();
  return {
    logger: () => ({ info: () => {}, warn: () => {} }),
    on: (name, handler) => { handlers.set(name, handler); },
    pick: (name) => handlers.get(name),
    sessionController: {
      prompt: async (request) => {
        calls.push(request);
        return { accepted: true };
      }
    }
  };
}

function stateKeys(board) {
  const file = path.join(board, ".kanban", ".watcher-state.json");
  if (!fs.existsSync(file)) return [];
  return Object.keys(JSON.parse(fs.readFileSync(file, "utf8")));
}

console.log("== наряды backlog: асайн и пополнение todo (поддельный сервис сессий)");

await check("карточка приходит в todo с владельцем — один наряд владельцу", async () => {
  // Карточка выходит из backlog: асайн — это появление в todo с владельцем.
  const board = makeBoard([["101", "backlog"]]);
  const calls = [];
  const ctx = makeCtx(calls);
  apply(ctx, { boards: [board], catchUpMs: 5000, debounceMs: 20 });
  // Фиксированная пауза не гарантирует, что fs.watch уже встал (под нагрузкой он
  // поднимается позже) — пишем ту же версию карточки, пока асайн не заметят:
  // `updated` не меняется, поэтому ключ доставки тот же и «ровно один наряд» цел.
  const deadline = Date.now() + 5000;
  while (calls.length === 0 && Date.now() < deadline) {
    writeCard(board, "101", "todo", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030", updated: "2026-10-21T11:00:00Z" });
    await sleep(50);
  }
  assert.ok(calls.length > 0, "наряд об асайне не отправлен");
  await sleep(150);
  assert.equal(calls.length, 1, `нарядов ${calls.length}`);
  assert.equal(calls[0].sessionId, "session-6af8ff46-f3e7-4640-8a2d-045543fbc030");
  assert.equal(calls[0].mode, "queue");
  assert.equal(calls[0].content[0].type, "text");
  const text = calls[0].content[0].text;
  assert.match(text, /#101/, "в наряде нет id карточки");
  assert.ok(text.includes(".kanban/tasks/101.md"), `в наряде нет пути к карточке: ${text}`);
  assert.ok(
    text.includes('bin/task-move.sh 101 in-progress --owner "$DSH_SESSION_ID" --role worker'),
    `в наряде нет команды взятия в работу: ${text}`,
  );
  assert.ok(calls[0].requestId, "у наряда нет requestId");
  ctx.pick("dispose")();
});

await check("карточка уже закреплена на старте — наряд уходит", async () => {
  const board = makeBoard([["102", "todo", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]]);
  const calls = [];
  const ctx = makeCtx(calls);
  apply(ctx, { boards: [board], catchUpMs: 20, debounceMs: 20 });
  assert.ok(await waitFor(() => calls.length > 0), "стартовый асайн не объявлен");
  assert.equal(calls.length, 1, `нарядов ${calls.length}`);
  assert.equal(calls[0].sessionId, "session-6af8ff46-f3e7-4640-8a2d-045543fbc030");
  ctx.pick("dispose")();
});

await check("асайн не повторяется при перезапуске сторожа", async () => {
  const board = makeBoard([["103", "todo", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]]);
  const calls = [];
  const first = makeCtx(calls);
  apply(first, { boards: [board], catchUpMs: 20, debounceMs: 20 });
  assert.ok(await waitFor(() => calls.length > 0), "первый наряд не отправлен");
  assert.ok(
    await waitFor(() => stateKeys(board).some((key) => key.startsWith("103:todo:"))),
    "в файле состояния нет ключа асайна",
  );
  first.pick("dispose")();

  const again = [];
  const second = makeCtx(again);
  apply(second, { boards: [board], catchUpMs: 20, debounceMs: 20 });
  await sleep(300);
  assert.equal(again.length, 0, "повторный запуск объявил асайн снова");
  second.pick("dispose")();
});

await check("смена владельца в todo даёт новый наряд", async () => {
  const board = makeBoard([["104", "todo", { owner: "session-bdd64920-57f1-42d3-8f70-1729d3d70ba0" }]]);
  const calls = [];
  const ctx = makeCtx(calls);
  apply(ctx, { boards: [board], catchUpMs: 20, debounceMs: 20 });
  assert.ok(await waitFor(() => calls.length === 1), "первый асайн не объявлен");
  assert.equal(calls[0].sessionId, "session-bdd64920-57f1-42d3-8f70-1729d3d70ba0");
  assert.ok(
    await waitFor(() => stateKeys(board).some((key) => key.startsWith("104:todo:"))),
    "первый асайн не записан в файл состояния",
  );

  // Переназначение: тот же статус, другой владелец — будить нужно нового.
  writeCard(board, "104", "todo", { owner: "session-be222977-cc93-4ab5-8678-16d8c2aee82a", updated: "2026-10-21T12:00:00Z" });
  assert.ok(await waitFor(() => calls.length === 2), "нового владельца не разбудили");
  await sleep(200);
  assert.equal(calls.length, 2, `нарядов ${calls.length}`);
  assert.equal(calls[1].sessionId, "session-be222977-cc93-4ab5-8678-16d8c2aee82a");
  ctx.pick("dispose")();
});

await check("обновление карточки в todo без смены владельца не будит", async () => {
  const board = makeBoard([["105", "todo", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]]);
  const calls = [];
  const ctx = makeCtx(calls);
  apply(ctx, { boards: [board], catchUpMs: 20, debounceMs: 20 });
  assert.ok(await waitFor(() => calls.length === 1), "первый асайн не объявлен");
  assert.ok(await waitFor(() => stateKeys(board).length > 0), "асайн не записан");

  // Та же карточка, тот же владелец, новая версия — асайна быть не должно.
  writeCard(board, "105", "todo", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030", updated: "2026-10-21T13:00:00Z" });
  await sleep(300);
  assert.equal(calls.length, 1, `нарядов ${calls.length}`);
  ctx.pick("dispose")();
});

await check("todo без владельца, backlog и карточка в работе асайна не дают", async () => {
  const board = makeBoard([
    ["106", "todo"],
    ["107", "backlog"],
    ["108", "in-progress", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }],
  ]);
  const calls = [];
  const ctx = makeCtx(calls);
  apply(ctx, { boards: [board], catchUpMs: 20, debounceMs: 20 });
  await sleep(300);
  assert.equal(calls.length, 0, `нарядов ${calls.length}: ${JSON.stringify(calls.map((c) => c.content[0].text))}`);
  ctx.pick("dispose")();
});

await check("переход из todo в работу асайна не даёт", async () => {
  const board = makeBoard([["109", "todo", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]]);
  const calls = [];
  const ctx = makeCtx(calls);
  apply(ctx, { boards: [board], catchUpMs: 20, debounceMs: 20 });
  assert.ok(await waitFor(() => calls.length === 1), "асайн не объявлен");
  assert.ok(await waitFor(() => stateKeys(board).length > 0), "асайн не записан");

  // Исполнитель взял задачу — асайн уже не нужен.
  writeCard(board, "109", "in-progress", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030", updated: "2026-10-21T14:00:00Z" });
  await sleep(300);
  assert.equal(calls.length, 1, `нарядов ${calls.length}`);
  ctx.pick("dispose")();
});

await check("недобор todo будит диспетчера один раз", async () => {
  const board = makeBoard([], { minTodo: 2 });
  const calls = [];
  const ctx = makeCtx(calls);
  apply(ctx, { boards: [board], roles: { dispatcher: "session-dca2c9fe-f0d4-43f2-855e-d62a284adf85" }, catchUpMs: 20, debounceMs: 20 });
  assert.ok(await waitFor(() => calls.length > 0), "наряд о недоборе не отправлен");
  assert.equal(calls.length, 1, `нарядов ${calls.length}`);
  assert.equal(calls[0].sessionId, "session-dca2c9fe-f0d4-43f2-855e-d62a284adf85");
  const text = calls[0].content[0].text;
  assert.ok(text.includes("в todo 0 < 2"), `в наряде нет чисел недобора: ${text}`);
  assert.ok(text.includes("bin/backlog-fill.sh"), `в наряде нет команды пополнения: ${text}`);
  assert.ok(text.includes("backlog пуст: нужна нарезка спеки"), `в наряде нет намёка на нарезку: ${text}`);
  ctx.pick("dispose")();
});

await check("недобор не повторяется при перезапуске сторожа", async () => {
  const board = makeBoard([], { minTodo: 2 });
  const calls = [];
  const first = makeCtx(calls);
  apply(first, { boards: [board], roles: { dispatcher: "session-dca2c9fe-f0d4-43f2-855e-d62a284adf85" }, catchUpMs: 20, debounceMs: 20 });
  assert.ok(await waitFor(() => calls.length > 0), "первый наряд о недоборе не отправлен");
  assert.ok(
    await waitFor(() => stateKeys(board).some((key) => key.startsWith("board:refill:"))),
    "сигнал о недоборе не записан в файл состояния",
  );
  first.pick("dispose")();

  const again = [];
  const second = makeCtx(again);
  apply(second, { boards: [board], roles: { dispatcher: "session-dca2c9fe-f0d4-43f2-855e-d62a284adf85" }, catchUpMs: 20, debounceMs: 20 });
  await sleep(300);
  assert.equal(again.length, 0, "повторный запуск объявил недобор снова");
  second.pick("dispose")();
});

await check("после пополнения и нового недобора — новый наряд", async () => {
  const board = makeBoard([], { minTodo: 1 });
  const calls = [];
  const ctx = makeCtx(calls);
  apply(ctx, { boards: [board], roles: { dispatcher: "session-dca2c9fe-f0d4-43f2-855e-d62a284adf85" }, catchUpMs: 20, debounceMs: 20 });
  assert.ok(await waitFor(() => calls.length === 1), "первый недобор не объявлен");
  assert.ok(await waitFor(() => stateKeys(board).some((key) => key.startsWith("board:refill:"))), "недобор не записан");

  // Пополнение: карточка появилась в todo без владельца — асайна нет, недобор снят.
  // Ждём не «прошло 300 мс», а факт: сторож убирает ключ недобора из файла
  // состояния. Под нагрузкой событие fs.watch может потеряться — тогда ту же
  // версию карточки пишем повторно, пока сторож её не увидит.
  const refillKey = () => stateKeys(board).some((key) => key.startsWith("board:refill:"));
  const settle = Date.now() + 5000;
  while (refillKey() && Date.now() < settle) {
    writeCard(board, "110", "todo");
    await sleep(50);
  }
  assert.equal(refillKey(), false, "сторож не увидел пополнение todo — недобор не снят");
  assert.equal(calls.length, 1, "пополнение не должно давать наряд");

  // Исполнитель взял карточку — todo снова пуст, это новый недобор.
  const deadline = Date.now() + 5000;
  while (calls.length < 2 && Date.now() < deadline) {
    writeCard(board, "110", "in-progress", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030", updated: "2026-10-21T15:00:00Z" });
    await sleep(50);
  }
  assert.equal(calls.length, 2, "новый недобор не объявлен");
  await sleep(200);
  assert.equal(calls.length, 2, `нарядов ${calls.length}`);
  assert.equal(calls[1].sessionId, "session-dca2c9fe-f0d4-43f2-855e-d62a284adf85");
  ctx.pick("dispose")();
});

await check("нет board.json — минимум 1", async () => {
  const empty = makeBoard([]);
  const calls = [];
  const ctx = makeCtx(calls);
  apply(ctx, { boards: [empty], roles: { dispatcher: "session-dca2c9fe-f0d4-43f2-855e-d62a284adf85" }, catchUpMs: 20, debounceMs: 20 });
  assert.ok(await waitFor(() => calls.length > 0), "без board.json недобор не объявлен");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].content[0].text.includes("в todo 0 < 1"), calls[0].content[0].text);
  ctx.pick("dispose")();

  // Одна карточка в todo при минимуме 1 — недобора уже нет.
  const filled = makeBoard([["111", "todo"]]);
  const quiet = [];
  const second = makeCtx(quiet);
  apply(second, { boards: [filled], roles: { dispatcher: "session-dca2c9fe-f0d4-43f2-855e-d62a284adf85" }, catchUpMs: 20, debounceMs: 20 });
  await sleep(300);
  assert.equal(quiet.length, 0, `нарядов ${quiet.length}, а минимум уже набран`);
  second.pick("dispose")();
});

await check("битый board.json — минимум 1, сторож работает", async () => {
  const board = makeBoard([], "{ это не json");
  const calls = [];
  const ctx = makeCtx(calls);
  apply(ctx, { boards: [board], roles: { dispatcher: "session-dca2c9fe-f0d4-43f2-855e-d62a284adf85" }, catchUpMs: 20, debounceMs: 20 });
  assert.ok(await waitFor(() => calls.length > 0), "с битым board.json наряд пропал");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].content[0].text.includes("в todo 0 < 1"), calls[0].content[0].text);
  ctx.pick("dispose")();
});

await check("роль dispatcher не задана — наряд пропускается без падения", async () => {
  const board = makeBoard([], { minTodo: 1 });
  const calls = [];
  const ctx = makeCtx(calls);
  apply(ctx, { boards: [board], catchUpMs: 20, debounceMs: 20 });
  await sleep(300);
  assert.equal(calls.length, 0, `наряд ушёл без роли: ${calls.length}`);
  assert.deepEqual(stateKeys(board), [], "недобор записали, хотя наряд не отправлен");
  ctx.pick("dispose")();
});

await check("board.json: разбор минимума и дефолты", async () => {
  assert.equal(parseMinTodo(undefined), 1, "нет файла — минимум 1");
  assert.equal(parseMinTodo("{ битый"), 1, "битый JSON — минимум 1");
  assert.equal(parseMinTodo("null"), 1, "null — минимум 1");
  assert.equal(parseMinTodo("{}"), 1, "нет поля minTodo — минимум 1");
  assert.equal(parseMinTodo('{"minTodo": 2}'), 2);
  assert.equal(parseMinTodo('{"minTodo": "3"}'), 3, "строковое число должно читаться");
  assert.equal(parseMinTodo('{"minTodo": 0}'), 0, "0 — осознанное «сигналов не надо»");
  assert.equal(parseMinTodo('{"minTodo": "много"}'), 1, "мусор — минимум 1");
  assert.equal(parseMinTodo('{"minTodo": -2}'), 1, "отрицательное — минимум 1");
});

console.log(`\nвсего: ${passed} ok, ${failed} провал(ов)`);
process.exit(failed > 0 ? 1 : 0);
