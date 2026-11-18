#!/usr/bin/env node
/**
 * Синхронизация доски с kanban-hub вручную (M1, #072).
 *
 *   bin/kanban-sync.sh --once
 *   bin/kanban-sync.sh --status
 *
 * Настройки: флаги --hub/--project/--token/--instance/--user или ENV
 * KANBAN_HUB_URL, KANBAN_HUB_TOKEN, KANBAN_HUB_PROJECT,
 * KANBAN_HUB_INSTANCE, KANBAN_HUB_USER. Доска — --board или cwd.
 */
import path from "node:path";
import { syncOnce, syncSettings, syncStatus } from "../dsh-kanban/lib/sync.js";

const args = process.argv.slice(2);
const flag = (name, fallback = undefined) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const board = path.resolve(flag("--board", process.cwd()));
const settings = syncSettings({
  sync: {
    enabled: true,
    hubUrl: flag("--hub", process.env.KANBAN_HUB_URL ?? ""),
    project: flag("--project", process.env.KANBAN_HUB_PROJECT ?? "default"),
    token: flag("--token", process.env.KANBAN_HUB_TOKEN ?? ""),
    instanceId: flag("--instance", process.env.KANBAN_HUB_INSTANCE ?? "cli"),
    userId: flag("--user", process.env.KANBAN_HUB_USER ?? ""),
    intervalMs: 30_000,
  },
});

if (args.includes("--status")) {
  const status = syncStatus(board);
  if (args.includes("--json")) console.log(JSON.stringify(status, null, 2));
  else {
    console.log(`доска: ${board}`);
    console.log(`курсор: ${status.state.cursor}; локальных отметок: ${Object.keys(status.state.cards).length}`);
    console.log(`remote-карточек: ${status.remote.cards?.length ?? 0}`);
    if (status.lastRun) console.log(`последний проход: ${status.lastRun.at} — ${JSON.stringify(status.lastRun.summary)}`);
  }
  process.exit(0);
}

const summary = await syncOnce({
  board,
  settings,
  log: (level, message) => console.error(`[${level}] ${message}`),
});
console.log(JSON.stringify({ board, ...summary }, null, 2));
process.exit(summary.errors > 0 ? 1 : 0);
