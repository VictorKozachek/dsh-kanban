/**
 * Batch-чтение доски на host-стороне (M2/#090): один Remote-вызов вместо
 * десятков `workspaceFiles/read`. Клиент падает обратно на файловый loader,
 * если служба недоступна.
 */
import fs from "node:fs";
import path from "node:path";
import { sessionCwdFromContext } from "./card-actions.js";
import { parseCard } from "./watcher-core.js";
import { markRemoteMethod } from "./card-actions.js";

export const SERVICE_KEY = "kanbanBoard";
export const NAMESPACE = "kanbanBoard";

function parseFile(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    const id = path.basename(file, ".md");
    return { id, text };
  } catch {
    return null;
  }
}

/** Тело карточки: description/comments — тот же формат, что у клиента. */
function enrich(card, text) {
  if (!card || card.broken) return card;
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  let start = 0;
  if (lines[0]?.trim() === "---") {
    start = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (start < 0) start = 0;
    start += 1;
  }
  const bodyLines = lines.slice(start);
  const comments = [];
  let current = null;
  for (const line of bodyLines) {
    const found = /^-\s*(\d{4}-\d{2}-\d{2}T[\d:]+Z?)\s*\[([^\]]+)\]\s*(.*)$/.exec(line);
    if (found) {
      if (current) comments.push(current);
      current = { at: found[1], status: found[2].trim(), lines: found[3] ? [found[3]] : [] };
      continue;
    }
    if (current) {
      if (/^##\s/.test(line) || (line.trim() !== "" && !/^\s/.test(line))) {
        comments.push(current); current = null; continue;
      }
      current.lines.push(line);
    }
  }
  if (current) comments.push(current);
  for (const item of comments) {
    item.text = item.lines.map((line) => line.replace(/^ {1,2}/, "")).join("\n").trim();
    delete item.lines;
  }
  const hasTask = bodyLines.some((line) => /^##\s*Задача\s*$/.test(line));
  const description = [];
  if (hasTask) {
    let inside = false;
    for (const line of bodyLines) {
      if (/^##\s/.test(line)) { inside = /^##\s*Задача\s*$/.test(line); continue; }
      if (inside) description.push(line);
    }
  } else {
    for (const line of bodyLines) { if (/^##\s/.test(line)) break; description.push(line); }
  }
  return { ...card, body: bodyLines.join("\n").trim(), description: description.join("\n").trim(), comments };
}

class BoardService {
  constructor(options) {
    this.options = options;
  }

  async read(request) {
    const sessionId = request?.sessionId ?? request?.request?.sessionId;
    const cwd = await this.options.resolveSessionCwd(sessionId);
    if (!cwd) return { ok: false, error: "session cwd unavailable" };
    const byId = new Map();
    let names = [];
    try { names = fs.readdirSync(path.join(cwd, ".kanban", "tasks")); } catch { names = []; }
    for (const name of names) {
      if (!name.endsWith(".md") || name.toLowerCase() === "readme.md") continue;
      let text;
      try { text = fs.readFileSync(path.join(cwd, ".kanban", "tasks", name), "utf8"); } catch { continue; }
      const card = enrich(parseCard(text), text);
      if (card.broken) continue;
      card.key = name;
      card.file = `.kanban/tasks/${name}`;
      card.source = "main";
      byId.set(String(card.id), card);
    }
    for (const root of [path.join(cwd, "worktrees"), path.join(cwd, ".worktrees")]) {
      let names = [];
      try { names = fs.readdirSync(root); } catch { continue; }
      for (const name of names) {
        const file = path.join(root, name, ".kanban", "tasks", `${name}.md`);
        const parsed = parseFile(file);
        if (!parsed) continue;
        const card = enrich(parseCard(parsed.text), parsed.text);
        if (card.broken) continue;
        card.key = `${card.id}.md`;
        card.file = `worktrees/${name}/.kanban/tasks/${card.id}.md`;
        card.source = "worktree";
        const existing = byId.get(String(card.id));
        if (!existing || String(card.updated || "") >= String(existing.updated || "")) byId.set(String(card.id), card);
      }
    }
    const cards = [...byId.values()].sort((a, b) => String(a.id).localeCompare(String(b.id), "ru"));
    return { ok: true, value: { cards, problems: [], truncated: false } };
  }
}

markRemoteMethod(BoardService.prototype, "read");

export function registerBoardService(ctx, options) {
  const service = new BoardService(options);
  service.typertRemote = Object.freeze({ service, serviceKey: SERVICE_KEY, namespace: NAMESPACE });
  const dispose = ctx.provide(SERVICE_KEY, service);
  return { service, dispose };
}
