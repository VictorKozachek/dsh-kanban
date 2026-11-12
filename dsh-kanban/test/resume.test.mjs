/**
 * Тесты авто-возврата прерванных сессий (issue #4).
 *
 * Запуск: node dsh-kanban/test/resume.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { collectInterrupted, resumeInterruptedSessions } from "../lib/resume.js";
import { openTurnOf } from "../lib/session-log.js";

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

const UUID_A = "6af8ff46-f3e7-4640-8a2d-045543fbc030";
const UUID_B = "1a7e1a7e-1111-4000-8000-000000000002";

function frame(value) {
  return zlib.zstdCompressSync(Buffer.from(JSON.stringify(value) + "\n"));
}

function writeLog(home, sessionId, events, headerExtra = {}) {
  const dir = path.join(home, "sessions", "--proj--", sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const header = { type: "session", version: 4, sessionId, cwd: "/proj", agentPreset: "worker", ...headerExtra };
  const chunks = [frame(header), ...events.map((event) => frame(event))];
  fs.writeFileSync(path.join(dir, "session.v4.jsonl.zstd"), Buffer.concat(chunks));
}

function makeBoard(home) {
  const board = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-resume-"));
  fs.mkdirSync(path.join(board, ".kanban", "tasks"), { recursive: true });
  fs.writeFileSync(
    path.join(board, ".kanban", "tasks", "001.md"),
    ['---', 'id: "001"', 'title: "Экспорт QR"', 'status: in-progress', `owner: "${UUID_A}"`, '---', ''].join("\n"),
  );
  fs.writeFileSync(path.join(board, ".kanban", ".watcher-roles.json"), JSON.stringify({ worker: UUID_A, reviewer: UUID_B }));
  return board;
}

function interruptedEvents(now, extra = []) {
  return [
    { type: "turn/start", seq: 1, time: now - 300_000, data: { turn: 1 } },
    { type: "step/start", seq: 2, time: now - 299_000, data: { turn: 1, step: 1 } },
    { type: "tool/call", seq: 3, time: now - 298_000, data: { name: "bash", callId: "call-1" } },
    ...extra,
  ];
}

function completeEvents(now) {
  return [
    { type: "turn/start", seq: 1, time: now - 300_000, data: { turn: 1 } },
    { type: "step/start", seq: 2, time: now - 299_000, data: { turn: 1, step: 1 } },
    { type: "turn/end", seq: 3, time: now - 298_000, data: { turn: 1, reason: { kind: "completed" } } },
  ];
}

function makeCtx(failure = null) {
  const calls = [];
  return {
    calls,
    sessionController: {
      prompt: async (request) => {
        if (failure) throw new Error(failure);
        calls.push(request);
        return { accepted: true };
      },
    },
  };
}

const quiet = () => {};

console.log("== авто-возврат: поиск открытых ходов");
await check("находит сессию с открытым ходом и активной карточкой", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-home-"));
  const board = makeBoard(home);
  const now = Date.now();
  writeLog(home, UUID_A, interruptedEvents(now));
  writeLog(home, UUID_B, completeEvents(now));
  const { candidates, skipped } = collectInterrupted({
    boards: [board],
    home,
    settings: { maxAgeHours: 12, minAgeSeconds: 1, maxSessions: 5 },
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].sessionId, UUID_A);
  assert.equal(candidates[0].card?.id, "001");
  assert.ok(skipped.some((item) => item.reason === "no-open-turn"));
});

await check("старый и слишком свежий ход не считаются прерванными", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-home-"));
  const board = makeBoard(home);
  const now = Date.now();
  writeLog(home, UUID_A, interruptedEvents(now - 13 * 3600 * 1000));
  const old = collectInterrupted({ boards: [board], home, settings: { maxAgeHours: 12, minAgeSeconds: 1, maxSessions: 5 } });
  assert.equal(old.candidates.length, 0, JSON.stringify({ candidates: old.candidates, skipped: old.skipped }));
  assert.ok(old.skipped.some((item) => item.reason === "too-old"), JSON.stringify(old.skipped));

  const freshHome = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-home-"));
  const freshBoard = makeBoard(freshHome);
  writeLog(freshHome, UUID_A, [
    { type: "turn/start", seq: 1, time: now - 20_000, data: { turn: 1 } },
    { type: "step/start", seq: 2, time: now - 10_000, data: { turn: 1, step: 1 } },
  ]);
  const fresh = collectInterrupted({ boards: [freshBoard], home: freshHome, settings: { maxAgeHours: 12, minAgeSeconds: 60, maxSessions: 5 } });
  assert.equal(fresh.candidates.length, 0);
  assert.ok(fresh.skipped.some((item) => item.reason === "too-fresh"));
});

await check("openTurnOf: turn/end закрывает ход", async () => {
  const now = Date.now();
  assert.equal(openTurnOf(interruptedEvents(now)), true);
  assert.equal(openTurnOf(completeEvents(now)), false);
});

console.log("== авто-возврат: отправка и дедуп");
await check("prompt уходит один раз и ход больше не будится", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-home-"));
  const board = makeBoard(home);
  const now = Date.now();
  writeLog(home, UUID_A, interruptedEvents(now));
  const ctx = makeCtx();
  const events = [];
  const options = {
    boards: [board],
    home,
    config: { resume: { minAgeSeconds: 1, maxHours: 12, maxSessions: 5 } },
    diagEvent: (event) => events.push(event),
    log: quiet,
  };
  const first = await resumeInterruptedSessions(ctx, options);
  assert.equal(first.sent, 1);
  assert.equal(ctx.calls.length, 1);
  assert.match(ctx.calls[0].content[0].text, /перезапускался/);
  assert.match(ctx.calls[0].content[0].text, /#001/);
  assert.ok(events.some((event) => event.step === "resume-sent"));

  const second = await resumeInterruptedSessions(ctx, options);
  assert.equal(second.sent, 0);
  assert.equal(ctx.calls.length, 1);
  assert.ok(events.some((event) => event.step === "resume-skipped" && event.reason === "already-resumed"));
});

await check("выключенный resume не отправляет prompt", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-home-"));
  const board = makeBoard(home);
  writeLog(home, UUID_A, interruptedEvents(Date.now()));
  const ctx = makeCtx();
  const result = await resumeInterruptedSessions(ctx, {
    boards: [board],
    home,
    config: { resume: { enabled: false } },
    diagEvent: quiet,
    log: quiet,
  });
  assert.equal(result.sent, 0);
  assert.equal(ctx.calls.length, 0);
});

await check("ошибка prompt не роняет скан", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-home-"));
  const board = makeBoard(home);
  writeLog(home, UUID_A, interruptedEvents(Date.now()));
  const ctx = makeCtx("session not found");
  const events = [];
  const result = await resumeInterruptedSessions(ctx, {
    boards: [board],
    home,
    config: { resume: { minAgeSeconds: 1 } },
    diagEvent: (event) => events.push(event),
    log: quiet,
  });
  assert.equal(result.sent, 0);
  assert.equal(result.failed, 1);
  assert.ok(events.some((event) => event.step === "resume-failed"));
});

console.log(`\nвсего: ${passed} ok, ${failed} провал(ов)`);
process.exit(failed > 0 ? 1 : 0);
