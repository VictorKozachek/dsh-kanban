/**
 * Наряды доски про backlog: назначение задачи исполнителю и сигнал о том, что
 * `todo` пора пополнить.
 *
 * Зачем отдельный модуль: сторож (`watcher-core.js`) умеет будить роль только по
 * переходу статуса, а асайн из `backlog` — это не возврат и не ревью: карточка
 * просто оказывается в `todo` с владельцем, и без наряда исполнитель о ней не
 * узнает. Ровно как ядро, модуль чистый: ни файловой системы, ни сессий — только
 * планирование нарядов, поэтому правила проверяются тестами без приложения.
 * Проводка (чтение `.kanban/board.json`, доставка, файл состояния) — в
 * `lib/index.js`.
 *
 * Модель (`.kanban/specs/001-backlog.md`, раздел «Наряды сторожа»):
 *   - асайн — событие: карточка пришла в `todo` с непустым `owner` или владелец
 *     в `todo` сменился;
 *   - пополнение — состояние: в `todo` меньше `minTodo`. Один наряд на недобор,
 *     повторно — только после возврата `todo` к минимуму и нового падения.
 *
 * Известная граница (та же, что у ядра): переход, случившийся внутри окна
 * `debounceMs`, может не дать события доски. Недобор успевает сняться и
 * появиться заново — тогда второй сигнал придёт не сразу, а на следующем
 * изменении доски.
 */

/** Минимум `todo` по умолчанию: нет `board.json` или он битый — считаем 1. */
export const DEFAULT_MIN_TODO = 1;

/**
 * Ключ сигнала о недоборе в файле состояния сторожа.
 *
 * Сигнал — состояние доски, а не версия карточки, поэтому в ключе нет `updated`:
 * пока `todo` не добрал до минимума, наряд повторно не отправляется.
 */
export const REFILL_KEY = "board:refill:short";

/** Вид наряда об асайне — по нему `index.js` берёт отдельный ключ доставки. */
export const ASSIGNMENT_KIND = "assignment";

/** Вид наряда о пополнении `todo`. */
export const REFILL_KIND = "refill";

/** Привести значение минимума к целому неотрицательному числу; мусор — дефолт. */
function normalizeMin(value) {
  const number = typeof value === "string" ? Number(value.trim()) : value;
  if (typeof number !== "number" || !Number.isFinite(number) || number < 0) return DEFAULT_MIN_TODO;
  return Math.floor(number);
}

/**
 * Разобрать `.kanban/board.json` и взять `minTodo`.
 *
 * @param text - содержимое файла (или `null`, если файла нет).
 * @returns Минимум карточек в `todo`; нет поля, битый JSON или мусор — 1.
 */
export function parseMinTodo(text) {
  if (typeof text !== "string" || text.trim() === "") return DEFAULT_MIN_TODO;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return DEFAULT_MIN_TODO;
  }
  if (!parsed || typeof parsed !== "object") return DEFAULT_MIN_TODO;
  if (!("minTodo" in parsed)) return DEFAULT_MIN_TODO;
  return normalizeMin(parsed.minTodo);
}

/** Сколько карточек снимка в указанном статусе. */
function countStatus(snapshot, status) {
  let count = 0;
  for (const card of snapshot?.values() ?? []) {
    if ((card?.status ?? "") === status) count += 1;
  }
  return count;
}

/** Сколько карточек в `todo` — по этому числу считается недобор. */
export function countTodo(snapshot) {
  return countStatus(snapshot, "todo");
}

/** Сколько карточек ждёт в `backlog` — от этого зависит текст наряда. */
export function countBacklog(snapshot) {
  return countStatus(snapshot, "backlog");
}

/**
 * Ключ доставки асайна: версия карточки плюс владелец.
 *
 * Владелец в ключе обязателен: перепривязка карточки в `todo` к другому
 * исполнителю обязана разбудить нового, хотя `updated` у неё мог и не измениться.
 *
 * @param card - карточка из снимка.
 * @returns Строковый ключ для файла состояния сторожа.
 */
export function assignmentKey(card) {
  return `${card?.id ?? ""}:todo:${card?.updated ?? ""}:${card?.owner ?? ""}`;
}

/**
 * Решить, кому сообщить об асайне.
 *
 * Наряд получает только `todo` с непустым владельцем, и только если карточка
 * пришла в `todo` с этим владельцем впервые: та же карточка, та же версия, тот
 * же владелец второй раз не будится. Карточки в других статусах и `todo` без
 * владельца нарядов не дают.
 *
 * @param previous - снимок до изменения (пустой на старте — тогда асайн свежий).
 * @param next - снимок после изменения.
 * @returns Список нарядов `{cardId, sessionId, kind, status, key, text}`.
 */
export function planAssignmentNotices(previous, next) {
  const notices = [];
  for (const [id, card] of next ?? []) {
    if ((card?.status ?? "") !== "todo") continue;
    const owner = String(card.owner ?? "");
    if (owner === "") continue;

    const before = previous?.get(id);
    if (before && (before.status ?? "") === "todo" && String(before.owner ?? "") === owner) continue;

    const place = `.kanban/tasks/${id}.md`;
    const title = card.title ? ` «${card.title}»` : "";
    notices.push({
      cardId: id,
      sessionId: owner,
      kind: ASSIGNMENT_KIND,
      status: "todo",
      key: assignmentKey(card),
      text:
        `Доска: тебе назначена #${id}${title}, бери в работу: ` +
        `bin/task-move.sh ${id} in-progress --owner "$DSH_SESSION_ID" --role worker; ` +
        `карточка: ${place}`,
    });
  }
  return notices;
}

/**
 * Решить, пора ли будить оркестратора из-за недобора `todo`.
 *
 * Наряд — не про карточку: он про состояние доски, поэтому ключ доставки у него
 * один (`REFILL_KEY`) и снимать его должен `index.js`, когда `todo` добрал до
 * минимума. Без роли `dispatcher` наряд не создаётся (но факт недобора в ответе
 * остаётся — по нему проводка решает, сбрасывать ли состояние).
 *
 * @param next - текущий снимок доски.
 * @param options - `{ minTodo, dispatcher }`.
 * @returns `{ short, todo, minTodo, backlog, notice }`, где `notice` — наряд или `null`.
 */
export function planRefillNotice(next, options = {}) {
  const minTodo = normalizeMin(options?.minTodo);
  const todo = countTodo(next);
  const backlog = countBacklog(next);
  const short = todo < minTodo;
  const dispatcher = typeof options?.dispatcher === "string" ? options.dispatcher.trim() : "";
  if (!short || dispatcher === "") return { short, todo, minTodo, backlog, notice: null };

  const tail = backlog > 0 ? "" : " backlog пуст: нужна нарезка спеки.";
  return {
    short,
    todo,
    minTodo,
    backlog,
    notice: {
      // Наряд адресован не карточке, а доске: `cardId` пустой, ключ — `REFILL_KEY`.
      cardId: "",
      sessionId: dispatcher,
      kind: REFILL_KIND,
      status: "todo",
      text: `Доска: в todo ${todo} < ${minTodo}, пополни: bin/backlog-fill.sh.${tail}`,
    },
  };
}
