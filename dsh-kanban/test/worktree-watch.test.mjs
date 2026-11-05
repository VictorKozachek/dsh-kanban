/**
 * Тесты обзора рабочих деревьев: сторож видит доски `worktrees/<id>` и сливает
 * их с основным чекаутом.
 *
 * Стенд без git: временный каталог с `.kanban/tasks` и
 * `worktrees/039/.kanban/tasks`, поддельный `sessionController` как в
 * `delivery.test.mjs`. Проверяется то, чего не видно в чистых функциях ядра:
 * слияние копий по `updated`, события из дерева, уборка дерева и путь дерева в
 * тексте наряда.
 *
 * Запуск: node dsh-kanban/test/worktree-watch.test.mjs
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

/** Роли, которых будит сторож. Диспетчера нет: недобор `todo` здесь не про нас. */
const ROLES = { reviewer: "session-8cce3644-b81e-4783-8ee2-04d8c0d0569e", verifier: "session-03d032c7-b73e-4ed5-82de-4cbb49138180" };

const T1 = "2026-10-21T10:00:00Z";
const T2 = "2026-10-21T11:00:00Z";
const T3 = "2026-10-21T12:00:00Z";

/** Записать карточку в доску `at` (корень проекта или каталог рабочего дерева). */
/**
 * Записать переход и дождаться, пока сторож его увидит.
 *
 * Фиксированная пауза перед записью не гарантирует, что `fs.watch` уже встал: под
 * нагрузкой он поднимается позже, и переход «теряется» — тест падал не по делу.
 * Пишем ту же версию карточки, пока наряд не появится: `updated` не меняется,
 * поэтому ключ доставки тот же и проверки «ровно один наряд» не ослабевают.
 */
async function writeUntilNoticed(write, calls, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (calls.length === 0 && Date.now() < deadline) {
    write();
    await sleep(50);
  }
  assert.ok(calls.length > 0, message);
}

function writeCard(at, id, status, extra = {}) {
  const dir = path.join(at, ".kanban", "tasks");
  fs.mkdirSync(dir, { recursive: true });
  const text = [
    "---",
    `id: "${id}"`,
    `title: Задача ${id}`,
    `status: ${status}`,
    `owner: "${extra.owner ?? "session-6af8ff46-f3e7-4640-8a2d-045543fbc030"}"`,
    `worktree: "${extra.worktree ?? ""}"`,
    `updated: "${extra.updated ?? T1}"`,
    "---",
    ""
  ].join("\n");
  fs.writeFileSync(path.join(dir, `${id}.md`), text);
}

/** Временный корень проекта с основным каталогом карточек. */
function makeBoard() {
  const board = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-worktree-"));
  fs.mkdirSync(path.join(board, ".kanban", "tasks"), { recursive: true });
  return board;
}

/** Рабочее дерево задачи внутри проекта: `worktrees/<name>/.kanban/tasks`. */
function makeWorktree(board, name) {
  const at = path.join(board, "worktrees", name);
  fs.mkdirSync(path.join(at, ".kanban", "tasks"), { recursive: true });
  return at;
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

/** Конфиг сторожа для стенда: короткие паузы, чтобы тест не ждал. */
function config(board, extra = {}) {
  return { boards: [board], roles: ROLES, debounceMs: 20, ...extra };
}

/** `board.json` с выключенным сигналом о недоборе: он в этих тестах не про нас. */
function silenceRefill(board) {
  fs.writeFileSync(path.join(board, ".kanban", "board.json"), '{\n  "minTodo": 0\n}\n');
}

console.log("== обзор worktrees: снимок доски из нескольких источников");

await check("переход карточки в рабочем дереве даёт наряд с путём дерева", async () => {
  const board = makeBoard();
  const tree = makeWorktree(board, "039");
  // Обе копии одинаковы — карточка живёт в дереве, основная копия от прошлого слияния.
  writeCard(board, "039", "in-progress", { updated: T1 });
  writeCard(tree, "039", "in-progress", { updated: T1, worktree: tree });

  const calls = [];
  const ctx = makeCtx(calls);
  apply(ctx, config(board, { catchUpMs: 5000 }));
  await writeUntilNoticed(() => writeCard(tree, "039", "in-review", { updated: T2, worktree: tree }), calls, "переход в рабочем дереве не объявлен");
  await sleep(200);
  assert.equal(calls.length, 1, `нарядов ${calls.length}`);
  assert.equal(calls[0].sessionId, "session-8cce3644-b81e-4783-8ee2-04d8c0d0569e");
  const text = calls[0].content[0].text;
  assert.match(text, /#039/, "в наряде нет id карточки");
  assert.ok(text.includes("worktrees/039"), `в наряде нет пути рабочего дерева: ${text}`);
  assert.ok(text.includes("работай там"), `в наряде нет указания работать в дереве: ${text}`);
  assert.ok(text.includes(".kanban/tasks/039.md"), "в наряде нет пути к карточке");
  ctx.pick("dispose")();
});

await check("свежая копия из рабочего дерева побеждает копию основного чекаута", async () => {
  const board = makeBoard();
  const tree = makeWorktree(board, "039");
  writeCard(board, "039", "in-progress", { updated: T1 });
  writeCard(tree, "039", "in-review", { updated: T2 });

  const calls = [];
  const ctx = makeCtx(calls);
  apply(ctx, config(board, { catchUpMs: 20 }));
  assert.ok(await waitFor(() => calls.length > 0), "карточка из дерева не объявлена");
  await sleep(150);
  assert.equal(calls.length, 1, `нарядов ${calls.length}`);
  assert.equal(calls[0].sessionId, "session-8cce3644-b81e-4783-8ee2-04d8c0d0569e");
  assert.ok(calls[0].content[0].text.includes("worktrees/039"));
  ctx.pick("dispose")();
});

await check("старая копия из рабочего дерева проигрывает основному чекауту", async () => {
  const board = makeBoard();
  const tree = makeWorktree(board, "039");
  writeCard(board, "039", "in-review", { updated: T3 });
  writeCard(tree, "039", "testing", { updated: T1 });

  const calls = [];
  const ctx = makeCtx(calls);
  apply(ctx, config(board, { catchUpMs: 20 }));
  assert.ok(await waitFor(() => calls.length > 0), "свежая копия не объявлена");
  await sleep(200);
  assert.equal(calls.length, 1, `нарядов ${calls.length}`);
  assert.equal(calls[0].sessionId, "session-8cce3644-b81e-4783-8ee2-04d8c0d0569e", "победила старая копия из дерева");
  ctx.pick("dispose")();
});

await check("при равном updated выигрывает копия из рабочего дерева", async () => {
  const board = makeBoard();
  const tree = makeWorktree(board, "039");
  writeCard(board, "039", "in-review", { updated: T2 });
  writeCard(tree, "039", "testing", { updated: T2 });

  const calls = [];
  const ctx = makeCtx(calls);
  apply(ctx, config(board, { catchUpMs: 20 }));
  assert.ok(await waitFor(() => calls.length > 0), "карточка не объявлена");
  await sleep(200);
  assert.equal(calls.length, 1, `нарядов ${calls.length}`);
  assert.equal(calls[0].sessionId, "session-03d032c7-b73e-4ed5-82de-4cbb49138180", "равенство должно решаться в пользу дерева");
  ctx.pick("dispose")();
});

await check("новое рабочее дерево подхватывается без перезапуска", async () => {
  const board = makeBoard();
  writeCard(board, "047", "in-progress", { updated: T1 });
  const calls = [];
  const ctx = makeCtx(calls);
  // Деревьев в проекте ещё нет — сторож узнаёт о них по событию в корне.
  apply(ctx, config(board, { catchUpMs: 5000 }));
  await sleep(150);
  const tree = makeWorktree(board, "047");
  await writeUntilNoticed(() => writeCard(tree, "047", "in-review", { updated: T2 }), calls, "появившееся дерево не подхвачено");
  await sleep(150);
  assert.equal(calls.length, 1, `нарядов ${calls.length}`);
  assert.equal(calls[0].sessionId, "session-8cce3644-b81e-4783-8ee2-04d8c0d0569e");
  assert.ok(calls[0].content[0].text.includes("worktrees/047"));
  ctx.pick("dispose")();
});

await check("удалённое дерево не ломает обход и не даёт ложных нарядов", async () => {
  const board = makeBoard();
  const tree = makeWorktree(board, "039");
  writeCard(board, "039", "in-progress", { updated: T1 });
  writeCard(tree, "039", "in-progress", { updated: T1 });

  const calls = [];
  const ctx = makeCtx(calls);
  apply(ctx, config(board, { catchUpMs: 5000 }));
  await sleep(150);
  assert.equal(calls.length, 0, "одинаковые копии не должны будить никого");

  // Убрали рабочее дерево: остаётся копия основного чекаута, статус тот же —
  // повода для наряда нет.
  fs.rmSync(path.join(board, "worktrees"), { recursive: true, force: true });
  await sleep(400);
  assert.equal(calls.length, 0, `уборка дерева дала наряд: ${JSON.stringify(calls.map((c) => c.content[0].text))}`);

  // Сторож продолжает работать: переход в основном чекауте по-прежнему виден.
  await writeUntilNoticed(() => writeCard(board, "039", "in-review", { updated: T2 }), calls, "основной чекаут перестал объявлять переходы");
  await sleep(150);
  assert.equal(calls.length, 1, `нарядов ${calls.length}`);
  assert.equal(calls[0].sessionId, "session-8cce3644-b81e-4783-8ee2-04d8c0d0569e");
  ctx.pick("dispose")();
});

await check("битые и пустые каталоги в worktrees/ не ломают обход", async () => {
  const board = makeBoard();
  fs.mkdirSync(path.join(board, "worktrees", "без-доски"), { recursive: true });
  fs.mkdirSync(path.join(board, "worktrees", ".мусор"), { recursive: true });
  fs.writeFileSync(path.join(board, "worktrees", "файл-не-дерево"), "не дерево");
  const broken = makeWorktree(board, "044");
  fs.writeFileSync(path.join(broken, ".kanban", "tasks", "044.md"), "просто текст без front matter\n");
  writeCard(board, "045", "in-progress", { updated: T1 });

  const calls = [];
  const ctx = makeCtx(calls);
  apply(ctx, config(board, { catchUpMs: 20 }));
  await sleep(300);
  assert.equal(calls.length, 0, `битые каталоги дали наряд: ${calls.length}`);

  await writeUntilNoticed(() => writeCard(board, "045", "in-review", { updated: T2 }), calls, "основной чекаут не объявил переход");
  await sleep(150);
  assert.equal(calls.length, 1, `нарядов ${calls.length}`);
  ctx.pick("dispose")();
});

await check("наряд по версии карточки не повторяется после перезапуска", async () => {
  const board = makeBoard();
  const tree = makeWorktree(board, "039");
  writeCard(board, "039", "in-review", { updated: T2 });
  writeCard(tree, "039", "in-review", { updated: T2 });

  const calls = [];
  const first = makeCtx(calls);
  apply(first, config(board, { catchUpMs: 20 }));
  assert.ok(await waitFor(() => calls.length > 0), "наряд не отправлен");
  assert.ok(
    await waitFor(() => stateKeys(board).some((key) => key.startsWith("039:in-review:"))),
    "в файле состояния нет ключа версии карточки",
  );
  first.pick("dispose")();

  const again = [];
  const second = makeCtx(again);
  apply(second, config(board, { catchUpMs: 20 }));
  await sleep(300);
  assert.equal(again.length, 0, "повторный запуск объявил ту же версию снова");
  second.pick("dispose")();
});

await check("карточка с полем worktree в основном чекауте зовёт в своё дерево", async () => {
  const board = makeBoard();
  const tree = makeWorktree(board, "052");
  // Карточка лежит в основном чекауте, но её рабочее дерево уже создано: путь
  // берётся из поля `worktree` (абсолютный, как его пишет bin/task-new.sh).
  writeCard(board, "052", "in-review", { updated: T2, worktree: tree });

  const calls = [];
  const ctx = makeCtx(calls);
  apply(ctx, config(board, { catchUpMs: 20 }));
  assert.ok(await waitFor(() => calls.length > 0), "карточка не объявлена");
  await sleep(150);
  assert.equal(calls.length, 1, `нарядов ${calls.length}`);
  const text = calls[0].content[0].text;
  assert.ok(text.includes("worktrees/052"), `путь из поля worktree не попал в наряд: ${text}`);
  assert.ok(text.includes("работай там"), "в наряде нет указания работать в дереве");
  ctx.pick("dispose")();
});

await check("переход в основном чекауте по-прежнему даёт наряд", async () => {
  const board = makeBoard();
  makeWorktree(board, "039"); // пустое дерево рядом не мешает
  writeCard(board, "048", "in-progress", { updated: T1 });

  const calls = [];
  const ctx = makeCtx(calls);
  apply(ctx, config(board, { catchUpMs: 5000 }));
  await writeUntilNoticed(() => writeCard(board, "048", "in-review", { updated: T2 }), calls, "переход в основной доске не объявлен");
  await sleep(150);
  assert.equal(calls.length, 1, `нарядов ${calls.length}`);
  assert.equal(calls[0].sessionId, "session-8cce3644-b81e-4783-8ee2-04d8c0d0569e");
  // Основная копия — без рабочего дерева: приписки про дерево в тексте быть не должно.
  assert.ok(!calls[0].content[0].text.includes("работай там"), "наряд из основного чекаута зовёт в дерево");
  ctx.pick("dispose")();
});

await check("наряд о слиянии не зовёт в рабочее дерево", async () => {
  const board = makeBoard();
  const tree = makeWorktree(board, "053");
  writeCard(board, "053", "in-progress", { updated: T1 });
  writeCard(tree, "053", "testing", { updated: T2, worktree: tree });
  silenceRefill(board);

  const calls = [];
  const ctx = makeCtx(calls);
  apply(ctx, { ...config(board, { catchUpMs: 5000 }), roles: { ...ROLES, dispatcher: "session-dca2c9fe-f0d4-43f2-855e-d62a284adf85" } });
  // Фиксированная пауза до записи не годится: `fs.watch` под нагрузкой не успевает
  // встать, и переход «теряется» (флейк на загруженной машине). Пишем ту же версию
  // карточки, пока сторож не увидит: `updated` не меняется, поэтому ключ доставки
  // тот же и второй наряд не появится — это проверяется ниже.
  const deadline = Date.now() + 5000;
  while (calls.length === 0 && Date.now() < deadline) {
    writeCard(tree, "053", "ready", { updated: T3, worktree: tree });
    await sleep(50);
  }
  assert.ok(calls.length > 0, "наряд о слиянии не отправлен");
  await sleep(200);
  assert.equal(calls.length, 1, `нарядов ${calls.length}`);
  assert.equal(calls[0].sessionId, "session-dca2c9fe-f0d4-43f2-855e-d62a284adf85");
  const text = calls[0].content[0].text;
  assert.ok(text.includes("bin/task-commit.sh 053"), `в наряде нет команды слияния: ${text}`);
  // `bin/task-commit.sh` из рабочего дерева задачи отказывается работать.
  assert.ok(!text.includes("работай там"), `наряд о слиянии зовёт в дерево: ${text}`);
  assert.ok(!text.includes("worktrees/053"), `наряд о слиянии упоминает дерево: ${text}`);
  ctx.pick("dispose")();
});

await check("унаследованная копия чужой карточки не приписывает чужое дерево", async () => {
  const board = makeBoard();
  const tree = makeWorktree(board, "039");
  // Дерево ветвится от main: в нём лежат копии всех карточек, но живая карточка
  // задачи — только одноимённая (039.md). Чужие копии — эхо основной ветки.
  writeCard(board, "042", "in-review", { updated: T2 });
  writeCard(tree, "042", "in-review", { updated: T2 });

  const calls = [];
  const ctx = makeCtx(calls);
  apply(ctx, config(board, { catchUpMs: 20 }));
  assert.ok(await waitFor(() => calls.length > 0), "карточка основного чекаута не объявлена");
  await sleep(200);
  assert.equal(calls.length, 1, `нарядов ${calls.length}`);
  const text = calls[0].content[0].text;
  assert.ok(!text.includes("работай там"), `наряд по #042 зовёт в чужое дерево: ${text}`);
  assert.ok(!text.includes("worktrees/039"), `наряд по #042 упоминает чужое дерево: ${text}`);

  // Даже более свежая копия чужой карточки в дереве не считается живой: правило
  // то же, что в клиентской половине — из дерева берётся только одноимённая.
  writeCard(tree, "042", "testing", { updated: T3 });
  await sleep(300);
  assert.equal(calls.length, 1, `унаследованная копия дала наряд: ${calls.length}`);
  ctx.pick("dispose")();
});

await check("файл с чужим id внутри дерева не приписывает карточку", async () => {
  const board = makeBoard();
  const tree = makeWorktree(board, "039");
  writeCard(board, "042", "in-review", { updated: T2 });
  // Файл назван по дереву, но внутри чужая карточка: испорченная копия не должна
  // ни подменить карточку основного чекаута, ни приписать ей это дерево.
  const impostor = [
    "---",
    'id: "042"',
    "title: Задача 042",
    "status: testing",
    'owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030"',
    `updated: "${T3}"`,
    "---",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(tree, ".kanban", "tasks", "039.md"), impostor);

  const calls = [];
  const ctx = makeCtx(calls);
  apply(ctx, config(board, { catchUpMs: 20 }));
  assert.ok(await waitFor(() => calls.length > 0), "карточка основного чекаута не объявлена");
  await sleep(200);
  assert.equal(calls.length, 1, `нарядов ${calls.length}`);
  assert.equal(calls[0].sessionId, "session-8cce3644-b81e-4783-8ee2-04d8c0d0569e", "испорченная копия подменила карточку");
  assert.ok(!calls[0].content[0].text.includes("работай там"), "испорченная копия приписала чужое дерево");
  ctx.pick("dispose")();
});

console.log(`\nвсего: ${passed} ok, ${failed} провал(ов)`);
process.exit(failed > 0 ? 1 : 0);
