import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-config-"));
const file = path.join(dir, "cordis.patch.yml");
fs.writeFileSync(file, [
  "plugins:",
  "  - id: ui-kanban",
  "    config:",
  "      boards:",
  "        - /old/project",
  "      ignore:",
  "        - /tmp/**",
  "  - id: other",
  "    config:",
  "      boards:",
  "        - /other/project",
  "",
].join("\n"));
const script = path.resolve("bin/kanban-config.mjs");
const node = process.execPath;
execFileSync(node, [script, "--boards", "/new/project", "--file", file]);
let text = fs.readFileSync(file, "utf8");
assert.match(text, /- \/new\/project/);
assert.match(text, /- \/other\/project/);
assert.match(text, /- \/old\/project/);
const before = text;
execFileSync(node, [script, "--boards", "/new/project", "--file", file]);
assert.equal(fs.readFileSync(file, "utf8"), before, "повторная установка не меняет файл");
execFileSync(node, [script, "--remove", "/new/project", "--file", file]);
text = fs.readFileSync(file, "utf8");
assert.doesNotMatch(text, /\/new\/project/);
console.log("kanban-config.test.mjs: все проверки прошли");
