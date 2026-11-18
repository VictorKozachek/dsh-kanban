/**
 * Тесты клиента синка с хабом (M1, #072): мок-хаб на node:http.
 *
 * Запуск: node dsh-kanban/test/sync.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { syncOnce } from "../lib/sync.js";

let passed = 0;
let failed = 0;

function report(name, error) {
  if (error) {
    failed += 1;
    console.log(`   ПРОВАЛ: ${name}\n      ${error.message}`);
    return;
  }
  passed += 1;
  console.log(`   ok: ${name}`);
}

async function check(name, fn) {
  try {
    await fn();
    report(name);
  } catch (error) {
    report(name, error);
  }
}

function writeCard(board, id, status, extra = {}) {
  fs.writeFileSync(
    path.join(board, ".kanban", "tasks", `${id}.md`),
    [
      "---",
      `id: "${id}"`,
      `title: Задача ${id}`,
      `status: ${status}`,
      `updated: "${extra.updated ?? new Date().toISOString()}"`,
      "---",
      "",
    ].join("\n"),
  );
}

function makeBoard() {
  const board = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-sync-"));
  fs.mkdirSync(path.join(board, ".kanban", "tasks"), { recursive: true });
  return board;
}

/** Мок-хаб: lease/claim, CAS, pull. */
function startHub() {
  const cards = new Map();
  const calls = [];
  let clock = Date.now();

  const send = (res, status, value) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };
  const cardJson = (card) => ({ ...card, lease: card.lease ?? null });
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      calls.push(`${req.method} ${req.url}`);
      if (req.headers.authorization !== "Bearer test") return send(res, 401, { error: "unauthorized" });
      const url = new URL(req.url, "http://localhost");
      const segments = url.pathname.split("/").filter(Boolean);
      // /v1/projects/demo/cards[/id[/action]]
      if (segments[0] !== "v1" || segments[1] !== "projects" || segments[3] !== "cards") {
        return send(res, 404, { error: "not found" });
      }
      const id = segments[4];
      const action = segments[5];
      const data = body ? JSON.parse(body) : {};
      const now = () => ++clock;
      if (req.method === "GET" && !id) {
        const since = Number(url.searchParams.get("since") ?? 0);
        const values = [...cards.values()].filter((card) => card.updated_at > since).map(cardJson);
        return send(res, 200, { cards: values });
      }
      if (req.method === "POST" && action === "claim") {
        const card = cards.get(id);
        if (!card) return send(res, 404, { error: "card not found" });
        if (card.lease && card.lease.until > now() && card.lease.instance !== data.instance) {
          return send(res, 409, { error: "held" });
        }
        card.lease = { instance: data.instance, user: data.user, until: now() + 60_000 };
        card.updated_at = now();
        return send(res, 200, cardJson(card));
      }
      if (req.method === "POST" && action === "release") {
        const card = cards.get(id);
        if (!card || !card.lease || card.lease.instance !== data.instance) return send(res, 409, { error: "not holder" });
        card.lease = null;
        card.updated_at = now();
        return send(res, 200, cardJson(card));
      }
      if (req.method === "PUT" && id) {
        const existing = cards.get(id);
        if (!existing) {
          if (data.base_rev !== 0) return send(res, 409, { error: "base_rev" });
          const created = {
            id,
            rev: 1,
            payload: data.payload,
            assignee: data.assignee ?? null,
            lease: { instance: data.instance, user: data.user, until: now() + 60_000 },
            updated_at: now(),
          };
          cards.set(id, created);
          return send(res, 200, cardJson(created));
        }
        if (!existing.lease || existing.lease.instance !== data.instance || existing.lease.until <= now()) {
          return send(res, 409, { error: "not holder" });
        }
        if (existing.rev !== data.base_rev) return send(res, 409, { error: "stale", rev: existing.rev });
        existing.rev += 1;
        existing.payload = data.payload;
        existing.assignee = data.assignee ?? existing.assignee;
        existing.lease.until = now() + 60_000;
        existing.updated_at = now();
        return send(res, 200, cardJson(existing));
      }
      return send(res, 404, { error: "not found" });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        calls,
        cards,
        seed(card) {
          cards.set(card.id, { ...card, lease: card.lease ?? null, updated_at: card.updated_at ?? ++clock });
        },
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function settings(hub, overrides = {}) {
  return {
    enabled: true,
    hubUrl: hub.url,
    project: "demo",
    token: "test",
    instanceId: "a",
    userId: "alice",
    intervalMs: 1000,
    board: null,
    ...overrides,
  };
}

const quiet = () => {};

console.log("== синк: новый и изменённый локальный файл");
await check("новая карточка уходит на хаб и lease отпускается", async () => {
  const hub = await startHub();
  const board = makeBoard();
  writeCard(board, "001", "todo");
  const result = await syncOnce({ board, settings: settings(hub), log: quiet });
  assert.equal(result.pushed, 1);
  assert.equal(hub.cards.size, 1);
  assert.equal(hub.cards.get("001").lease, null);
  assert.ok(hub.calls.some((call) => call.includes("release")));
  await hub.close();
});

await check("без изменений повторный проход ничего не пушит", async () => {
  const hub = await startHub();
  const board = makeBoard();
  writeCard(board, "001", "todo");
  await syncOnce({ board, settings: settings(hub), log: quiet });
  const before = hub.calls.length;
  const result = await syncOnce({ board, settings: settings(hub), log: quiet });
  assert.equal(result.pushed, 0);
  assert.ok(result.skipped >= 1);
  assert.equal(hub.calls.filter((call) => call.startsWith("PUT")).length, 1, JSON.stringify(hub.calls.slice(before)));
  await hub.close();
});

await check("изменённый локальный статус обновляет карточку", async () => {
  const hub = await startHub();
  const board = makeBoard();
  writeCard(board, "001", "todo");
  await syncOnce({ board, settings: settings(hub), log: quiet });
  writeCard(board, "001", "in-progress", { updated: new Date(Date.now() + 1000).toISOString() });
  const result = await syncOnce({ board, settings: settings(hub), log: quiet });
  assert.equal(result.pushed, 1);
  assert.equal(hub.cards.get("001").payload.status, "in-progress");
  assert.ok(hub.cards.get("001").rev >= 2);
  await hub.close();
});

console.log("== синк: чужие карточки и конфликты");
await check("карточки другого инстанса попадают в remote cache", async () => {
  const hub = await startHub();
  const board = makeBoard();
  hub.seed({ id: "002", rev: 1, payload: { status: "todo" }, lease: { instance: "b", user: "bob", until: Date.now() + 60000 } });
  await syncOnce({ board, settings: settings(hub), log: quiet });
  const remote = JSON.parse(fs.readFileSync(path.join(board, ".kanban", ".sync", "remote.json"), "utf8"));
  assert.equal(remote.cards.length, 1);
  assert.equal(remote.cards[0].id, "002");
  await hub.close();
});

await check("чужой lease не перезаписывается: конфликт", async () => {
  const hub = await startHub();
  const board = makeBoard();
  hub.seed({ id: "003", rev: 1, payload: { status: "todo" }, lease: { instance: "b", user: "bob", until: Date.now() + 60000 } });
  writeCard(board, "003", "in-progress");
  const result = await syncOnce({ board, settings: settings(hub), log: quiet });
  assert.equal(result.pushed, 0);
  assert.equal(result.conflicts, 1);
  assert.equal(hub.cards.get("003").payload.status, "todo");
  await hub.close();
});

console.log("== синк: офлайн и выключение");
await check("недоступный хаб не ломает проход и не сдвигает state", async () => {
  const hub = await startHub();
  const board = makeBoard();
  writeCard(board, "001", "todo");
  const offline = async () => {
    throw new Error("offline");
  };
  const result = await syncOnce({ board, settings: settings(hub), fetchImpl: offline, log: quiet });
  assert.equal(result.errors, 1);
  assert.equal(fs.existsSync(path.join(board, ".kanban", ".sync", "state.json")), true);
  const state = JSON.parse(fs.readFileSync(path.join(board, ".kanban", ".sync", "state.json"), "utf8"));
  assert.deepEqual(state.cards, {});
  // после возврата сети тот же файл уходит
  const retry = await syncOnce({ board, settings: settings(hub), log: quiet });
  assert.equal(retry.pushed, 1);
  await hub.close();
});

await check("sync.enabled=false не делает запросов", async () => {
  const hub = await startHub();
  const board = makeBoard();
  writeCard(board, "001", "todo");
  const result = await syncOnce({ board, settings: settings(hub, { enabled: false }), log: quiet });
  assert.equal(result.enabled, false);
  assert.equal(hub.calls.length, 0);
  await hub.close();
});

console.log(`\nвсего: ${passed} ok, ${failed} провал(ов)`);
process.exit(failed > 0 ? 1 : 0);
