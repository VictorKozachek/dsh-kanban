/**
 * Тесты офлайн-смены пресета сессии (#064, спека 006).
 *
 * Инструмент работает при закрытом DSH: читает `session.v4.jsonl.zstd`
 * (конкатенация zstd-кадров, один JSON-объект на строку), досыпает ОДИН кадр с
 * событием `agent-preset/selected` и обновляет карту ролей доски. Поэтому тесты
 * поднимают временный `DSH_HOME` на диске и проверяют ровно то, что увидит
 * пользователь и DSH после перезапуска:
 *
 * - декодирование (и на «чужих» байтах — захардкоженный кадр), проекция пресета,
 *   `seq`, открытый ход, оборванный хвост;
 * - досыпание: один новый кадр, оригинальные кадры байт-в-байт на месте;
 * - dry-run ничего не меняет, бэкап создаётся, `--restore` возвращает файл;
 * - отказы: DSH держит сессию (flock), неизвестный пресет, битый лог, не v4,
 *   открытый ход (только без `--force`);
 * - карта ролей: обновляется ролью пресета или `--role`, `--no-roles` не трогает,
 *   `standard` снимает запись сессии;
 * - CLI-поведение: `--list`/`--json`, `--cwd`/`--all`/`--from`, коды 0/1/2.
 *
 * Запуск: node dsh-kanban/test/session-preset.test.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import {
  BACKUP_DIR,
  LOG_FILE,
  LOG_VERSION,
  ROLES,
  appendEventFrame,
  boardForCwd,
  decodeLog,
  discoverSessions,
  dshHome,
  encodeEventFrame,
  knownPresets,
  lastSeqOf,
  main,
  openTurnOf,
  parseArgs,
  presetOf,
  readLog,
  readRoleMap,
  restoreLog,
  roleOfPreset,
  sessionLockHeld,
  splitFrames,
  writeRoleMap,
} from "../../bin/session-preset.mjs";

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

const work = fs.mkdtempSync(path.join(os.tmpdir(), "session-preset-"));
const home = path.join(work, "dsh");
const repoRoot = path.join(work, "repo");
fs.mkdirSync(path.join(repoRoot, "presets"), { recursive: true });

/** Кадр zstd, как у DSH: контрольная сумма включена. */
function frame(text) {
  return zlib.zstdCompressSync(Buffer.from(`${text}\n`, "utf8"), {
    params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
  });
}

/** Захардкоженный лог из ЧУЖИХ байтов: заголовок + turn/start + turn/end. */
const FIXTURE_B64 =
  "KLUv/SRtzQIAYkUSGICpbfhGlPuMBUVNIRaMtlI3QiWxhWWME4CGMQ/R7V6fhUU/nMuYlwzkQCxRGJegeAn4vadx2cwsgMc1KPmEyygd1auLfyzWjAQABCEGRgXsc6G2RQx3wFOLKLUv/SQ5yQEAeyJ0eXBlIjoidHVybi9zdGFydCIsInNlcSI6MCwidGltZSI6MiwiZGF0YSI6eyJ0dXJuIjoxfX0KhZtBWii1L/0kRzkCAHsidHlwZSI6InR1cm4vZW5kIiwic2VxIjoxLCJ0aW1lIjozLCJkYXRhIjp7InR1cm4iOjEsInJlYXNvbiI6ImRvbmUifX0KDdPC+w==";

/** Собрать v4-лог сессии на диске. */
function writeSession(options = {}) {
  const id = options.id ?? "session-aaaa0001";
  const cwd = options.cwd ?? path.join(work, "board");
  const preset = options.preset ?? "standard";
  const events = [{ type: "turn/start", seq: 0, time: 2, data: { turn: 1 } }];
  let seq = 1;
  if (preset !== "standard") {
    events.push({ type: "agent-preset/selected", seq, time: 3, data: { agentPreset: preset } });
    seq += 1;
  }
  events.push({ type: "turn/end", seq, time: 4, data: { turn: 1, reason: "done" } });
  seq += 1;
  if (options.openTurn) events.push({ type: "turn/start", seq, time: 5, data: { turn: 2 } });
  const dir = path.join(home, "sessions", `--${cwd.replaceAll("/", "-")}--`, id);
  fs.mkdirSync(dir, { recursive: true });
  const header = { type: "session", version: options.version ?? LOG_VERSION, id, createdAt: 1, cwd, agentPreset: "standard" };
  const chunks = [frame(JSON.stringify(header)), ...events.map((event) => frame(JSON.stringify(event)))];
  if (options.stray) chunks.push(options.stray);
  const file = path.join(dir, LOG_FILE);
  fs.writeFileSync(file, Buffer.concat(chunks));
  fs.writeFileSync(path.join(dir, "session.lock"), "");
  return { id, cwd, dir, file, events, preset };
}

/** Захватить вывод CLI. */
function capture() {
  const out = [];
  const err = [];
  const stream = (bucket) => ({
    write(chunk) {
      bucket.push(String(chunk));
      return true;
    },
  });
  return {
    io: { out: stream(out), err: stream(err), stdin: { isTTY: false, on() {}, off() {} } },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

/** Запустить CLI так, как это делает bin/session-preset.sh. */
async function run(argv, extra = {}) {
  const captured = capture();
  const code = await main(argv, { ...captured.io, env: { DSH_HOME: home }, repoRoot, ...extra });
  return { code, out: captured.out(), err: captured.err(), io: captured.io };
}

const sha = (file) => String(fs.statSync(file).size) + ":" + fs.readFileSync(file).toString("base64").length;
const bytes = (file) => fs.readFileSync(file);

console.log("== декодирование лога: чужие байты, кадры, проекция пресета");

check("захардкоженный лог из чужих байтов декодируется", () => {
  const log = decodeLog(Buffer.from(FIXTURE_B64, "base64"));
  assert.deepEqual(log.problems, []);
  assert.equal(log.header.type, "session");
  assert.equal(log.header.version, 4);
  assert.equal(log.header.cwd, "/tmp/board");
  assert.equal(log.events.length, 2);
  assert.equal(log.torn, 0);
  assert.equal(lastSeqOf(log.events), 1);
  assert.equal(presetOf(log.header, log.events), "standard");
  assert.equal(openTurnOf(log.events), false);
});

check("кадры считаются по границам, а хвост распознаётся как оборванный", () => {
  const buffer = Buffer.from(FIXTURE_B64, "base64");
  const { frames, torn } = splitFrames(buffer);
  assert.equal(frames.length, 3);
  assert.equal(torn, 0);
  const damaged = Buffer.concat([buffer, Buffer.from("\x28\xb5\x2f\x70", "latin1")]);
  const split = splitFrames(damaged);
  assert.equal(split.frames.length, 3);
  assert.ok(split.torn > 0, "оборванный кадр не распознан");
  const log = decodeLog(damaged);
  assert.equal(log.torn > 0, true);
  assert.equal(log.events.length, 2, "валидные кадры должны читаться и при оборванном хвосте");
});

check("проекция пресета: последнее событие побеждает заголовок", () => {
  const header = { type: "session", version: 4, agentPreset: "standard" };
  const events = [
    { type: "agent-preset/selected", seq: 1, time: 1, data: { agentPreset: "worker" } },
    { type: "agent-preset/selected", seq: 2, time: 2, data: { agentPreset: "reviewer" } },
  ];
  assert.equal(presetOf(header, events), "reviewer");
  assert.equal(presetOf(header, []), "standard");
});

check("открытый ход: turn/start после turn/end", () => {
  assert.equal(openTurnOf([{ type: "turn/start", seq: 0 }, { type: "turn/end", seq: 1 }]), false);
  assert.equal(openTurnOf([{ type: "turn/start", seq: 0 }, { type: "turn/end", seq: 1 }, { type: "turn/start", seq: 2 }]), true);
  assert.equal(openTurnOf([{ type: "turn/start", seq: 0 }]), true);
});

console.log("== досыпание события: один кадр, оригинальные кадры на месте");

check("appendEventFrame досыпает ровно один кадр и не трогает прежние", () => {
  const session = writeSession({ id: "session-append01" });
  const before = bytes(session.file);
  appendEventFrame(session.file, { type: "agent-preset/selected", seq: 99, time: Date.now(), data: { agentPreset: "worker" } });
  const after = bytes(session.file);
  assert.ok(after.length > before.length);
  assert.ok(after.subarray(0, before.length).equals(before), "оригинальные кадры переписаны");
  const log = decodeLog(after);
  assert.deepEqual(log.problems, []);
  assert.equal(log.frames.length, 4);
  assert.equal(log.events.length, 3);
  const last = log.events[2];
  assert.equal(last.type, "agent-preset/selected");
  assert.equal(last.seq, 99);
  assert.equal(last.data.agentPreset, "worker");
});

check("кадр проходит независимую проверку zstd (zlib) и seq идёт от lastSeq+1", () => {
  const session = writeSession({ id: "session-append02" });
  const log = readLog(session.file);
  const next = lastSeqOf(log.events) + 1;
  const encoded = encodeEventFrame({ type: "agent-preset/selected", seq: next, time: 10, data: { agentPreset: "reviewer" } });
  const decoded = zlib.zstdDecompressSync(encoded).toString("utf8").trim();
  assert.equal(JSON.parse(decoded).seq, next);
});

console.log("== карта ролей: роль из пресета, --role, standard снимает запись");

check("роль по пресету: четыре роли и префикс preset-", () => {
  for (const role of ROLES) assert.equal(roleOfPreset(role), role);
  assert.equal(roleOfPreset("preset-worker"), "worker");
  assert.equal(roleOfPreset("standard"), null);
});

check("знакомые пресеты: JSON из репозитория или встроенный список", () => {
  const fallback = knownPresets(path.join(work, "no-presets"));
  assert.deepEqual(fallback.ids, ["standard", ...ROLES]);
  fs.writeFileSync(path.join(repoRoot, "presets", "role-presets.json"), JSON.stringify([{ id: "standard" }, { id: "worker" }, { id: "auditor" }]));
  const fromFile = knownPresets(repoRoot);
  assert.deepEqual(fromFile.ids, ["standard", "worker", "auditor"]);
  fs.rmSync(path.join(repoRoot, "presets", "role-presets.json"));
});

check("карта ролей обновляется, порядок ключей как у сторожа", () => {
  const board = path.join(work, "board-roles");
  fs.mkdirSync(path.join(board, ".kanban"), { recursive: true });
  fs.writeFileSync(path.join(board, ".kanban", ".watcher-roles.json"), `${JSON.stringify({ reviewer: "session-old", custom: "session-x" }, null, 2)}\n`);
  const result = writeRoleMap(board, "session-me", "worker");
  assert.equal(result.changed, true);
  assert.deepEqual(readRoleMap(board), { worker: "session-me", reviewer: "session-old", custom: "session-x" });
  const text = fs.readFileSync(result.file, "utf8");
  assert.ok(text.endsWith("\n"));
  const keys = Object.keys(JSON.parse(text));
  assert.deepEqual(keys, ["worker", "reviewer", "custom"]);
});

check("смена роли снимает сессию со старой роли; standard убирает запись", () => {
  const board = path.join(work, "board-roles2");
  fs.mkdirSync(path.join(board, ".kanban"), { recursive: true });
  writeRoleMap(board, "session-me", "reviewer");
  assert.deepEqual(readRoleMap(board), { reviewer: "session-me" });
  writeRoleMap(board, "session-me", "worker");
  assert.deepEqual(readRoleMap(board), { worker: "session-me" });
  const cleared = writeRoleMap(board, "session-me", null);
  assert.deepEqual(readRoleMap(board), {});
  assert.equal(cleared.changed, true);
});

check("доска находится по cwd сессии (ближайший родитель с .kanban)", () => {
  const board = path.join(work, "board-nested");
  fs.mkdirSync(path.join(board, "worktrees", "064", ".kanban"), { recursive: true });
  fs.mkdirSync(path.join(board, ".kanban"), { recursive: true });
  assert.equal(boardForCwd(path.join(board, "worktrees", "064")), path.join(board, "worktrees", "064"));
  assert.equal(boardForCwd(path.join(board, "worktrees", "064", "src")), path.join(board, "worktrees", "064"));
  assert.equal(boardForCwd(path.join(work, "no-board")), null);
});

console.log("== CLI: dry-run, запись, бэкап, восстановление");

await checkAsync("dry-run печатает план и не меняет файл", async () => {
  const session = writeSession({ id: "session-dry001", preset: "standard" });
  const before = bytes(session.file);
  const run1 = await run(["--session", "dry001", "--to", "worker", "--dry-run", "--yes"]);
  assert.equal(run1.code, 0, run1.err);
  assert.match(run1.out, /dry-run/);
  assert.match(run1.out, /standard → worker/);
  assert.ok(bytes(session.file).equals(before), "dry-run изменил лог");
  assert.equal(fs.existsSync(path.join(home, BACKUP_DIR)), false, "dry-run создал бэкап");
});

await checkAsync("реальная смена: событие в логе, бэкап, карта ролей", async () => {
  const session = writeSession({ id: "session-real001", preset: "standard", cwd: path.join(work, "board-real") });
  fs.mkdirSync(path.join(work, "board-real", ".kanban"), { recursive: true });
  const before = bytes(session.file);
  const result = await run(["--session", "real001", "--to", "worker", "--yes"]);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /перезапустите DSH/);
  const after = bytes(session.file);
  assert.ok(after.subarray(0, before.length).equals(before), "оригинальные кадры переписаны");
  const log = decodeLog(after);
  assert.deepEqual(log.problems, []);
  const last = log.events[log.events.length - 1];
  assert.equal(last.type, "agent-preset/selected");
  assert.equal(last.seq, lastSeqOf(log.events), "seq не монотонен");
  assert.equal(last.data.agentPreset, "worker");
  assert.equal(presetOf(log.header, log.events), "worker");
  const backups = fs.readdirSync(path.join(home, BACKUP_DIR));
  const backup = backups.find((name) => name.startsWith("session-real001."));
  assert.ok(backup, "бэкап не создан");
  assert.ok(bytes(path.join(home, BACKUP_DIR, backup)).equals(before), "бэкап не равен исходному логу");
  assert.deepEqual(readRoleMap(path.join(work, "board-real")), { worker: "session-real001" });
});

await checkAsync("--no-roles не трогает карту ролей", async () => {
  const board = path.join(work, "board-noroles");
  fs.mkdirSync(path.join(board, ".kanban"), { recursive: true });
  writeSession({ id: "session-norole1", preset: "standard", cwd: board });
  const result = await run(["--session", "norole1", "--to", "worker", "--no-roles", "--yes"]);
  assert.equal(result.code, 0, result.err);
  assert.equal(fs.existsSync(path.join(board, ".kanban", ".watcher-roles.json")), false, "--no-roles создал карту");
});

await checkAsync("--role задаёт роль явно, пресет вне ролей снимает запись", async () => {
  const board = path.join(work, "board-explicit");
  fs.mkdirSync(path.join(board, ".kanban"), { recursive: true });
  writeSession({ id: "session-explic1", preset: "standard", cwd: board });
  const first = await run(["--session", "explic1", "--to", "worker", "--role", "reviewer", "--yes"]);
  assert.equal(first.code, 0, first.err);
  assert.deepEqual(readRoleMap(board), { reviewer: "session-explic1" });
  const second = await run(["--session", "explic1", "--to", "standard", "--yes"]);
  assert.equal(second.code, 0, second.err);
  assert.deepEqual(readRoleMap(board), {}, "standard не снял запись сессии");
});

await checkAsync("--restore возвращает лог из бэкапа", async () => {
  const session = writeSession({ id: "session-rest001", preset: "standard" });
  const before = bytes(session.file);
  const applied = await run(["--session", "rest001", "--to", "worker", "--yes"]);
  assert.equal(applied.code, 0, applied.err);
  assert.notEqual(bytes(session.file).toString("base64"), before.toString("base64"));
  const backup = fs
    .readdirSync(path.join(home, BACKUP_DIR))
    .filter((name) => name.startsWith("session-rest001."))
    .map((name) => path.join(home, BACKUP_DIR, name))
    .find((file) => !file.includes(".pre-restore"));
  const restored = await run(["--restore", backup]);
  assert.equal(restored.code, 0, restored.err);
  assert.ok(bytes(session.file).equals(before), "restore не вернул исходный файл");
  assert.match(restored.out, /перезапустите DSH/);
});

await checkAsync("--restore несуществующего бэкапа — код 1", async () => {
  const result = await run(["--restore", path.join(work, "no-such-backup.zst")]);
  assert.equal(result.code, 1);
  assert.match(result.err, /не найден/);
});

console.log("== отказы: DSH занят, неизвестный пресет, битый лог, открытый ход");

await checkAsync("живой flock на session.lock — отказ, файл не меняется", async () => {
  const session = writeSession({ id: "session-lock01", preset: "standard" });
  const lockPath = path.join(session.dir, "session.lock");
  const holder = spawn("python3", [
    "-c",
    "import fcntl,sys,time\nhandle=open(sys.argv[1],'r+')\nfcntl.flock(handle, fcntl.LOCK_EX|fcntl.LOCK_NB)\nprint('ok', flush=True)\ntime.sleep(10)",
    lockPath,
  ]);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("держатель лока не стартовал")), 3000);
      holder.stdout.once("data", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    const status = sessionLockHeld(lockPath);
    assert.equal(status.held, true, "flock не виден");
    const before = bytes(session.file);
    const result = await run(["--session", "lock01", "--to", "worker", "--yes"]);
    assert.equal(result.code, 1, "смена прошла при живом DSH");
    assert.match(result.err, /DSH держит сессию/);
    assert.ok(bytes(session.file).equals(before), "файл изменён при живом DSH");
  } finally {
    holder.kill("SIGKILL");
  }
});

await checkAsync("неизвестный пресет — отказ, --allow-unknown разрешает", async () => {
  writeSession({ id: "session-unk001", preset: "standard" });
  const refused = await run(["--session", "unk001", "--to", "ghost", "--yes"]);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /неизвестен/);
  const allowed = await run(["--session", "unk001", "--to", "ghost", "--allow-unknown", "--dry-run", "--yes"]);
  assert.equal(allowed.code, 0, allowed.err);
  assert.match(allowed.out, /ghost/);
});

await checkAsync("не v4 — отказ", async () => {
  writeSession({ id: "session-v3-001", preset: "standard", version: 3 });
  const result = await run(["--session", "v3-001", "--to", "worker", "--yes"]);
  assert.equal(result.code, 1);
  assert.match(result.err, /формат лога|v4/);
});

await checkAsync("битая строка в логе — отказ", async () => {
  const session = writeSession({ id: "session-bad001", preset: "standard" });
  const damaged = Buffer.concat([bytes(session.file), frame("{не json")]);
  fs.writeFileSync(session.file, damaged);
  const result = await run(["--session", "bad001", "--to", "worker", "--yes"]);
  assert.equal(result.code, 1);
  assert.ok(bytes(session.file).equals(damaged), "битый лог всё равно переписали");
});

await checkAsync("открытый ход — отказ без --force, проходит с --force", async () => {
  const session = writeSession({ id: "session-open01", preset: "standard", openTurn: true });
  const before = bytes(session.file);
  const refused = await run(["--session", "open01", "--to", "worker", "--yes"]);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /открытый ход/);
  assert.ok(bytes(session.file).equals(before));
  const forced = await run(["--session", "open01", "--to", "worker", "--force", "--yes"]);
  assert.equal(forced.code, 0, forced.err);
  assert.ok(bytes(session.file).length > before.length);
});

console.log("== CLI: --list, --json, --cwd, --all, коды аргументов");

await checkAsync("--list показывает сессии, --json разбирается", async () => {
  const listed = await run(["--list"]);
  assert.equal(listed.code, 0, listed.err);
  assert.match(listed.out, /session-real001/);
  assert.match(listed.out, /пресет:/);
  const json = await run(["--list", "--json"]);
  const rows = JSON.parse(json.out);
  const row = rows.find((item) => item.id === "session-real001");
  assert.ok(row, "сессия не попала в --json");
  assert.equal(row.preset, "worker");
  assert.equal(typeof row.lastSeq, "number");
  assert.equal(row.lock, "free");
});

await checkAsync("--cwd фильтрует по каталогу и вложенным", async () => {
  const board = path.join(work, "board-cwd");
  fs.mkdirSync(path.join(board, "worktrees", "064"), { recursive: true });
  writeSession({ id: "session-cwd001", preset: "standard", cwd: path.join(board, "worktrees", "064") });
  writeSession({ id: "session-cwd002", preset: "standard", cwd: path.join(work, "board-other") });
  const result = await run(["--cwd", board, "--from", "standard", "--to", "worker", "--dry-run", "--yes"]);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /session-cwd001/);
  assert.doesNotMatch(result.out, /session-cwd002/);
});

await checkAsync("--all --from меняет только совпавшие и пропускает остальные", async () => {
  // Общий home содержит и «сломанные» фикстуры других проверок, поэтому здесь
  // важен не код, а состав плана: совпавшая сессия — в плане, остальные — пропущены.
  const result = await run(["--all", "--from", "worker", "--to", "reviewer", "--dry-run", "--yes"]);
  assert.ok(result.code === 0 || result.code === 1, result.err);
  assert.match(result.out, /session-real001/);
  assert.match(result.out, /пропущена/);
});

await checkAsync("массовая смена: обе сессии получают событие", async () => {
  // Своя доска, чтобы массовый прогон не задевал фикстуры других проверок.
  const massBoard = path.join(work, "board-mass");
  fs.mkdirSync(massBoard, { recursive: true });
  const first = writeSession({ id: "session-mass001", preset: "worker", cwd: massBoard });
  const second = writeSession({ id: "session-mass002", preset: "worker", cwd: massBoard });
  const result = await run(["--cwd", massBoard, "--from", "worker", "--to", "reviewer", "--no-roles", "--yes"]);
  assert.equal(result.code, 0, result.err);
  for (const session of [first, second]) {
    const log = readLog(session.file);
    assert.equal(presetOf(log.header, log.events), "reviewer");
  }
});

await checkAsync("ошибки аргументов — код 2", async () => {
  const cases = [
    [],
    ["--session", "x"],
    ["--session", "x", "--cwd", work, "--to", "worker"],
    ["--session", "x", "--to", "worker", "--role", "boss"],
    ["--frobnicate"],
    ["--list", "--to", "worker"],
  ];
  for (const argv of cases) {
    const result = await run(argv);
    assert.equal(result.code, 2, `код для ${JSON.stringify(argv)}: ${result.code}`);
  }
  const parsed = parseArgs(["--session", "x", "--to", "worker"]);
  assert.equal(parsed.ok, true);
  assert.equal(parseArgs(["--session", "x"]).ok, false);
});

await checkAsync("без --yes в неинтерактивном режиме отказ (код 2), с TTY подтверждение работает", async () => {
  writeSession({ id: "session-tty0001", preset: "standard" });
  const refused = await run(["--session", "tty0001", "--to", "worker"]);
  assert.equal(refused.code, 2);
  assert.match(refused.err, /--yes/);
  const answered = await run(["--session", "tty0001", "--to", "worker"], {
    stdin: { isTTY: true, on(event, handler) { if (event === "data") handler("y\n"); }, off() {} },
  });
  assert.equal(answered.code, 0, answered.err);
  assert.match(answered.out, /Изменить пресет/);
});

console.log("== обнаружение сессий и DSH_HOME");

check("DSH_HOME уважается, иначе ~/.dsh; сессии находятся по v4-логу", () => {
  assert.equal(dshHome({ DSH_HOME: home }), path.resolve(home));
  assert.equal(dshHome({}), path.join(os.homedir(), ".dsh"));
  const found = discoverSessions(home);
  assert.ok(found.length >= 5);
  assert.ok(found.every((session) => fs.existsSync(session.file)));
  assert.ok(found.some((session) => session.id === "session-real001"));
});

check("объект decodeLog не падает на пустом файле и на мусоре", () => {
  const empty = decodeLog(Buffer.alloc(0));
  assert.ok(empty.problems.length > 0);
  const garbage = decodeLog(Buffer.from("совсем не лог"));
  assert.ok(garbage.torn > 0 || garbage.problems.length > 0);
  assert.equal(garbage.header, null);
});

fs.rmSync(work, { recursive: true, force: true });

console.log(`\nвсего: ${passed} ok, ${failed} провал(ов)`);
process.exit(failed > 0 ? 1 : 0);
