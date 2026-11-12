/**
 * Stale-watchdog (issue #4, второй симптом): карточка стоит в работе/ревью/
 * тестировании дольше порога, а роль её не двигает.
 *
 * Сторож периодически смотрит карточки активных статусов, возраст по `since`
 * (или `updated`), и проверяет сессию роли по логу:
 * - у сессии открытый ход и он свежий → роль работает, не мешаем;
 * - открытого хода нет → шлём роли напоминание «карточка стоит»;
 * - лога сессии нет → эскалируем диспетчеру (перевыдать/вернуть в очередь).
 *
 * Один наряд на версию карточки: отметка в `.kanban/.watcher-stale.json`.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { isSessionId, parseCard } from "./watcher-core.js";
import { lastEventTime, openTurnOf, readLog } from "./session-log.js";
import { sessionLogIndex } from "./resume.js";

const STALE_FILE = ".watcher-stale.json";
const ACTIVE_ROLES = { "in-progress": "worker", "in-review": "reviewer", testing: "verifier" };

/** Настройки `stale` из конфига строки плагина. */
export function staleSettings(config = {}) {
  const raw = config?.stale && typeof config.stale === "object" ? config.stale : {};
  const positive = (value, fallback) => (Number.isFinite(value) && value > 0 ? Number(value) : fallback);
  return {
    enabled: raw.enabled === true,
    minutes: positive(raw.minutes, 120),
    maxPerRun: Math.floor(positive(raw.maxPerRun, 5)),
    workingMinutes: positive(raw.workingMinutes, 15),
  };
}

function readRoles(board) {
  try {
    return JSON.parse(fs.readFileSync(path.join(board, ".kanban", ".watcher-roles.json"), "utf8")) ?? {};
  } catch {
    return {};
  }
}

function loadState(board) {
  try {
    return JSON.parse(fs.readFileSync(path.join(board, ".kanban", STALE_FILE), "utf8")) ?? {};
  } catch {
    return {};
  }
}

function saveState(board, state) {
  try {
    fs.writeFileSync(path.join(board, ".kanban", STALE_FILE), JSON.stringify(state, null, 2));
  } catch {
    /* подсказка, не источник правды */
  }
}

/**
 * Найти стоящие карточки.
 *
 * @returns `{ candidates, skipped }`, кандидат:
 * `{ board, card, role, sessionId, key, ageMinutes, dead, working }`.
 */
export function findStale({ boards, home = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh"), settings, now = Date.now() } = {}) {
  const minutes = settings?.minutes ?? 120;
  const workingMs = (settings?.workingMinutes ?? 15) * 60_000;
  const maxPerRun = settings?.maxPerRun ?? 5;
  const index = sessionLogIndex(home);
  const candidates = [];
  const skipped = [];

  for (const board of boards ?? []) {
    const roles = readRoles(board);
    const state = loadState(board);
    let names;
    try {
      names = fs.readdirSync(path.join(board, ".kanban", "tasks")).filter((name) => name.endsWith(".md") && name !== "README.md");
    } catch {
      continue;
    }
    for (const name of names) {
      let card;
      try {
        card = parseCard(fs.readFileSync(path.join(board, ".kanban", "tasks", name), "utf8"));
      } catch {
        continue;
      }
      if (!card || card.broken) continue;
      const role = ACTIVE_ROLES[String(card.status)];
      if (!role) continue;
      const at = Date.parse(String(card.since || card.updated || ""));
      if (!Number.isFinite(at)) {
        skipped.push({ board, card: card.id, reason: "no-date" });
        continue;
      }
      const ageMinutes = Math.floor((now - at) / 60_000);
      if (ageMinutes < minutes) {
        skipped.push({ board, card: card.id, reason: "fresh" });
        continue;
      }
      const sessionId = role === "worker" ? String(card.owner ?? "") : String(roles[role] ?? "");
      if (!isSessionId(sessionId)) {
        skipped.push({ board, card: card.id, reason: "no-session" });
        continue;
      }
      const key = `${card.id}:${card.status}:${card.updated ?? ""}`;
      if (state[key]) {
        skipped.push({ board, card: card.id, reason: "already-notified" });
        continue;
      }
      const log = index.get(sessionId.replace(/^session-/, ""));
      let working = false;
      let dead = log === undefined;
      if (log) {
        const decoded = readLog(log);
        if (!decoded || decoded.problems.length > 0) {
          skipped.push({ board, card: card.id, reason: "broken-log" });
          continue;
        }
        const last = lastEventTime(decoded.events);
        working = openTurnOf(decoded.events) && last > now - workingMs;
        dead = false;
      }
      if (working) {
        skipped.push({ board, card: card.id, reason: "working" });
        continue;
      }
      candidates.push({ board: String(board), card, role, sessionId, key, ageMinutes, dead, working });
      if (candidates.length >= maxPerRun) break;
    }
    if (candidates.length >= maxPerRun) break;
  }
  return { candidates, skipped };
}

/** Текст напоминания роли. */
function remindText(candidate) {
  return [
    `Карточка #${candidate.card.id} «${String(candidate.card.title ?? "").slice(0, 100)}» стоит в статусе «${candidate.card.status}» уже ${candidate.ageMinutes} мин.`,
    "",
    "Если работа идёт — продолжай; если нет, верни карточку с причиной или напиши диспетчеру.",
    "Это автоматическое напоминание сторожа (issue #4).",
  ].join("\n");
}

/** Текст эскалации диспетчеру. */
function escalateText(candidate) {
  return [
    `Карточка #${candidate.card.id} «${String(candidate.card.title ?? "").slice(0, 100)}» стоит в статусе «${candidate.card.status}» уже ${candidate.ageMinutes} мин.`,
    `Сессия роли ${candidate.role} (${candidate.sessionId}) не найдена или мертва.`,
    "",
    "Перевыдай карточку или верни её в очередь; проверь, не потерялась ли сессия.",
    "Это автоматическая эскалация сторожа (issue #4).",
  ].join("\n");
}

/**
 * Один проход watchdog: напоминания/эскалации. Возвращает `{ sent, escalated, skipped }`.
 *
 * @param deliver - `async (item) => ({ ok, permanent })` — обычная доставка сторожа.
 */
export async function runStaleWatchdog(ctx, { boards, config, deliver, diagEvent, log, disposed, home } = {}) {
  const settings = staleSettings(config);
  if (!settings.enabled) {
    diagEvent?.({ step: "stale-skipped", reason: "disabled" });
    return { sent: 0, escalated: 0, skipped: 0 };
  }
  if (typeof deliver !== "function") return { sent: 0, escalated: 0, skipped: 0 };
  const { candidates, skipped } = findStale({ boards, home, settings });
  for (const item of skipped) diagEvent?.({ step: "stale-skipped", ...item });

  let sent = 0;
  let escalated = 0;
  for (const candidate of candidates) {
    if (disposed?.()) break;
    const state = loadState(candidate.board);
    if (candidate.dead) {
      const roles = readRoles(candidate.board);
      const dispatcher = String(roles.dispatcher ?? "");
      if (!isSessionId(dispatcher)) {
        diagEvent?.({ step: "stale-skipped", board: candidate.board, card: candidate.card.id, reason: "no-dispatcher" });
        continue;
      }
      const result = await deliver({
        board: candidate.board,
        kind: "stale-escalation",
        cardId: candidate.card.id,
        status: candidate.card.status,
        sessionId: dispatcher,
        text: escalateText(candidate),
      });
      if (result?.ok) {
        state[candidate.key] = { at: new Date().toISOString(), escalatedTo: dispatcher };
        saveState(candidate.board, state);
        escalated += 1;
        diagEvent?.({ step: "stale-escalated", board: candidate.board, card: candidate.card.id, session: dispatcher, ageMinutes: candidate.ageMinutes });
        log?.("warn", `карточка #${candidate.card.id} стоит ${candidate.ageMinutes} мин, сессия мертва — эскалация диспетчеру`);
      }
      continue;
    }
    const result = await deliver({
      board: candidate.board,
      kind: "stale-reminder",
      cardId: candidate.card.id,
      status: candidate.card.status,
      sessionId: candidate.sessionId,
      text: remindText(candidate),
    });
    if (result?.ok) {
      state[candidate.key] = { at: new Date().toISOString() };
      saveState(candidate.board, state);
      sent += 1;
      diagEvent?.({ step: "stale-notice", board: candidate.board, card: candidate.card.id, session: candidate.sessionId, ageMinutes: candidate.ageMinutes });
      log?.("info", `напоминание по #${candidate.card.id}: стоит ${candidate.ageMinutes} мин`);
    }
  }
  return { sent, escalated, skipped: skipped.length };
}
