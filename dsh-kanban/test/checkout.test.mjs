/** Тесты /checkout (#088): git-гигиена, блокеры и финальный вердикт. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCheckout } from "../lib/day-report.js";

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

function repo(status = "merged") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-checkout-"));
  fs.mkdirSync(path.join(dir, ".kanban", "tasks"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".kanban", "tasks", "001.md"), `---\nid: "001"\ntitle: Задача\nstatus: ${status}\nupdated: "2026-11-20T08:00:00Z"\n---\n`);
  fs.writeFileSync(path.join(dir, ".gitignore"), ".kanban/.checkout/\n");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}

console.log("== checkout: вердикт");
check("чистое дерево без блокеров — можно выключать", () => {
  const dir = repo("merged");
  const report = runCheckout([dir], { now: Date.parse("2026-11-20T20:00:00Z") });
  assert.equal(report.canShutdown, true);
  assert.match(report.markdown, /МОЖНО ВЫКЛЮЧАТЬ КОМПЬЮТЕР/);
});

check("незакоммиченные изменения — выключать нельзя", () => {
  const dir = repo("merged");
  fs.writeFileSync(path.join(dir, "dirty.txt"), "x");
  const report = runCheckout([dir], { now: Date.parse("2026-11-20T20:00:00Z") });
  assert.equal(report.canShutdown, false);
  assert.match(report.markdown, /незакоммичено/);
});

check("блокер — выключать нельзя", () => {
  const dir = repo("blocked");
  const report = runCheckout([dir], { now: Date.parse("2026-11-20T20:00:00Z") });
  assert.equal(report.canShutdown, false);
  assert.match(report.markdown, /блокеры/);
});

console.log(`\nвсего: ${passed} ok, ${failed} провал(ов)`);
process.exit(failed > 0 ? 1 : 0);
