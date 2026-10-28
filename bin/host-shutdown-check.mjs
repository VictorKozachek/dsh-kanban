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
 * Раскладка бандла и вход Host'а. Харнесс не зашивает пути: он спрашивает сам
 * бандл (пробой в Electron node-режиме, потому что обычный Node не читает asar)
 * — где лежит `@deepseek-ai/dsh-desktop-host` (кандидаты: `app.asar/dsh`,
 * `Resources/runtime`, `app.asar.unpacked/dsh`; сперва `package.json.main`
 * пакета, потом известные пути), какая версия приложения и какая версия
 * desktop-хоста. Так харнесс переживает переезды вроде 0.1.x → 0.2.x, где
 * рантайм переехал в `Resources/runtime`.
 *
 * Порт. В 0.1.x host-энтри зашивал порт литералом (`"--port", "19387"`) — рядом
 * с живым приложением это `EADDRINUSE`. В 0.2.x хост сам просит свободный порт
 * (`"0"`). Харнесс читает литерал из энтри: если он фиксированный — подменяет
 * его на `0` ESM-хуком `--import` (файл энтри не копируется, граф модулей
 * настоящий); если порт уже динамический или литерала нет — хук ничего не
 * трогает и падать из-за отсутствия литерала не может.
 *
 * Запуск (node вне PATH, поэтому через bin/node.sh):
 *   bin/node.sh bin/host-shutdown-check.mjs
 *   bin/node.sh bin/host-shutdown-check.mjs --scenario control --repeat 3 --verbose
 *   bin/node.sh bin/host-shutdown-check.mjs --scenario board --settle 2500 --verbose  # дождаться самопроверки канала
 *   DSH_APP_DIR="/Applications/DeepSeek Harness.app" bin/node.sh bin/host-shutdown-check.mjs
 *
 * Коды возврата: 0 — все сценарии в бюджете (или приложения нет — skip);
 * 1 — какой-то сценарий не уложился: нет ack за 5с, процесс не вышел сам за 10с
 * или вышел с ошибкой.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Плагин под тестом: по умолчанию — из этого дерева, можно подменить копией. */
const PLUGIN_DIR = process.env.DSH_HARNESS_PLUGIN_DIR ?? path.join(REPO_ROOT, "dsh-kanban");
const APP_DIR = process.env.DSH_APP_DIR ?? "/Applications/DeepSeek Harness.app";
const RESOURCES = path.join(APP_DIR, "Contents", "Resources");
/** Пакет desktop-хоста внутри рантайма; версии 0.1.x и 0.2.x называют его одинаково. */
const HOST_PACKAGE = ["@deepseek-ai", "dsh-desktop-host"];
/** Путь входа можно подменить: так проверяется, что срыв виден по причине, а не по коду. */
const ENTRY_OVERRIDE = process.env.DSH_HARNESS_ENTRY ?? null;

/** Где искать рантайм DSH: 0.1.x — в asar, 0.2.x — плюс распакованный `Resources/runtime`. */
function runtimeCandidates() {
  return [
    process.env.DSH_HARNESS_RUNTIME_DIR,
    path.join(RESOURCES, "app.asar", "dsh"),
    path.join(RESOURCES, "runtime"),
    path.join(RESOURCES, "app.asar.unpacked", "dsh"),
  ].filter((value) => typeof value === "string" && value !== "");
}

/** Где искать `primary-runtime` (набор зависимостей офисных скилов). */
function primaryCandidates() {
  return [
    process.env.DSH_HARNESS_PRIMARY_RUNTIME,
    path.join(RESOURCES, "runtime", "primary-runtime"),
    path.join(process.env.DSH_HARNESS_RUNTIME_DIR ?? "", "..", "runtime", "primary-runtime"),
  ].filter((value) => typeof value === "string" && value !== "");
}

/** Бюджет ack: столько DSH ждёт dispose дерева плагинов (profile-boot). */
const ACK_BUDGET_MS = numberFromEnv("DSH_HARNESS_ACK_BUDGET_MS", 5_000);
/** Бюджет выхода: столько оболочка ждёт процесс, прежде чем SIGTERM/SIGKILL. */
const EXIT_BUDGET_MS = numberFromEnv("DSH_HARNESS_EXIT_BUDGET_MS", 10_000);
/** Сколько ждать `ready`: первый старт грузит модули с диска. */
const READY_TIMEOUT_MS = numberFromEnv("DSH_HARNESS_READY_TIMEOUT_MS", 90_000);
/** Дополнительное время после бюджета выхода — чтобы увидеть «не вышел». */
const EXIT_SLACK_MS = 2_000;

/** Имена сценариев: по ним же проверяется `--scenario`. */
const SCENARIO_NAMES = ["control", "board", "roots", "events"];

/**
 * Разобрать аргументы командной строки.
 *
 * Строгий разбор — часть диагностики: опечатка в команде не должна выглядеть
 * как успешный прогон. Поэтому неизвестный флаг, `--repeat` без числа, ноль или
 * отрицательное число — код 2 с подсказкой, а не «тихий» дефолт (#052, ревью).
 *
 * @param argv - аргументы без `node` и имени файла.
 * @returns `{ verbose, keep, handles, scenario, repeat, help }`.
 */
function parseArgs(argv) {
  const parsed = { verbose: false, keep: false, handles: false, scenario: undefined, repeat: 1, settle: 120, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--verbose") parsed.verbose = true;
    else if (arg === "--keep") parsed.keep = true;
    else if (arg === "--handles") parsed.handles = true;
    else if (arg === "-h" || arg === "--help") parsed.help = true;
    else if (arg === "--scenario") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        fail(`--scenario: ожидается имя сценария (${SCENARIO_NAMES.join(", ")}), получено ${value === undefined ? "пусто" : `«${value}»`}`);
      }
      if (!SCENARIO_NAMES.includes(value)) {
        fail(`--scenario: неизвестный сценарий «${value}» (есть ${SCENARIO_NAMES.join(", ")})`);
      }
      parsed.scenario = value;
      index += 1;
    } else if (arg === "--settle") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        fail(`--settle: ожидается целое ≥ 0 мс, получено ${value === undefined ? "пусто" : `«${value}»`}`);
      }
      const settle = Number(value);
      if (!Number.isInteger(settle) || settle < 0) {
        fail(`--settle: ожидается целое ≥ 0 мс, получено «${value}»`);
      }
      parsed.settle = settle;
      index += 1;
    } else if (arg === "--repeat") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        fail(`--repeat: ожидается целое ≥ 1, получено ${value === undefined ? "пусто" : `«${value}»`}`);
      }
      const repeat = Number(value);
      if (!Number.isInteger(repeat) || repeat < 1) {
        fail(`--repeat: ожидается целое ≥ 1, получено «${value}»`);
      }
      parsed.repeat = repeat;
      index += 1;
    } else {
      fail(`неизвестный аргумент «${arg}» (см. --help)`);
    }
  }
  return parsed;
}

/** Отказ в аргументах: код 2 и подсказка, без запуска приложения. */
function fail(message) {
  console.error(message);
  console.error("использование: bin/node.sh bin/host-shutdown-check.mjs [--scenario control|board|roots|events] [--repeat N] [--handles] [--verbose] [--keep]");
  process.exit(2);
}

const cli = parseArgs(process.argv.slice(2));
if (cli.help) {
  console.log("использование: bin/node.sh bin/host-shutdown-check.mjs [--scenario control|board|roots|events] [--repeat N] [--handles] [--verbose] [--keep]");
  console.log(`  --scenario  сценарий (${SCENARIO_NAMES.join(", ")}), по умолчанию все четыре`);
  console.log("  --repeat    прогонов на сценарий, целое ≥ 1 (по умолчанию 1)");
  console.log("  --settle    пауза после ready до shutdown, мс (по умолчанию 120; 2500 — дождаться самопроверки канала)");
  console.log("  --handles   снять живые handles через inspector (влияет на тайминги)");
  console.log("  --verbose   печатать IPC-сообщения и stderr хоста");
  console.log("  --keep      не удалять временный DSH_HOME");
  process.exit(0);
}
const VERBOSE = cli.verbose;
const KEEP = cli.keep;
const SCENARIO_ONLY = cli.scenario;
const REPEAT = cli.repeat;
/** Пауза после `ready` до shutdown: даёт дожить до отложенных проверок плагина. */
const SETTLE_MS = cli.settle;
/** Снимок handles через inspector — только по флагу: сам inspector влияет на тайминги. */
const WANT_HANDLES = cli.handles;

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Найти бинарь Electron приложения. */
function resolveBinary() {
  const binariesDir = path.join(APP_DIR, "Contents", "MacOS");
  if (!fs.existsSync(binariesDir)) return undefined;
  return fs
    .readdirSync(binariesDir)
    .map((name) => path.join(binariesDir, name))
    .find((file) => {
      try {
        return fs.statSync(file).isFile();
      } catch {
        return false;
      }
    });
}

/**
 * Спросить у самого бандла раскладку рантайма и вход Host'а.
 *
 * Обычный Node не читает asar, поэтому пробу выполняет Electron приложения в
 * node-режиме: он видит и `app.asar`, и распакованные каталоги. Так харнесс не
 * зависит от того, куда в очередной версии переехал рантайм.
 *
 * @param binary - путь к Electron приложения.
 * @returns `{ runtimeDir, entry, hostVersion, release, primaryRuntime, portLiteral, seen }`
 *   или `{ error }`, если рантайм не найден.
 */
function probeBundle(binary) {
  const script = `
import fs from "node:fs";
const runtimes = ${JSON.stringify(runtimeCandidates())};
const primaries = ${JSON.stringify(primaryCandidates())};
const pkgDir = ${JSON.stringify(HOST_PACKAGE.join("/"))};
const info = { runtimeDir: null, entry: null, hostVersion: null, release: null, primaryRuntime: null, portLiteral: null, seen: [] };
for (const dir of runtimes) {
  const root = dir + "/node_modules/" + pkgDir;
  const candidates = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(root + "/package.json", "utf8"));
    if (typeof pkg.main === "string") candidates.push(root + "/" + pkg.main);
    if (typeof pkg.version === "string" && info.hostVersion === null) info.hostVersion = pkg.version;
  } catch {}
  candidates.push(root + "/lib/index.js");
  candidates.push(root + "/lib/cli.js");
  const seen = candidates.filter((candidate) => { try { return fs.existsSync(candidate); } catch { return false; } });
  info.seen.push({ dir, entry: seen[0] ?? null });
  if (info.entry === null && seen.length > 0) {
    info.runtimeDir = dir;
    info.entry = seen[0];
    try { info.release = JSON.parse(fs.readFileSync(dir + "/desktop-runtime.json", "utf8")).release?.version ?? null; } catch {}
    try {
      const source = fs.readFileSync(seen[0], "utf8");
      const match = /"--port",\\s*"(\\d+)"/.exec(source);
      info.portLiteral = match ? match[1] : null;
    } catch {}
  }
}
for (const dir of primaries) { try { if (fs.existsSync(dir)) { info.primaryRuntime = dir; break; } } catch {} }
console.log(JSON.stringify(info));
`;
  const probe = spawnSync(binary, ["--expose-internals", "--input-type=module", "-e", script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf8",
    timeout: 60_000,
  });
  const line = (probe.stdout ?? "").trim().split("\n").filter(Boolean).pop();
  if (probe.error || probe.status !== 0 || line === undefined) {
    const detail = (probe.stderr ?? "").trim().split("\n").slice(-3).join(" ");
    return { error: `проба бандла не удалась: ${probe.error?.message ?? `код ${probe.status}: ${detail}`}` };
  }
  try {
    return JSON.parse(line);
  } catch (error) {
    return { error: `проба бандла вернула не JSON: ${error.message}` };
  }
}

/** Итоговая информация о бандле: заполняется один раз в main(). */
const BUNDLE = { binary: undefined, problems: [], runtimeDir: null, entry: null, hostVersion: null, release: null, primaryRuntime: null, portLiteral: null };

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
 * Хук для дочернего процесса: заменить фиксированный порт Host'а на свободный.
 *
 * Файл лежит рядом с профилем во временном каталоге и удаляется вместе с ним.
 * Хук не падает, если литерала порта в энтри нет: с 0.2.x хост сам просит
 * свободный порт (`"--port", "0"`), и подменять нечего. Порог — только
 * фиксированный ненулевой литерал, иначе рядом с живым приложением `EADDRINUSE`.
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
    if (typeof url !== "string" || !url.includes("dsh-desktop-host") || result.source == null) return result;
    const text = String(result.source);
    const match = /("--port",\\s*)"(\\d+)"/.exec(text);
    if (match === null || match[2] === "0") return result;
    return { ...result, source: text.replace(match[0], match[1] + JSON.stringify(PORT)) };
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
  const entry = ENTRY_OVERRIDE ?? BUNDLE.entry;
  const startedAt = Date.now();
  const child = spawn(
    BUNDLE.binary,
    [
      "--expose-internals",
      ...(WANT_HANDLES ? ["--inspect=127.0.0.1:0"] : []),
      "--import",
      hook,
      entry,
      BUNDLE.runtimeDir,
      prepared.profile,
      ...(BUNDLE.primaryRuntime === null ? [] : [BUNDLE.primaryRuntime])
    ],
    {
      cwd: prepared.profile,
      env: { ...process.env, DSH_HOME: prepared.home, ELECTRON_RUN_AS_NODE: "1", DSH_HARNESS_PORT: "0" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  const row = { name, boards: prepared.boards.length, readyMs: null, ackMs: null, exitMs: null, code: null, signal: null, handles: null, stderr: "", stdout: "" };
  let inspectorUrl = null;
  let ackAt = null;
  let exited = false;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    row.stderr = (row.stderr + chunk).slice(-8_000);
    const match = /Debugger listening on (ws:\/\/\S+)/.exec(chunk);
    if (match) inspectorUrl = match[1];
  });
  // stdout хоста тоже копим: при падении до `ready` причина бывает только там
  // (например, «dsh web: …» или стек модульного загрузчика).
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    row.stdout = (row.stdout + chunk).slice(-8_000);
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
    await sleep(SETTLE_MS);
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

/** Понятная причина срыва: по stderr/stdout/fatal, а не «код 1». */
function diagnose(row) {
  const text = `${row.stderr ?? ""}\n${row.stdout ?? ""}`;
  if (row.fatal) return `хост сообщил fatal: ${row.fatal}`;
  const known = [
    [/ERR_MODULE_NOT_FOUND|Cannot find module|MODULE_NOT_FOUND/, "модуль не найден (сломан вход или раскладка рантайма)"],
    [/EADDRINUSE/, "порт занят (рядом работает живое приложение и порт не был подменён)"],
    [/StartupError|required plugins did not activate|Failed plugins/, "профиль не поднялся: не активировались обязательные плагины"],
    [/ValidationError/, "невалидный конфиг плагина в профиле"],
    [/unbound variable/, "ошибка оболочки в скрипте набора"],
    [/ENOENT/, "файл или каталог не найден"],
  ];
  for (const [pattern, reason] of known) {
    const match = pattern.exec(text);
    if (!match) continue;
    // Берём не первое совпадение, а самую содержательную строку рядом: у стеков
    // первым идёт `throw new ERR_…(`, а сообщение — строкой ниже.
    const window = text.slice(Math.max(0, match.index - 200), match.index + 400).split("\n").map((part) => part.trim()).filter(Boolean);
    const lines = window.filter((part) => pattern.test(part));
    const best = lines.find((part) => /Cannot find|Error:|missing|EADDRINUSE|did not activate/i.test(part)) ?? lines.sort((a, b) => b.length - a.length)[0] ?? "";
    return `${reason}: ${best.slice(0, 300)}`;
  }
  return null;
}

/** Хвост вывода: последние строки, с отступом, чтобы читалось в отчёте. */
function tail(text, lines, indent) {
  const parts = String(text ?? "").trim().split("\n").filter((part) => part.trim() !== "");
  if (parts.length === 0) return `${indent}(пусто)`;
  return parts.slice(-lines).map((part) => `${indent}${part}`).join("\n");
}

/** Полный разбор срыва: причина, stdout и stderr хоста. */
function printFailure(row) {
  const reason = diagnose(row);
  console.log(`      причина: ${reason ?? "хост завершился без внятного сообщения — смотрите вывод ниже"}`);
  console.log(`      stdout хоста:\n${tail(row.stdout, 15, "        ")}`);
  console.log(`      stderr хоста:\n${tail(row.stderr, 20, "        ")}`);
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
  BUNDLE.binary = resolveBinary();
  if (!BUNDLE.binary) {
    BUNDLE.problems.push(`нет бинаря Electron в ${path.join(APP_DIR, "Contents", "MacOS")}`);
  } else if (!ENTRY_OVERRIDE) {
    const probe = probeBundle(BUNDLE.binary);
    if (probe.error) BUNDLE.problems.push(probe.error);
    else Object.assign(BUNDLE, probe);
    if (!probe.error && BUNDLE.entry === null) {
      BUNDLE.problems.push(`в бандле нет @deepseek-ai/dsh-desktop-host (искали в: ${runtimeCandidates().join(", ")})`);
    }
  }
  if (!fs.existsSync(PLUGIN_DIR)) BUNDLE.problems.push(`нет плагина ${PLUGIN_DIR}`);

  if (BUNDLE.problems.length > 0) {
    console.log("пропуск: приложение DSH или плагин недоступны");
    for (const problem of BUNDLE.problems) console.log(`  - ${problem}`);
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
  console.log(`версия DSH: ${BUNDLE.release ?? "неизвестна"} (desktop-host ${BUNDLE.hostVersion ?? "неизвестен"})`);
  console.log(`рантайм: ${BUNDLE.runtimeDir}`);
  console.log(`вход Host'а: ${ENTRY_OVERRIDE ?? BUNDLE.entry}${ENTRY_OVERRIDE === null ? "" : " (переопределён DSH_HARNESS_ENTRY)"}`);
  console.log(`primary runtime: ${BUNDLE.primaryRuntime ?? "не найден"}`);
  console.log(`порт Host'а: ${BUNDLE.portLiteral === null ? "динамический (литерала в энтри нет)" : BUNDLE.portLiteral === "0" ? "динамический («0» в энтри)" : `фиксированный литерал ${BUNDLE.portLiteral} — подменяем на свободный`}`);
  console.log(`плагин под тестом: ${PLUGIN_DIR}`);
  console.log(`бюджеты: ack ≤ ${ACK_BUDGET_MS}мс, выход ≤ ${EXIT_BUDGET_MS}мс; прогонов на сценарий: ${REPEAT}; пауза до shutdown: ${SETTLE_MS}мс`);

  const rows = [];
  for (const scenario of scenarios) {
    for (let attempt = 1; attempt <= REPEAT; attempt += 1) {
      const label = REPEAT > 1 ? `${scenario.name}#${attempt}` : scenario.name;
      process.stdout.write(`\n${label}: `);
      const row = await runScenario(label, scenario.options);
      process.stdout.write(`ready ${row.readyMs ?? "—"}мс, ack ${row.ackMs ?? "—"}мс, exit ${row.exitMs ?? "—"}мс — ${verdict(row)}\n`);
      if (row.handles) {
        console.log(`      live handles: ${(row.handles.handles ?? []).join(", ")}`);
        console.log(`      live resources: ${(row.handles.resources ?? []).join(", ")}`);
      }
      if (VERBOSE && verdict(row) === "ok") {
        console.log(`      stderr хоста:\n${tail(row.stderr, 40, "        ")}`);
      }
      // Срыв старта — это отдельный разбор: причина и полный вывод Host'а.
      if (verdict(row) !== "ok" || row.error) {
        if (row.error) console.log(`      ошибка: ${row.error}`);
        printFailure(row);
      }
      rows.push(row);
    }
  }

  if (rows.length === 0) {
    console.error("внутренняя ошибка: ни одного прогона — таблица пуста");
    return 2;
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
