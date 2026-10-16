/**
 * Браузерная половина плагина `dsh-kanban` — доска агентских задач в правом
 * сайдбаре.
 *
 * Формат файла: классический скрипт-обёртка `window.__ModuleLoader__.load`,
 * который ядро DSH материализует лениво (`factory(require)` → exports). React
 * берётся из базовой таблицы модулей оболочки, поэтому `dsh.client.external`
 * не нужен, а сборщик — тоже: файл написан руками, без JSX.
 *
 * Данные: каталог `.kanban/tasks/*.md` в рабочей директории сессии. Читаем
 * через уже существующий Remote `workspaceFiles` (он read-only), поэтому
 * карточки двигают агенты обычными файловыми инструментами, а доска только
 * показывает состояние и опрашивает его раз в POLL_MS.
 */
window.__ModuleLoader__.load({
  id: "dsh-kanban",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");
    const h = React.createElement;

    /** Идентификатор типа таба; он же ключ регистрации тела и заголовка. */
    const ID = "dsh-kanban";
    /** Дискриминатор типа: то, что называет `openTab`. */
    const KIND = "kanban";
    /** Пространство имён локали. */
    const NS = "kanban";
    /** Где лежат карточки, относительно рабочей директории сессии. */
    const TASKS_DIR = ".kanban/tasks";
    /** Манифест карточек открытых задач из worktree (пишет bin/board-sync.sh). */
    const MANIFEST_FILE = ".kanban/worktrees.json";
    /**
     * Каталоги рабочих деревьев задач внутри проекта. `worktrees` — основной
     * (видимый: путь выбирают руками в диалоге выбора папки), `.worktrees` —
     * поддержка прежних раскладок.
     */
    const WORKTREES_DIRS = ["worktrees", ".worktrees"];
    /** Период опроса: фид изменений не видит записи из bash и редактора. */
    const POLL_MS = 3000;
    /** Сколько строк карточки читать (front matter + тело задачи). */
    const MAX_LINES = 400;

    /** Колонки доски в порядке показа. */
    const COLUMNS = [
      { id: "todo", color: "#94a3b8" },
      { id: "in-progress", color: "#3b82f6" },
      { id: "in-review", color: "#06b6d4" },
      { id: "testing", color: "#f59e0b" },
      { id: "ready", color: "#8b5cf6" },
      { id: "merged", color: "#22c55e" },
      { id: "blocked", color: "#ef4444" }
    ];
    const COLUMN_IDS = COLUMNS.map((column) => column.id);
    const COLUMN_BY_ID = {};
    for (const column of COLUMNS) COLUMN_BY_ID[column.id] = column;

    /** Синонимы статусов: и английские, и русские, чтобы агенты не спотыкались. */
    const STATUS_ALIASES = {
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
    };

    /** Расход по ролям: плоские поля `tokens_<роль>` из front matter. */
    function usageFrom(data) {
      const usage = {};
      for (const [key, value] of Object.entries(data)) {
        const match = /^tokens_([a-z]+)$/.exec(key);
        if (match && String(value) !== "") usage[match[1]] = String(value);
      }
      return usage;
    }

    /** Компактная запись числа: 1234 → «1,2k», 12345678 → «12,3M». */
    function formatTokens(value) {
      const number = Number(String(value).replace(/\s+/g, ""));
      if (!isFinite(number) || number <= 0) return String(value);
      const short = (scaled, suffix) =>
        scaled.toFixed(scaled < 10 ? 1 : 0).replace(".", ",") + suffix;
      if (number < 1000) return String(number);
      if (number < 1000000) return short(number / 1000, "k");
      if (number < 1000000000) return short(number / 1000000, "M");
      return short(number / 1000000000, "G");
    }

    /** Привести произвольный статус карточки к идентификатору колонки. */
    function normalizeStatus(raw) {
      const value = String(raw == null ? "" : raw).trim().toLowerCase().replace(/\s+/g, "-");
      if (value === "") return "todo";
      if (STATUS_ALIASES[value]) return STATUS_ALIASES[value];
      return COLUMN_IDS.indexOf(value) >= 0 ? value : "todo";
    }

    /** Разобрать YAML-front-matter карточки (плоские `key: value`, вложенность не нужна). */
    function parseFrontMatter(text) {
      const data = {};
      let body = text || "";
      const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(body);
      if (!match) return { data, body };
      body = body.slice(match[0].length);
      for (const line of match[1].split(/\r?\n/)) {
        if (/^\s*#/.test(line)) continue;
        const cut = line.indexOf(":");
        if (cut <= 0) continue;
        const key = line.slice(0, cut).trim();
        let value = line.slice(cut + 1).trim();
        if (value.length >= 2) {
          const first = value[0];
          const last = value[value.length - 1];
          if ((first === '"' && last === '"') || (first === "'" && last === "'")) value = value.slice(1, -1);
        }
        if (value === "~" || value === "null") value = "";
        if (key !== "") data[key] = value;
      }
      return { data, body };
    }

    /** Статус, записанный в теле карточки строкой «Статус: review». */
    function statusFromBody(body) {
      const match = /(?:^|\n)\s*(?:\*\*)?(?:Статус|Status)(?:\*\*)?\s*[:：]\s*(?:\*\*)?([^\s*]+)/.exec(body || "");
      return match ? match[1] : "";
    }

    /** Первый заголовок тела — запасное имя карточки, если нет `title`. */
    function titleFromBody(body) {
      const match = /^[ \t]*#[ \t]+(.+?)[ \t]*$/m.exec(body || "");
      return match ? match[1] : "";
    }

    /** Собрать карточку из имени файла и его текста. */
    /**
     * Разделить тело карточки на описание и комментарии ролей. Комментарий — блок,
     * который начинается строкой `- <ISO-дата> [<статус>]`; описание — текст под
     * заголовком «## Задача», иначе всё, что идёт до первого раздела.
     */
    function splitCardBody(rawBody) {
      const body = String(rawBody || "").replace(/\r\n/g, "\n");
      const comments = [];
      const pattern = /^-\s*(\d{4}-\d{2}-\d{2}T[\d:]+Z?)\s*\[([^\]]+)\]\s*\n?([\s\S]*?)(?=\n-\s*\d{4}-\d{2}-\d{2}T|$)/gm;
      for (const match of body.matchAll(pattern)) {
        comments.push({ at: match[1], status: match[2].trim(), text: (match[3] || "").trim() });
      }
      const taskSection = /^##\s*Задача\s*\n([\s\S]*?)(?=\n##\s|$)/m.exec(body);
      const description = (taskSection ? taskSection[1] : body.split(/\n##\s/)[0])
        .split("\n")
        .filter((line) => !/^\s*-\s*\d{4}-\d{2}-\d{2}T/.test(line))
        .join("\n")
        .trim();
      return { description, comments };
    }

    function parseCard(fileName, text) {
      const parsed = parseFrontMatter(text);
      const data = parsed.data;
      const fromName = (fileName.match(/^(\d+)/) || [])[1];
      const bare = fileName.replace(/\.md$/i, "");
      return {
        key: fileName,
        file: TASKS_DIR + "/" + fileName,
        id: String(data.id || fromName || bare),
        title: String(data.title || titleFromBody(parsed.body) || bare),
        status: normalizeStatus(data.status || data.state || statusFromBody(parsed.body)),
        owner: String(data.owner || data.assignee || data.agent || ""),
        role: String(data.role || data.actor || ""),
        tokens: String(data.tokens || ""),
        since: String(data.since || ""),
        usage: usageFrom(data),
        branch: String(data.branch || ""),
        worktree: String(data.worktree || ""),
        updated: String(data.updated || data.updatedAt || ""),
        note: String(data.blocked || data.note || data.reason || ""),
        body: parsed.body,
        ...splitCardBody(parsed.body)
      };
    }

    /**
     * Обрезать длинный текст для карточки: заметка может быть отчётом на
     * несколько килобайт, а на доске ей хватает двух строк. Полный текст
     * остаётся в атрибуте title и в самой карточке в репозитории.
     */
    function clampText(value, limit) {
      const text = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
      if (text.length <= limit) return text;
      return text.slice(0, limit - 1).replace(/[\s,;:.]+$/, "") + "…";
    }

    /** Человекочитаемое описание ошибки Remote. */
    function describeError(error) {
      if (!error) return "unknown";
      if (typeof error === "string") return error;
      const code = error.code ? String(error.code) : "";
      const message = error.message ? String(error.message) : "";
      if (code && message) return code + ": " + message;
      if (message) return message;
      if (code) return code;
      try {
        return JSON.stringify(error);
      } catch (ignored) {
        return String(error);
      }
    }

    /**
     * Прочитать манифест worktree. Любая проблема (нет файла, битый JSON,
     * ошибка Remote) означает просто «открытых карточек из веток нет»: доска
     * обязана работать и без манифеста.
     */
    async function readManifest(remote, sessionId, signal) {
      let result;
      try {
        result = await remote.workspaceFiles.read(sessionId, MANIFEST_FILE, { limit: 200 }, signal);
      } catch (error) {
        return [];
      }
      if (!result || result.ok !== true) return [];
      try {
        const parsed = JSON.parse((result.value || {}).text || "");
        const list = parsed && Array.isArray(parsed.cards) ? parsed.cards : [];
        return list.filter((item) => typeof item === "string" && item.length > 0);
      } catch (error) {
        return [];
      }
    }

    /**
     * Карточки задач из рабочих деревьев внутри проекта:
     * `.worktrees/<id>/.kanban/tasks/*.md`. Обход идёт по workspace, поэтому
     * работает и без манифеста — тот нужен только для worktree за его пределами.
     */
    async function listWorktreeCards(remote, sessionId, signal) {
      const paths = [];
      for (const root of WORKTREES_DIRS) {
        await collectWorktreeCards(remote, sessionId, signal, root, paths);
      }
      return paths;
    }

    /** Обход одного каталога рабочих деревьев. */
    async function collectWorktreeCards(remote, sessionId, signal, worktreesDir, paths) {
      let listing;
      try {
        listing = await remote.workspaceFiles.list(sessionId, worktreesDir, signal);
      } catch (error) {
        return;
      }
      if (!listing || listing.ok !== true) return;
      for (const entry of (listing.value && listing.value.entries) || []) {
        if (!entry || entry.type !== "directory") continue;
        const name = String(entry.name || "");
        if (name === "") continue;
        const dir = worktreesDir + "/" + name;
        let tasks;
        try {
          tasks = await remote.workspaceFiles.list(sessionId, dir + "/" + TASKS_DIR, signal);
        } catch (error) {
          continue;
        }
        if (!tasks || tasks.ok !== true) continue;
        for (const file of (tasks.value && tasks.value.entries) || []) {
          if (!file || file.type !== "file") continue;
          const file_name = String(file.name || "");
          if (!/\.md$/i.test(file_name)) continue;
          if (/^readme\.md$/i.test(file_name)) continue;
          // Worktree ветвится от основной ветки и наследует все её карточки.
          // Живая карточка задачи — только одноимённая с рабочим деревом:
          // остальные уже представлены копией из основного чекаута.
          if (file_name.replace(/\.md$/i, "") !== name) continue;
          paths.push(dir + "/" + TASKS_DIR + "/" + file_name);
        }
      }
    }

    /** Имя файла из абсолютного пути. */
    function basenameOf(path) {
      const parts = String(path).split(/[\\/]/);
      return parts[parts.length - 1] || String(path);
    }

    /**
     * Какая запись свежее. Сравниваем `updated` (ISO-строки сравнимы
     * лексикографически); при равенстве выигрывает карточка из ветки — она
     * живая, а копия в основном чекауте могла остаться от прошлого слияния.
     */
    function isNewer(candidate, current) {
      const left = String(candidate.updated || "");
      const right = String(current.updated || "");
      if (left && right) return left === right ? candidate.source === "worktree" : left > right;
      if (left) return true;
      if (right) return false;
      return candidate.source === "worktree";
    }

    /** Порядок карточек на доске — по id. */
    function compareCards(left, right) {
      return String(left.id).localeCompare(String(right.id), "ru");
    }

    /**
     * Читатель доски: перечисляет `.kanban/tasks`, читает каждую `.md`-карточку,
     * дочитывает манифест worktree и сливает записи по id. Ничего не пишет —
     * Remote этого не умеет.
     */
    function createLoader(remote) {
      return async function loadBoard(sessionId, signal) {
        if (!remote || !remote.workspaceFiles) {
          return { ok: false, error: "workspaceFiles Remote недоступен" };
        }
        let listing;
        try {
          listing = await remote.workspaceFiles.list(sessionId, TASKS_DIR, signal);
        } catch (error) {
          return { ok: false, error: describeError(error) };
        }
        if (!listing || listing.ok !== true) {
          return { ok: false, error: describeError(listing ? listing.error : null) };
        }
        const value = listing.value || {};
        const files = [];
        for (const entry of value.entries || []) {
          if (!entry || entry.type !== "file") continue;
          const name = String(entry.name || "");
          if (!/\.md$/i.test(name)) continue;
          if (/^readme\.md$/i.test(name)) continue;
          files.push(name);
        }
        files.sort();
        const cards = [];
        const problems = [];
        for (const name of files) {
          let result;
          try {
            result = await remote.workspaceFiles.read(sessionId, TASKS_DIR + "/" + name, { limit: MAX_LINES }, signal);
          } catch (error) {
            problems.push(name + ": " + describeError(error));
            continue;
          }
          if (result && result.ok === true) {
            const card = parseCard(name, (result.value || {}).text);
            card.source = "main";
            cards.push(card);
          } else {
            problems.push(name + ": " + describeError(result ? result.error : null));
          }
        }

        // Открытые задачи живут в ветках (worktree). Находим их обходом
        // .worktrees/ внутри проекта и — для worktree за его пределами — по
        // манифесту от bin/board-sync.sh. Пути дедуплицируем.
        const byId = new Map();
        for (const card of cards) byId.set(card.id, card);
        const external = [];
        const seen = {};
        const scanned = await listWorktreeCards(remote, sessionId, signal);
        const listed = await readManifest(remote, sessionId, signal);
        for (const path of scanned.concat(listed)) {
          if (seen[path]) continue;
          seen[path] = true;
          external.push(path);
        }
        for (const path of external) {
          let result;
          try {
            result = await remote.workspaceFiles.read(sessionId, path, { limit: MAX_LINES }, signal);
          } catch (error) {
            problems.push(path + ": " + describeError(error));
            continue;
          }
          if (!result || result.ok !== true) {
            // Исчезнувший worktree — обычная гонка с board-sync, молчим про него.
            const code = result && result.error ? result.error.code : "";
            if (code !== "workspace-file/not-found") {
              problems.push(path + ": " + describeError(result ? result.error : null));
            }
            continue;
          }
          const card = parseCard(basenameOf(path), (result.value || {}).text);
          card.source = "worktree";
          card.path = path;
          const existing = byId.get(card.id);
          if (!existing || isNewer(card, existing)) byId.set(card.id, card);
        }

        const merged = Array.from(byId.values()).sort(compareCards);
        return { ok: true, value: { cards: merged, problems, truncated: value.truncated === true } };
      };
    }

    /** Фабрика бизнес-лица: превращает читатель в prop `loadBoard` тела слота. */
    function boardFace(loadBoard) {
      return (sessionId) => ({
        loadBoard: (signal) => loadBoard(sessionId, signal)
      });
    }

    /** Инлайн-стили: тема не нужна, цвет наследуем у оболочки через currentColor. */
    const HAIRLINE = "color-mix(in srgb, currentColor 12%, transparent)";
    const styles = {
      root: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0, color: "inherit", fontSize: 12, lineHeight: 1.45 },
      header: { display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderBottom: "1px solid " + HAIRLINE, flex: "0 0 auto" },
      headerTitle: { fontWeight: 600, fontSize: 12, letterSpacing: ".02em" },
      headerMeta: { flex: 1, minWidth: 0, opacity: 0.6, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      refresh: { border: "1px solid " + HAIRLINE, background: "transparent", color: "inherit", borderRadius: 6, cursor: "pointer", fontSize: 12, lineHeight: 1, padding: "3px 7px" },
      banner: { margin: "6px 10px 0", padding: "5px 8px", borderRadius: 6, fontSize: 11, background: "color-mix(in srgb, #ef4444 14%, transparent)", border: "1px solid color-mix(in srgb, #ef4444 35%, transparent)" },
      note: { margin: "6px 10px 0", padding: "5px 8px", borderRadius: 6, fontSize: 11, background: "color-mix(in srgb, #f59e0b 14%, transparent)", border: "1px solid color-mix(in srgb, #f59e0b 35%, transparent)" },
      board: { display: "flex", gap: 8, padding: 8, flex: 1, minHeight: 0, alignItems: "flex-start", overflowX: "auto", overflowY: "hidden" },
      /** Раскладка вкладки: доска слева, панель деталей справа. */
      split: { display: "flex", flex: 1, minHeight: 0, gap: 8, alignItems: "stretch", overflow: "hidden" },
      details: { flex: "0 0 300px", display: "flex", flexDirection: "column", gap: 6, padding: "8px 8px 8px 10px", borderLeft: "1px solid " + HAIRLINE, overflowY: "auto" },
      detailsHead: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 6 },
      detailsTitle: { fontSize: 13, fontWeight: 600, wordBreak: "break-word" },
      detailsRow: { display: "flex", gap: 6, fontSize: 11, alignItems: "baseline", flexWrap: "wrap" },
      detailsLabel: { opacity: 0.6 },
      detailsText: { fontSize: 11, whiteSpace: "pre-wrap", wordBreak: "break-word", opacity: 0.9 },
      detailsSection: { fontSize: 11, fontWeight: 600, opacity: 0.75, marginTop: 2 },
      comment: { borderLeft: "2px solid " + HAIRLINE, paddingLeft: 6, display: "flex", flexDirection: "column", gap: 2 },
      commentHead: { display: "flex", gap: 6, fontSize: 10, opacity: 0.65, flexWrap: "wrap" },
      column: { flex: "0 0 auto", width: 232, maxHeight: "100%", display: "flex", flexDirection: "column", border: "1px solid " + HAIRLINE, borderRadius: 10, background: "color-mix(in srgb, currentColor 4%, transparent)", overflow: "hidden" },
      columnHeader: { display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", borderBottom: "1px solid " + HAIRLINE, fontSize: 11, letterSpacing: ".04em", textTransform: "uppercase", opacity: 0.85, flex: "0 0 auto" },
      dot: { width: 8, height: 8, borderRadius: "50%", flex: "0 0 auto" },
      count: { marginLeft: "auto", opacity: 0.6, fontVariantNumeric: "tabular-nums" },
      columnBody: { display: "flex", flexDirection: "column", gap: 6, padding: 6, overflowY: "auto", minHeight: 40 },
      card: { display: "flex", flexDirection: "column", gap: 3, padding: "6px 8px", border: "1px solid " + HAIRLINE, borderLeftWidth: 3, borderLeftStyle: "solid", borderRadius: 8, background: "color-mix(in srgb, currentColor 5%, transparent)" },
      cardTop: { display: "flex", alignItems: "center", gap: 6 },
      cardId: { opacity: 0.6, fontSize: 11, fontVariantNumeric: "tabular-nums" },
      owner: { marginLeft: "auto", fontSize: 10, padding: "1px 5px", borderRadius: 999, border: "1px solid " + HAIRLINE, opacity: 0.9, maxWidth: 110, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      branchBadge: { fontSize: 10, padding: "1px 5px", borderRadius: 999, background: "color-mix(in srgb, currentColor 14%, transparent)", opacity: 0.85, whiteSpace: "nowrap" },
      roleBadge: { fontSize: 10, padding: "1px 5px", borderRadius: 999, border: "1px solid " + HAIRLINE, opacity: 0.9, whiteSpace: "nowrap" },
      ownerEmpty: { marginLeft: "auto", fontSize: 10, opacity: 0.45 },
      cardTitle: { fontSize: 12, fontWeight: 500, wordBreak: "break-word" },
      /** Название закрытой задачи: зачёркнуто, чтобы колонка merged читалась сразу. */
      cardTitleMerged: { textDecoration: "line-through", opacity: 0.7 },
      /** Выбранная карточка: панель деталей справа показывает именно её. */
      cardSelected: { outline: "1px solid currentColor", outlineOffset: 1, background: "color-mix(in srgb, currentColor 10%, transparent)" },
      meta: { fontSize: 10, opacity: 0.6, wordBreak: "break-all" },
      note: { fontSize: 10, color: "#f97316", wordBreak: "break-word" },
      empty: { padding: "14px 12px", opacity: 0.7, fontSize: 11, maxWidth: 420 },
      mono: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 11 }
    };

    /** Есть ли расход: ноль и пустое значение — это отсутствие данных. */
    function hasTokens(card) {
      return Number(String(card.tokens || "").replace(/\s+/g, "")) > 0;
    }

    /** Подпись роли: известные роли берём из словаря, незнакомую показываем как записана. */
    function roleLabel(role, t) {
      const value = String(role || "").trim().toLowerCase();
      if (value === "") return "";
      const key = "role." + value;
      const label = t(key);
      return typeof label === "string" && label !== "" && label !== key ? label : value;
    }

    /** Короткая подпись владельца: id сессии длинный, в карточке хватит начала. */
    function shortOwner(owner) {
      const value = String(owner || "");
      return value.length > 14 ? value.slice(0, 12) + "…" : value;
    }

    /** Одна карточка задачи. */
    /**
     * Панель деталей задачи: открывается кликом по карточке. Показывает название,
     * расход токенов с разбивкой по ролям, роль и владельца-сессию, описание задачи
     * и все комментарии ролей за время решения.
     */
    function CardDetails({ card, t, onClose }) {
      const rows = [];
      if (hasTokens(card)) {
        const breakdown = Object.entries(card.usage || {})
          .map(([role, value]) => role + ": " + formatTokens(value))
          .join("; ");
        rows.push(
          h(
            "div",
            { key: "tokens", style: styles.detailsRow },
            h("span", { style: styles.detailsLabel }, t("tokens") + ":"),
            h("span", null, formatTokens(card.tokens) + (breakdown ? " (" + breakdown + ")" : ""))
          )
        );
      }
      const who = [card.role ? roleLabel(card.role, t) : "", card.owner ? shortOwner(card.owner) : t("noOwner")]
        .filter(Boolean)
        .join(" · ");
      rows.push(
        h(
          "div",
          { key: "who", style: styles.detailsRow },
          h("span", { style: styles.detailsLabel }, t("session") + ":"),
          h("span", { title: card.owner || "" }, who)
        )
      );
      if (card.since) {
        rows.push(
          h(
            "div",
            { key: "since", style: styles.detailsRow },
            h("span", { style: styles.detailsLabel }, t("since") + ":"),
            h("span", null, card.since)
          )
        );
      }

      const comments = Array.isArray(card.comments) ? card.comments : [];
      const commentNodes = comments.length
        ? comments.map((comment, index) =>
            h(
              "div",
              { key: "c" + index, style: styles.comment, "data-kanban-comment": String(index) },
              h(
                "div",
                { style: styles.commentHead },
                h("span", null, comment.at),
                h("span", null, comment.status)
              ),
              h("div", { style: styles.detailsText }, comment.text)
            )
          )
        : [h("div", { key: "none", style: styles.detailsText }, t("noComments"))];

      return h(
        "aside",
        { style: styles.details, "data-kanban-details": String(card.id) },
        h(
          "div",
          { style: styles.detailsHead },
          h("div", { style: styles.detailsTitle }, card.title),
          h(
            "button",
            { type: "button", style: styles.refresh, title: t("close"), onClick: () => onClose && onClose() },
            "✕"
          )
        ),
        h("div", { style: styles.detailsRow }, h("span", { style: styles.detailsLabel }, "#" + card.id)),
        rows,
        h("div", { style: styles.detailsSection }, t("description")),
        h("div", { style: styles.detailsText }, card.description || "—"),
        h("div", { style: styles.detailsSection }, t("comments") + " (" + comments.length + ")"),
        commentNodes
      );
    }

    function Card({ card, t, onSelect, selected }) {
      const column = COLUMN_BY_ID[card.status] || COLUMN_BY_ID.todo;
      const children = [
        h(
          "div",
          { key: "top", style: styles.cardTop },
          h("span", { style: styles.cardId }, "#" + card.id),
          card.source === "worktree"
            ? h("span", { key: "branch", style: styles.branchBadge, title: card.path || "" }, t("inBranch"))
            : null,
          card.role
            ? h(
                "span",
                {
                  key: "role",
                  style: styles.roleBadge,
                  title: card.since ? card.role + " · " + t("since") + " " + card.since : card.role
                },
                roleLabel(card.role, t)
              )
            : null,
          card.owner
            ? h("span", { style: styles.owner, title: card.owner }, shortOwner(card.owner))
            : h("span", { style: styles.ownerEmpty }, t("noOwner"))
        ),
        h(
          "div",
          {
            key: "title",
            style:
              card.status === "merged"
                ? Object.assign({}, styles.cardTitle, styles.cardTitleMerged)
                : styles.cardTitle
          },
          card.title
        )
      ];
      if (card.branch) children.push(h("div", { key: "branch", style: styles.meta }, card.branch));
      if (hasTokens(card)) {
        const breakdown = Object.entries(card.usage || {})
          .map(([role, value]) => role + ": " + formatTokens(value))
          .join("; ");
        children.push(
          h(
            "div",
            { key: "tokens", style: styles.meta, title: breakdown || card.tokens },
            t("tokens") + ": " + formatTokens(card.tokens)
          )
        );
      }
      if (card.note) children.push(h("div", { key: "note", style: styles.note, title: card.note }, clampText(card.note, 140)));
      if (card.updated) children.push(h("div", { key: "updated", style: styles.meta }, card.updated));
      const style = Object.assign(
        {},
        styles.card,
        { borderLeftColor: column.color },
        selected ? styles.cardSelected : null,
        onSelect ? { cursor: "pointer" } : null
      );
      return h(
        "article",
        {
          style,
          title: card.file,
          "data-kanban-card": card.id,
          "data-kanban-status": card.status,
          onClick: onSelect ? () => onSelect(card.key) : undefined
        },
        children
      );
    }

    /** Тело таба: шапка, предупреждения и колонки. */
    function KanbanBody(props) {
      const sessionId = props.sessionId;
      const t = props.t;
      const useSessions = props.useSessions;
      const loadBoard = props.loadBoard;

      const cwd =
        typeof useSessions === "function"
          ? useSessions((sessions) => {
              const row = sessions && sessions.byId ? sessions.byId[sessionId] : undefined;
              return row ? row.cwd : undefined;
            })
          : undefined;

      const [state, setState] = React.useState({ phase: "loading", cards: [], problems: [], truncated: false, error: "" });
      // Какая карточка открыта в панели деталей (ключ — имя файла).
      const [selectedKey, setSelectedKey] = React.useState(null);
      const signature = React.useRef("");
      const tickRef = React.useRef(null);
      const loadRef = React.useRef(loadBoard);
      React.useEffect(() => {
        loadRef.current = loadBoard;
      }, [loadBoard]);

      React.useEffect(() => {
        let stopped = false;
        let timer = 0;
        const controller = new AbortController();
        const tick = async () => {
          let result;
          if (typeof loadRef.current !== "function") return;
          try {
            result = await loadRef.current(controller.signal);
          } catch (error) {
            result = { ok: false, error: describeError(error) };
          }
          if (stopped) return;
          const ok = Boolean(result && result.ok);
          const value = (ok && result.value) || { cards: [], problems: [] };
          const next = {
            phase: ok ? "ready" : "error",
            cards: value.cards || [],
            problems: value.problems || [],
            truncated: value.truncated === true,
            error: ok ? "" : describeError(result ? result.error : null)
          };
          const fingerprint = JSON.stringify([next.error, next.problems, next.truncated, next.cards.map((card) => [card.id, card.status, card.owner, card.updated, card.title])]);
          if (fingerprint === signature.current) return;
          signature.current = fingerprint;
          setState((previous) => (ok ? next : Object.assign({}, previous, { phase: previous.cards.length ? "ready" : "error", error: next.error })));
        };
        tickRef.current = tick;
        tick();
        timer = setInterval(tick, POLL_MS);
        return () => {
          stopped = true;
          if (timer) clearInterval(timer);
          controller.abort();
        };
      }, [sessionId]);

      const columns = COLUMNS.map((column) => ({
        column,
        items: state.cards.filter((card) => card.status === column.id)
      }));
      const selectedCard = state.cards.find((card) => card.key === selectedKey) || null;
      const workspaceLabel = cwd ? cwd.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || cwd : t("noWorkspace");

      const body = [];
      body.push(
        h(
          "div",
          { key: "header", style: styles.header },
          h("span", { style: styles.headerTitle }, t("title")),
          h("span", { style: styles.headerMeta, title: cwd || "" }, workspaceLabel + " · " + state.cards.length + " " + t("cards")),
          h(
            "button",
            {
              type: "button",
              style: styles.refresh,
              title: t("refresh"),
              onClick: () => {
                if (typeof tickRef.current === "function") tickRef.current();
              }
            },
            "⟳"
          )
        )
      );
      if (state.error) body.push(h("div", { key: "error", style: styles.banner }, t("error") + ": " + state.error));
      if (state.problems.length) body.push(h("div", { key: "problems", style: styles.note }, t("problems") + ": " + state.problems.join("; ")));
      if (state.truncated) body.push(h("div", { key: "truncated", style: styles.note }, t("truncated")));

      if (state.cards.length === 0 && !state.error) {
        body.push(h("div", { key: "empty", style: styles.empty }, h("div", null, t("missing")), h("div", { style: styles.mono }, 'bash bin/task-new.sh "название задачи"')));
      } else {
        body.push(
          h(
            "div",
            { key: "board", style: styles.board },
            columns.map(({ column, items }) =>
              h(
                "section",
                { key: column.id, style: styles.column, "data-kanban-column": column.id },
                h(
                  "header",
                  { style: styles.columnHeader },
                  h("span", { style: Object.assign({}, styles.dot, { background: column.color }) }),
                  h("span", null, t("column." + column.id)),
                  h("span", { style: styles.count }, String(items.length))
                ),
                h(
                  "div",
                  { style: styles.columnBody },
                  items.length === 0
                    ? h("div", { style: { opacity: 0.35, fontSize: 11 } }, "—")
                    : items.map((card) =>
                        h(Card, {
                          key: card.key,
                          card,
                          t,
                          onSelect: setSelectedKey,
                          selected: card.key === selectedKey
                        })
                      )
                )
              )
            ),
            selectedCard
              ? h(CardDetails, { key: "details", card: selectedCard, t, onClose: () => setSelectedKey(null) })
              : null
          )
        );
      }
      return h("div", { style: styles.root, "data-kanban-phase": state.phase }, body);
    }

    /** Заголовок таба. */
    function KanbanTitle(props) {
      return h("span", null, props.t ? props.t("title") : "Kanban");
    }

    const ru = {
      title: "Канбан",
      guide: "Задачи агентов: что в очереди, что в работе, что на ревью, что на проверке и что уже влито",
      cards: "карточек",
      noWorkspace: "нет рабочей директории",
      noOwner: "не назначен",
      inBranch: "в ветке",
      tokens: "токенов",
      since: "с",
      details: "Детали задачи",
      description: "Описание",
      comments: "Комментарии",
      noComments: "Комментариев пока нет",
      session: "Сессия",
      close: "Закрыть",
      "role.worker": "исполнитель",
      "role.reviewer": "ревьювер",
      "role.verifier": "тестировщик",
      "role.dispatcher": "оркестратор",
      refresh: "Обновить сейчас",
      error: "Ошибка чтения доски",
      problems: "Часть карточек не прочитана",
      truncated: "Список файлов обрезан (слишком много карточек)",
      missing: "Карточек пока нет: каталог .kanban/tasks пуст или отсутствует.",
      "column.todo": "Нужно сделать",
      "column.in-progress": "В работе",
      "column.in-review": "На ревью",
      "column.testing": "Тестирование",
      "column.ready": "Готово к слиянию",
      "column.merged": "Влито",
      "column.blocked": "Заблокировано"
    };

    const en = {
      title: "Kanban",
      guide: "Agent tasks: queued, in progress, in review, in testing, and merged",
      cards: "cards",
      noWorkspace: "no workspace",
      noOwner: "unassigned",
      inBranch: "in branch",
      tokens: "tokens",
      details: "Card details",
      description: "Description",
      comments: "Comments",
      noComments: "No comments yet",
      session: "Session",
      close: "Close",
      since: "since",
      "role.worker": "executor",
      "role.reviewer": "reviewer",
      "role.verifier": "tester",
      "role.dispatcher": "orchestrator",
      refresh: "Refresh now",
      error: "Board read failed",
      problems: "Some cards could not be read",
      truncated: "File listing truncated (too many cards)",
      missing: "No cards yet: .kanban/tasks is empty or missing.",
      "column.todo": "Todo",
      "column.in-progress": "In progress",
      "column.in-review": "In review",
      "column.testing": "Testing",
      "column.ready": "Ready to merge",
      "column.merged": "Merged",
      "column.blocked": "Blocked"
    };

    /** Сервисы Cordis, без которых `apply` не запускается. */
    const inject = ["slots", "locale", "sidebarRightTabs", "remote", "remote.workspaceFiles"];

    /** Тело плагина: тип таба, словари, тело и заголовок. */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, ru }), "dsh-kanban: dictionaries");
      const t = ctx.locale.bind(NS);

      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
            id: ID,
            kind: KIND,
            priority: "extension",
            title: () => t("title"),
            guide: [{ order: 30, title: () => t("title"), description: () => t("guide") }]
          }),
        "dsh-kanban: tab type"
      );

      const loadBoard = createLoader(ctx.remote);
      ctx.effect(
        () =>
          ctx.slots.inject("sidebar.right.pane.tab", () =>
            ctx.slots.register(
              { name: "sidebar.right.pane.tab", key: ID, locale: NS, inject: boardFace(loadBoard) },
              KanbanBody
            )
          ),
        "dsh-kanban: board body"
      );
      ctx.effect(
        () =>
          ctx.slots.inject("sidebar.right.pane.tab.title", () =>
            ctx.slots.register({ name: "sidebar.right.pane.tab.title", key: ID, locale: NS }, KanbanTitle)
          ),
        "dsh-kanban: board title"
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    // Внутренности для тестов и генератора макета (dsh-kanban/test,
    // dsh-kanban/docs): рантайм DSH их не использует, браузеру они не мешают.
    exports.__internals = { parseCard, parseFrontMatter, normalizeStatus, createLoader, readManifest, listWorktreeCards, isNewer, compareCards, splitCardBody, CardDetails, styles, COLUMNS };
    return module.exports;
  }
});
