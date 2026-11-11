/**
 * Регрессия dispose host-половины плагина: после выгрузки не остаётся живых
 * ресурсов, а in-flight работа отменяется.
 *
 * Приложение не запускается: контекст поддельный (как в `delivery.test.mjs`),
 * доски — временные каталоги. Проверяется то, что видно только в рантайме:
 * `fs.watch`-дескрипторы и таймеры после dispose, отмена `prompt` и дочерних
 * процессов `bin/task-assign.sh`, идемпотентность и бюджет времени dispose.
 *
 * Запуск: node dsh-kanban/test/shutdown.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { SERVICE_KEY } from "../lib/card-actions.js";
import { apply } from "../lib/index.js";

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`   ok: ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`   ПРОВАЛ: ${name}\n      ${error.message}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeout = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return true;
    await sleep(10);
  }
  return predicate();
}

/** Живые наблюдатели: на macOS это FSEventWrap, но класс всегда FSWatcher. */
function activeWatchers() {
  return process._getActiveHandles().filter((handle) => handle?.constructor?.name === "FSWatcher");
}

/** Сколько таймеров держит процесс: `getActiveResourcesInfo` видит Node-таймеры. */
function activeTimers() {
  return process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
}

/** Базовый уровень таймеров до стенда: у самого теста их быть не должно. */
const TIMER_BASELINE = activeTimers();

function writeCard(board, id, status, extra = {}) {
  fs.mkdirSync(path.join(board, ".kanban", "tasks"), { recursive: true });
  fs.writeFileSync(
    path.join(board, ".kanban", "tasks", `${id}.md`),
    [
      "---",
      `id: "${id}"`,
      `title: Задача ${id}`,
      `status: ${status}`,
      `owner: "${extra.owner ?? ""}"`,
      `updated: "${extra.updated ?? "2026-10-28T15:00:00Z"}"`,
      "---",
      "",
      "## Задача",
      "Тестовая карточка.",
      "",
    ].join("\n"),
  );
}

function makeBoard(name, cards) {
  const board = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kanban-shutdown-")), name);
  fs.mkdirSync(path.join(board, ".kanban", "tasks"), { recursive: true });
  for (const [id, status, extra] of cards) writeCard(board, id, status, extra);
  return board;
}

const stateFile = (board) => path.join(board, ".kanban", ".watcher-state.json");
const pendingFile = (board) => path.join(board, ".kanban", ".watcher-pending.json");

/**
 * Поддельный контекст: service-provider, обработчики и службы, которыми живут
 * сторож и канал. `prompt` подменяется сценарием теста.
 */
function makeCtx({ sessionCwd, prompt, logs = [] } = {}) {
  const handlers = new Map();
  const services = new Map();
  const prompts = [];
  /**
   * Выгрузка, как её делает cordis: при unload файбера вызываются disposer'ы
   * эффектов (в обратном порядке регистрации), а событие `dispose` при shutdown
   * DSH не эмитит вовсе. Тест обязан гонять именно этот путь — иначе мёртвый
   * cleanup проходит зелёным (ровно эта дыра нашлась в #052).
   */
  const effects = [];
  const promptImpl =
    prompt ??
    (async () => {
      return { accepted: true };
    });
  const ctx = {
    logger: () => ({
      info: (message) => logs.push(`info: ${message}`),
      warn: (message) => logs.push(`warn: ${message}`),
    }),
    on: (name, handler) => {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    pick: (name) => () => (handlers.get(name) ?? []).forEach((handler) => handler()),
    effect: (callback, label) => {
      const dispose = callback();
      if (typeof dispose === "function") effects.push({ dispose, label });
      return dispose;
    },
    provide: (name, value) => {
      services.set(name, value);
      return async () => services.delete(name);
    },
    get: (name) => {
      // Реестр пресетов (#062): без него плагин не стартует (inject).
      if (name === "agentPresets") return { register: async () => async () => {} };
      if (name === "sessionQuery") {
        return {
          observeSession: async (sessionId) => ({
            header: { id: sessionId, cwd: sessionCwd },
            [Symbol.dispose]: () => {},
          }),
        };
      }
      return services.get(name);
    },
    sessionController: {
      prompt: async (request, signal) => {
        prompts.push({ request, signal });
        return promptImpl(request, signal, prompts.length);
      },
    },
  };
  // Эффекты доступны и через ctx: так тест может звать unload(ctx) как cordis.
  ctx.effects = effects;
  return { ctx, prompts, services, effects };
}

/** Выгрузить плагин так, как это делает cordis: снять эффекты в обратном порядке. */
function unload(ctx) {
  for (const effect of [...ctx.effects].reverse()) effect.dispose();
}

console.log("== dispose: нет живых наблюдателей и таймеров, повтор безопасен");

/**
 * Один замер dispose: свежие 30 досок, свой контекст, своя уборка.
 *
 * Возвращает время teardown. Проверки живых ресурсов делаются в каждом прогоне:
 * «быстро, но с утёкшими watcher'ами» — не результат.
 */
async function measureDispose(cycle) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `kanban-shutdown-many-${cycle}-`));
  const boards = [];
  for (let index = 0; index < 30; index += 1) {
    const board = path.join(root, `board-${String(index).padStart(2, "0")}`);
    fs.mkdirSync(path.join(board, ".kanban", "tasks"), { recursive: true });
    writeCard(board, "001", "in-progress", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" });
    writeCard(board, "002", "in-review", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" });
    boards.push(board);
  }
  const { ctx } = makeCtx({ sessionCwd: boards[0] });
  apply(ctx, { boards, roles: { reviewer: "session-8cce3644-b81e-4783-8ee2-04d8c0d0569e" }, catchUpMs: 40, debounceMs: 10 });
  assert.ok(activeWatchers().length > 0, "сторож не поднял наблюдение — стенд не проверяет dispose");
  assert.ok(
    ctx.effects.some((effect) => typeof effect.dispose === "function"),
    "cleanup не зарегистрирован через ctx.effect: при shutdown cordis вызовет только его",
  );
  await sleep(60);
  const started = performance.now();
  unload(ctx);
  const elapsed = performance.now() - started;
  const closed = await waitFor(() => activeWatchers().length === 0, 5000);
  assert.ok(closed, `после dispose остались FSWatcher: ${activeWatchers()}`);
  const timersBack = await waitFor(() => activeTimers() <= TIMER_BASELINE, 5000);
  assert.ok(timersBack, `после dispose остались таймеры: ${activeTimers()} > ${TIMER_BASELINE}`);
  fs.rmSync(root, { recursive: true, force: true });
  return elapsed;
}

await check("30 досок: dispose закрывает все FSWatcher и укладывается в строгий бюджет (лучший из пяти)", async () => {
  // Строгий порог, но без флейков: машина под тестами бывает загружена, поэтому
  // меряем **лучший** из пяти независимых прогонов — это характеристика кода
  // dispose, а не текущей загрузки CPU (наблюдали разброс 53…1500 мс на одном коде).
  // Регрессию «в 3–5 раз медленнее» (300–900 мс вместо 150) такой порог ловит,
  // а прежний 1000 мс — уже нет.
  const timings = [];
  for (let cycle = 0; cycle < 5; cycle += 1) timings.push(await measureDispose(cycle));
  const best = Math.min(...timings);
  assert.ok(
    best < 250,
    `лучший dispose ${best.toFixed(1)} мс (бюджет 250); прогоны: ${timings.map((value) => value.toFixed(1)).join(", ")}`,
  );
});

await check("событие файловой системы после dispose не поднимает watcher и не пишет state", async () => {
  const board = makeBoard("events", [["002", "in-review", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]]);
  const { ctx, prompts } = makeCtx({ sessionCwd: board });
  apply(ctx, { boards: [board], roles: { reviewer: "session-8cce3644-b81e-4783-8ee2-04d8c0d0569e" }, catchUpMs: 20, debounceMs: 10 });
  assert.ok(await waitFor(() => fs.existsSync(stateFile(board))), "стартовый обход не записал state");
  const before = fs.readFileSync(stateFile(board), "utf8");
  const promptsBefore = prompts.length;
  unload(ctx);
  assert.ok(await waitFor(() => activeWatchers().length === 0, 5000), "наблюдатель не закрылся");
  // Событие после dispose: карточка появляется, каталог «меняется».
  writeCard(board, "003", "in-review", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" });
  await sleep(150);
  assert.equal(activeWatchers().length, 0, "watch не должен подниматься заново");
  assert.equal(fs.readFileSync(stateFile(board), "utf8"), before, "state изменился после dispose");
  assert.equal(prompts.length, promptsBefore, "после dispose ушёл новый наряд");
});

await check("повторный dispose безопасен и снимает службу канала", async () => {
  const board = makeBoard("repeat", [["001", "in-progress", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]]);
  const { ctx, services } = makeCtx({ sessionCwd: board });
  apply(ctx, { boards: [board], catchUpMs: 10 });
  assert.ok(ctx.get(SERVICE_KEY), "служба канала не зарегистрирована");
  const effect = ctx.effects.find((item) => item.label === "dsh-kanban: dispose") ?? ctx.effects.at(-1);
  assert.ok(effect, "cleanup не зарегистрирован как effect");
  effect.dispose();
  effect.dispose();
  assert.equal(ctx.get(SERVICE_KEY), undefined, "служба канала не снята");
  assert.equal(services.size, 0, "в контексте остались службы плагина");
  // Закрытый fs.watch исчезает из списка handles не мгновенно (платформа
  // дозавершает закрытие), поэтому ждём, а не проверяем сразу.
  assert.ok(await waitFor(() => activeWatchers().length === 0, 5000), "остались наблюдатели");
});

console.log("== dispose: in-flight наряды отменяются");

await check("in-flight prompt получает abort, новых доставок и записей после dispose нет", async () => {
  const board = makeBoard("inflight", [["002", "in-review", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]]);
  let capturedSignal = null;
  const prompt = (_request, signal) =>
    new Promise((_resolve, reject) => {
      capturedSignal = signal;
      signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    });
  const { ctx, prompts } = makeCtx({ sessionCwd: board, prompt });
  apply(ctx, { boards: [board], roles: { reviewer: "session-8cce3644-b81e-4783-8ee2-04d8c0d0569e" }, catchUpMs: 20, debounceMs: 10 });
  assert.ok(await waitFor(() => capturedSignal !== null), "доставка не началась");
  assert.equal(capturedSignal.aborted, false, "сигнал не должен быть отменён до dispose");
  unload(ctx);
  assert.equal(capturedSignal.aborted, true, "prompt не получил aborted-сигнал");
  await sleep(120);
  assert.equal(prompts.length, 1, "после dispose началась новая доставка");
  assert.equal(fs.existsSync(stateFile(board)), false, "после dispose записан state");
  assert.equal(fs.existsSync(pendingFile(board)), false, "отменённый наряд попал в pending");
});

await check("дочерний bin/task-assign.sh отменяется по dispose, а не живёт до таймаута", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-shutdown-child-"));
  writeCard(root, "001", "backlog");
  const marker = path.join(root, "child-started");
  const finished = path.join(root, "child-finished");
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  const script = path.join(root, "bin", "task-assign.sh");
  fs.writeFileSync(
    script,
    ["#!/usr/bin/env bash", `: > "${marker}"`, "sleep 5", `: > "${finished}"`, "exit 0", ""].join("\n"),
  );
  fs.chmodSync(script, 0o755);

  const { ctx } = makeCtx({ sessionCwd: root });
  apply(ctx, { boards: [root], catchUpMs: 5 });
  const service = ctx.get(SERVICE_KEY);
  assert.ok(service, "служба канала не зарегистрирована");
  const pending = service.assign({ sessionId: "session-df98a854-4084-4ba1-8fbc-f00faea193bf", cardId: "001" });
  let outcome = null;
  pending.then((value) => {
    outcome = value;
  });
  // Под нагрузкой запуск bash и запись маркера занимают секунды: 2 с мало.
  assert.ok(await waitFor(() => fs.existsSync(marker), 15000), "дочерний скрипт не запустился");
  const started = performance.now();
  unload(ctx);
  assert.ok(await waitFor(() => outcome !== null, 5000), "асайн не завершился после dispose");
  const elapsed = performance.now() - started;
  assert.equal(outcome.ok, false, `асайн не отменён: ${JSON.stringify(outcome)}`);
  assert.match(outcome.message, /отменён/);
  // Ребёнок спит 5 с, поэтому отмена за 3 с всё ещё доказывает, что его убили, а
  // не дождались его собственного выхода.
  assert.ok(elapsed < 3000, `ожидание отмены ${elapsed.toFixed(0)} мс (ребёнок не убит)`);
  await sleep(250);
  assert.equal(fs.existsSync(finished), false, "дочерний процесс дожил до конца: не убит");
  assert.equal(activeWatchers().length, 0, "остались наблюдатели");
});

console.log(`\nвсего: ${passed} ok, ${failed} провал(ов)`);
process.exit(failed > 0 ? 1 : 0);
