/**
 * Batch-чтение доски на host-стороне (M2/#090): один Remote-вызов вместо
 * десятков `workspaceFiles/read`. Клиент падает обратно на файловый loader,
 * если служба недоступна.
 */
import fs from "node:fs";
import path from "node:path";
import { sessionCwdFromContext } from "./card-actions.js";
import { readLocalCards } from "./sync.js";
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

class BoardService {
  constructor(options) {
    this.options = options;
  }

  async read(request) {
    const sessionId = request?.sessionId ?? request?.request?.sessionId;
    const cwd = await this.options.resolveSessionCwd(sessionId);
    if (!cwd) return { ok: false, error: "session cwd unavailable" };
    const byId = new Map();
    for (const entry of readLocalCards(cwd).values()) {
      const card = { ...entry.card, source: "main" };
      byId.set(String(card.id), card);
    }
    for (const root of [path.join(cwd, "worktrees"), path.join(cwd, ".worktrees")]) {
      let names = [];
      try { names = fs.readdirSync(root); } catch { continue; }
      for (const name of names) {
        const file = path.join(root, name, ".kanban", "tasks", `${name}.md`);
        const parsed = parseFile(file);
        if (!parsed) continue;
        const card = parseCard(parsed.text);
        if (card.broken) continue;
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
