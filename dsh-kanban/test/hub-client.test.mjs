/** Тесты claim/release/handoff клиента хаба (M2). */
import assert from "node:assert/strict";
import http from "node:http";
import { claimCard, handoffCard, hubSettingsFromBoard, releaseCard } from "../lib/hub-client.js";

let passed = 0, failed = 0;
async function check(name, fn) { try { await fn(); passed++; console.log(`   ok: ${name}`); } catch (e) { failed++; console.log(`   ПРОВАЛ: ${name}\n      ${e.message}`); } }
const calls = [];
const server = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    calls.push({ url: req.url, method: req.method, body: body ? JSON.parse(body) : null });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const settings = hubSettingsFromBoard(process.cwd(), { hubUrl: `http://127.0.0.1:${server.address().port}`, token: "t", project: "p", instanceId: "a", userId: "alice" });

await check("claim шлёт instance/user", async () => {
  const r = await claimCard(settings, "001", { ttlSeconds: 60 });
  assert.equal(r.status, 200);
  assert.deepEqual(calls.at(-1).body, { instance: "a", user: "alice", ttl_seconds: 60 });
});
await check("release шлёт instance", async () => {
  await releaseCard(settings, "001");
  assert.deepEqual(calls.at(-1).body, { instance: "a" });
});
await check("handoff шлёт assignee", async () => {
  await handoffCard(settings, "001", "bob");
  assert.deepEqual(calls.at(-1).body, { instance: "a", assignee: "bob" });
});
server.close();
console.log(`\nвсего: ${passed} ok, ${failed} провал(ов)`);
process.exit(failed > 0 ? 1 : 0);
