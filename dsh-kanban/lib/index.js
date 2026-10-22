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
 * Доска собирается из нескольких источников: `.kanban/tasks` основного чекаута и
 * доски рабочих деревьев (`worktrees/*`, `.worktrees/*`) — открытая задача живёт
 * в своём дереве, и без обхода деревьев её переходы невидимы. Записи сливаются по
 * `id`: побеждает более свежий `updated`, при равенстве — копия из дерева (та же
 * семантика, что в клиентской половине). Если карточка живёт в дереве, текст
 * наряда указывает этот каталог: работать надо там.
 *
 * Конфиг (в строке плагина, `config`):
 *   boards: ["/путь/к/проекту"]      — где искать `.kanban/tasks`
 *   roles: { reviewer, verifier, dispatcher } — id сессий ролей
 * Без `boards` сторож выключен, без `roles` будит только владельцев карточек.
 *
 * Кроме сторожа, здесь поднимается командный канал клиент→хост
 * (`./card-actions.js`): GUI может попросить асайн карточки из `backlog` или
 * возврат в `backlog` из `todo`, а хост валидирует запрос и запускает
 * `bin/task-assign.sh` в корне доски. Канал — обычный Typert Remote в режиме
 * SRC: служба `kanbanCardActions` с методами `assign`/`unassign`. Подробности,
 * обоснование выбора канала и wire-контракт — в шапке `card-actions.js`.
 *
 * Браузерная половина (`./client`) от этой не зависят, поэтому вся обвязка
 * обёрнута в try/catch: сломанный сторож не должен уронить загрузку плагина.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { deliveryKey, isNewer, planNotices, snapshotCards } from "./watcher-core.js";
import {
  DEFAULT_MIN_TODO,
  REFILL_KEY,
  parseMinTodo,
  planAssignmentNotices,
  planRefillNotice,
} from "./backlog-notices.js";
import {
  NAMESPACE,
  registerCardActionsService,
  runAssignScript,
  sessionCwdFromContext,
} from "./card-actions.js";

/** Сервис, которым GUI отправляет сообщение в сессию. */
export const inject = ["sessionController"];
apply.inject = inject;

/**
 * Самопроверка командного канала: видит ли Gateway объявленные endpoint'ы.
 *
 * Запускается НЕ синхронно в `apply`: в момент загрузки плагина gateway может
 * быть ещё не смонтирован, и `claimsEndpoint` вернул бы false — в логе появился
 * бы ложный warn «не объявил», хотя канал работает. Поэтому проба идёт после
 * стартовой паузы (`catchUpMs`, как у стартового обхода сторожа), а сообщения
 * различают три состояния: «не проверено» (gateway не готов или не умеет
 * проверку), «endpoint не объявлен» и «видит endpoint».
 *
 * Уровни нарочно разные: «не проверено» — это `info` (нормальный ход событий, а
 * не поломка: оркестратор не должен принимать его за сбой), `warn` остаётся
 * только для настоящего «endpoint не объявлен».
 *
 * @param ctx - контекст плагина.
 */
function probeCardChannel(ctx) {
  const gateway = ctx.get?.("typertGateway");
  if (!gateway) {
    // `info`, а не `warn`: gateway может смонтироваться после пробы — это штатный
    // ход старта, и пугать оркестратора поломкой не нужно.
    log(ctx, "info", "канал асайна: не проверено — gateway ещё не готов (typertGateway не смонтирован)");
    return;
  }
  if (typeof gateway.claimsEndpoint !== "function") {
    log(ctx, "info", "канал асайна: не проверено — gateway не отдаёт claimsEndpoint");
    return;
  }
  let claimed = false;
  try {
    claimed = gateway.claimsEndpoint(`${NAMESPACE}/assign`) === true;
  } catch (error) {
    claimed = false;
  }
  if (claimed) {
    log(ctx, "info", `канал асайна: Gateway видит endpoint ${NAMESPACE}/assign`);
  } else {
    log(ctx, "warn", `канал асайна: gateway не объявил endpoint ${NAMESPACE}/assign — проверьте Typert-маркеры`);
  }
}

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

/**
 * Каталоги рабочих деревьев задач внутри проекта: оба имени встречаются в
 * проекте (`worktrees` — основной, `.worktrees` — прежние раскладки).
 */
const WORKTREES_DIRS = ["worktrees", ".worktrees"];

/** Каталог карточек основного чекаута — единственный обязательный источник. */
function mainTasksDir(root) {
  return path.join(root, ".kanban", "tasks");
}

/**
 * Источники снимка доски: основной чекаут и доски рабочих деревьев.
 *
 * Открытая задача живёт в своём дереве (`worktrees/<id>`, где своя копия
 * `.kanban/tasks` из ветки задачи), поэтому без обхода деревьев её переходы для
 * сторожа невидимы. Манифест `.kanban/worktrees.json` (деревья за пределами
 * проекта) здесь не читается — это отдельная задача.
 *
 * @param root - корень проекта из `config.boards`.
 * @returns Список `{ dir, worktree, cardFile }`; `worktree` — путь дерева
 *   относительно корня проекта, `null` — основная доска; `cardFile` — единственный
 *   файл, который в этом источнике считается живой карточкой задачи (пусто —
 *   читать все).
 */
function boardSources(root) {
  const sources = [{ dir: mainTasksDir(root), worktree: null, cardFile: "" }];
  for (const trees of WORKTREES_DIRS) {
    let names;
    try {
      names = fs.readdirSync(path.join(root, trees));
    } catch {
      continue; // деревьев этого вида нет — обычное дело
    }
    for (const name of names) {
      const dir = path.join(root, trees, name, ".kanban", "tasks");
      try {
        if (!fs.statSync(dir).isDirectory()) continue;
      } catch {
        continue; // не дерево (файл, мусор) или исчезло между обходом и проверкой
      }
      // Дерево ветвится от основной ветки и наследует все карточки, поэтому живая
      // карточка задачи — только одноимённая с деревом. Остальные копии — эхо
      // основной ветки, и приписывать им чужое дерево нельзя (иначе наряд позовёт
      // править чужую задачу в чужой ветке). То же правило в клиентской половине
      // (`lib/client.js`) и в `bin/board-status.mjs`.
      sources.push({ dir, worktree: `${trees}/${name}`, cardFile: `${name}.md` });
    }
  }
  return sources;
}

/**
 * Каталоги, события в которых могут изменить снимок: сама доска, доски деревьев
 * и родительские `worktrees/` — по ним видно появление и удаление дерева.
 *
 * Если каталога деревьев ещё нет, следим за корнем проекта: так замечается его
 * создание, иначе первое дерево появилось бы без единого события и сторож узнал
 * бы о нём только при следующем переходе в основной доске. Событий от корня
 * немного (только создание и удаление записей в нём), а обход по ним дешёвый и
 * дедуплицированный.
 */
function watchDirs(root) {
  const dirs = new Set([mainTasksDir(root)]);
  for (const source of boardSources(root)) dirs.add(source.dir);
  for (const trees of WORKTREES_DIRS) {
    const parent = path.join(root, trees);
    try {
      if (fs.statSync(parent).isDirectory()) {
        dirs.add(parent);
        continue;
      }
    } catch {
      /* деревьев этого вида пока нет */
    }
    dirs.add(root);
  }
  return dirs;
}

/**
 * Прочитать карточки каталога; `null` — каталог недоступен.
 *
 * @param dir - каталог карточек.
 * @param cardFile - читать только этот файл (доска рабочего дерева), пусто — все.
 */
function readCards(dir, cardFile = "") {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const entries = [];
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    if (cardFile !== "" && name !== cardFile) continue;
    try {
      entries.push([name, fs.readFileSync(path.join(dir, name), "utf8")]);
    } catch {
      /* файл исчез между чтением каталога и файла — не беда */
    }
  }
  return entries;
}

/**
 * Поле `worktree` из front matter карточки.
 *
 * Ядро (`watcher-core.js`, `FIELDS`) его не читает: там карточка нужна только для
 * решения «кого будить». Тексту наряда оно нужно — карточка открытой задачи живёт
 * в рабочем дереве, и исполнителю надо знать, откуда работать.
 */
function worktreeField(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return "";
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "---") break;
    const match = /^worktree:[ \t]*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[1].trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    return value;
  }
  return "";
}

/**
 * Путь рабочего дерева для текста наряда: относительный, если дерево внутри
 * проекта (так наряд читаемее), иначе как записан в карточке.
 */
function displayWorktree(root, value) {
  const raw = String(value ?? "").trim();
  if (raw === "") return "";
  const relative = path.relative(root, path.resolve(root, raw));
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join("/");
  }
  return raw;
}

/**
 * Снять слитый снимок доски; `null` — каталога карточек основного чекаута нет.
 *
 * Слияние по id карточки: побеждает более свежий `updated`, при равенстве —
 * копия из рабочего дерева. Та же семантика, что в клиентской половине
 * (`lib/client.js`). Нечитаемый каталог, пропавший файл, удалённое дерево —
 * пропускаем: доска обязана пережить уборку дерева.
 *
 * @param root - корень проекта.
 * @returns Снимок `id → карточка` с полями `source` и `worktree`.
 */
function readSnapshot(root) {
  const merged = new Map();
  let found = false;
  for (const source of boardSources(root)) {
    const entries = readCards(source.dir, source.cardFile);
    if (entries === null) continue;
    // Без основного каталога доски нет — сторож по ней не запускается. Рабочее
    // дерево, наоборот, могло исчезнуть: это норма, а не повод молчать.
    if (source.worktree === null) found = true;
    const fields = new Map();
    for (const [name, text] of entries) {
      fields.set(name.replace(/\.md$/, ""), worktreeField(text));
    }
    const liveId = source.cardFile ? source.cardFile.replace(/\.md$/, "") : "";
    for (const [id, card] of snapshotCards(entries)) {
      // В рабочем дереве живая карточка — ровно та, что названа каталогом: файл с
      // чужим `id` внутри (испорченная копия) не должен приписать карточке чужое
      // дерево, иначе наряд позовёт править чужую задачу в чужой ветке.
      if (liveId && String(card.id) !== liveId) continue;
      card.source = source.worktree ? "worktree" : "main";
      card.worktree = source.worktree ?? displayWorktree(root, fields.get(id) ?? "");
      const current = merged.get(card.id);
      if (!current || isNewer(card, current)) merged.set(card.id, card);
    }
  }
  return found ? merged : null;
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

/**
 * Текст наряда: если карточка живёт в рабочем дереве, к нему дописывается путь
 * дерева — исполнитель и ревьювер должны работать там, а не в основном чекауте
 * (в основном чекауте копия карточки старая, а файлы задачи — в дереве).
 *
 * Наряд о слиянии — исключение: он адресован оркестратору, а `bin/task-commit.sh`
 * из рабочего дерева задачи отказывается работать и просит основной чекаут.
 *
 * Решение о том, кого будить, остаётся в ядре (`watcher-core.js`): здесь только
 * текст.
 */
function noticeText(item) {
  if (item?.kind === "merge") return item.text;
  const dir = String(item?.worktree ?? "");
  if (dir === "") return item.text;
  return `${item.text}\n\nКарточка в ${dir} — работай там: команды выполняй из этого каталога.`;
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
        content: [{ type: "text", text: noticeText(item) }],
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

    // Командный канал клиент→хост: асайн `backlog → todo` и возврат `todo →
    // backlog` из GUI. Регистрируется даже без сторожевых `boards`: без них
    // канал просто отказывает «сессия не привязана к доске», и это понятнее
    // ошибки «endpoint не найден» на стороне клиента.
    try {
      registerCardActionsService(ctx, {
        boards,
        snapshot: readSnapshot,
        resolveSessionCwd: (sessionId) => sessionCwdFromContext(ctx, sessionId),
        runScript: runAssignScript,
        log: (level, message) => log(ctx, level, message),
      });
    } catch (error) {
      log(ctx, "warn", `канал асайна не поднялся: ${error?.message ?? error}`);
    }

    // Эффективная карта ролей: ручные id из строки плагина главнее автокарты.
    const roles = { ...configuredRoles };
    // Паузы настраиваются: тесты доставки берут короткие, живой профиль — обычные.
    const debounceMs = Number.isFinite(config?.debounceMs) ? Number(config.debounceMs) : DEBOUNCE_MS;
    const catchUpMs = Number.isFinite(config?.catchUpMs) ? Number(config.catchUpMs) : CATCH_UP_MS;

    // Самопроверка канала — после стартовой паузы, когда gateway уже смонтирован
    // (синхронная проба в apply давала ложный «не объявил»). Таймер снимаем по
    // dispose, чтобы он не выстрелил после выгрузки плагина.
    const channelProbe = setTimeout(() => {
      try {
        probeCardChannel(ctx);
      } catch (error) {
        log(ctx, "warn", `канал асайна: самопроверка упала: ${error?.message ?? error}`);
      }
    }, catchUpMs);
    ctx.on?.("dispose", () => clearTimeout(channelProbe));

    if (boards.length === 0) {
      log(ctx, "info", "сторож доски выключен: в конфиге плагина нет boards");
      return;
    }

    const watchers = [];
    const timers = [];
    /** Повторный обход досок: нужен, когда роль появляется позже карточки. */
    const reannounce = [];

    for (const board of boards) {
      const root = String(board);
      const tasksDir = mainTasksDir(root);
      const stateFile = path.join(root, ".kanban", ".watcher-state.json");
      // Минимум карточек в `todo` (`.kanban/board.json`): по нему решается, пора ли
      // будить оркестратора. Читаем на каждый обход — конфиг может поправить сам
      // оркестратор, а файл дешёвый.
      const boardFile = path.join(root, ".kanban", "board.json");
      let previous = readSnapshot(root);
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
              // Рабочее дерево — часть текста наряда, поэтому едет вместе с ним.
              worktree: item.worktree ?? "",
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
          const key = item.key ?? deliveryKey(next.get(item.cardId), item.status);
          // Рабочее дерево карточки едет в тексте наряда: открытая задача живёт там,
          // и роли надо работать из этого каталога, а не из основного чекаута.
          const worktree = next.get(item.cardId)?.worktree ?? "";
          deliverOnce(key, worktree ? { ...item, worktree } : item);
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

      // 2. Переходы: следим за каталогами карточек и разбираем изменения.
      //    Кроме основной доски — доски рабочих деревьев и сами `worktrees/`:
      //    по ним видно появление и уборку дерева. Набор каталогов меняется,
      //    поэтому наблюдения сверяем на каждом тике.
      let timer = null;
      const watched = new Map();
      const tick = () => {
        timer = null;
        const next = readSnapshot(root);
        if (next === null) return;
        const before = previous;
        previous = next;
        announce(before, next);
        syncWatch();
      };
      const onEvent = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(tick, debounceMs);
        // Таймер паузы тоже отслеживаем: иначе после dispose он выстрелит ещё раз.
        timers.push(timer);
      };
      const syncWatch = () => {
        const dirs = watchDirs(root);
        for (const [dir, watcher] of watched) {
          if (dirs.has(dir)) continue;
          // Дерево убрали — наблюдение за ним закрываем, иначе оно держит дескриптор.
          try {
            watcher.close();
          } catch {
            /* уже закрыт */
          }
          watched.delete(dir);
        }
        for (const dir of dirs) {
          if (watched.has(dir)) continue;
          try {
            const watcher = fs.watch(dir, onEvent);
            watched.set(dir, watcher);
            watchers.push(watcher);
          } catch (error) {
            log(ctx, "warn", `не слежу за ${dir}: ${error?.message ?? error}`);
          }
        }
      };
      syncWatch();
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
