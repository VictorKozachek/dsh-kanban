/**
 * Отчёты рабочего дня: `/checkin` (утро) и `/checkout` (вечер).
 *
 * Читает `.kanban/tasks` как обычная доска; ничего не двигает. Задача — дать
 * manager-сессии и человеку агрегированную картину по одной или нескольким
 * доскам, а checkout — финальный вердикт «можно выключать».
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readLocalCards } from "./sync.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function cardsOf(board) {
  return [...readLocalCards(board).values()].map((entry) => entry.card);
}

function dateOf(now) {
  return new Date(now).toISOString().slice(0, 10);
}

function short(card) {
  const title = String(card.title ?? "").trim();
  return `#${card.id}${title ? ` ${title}` : ""}`;
}

function statePath(board) {
  return path.join(board, ".kanban", ".checkin", "state.json");
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** Одна секция checkin по доске. */
export function checkinSection(board, { since, now = Date.now() } = {}) {
  const cards = cardsOf(board);
  const done = cards.filter((card) => card.status === "merged" && Date.parse(card.updated ?? "") > since);
  const active = cards.filter((card) => ["in-progress", "in-review", "testing"].includes(card.status));
  const todo = cards.filter((card) => card.status === "todo");
  const blocked = cards.filter((card) => card.status === "blocked");
  const sleeping = cards.filter(
    (card) => card.status === "todo" && Date.parse(card.updated ?? "") && now - Date.parse(card.updated) > DAY_MS,
  );
  return {
    board,
    name: path.basename(board),
    done,
    active,
    todo,
    blocked,
    sleeping,
    markdown: [
      `## ${path.basename(board)}`,
      "",
      `- сделано с прошлого раза: ${done.length ? done.map(short).join(", ") : "—"}`,
      `- в работе: ${active.length ? active.map((card) => `${short(card)} (${card.status}${card.owner ? `, ${card.owner}` : ""})`).join(", ") : "—"}`,
      `- todo: ${todo.length ? todo.map(short).join(", ") : "—"}`,
      `- блокеры: ${blocked.length ? blocked.map((card) => `${short(card)}${card.note ? ` — ${String(card.note).trim()}` : ""}`).join("; ") : "—"}`,
      `- спящие todo (>24ч): ${sleeping.length ? sleeping.map(short).join(", ") : "—"}`,
      "",
    ].join("\n"),
  };
}

/** Собрать утренний отчёт по доскам. */
export function buildCheckin(boards, { now = Date.now(), state = {} } = {}) {
  const since = Number(state.lastCheckinAt ? Date.parse(state.lastCheckinAt) : 0) || now - DAY_MS;
  const sections = boards.map((board) => checkinSection(board, { since, now }));
  const markdown = [
    `# Checkin ${dateOf(now)}`,
    "",
    ...sections.map((section) => section.markdown),
    "## Итог",
    "",
    ...sections.map((section) => {
      const blockers = section.blocked.length + section.sleeping.length;
      return `- ${section.name}: сделано ${section.done.length}, в работе ${section.active.length}, todo ${section.todo.length}, блокеры/спящие ${blockers}`;
    }),
    "",
  ].join("\n");
  return { markdown, sections, state: { lastCheckinAt: new Date(now).toISOString() } };
}

/** Запустить checkin: отчёт + сдвиг состояния (для «сделано с прошлого раза»). */
export function runCheckin(boards, { now = Date.now(), reportFile, out } = {}) {
  const first = boards[0] ?? process.cwd();
  const states = boards.map((board) => readJson(statePath(board), {}));
  const mergedState = states.reduce((acc, item) => ({ ...acc, ...item }), {});
  const report = buildCheckin(boards, { now, state: mergedState });
  const file = reportFile ?? path.join(first, ".kanban", ".checkin", `${dateOf(now)}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, report.markdown);
  for (const board of boards) {
    const fileState = statePath(board);
    fs.mkdirSync(path.dirname(fileState), { recursive: true });
    fs.writeFileSync(fileState, JSON.stringify({ ...readJson(fileState, {}), ...report.state }, null, 2));
  }
  if (out) out(report.markdown);
  return { ...report, file };
}

function git(board, args) {
  try {
    return execFileSync("git", args, { cwd: board, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/** Одна секция checkout: git-гигиена + блокеры + вердикт. */
export function checkoutSection(board, { now = Date.now() } = {}) {
  const cards = cardsOf(board);
  const active = cards.filter((card) => ["in-progress", "in-review", "testing", "ready"].includes(card.status));
  const blocked = cards.filter((card) => card.status === "blocked");
  const dirty = git(board, ["status", "--porcelain"]).split("\n").filter(Boolean);
  const ahead = Number(git(board, ["rev-list", "--count", "@{u}..HEAD"]) || 0);
  const branch = git(board, ["branch", "--show-current"]);
  const reasons = [];
  if (dirty.length) reasons.push(`незакоммичено файлов: ${dirty.length}`);
  if (ahead > 0) reasons.push(`незапушенных коммитов: ${ahead}`);
  if (blocked.length) reasons.push(`блокеры: ${blocked.map(short).join(", ")}`);
  const canShutdown = reasons.length === 0;
  return {
    board,
    name: path.basename(board),
    active,
    blocked,
    dirty,
    ahead,
    branch,
    canShutdown,
    reasons,
    markdown: [
      `## ${path.basename(board)}`,
      "",
      `- ветка: ${branch || "—"}`,
      `- в работе: ${active.length ? active.map((card) => `${short(card)} (${card.status})`).join(", ") : "—"}`,
      `- блокеры: ${blocked.length ? blocked.map((card) => `${short(card)}${card.note ? ` — ${String(card.note).trim()}` : ""}`).join("; ") : "—"}`,
      `- незакоммичено: ${dirty.length ? dirty.join("; ") : "—"}`,
      `- незапушено коммитов: ${ahead}`,
      `- трекер: не настроен (проверка статусов пропущена)`,
      `- вердикт: ${canShutdown ? "можно выключать" : "нельзя — " + reasons.join("; ")}`,
      "",
    ].join("\n"),
  };
}

export function buildCheckout(boards, { now = Date.now() } = {}) {
  const sections = boards.map((board) => checkoutSection(board, { now }));
  const allOk = sections.every((section) => section.canShutdown);
  const reasons = sections.flatMap((section) => section.reasons.map((reason) => `${section.name}: ${reason}`));
  const markdown = [
    `# Checkout ${dateOf(now)}`,
    "",
    ...sections.map((section) => section.markdown),
    "## Итог",
    "",
    allOk
      ? "**МОЖНО ВЫКЛЮЧАТЬ КОМПЬЮТЕР** — всё закоммичено/запушено, блокеров нет."
      : `**ВЫКЛЮЧАТЬ ПОКА НЕЛЬЗЯ:** ${reasons.join("; ")}`,
    "",
  ].join("\n");
  return { markdown, sections, canShutdown: allOk, reasons };
}

export function runCheckout(boards, { now = Date.now(), reportFile, out, push = true } = {}) {
  const first = boards[0] ?? process.cwd();
  // Пуш — операция checkout (по решению владельца): отправляем всё, что уже
  // закоммичено. Грязные файлы не коммитим — они остаются причиной «нельзя».
  if (push) for (const board of boards) git(board, ["push"]);
  const report = buildCheckout(boards, { now });
  const file = reportFile ?? path.join(first, ".kanban", ".checkout", `${dateOf(now)}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, report.markdown);
  if (out) out(report.markdown);
  return { ...report, file };
}
