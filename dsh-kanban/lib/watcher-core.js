/**
 * Чистая часть сторожевого плагина доски (`dsh-kanban`, host-половина).
 *
 * Здесь нет ни файловой системы, ни сессий: только разбор карточек и решение
 * «когда и кому отправить наряд». Благодаря этому правила проверяются тестами
 * без запуска приложения, а host-обвязка (`lib/index.js`) остаётся тонкой.
 *
 * Идея: доска — это файлы, а роль узнаёт о работе только когда ей напишут.
 * Сторож сравнивает два снимка каталога `.kanban/tasks` и по переходу статуса
 * решает, кого будить.
 */

/**
 * Поля front matter, которые влияют на решение (остальное читает доска).
 * `updated` нужен для ключа доставки: по нему видно, что карточка ушла в статус
 * заново, а не осталась в нём с прошлого раза.
 */
const FIELDS = ["id", "title", "status", "owner", "role", "updated"];

/**
 * Разобрать карточку: front matter между первыми `---` плюс первый абзац задачи.
 *
 * @param text - содержимое файла карточки.
 * @returns Объект с полями из front matter (без кавычек) и флагом `broken`.
 */
/**
 * Канонические колонки доски — те же id, что в `COLUMNS` клиентской половины.
 */
export const COLUMN_IDS = ["todo", "in-progress", "in-review", "testing", "ready", "merged", "blocked"];

/**
 * Нормализация статуса: та же логика, что в клиентской половине
 * (`lib/client.js`, `__internals.normalizeStatus`) — регистр, пробелы и синонимы
 * (`in_progress`, `wip`, `done`, «заблокировано»). Половинки живут в разных
 * модульных системах, поэтому копий две; их согласие проверяет `test/merge.test.mjs`.
 */
export const STATUS_ALIASES = {
  todo: "todo",
  backlog: "todo",
  new: "todo",
  "нужно-сделать": "todo",
  "in-progress": "in-progress",
  in_progress: "in-progress",
  progress: "in-progress",
  wip: "in-progress",
  doing: "in-progress",
  active: "in-progress",
  "в-работе": "in-progress",
  "in-review": "in-review",
  in_review: "in-review",
  inreview: "in-review",
  "code-review": "in-review",
  reviewing: "in-review",
  "на-ревью": "in-review",
  "ревью": "in-review",
  testing: "testing",
  review: "in-review",
  test: "testing",
  verify: "testing",
  "на-проверке": "testing",
  "тестирование": "testing",
  ready: "ready",
  "ready-to-merge": "ready",
  done: "ready",
  "готово": "ready",
  merged: "merged",
  "влито": "merged",
  "слито": "merged",
  closed: "merged",
  blocked: "blocked",
  hold: "blocked",
  "заблокировано": "blocked"
}

export function normalizeStatus(raw) {
  const value = String(raw == null ? "" : raw).trim().toLowerCase().replace(/\s+/g, "-");
  if (value === "") return "todo";
  if (STATUS_ALIASES[value]) return STATUS_ALIASES[value];
  return COLUMN_IDS.indexOf(value) >= 0 ? value : "todo";
}

export function parseCard(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { broken: true };
  const card = { broken: false };
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "---") break;
    const match = /^([A-Za-z_][A-Za-z0-9_]*):[ \t]*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, raw] = match;
    if (!FIELDS.includes(key)) continue;
    let value = raw.trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    card[key] = value;
  }
  if (!card.id) return { broken: true };
  return card;
}

/**
 * Снять снимок доски: `id` → карточка.
 *
 * @param entries - пары `[имя файла, содержимое]`.
 * @returns Снимок карточек, по которому считается переход.
 */
export function snapshotCards(entries) {
  const snapshot = new Map();
  for (const [name, text] of entries ?? []) {
    if (!String(name).endsWith(".md") || String(name) === "README.md") continue;
    const card = parseCard(text);
    if (card.broken) continue;
    // Доска терпима к статусам (регистр, пробелы, синонимы), поэтому приводим их
    // к каноническим здесь — на входе в снимок доски, как это делает GUI.
    card.status = normalizeStatus(card.status);
    snapshot.set(String(card.id), card);
  }
  return snapshot;
}

/**
 * Ключ доставки: одна версия карточки в одном статусе объявляется один раз.
 *
 * Версия — это `updated`: карточка, побывавшая в статусе, вернувшаяся исполнителю
 * и снова пришедшая в тот же статус, обязана объявляться заново.
 *
 * @param card - карточка из снимка.
 * @param status - статус, о котором идёт наряд.
 * @returns Строковый ключ для файла состояния сторожа.
 */
/**
 * Какая запись карточки свежее. Та же логика, что в клиентской половине
 * (`lib/client.js`, `__internals.isNewer`): `updated` сравниваем лексикографически,
 * при равенстве выигрывает карточка из ветки. Половинки плагина живут в разных
 * модульных системах (классический скрипт против ESM), поэтому копий две — что они
 * не разъезжаются, проверяет `test/merge.test.mjs`.
 */
export function isNewer(candidate, current) {
  const left = String(candidate?.updated ?? "");
  const right = String(current?.updated ?? "");
  if (left && right) return left === right ? candidate.source === "worktree" : left > right;
  if (left) return true;
  if (right) return false;
  return candidate.source === "worktree";
}

export function deliveryKey(card, status) {
  return `${card?.id ?? ""}:${status ?? ""}:${card?.updated ?? ""}`;
}

/** Статусы, из которых возврат в работу означает «карточку вернула другая роль». */
const RETURNED_FROM = new Set(["in-review", "testing", "ready", "blocked"]);

function commandTail(card) {
  return `bin/task-move.sh ${card.id}`;
}

function notice(card, sessionId, text, kind) {
  return { cardId: card.id, sessionId, kind, text };
}

/**
 * Решить, кого будить по переходам между снимками.
 *
 * @param previous - снимок до изменения.
 * @param next - снимок после изменения.
 * @param options - `{ reviewer, verifier, dispatcher }` — id сессий ролей.
 * @returns Список нарядов `{cardId, sessionId, kind, text}` в порядке карточек.
 */
export function planNotices(previous, next, options = {}) {
  const notices = [];
  const role = (name) => {
    const value = options?.[name];
    return typeof value === "string" && value.length > 0 ? value : null;
  };

  for (const [id, card] of next ?? []) {
    const before = previous?.get(id);
    const status = card.status ?? "";
    if (before && (before.status ?? "") === status) continue;
    if (!before && !status) continue;

    const place = `.kanban/tasks/${id}.md`;
    const title = card.title ? ` «${card.title}»` : "";

    if (status === "in-progress") {
      // Из очереди задачу берёт сам исполнитель — будить некого. А вот возврат
      // из ревью, тестов, ready или блокировки адресован владельцу карточки.
      if (!before || !RETURNED_FROM.has(before.status ?? "")) continue;
      if (!card.owner) continue;
      notices.push(
        notice(
          card,
          card.owner,
          `Доска: карточка #${id}${title} вернулась в работу из «${before.status}». ` +
            `Прочитай ${place} (замечания) и продолжай. Закончишь — ` +
            `${commandTail(card)} in-review --role worker --tokens auto --note "..."`,
          "returned",
        ),
      );
      continue;
    }

    if (status === "in-review") {
      const target = role("reviewer");
      if (!target || target === card.owner) continue;
      notices.push(
        notice(
          card,
          target,
          `Доска: карточка #${id}${title} ждёт ревью (${place}). ` +
            `Принял — ${commandTail(card)} testing --role reviewer --tokens auto --note "..."; ` +
            `есть замечания — впиши их в карточку и ${commandTail(card)} in-progress --role reviewer --note "..."`,
          "review",
        ),
      );
      continue;
    }

    if (status === "testing") {
      const target = role("verifier");
      if (!target || target === card.owner) continue;
      notices.push(
        notice(
          card,
          target,
          `Доска: карточка #${id}${title} ждёт тестирования (${place}). ` +
            `Прошло — ${commandTail(card)} ready --role verifier --tokens auto --note "..."; ` +
            `не прошло — впиши причину в карточку и ${commandTail(card)} in-progress --role verifier --note "..."`,
          "test",
        ),
      );
      continue;
    }

    if (status === "ready") {
      const target = role("dispatcher");
      if (!target) continue;
      notices.push(
        notice(
          card,
          target,
          `Доска: карточка #${id}${title} готова к слиянию: bin/task-commit.sh ${card.id}`,
          "merge",
        ),
      );
    }
  }

  // Наряд несёт статус карточки: по нему сторож отмечает доставку, чтобы не
  // повторять один и тот же наряд при перезапуске.
  for (const item of notices) {
    item.status = next.get(item.cardId)?.status ?? "";
  }

  return notices;
}
