/**
 * Тесты автостарта рабочего дня (`.kanban/autostart.json`).
 *
 * Запуск: node dsh-kanban/test/autostart.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { autostartConfig, runAutostart } from "../lib/autostart.js";

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

const SESSION = "6af8ff46-f3e7-4640-8a2d-045543fbc030";

function makeBoard(config) {
  const board = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-autostart-"));
  fs.mkdirSync(path.join(board, ".kanban"), { recursive: true });
  if (config) fs.writeFileSync(path.join(board, ".kanban", "autostart.json"), JSON.stringify(config));
  return board;
}

function makeCtx() {
  const calls = [];
  return {
    calls,
    sessionController: {
      prompt: async (request) => {
        calls.push(request);
        return { accepted: true };
      },
    },
  };
}

const quiet = () => {};

console.log("== автостарт: конфиг и время");
await check("нет конфига — пропуск", async () => {
  const board = makeBoard(null);
  const result = await runAutostart({}, { boards: [board], home: board, log: quiet });
  assert.equal(result.reason, "no-config");
  assert.equal(autostartConfig([board]), null);
});

await check("notBefore в будущем — не отправляет", async () => {
  const board = makeBoard({
    enabled: true,
    notBefore: "2026-11-20T00:00:00+03:00",
    sessions: [SESSION],
    text: "план",
  });
  const ctx = makeCtx();
  const result = await runAutostart(ctx, {
    boards: [board],
    home: board,
    log: quiet,
    now: Date.parse("2026-11-19T22:00:00+03:00"),
  });
  assert.equal(result.sent, 0);
  assert.equal(result.reason, "not-before");
  assert.equal(ctx.calls.length, 0);
});

await check("после notBefore — отправляет один раз и помнит день", async () => {
  const board = makeBoard({
    enabled: true,
    notBefore: "2026-11-20T00:00:00+03:00",
    sessions: [SESSION],
    text: "Начинай день",
  });
  const ctx = makeCtx();
  const now = Date.parse("2026-11-20T08:00:00+03:00");
  const first = await runAutostart(ctx, { boards: [board], home: board, log: quiet, now });
  assert.equal(first.sent, 1);
  assert.equal(ctx.calls.length, 1);
  assert.match(ctx.calls[0].content[0].text, /Начинай день/);

  const second = await runAutostart(ctx, { boards: [board], home: board, log: quiet, now: now + 60_000 });
  assert.equal(second.sent, 0);
  assert.equal(ctx.calls.length, 1);
});

await check("следующий день — снова отправляет", async () => {
  const board = makeBoard({
    enabled: true,
    sessions: [SESSION],
    text: "план",
  });
  const ctx = makeCtx();
  await runAutostart(ctx, { boards: [board], home: board, log: quiet, now: Date.parse("2026-11-20T08:00:00+03:00") });
  const next = await runAutostart(ctx, {
    boards: [board],
    home: board,
    log: quiet,
    now: Date.parse("2026-11-21T08:00:00+03:00"),
  });
  assert.equal(next.sent, 1);
  assert.equal(ctx.calls.length, 2);
});

await check("невалидный sessionId не отправляется", async () => {
  const board = makeBoard({
    enabled: true,
    sessions: ["executor-skills (DSH)"],
    text: "план",
  });
  const ctx = makeCtx();
  const result = await runAutostart(ctx, { boards: [board], home: board, log: quiet });
  assert.equal(result.sent, 0);
  assert.equal(ctx.calls.length, 0);
});

console.log(`\nвсего: ${passed} ok, ${failed} провал(ов)`);
process.exit(failed > 0 ? 1 : 0);
