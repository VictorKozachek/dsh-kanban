/**
 * Проверки генератора HTML-макета: то, что раньше держалось на ручных замерах.
 *
 * Генератор пишет HTML рядом с собой, поэтому работаем в временной копии: артефакты
 * набора тест не трогает.
 *
 * Запуск: node dsh-kanban/test/mockup.test.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const plugin = path.dirname(here);

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

const work = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-mockup-"));
fs.mkdirSync(path.join(work, "docs"), { recursive: true });
fs.cpSync(path.join(plugin, "lib"), path.join(work, "lib"), { recursive: true });
for (const name of ["build-mockup.mjs", "demo-cards.json"]) {
  fs.copyFileSync(path.join(plugin, "docs", name), path.join(work, "docs", name));
}
// Маячок в общем списке: он должен доехать до HTML, иначе генератор читает свой
// зашитый список, а проверки этого не замечают.
const MARKER = "МАЯЧОК-ИЗ-ОБЩЕГО-СПИСКА";
const shared = JSON.parse(fs.readFileSync(path.join(work, "docs", "demo-cards.json"), "utf8"));
shared[0].title = MARKER;
fs.writeFileSync(path.join(work, "docs", "demo-cards.json"), JSON.stringify(shared, null, 2), "utf8");
execFileSync(process.execPath, [path.join(work, "docs", "build-mockup.mjs"), "view=panel&theme=dark"], {
  cwd: work,
  stdio: "pipe",
});
const html = fs.readFileSync(path.join(work, "docs", "board-mockup-panel-dark.html"), "utf8");

/** Свойства, у которых число не требует единиц измерения. */
const UNITLESS = new Set([
  "line-height",
  "opacity",
  "z-index",
  "flex",
  "flex-grow",
  "flex-shrink",
  "order",
  "font-weight",
  "zoom"
]);

console.log("== генератор HTML-макета");

check("макет собрался", () => {
  assert.ok(html.includes("Канбан"), "в HTML нет доски");
  assert.ok(html.length > 1000, "HTML подозрительно короткий");
});

check("числовые свойства не теряют единицы измерения", () => {
  const bad = [];
  for (const match of html.matchAll(/style="([^"]*)"/g)) {
    for (const declaration of match[1].split(";")) {
      const separator = declaration.indexOf(":");
      if (separator < 0) continue;
      const name = declaration.slice(0, separator).trim();
      const value = declaration.slice(separator + 1).trim();
      if (!name || !value || value === "0") continue;
      if (/^-?\d+(\.\d+)?$/.test(value) && !UNITLESS.has(name)) bad.push(`${name}:${value}`);
    }
  }
  assert.deepEqual(bad, [], `без единиц: ${[...new Set(bad)].slice(0, 5).join(", ")}`);
});

check("все единичные свойства остались единичными", () => {
  const wrong = [];
  for (const match of html.matchAll(/style="([^"]*)"/g)) {
    for (const declaration of match[1].split(";")) {
      const separator = declaration.indexOf(":");
      if (separator < 0) continue;
      const name = declaration.slice(0, separator).trim();
      const value = declaration.slice(separator + 1).trim();
      if (UNITLESS.has(name) && /^\d+(\.\d+)?px$/.test(value)) wrong.push(`${name}:${value}`);
    }
  }
  assert.deepEqual(wrong, [], `единицы там, где не нужны: ${wrong.slice(0, 5).join(", ")}`);
});

check("подсказка чипа роли несёт время роли", () => {
  assert.match(html, /title="[a-z]+ · с \d{4}-\d{2}-\d{2}/, "нет title вида «роль · с дата»");
});

check("нулевой расход не рисует строку «токенов: 0»", () => {
  assert.ok(!html.includes("токенов: 0"), "нулевой расход нарисован строкой расхода");
});

check("генератор читает общий список карточек", () => {
  assert.ok(html.includes(MARKER), "правка общего списка не доехала до HTML");
});

check("название слитой карточки зачёркнуто, как на доске", () => {
  const struck = html.match(/line-through/g) || [];
  assert.equal(struck.length, 1, `зачёркиваний ${struck.length}`);
});

check("значок «в ветке» есть у карточек из worktree", () => {
  assert.ok(html.includes("в ветке"), "нет значка «в ветке»");
});

check("дата карточки в ISO, как показывает плагин", () => {
  assert.match(html, /2026-09-23T\d{2}:\d{2}:\d{2}Z/, "нет ISO-даты");
  assert.ok(!/\d{2}\.\d{2} \d{2}:\d{2}/.test(html), "в HTML осталась короткая дата");
});

check("положительный расход рисуется", () => {
  assert.match(html, /токенов: [\d.,]+[kMG]?/, "нет ни одной строки расхода");
});

console.log(`\nвсего: ${passed} ok, ${failed} провал(ов)`);
process.exit(failed > 0 ? 1 : 0);
