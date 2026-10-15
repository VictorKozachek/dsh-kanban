/**
 * Согласие половинок плагина: правило «какая запись свежее» есть и в клиентском
 * бандле (`__internals.isNewer`), и в host-половине (`lib/watcher-core.js`). Копий
 * две, потому что половины живут в разных модульных системах; этот тест следит,
 * чтобы они не разъехались.
 *
 * Запуск: node dsh-kanban/test/merge.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

import { isNewer as coreIsNewer, normalizeStatus as coreNormalize, parseCard as coreParseCard } from "../lib/watcher-core.js";

const source = fs.readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
let entry = null;
const sandbox = {
  window: { __ModuleLoader__: { load: (value) => { entry = value; } } },
  console,
  setTimeout,
  clearTimeout
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: "client.js" });
// На загрузке бандлу нужен только React.createElement; хуки понадобятся рендеру,
// а нам здесь достаточно internals.
const react = {
  createElement: () => null,
  Fragment: Symbol("Fragment"),
  useState: (value) => [value, () => {}],
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn()
};
const plugin = entry.factory((name) => {
  if (name === "react") return react;
  throw new Error("неожиданный require: " + name);
});
const clientIsNewer = plugin.__internals.isNewer;
const clientNormalize = plugin.__internals.normalizeStatus;
const clientParseCard = plugin.__internals.parseCard;

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

const CASES = [
  ["свежее по updated", { updated: "2026-10-15T10:00:00Z", source: "main" }, { updated: "2026-10-14T10:00:00Z", source: "worktree" }, true],
  ["старая копия из ветки не побеждает", { updated: "2026-10-14T10:00:00Z", source: "worktree" }, { updated: "2026-10-15T10:00:00Z", source: "main" }, false],
  ["при равенстве выигрывает ветка", { updated: "2026-10-15T10:00:00Z", source: "worktree" }, { updated: "2026-10-15T10:00:00Z", source: "main" }, true],
  ["при равенстве main не побеждает", { updated: "2026-10-15T10:00:00Z", source: "main" }, { updated: "2026-10-15T10:00:00Z", source: "worktree" }, false],
  ["пустой updated у ветки побеждает", { source: "worktree" }, { source: "main" }, true],
  ["пустой updated у main проигрывает ветке", { source: "main" }, { source: "worktree" }, false],
  ["обе пустые — ветка", { updated: "", source: "worktree" }, { updated: "", source: "main" }, true],
  ["обе пустые — main", { updated: "", source: "main" }, { updated: "", source: "worktree" }, false],
  ["без полей — не ветка", {}, {}, false]
];

check("клиентский бандл отдаёт isNewer", () => {
  assert.equal(typeof clientIsNewer, "function");
  assert.equal(typeof coreIsNewer, "function");
});

for (const [name, candidate, current, expected] of CASES) {
  check(`половинки согласны: ${name}`, () => {
    const fromClient = clientIsNewer(candidate, current);
    const fromCore = coreIsNewer(candidate, current);
    assert.equal(fromClient, fromCore, `client ${fromClient}, core ${fromCore}`);
    assert.equal(fromCore, expected, `ожидалось ${expected}`);
  });
}

// Статус на доске терпим к регистру, пробелам и синонимам — дамп обязан совпадать.
const STATUS_CASES = [
  "todo", "in-progress", "in-review", "testing", "ready", "merged", "blocked",
  "ready ", "  merged  ", "In Review", "IN_PROGRESS", "in_progress", "wip", "doing",
  "done", "заблокировано", "ревью", "тестирование", "слито", "hold", "closed",
  "нечто-своё", "", null
];

check("нормализация статуса совпадает с плагином", () => {
  for (const value of STATUS_CASES) {
    assert.equal(coreNormalize(value), clientNormalize(value), `на ${JSON.stringify(value)}`);
  }
});

const CARD_TEXTS = [
  '---\nid: "001"\nstatus: "ready "\ntitle: Пробельный статус\n---\n',
  '---\nid: "002"\nstatus: In Review\ntitle: Регистр\n---\n',
  '---\nid: "003"\nstatus: заблокировано\ntitle: Синоним\n---\n',
  '---\nid: "004"\nstatus: wip\ntitle: Без кавычек\nupdated: 2026-10-15T10:00:00Z\n---\n'
];

// Сверяем не сырое значение, а колонку: каждая половина читает карточку сама и
// нормализует статус своей копией правила. У половин разные подписи парсера
// (клиентской нужен ещё имя файла), поэтому колонка — общая точка сравнения.
check("колонка карточки совпадает с плагином", () => {
  for (const text of CARD_TEXTS) {
    const fromCore = coreNormalize(coreParseCard(text).status);
    const fromClient = clientNormalize(clientParseCard("001.md", text).status);
    assert.equal(fromCore, fromClient, `на ${JSON.stringify(text.slice(0, 30))}`);
  }
});

console.log(`\nвсего: ${passed} ok, ${failed} провал(ов)`);
process.exit(failed > 0 ? 1 : 0);
