/**
 * Тесты stale-watchdog (issue #4): карточка стоит, роль не двигает.
 *
 * Запуск: node dsh-kanban/test/stale.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { findStale, runStaleWatchdog } from "../lib/stale.js";

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

const WORKER = "6af8ff46-f3e7-4640-8a2d-045543fbc030";
const REVIEWER = "1a7e1a7e-1111-4000-8000-000000000002";
const VERIFIER = "2b7e2b7e-2222-4000-8000-000000000003";
const DISPATCHER = "3c7e3c7e-3333-4000-8000-000000000004";

const frame = (value) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(value) + "\n"));

function writeLog(home, sessionId, events) {
  const dir = path.join(home, "sessions", "--proj--", sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const header = { type: "session", version: 4, sessionId, cwd: "/proj", agentPreset: "worker" };
  fs.writeFileSync(
    path.join(dir, "session.v4.jsonl.zstd"),
    Buffer.concat([frame(header), ...events.map(frame)]),
  );
}

function makeBoard(home, { status = "in-progress", ageMinutes = 180 } = {}) {
  const board = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-stale-"));
  fs.mkdirSync(path.join(board, ".kanban", "tasks"), { recursive: true });
  const updated = new Date(Date.now() - ageMinutes * 60_000).toISOString();
  fs.writeFileSync(
    path.join(board, ".kanban", "tasks", "001.md"),
    [
      "---",
      'id: "001"',
      'title: "Экспорт QR"',
      `status: ${status}`,
      `owner: "${WORKER}"`,
      `updated: ${updated}`,
      "---",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(board, ".kanban", ".watcher-roles.json"),
    JSON.stringify({ worker: WORKER, reviewer: REVIEWER, verifier: VERIFIER, dispatcher: DISPATCHER }),
  );
  return { board, updated };
}

function deliverRecorder() {
  const calls = [];
  return {
    calls,
    deliver: async (item) => {
      calls.push(item);
      return { ok: true };
    },
  };
}

const quiet = () => {};

console.log("== stale-watchdog: поиск и доставка");
await check("мёртвая сессия — эскалация диспетчеру, без повтора", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-home-"));
  const { board } = makeBoard(home);
  const rec = deliverRecorder();
  const events = [];
  const options = {
    boards: [board],
    home,
    config: { stale: { enabled: true, minutes: 1 } },
    deliver: rec.deliver,
    diagEvent: (event) => events.push(event),
    log: quiet,
  };
  const first = await runStaleWatchdog({}, options);
  assert.equal(first.escalated, 1);
  assert.equal(rec.calls.length, 1);
  assert.equal(rec.calls[0].sessionId, DISPATCHER);
  assert.match(rec.calls[0].text, /мертва/);
  assert.ok(events.some((event) => event.step === "stale-escalated"));

  const second = await runStaleWatchdog({}, options);
  assert.equal(rec.calls.length, 1);
  assert.equal(second.escalated, 0);
});

await check("закрытый ход — напоминание роли, не эскалация", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-home-"));
  const { board } = makeBoard(home);
  writeLog(home, WORKER, [
    { type: "turn/start", seq: 1, time: Date.now() - 3600_000 },
    { type: "turn/end", seq: 2, time: Date.now() - 3599_000, data: { reason: { kind: "completed" } } },
  ]);
  const rec = deliverRecorder();
  const result = await runStaleWatchdog({}, {
    boards: [board],
    home,
    config: { stale: { enabled: true, minutes: 1 } },
    deliver: rec.deliver,
    diagEvent: quiet,
    log: quiet,
  });
  assert.equal(result.sent, 1);
  assert.equal(rec.calls[0].sessionId, WORKER);
  assert.match(rec.calls[0].text, /стоит в статусе/);
});

await check("работающая сессия (свежий открытый ход) не получает напоминание", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-home-"));
  const { board } = makeBoard(home);
  writeLog(home, WORKER, [
    { type: "turn/start", seq: 1, time: Date.now() - 60_000 },
    { type: "step/start", seq: 2, time: Date.now() - 30_000 },
  ]);
  const rec = deliverRecorder();
  const result = await runStaleWatchdog({}, {
    boards: [board],
    home,
    config: { stale: { enabled: true, minutes: 1 } },
    deliver: rec.deliver,
    diagEvent: quiet,
    log: quiet,
  });
  assert.equal(result.sent, 0);
  assert.equal(rec.calls.length, 0);
  const { skipped } = findStale({ boards: [board], home, settings: { minutes: 1, workingMinutes: 15, maxPerRun: 5 } });
  assert.ok(skipped.some((item) => item.reason === "working"));
});

await check("свежая карточка не считается стоящей", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-home-"));
  const { board } = makeBoard(home, { ageMinutes: 5 });
  const rec = deliverRecorder();
  const result = await runStaleWatchdog({}, {
    boards: [board],
    home,
    config: { stale: { enabled: true, minutes: 60 } },
    deliver: rec.deliver,
    diagEvent: quiet,
    log: quiet,
  });
  assert.equal(result.sent, 0);
  assert.equal(rec.calls.length, 0);
});

await check("выключенный stale ничего не шлёт", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-home-"));
  const { board } = makeBoard(home);
  const rec = deliverRecorder();
  const result = await runStaleWatchdog({}, {
    boards: [board],
    home,
    config: { stale: { enabled: false } },
    deliver: rec.deliver,
    diagEvent: quiet,
    log: quiet,
  });
  assert.equal(result.sent, 0);
  assert.equal(rec.calls.length, 0);
});

console.log(`\nвсего: ${passed} ok, ${failed} провал(ов)`);
process.exit(failed > 0 ? 1 : 0);
