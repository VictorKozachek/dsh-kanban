#!/usr/bin/env node
/** `/checkout` — вечерний отчёт и вердикт «можно выключать» (MVP, #088). */
import path from "node:path";
import { runCheckout } from "../dsh-kanban/lib/day-report.js";

const args = process.argv.slice(2);
const boards = [];
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--board" && args[index + 1]) boards.push(path.resolve(args[index + 1]));
}
const outIndex = args.indexOf("--out");
const report = runCheckout(boards.length ? boards : [process.cwd()], {
  reportFile: outIndex >= 0 ? path.resolve(args[outIndex + 1]) : undefined,
  push: !args.includes("--no-push"),
});
if (args.includes("--json")) console.log(JSON.stringify({ file: report.file, canShutdown: report.canShutdown, reasons: report.reasons }, null, 2));
else {
  console.log(report.markdown.trim());
  console.error(`\nотчёт: ${report.file}`);
}
