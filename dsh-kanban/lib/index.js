/**
 * Host-половина плагина `dsh-kanban`: сторож доски.
 *
 * Зачем: доска — это файлы, и роль узнаёт о работе, только когда ей напишут.
 * Сторож следит за `.kanban/tasks` и сам отправляет наряд в нужную сессию:
 * карточка вернулась в `in-progress` — будит исполнителя, ушла в `in-review` —
 * ревьювера, в `testing` — тестировщика, в `ready` — оркестратора.
 *
 * Сообщение в сессию отправляется тем же сервисом, которым пользуется GUI
 * (`sessionController.prompt`, режим `queue` — обычное сообщение в очередь,
 * занятая сессия его не теряет).
 *
 * Два случая, которые обязан закрыть сторож:
 *   1. переход — кто-то подвинул карточку, пока сторож работает;
 *   2. старт — карточка уже ждёт роль (её подвинули до запуска или пока сторож
 *      спал). Иначе карточка, застрявшая в `in-review`, так и висела бы молча.
 * От повторов при перезапусках спасает файл состояния: наряд помечается
 * отправленным для конкретной версии карточки (`id:status:updated`).
 *
 * Конфиг (в строке плагина, `config`):
 *   boards: ["/путь/к/проекту"]      — где искать `.kanban/tasks`
 *   roles: { reviewer, verifier, dispatcher } — id сессий ролей
 * Без `boards` сторож выключен, без `roles` будит только владельцев карточек.
 *
 * Браузерная половина (`./client`) от этой не зависят, поэтому вся обвязка
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

/** Пауза перед разбором «что уже ждёт роль»: дать профилю подняться. */
const CATCH_UP_MS = 2000;

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

/** Ключ доставки: одна версия карточки в одном статусе объявляется один раз. */
function deliveryKey(cardId, status, updated) {
  return `${cardId}:${status}:${updated ?? ""}`;
}

function loadState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveState(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    /* состояние — подсказка, а не источник правды: не сохранилось, переживём */
  }
}

/** Отправить один наряд в сессию; `true` — принят. */
async function deliver(ctx, item) {
  const service = ctx.sessionController;
  if (!service || typeof service.prompt !== "function") {
    log(ctx, "warn", "нет сервиса sessionController — наряд не отправлен");
    return false;
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
    return true;
  } catch (error) {
    log(ctx, "warn", `наряд по #${item.cardId} не доставлен (${item.sessionId}): ${error?.message ?? error}`);
    return false;
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
    const timers = [];

    for (const board of boards) {
      const tasksDir = path.join(String(board), ".kanban", "tasks");
      const stateFile = path.join(String(board), ".kanban", ".watcher-state.json");
      let previous = readSnapshot(tasksDir);
      if (previous === null) {
        log(ctx, "warn", `нет каталога карточек: ${tasksDir}`);
        continue;
      }

      const state = loadState(stateFile);
      const announced = new Map();
      const announce = (before, next) => {
        let notices = [];
        try {
          notices = planNotices(before, next, roles);
        } catch (error) {
          log(ctx, "warn", `не разобрал переходы доски: ${error?.message ?? error}`);
          return;
        }
        for (const item of notices) {
          const key = deliveryKey(item.cardId, item.status, next.get(item.cardId)?.updated);
          if (state[key]) continue;
          void deliver(ctx, item).then((accepted) => {
            if (!accepted) return;
            state[key] = new Date().toISOString();
            saveState(stateFile, state);
          });
        }
      };

      // 1. Что уже ждёт роль: карточка могла зависнуть в in-review/testing/ready
      //    до запуска сторожа. Повторов не будет — их гасит файл состояния.
      timers.push(
        setTimeout(() => {
          try {
            announce(new Map(), previous);
          } catch (error) {
            log(ctx, "warn", `не разобрал стартовое состояние доски: ${error?.message ?? error}`);
          }
        }, CATCH_UP_MS),
      );

      // 2. Переходы: следим за каталогом и разбираем изменения.
      let timer = null;
      const tick = () => {
        timer = null;
        const next = readSnapshot(tasksDir);
        if (next === null) return;
        const before = previous;
        previous = next;
        announced.clear();
        announce(before, next);
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

    log(ctx, "info", `сторож доски: каталогов ${watchers.length}, ролей ${Object.keys(roles).length}`);
    ctx.on?.("dispose", () => {
      for (const watcher of watchers) {
        try {
          watcher.close();
        } catch {
          /* уже закрыт */
        }
      }
      for (const timer of timers) clearTimeout(timer);
    });
  } catch (error) {
    log(ctx, "warn", `сторож доски не запустился: ${error?.message ?? error}`);
  }
}
