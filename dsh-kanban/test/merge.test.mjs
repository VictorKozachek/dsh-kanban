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

import { isNewer as coreIsNewer } from "../lib/watcher-core.js";

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

console.log(`\nвсего: ${passed} ok, ${failed} провал(ов)`);
process.exit(failed > 0 ? 1 : 0);
