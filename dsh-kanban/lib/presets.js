/**
 * Самолечение пресетов ролей (#062, issue #1).
 *
 * ## Зачем
 *
 * Пресет сессии — это её **id** в логе (`dispatcher`, `worker`, `reviewer`,
 * `verifier`), а при рестарте DSH берёт *текущее* определение этого id: «recovery
 * … uses the current definition of that ID and rejects a missing definition».
 * До этой задачи определения жили только в профильном патче
 * (`bin/install-presets.sh` → `cordis.patch.yml`), и обновление/сброс профиля
 * или новая машина могли оставить профиль без строк — тогда существующие
 * сессии слетали в стандартные, сторож не мог доставлять наряды, а сменить
 * пресет у непустой сессии нельзя (это апстрим DSH), то есть оставалось только
 * архивировать и пересоздавать парк сессий.
 *
 * ## Что делает
 *
 * Host-половина плагина при старте читает `presets/role-presets.json` (артефакт
 * `bin/gen-role-presets.sh`, едет вместе с пакетом) и регистрирует определения в
 * реестре DSH (`agentPresets.register(definition)`). Версия пресетов теперь
 * совпадает с версией плагина, и потерять их «обновлением» нельзя.
 *
 * Дубликаты — норма: если профиль по-прежнему ставит legacy-строки
 * (`bin/install-presets.sh`), они регистрируются раньше, а реестр бросает
 * `Duplicate agent preset: <id>`. Плагин ловит это, пишет предупреждение и идёт
 * дальше: старые установки работают как раньше, новые — без строк профиля.
 *
 * Ничего не пишется на диск и не меняется в реестре, кроме собственных
 * определений: выгрузка плагина снимает их (disposer возвращает `register()`),
 * повторный вызов disposer идемпотентен.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Каталог пакета плагина. Путь к артефакту считается от него, а не от cwd
 * сессии: host-половина грузится из пакета в профиле, а сессия живёт где угодно.
 */
export const PACKAGE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Артефакт с определениями ролей: его генерирует `bin/gen-role-presets.sh`. */
export const PRESETS_FILE = path.join(PACKAGE_DIR, "presets", "role-presets.json");

/**
 * Стабильные id ролей. Они записаны в логах сессий, поэтому **переименовывать
 * нельзя** — только добавлять новые (правило релиза, спека 005).
 */
export const ROLE_IDS = ["dispatcher", "worker", "reviewer", "verifier", "analyst"];

/** Предел текста диагностики, чтобы лог не разрастался. */
const MAX_MESSAGE = 400;

function shortText(value) {
  const text = String(value == null ? "" : value)
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= MAX_MESSAGE ? text : text.slice(0, MAX_MESSAGE - 1) + "…";
}

/**
 * Прочитать определения ролей из JSON-артефакта.
 *
 * @param file - путь к артефакту (по умолчанию — в пакете плагина).
 * @returns `{ ok: true, definitions }` либо `{ ok: false, message }`.
 */
export function readRolePresets(file = PRESETS_FILE) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    return {
      ok: false,
      message: `пресеты ролей: файл ${file} не прочитан (${error?.code ?? error?.message ?? error}); перегенерируйте: bin/gen-role-presets.sh`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      message: `пресеты ролей: ${file} — не JSON (${error.message}); перегенерируйте: bin/gen-role-presets.sh`,
    };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return {
      ok: false,
      message: `пресеты ролей: ${file} должен содержать непустой массив определений; перегенерируйте: bin/gen-role-presets.sh`,
    };
  }
  const definitions = [];
  for (const [index, definition] of parsed.entries()) {
    const id = definition && typeof definition.id === "string" ? definition.id.trim() : "";
    if (id === "") {
      return { ok: false, message: `пресеты ролей: определение №${index + 1} без id — файл испорчен` };
    }
    if (!Array.isArray(definition.plugins) || definition.plugins.length === 0) {
      return { ok: false, message: `пресеты ролей: у роли «${id}» пустой список plugins — файл испорчен` };
    }
    definitions.push(definition);
  }
  return { ok: true, definitions };
}

/**
 * Зарегистрировать определения ролей в реестре пресетов DSH.
 *
 * @param options - `{ agentPresets, log, file }`:
 *   `agentPresets` — служба реестра из контекста плагина (метод `register`),
 *   `log(level, message)` — лог плагина, `file` — путь к артефакту (для тестов).
 * @returns `{ ok, registered, duplicates, failures, dispose }`:
 *   `registered`/`duplicates`/`failures` — id ролей по исходам, `dispose()` снимает
 *   определения в обратном порядке и идемпотентен.
 */
export async function registerRolePresets({ agentPresets, log = () => {}, file = PRESETS_FILE } = {}) {
  const registered = [];
  const duplicates = [];
  const failures = [];

  /** Снятие регистраций: обратный порядок, повторный вызов ничего не делает. */
  let disposed = false;
  const disposers = [];
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    for (const { id, unregister } of disposers.reverse()) {
      try {
        await unregister();
      } catch (error) {
        log("warn", `пресеты ролей: «${id}» не снялся: ${shortText(error?.message ?? error)}`);
      }
    }
    disposers.length = 0;
  };

  const read = readRolePresets(file);
  if (!read.ok) {
    log("warn", read.message);
    return { ok: false, registered, duplicates, failures, dispose };
  }

  if (!agentPresets || typeof agentPresets.register !== "function") {
    log("warn", "пресеты ролей: служба agentPresets недоступна — определения не зарегистрированы");
    return { ok: false, registered, duplicates, failures, dispose };
  }

  for (const definition of read.definitions) {
    const id = String(definition.id);
    try {
      const unregister = await agentPresets.register(definition);
      registered.push(id);
      if (typeof unregister === "function") disposers.push({ id, unregister });
    } catch (error) {
      const message = String(error?.message ?? error);
      // Дубликат — не ошибка: legacy-строки профиля зарегистрировались первыми
      // (или пресет уже объявлен другой копией плагина). Такие установки живут
      // как раньше, плагин лишь не дублирует определения.
      if (message.startsWith("Duplicate agent preset")) {
        duplicates.push(id);
        log("warn", `пресеты ролей: «${id}» уже зарегистрирован (дубликат) — оставляю существующее определение`);
        continue;
      }
      failures.push(id);
      log("warn", `пресеты ролей: «${id}» не зарегистрирован: ${shortText(message)}`);
    }
  }

  const summary = `пресеты ролей: зарегистрировано ${registered.length}, дубликатов ${duplicates.length}, ошибок ${failures.length}`;
  if (failures.length > 0) log("warn", summary);
  else log("info", summary);

  return { ok: failures.length === 0, registered, duplicates, failures, dispose };
}
