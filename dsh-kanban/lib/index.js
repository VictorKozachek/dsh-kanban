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
 * Кроме переходов, сторож закрывает поток `backlog` (`./backlog-notices.js`):
 * асайн — карточка пришла в `todo` с владельцем — и пополнение — в `todo` стало
 * меньше `minTodo` из `.kanban/board.json`. Недобор будит оркестратора один раз
 * на состояние: файл состояния хранит ключ `board:refill:short`, пока `todo` не
 * доберёт до минимума.
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
import { deliveryKey, planNotices, snapshotCards } from "./watcher-core.js";
import {
  DEFAULT_MIN_TODO,
  REFILL_KEY,
  parseMinTodo,
  planAssignmentNotices,
  planRefillNotice,
} from "./backlog-notices.js";

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

/**
 * Прочитать минимум карточек в `todo` из `.kanban/board.json`.
 *
 * Файла нет или он битый — считаем `DEFAULT_MIN_TODO` (1): доска обязана
 * работать и без конфига.
 */
function readMinTodo(file) {
  try {
    return parseMinTodo(fs.readFileSync(file, "utf8"));
  } catch {
    return DEFAULT_MIN_TODO;
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

/** Роли доски: id пресета совпадает с именем роли, но допускаем префикс `preset-`. */
const ROLES = ["dispatcher", "worker", "reviewer", "verifier"];

/** Файл автокарты ролей — рядом с состоянием сторожа, в `.gitignore`. */
const ROLES_FILE = ".watcher-roles.json";

/** Файл недоставленных нарядов: их повторяем при следующем старте профиля. */
const PENDING_FILE = ".watcher-pending.json";

/** Роль по id пресета: `reviewer` и `preset-reviewer` — это одно и то же. */
function roleOfPreset(agentPreset) {
  const name = String(agentPreset ?? "").replace(/^preset-/, "");
  return ROLES.includes(name) ? name : null;
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
    const configuredRoles = config?.roles && typeof config.roles === "object" ? config.roles : {};
    // Эффективная карта ролей: ручные id из строки плагина главнее автокарты.
    const roles = { ...configuredRoles };
    // Паузы настраиваются: тесты доставки берут короткие, живой профиль — обычные.
    const debounceMs = Number.isFinite(config?.debounceMs) ? Number(config.debounceMs) : DEBOUNCE_MS;
    const catchUpMs = Number.isFinite(config?.catchUpMs) ? Number(config.catchUpMs) : CATCH_UP_MS;
    if (boards.length === 0) {
      log(ctx, "info", "сторож доски выключен: в конфиге плагина нет boards");
      return;
    }

    const watchers = [];
    const timers = [];
    /** Повторный обход досок: нужен, когда роль появляется позже карточки. */
    const reannounce = [];

    for (const board of boards) {
      const tasksDir = path.join(String(board), ".kanban", "tasks");
      const stateFile = path.join(String(board), ".kanban", ".watcher-state.json");
      // Минимум карточек в `todo` (`.kanban/board.json`): по нему решается, пора ли
      // будить оркестратора. Читаем на каждый обход — конфиг может поправить сам
      // оркестратор, а файл дешёвый.
      const boardFile = path.join(String(board), ".kanban", "board.json");
      let previous = readSnapshot(tasksDir);
      if (previous === null) {
        log(ctx, "warn", `нет каталога карточек: ${tasksDir}`);
        continue;
      }

      // Автокарту ролей читаем с доски: она переживает перезапуск профиля.
      // Ручной конфиг главнее — он остаётся на случай, когда событие не пришло.
      for (const [role, sessionId] of Object.entries(loadState(path.join(String(board), ".kanban", ROLES_FILE)))) {
        if (!configuredRoles[role] && !roles[role]) roles[role] = String(sessionId);
      }

      const state = loadState(stateFile);
      const pendingFile = path.join(String(board), ".kanban", PENDING_FILE);
      const pending = loadState(pendingFile);
      // Налярд мог дойти позже, уже после неудачной попытки: такой след не нужен.
      for (const key of Object.keys(pending)) {
        if (state[key]) delete pending[key];
      }
      // Ключи, наряды по которым уже в полёте: файл состояния пишется только после
      // успешной доставки, поэтому без этого набора два обхода (стартовый и по
      // появлению роли, или стартовый и повтор недоставленного) успевают запланировать
      // один и тот же наряд дважды.
      const inFlight = new Set();
      const deliverOnce = (key, item) => {
        if (state[key] || inFlight.has(key)) return;
        inFlight.add(key);
        void deliver(ctx, item).then((accepted) => {
          inFlight.delete(key);
          if (!accepted) {
            // Наряд не дошёл — запоминаем, чтобы повторить при следующем старте.
            // Иначе возврат владельцу теряется молча, если его сессию пересоздали.
            pending[key] = {
              cardId: item.cardId,
              status: item.status,
              sessionId: item.sessionId,
              text: item.text,
              at: new Date().toISOString(),
            };
            saveState(pendingFile, pending);
            return;
          }
          state[key] = new Date().toISOString();
          saveState(stateFile, state);
          if (pending[key]) {
            delete pending[key];
            saveState(pendingFile, pending);
          }
        });
      };

      /**
       * Сигнал о недоборе `todo`: один наряд на недобор, а не на каждый тик доски.
       *
       * Недобор — состояние доски, поэтому снимаем сигнал (ключ в файле состояния)
       * ровно тогда, когда `todo` добрал до минимума: следующий недобор снова
       * разбудит оркестратора.
       */
      const announceRefill = (next) => {
        let plan;
        try {
          plan = planRefillNotice(next, { minTodo: readMinTodo(boardFile), dispatcher: roles.dispatcher });
        } catch (error) {
          log(ctx, "warn", `не разобрал пополнение todo: ${error?.message ?? error}`);
          return;
        }
        if (plan.short) {
          if (plan.notice) deliverOnce(REFILL_KEY, plan.notice);
          return;
        }
        let stateDropped = false;
        let pendingDropped = false;
        if (state[REFILL_KEY]) {
          delete state[REFILL_KEY];
          stateDropped = true;
        }
        if (pending[REFILL_KEY]) {
          // Недоставленный сигнал того же недобора: недобора больше нет — повторять
          // нечего.
          delete pending[REFILL_KEY];
          pendingDropped = true;
        }
        if (stateDropped) saveState(stateFile, state);
        if (pendingDropped) saveState(pendingFile, pending);
      };

      const announce = (before, next) => {
        let notices = [];
        try {
          notices = planNotices(before, next, roles);
        } catch (error) {
          log(ctx, "warn", `не разобрал переходы доски: ${error?.message ?? error}`);
          return;
        }
        // Асайн из `backlog` (`todo` с владельцем) ядро не объявляет — это не переход
        // статуса, а выдача задачи конкретному исполнителю.
        try {
          notices = notices.concat(planAssignmentNotices(before, next));
        } catch (error) {
          log(ctx, "warn", `не разобрал асайны доски: ${error?.message ?? error}`);
        }
        for (const item of notices) {
          // У асайна свой ключ: он учитывает владельца, иначе перепривязка в `todo`
          // осталась бы без наряда.
          deliverOnce(item.key ?? deliveryKey(next.get(item.cardId), item.status), item);
        }
        announceRefill(next);
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
          // Прошлый запуск не смог доставить наряд — пробуем снова. Идём через тот
          // же deliverOnce: если объявление выше уже взяло наряд в работу, повтор
          // не отправит второе сообщение.
          for (const [key, item] of Object.entries(pending)) {
            const card = previous.get(item.cardId);
            // След мог устареть: карточка уехала дальше или её уже нет на доске.
            // Такой наряд отправлять нечего — молча снимаем, иначе он висел бы в
            // файле и повторялся при каждом старте.
            if (!card || card.status !== item.status) {
              delete pending[key];
              saveState(pendingFile, pending);
              continue;
            }
            deliverOnce(key, item);
          }
        }, catchUpMs),
      );

      // Тот же обход с пустым «предыдущим»: зовём, когда роль появилась позже
      // карточки, которая её ждёт. Повторов не будет — доставленные наряды лежат
      // в файле состояния по ключу id:status:updated.
      reannounce.push(() => announce(new Map(), previous));

      // 2. Переходы: следим за каталогом и разбираем изменения.
      let timer = null;
      const tick = () => {
        timer = null;
        const next = readSnapshot(tasksDir);
        if (next === null) return;
        const before = previous;
        previous = next;
        announce(before, next);
      };

      try {
        const watcher = fs.watch(tasksDir, () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(tick, debounceMs);
          // Таймер паузы тоже отслеживаем: иначе после dispose он выстрелит ещё раз.
          timers.push(timer);
        });
        watchers.push(watcher);
      } catch (error) {
        log(ctx, "warn", `не слежу за ${tasksDir}: ${error?.message ?? error}`);
      }
    }

    // Роль сессии узнаём сами: DSH объявляет выбор пресета глобальным событием
    // `agent-preset/selected` (sessionId, agentPreset) — см. dsh-agent-presets.
    // Так id ролей не приходится держать руками, и они не стареют, когда сессию
    // роли пересоздают: новая сессия снова выберет пресет и снова объявится.
    const persistRoles = () => {
      const auto = {};
      for (const role of ROLES) {
        if (!configuredRoles[role] && roles[role]) auto[role] = roles[role];
      }
      for (const board of boards) {
        saveState(path.join(String(board), ".kanban", ROLES_FILE), auto);
      }
    };
    ctx.on?.("agent-preset/selected", (sessionId, agentPreset) => {
      const role = roleOfPreset(agentPreset);
      if (!role || configuredRoles[role]) return;
      const id = String(sessionId ?? "");
      if (!id || roles[role] === id) return;
      roles[role] = id;
      persistRoles();
      log(ctx, "info", `роль ${role} закреплена за сессией ${id} (пресет ${agentPreset})`);
      // Карточки, которые ждали роль до её появления, иначе остались бы без наряда
      // до следующего перехода: сессия роли выбирает пресет один раз при создании.
      for (const again of reannounce) {
        try {
          again();
        } catch (error) {
          log(ctx, "warn", `не объявил доску после появления роли: ${error?.message ?? error}`);
        }
      }
    });

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
