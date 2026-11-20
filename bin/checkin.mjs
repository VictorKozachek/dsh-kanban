#!/usr/bin/env node
/**
 * `/checkin` — утренний отчёт по доскам (MVP, issue #6/#087).
 *
 *   bin/checkin.sh [--board DIR]... [--out FILE] [--json]
 *
 * Ничего не двигает: читает карточки, пишет отчёт в `.kanban/.checkin/<date>.md`
 * и сдвигает отметку «с прошлого раза». Каскад нарядов делает manager-сессия
 * по протоколу; этот скрипт — общая фактическая база для отчёта.
 */
import path from "node:path";
import { runCheckin } from "../dsh-kanban/lib/day-report.js";

const args = process.argv.slice(2);
const boards = [];
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--board" && args[index + 1]) boards.push(path.resolve(args[index + 1]));
}
const outIndex = args.indexOf("--out");
const out = outIndex >= 0 ? path.resolve(args[outIndex + 1]) : undefined;
const selected = boards.length > 0 ? boards : [process.cwd()];

const report = runCheckin(selected, { reportFile: out });
if (args.includes("--json")) {
  console.log(JSON.stringify({ file: report.file, sections: report.sections.map(({ markdown, ...rest }) => rest) }, null, 2));
} else {
  console.log(report.markdown.trim());
  console.error(`\nотчёт: ${report.file}`);
}
