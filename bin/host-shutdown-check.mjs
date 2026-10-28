#!/usr/bin/env node
/**
 * Харнесс реального graceful shutdown Host-процесса DSH — диагностика, а не
 * регрессия: он поднимает настоящее приложение, поэтому медленный и в базовый
 * `bin/test.sh` не входит (регрессия dispose — отдельная задача #053).
 *
 * Что меряет. Host (Electron в node-режиме + `dsh-desktop-host`) грузит профиль
 * `desktop` из копии, которую готовит харнесс, и общается с оболочкой по IPC:
 * `ready` → работа → `{type:"shutdown"}` → `shutdown-complete` → выход процесса.
 * Внутри DSH на это есть два бюджета: `PROCESS_SHUTDOWN_TIMEOUT_MS = 5e3` в
 * `dsh/lib/profile-boot` (дерево плагинов обязано дозакрыться за 5с, иначе
 * force-exit) и 10с у desktop-оболочки (потом SIGTERM/SIGKILL и
 * `DesktopHostUncleanExitError`). Харнесс печатает время до `ready`, до ack и до
 * выхода, код/сигнал выхода, и говорит, уложился ли сценарий в бюджет.
 *
 * Сценарии (как в спеке 003): `control` — плагин выключен; `board` — плагин и
 * одна доска; `roots` — плагин и `roots` на дерево с десятками досок; `events` —
 * плагин, много досок и записи в доски накануне shutdown (тикают debounce и
 * доставка нарядов). Разница «с плагином / без плагина» и есть ответ на вопрос
 * «виноват ли плагин».
 *
 * Изоляция. Временный `DSH_HOME` с собранным с нуля профилем `desktop`
 * (`package.json` с `dsh.profile.bundles`, `cordis.yml`, `cordis.patch.yml`,
 * `node_modules/dsh-kanban` — символическая ссылка на плагин этого дерева),
 * временные доски, свободный порт. Живой `~/.dsh` и живые сессии не трогаются:
 * всё лежит в `mkdtemp`.
 *
 * Порт. В host-энтри (`dsh-desktop-host/lib/index.js`) порт зашит: `"--port",
 * "19387"`. Если живое приложение запущено, порт занят, и второй Host падает с
 * `EADDRINUSE`. Поэтому харнесс подменяет литерал на `0` (ОС выдаёт свободный
 * порт) через ESM-хук `--import`: сам файл энтри не копируется и реальный граф
 * модулей не меняется.
 *
 * Запуск (node вне PATH, поэтому через bin/node.sh):
 *   bin/node.sh bin/host-shutdown-check.mjs
 *   bin/node.sh bin/host-shutdown-check.mjs --scenario control --repeat 3 --verbose
 *   DSH_APP_DIR="/Applications/DeepSeek Harness.app" bin/node.sh bin/host-shutdown-check.mjs
 *
 * Коды возврата: 0 — все сценарии в бюджете (или приложения нет — skip);
 * 1 — какой-то сценарий не уложился: нет ack за 5с, процесс не вышел сам за 10с
 * или вышел с ошибкой.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Плагин под тестом: по умолчанию — из этого дерева, можно подменить копией. */
const PLUGIN_DIR = process.env.DSH_HARNESS_PLUGIN_DIR ?? path.join(REPO_ROOT, "dsh-kanban");
const APP_DIR = process.env.DSH_APP_DIR ?? "/Applications/DeepSeek Harness.app";
const RESOURCES = path.join(APP_DIR, "Contents", "Resources");
const RUNTIME_DIR = path.join(RESOURCES, "app.asar", "dsh");
const HOST_ENTRY = path.join(RUNTIME_DIR, "node_modules", "@deepseek-ai", "dsh-desktop-host", "lib", "index.js");
const PRIMARY_RUNTIME = path.join(RESOURCES, "runtime", "primary-runtime");

/** Бюджет ack: столько DSH ждёт dispose дерева плагинов (profile-boot). */
const ACK_BUDGET_MS = numberFromEnv("DSH_HARNESS_ACK_BUDGET_MS", 5_000);
/** Бюджет выхода: столько оболочка ждёт процесс, прежде чем SIGTERM/SIGKILL. */
const EXIT_BUDGET_MS = numberFromEnv("DSH_HARNESS_EXIT_BUDGET_MS", 10_000);
/** Сколько ждать `ready`: первый старт грузит модули с диска. */
const READY_TIMEOUT_MS = numberFromEnv("DSH_HARNESS_READY_TIMEOUT_MS", 90_000);
/** Дополнительное время после бюджета выхода — чтобы увидеть «не вышел». */
const EXIT_SLACK_MS = 2_000;

const args = new Set(process.argv.slice(2));
const VERBOSE = args.has("--verbose");
const KEEP = args.has("--keep");
const SCENARIO_ONLY = valueOf("--scenario");
const REPEAT = Number(valueOf("--repeat") ?? 1);
/** Снимок handles через inspector — только по флагу: сам inspector влияет на тайминги. */
const WANT_HANDLES = args.has("--handles");

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function valueOf(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith("-") ? value : undefined;
}

/** Найти приложение: бинарь Electron, asar и собранный runtime. */
function resolveApp() {
  const binary = fs.existsSync(path.join(APP_DIR, "Contents", "MacOS"))
    ? fs.readdirSync(path.join(APP_DIR, "Contents", "MacOS")).map((name) => path.join(APP_DIR, "Contents", "MacOS", name)).find((file) => {
        try {
          return fs.statSync(file).isFile();
        } catch {
          return false;
        }
      })
    : undefined;
  const problems = [];
  if (!binary) problems.push(`нет бинаря Electron в ${path.join(APP_DIR, "Contents", "MacOS")}`);
  if (!fs.existsSync(path.join(RESOURCES, "app.asar"))) problems.push(`нет ${path.join(RESOURCES, "app.asar")}`);
  if (!fs.existsSync(PRIMARY_RUNTIME)) problems.push(`нет primary runtime ${PRIMARY_RUNTIME}`);
  if (!fs.existsSync(PLUGIN_DIR)) problems.push(`нет плагина ${PLUGIN_DIR}`);
  return { binary, problems };
}

/**
 * Подготовить изолированное окружение сценария.
 *
 * @param options - `{ plugin: boolean, boards: number, roots: boolean }`.
 * @returns Пути временного корня, DSH_HOME и профиля.
 */
function prepareHome(options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-shutdown-"));
  const home = path.join(root, "home");
  const profile = path.join(home, "profiles", "desktop");
  fs.mkdirSync(path.join(profile, "node_modules"), { recursive: true });

  // Профиль собираем с нуля: живой ~/.dsh не читаем вовсе (изоляция).
  const bundles = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"];
  if (options.plugin) bundles.push("dsh-kanban");
  fs.writeFileSync(
    path.join(profile, "package.json"),
    JSON.stringify(
      {
        name: "dsh-profile-desktop",
        private: true,
        ...(options.plugin ? { dependencies: { "dsh-kanban": `link:${PLUGIN_DIR}` } } : {}),
        dsh: { profile: { bundles } }
      },
      null,
      2,
    ) + "\n",
  );
  fs.writeFileSync(
    path.join(profile, "cordis.yml"),
    "# dsh profile root: дерево собирается патчами (см. package.json dsh.profile.bundles).\n[]\n",
  );
  // Патч-слой — либо пустой список, либо список строк: `[]` и элементы подряд
  // YAML не разберёт, поэтому строку ui-kanban пишем вместо `[]`, а не после.
  let rows = "";
  fs.writeFileSync(path.join(profile, "pnpm-workspace.yaml"), "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n");

  const boards = [];
  if (options.plugin && options.boards > 0) {
    if (options.roots) {
      const rootsDir = path.join(root, "projects");
      for (let index = 1; index <= options.boards; index += 1) {
        boards.push(makeBoard(path.join(rootsDir, `board-${String(index).padStart(2, "0")}`), 4));
      }
      rows += `- id: ui-kanban\n  config:\n    boards: []\n    roots:\n      - ${rootsDir}\n    roles: {}\n`;
    } else {
      for (let index = 1; index <= options.boards; index += 1) {
        boards.push(makeBoard(path.join(root, "projects", `board-${String(index).padStart(2, "0")}`), 4));
      }
      rows += `- id: ui-kanban\n  config:\n    boards:\n${boards.map((board) => `      - ${board}`).join("\n")}\n    roles: {}\n`;
    }
  }
  fs.writeFileSync(path.join(profile, "cordis.patch.yml"), "# Патч-слой профиля харнесса.\n" + (rows === "" ? "[]\n" : rows));
  if (options.plugin) fs.symlinkSync(PLUGIN_DIR, path.join(profile, "node_modules", "dsh-kanban"), "dir");
  return { root, home, profile, boards };
}

/** Доска с карточками: `.kanban/tasks` плюс board.json, как у живого проекта. */
function makeBoard(dir, cards) {
  fs.mkdirSync(path.join(dir, ".kanban", "tasks"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".kanban", "board.json"), '{ "minTodo": 0 }\n');
  for (let index = 1; index <= cards; index += 1) {
    const id = String(index).padStart(3, "0");
    fs.writeFileSync(
      path.join(dir, ".kanban", "tasks", `${id}.md`),
      `---\nid: "${id}"\ntitle: Задача ${id}\nstatus: todo\nowner: ""\nrole: ""\nupdated: 2026-10-28T10:00:00Z\n---\n\n## Задача\n\nПроба харнесса.\n`,
    );
  }
  return dir;
}

/**
 * Хук для дочернего процесса: подменить зашитый в host-энтри порт.
 *
 * Файл лежит рядом с профилем во временном каталоге и удаляется вместе с ним.
 * Литерал в энтри — `"--port", "19387"`; на `0` его подменяем, чтобы ОС выдала
 * свободный порт и харнесс не конфликтовал с живым приложением.
 */
function writePortHook(dir) {
  const file = path.join(dir, "port-hook.mjs");
  fs.writeFileSync(
    file,
    `import { registerHooks } from "node:module";
const PORT = process.env.DSH_HARNESS_PORT ?? "0";
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (typeof url === "string" && url.includes("dsh-desktop-host/lib/index.js") && result.source != null) {
      const text = String(result.source);
      const patched = text.replace(/(\\"--port\\",\\s*)\\"19387\\"/, (match, head) => head + JSON.stringify(PORT));
      if (patched === text) throw new Error("харнесс: в host-энтри не нашёлся \\"--port\\", \\"19387\\"");
      return { ...result, source: patched };
    }
    return result;
  }
});
`,
  );
  return file;
}

/** Снимок живых handles через inspector: что именно держит процесс. */
async function dumpHandles(inspectorUrl) {
  const socket = new WebSocket(inspectorUrl);
  const pending = new Map();
  let nextId = 1;
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("inspector: нет соединения")), { once: true });
  });
  try {
    // Мало имени конструктора: `process.getActiveResourcesInfo()` показывает
    // типы и количество (Timer, FSWatcher, …) — по ним видно, что не закрылось.
    const expression = `JSON.stringify({
      handles: process._getActiveHandles().map((handle) => handle.constructor?.name ?? typeof handle),
      resources: process.getActiveResourcesInfo(),
    })`;
    const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: false });
    const value = result?.result?.value;
    if (typeof value !== "string") return null;
    const parsed = JSON.parse(value);
    const counts = {};
    for (const name of parsed.resources ?? []) counts[name] = (counts[name] ?? 0) + 1;
    const summary = Object.entries(counts).map(([name, count]) => count > 1 ? `${name}×${count}` : name);
    return { handles: parsed.handles ?? [], resources: summary };
  } finally {
    socket.close();
  }
}

/**
 * Один прогон: старт, ready, shutdown, ack, выход.
 *
 * @param name - имя сценария.
 * @param options - `{ plugin, boards, roots, events }`.
 * @returns Замеры строкой таблицы.
 */
async function runScenario(name, options) {
  const prepared = prepareHome(options);
  const hook = writePortHook(prepared.root);
  const startedAt = Date.now();
  const child = spawn(
    resolveApp().binary,
    [
      "--expose-internals",
      ...(WANT_HANDLES ? ["--inspect=127.0.0.1:0"] : []),
      "--import",
      hook,
      HOST_ENTRY,
      RUNTIME_DIR,
      prepared.profile,
      PRIMARY_RUNTIME
    ],
    {
      cwd: prepared.profile,
      env: { ...process.env, DSH_HOME: prepared.home, ELECTRON_RUN_AS_NODE: "1", DSH_HARNESS_PORT: "0" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  const row = { name, boards: prepared.boards.length, readyMs: null, ackMs: null, exitMs: null, code: null, signal: null, handles: null, stderr: "" };
  let inspectorUrl = null;
  let ackAt = null;
  let exited = false;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    row.stderr = (row.stderr + chunk).slice(-8_000);
    const match = /Debugger listening on (ws:\/\/\S+)/.exec(chunk);
    if (match) inspectorUrl = match[1];
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", () => {
    /* stdout хоста не нужен: всё интересное в IPC и stderr */
  });

  const closed = new Promise((resolve) => {
    child.on("close", (code, signal) => {
      exited = true;
      row.code = code;
      row.signal = signal;
      row.exitMs = Date.now() - startedAt;
      resolve();
    });
  });

  const sentShutdown = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ready не пришёл за ${READY_TIMEOUT_MS}мс`)), READY_TIMEOUT_MS);
    const settle = (fn, value) => {
      clearTimeout(timer);
      fn(value);
    };
    child.on("message", (message) => {
      if (message?.type === "ready") {
        row.readyMs = Date.now() - startedAt;
        settle(resolve);
      }
      if (message?.type === "shutdown-complete") {
        row.ackMs = Date.now() - startedAt;
        ackAt = row.ackMs;
      }
      if (message?.type === "fatal") row.fatal = String(message.message ?? "").slice(0, 400);
      if (VERBOSE) console.log(`      [ipc] ${JSON.stringify(message).slice(0, 160)}`);
    });
    // Быстрый выход до ready — это падение старта, а не «ready не пришёл»:
    // без этой гонки провал старта ждал бы полный READY_TIMEOUT_MS.
    child.once("close", (code, signal) => {
      settle(reject, new Error(`хост завершился до ready: код ${code}${signal === null ? "" : `, сигнал ${signal}`}${row.fatal ? ` — ${row.fatal}` : ""}`));
    });
    child.on("error", (error) => settle(reject, error));
  });

  try {
    await sentShutdown;
    // Сценарий «события»: пишем в доски прямо перед shutdown, чтобы дебаунс и
    // доставка нарядов были в полёте в момент закрытия.
    if (options.events) {
      for (const board of prepared.boards.slice(0, 3)) {
        const stamp = new Date().toISOString();
        fs.writeFileSync(
          path.join(board, ".kanban", "tasks", "900.md"),
          `---\nid: "900"\ntitle: Событие перед shutdown\nstatus: todo\nowner: "session-probe"\nrole: ""\nupdated: ${stamp}\n---\n`,
        );
      }
    }
    await sleep(120);
    child.send({ type: "shutdown" });
    // Ждём ровно бюджет выхода плюс запас: «не вышел» — это тоже результат.
    await Promise.race([closed, sleep(EXIT_BUDGET_MS + EXIT_SLACK_MS)]);
    if (WANT_HANDLES && !exited && inspectorUrl) {
      try {
        row.handles = await dumpHandles(inspectorUrl);
      } catch (error) {
        row.handles = [`inspector: ${error.message}`];
      }
    }
  } catch (error) {
    row.error = error.message;
  } finally {
    if (!exited) {
      row.killed = true;
      child.kill("SIGKILL");
      await Promise.race([closed, sleep(2_000)]);
    }
    if (!KEEP) fs.rmSync(prepared.root, { recursive: true, force: true });
    else console.log(`      временный каталог: ${prepared.root}`);
  }
  return row;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Уложился ли сценарий в бюджеты: ack за 5с и выход за 10с. */
function verdict(row) {
  if (row.error) return `ошибка: ${row.error}`;
  if (row.ackMs === null) {
    return row.exitMs === null ? "нет ack и не вышел" : `нет ack, выход на ${row.exitMs}мс — похоже на force-exit`;
  }
  if (row.ackMs > ACK_BUDGET_MS) return `ack ${row.ackMs}мс — дольше ${ACK_BUDGET_MS}мс`;
  if (row.killed || row.exitMs === null) return `ack ${row.ackMs}мс, но процесс не вышел за ${EXIT_BUDGET_MS}мс`;
  if (row.exitMs - row.ackMs > EXIT_BUDGET_MS) return `выход через ${row.exitMs - row.ackMs}мс после ack — дольше бюджета`;
  if (row.code !== 0) return `выход с кодом ${row.code}`;
  if (row.signal !== null) return `выход по сигналу ${row.signal}`;
  return "ok";
}

function printTable(rows) {
  const header = ["сценарий", "досок", "ready, мс", "ack, мс", "exit, мс", "код", "сигнал", "вердикт"];
  const width = (value) => String(value ?? "—");
  const table = rows.map((row) => [
    row.name,
    width(row.boards),
    width(row.readyMs),
    width(row.ackMs),
    width(row.exitMs),
    width(row.code),
    width(row.signal),
    verdict(row),
  ]);
  const sizes = header.map((cell, index) => Math.max(cell.length, ...table.map((line) => line[index].length)));
  const line = (cells) => cells.map((cell, index) => cell.padEnd(sizes[index])).join("  ");
  console.log(`\n${line(header)}`);
  console.log(sizes.map((size) => "─".repeat(size)).join("  "));
  for (const cells of table) console.log(line(cells));
}

async function main() {
  const app = resolveApp();
  if (app.problems.length > 0) {
    console.log("пропуск: приложение DSH или плагин недоступны");
    for (const problem of app.problems) console.log(`  - ${problem}`);
    console.log("  харнесс поднимает настоящее приложение; на другой машине или платформе он не нужен");
    return 0;
  }

  const scenarios = [
    { name: "control", options: { plugin: false, boards: 0, roots: false, events: false } },
    { name: "board", options: { plugin: true, boards: 1, roots: false, events: false } },
    { name: "roots", options: { plugin: true, boards: 30, roots: true, events: false } },
    { name: "events", options: { plugin: true, boards: 10, roots: false, events: true } },
  ].filter((scenario) => SCENARIO_ONLY === undefined || scenario.name === SCENARIO_ONLY);

  if (scenarios.length === 0) {
    console.error(`неизвестный сценарий: ${SCENARIO_ONLY} (есть control, board, roots, events)`);
    return 2;
  }

  console.log(`приложение: ${APP_DIR}`);
  console.log(`плагин под тестом: ${PLUGIN_DIR}`);
  console.log(`бюджеты: ack ≤ ${ACK_BUDGET_MS}мс, выход ≤ ${EXIT_BUDGET_MS}мс; прогонов на сценарий: ${REPEAT}`);

  const rows = [];
  for (const scenario of scenarios) {
    for (let attempt = 1; attempt <= REPEAT; attempt += 1) {
      const label = REPEAT > 1 ? `${scenario.name}#${attempt}` : scenario.name;
      process.stdout.write(`\n${label}: `);
      const row = await runScenario(label, scenario.options);
      process.stdout.write(`ready ${row.readyMs ?? "—"}мс, ack ${row.ackMs ?? "—"}мс, exit ${row.exitMs ?? "—"}мс — ${verdict(row)}\n`);
      if (VERBOSE || (row.handles || []).length > 0 || row.error || verdict(row) !== "ok") {
        if (row.handles) {
          console.log(`      live handles: ${(row.handles.handles ?? []).join(", ")}`);
          console.log(`      live resources: ${(row.handles.resources ?? []).join(", ")}`);
        }
        if (row.error) console.log(`      ошибка: ${row.error}`);
        if ((VERBOSE || verdict(row) !== "ok") && row.stderr.trim() !== "") {
          console.log(`      stderr: ${row.stderr.trim().split("\n").slice(-6).join("\n              ")}`);
        }
      }
      rows.push(row);
    }
  }

  printTable(rows);

  // Вывод: виноват ли плагин. Контроль без плагина — эталон.
  const control = rows.filter((row) => row.name.startsWith("control"));
  const withPlugin = rows.filter((row) => !row.name.startsWith("control"));
  const controlBad = control.some((row) => verdict(row) !== "ok");
  const pluginBad = withPlugin.some((row) => verdict(row) !== "ok");
  console.log("");
  if (!pluginBad && !controlBad) {
    console.log("вывод: все сценарии в бюджете; graceful shutdown в порядке");
  } else if (controlBad && pluginBad) {
    console.log("вывод: плохо и без плагина тоже — причина не в dsh-kanban (или не только в нём)");
  } else if (controlBad) {
    console.log("вывод: с плагином всё в бюджете, а контроль без плагина — нет; плагин ни при чём");
  } else {
    console.log("вывод: без плагина в бюджете, с плагином — нет: причина в dsh-kanban");
    const worst = withPlugin.filter((row) => verdict(row) !== "ok").map((row) => `${row.name}: ${verdict(row)}`);
    for (const line of worst) console.log(`  - ${line}`);
    const live = withPlugin.filter((row) => row.handles).map((row) => `${row.name}: ${(row.handles.resources ?? []).join(", ")}`);
    for (const line of live) console.log(`  живые ресурсы после shutdown — ${line}`);
  }

  const failed = rows.filter((row) => verdict(row) !== "ok");
  if (failed.length > 0) {
    console.log(`\nпровалов: ${failed.length} из ${rows.length}`);
    return 1;
  }
  console.log(`\nвсе сценарии в бюджете (${rows.length})`);
  return 0;
}

const code = await main();
process.exit(code);
