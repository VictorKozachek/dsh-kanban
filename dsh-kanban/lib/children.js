/**
 * Дочерние доски: read-only обзор досок дерева команд (host-половина).
 *
 * Зачем: у каждой команды свой проект со своей доской, и доски образуют дерево
 * (`aif-project/infra`, `aif-project/frontend/…`). Сессия-родитель видит только
 * свою доску, поэтому обзор детей живёт отдельной вкладкой (спека 004).
 *
 * ## Контракт
 *
 * Манифест `.kanban/children.json` в корне рабочей директории сессии:
 *
 * ```json
 * { "version": 1, "boards": [ { "path": "aif-project/infra", "title": "infra" } ] }
 * ```
 *
 * Относительные пути считаются от корня рабочей директории сессии, абсолютные
 * берутся как есть (доски вне дерева). `title` необязателен — по умолчанию
 * последний сегмент пути.
 *
 * Endpoint `kanbanChildren/read`, аргумент `{ request: { sessionId } }`, ответ
 * `{ ok: true, value: { boards, problems, manifest } }`:
 * - `boards[i] = { path, absPath, title, cards, problems, missing }`, где `cards`
 *   уже слиты из основной доски и досок рабочих деревьев (та же семантика, что у
 *   сторожа: одноимённая карточка из дерева, свежесть по `updated`, при равенстве
 *   побеждает дерево);
 * - `manifest` — `"ok" | "missing" | "broken"`: клиенту нужно отличать «манифеста
 *   нет» (подсказать `bin/board-children.sh`) от «манифест пуст»;
 * - ошибка одной доски (нет каталога карточек, нечитаемый файл) попадает в её
 *   `problems`/`missing` и не валит остальные.
 *
 * ## Только чтение
 *
 * В модуле нет ни одной операции записи: обзор — это `readdir`/`readFile` и
 * ничего больше. Read-only — гарантия службы и UI, а не песочница (доски детей
 * могут физически лежать внутри workspace родителя; жёсткая изоляция — вне скоупа
 * спеки 004).
 *
 * Чистая часть (разбор карточки, слияние по свежести, нормализация статуса)
 * живёт в `watcher-core.js` и здесь переиспользуется — копий правил нет.
 */
import fs from "node:fs";
import path from "node:path";

import { markRemoteMethod, sessionCwdFromContext } from "./card-actions.js";
import { COLUMN_IDS, isNewer, normalizeStatus, parseCard, snapshotCards } from "./watcher-core.js";

/** Ключ контекста и namespace Remote-службы: endpoint — `<namespace>/<method>`. */
export const SERVICE_KEY = "kanbanChildren";
export const NAMESPACE = "kanbanChildren";

/** Имя манифеста в корне рабочей директории сессии. */
export const MANIFEST_FILE = ".kanban/children.json";

/** Каталоги рабочих деревьев доски ребёнка — те же, что у сторожа. */
const WORKTREES_DIRS = ["worktrees", ".worktrees"];

/** Предохранители: обзор не должен превращаться в обход диска без границ. */
const MAX_BOARDS = 200;
const MAX_CARDS = 2000;
const MAX_TEXT = 400;

/** `sessionId` — идентификатор сессии, а не произвольная строка. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;

/** Статусы, по которым клиент показывает счётчики (без `merged`). */
export const COUNTED_STATUSES = COLUMN_IDS.filter((status) => status !== "merged");

/** Короткий текст для провода: одна строка с обрезкой. */
function shortText(value) {
  const text = String(value == null ? "" : value)
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= MAX_TEXT ? text : text.slice(0, MAX_TEXT - 1) + "…";
}

/**
 * Проверить запрос из GUI.
 *
 * Клиент присылает только `sessionId`: путь к манифесту и доскам вычисляет хост
 * по каталогу сессии, поэтому протащить путь или команду через канал нельзя.
 * Служба только читает, поэтому изменяющих аргументов у неё нет вовсе.
 *
 * @param request - присланный объект.
 * @returns `{ ok: true, value }` или `{ ok: false, message }`.
 */
export function validateRequest(request) {
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    return { ok: false, message: "ожидался объект { sessionId }" };
  }
  const extra = Object.keys(request).filter((key) => key !== "sessionId");
  if (extra.length > 0) {
    return { ok: false, message: `лишние поля в запросе: ${extra.join(", ")}` };
  }
  const sessionId = typeof request.sessionId === "string" ? request.sessionId.trim() : "";
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return { ok: false, message: "неверный sessionId: ожидается идентификатор сессии" };
  }
  return { ok: true, value: { sessionId } };
}

/**
 * Заголовок доски: `title` из манифеста либо последний сегмент пути.
 *
 * @param boardPath - путь как записан в манифесте.
 * @param title - необязательный заголовок.
 * @returns Строка для списка досок.
 */
export function boardTitle(boardPath, title) {
  const explicit = String(title == null ? "" : title).trim();
  if (explicit !== "") return explicit;
  const parts = String(boardPath ?? "")
    .replace(/[/\\]+$/, "")
    .split(/[/\\]/)
    .filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : ".";
}

/**
 * Путь доски: абсолютный остаётся как есть, относительный считается от cwd.
 *
 * `~` не раскрывается: манифест — данные, а не шелл; путь с `~` попадёт в
 * `problems` доски как несуществующий.
 *
 * @param cwd - корень рабочей директории сессии.
 * @param boardPath - путь из манифеста.
 * @returns Абсолютный нормализованный путь.
 */
export function resolveBoardPath(cwd, boardPath) {
  const raw = String(boardPath ?? "").trim();
  if (raw === "") return "";
  return path.resolve(String(cwd), raw);
}

/**
 * Разобрать манифест.
 *
 * @param text - содержимое `.kanban/children.json`.
 * @returns `{ boards, problems }`: по записи на доску, с сохранением порядка.
 */
export function parseManifest(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text ?? ""));
  } catch (error) {
    return { boards: [], problems: [`манифест не разобран: ${error.message}`] };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { boards: [], problems: ["манифест должен быть объектом { version, boards }"] };
  }
  const list = Array.isArray(parsed.boards) ? parsed.boards : null;
  if (list === null) {
    return { boards: [], problems: ["в манифесте нет массива boards"] };
  }
  const boards = [];
  const problems = [];
  const seen = new Set();
  for (const [index, entry] of list.entries()) {
    if (index >= MAX_BOARDS) {
      problems.push(`досок больше ${MAX_BOARDS}: остальные не показаны`);
      break;
    }
    const raw = typeof entry === "string" ? entry : entry && typeof entry === "object" ? entry.path : null;
    const boardPath = typeof raw === "string" ? raw.trim() : "";
    if (boardPath === "") {
      problems.push(`запись доски №${index + 1} без path — пропущена`);
      continue;
    }
    if (seen.has(boardPath)) continue;
    seen.add(boardPath);
    const title = entry && typeof entry === "object" && typeof entry.title === "string" ? entry.title : "";
    boards.push({ path: boardPath, title: boardTitle(boardPath, title) });
  }
  return { boards, problems };
}

/**
 * Поля карточки, которых нет в ядре сторожа, но которые нужны панели деталей.
 *
 * `watcher-core.parseCard` читает только поля решения (`id`, `title`, `status`,
 * `owner`, `role`, `spec`, `updated`), потому что сторожу больше не нужно.
 * Обзору детей нужны ещё расход, ветка, заметка и первый абзац задачи — их
 * достаём здесь, не расширяя ядро.
 *
 * @param text - содержимое файла карточки.
 * @returns `{ tokens, usage, branch, since, note, body }`.
 */
export function cardExtras(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const extras = { tokens: "", usage: {}, branch: "", since: "", note: "", body: "" };
  let index = 0;
  if (lines[0]?.trim() === "---") {
    for (index = 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.trim() === "---") {
        index += 1;
        break;
      }
      const match = /^([A-Za-z_][A-Za-z0-9_]*):[ \t]*(.*)$/.exec(line);
      if (!match) continue;
      const [, key, rawValue] = match;
      let value = rawValue.trim();
      if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
        value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      }
      if (key === "tokens") extras.tokens = value;
      else if (key === "branch") extras.branch = value;
      else if (key === "since") extras.since = value;
      else if (key === "note") extras.note = value;
      else if (key.startsWith("tokens_")) extras.usage[key.slice("tokens_".length)] = value;
    }
  }
  // Описание — первый непустой абзац тела после front matter (как на доске).
  const body = [];
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "" && body.length === 0) continue;
    if (/^#{1,6}\s/.test(line)) continue;
    if (line.trim() === "") {
      if (body.length > 0) break;
      continue;
    }
    body.push(line.trim());
  }
  extras.body = shortText(body.join(" "));
  extras.note = shortText(extras.note);
  return extras;
}

/** Прочитать каталог карточек; `null` — каталога нет или он не читается. */
function readCards(dir, cardFile = "") {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const entries = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".md")) continue;
    if (name.toLowerCase() === "readme.md") continue;
    if (cardFile !== "" && name !== cardFile) continue;
    if (entries.length >= MAX_CARDS) break;
    try {
      entries.push([name, fs.readFileSync(path.join(dir, name), "utf8")]);
    } catch {
      /* файл исчез между чтением каталога и файла — не беда */
    }
  }
  return entries;
}

/**
 * Снять снимок доски ребёнка: основная доска плюс доски рабочих деревьев.
 *
 * Правила те же, что у сторожа и клиентской доски: из рабочего дерева берётся
 * только одноимённая карточка (остальные — эхо основной ветки), копии одной
 * карточки сливаются по свежести `updated`, при равенстве побеждает дерево.
 *
 * @param boardRoot - абсолютный путь доски.
 * @returns `{ cards, problems, missing }`.
 */
export function readBoardCards(boardRoot) {
  const problems = [];
  const sources = [{ dir: path.join(boardRoot, ".kanban", "tasks"), worktree: null, cardFile: "" }];
  for (const trees of WORKTREES_DIRS) {
    let names;
    try {
      names = fs.readdirSync(path.join(boardRoot, trees));
    } catch {
      continue; // деревьев этого вида нет — обычное дело
    }
    for (const name of names.sort()) {
      const dir = path.join(boardRoot, trees, name, ".kanban", "tasks");
      try {
        if (!fs.statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      sources.push({ dir, worktree: `${trees}/${name}`, cardFile: `${name}.md` });
    }
  }

  const merged = new Map();
  let found = false;
  for (const source of sources) {
    const entries = readCards(source.dir, source.cardFile);
    if (entries === null) {
      if (source.worktree === null) problems.push(`нет каталога карточек: ${path.join(boardRoot, ".kanban", "tasks")}`);
      continue;
    }
    if (source.worktree === null) found = true;
    const texts = new Map(entries.map(([name, text]) => [name.replace(/\.md$/, ""), text]));
    const liveId = source.cardFile ? source.cardFile.replace(/\.md$/, "") : "";
    for (const [id, card] of snapshotCards(entries)) {
      if (liveId !== "" && String(card.id) !== liveId) continue;
      const extras = cardExtras(texts.get(String(card.id)) ?? "");
      const candidate = {
        id: String(card.id),
        title: String(card.title ?? ""),
        status: normalizeStatus(card.status),
        owner: String(card.owner ?? ""),
        role: String(card.role ?? ""),
        spec: String(card.spec ?? ""),
        updated: String(card.updated ?? ""),
        source: source.worktree ? "worktree" : "main",
        worktree: source.worktree ?? "",
        tokens: extras.tokens,
        usage: extras.usage,
        branch: extras.branch,
        since: extras.since,
        note: extras.note,
        description: extras.body,
      };
      const current = merged.get(candidate.id);
      if (!current || isNewer(candidate, current)) merged.set(candidate.id, candidate);
    }
  }

  const cards = Array.from(merged.values()).sort((left, right) => String(left.id).localeCompare(String(right.id), "ru"));
  return { cards, problems, missing: !found };
}

/**
 * Счётчики карточек по статусам плюс карточки «в работе».
 *
 * @param cards - слитые карточки доски.
 * @returns `{ counts, inProgress }`.
 */
export function summarizeCards(cards) {
  const counts = {};
  for (const status of COUNTED_STATUSES) counts[status] = 0;
  const inProgress = [];
  for (const card of cards ?? []) {
    if (Object.prototype.hasOwnProperty.call(counts, card.status)) counts[card.status] += 1;
    if (card.status === "in-progress") {
      inProgress.push({ id: card.id, title: card.title, owner: card.owner, role: card.role, updated: card.updated });
    }
  }
  return { counts, inProgress };
}

/**
 * Обзор дочерних досок по манифесту в каталоге сессии.
 *
 * @param options - `{ cwd }`: корень рабочей директории сессии.
 * @returns `{ boards, problems, manifest }`.
 */
export function readOverview(options) {
  const cwd = String(options?.cwd ?? "");
  const manifestPath = path.join(cwd, MANIFEST_FILE);
  let text;
  try {
    text = fs.readFileSync(manifestPath, "utf8");
  } catch (error) {
    const hint = `манифеста нет: создайте ${MANIFEST_FILE} командой bin/board-children.sh --root <дерево>`;
    return {
      boards: [],
      problems: [error?.code === "ENOENT" ? hint : `манифест не прочитан: ${error?.message ?? error}`],
      manifest: "missing",
    };
  }

  const parsed = parseManifest(text);
  if (parsed.boards.length === 0) {
    return { boards: [], problems: parsed.problems, manifest: parsed.problems.length > 0 ? "broken" : "ok" };
  }

  const boards = [];
  const problems = [...parsed.problems];
  for (const entry of parsed.boards) {
    const absPath = resolveBoardPath(cwd, entry.path);
    let stats = null;
    try {
      stats = fs.statSync(absPath);
    } catch {
      boards.push({ path: entry.path, absPath, title: entry.title, ...summarizeCards([]), cards: [], problems: ["доска не найдена"], missing: true });
      continue;
    }
    if (!stats.isDirectory()) {
      boards.push({ path: entry.path, absPath, title: entry.title, ...summarizeCards([]), cards: [], problems: ["путь не каталог"], missing: true });
      continue;
    }
    const snapshot = readBoardCards(absPath);
    boards.push({
      path: entry.path,
      absPath,
      title: entry.title,
      ...summarizeCards(snapshot.cards),
      cards: snapshot.cards,
      problems: snapshot.problems,
      missing: snapshot.missing,
    });
  }
  return { boards, problems, manifest: "ok" };
}

/**
 * Собрать бизнес-часть службы обзора.
 *
 * Зависимости внедряются, чтобы логика проверялась без DSH:
 * `resolveSessionCwd(sessionId)` — корень рабочей директории сессии,
 * `readOverview({ cwd })` — чтение обзора (по умолчанию — с диска).
 *
 * @param options - `{ resolveSessionCwd, readOverview, log }`.
 * @returns `{ read }` — единственная операция службы, только чтение.
 */
export function createChildrenActions(options) {
  const resolveSessionCwd = options?.resolveSessionCwd;
  const read = typeof options?.readOverview === "function" ? options.readOverview : readOverview;
  const log = typeof options?.log === "function" ? options.log : () => {};

  const readOverviewFor = async (request) => {
    const checked = validateRequest(request);
    if (!checked.ok) return { ok: false, message: checked.message };
    const { sessionId } = checked.value;
    let cwd = null;
    try {
      cwd = await resolveSessionCwd?.(sessionId);
    } catch (error) {
      log("warn", `обзор детей: каталог сессии ${sessionId} не прочитан: ${error?.message ?? error}`);
      return { ok: false, message: "не удалось определить каталог сессии" };
    }
    if (typeof cwd !== "string" || cwd.length === 0) {
      return { ok: false, message: "сессия не найдена: каталог сессии неизвестен" };
    }
    let overview;
    try {
      overview = read({ cwd });
    } catch (error) {
      log("warn", `обзор детей: манифест в ${cwd} не прочитан: ${error?.message ?? error}`);
      return { ok: false, message: "обзор дочерних досок не прочитан: проверьте манифест" };
    }
    return {
      ok: true,
      value: {
        boards: Array.isArray(overview?.boards) ? overview.boards : [],
        problems: Array.isArray(overview?.problems) ? overview.problems : [],
        manifest: overview?.manifest === "missing" || overview?.manifest === "broken" ? overview.manifest : "ok",
      },
    };
  };

  return { read: (request) => readOverviewFor(request) };
}

/**
 * Служба обзора для Gateway.
 *
 * Метод — обычный `async` с одним простым параметром: SRC-режим Gateway читает
 * имена параметров из исходника метода и не принимает деструктуризацию.
 */
class ChildrenService {
  constructor(actions) {
    this.actions = actions;
  }

  async read(request) {
    return this.actions.read(request);
  }
}

markRemoteMethod(ChildrenService.prototype, "read");

/**
 * Зарегистрировать службу обзора в host-контексте.
 *
 * @param ctx - cordis-контекст плагина (host-половина).
 * @param options - то же, что у `createChildrenActions`, плюс необязательный `log`.
 * @returns `{ service, dispose }`: служба (для тестов) и disposer регистрации.
 */
export function registerChildrenService(ctx, options) {
  const actions = createChildrenActions(options);
  const service = new ChildrenService(actions);
  service.typertRemote = Object.freeze({ service, serviceKey: SERVICE_KEY, namespace: NAMESPACE });
  const dispose = ctx.provide(SERVICE_KEY, service);
  return { service, dispose };
}

/** Переиспользуемый из `index.js` резолвер каталога сессии (общий с каналом). */
export { sessionCwdFromContext };
