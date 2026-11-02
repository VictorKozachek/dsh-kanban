/**
 * Тесты самолечения пресетов ролей (#062, спека 005, issue #1).
 *
 * Проверяются две половины: артефакт `presets/role-presets.json` (его собирает
 * `bin/gen-role-presets.sh`, он едет вместе с плагином) и регистрация определений
 * в реестре DSH при старте — с фейковым реестром, потому что настоящий живёт в
 * профиле и поднимается только приложением.
 *
 * Главное обещание: регистрация не роняет плагин. Дубликат (legacy-строки
 * профиля) — предупреждение, а не ошибка; битый артефакт и отсутствие реестра —
 * понятная диагностика, а не крэш.
 *
 * Запуск: node dsh-kanban/test/presets.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PACKAGE_DIR, PRESETS_FILE, ROLE_IDS, readRolePresets, registerRolePresets } from "../lib/presets.js";

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`   ok: ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`   ПРОВАЛ: ${name}\n      ${error.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`   ok: ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`   ПРОВАЛ: ${name}\n      ${error.message}`);
  }
}

/** Фейковый реестр: пишет вызовы, умеет бросать дубликаты и «странные» ошибки. */
function makeRegistry(options = {}) {
  const calls = { registered: [], disposed: [] };
  const duplicates = new Set(options.duplicates ?? []);
  const failures = new Set(options.failures ?? []);
  return {
    calls,
    async register(definition) {
      const id = String(definition.id);
      if (duplicates.has(id)) throw new Error(`Duplicate agent preset: ${id}`);
      if (failures.has(id)) throw new Error(`реестр отказал: ${id}`);
      calls.registered.push(id);
      return async () => {
        calls.disposed.push(id);
      };
    },
  };
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-presets-"));

// ── артефакт ─────────────────────────────────────────────────────────────────

console.log("== артефакт presets/role-presets.json");

check("артефакт лежит в пакете плагина и читается относительно пакета, а не cwd", () => {
  assert.equal(PRESETS_FILE, path.join(PACKAGE_DIR, "presets", "role-presets.json"));
  assert.equal(fs.existsSync(PRESETS_FILE), true, `нет файла ${PRESETS_FILE}: перегенерируйте bin/gen-role-presets.sh`);
  assert.equal(path.isAbsolute(PRESETS_FILE), true);
});

check("четыре определения ролей со стабильными id и порядком", () => {
  const definitions = JSON.parse(fs.readFileSync(PRESETS_FILE, "utf8"));
  assert.ok(Array.isArray(definitions), "артефакт должен быть массивом определений");
  assert.deepEqual(
    definitions.map((definition) => [definition.id, definition.order]),
    [
      ["dispatcher", 10],
      ["worker", 11],
      ["reviewer", 12],
      ["verifier", 13],
    ],
  );
  assert.deepEqual(
    definitions.map((definition) => definition.id),
    ROLE_IDS,
    "ROLE_IDS должны совпадать с артефактом: id записаны в логах сессий",
  );
});

check("у каждого определения есть name, description и непустой plugins", () => {
  for (const definition of JSON.parse(fs.readFileSync(PRESETS_FILE, "utf8"))) {
    assert.ok(String(definition.name ?? "").length > 0, `у ${definition.id} нет name`);
    assert.ok(String(definition.description ?? "").length > 0, `у ${definition.id} нет description`);
    assert.ok(Array.isArray(definition.plugins) && definition.plugins.length > 0, `у ${definition.id} пустой plugins`);
    for (const plugin of definition.plugins) {
      assert.ok(typeof plugin.id === "string" && plugin.id.length > 0, "у строки plugins нет id");
      assert.ok(typeof plugin.name === "string" && plugin.name.length > 0, "у строки plugins нет name");
    }
  }
});

check("YAML-тег !!js стал узлом __jsExpr, выражения сохранены", () => {
  const raw = fs.readFileSync(PRESETS_FILE, "utf8");
  assert.equal(raw.includes("!!js"), false, "в JSON остался YAML-тег !!js");
  const nodes = [];
  const walk = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value && typeof value === "object") {
      if (typeof value.__jsExpr === "string") nodes.push(value.__jsExpr);
      for (const item of Object.values(value)) walk(item);
    }
  };
  walk(JSON.parse(raw));
  assert.ok(nodes.length >= 2, `узлов __jsExpr: ${nodes.length}`);
  assert.ok(nodes.some((expr) => /win32/.test(expr)), `нет условия по платформе: ${nodes.join(" | ")}`);
  for (const expr of nodes) assert.ok(expr.trim().length > 0, "пустое выражение __jsExpr");
});

check("readRolePresets отдаёт определения и подсказку на битом файле", () => {
  const good = readRolePresets();
  assert.equal(good.ok, true);
  assert.equal(good.definitions.length, 4);
  const broken = path.join(work, "broken.json");
  fs.writeFileSync(broken, "{ не json");
  const bad = readRolePresets(broken);
  assert.equal(bad.ok, false);
  assert.match(bad.message, /не JSON/);
  assert.match(bad.message, /bin\/gen-role-presets\.sh/);
  const missing = readRolePresets(path.join(work, "нет-такого.json"));
  assert.equal(missing.ok, false);
  assert.match(missing.message, /не прочитан/);
  const noId = path.join(work, "no-id.json");
  fs.writeFileSync(noId, JSON.stringify([{ plugins: [{ id: "x", name: "y" }] }]));
  assert.match(readRolePresets(noId).message, /без id/);
  const noPlugins = path.join(work, "no-plugins.json");
  fs.writeFileSync(noPlugins, JSON.stringify([{ id: "worker", plugins: [] }]));
  assert.match(readRolePresets(noPlugins).message, /пустой список plugins/);
});

// ── регистрация ──────────────────────────────────────────────────────────────

console.log("== регистрация при старте: роли, дубликаты, dispose");

await checkAsync("регистрируются все четыре роли — и ровно из артефакта", async () => {
  const registry = makeRegistry();
  const result = await registerRolePresets({ agentPresets: registry, log: () => {} });
  assert.equal(result.ok, true);
  assert.deepEqual(result.registered, ROLE_IDS);
  assert.deepEqual(result.duplicates, []);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(registry.calls.registered, ROLE_IDS);
});

await checkAsync("dispose снимает определения в обратном порядке и идемпотентен", async () => {
  const registry = makeRegistry();
  const result = await registerRolePresets({ agentPresets: registry, log: () => {} });
  await result.dispose();
  assert.deepEqual(registry.calls.disposed, [...ROLE_IDS].reverse());
  await result.dispose();
  assert.equal(registry.calls.disposed.length, 4, "повторный dispose снял что-то ещё");
});

await checkAsync("дубликат legacy-строки не рвёт регистрацию, остальные роли на месте", async () => {
  const registry = makeRegistry({ duplicates: ["worker"] });
  const logs = [];
  const result = await registerRolePresets({ agentPresets: registry, log: (level, message) => logs.push(`${level}: ${message}`) });
  assert.equal(result.ok, true, "дубликат не должен считаться сбоем");
  assert.deepEqual(result.registered, ["dispatcher", "reviewer", "verifier"]);
  assert.deepEqual(result.duplicates, ["worker"]);
  assert.deepEqual(result.failures, []);
  assert.ok(logs.some((line) => /worker.*дубликат/.test(line)), `нет предупреждения о дубликате: ${logs.join(" | ")}`);
  await result.dispose();
  assert.deepEqual(registry.calls.disposed, ["verifier", "reviewer", "dispatcher"], "снимаются только свои определения");
});

await checkAsync("странная ошибка реестра фиксируется, но другие роли регистрируются", async () => {
  const registry = makeRegistry({ failures: ["reviewer"] });
  const logs = [];
  const result = await registerRolePresets({ agentPresets: registry, log: (level, message) => logs.push(`${level}: ${message}`) });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failures, ["reviewer"]);
  assert.deepEqual(result.registered, ["dispatcher", "worker", "verifier"]);
  assert.ok(logs.some((line) => /reviewer/.test(line) && /не зарегистрирован/.test(line)), logs.join(" | "));
});

await checkAsync("без службы реестра и без артефакта — предупреждение вместо крэша", async () => {
  const logs = [];
  const noRegistry = await registerRolePresets({ agentPresets: undefined, log: (level, message) => logs.push(`${level}: ${message}`) });
  assert.equal(noRegistry.ok, false);
  assert.ok(logs.some((line) => /agentPresets недоступна/.test(line)), logs.join(" | "));
  const noFile = await registerRolePresets({
    agentPresets: makeRegistry(),
    file: path.join(work, "нет-такого.json"),
    log: (level, message) => logs.push(`${level}: ${message}`),
  });
  assert.equal(noFile.ok, false);
  assert.ok(logs.some((line) => /gen-role-presets\.sh/.test(line)), logs.join(" | "));
});

await checkAsync("определения уходят в реестр как есть — с plugins и __jsExpr-узлами", async () => {
  const seen = [];
  const registry = {
    async register(definition) {
      seen.push(definition);
      return async () => {};
    },
  };
  await registerRolePresets({ agentPresets: registry, log: () => {} });
  const artifact = JSON.parse(fs.readFileSync(PRESETS_FILE, "utf8"));
  assert.deepEqual(seen, artifact, "в реестр ушло не то, что в артефакте");
  const raw = JSON.stringify(seen);
  assert.ok(raw.includes("__jsExpr"), "условия платформы потерялись при регистрации");
});

await checkAsync("путь к артефакту берётся от пакета, а не от cwd", async () => {
  const before = process.cwd();
  process.chdir(os.tmpdir());
  try {
    const result = await registerRolePresets({ agentPresets: makeRegistry(), log: () => {} });
    assert.equal(result.ok, true, "из чужого cwd артефакт не нашёлся");
    assert.deepEqual(result.registered, ROLE_IDS);
  } finally {
    process.chdir(before);
  }
});

fs.rmSync(work, { recursive: true, force: true });

console.log(`\nвсего: ${passed} ok, ${failed} провал(ов)`);
process.exit(failed > 0 ? 1 : 0);
