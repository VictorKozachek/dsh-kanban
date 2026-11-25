#!/usr/bin/env node
/**
 * Безопасно добавить/убрать проект в `config.boards` ряда ui-kanban
 * глобального/профильного патч-слоя (issue #076).
 *
 *   bin/kanban-config.sh --boards /path/to/project [--file FILE] [--dry-run]
 *   bin/kanban-config.sh --remove /path/to/project
 *
 * Не парсит YAML целиком: правит только блок `- id: ui-kanban` → `boards:`,
 * сохраняя комментарии и остальные ключи. Идемпотентно, с бэкапом.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback = undefined) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const dryRun = args.includes("--dry-run");
const remove = args.includes("--remove");
const target = path.resolve(flag("--boards") ?? flag("--remove") ?? "");
const file = path.resolve(flag("--file") ?? path.join(process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh"), "cordis.patch.yml"));
if (!target) {
  console.error("укажите путь: --boards <project> (или --remove <project>)");
  process.exit(2);
}
let text;
try {
  text = fs.readFileSync(file, "utf8");
} catch (error) {
  console.error(`не читается ${file}: ${error.message}`);
  process.exit(2);
}
const lines = text.split("\n");
const start = lines.findIndex((line) => /^\s*-\s*id:\s*ui-kanban\s*$/.test(line));
if (start < 0) {
  console.error("в файле нет ряда `- id: ui-kanban`; сначала установите плагин");
  process.exit(2);
}
let end = lines.length;
const indent = (lines[start].match(/^\s*/) || [""])[0].length;
for (let index = start + 1; index < lines.length; index += 1) {
  const match = /^(\s*)-\s+id:/.exec(lines[index]);
  if (match && match[1].length <= indent) { end = index; break; }
}
let boardsLine = -1;
for (let index = start + 1; index < end; index += 1) {
  if (/^\s*boards:\s*$/.test(lines[index])) { boardsLine = index; break; }
}
if (boardsLine < 0) {
  console.error("в ряду ui-kanban нет `boards:` — добавьте вручную");
  process.exit(2);
}
const itemIndent = " ".repeat((lines[boardsLine].match(/^\s*/) || [""])[0].length + 2);
const existing = [];
let lastItem = boardsLine;
for (let index = boardsLine + 1; index < end; index += 1) {
  const line = lines[index];
  if (/^\s*-\s+/.test(line)) {
    existing.push(line.replace(/^\s*-\s*/, "").replace(/\s+#.*$/, "").trim());
    lastItem = index;
    continue;
  }
  if (line.trim() === "" || /^\s*#/.test(line)) continue;
  break;
}
const already = existing.includes(target);
if (remove) {
  if (!already) { console.log(`путь уже отсутствует: ${target}`); process.exit(0); }
  const kept = lines.filter((line) => !(/^\s*-\s+/.test(line) && line.replace(/^\s*-\s*/, "").replace(/\s+#.*$/, "").trim() === target));
  text = kept.join("\n");
} else if (already) {
  console.log(`путь уже есть: ${target}`);
  process.exit(0);
} else {
  lines.splice(lastItem + 1, 0, `${itemIndent}- ${target}`);
  text = lines.join("\n");
}
if (dryRun) {
  console.log(text);
  process.exit(0);
}
const backup = `${file}.bak.${Date.now()}`;
fs.copyFileSync(file, backup);
fs.writeFileSync(file, text);
console.log(`${remove ? "удалён" : "добавлен"}: ${target}`);
console.log(`файл: ${file}`);
console.log(`бэкап: ${backup}`);
