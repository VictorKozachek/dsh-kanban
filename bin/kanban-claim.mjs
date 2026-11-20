#!/usr/bin/env node
/** claim/release/handoff карточки на хабе (M2). */
import path from "node:path";
import { claimCard, handoffCard, hubSettingsFromBoard, releaseCard } from "../dsh-kanban/lib/hub-client.js";

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const board = path.resolve(flag("--board") ?? process.cwd());
const card = flag("--card");
if (!card) { console.error("нужен --card <id>"); process.exit(2); }
const settings = hubSettingsFromBoard(board, {
  hubUrl: flag("--hub"), project: flag("--project"), token: flag("--token"),
  instanceId: flag("--instance"), userId: flag("--user"),
});
let result;
if (args.includes("--release")) result = await releaseCard(settings, card);
else if (args.includes("--handoff")) result = await handoffCard(settings, card, flag("--to") ?? "");
else result = await claimCard(settings, card);
console.log(JSON.stringify(result, null, 2));
process.exit(result.status === 200 ? 0 : 1);
