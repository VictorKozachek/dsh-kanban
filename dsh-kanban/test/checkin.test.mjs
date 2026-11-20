/**
 * Тесты /checkin (issue #6/#087): отчёт по доске, «с прошлого раза», блокеры,
 * спящие todo и состояние между запусками.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCheckin } from "../lib/day-report.js";

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

function writeCard(board, id, status, extra = {}) {
  fs.writeFileSync(
    path.join(board, ".kanban", "tasks", `${id}.md`),
    [`---`, `id: "${id}"`, `title: Задача ${id}`, `status: ${status}`, `updated: "${extra.updated ?? "2026-11-20T08:00:00Z"}"`, extra.owner ? `owner: "${extra.owner}"` : "", extra.note ? `note: "${extra.note}"` : "", "---", ""].join("\n"),
  );
}

function board() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-checkin-"));
  fs.mkdirSync(path.join(dir, ".kanban", "tasks"), { recursive: true });
  return dir;
}

console.log("== checkin: отчёт");
check("сделано/в работе/todo/блокеры попадают в отчёт", () => {
  const dir = board();
  writeCard(dir, "001", "merged", { updated: "2026-11-19T10:00:00Z" });
  writeCard(dir, "002", "in-progress", { owner: "session-a" });
  writeCard(dir, "003", "todo");
  writeCard(dir, "004", "blocked", { note: "ждём доступ" });
  const report = runCheckin([dir], { now: Date.parse("2026-11-20T09:00:00Z") });
  assert.match(report.markdown, /#001/);
  assert.match(report.markdown, /#002/);
  assert.match(report.markdown, /#003/);
  assert.match(report.markdown, /#004.*ждём доступ/);
  assert.ok(fs.existsSync(report.file), "отчёт не записан");
});

check("повторный запуск не повторяет «сделано»", () => {
  const dir = board();
  writeCard(dir, "001", "merged", { updated: "2026-11-19T10:00:00Z" });
  runCheckin([dir], { now: Date.parse("2026-11-20T09:00:00Z") });
  const second = runCheckin([dir], { now: Date.parse("2026-11-20T10:00:00Z") });
  assert.doesNotMatch(second.markdown, /сделано с прошлого раза: #001/);
});

check("спящий todo старше суток отмечен", () => {
  const dir = board();
  writeCard(dir, "005", "todo", { updated: "2026-11-18T09:00:00Z" });
  const report = runCheckin([dir], { now: Date.parse("2026-11-20T09:00:00Z") });
  assert.match(report.markdown, /спящие todo.*#005/);
});

console.log(`\nвсего: ${passed} ok, ${failed} провал(ов)`);
process.exit(failed > 0 ? 1 : 0);
