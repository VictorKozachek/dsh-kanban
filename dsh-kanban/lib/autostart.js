/**
 * Автостарт рабочего дня (issue #086/#087, запрос пользователя).
 *
 * При холодном старте приложения плагин читает `.kanban/autostart.json` и
 * отправляет в указанные сессии один prompt «начинай по плану». Это не
 * автономный агент: сообщение просто кладётся в очередь, как обычный наряд.
 *
 * Файл (в проекте, не в git):
 * {
 *   "enabled": true,
 *   "notBefore": "2026-11-20T00:00:00+03:00",
 *   "oncePerDay": true,
 *   "sessions": ["session-…"],
 *   "text": "Начинай день: …"
 * }
 *
 * Состояние — `$DSH_HOME/kanban-autostart.json` (день + кому уже отправили).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isSessionId } from "./watcher-core.js";

const CONFIG_FILE = ".kanban/autostart.json";
const STATE_FILE = "kanban-autostart.json";
const TIMEOUT_MS = 10_000;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function dayOf(now) {
  return new Date(now).toISOString().slice(0, 10);
}

/** Прочитать конфиг автостарта; первый включённый файл среди досок. */
export function autostartConfig(boards) {
  for (const board of boards ?? []) {
    const value = readJson(path.join(String(board), CONFIG_FILE), null);
    if (value && typeof value === "object" && value.enabled === true) {
      return { board: String(board), ...value };
    }
  }
  return null;
}

/**
 * Отправить автостарт, если сегодня ещё не отправляли и время пришло.
 *
 * @returns `{ sent, skipped, reason }`.
 */
export async function runAutostart(ctx, { boards, home, log = () => {}, diagEvent, disposed, now = Date.now(), fetchPrompt } = {}) {
  const config = autostartConfig(boards);
  if (!config) return { sent: 0, skipped: 0, reason: "no-config" };
  if (config.notBefore && now < Date.parse(String(config.notBefore))) {
    return { sent: 0, skipped: 0, reason: "not-before" };
  }
  const sessions = (Array.isArray(config.sessions) ? config.sessions : []).filter((id) => isSessionId(String(id)));
  if (sessions.length === 0) return { sent: 0, skipped: 0, reason: "no-sessions" };
  const statePath = path.join(home ?? process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh"), STATE_FILE);
  const state = readJson(statePath, { day: "", sent: [] });
  const day = dayOf(now);
  const already = new Set(state.day === day ? state.sent ?? [] : []);

  let sent = 0;
  for (const sessionId of sessions) {
    if (disposed?.()) break;
    if (config.oncePerDay !== false && already.has(sessionId)) continue;
    const service = ctx?.sessionController;
    if (!service || typeof service.prompt !== "function") break;
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("autostart-timeout"));
      }, TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      const prompt = fetchPrompt ?? service.prompt.bind(service);
      await Promise.race([
        prompt(
          {
            requestId: randomUUID(),
            sessionId,
            mode: "queue",
            content: [{ type: "text", text: String(config.text ?? "Начинай рабочий день по плану.") }],
          },
          controller.signal,
        ),
        timeout,
      ]);
      sent += 1;
      already.add(sessionId);
      diagEvent?.({ step: "autostart-sent", board: config.board, session: sessionId });
      log("info", `автостарт: отправил план в ${sessionId}`);
    } catch (error) {
      diagEvent?.({ step: "autostart-failed", board: config.board, session: sessionId, error: String(error?.message ?? error) });
      log("warn", `автостарт: не отправил в ${sessionId}: ${error?.message ?? error}`);
    } finally {
      clearTimeout(timer);
    }
  }
  if (sent > 0) writeJson(statePath, { day, sent: [...already] });
  return { sent, skipped: already.size - sent, reason: sent > 0 ? "sent" : "already" };
}
