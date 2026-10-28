/**
 * Командный канал клиент→хост для перемещения карточки: `backlog ↔ todo`.
 *
 * Зачем: клиентская половина плагина умеет только читать (`workspaceFiles` —
 * read-only Remote), поэтому решение «человек перетащил карточку» выполняет
 * хост: асайн или возврат в очередь делает `bin/task-assign.sh` (задача #046),
 * а здесь живут валидация запроса и host-служба, которую вызывает GUI.
 *
 * ## Спайк: чем вызывать хост (решение и обоснование)
 *
 * Проверялись три пути из карточки #047:
 *
 * 1. **Свой host-remote по образцу `remote.workspaceFiles` — выбран.**
 *    Host-половина `@deepseek-ai/dsh-api-workspace-files` — это cordis-служба,
 *    зарегистрированная под ключом контекста и помеченная рантайм-маркерами
 *    Typert (`TypertRemoteService` + `@Remote`). Gateway (host-служба
 *    `typertGateway`) находит такие методы в режиме SRC — «fallback для
 *    endpoints, у которых никогда не было строгого определения»: он разбирает
 *    имена параметров обычного JS-метода, принимает только JSON-значения и не
 *    требует сгенерированных схем. Это ровно наш случай: плагин пишется руками
 *    на JS, генератора `dsh-typert-generator` в наборе нет.
 *
 *    Грабли и обход: пакет `@deepseek-ai/dsh-typert-protocol` из нашего плагина
 *    **не резолвится** — профиль DSH монтирует `dsh-kanban` симлинком, а
 *    node_modules рядом с настоящим путём плагина нет (проверено:
 *    `node -e 'import("@deepseek-ai/dsh-typert-protocol")'` из `dsh-kanban/` →
 *    ERR_MODULE_NOT_FOUND). Добавлять зависимость в `package.json` — не наша
 *    задача, поэтому binding и маркеры строятся по опубликованной в протоколе
 *    рантайм-форме (она же лежит в дескрипторе прототипа и проверяется
 *    тестом): `typertRemote = { service, serviceKey, namespace }` и дескриптор
 *    под ключом `@deepseek-ai/dsh-typert-protocol/remote-methods` версии 1 со
 *    списком `{ method, invocation: { kind: "direct" } }`. Если однажды пакет
 *    станет резолвимым (его добавят в зависимости или положат в node_modules
 *    плагина), можно перейти на `TypertRemoteService`/`Remote` без смены
 *    wire-контракта — форма та же.
 *
 * 2. **Переиспользовать готовый remote с выполнением команды — не взлетело.**
 *    Терминального/шеллового Remote в сборке нет (есть только host-инструменты
 *    `dsh-tool-bash`, клиенту они недоступны), а `sessionController.prompt` —
 *    это сообщение агенту, а не запуск команды.
 *
 * 3. **Деградация промптом оркестратору** (тоже вариант 3 карточки) осталась бы
 *    медленной и шла бы через LLM; в коде она не нужна, потому что путь 1
 *    работает: gateway уже поднят в профиле (через него живёт
 *    `remote.workspaceFiles`), а клиентская половина вызывает endpoint тем же
 *    носителем, что и типизированные remote'ы.
 *
 * ## Wire-контракт (для клиентской половины, задача #048)
 *
 * Endpoint'ы: `kanbanCardActions/assign`, `kanbanCardActions/unassign`.
 * Параметр у метода один — чтобы SRC-режим принял сигнатуру (он запрещает
 * деструктуризацию, значения по умолчанию и rest), и он не совпадает с именами
 * lookup-параметров Typert:
 *
 * ```js
 * const envelope = await connection.rpc.call(
 *   "/api",
 *   "kanbanCardActions/assign",
 *   { args: { request: { sessionId, cardId } } },
 *   signal,
 * );
 * // envelope.ok === false — отказ транспорта/шлюза: { error: { code, message } }
 * // envelope.ok === true  — результат бизнес-операции:
 * // { ok, status, owner?, message } — ok=false это отказ по делу
 * // ("карточка не в бэклоге", "все заняты"), а не сбой канала.
 * ```
 *
 * `status` — колонка карточки после операции (или текущая при отказе),
 * `owner` — исполнитель при успешном асайне, `message` — человеческий текст для
 * баннера в GUI.
 *
 * ## Почему это безопасно
 *
 * Клиент не присылает ни путей, ни команд: только `sessionId` (который хост сам
 * сопоставляет с корнем проекта из конфига `boards`) и `cardId` вида `047`.
 * Скрипт запускается массивом аргументов без шелла (`execFile`, `shell: false`),
 * только из корня проекта, только `bin/task-assign.sh`, только два режима —
 * асайн из `backlog` и возврат из `todo`. Хост дополнительно проверяет статус
 * карточки по слитому снимку доски до вызова скрипта, поэтому канал не может
 * увести карточку из `in-progress` или дальше.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Ключ контекста и namespace Remote-службы: endpoint — `<namespace>/<method>`. */
export const SERVICE_KEY = "kanbanCardActions";
export const NAMESPACE = "kanbanCardActions";

/** Ключ дескриптора Remote-методов на прототипе службы (контракт протокола). */
export const REMOTE_METHODS_KEY = "@deepseek-ai/dsh-typert-protocol/remote-methods";

/** `cardId` — номер карточки: три и более цифр, никаких путей снаружи. */
export const CARD_ID_PATTERN = /^[0-9]{3,}$/;

/** `sessionId` — id сессии DSH: идентификатор, а не произвольная строка. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;

/** Сколько ждать `bin/task-assign.sh`: асайн — локальная файловая операция. */
const SCRIPT_TIMEOUT_MS = 20_000;

/** Предел текста, который уходит в GUI: баннер не должен разрастаться. */
const MAX_MESSAGE = 400;

/** Подсказки по кодам возврата `bin/task-assign.sh` (см. карточку #046). */
const CODE_HINTS = {
  1: "ошибка конфига или доски",
  3: "карточка не в том статусе",
  4: "все исполнители заняты",
};

/**
 * Пометить метод службы как Remote для Gateway (SRC-режим).
 *
 * Форма дескриптора — публичный рантайм-контракт `@deepseek-ai/dsh-typert-protocol`
 * (`Remote`/`remoteMethods`): версия 1, методы в порядке объявления, у каждого
 * `invocation.kind = "direct"` (вызов метода самой службы, без резолва через
 * Context).
 *
 * @param prototype - прототип класса службы.
 * @param method - имя публичного метода.
 */
export function markRemoteMethod(prototype, method) {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, REMOTE_METHODS_KEY)?.value;
  const methods = Array.isArray(descriptor?.methods) ? [...descriptor.methods] : [];
  if (!methods.some((entry) => entry.method === method)) {
    methods.push(Object.freeze({ method, invocation: Object.freeze({ kind: "direct" }) }));
  }
  Object.defineProperty(prototype, REMOTE_METHODS_KEY, {
    configurable: true,
    value: Object.freeze({ version: 1, methods: Object.freeze(methods) }),
  });
}

/** Простой объект: пришедший по проводу запрос не должен тащить классы/массивы. */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Текст для GUI: одна строка, обрезанная до разумного предела. */
function shortText(value) {
  const text = String(value == null ? "" : value)
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= MAX_MESSAGE) return text;
  return text.slice(0, MAX_MESSAGE - 1) + "…";
}

/** Единая форма ответа: поля всегда есть, `owner` — только когда он известен. */
function result(ok, status, message, owner) {
  const payload = { ok: Boolean(ok), status: String(status ?? ""), message: shortText(message) };
  if (ok && typeof owner === "string" && owner.length > 0) payload.owner = owner;
  return payload;
}

/**
 * Проверить запрос из GUI.
 *
 * Никаких лишних полей: клиент может прислать только `sessionId` и `cardId`.
 * Это отсекает и попытку протащить «команду» или путь в запросе.
 *
 * @param request - присланный объект.
 * @returns `{ ok: true, value }` или `{ ok: false, message }`.
 */
export function validateRequest(request) {
  if (!isPlainObject(request)) {
    return { ok: false, message: "ожидался объект { sessionId, cardId }" };
  }
  const extra = Object.keys(request).filter((key) => key !== "sessionId" && key !== "cardId");
  if (extra.length > 0) {
    return { ok: false, message: `лишние поля в запросе: ${extra.join(", ")}` };
  }
  const sessionId = typeof request.sessionId === "string" ? request.sessionId.trim() : "";
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return { ok: false, message: "неверный sessionId: ожидается идентификатор сессии" };
  }
  const cardId = typeof request.cardId === "string" ? request.cardId.trim() : "";
  if (!CARD_ID_PATTERN.test(cardId)) {
    return { ok: false, message: "неверный cardId: ожидается номер карточки, например 047" };
  }
  return { ok: true, value: { sessionId, cardId } };
}

/**
 * Нормализовать путь: `resolve` плюс `realpath`, если файл существует.
 *
 * Нужен, чтобы `/var/...` и `/private/var/...` (macOS), симлинки и `..` в
 * конфиге и в каталоге сессии не давали «сессия не привязана к доске», когда это
 * на самом деле одна и та же папка.
 *
 * @param value - путь.
 * @returns абсолютный нормализованный путь.
 */
function normalizedPath(value) {
  const resolved = path.resolve(String(value));
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Корень проекта, к которому относится рабочий каталог сессии.
 *
 * Сессия может жить и в корне проекта, и в рабочем дереве
 * (`<проект>/worktrees/<id>`) — поднимаемся вверх, пока не совпадём с одной из
 * досок конфига. Пути сравниваются после `realpath`-нормализации, чтобы симлинки
 * и `..` не давали ложных «чужих» досок.
 *
 * @param boards - корни досок из конфига плагина.
 * @param cwd - рабочий каталог сессии.
 * @returns корень доски или `null`.
 */
export function findBoardRoot(boards, cwd) {
  if (typeof cwd !== "string" || cwd.length === 0) return null;
  const known = new Set((boards ?? []).map((board) => normalizedPath(board)));
  let dir = normalizedPath(cwd);
  for (;;) {
    if (known.has(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Запустить `bin/task-assign.sh` из корня проекта — массивом аргументов, без шелла.
 *
 * @param options - `{ root, args, signal, timeoutMs }`.
 * @returns `{ ok, code, stdout, stderr }`; `code: "missing"` — скрипта нет.
 */
export function runAssignScript({ root, args, signal, timeoutMs = SCRIPT_TIMEOUT_MS }) {
  const script = path.join(String(root), "bin", "task-assign.sh");
  return new Promise((resolve) => {
    execFile(
      script,
      args,
      {
        cwd: String(root),
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        signal,
        // Предсказуемая локаль для скрипта набора: bash 3.2 под multibyte-локалью
        // неправильно разбирает `${var:+ «...»}` в `bin/task-assign.sh` (#056) и
        // выходит с 0, ничего не сделав. Основной фикс — в #056, но канал не
        // должен зависеть от локали вызывающего процесса (LC_ALL=C.UTF-8 не
        // помогает: именно multibyte-режим и ломает разбор).
        env: { ...process.env, LC_ALL: "C" },
      },
      (error, stdout, stderr) => {
        const out = String(stdout ?? "");
        const err = String(stderr ?? "");
        if (!error) {
          resolve({ ok: true, code: 0, stdout: out, stderr: err });
          return;
        }
        if (error.code === "ENOENT") {
          resolve({ ok: false, code: "missing", stdout: out, stderr: err });
          return;
        }
        // Плагин выгружается: execFile убивает ребёнка по сигналу, и это не
        // «скрипт упал», а отмена — вызывающий должен отличить одно от другого.
        if (error.name === "AbortError" || error.code === "ABORT_ERR" || signal?.aborted) {
          resolve({ ok: false, code: "aborted", stdout: out, stderr: err });
          return;
        }
        const code = typeof error.code === "number" ? error.code : "failed";
        resolve({ ok: false, code, stdout: out, stderr: err });
      },
    );
  });
}

/**
 * Собрать бизнес-часть канала.
 *
 * Зависимости внедряются, чтобы логика проверялась без DSH и без живого диска:
 * `snapshot(root)` — слитый снимок доски (`id → карточка`, как у сторожа),
 * `resolveSessionCwd(sessionId)` — корень рабочего каталога сессии,
 * `runScript({ root, args, signal })` — запуск `bin/task-assign.sh`.
 *
 * @param options - `{ boards, snapshot, resolveSessionCwd, runScript, log }`.
 * @returns `{ assign, unassign }` — бизнес-операции канала.
 */
export function createCardActions(options) {
  const boards = Array.isArray(options?.boards) ? options.boards.map(String) : [];
  const snapshot = options?.snapshot;
  const resolveSessionCwd = options?.resolveSessionCwd;
  const runScript = options?.runScript ?? runAssignScript;
  const log = typeof options?.log === "function" ? options.log : () => {};
  // Сигнал жизни плагина: по dispose начатый `bin/task-assign.sh` (и его дети)
  // отменяется сигналом, а новые асайны не стартуют вовсе.
  const signal = options?.signal ?? null;
  const cancelled = () => Boolean(signal?.aborted);
  const CANCELLED_MESSAGE = "канал асайна отменён: плагин выгружается";

  /** Очередь: два асайна одновременно не должны выбрать одного исполнителя. */
  let queue = Promise.resolve();
  const serialize = (task) => {
    const run = queue.then(task, task);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  /** Карточка из слитого снимка доски; `null` — нет доски/карточки. */
  const cardOf = (root, cardId) => {
    try {
      const shot = snapshot?.(root);
      return shot ? shot.get(String(cardId)) ?? null : null;
    } catch (error) {
      log("warn", `канал асайна: снимок доски ${root} не прочитан: ${error?.message ?? error}`);
      return null;
    }
  };

  /** Корень доски для сессии: `{ ok:true, root }` либо `{ ok:false, message }`. */
  const boardOf = async (sessionId) => {
    let cwd = null;
    try {
      cwd = await resolveSessionCwd?.(sessionId);
    } catch (error) {
      log("warn", `канал асайна: каталог сессии ${sessionId} не прочитан: ${error?.message ?? error}`);
      return { ok: false, message: "не удалось определить каталог сессии" };
    }
    if (typeof cwd !== "string" || cwd.length === 0) {
      return { ok: false, message: "сессия не найдена: каталог сессии неизвестен" };
    }
    const root = findBoardRoot(boards, cwd);
    if (root === null) {
      return { ok: false, message: "сессия не привязана ни к одной доске проекта" };
    }
    return { ok: true, root };
  };

  /** Запуск скрипта с переводом кодов и текста отказа в человеческое сообщение. */
  const invoke = async (root, args) => {
    if (cancelled()) return { ok: false, message: CANCELLED_MESSAGE };
    let outcome;
    try {
      outcome = await runScript({ root, args, signal: signal ?? undefined });
    } catch (error) {
      if (cancelled()) return { ok: false, message: CANCELLED_MESSAGE };
      return { ok: false, message: `канал асайна упал: ${shortText(error?.message ?? error)}` };
    }
    // Отмена по dispose: ни отменять результат, ни писать состояние не нужно.
    if (cancelled() || outcome?.code === "aborted") {
      return { ok: false, message: CANCELLED_MESSAGE };
    }
    if (outcome?.ok) return { ok: true };
    if (outcome?.code === "missing") {
      return {
        ok: false,
        message: "канал асайна не установлен: в проекте нет bin/task-assign.sh",
      };
    }
    const hint = CODE_HINTS[outcome?.code] ?? "скрипт асайна завершился с ошибкой";
    const detail = shortText([outcome?.stdout, outcome?.stderr].filter(Boolean).join(" "));
    return { ok: false, message: detail ? `${hint}: ${detail}` : hint };
  };

  /** Асайн: только карточка из `backlog`, только через `bin/task-assign.sh`. */
  const doAssign = async (request) => {
    const checked = validateRequest(request);
    if (!checked.ok) return result(false, "", checked.message);
    const { sessionId, cardId } = checked.value;
    const board = await boardOf(sessionId);
    if (!board.ok) return result(false, "", board.message);
    const card = cardOf(board.root, cardId);
    if (!card) return result(false, "", `карточка #${cardId} не найдена на доске`);
    const status = String(card.status ?? "");
    if (status !== "backlog") {
      return result(false, status, `карточка #${cardId} в статусе «${status}»: асайн — только из backlog`);
    }
    const run = await invoke(board.root, [cardId]);
    if (!run.ok) return result(false, status, run.message);
    // Код возврата скрипта — ещё не доказательство асайна: #056 показал, что
    // `bin/task-assign.sh` может вернуть 0, ничего не сделав (локаль/маскировка
    // кода). Перечитываем снимок и проверяем фактический результат.
    const after = cardOf(board.root, cardId);
    if (!after) {
      return result(false, status, `bin/task-assign.sh завершился, но карточку #${cardId} не удалось перечитать — асайн не подтверждён`);
    }
    const nextStatus = String(after.status ?? "");
    const owner = String(after.owner ?? "");
    if (nextStatus !== "todo") {
      const reason = nextStatus === status
        ? `карточка #${cardId} осталась в ${status}`
        : `карточка #${cardId} оказалась в статусе «${nextStatus}», ожидался todo`;
      return result(
        false,
        nextStatus || status,
        `bin/task-assign.sh завершился успешно, но ${reason} — асайн не подтверждён, проверьте bin/task-assign.sh`,
      );
    }
    if (owner === "") {
      return result(
        false,
        nextStatus,
        `bin/task-assign.sh завершился успешно, но карточка #${cardId} в todo без исполнителя — асайн не подтверждён, проверьте bin/task-assign.sh`,
      );
    }
    return result(true, nextStatus, `карточка #${cardId} выдана: ${nextStatus}, исполнитель ${owner}`, owner);
  };

  /** Возврат в очередь: строго из `todo` (карточку в работе человек не двигает). */
  const doUnassign = async (request) => {
    const checked = validateRequest(request);
    if (!checked.ok) return result(false, "", checked.message);
    const { sessionId, cardId } = checked.value;
    const board = await boardOf(sessionId);
    if (!board.ok) return result(false, "", board.message);
    const card = cardOf(board.root, cardId);
    if (!card) return result(false, "", `карточка #${cardId} не найдена на доске`);
    const status = String(card.status ?? "");
    if (status !== "todo") {
      return result(false, status, `карточка #${cardId} в статусе «${status}»: вернуть в backlog можно только из todo`);
    }
    const run = await invoke(board.root, [cardId, "--unassign"]);
    if (!run.ok) return result(false, status, run.message);
    // То же правило, что у асайна: `exit 0` не доказывает возврат — проверяем
    // статус и снятые владельца с ролью по перечитанному снимку.
    const after = cardOf(board.root, cardId);
    if (!after) {
      return result(false, status, `bin/task-assign.sh завершился, но карточку #${cardId} не удалось перечитать — возврат не подтверждён`);
    }
    const nextStatus = String(after.status ?? "");
    const owner = String(after.owner ?? "");
    const role = String(after.role ?? "");
    if (nextStatus !== "backlog") {
      const reason = nextStatus === status
        ? `карточка #${cardId} осталась в ${status}`
        : `карточка #${cardId} оказалась в статусе «${nextStatus}», ожидался backlog`;
      return result(
        false,
        nextStatus || status,
        `bin/task-assign.sh завершился успешно, но ${reason} — возврат не подтверждён, проверьте bin/task-assign.sh`,
      );
    }
    if (owner !== "" || role !== "") {
      return result(
        false,
        nextStatus,
        `bin/task-assign.sh завершился успешно, но у карточки #${cardId} в backlog остались ${[owner ? "владелец" : "", role ? "роль" : ""].filter(Boolean).join(" и ")} — возврат не подтверждён, проверьте bin/task-assign.sh`,
      );
    }
    return result(true, nextStatus, `карточка #${cardId} вернулась в backlog`);
  };

  return {
    assign: (request) => serialize(() => doAssign(request)),
    unassign: (request) => serialize(() => doUnassign(request)),
  };
}

/**
 * Служба канала для Gateway.
 *
 * Методы — обычные `async` с одним простым параметром: SRC-режим Gateway читает
 * имена параметров из исходника метода и не принимает деструктуризацию.
 */
class CardActionsService {
  constructor(actions) {
    this.actions = actions;
  }

  async assign(request) {
    return this.actions.assign(request);
  }

  async unassign(request) {
    return this.actions.unassign(request);
  }
}

markRemoteMethod(CardActionsService.prototype, "assign");
markRemoteMethod(CardActionsService.prototype, "unassign");

/**
 * Зарегистрировать канал в host-контексте.
 *
 * Служба кладётся в контекст (`ctx.provide`) и получает `typertRemote`-binding —
 * этого достаточно, чтобы Gateway нашёл endpoint в SRC-режиме.
 *
 * @param ctx - cordis-контекст плагина (host-половина).
 * @param options - то же, что у `createCardActions`, плюс необязательный `log`.
 * @returns `{ service, dispose }`: служба (для тестов) и disposer регистрации.
 */
export function registerCardActionsService(ctx, options) {
  const actions = createCardActions(options);
  const service = new CardActionsService(actions);
  service.typertRemote = Object.freeze({ service, serviceKey: SERVICE_KEY, namespace: NAMESPACE });
  const dispose = ctx.provide(SERVICE_KEY, service);
  return { service, dispose };
}

/**
 * Прочитать рабочий каталог сессии через host-службу `sessionQuery`.
 *
 * `observeSession` отдаёт во владение «lease»: у холодной сессии его нужно
 * освободить, иначе подготовка висит в кэше. Нужен только `header.cwd`.
 *
 * @param ctx - контекст плагина.
 * @param sessionId - id сессии.
 * @returns путь рабочего каталога или `null`.
 */
export async function sessionCwdFromContext(ctx, sessionId) {
  const query = ctx?.get?.("sessionQuery");
  if (!query || typeof query.observeSession !== "function") return null;
  const lease = await query.observeSession(sessionId, { projectionMode: "none" });
  try {
    const cwd = lease?.header?.cwd;
    return typeof cwd === "string" && cwd.length > 0 ? cwd : null;
  } finally {
    const release = lease?.[Symbol.dispose];
    if (typeof release === "function") {
      try {
        release.call(lease);
      } catch {
        /* освобождение lease не должно ломать ответ канала */
      }
    }
  }
}
