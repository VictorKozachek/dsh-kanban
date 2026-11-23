/** Тесты batch-службы доски (#090). */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerBoardService } from "../lib/board-service.js";

const board = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-board-service-"));
fs.mkdirSync(path.join(board, ".kanban", "tasks"), { recursive: true });
fs.writeFileSync(path.join(board, ".kanban", "tasks", "001.md"), '---\nid: "001"\ntitle: Main\nstatus: todo\nupdated: "2026-11-20T08:00:00Z"\n---\n\n## Задача\n\nСделать X.\n\n- 2026-11-20T09:00:00Z [in-progress] Заметка\n  Текст заметки.\n');
fs.mkdirSync(path.join(board, "worktrees", "002", ".kanban", "tasks"), { recursive: true });
fs.writeFileSync(path.join(board, "worktrees", "002", ".kanban", "tasks", "002.md"), '---\nid: "002"\ntitle: Branch\nstatus: in-progress\nupdated: "2026-11-20T09:00:00Z"\n---\n');

let service;
const ctx = { provide: (_key, value) => { service = value; return () => {}; } };
registerBoardService(ctx, { resolveSessionCwd: async () => board });
const result = await service.read({ sessionId: "session-x" });
assert.equal(result.ok, true);
assert.deepEqual(result.value.cards.map((card) => card.id), ["001", "002"]);
assert.equal(result.value.cards.find((card) => card.id === "002").title, "Branch");
assert.equal(result.value.cards.find((card) => card.id === "001").key, "001.md", "нет стабильного key для выбора карточки");
assert.match(result.value.cards.find((card) => card.id === "001").description, /Сделать X/);
assert.equal(result.value.cards.find((card) => card.id === "001").comments.length, 1);
assert.equal(result.value.cards.find((card) => card.id === "002").key, "002.md");
assert.equal(result.value.cards.find((card) => card.id === "002").source, "worktree");
console.log("board-service.test.mjs: все проверки прошли");
