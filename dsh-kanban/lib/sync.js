/**
 * Синхронизация локальных карточек с `kanban-hub` (M1, issue #072).
 *
 * Файлы `.kanban/tasks/*.md` остаются локальной правдой; хаб — общий обмен.
 * За один проход:
 * 1. pull — что изменилось на хабе после курсора `updated_at`;
 * 2. push — локальные карточки, чей хэш изменился: claim lease → upsert
 *    снимка с `base_rev` → release;
 * 3. отметки в `.kanban/.sync/state.json`, remote-карточки в `remote.json`.
 *
 * При недоступном хабе проход не падает: dirty-карточки остаются локально и
 * уйдут в следующий раз. Чужой/устаревший lease — `409`, карточка не
 * перезаписывается.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseCard } from "./watcher-core.js";

const SYNC_DIR = ".kanban/.sync";
const STATE_FILE = "state.json";
const REMOTE_FILE = "remote.json";
const LAST_RUN_FILE = "last-run.json";
const DEFAULT_INTERVAL_MS = 30_000;
const HTTP_TIMEOUT_MS = 10_000;

function positive(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Number(value) : fallback;
}

/** Настройки `sync` из конфига строки плагина. */
export function syncSettings(config = {}) {
  const raw = config?.sync && typeof config.sync === "object" ? config.sync : {};
  const hubUrl = String(raw.hubUrl ?? "").trim().replace(/\/+$/, "");
  const token = String(raw.token ?? "");
  return {
    enabled: raw.enabled === true && hubUrl !== "" && token !== "",
    hubUrl,
    project: String(raw.project ?? "default").trim() || "default",
    token,
    instanceId: String(raw.instanceId ?? "instance").trim() || "instance",
    userId: String(raw.userId ?? "").trim(),
    intervalMs: positive(raw.intervalMs, DEFAULT_INTERVAL_MS),
    /** Доска, которую синхронизируем; по умолчанию — первая из `boards`. */
    board: raw.board ? path.resolve(String(raw.board)) : null,
  };
}

function syncDir(board) {
  return path.join(board, SYNC_DIR);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

/** Стабильная строка JSON: одинаковый хэш для одинакового снимка. */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Хэш карточки без служебного `broken`. */
export function cardHash(card) {
  const snapshot = { ...card };
  delete snapshot.broken;
  return crypto.createHash("sha256").update(stableStringify(snapshot)).digest("hex");
}

/** Локальные карточки: `id → { card, hash }`. */
export function readLocalCards(board) {
  const tasks = path.join(board, ".kanban", "tasks");
  let names;
  try {
    names = fs.readdirSync(tasks).filter((name) => name.endsWith(".md") && name !== "README.md");
  } catch {
    return new Map();
  }
  const cards = new Map();
  for (const name of names) {
    let card;
    try {
      card = parseCard(fs.readFileSync(path.join(tasks, name), "utf8"));
    } catch {
      continue;
    }
    if (!card || card.broken) continue;
    cards.set(String(card.id), { card, hash: cardHash(card) });
  }
  return cards;
}

function loadState(board) {
  const value = readJson(path.join(syncDir(board), STATE_FILE), null);
  return value && typeof value === "object"
    ? { cursor: Number(value.cursor ?? 0), cards: value.cards ?? {} }
    : { cursor: 0, cards: {} };
}

function saveState(board, state) {
  writeJson(path.join(syncDir(board), STATE_FILE), state);
}

async function request(settings, pathname, { method = "GET", body, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${settings.hubUrl}${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${settings.token}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    try {
      data = text === "" ? null : JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    return { status: response.status, data };
  } finally {
    clearTimeout(timer);
  }
}

function projectPath(settings, suffix) {
  return `/v1/projects/${encodeURIComponent(settings.project)}${suffix}`;
}

/**
 * Один проход синка.
 *
 * @returns `{ enabled, pulled, pushed, skipped, conflicts, errors, cursor }`.
 */
export async function syncOnce({ board, settings, fetchImpl = fetch, log = () => {} } = {}) {
  const summary = { enabled: false, pulled: 0, pushed: 0, skipped: 0, conflicts: 0, errors: 0, cursor: 0 };
  if (!board || !settings?.enabled) return summary;
  summary.enabled = true;
  const state = loadState(board);

  // 1. pull
  const hubCards = new Map();
  let pullOk = false;
  try {
    const pulled = await request(settings, projectPath(settings, `/cards?since=${state.cursor}`), { fetchImpl });
    if (pulled.status !== 200) throw new Error(`hub pull ${pulled.status}: ${JSON.stringify(pulled.data)}`);
    for (const card of pulled.data?.cards ?? []) {
      hubCards.set(String(card.id), card);
      state.cursor = Math.max(state.cursor, Number(card.updated_at ?? 0));
      summary.pulled += 1;
    }
    const remote = [...hubCards.values()].filter((card) => card?.lease?.instance !== settings.instanceId);
    writeJson(path.join(syncDir(board), REMOTE_FILE), {
      syncedAt: new Date().toISOString(),
      project: settings.project,
      cards: remote,
    });
    pullOk = true;
  } catch (error) {
    summary.errors += 1;
    log("warn", `sync pull: ${error?.message ?? error}`);
  }

  // 2. push
  if (pullOk) {
    const locals = readLocalCards(board);
    for (const [id, local] of locals) {
      if (state.cards[id]?.hash === local.hash) {
        summary.skipped += 1;
        continue;
      }
      const hub = hubCards.get(id);
      try {
        let baseRev = 0;
        let claimed = false;
        if (!hub) {
          // Новую карточку создаёт upsert с base_rev=0; хаб выдаёт lease создателю.
          claimed = true;
        }
        if (hub) {
          const claim = await request(settings, projectPath(settings, `/cards/${encodeURIComponent(id)}/claim`), {
            method: "POST",
            body: { instance: settings.instanceId, user: settings.userId || settings.instanceId },
            fetchImpl,
          });
          if (claim.status === 409) {
            summary.conflicts += 1;
            log("info", `sync: ${id} держит другой инстанс, пропускаю`);
            continue;
          }
          if (claim.status !== 200) throw new Error(`claim ${claim.status}: ${JSON.stringify(claim.data)}`);
          baseRev = Number(claim.data?.rev ?? 0);
          claimed = true;
        }
        const upsert = await request(settings, projectPath(settings, `/cards/${encodeURIComponent(id)}`), {
          method: "PUT",
          body: {
            instance: settings.instanceId,
            user: settings.userId || settings.instanceId,
            base_rev: baseRev,
            payload: local.card,
          },
          fetchImpl,
        });
        if (upsert.status === 409) {
          summary.conflicts += 1;
          log("info", `sync: ${id} устарел на хабе, перечитаю в следующий раз`);
        } else if (upsert.status !== 200) {
          throw new Error(`upsert ${upsert.status}: ${JSON.stringify(upsert.data)}`);
        } else {
          state.cards[id] = { hash: local.hash, rev: Number(upsert.data?.rev ?? baseRev + 1), syncedAt: new Date().toISOString() };
          summary.pushed += 1;
        }
        if (claimed) {
          await request(settings, projectPath(settings, `/cards/${encodeURIComponent(id)}/release`), {
            method: "POST",
            body: { instance: settings.instanceId },
            fetchImpl,
          });
        }
      } catch (error) {
        summary.errors += 1;
        log("warn", `sync push ${id}: ${error?.message ?? error}`);
        break;
      }
    }
  }

  state.updatedAt = new Date().toISOString();
  saveState(board, state);
  writeJson(path.join(syncDir(board), LAST_RUN_FILE), {
    at: new Date().toISOString(),
    summary,
    project: settings.project,
    instanceId: settings.instanceId,
  });
  return summary;
}

/** Статус последнего прохода (для CLI/doctor). */
export function syncStatus(board) {
  return {
    state: loadState(board),
    remote: readJson(path.join(syncDir(board), REMOTE_FILE), { cards: [] }),
    lastRun: readJson(path.join(syncDir(board), LAST_RUN_FILE), null),
  };
}
