#!/usr/bin/env node
/**
 * `bin/doctor` — проверка установки и первых шагов.
 *
 * Отвечает на вопрос «почему наряды не идут / новичок всё сделал?» одним
 * прогоном: node/git, доска и протокол в проекте, установка плагина в профиль,
 * профильный конфиг (`boards`/`roots`), живая диагностика сторожа
 * (`/tmp/dsh-kanban-watch.diag.json`), карта ролей, pending.
 *
 * Коды выхода: 0 — всё хорошо, 1 — есть предупреждения, 2 — есть ошибки.
 *
 * Запуск:
 *   bin/doctor.sh                    # текущий проект
 *   bin/doctor.sh --project DIR      # другой проект
 *   bin/doctor.sh --json             # машинный отчёт
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
let project = process.cwd();
const projectIndex = args.indexOf("--project");
if (projectIndex >= 0) {
  const value = args[projectIndex + 1];
  if (!value) {
    console.error("doctor: --project требует каталог");
    process.exit(2);
  }
  project = path.resolve(value);
}

const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
const DIAG_PATH = process.env.DSH_KANBAN_DIAG_PATH ?? "/tmp/dsh-kanban-watch.diag.json";
const checks = [];

function add(level, name, detail, fix = "") {
  checks.push({ level, name, detail, fix });
}

function exists(file) {
  try {
    fs.statSync(file);
    return true;
  } catch {
    return false;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function run(cmd, cmdArgs, cwd) {
  try {
    return execFileSync(cmd, cmdArgs, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function real(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

/* --- 1. Node --------------------------------------------------------------- */
add("ok", "node", process.version);

/* --- 2. Проект и доска ----------------------------------------------------- */
const tasksDir = path.join(project, ".kanban", "tasks");
if (!exists(tasksDir)) {
  add(
    "fail",
    "доска проекта",
    `нет каталога ${path.relative(project, tasksDir)}`,
    "разверните протокол: bin/kanban-init.sh <проект> (или создайте .kanban/tasks вручную)",
  );
} else {
  let cards = 0;
  try {
    cards = fs.readdirSync(tasksDir).filter((name) => name.endsWith(".md") && name !== "README.md").length;
  } catch {
    /* нет доступа — ниже диагностика покажет */
  }
  add("ok", "доска проекта", `.kanban/tasks — карточек: ${cards}`);
}

/* --- 3. Git ---------------------------------------------------------------- */
const insideGit = run("git", ["-C", project, "rev-parse", "--is-inside-work-tree"], project) === "true";
if (!insideGit) {
  add(
    "warn",
    "git",
    "проект не в git-репозитории",
    "задачи с worktree требуют git; для проб можно bin/task-new.sh --no-worktree",
  );
} else {
  const head = run("git", ["-C", project, "rev-parse", "--verify", "HEAD"], project);
  if (!head) {
    add("warn", "git", "в репозитории ещё нет коммитов", "сделайте первый коммит — worktree создаётся от HEAD");
  } else {
    add("ok", "git", `репозиторий, HEAD ${head.slice(0, 7)}`);
  }
}

/* --- 4. Протокол в проекте ------------------------------------------------- */
const protocol = [
  ["AGENTS.md", "правила ролей для агентов"],
  ["bin/task-new.sh", "создание задачи"],
  ["bin/task-move.sh", "переходы карточки"],
  ["bin/task-commit.sh", "слияние"],
  ["bin/board-status.sh", "состояние доски"],
  ["bin/node.sh", "поиск node"],
  [".kanban/tasks/README.md", "формат карточек"],
];
const missing = protocol.filter(([file]) => !exists(path.join(project, file))).map(([file]) => file);
if (missing.length === 0) {
  add("ok", "протокол", "bin/ + AGENTS.md + .kanban на месте");
} else {
  add(
    "warn",
    "протокол",
    `нет: ${missing.join(", ")}`,
    "bin/kanban-init.sh <проект> развернёт недостающее",
  );
}

/* --- 5. Установка плагина в профили ---------------------------------------- */
const profilesDir = path.join(DSH_HOME, "profiles");
const installed = [];
try {
  for (const name of fs.readdirSync(profilesDir)) {
    const manifest = readJson(path.join(profilesDir, name, "package.json"));
    if (!manifest) continue;
    const deps = manifest.dependencies ?? {};
    const bundles = manifest?.dsh?.profile?.bundles ?? [];
    if (deps["dsh-kanban"] || bundles.includes("dsh-kanban")) installed.push(name);
  }
} catch {
  /* профилей ещё нет */
}
if (installed.length > 0) {
  add("ok", "плагин", `установлен в профиль: ${installed.join(", ")}`);
} else {
  add(
    "fail",
    "плагин",
    `не найден ни в одном профиле (${profilesDir})`,
    "bin/install-kanban.sh desktop  (или web) и перезапустите DSH",
  );
}

/* --- 6. Профильный конфиг: где сторож ищет доски --------------------------- */
const patch = path.join(DSH_HOME, "cordis.patch.yml");
const patchText = exists(patch) ? fs.readFileSync(patch, "utf8") : "";
const projectReal = real(project);
if (patchText.includes(project) || patchText.includes(projectReal)) {
  add("ok", "конфиг", `${project} упомянут в ~/.dsh/cordis.patch.yml`);
} else {
  add(
    "warn",
    "конфиг",
    `проект не найден в ~/.dsh/cordis.patch.yml (boards/roots)`,
    `добавьте boards: ["${project}"] в строку ui-kanban и перезапустите DSH`,
  );
}

/* --- 7. Диагностика сторожа ------------------------------------------------- */
const diag = exists(DIAG_PATH) ? readJson(DIAG_PATH) : null;
if (!diag) {
  add(
    "fail",
    "сторож",
    `нет файла ${DIAG_PATH}`,
    "запущен ли DSH с плагином; после перезапуска файл появится сам",
  );
} else {
  if (diag.fatal) {
    add("fail", "сторож", `ошибка применения: ${String(diag.fatal).split("\n")[0]}`, "см. события в диагностике");
  } else {
    const boards = diag?.applied?.boards ?? diag?.applies?.at(-1)?.boards ?? 0;
    const watchers = diag?.applied?.watchers ?? 0;
    if (boards > 0) add("ok", "сторож", `досок: ${boards}, наблюдателей: ${watchers}`);
    else add("fail", "сторож", "apply был, но досок 0", "проверьте boards/roots в конфиге");
  }

  const heartbeat = diag.heartbeatAt ? Date.parse(diag.heartbeatAt) : 0;
  const ageSeconds = heartbeat ? Math.round((Date.now() - heartbeat) / 1000) : null;
  if (ageSeconds !== null && ageSeconds <= 120) {
    add("ok", "heartbeat", `${ageSeconds} с назад`);
  } else if (ageSeconds !== null) {
    add("warn", "heartbeat", `${ageSeconds} с назад — плагин мог остановиться`, "перезапустите DSH");
  }

  const watched = diag.watched ?? [];
  const watchedReal = watched.map((item) => real(item));
  const covered = watchedReal.some((item) => item === projectReal || projectReal.startsWith(item + path.sep));
  if (covered) {
    add("ok", "наблюдение", "проект входит в watched");
  } else {
    add(
      "warn",
      "наблюдение",
      `проекта нет в watched (${watched.length} досок)`,
      "проверьте boards/roots в ~/.dsh/cordis.patch.yml и перезапустите DSH",
    );
  }
}

/* --- 7b. Что DSH считает активным при закрытии (issue #081) ---------------- */
if (diag.host && diag.host.available) {
  const agents = Array.isArray(diag.host.agents) ? diag.host.agents : [];
  const jobs = Array.isArray(diag.host.jobs) ? diag.host.jobs : [];
  if (agents.length === 0 && jobs.length === 0) {
    add("ok", "активные задачи", "DSH не видит, что прерывать при закрытии");
  } else {
    const parts = [
      ...agents.map((agent) => `сессия ${agent.id} (${agent.status}, очередь ${agent.nextTurn}/${agent.nextStep})`),
      ...jobs.map((job) => `job ${job.jobId} (${job.kind}, ${job.status})`),
    ];
    add(
      "warn",
      "активные задачи",
      `DSH считает активными: ${parts.join("; ")}`,
      "если сессии не работают — это фантомная активность (issue #081); смотрите host в диагностике",
    );
  }
}

/* --- 8. Карта ролей --------------------------------------------------------- */
const rolesFile = path.join(project, ".kanban", ".watcher-roles.json");
const roles = exists(rolesFile) ? readJson(rolesFile) : null;
const sessionIds = new Set();
const sessionRoot = path.join(DSH_HOME, "sessions");
try {
  for (const projectDir of fs.readdirSync(sessionRoot)) {
    const dir = path.join(sessionRoot, projectDir);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const entry of fs.readdirSync(dir)) {
      sessionIds.add(entry.replace(/^session-/, ""));
    }
  }
} catch {
  /* сессий ещё нет */
}
if (roles && Object.keys(roles).length > 0) {
  const bad = [];
  for (const [role, id] of Object.entries(roles)) {
    const uuid = String(id).replace(/^session-/, "");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) bad.push(`${role}: не session-id`);
    else if (!sessionIds.has(uuid)) bad.push(`${role}: сессия не найдена`);
  }
  if (bad.length === 0) add("ok", "роли", Object.keys(roles).join(", "));
  else add("warn", "роли", bad.join("; "), "пересоздайте роль с пресетом или поправьте .watcher-roles.json");
} else {
  add(
    "warn",
    "роли",
    "карта ролей пуста — наряды некому доставлять",
    "создайте 4 сессии с пресетами dispatcher/worker/reviewer/verifier",
  );
}

/* --- 9. Pending ------------------------------------------------------------- */
const pendingFile = path.join(project, ".kanban", ".watcher-pending.json");
const pending = exists(pendingFile) ? readJson(pendingFile) : null;
const pendingCount = pending && typeof pending === "object" ? Object.keys(pending).length : 0;
if (pendingCount === 0) add("ok", "pending", "недоставленных нарядов нет");
else add("warn", "pending", `${pendingCount} наряд(ов) ждут доставки`, "смотрите причины в событиях диагностики");

/* --- Отчёт ------------------------------------------------------------------ */
const summary = {
  ok: checks.filter((item) => item.level === "ok").length,
  warn: checks.filter((item) => item.level === "warn").length,
  fail: checks.filter((item) => item.level === "fail").length,
};

if (asJson) {
  console.log(JSON.stringify({ project, dshHome: DSH_HOME, checks, summary }, null, 2));
  process.exit(summary.fail > 0 ? 2 : summary.warn > 0 ? 1 : 0);
}

const marks = { ok: "✔", warn: "!", fail: "✘" };
const labels = { ok: "ok", warn: "warn", fail: "fail" };
console.log(`kanban doctor · ${project}`);
console.log(`DSH_HOME: ${DSH_HOME}`);
console.log("");
for (const item of checks) {
  console.log(`  ${marks[item.level]} ${labels[item.level].padEnd(4)}  ${item.name}: ${item.detail}`);
  if (item.fix && item.level !== "ok") console.log(`           → ${item.fix}`);
}
console.log("");
console.log(`Итог: ${summary.ok} ok, ${summary.warn} предупреждений, ${summary.fail} ошибок`);
process.exit(summary.fail > 0 ? 2 : summary.warn > 0 ? 1 : 0);
