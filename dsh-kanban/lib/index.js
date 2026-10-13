/**
 * Host-половина плагина `dsh-kanban`: сторож доски.
 *
 * Зачем: доска — это файлы, и роль узнаёт о работе, только когда ей напишут.
 * Сторож следит за `.kanban/tasks` и сам отправляет наряд в нужную сессию:
 * карточка вернулась в `in-progress` — будит исполнителя, ушла в `in-review` —
 * ревьювера, в `testing` — тестировщика, в `ready` — оркестратора.
 *
 * Сообщение в сессию отправляется тем же сервисом, которым пользуется GUI
 * (`sessionController.prompt`, режим `queue` — обычное сообщение в очередь).
 *
 * Конфиг (в строке плагина, `config`):
 *   boards: ["/путь/к/проекту"]      — где искать `.kanban/tasks`
 *   roles: { reviewer, verifier, dispatcher } — id сессий ролей
 * Без `boards` сторож выключен, без `roles` будит только владельцев карточек.
 *
 * Браузерная половина (`./client`) от этой не зависит, поэтому вся обвязка
 * обёрнута в try/catch: сломанный сторож не должен уронить загрузку плагина.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { planNotices, snapshotCards } from "./watcher-core.js";

/** Сервис, которым GUI отправляет сообщение в сессию. */
export const inject = ["sessionController"];
apply.inject = inject;

/** Пауза после события файловой системы: карточка пишется одним коммитом. */
const DEBOUNCE_MS = 400;

/** Лог плагина: у cordis логгер может быть и функцией, и объектом. */
function log(ctx, level, message) {
  try {
    const logger = typeof ctx.logger === "function" ? ctx.logger("dsh-kanban") : ctx.logger;
    logger?.[level]?.(message);
  } catch {
    /* лог не должен мешать работе */
  }
}

/** Прочитать снимок доски; `null` — каталога нет или он недоступен. */
function readSnapshot(tasksDir) {
  let names;
  try {
    names = fs.readdirSync(tasksDir);
  } catch {
    return null;
  }
  const entries = [];
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    try {
      entries.push([name, fs.readFileSync(path.join(tasksDir, name), "utf8")]);
    } catch {
      /* файл исчез между чтением каталога и файла — не беда */
    }
  }
  return snapshotCards(entries);
}

/** Отправить один наряд в сессию. */
async function deliver(ctx, item) {
  const service = ctx.sessionController;
  if (!service || typeof service.prompt !== "function") {
    log(ctx, "warn", "нет сервиса sessionController — наряд не отправлен");
    return;
  }
  try {
    await service.prompt(
      {
        requestId: randomUUID(),
        sessionId: item.sessionId,
        mode: "queue",
        content: [{ type: "text", text: item.text }],
      },
      new AbortController().signal,
    );
    log(ctx, "info", `наряд по #${item.cardId} (${item.kind}) → ${item.sessionId}`);
  } catch (error) {
    log(ctx, "warn", `наряд по #${item.cardId} не доставлен (${item.sessionId}): ${error?.message ?? error}`);
  }
}

/**
 * Включить сторож: по одному наблюдению на каждый корень из конфига.
 *
 * @param ctx - контекст плагина.
 * @param config - `{ boards, roles }` из строки плагина.
 */
export function apply(ctx, config = {}) {
  try {
    const boards = Array.isArray(config?.boards) ? config.boards : [];
    const roles = config?.roles && typeof config.roles === "object" ? config.roles : {};
    if (boards.length === 0) {
      log(ctx, "info", "сторож доски выключен: в конфиге плагина нет boards");
      return;
    }

    const watchers = [];
    for (const board of boards) {
      const tasksDir = path.join(String(board), ".kanban", "tasks");
      let previous = readSnapshot(tasksDir);
      if (previous === null) {
        log(ctx, "warn", `нет каталога карточек: ${tasksDir}`);
        continue;
      }

      let timer = null;
      const tick = () => {
        timer = null;
        const next = readSnapshot(tasksDir);
        if (next === null) return;
        const before = previous;
        previous = next;
        let notices = [];
        try {
          notices = planNotices(before, next, roles);
        } catch (error) {
          log(ctx, "warn", `не разобрал переходы доски: ${error?.message ?? error}`);
          return;
        }
        for (const item of notices) void deliver(ctx, item);
      };

      try {
        const watcher = fs.watch(tasksDir, () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(tick, DEBOUNCE_MS);
        });
        watchers.push(watcher);
      } catch (error) {
        log(ctx, "warn", `не слежу за ${tasksDir}: ${error?.message ?? error}`);
      }
    }

    if (watchers.length > 0) {
      log(ctx, "info", `сторож доски следит за ${watchers.length} каталог(ом/ами)`);
      ctx.on?.("dispose", () => {
        for (const watcher of watchers) {
          try {
            watcher.close();
          } catch {
            /* уже закрыт */
          }
        }
      });
    }
  } catch (error) {
    log(ctx, "warn", `сторож доски не запустился: ${error?.message ?? error}`);
  }
}
