/**
 * Отдать таблицу стилей и колонки плагина в JSON — для рендера макета не в
 * браузере (dsh-kanban/docs/render-mockup.py).
 *
 * Запуск: node dsh-kanban/docs/dump-styles.mjs
 */
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "..", "lib", "client.js"), "utf8");

let entry = null;
const sandbox = { window: { __ModuleLoader__: { load: (value) => { entry = value; } } }, console };
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: "client.js" });
const plugin = entry.factory((name) => {
  if (name === "react") return { createElement: () => null };
  throw new Error("неожиданный require: " + name);
});

process.stdout.write(JSON.stringify({ styles: plugin.__internals.styles, columns: plugin.__internals.COLUMNS }, null, 2));
