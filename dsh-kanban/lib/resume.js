/**
 * Авто-возврат прерванных сессий после перезапуска DSH (issue #4).
 *
 * DSH при resume сам досыпает `interruptedTurnClosers`, поэтому достаточно найти
 * сессии с открытым ходом (`turn/start` без `turn/end`) и отправить им prompt в
 * очередь. Кандидаты — только сессии из карты ролей наблюдаемых досок, в окне
 * `[minAgeSeconds, maxAgeHours]`: слишком свежие не трогаем (чтобы не разбудить
 * живую сессию при HMR-перезагрузке плагина), слишком старые — не поднимаем.
 *
 * Повторно один и тот же прерванный ход не будим: отметка лежит в
 * `.kanban/.watcher-resume.json` (`sessionId → { turnStartSeq, at }`).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isSessionId, parseCard } from "./watcher-core.js";
import { decodeLog, lastEventTime, lastTurnStartSeq, openTurnOf, readLog } from "./session-log.js";

const RESUME_FILE = ".watcher-resume.json";
const ACTIVE = new Set(["in-progress", "in-review", "testing"]);

/** Настройки `resume` из конфига строки плагина. */
export function resumeSettings(config = {}) {
  const raw = config?.resume && typeof config.resume === "object" ? config.resume : {};
  const number = (value, fallback) => (Number.isFinite(value) && value > 0 ? Number(value) : fallback);
  return {
    enabled: raw.enabled !== false,
    maxAgeHours: number(raw.maxAgeHours, 12),
    // На холодном старте свежесть не мешает: HMR-перезагрузку отсекает uptime
    // процесса, поэтому по умолчанию будим и ход, оборванный секунды назад.
    minAgeSeconds: Number.isFinite(raw.minAgeSeconds) && raw.minAgeSeconds >= 0 ? Number(raw.minAgeSeconds) : 0,
    maxSessions: Math.floor(number(raw.maxSessions, 5)),
  };
}

/** Разовый индекс логов сессий: `uuid → путь к session.v4.jsonl.zstd`. */
function sessionLogIndex(home) {
  const index = new Map();
  const sessions = path.join(home, "sessions");
  let projects;
  try {
    projects = fs.readdirSync(sessions);
  } catch {
    return index;
  }
  for (const project of projects) {
    const dir = path.join(sessions, project);
    let entries;
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const log = path.join(dir, entry, "session.v4.jsonl.zstd");
      if (!fs.existsSync(log)) continue;
      index.set(entry.replace(/^session-/, ""), log);
    }
  }
  return index;
}

/** Карточка в работе у сессии/роли — для текста наряда. */
function activeCard(board, sessionId) {
  const dir = path.join(board, ".kanban", "tasks");
  let names;
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".md") && name !== "README.md");
  } catch {
    return null;
  }
  for (const name of names) {
    let card;
    try {
      card = parseCard(fs.readFileSync(path.join(dir, name), "utf8"));
    } catch {
      continue;
    }
    if (!card || !ACTIVE.has(String(card.status))) continue;
    if (String(card.owner) === sessionId) return card;
  }
  return null;
}

/**
 * Найти прерванные сессии.
 *
 * @returns массив `{ board, role, sessionId, turnStartSeq, lastAt, card, log }`.
 */
export function collectInterrupted({ boards, home = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh"), settings } = {}) {
  const limit = settings?.maxSessions ?? 5;
  const maxAge = (settings?.maxAgeHours ?? 12) * 3600 * 1000;
  const minAge = (settings?.minAgeSeconds ?? 60) * 1000;
  let index = null;
  const now = Date.now();
  const seen = new Map();
  const skipped = [];

  for (const board of boards ?? []) {
    const rolesFile = path.join(String(board), ".kanban", ".watcher-roles.json");
    let roles;
    try {
      roles = JSON.parse(fs.readFileSync(rolesFile, "utf8"));
    } catch {
      continue;
    }
    if (index === null) index = sessionLogIndex(home);
    for (const [role, rawId] of Object.entries(roles ?? {})) {
      const sessionId = String(rawId);
      if (!isSessionId(sessionId)) {
        skipped.push({ board, role, sessionId, reason: "invalid-owner" });
        continue;
      }
      const log = index.get(sessionId.replace(/^session-/, ""));
      if (!log) {
        skipped.push({ board, role, sessionId, reason: "no-log" });
        continue;
      }
      const decoded = readLog(log);
      if (!decoded || decoded.problems.length > 0) {
        skipped.push({ board, role, sessionId, reason: "broken-log" });
        continue;
      }
      if (!openTurnOf(decoded.events)) {
        skipped.push({ board, role, sessionId, reason: "no-open-turn" });
        continue;
      }
      const lastAt = lastEventTime(decoded.events) || fs.statSync(log).mtimeMs;
      if (lastAt < now - maxAge) {
        skipped.push({ board, role, sessionId, reason: "too-old" });
        continue;
      }
      if (lastAt > now - minAge) {
        skipped.push({ board, role, sessionId, reason: "too-fresh" });
        continue;
      }
      const candidate = {
        board: String(board),
        role,
        sessionId,
        turnStartSeq: lastTurnStartSeq(decoded.events),
        lastAt,
        card: activeCard(String(board), sessionId),
        log,
      };
      // Одна сессия может быть в карте нескольких досок — берём ту, где нашлась карточка.
      const previous = seen.get(sessionId);
      if (!previous || (!previous.card && candidate.card)) seen.set(sessionId, candidate);
    }
  }

  return { candidates: [...seen.values()].slice(0, limit), skipped };
}

/** Текст наряда-возврата. */
export function resumePrompt(candidate) {
  const board = path.basename(candidate.board);
  const card = candidate.card;
  return [
    `DSH перезапускался, и твой предыдущий ход был прерван (${candidate.role} · ${board}).`,
    "",
    "Проверь незавершённые tool calls: их результат неизвестен. Если инструмент мог что-то изменить, сначала сверься с фактическим состоянием — не повторяй вслепую.",
    card ? `Продолжи работу по карточке #${card.id} «${String(card.title ?? "").slice(0, 100)}» (статус ${card.status}).` : "Продолжи работу по своей роли.",
    "",
    "Если ты ждал ответа человека — вопрос снят при перезапуске: переспроси, если он всё ещё важен.",
  ].join("\n");
}

function loadResumeState(board) {
  try {
    return JSON.parse(fs.readFileSync(path.join(board, ".kanban", RESUME_FILE), "utf8")) ?? {};
  } catch {
    return {};
  }
}

function saveResumeState(board, state) {
  try {
    fs.writeFileSync(path.join(board, ".kanban", RESUME_FILE), JSON.stringify(state, null, 2));
  } catch {
    /* состояние — подсказка, не источник правды */
  }
}

/**
 * Разбудить найденные сессии. Возвращает `{ sent, skipped, failed }`.
 *
 * @param ctx - контекст плагина (нужен `sessionController`).
 * @param options - `{ boards, config, log, diagEvent, disposed, signal, home }`.
 */
export async function resumeInterruptedSessions(ctx, options = {}) {
  const settings = resumeSettings(options.config);
  if (!settings.enabled) {
    options.diagEvent?.({ step: "resume-skipped", reason: "disabled" });
    return { sent: 0, skipped: 0, failed: 0 };
  }
  const service = ctx?.sessionController;
  if (!service || typeof service.prompt !== "function") {
    options.diagEvent?.({ step: "resume-skipped", reason: "no-session-controller" });
    return { sent: 0, skipped: 0, failed: 0 };
  }

  const { candidates, skipped } = collectInterrupted({
    boards: options.boards,
    home: options.home,
    settings,
  });
  for (const item of skipped) options.diagEvent?.({ step: "resume-skipped", ...item });

  let sent = 0;
  let failed = 0;
  for (const candidate of candidates) {
    if (options.disposed?.()) break;
    const state = loadResumeState(candidate.board);
    if (state[candidate.sessionId]?.turnStartSeq === candidate.turnStartSeq) {
      options.diagEvent?.({ step: "resume-skipped", reason: "already-resumed", session: candidate.sessionId });
      continue;
    }
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("resume-timeout"));
      }, 15_000);
    });
    try {
      await Promise.race([
        service.prompt(
          {
            requestId: randomUUID(),
            sessionId: candidate.sessionId,
            mode: "queue",
            content: [{ type: "text", text: resumePrompt(candidate) }],
          },
          controller.signal,
        ),
        timeout,
      ]);
      state[candidate.sessionId] = { turnStartSeq: candidate.turnStartSeq, at: new Date().toISOString() };
      saveResumeState(candidate.board, state);
      sent += 1;
      options.diagEvent?.({
        step: "resume-sent",
        board: candidate.board,
        role: candidate.role,
        session: candidate.sessionId,
        card: candidate.card?.id ?? null,
        turnStartSeq: candidate.turnStartSeq,
      });
      options.log?.("info", `разбудил прерванную сессию ${candidate.sessionId} (${candidate.role}, ${candidate.board})`);
    } catch (error) {
      failed += 1;
      options.diagEvent?.({
        step: "resume-failed",
        session: candidate.sessionId,
        board: candidate.board,
        error: String(error?.message ?? error),
      });
      options.log?.("warn", `не разбудил ${candidate.sessionId}: ${error?.message ?? error}`);
    } finally {
      clearTimeout(timer);
    }
  }
  return { sent, skipped: skipped.length, failed };
}
