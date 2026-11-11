/**
 * Тесты `bin/doctor`: успешный проект и «пусто» (нет доски/профиля).
 *
 * Запуск: node dsh-kanban/test/doctor.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DOCTOR = path.resolve(import.meta.dirname, "..", "..", "bin", "doctor.mjs");
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

const UUID = "6af8ff46-f3e7-4640-8a2d-045543fbc030";

function makeWorld({ broken = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-doctor-"));
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  const tasks = path.join(project, ".kanban", "tasks");
  fs.mkdirSync(tasks, { recursive: true });
  fs.writeFileSync(
    path.join(tasks, "001.md"),
    ['---', 'id: "001"', 'title: Проба', 'status: todo', 'owner: ""', '---', ''].join("\n"),
  );
  fs.writeFileSync(path.join(tasks, "README.md"), "# Карточки\n");
  fs.mkdirSync(path.join(project, "bin"), { recursive: true });
  for (const name of ["task-new.sh", "task-move.sh", "task-commit.sh", "board-status.sh", "node.sh"]) {
    fs.writeFileSync(path.join(project, "bin", name), "#!/bin/bash\n");
  }
  fs.writeFileSync(path.join(project, "AGENTS.md"), "# правила\n");
  fs.writeFileSync(path.join(project, ".kanban", ".watcher-roles.json"), JSON.stringify({ worker: UUID }));
  const git = (...args) =>
    spawnSync("git", ["-C", project, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  git("init", "-q");
  git("config", "user.email", "doctor@test");
  git("config", "user.name", "doctor");
  git("add", "-A");
  git("commit", "-qm", "init");

  fs.mkdirSync(path.join(home, "profiles", "desktop"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "profiles", "desktop", "package.json"),
    JSON.stringify({ name: "desktop", dependencies: { "dsh-kanban": "link:x" }, dsh: { profile: { bundles: ["dsh-kanban"] } } }),
  );
  fs.writeFileSync(path.join(home, "cordis.patch.yml"), `- id: ui-kanban\n  config:\n    boards:\n      - ${project}\n`);
  fs.mkdirSync(path.join(home, "sessions", "--project--", UUID), { recursive: true });
  const diag = path.join(root, "diag.json");
  fs.writeFileSync(
    diag,
    JSON.stringify({
      pid: process.pid,
      heartbeatAt: new Date().toISOString(),
      applied: { boards: 1, watchers: 2 },
      watched: [project],
      fatal: null,
    }),
  );
  if (broken) {
    fs.rmSync(path.join(project, ".kanban", "tasks"), { recursive: true, force: true });
    fs.rmSync(path.join(home, "profiles"), { recursive: true, force: true });
  }
  return { root, project, home, diag };
}

function runDoctor(world) {
  const result = spawnSync(process.execPath, [DOCTOR, "--project", world.project, "--json"], {
    env: { ...process.env, DSH_HOME: world.home, DSH_KANBAN_DIAG_PATH: world.diag },
    encoding: "utf8",
  });
  return { status: result.status, report: JSON.parse(result.stdout), stderr: result.stderr };
}

console.log("== doctor: успешная установка и пустой проект");

await check("успешный проект — 0 ошибок, код 0", async () => {
  const world = makeWorld();
  const { status, report } = runDoctor(world);
  assert.equal(report.summary.fail, 0, JSON.stringify(report.checks));
  assert.equal(report.summary.warn, 0, JSON.stringify(report.checks));
  assert.equal(status, 0);
  assert.ok(report.checks.some((item) => item.name === "роли" && item.level === "ok"));
});

await check("без доски и профиля — ошибки, код 2", async () => {
  const world = makeWorld({ broken: true });
  const { status, report } = runDoctor(world);
  assert.equal(report.summary.fail > 0, true);
  assert.equal(status, 2);
  const names = report.checks.filter((item) => item.level === "fail").map((item) => item.name);
  assert.ok(names.includes("доска проекта"), JSON.stringify(names));
  assert.ok(names.includes("плагин"), JSON.stringify(names));
});

console.log(`\nвсего: ${passed} ok, ${failed} провал(ов)`);
process.exit(failed > 0 ? 1 : 0);
