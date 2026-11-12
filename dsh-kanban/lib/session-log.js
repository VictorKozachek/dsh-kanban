/**
 * Чтение лога сессии DSH (`session.v4.jsonl.zstd`) без записи.
 *
 * Лог — конкатенация независимых zstd-кадров: первый кадр — заголовок
 * (`{type:"session", version:4, …}`), дальше по кадру на батч событий. Здесь
 * только чтение: нужно сторожу, чтобы понять, остался ли у сессии открытый ход
 * после перезапуска (issue #4). Запись (смена пресета) — в `bin/session-preset.mjs`.
 */
import fs from "node:fs";
import zlib from "node:zlib";

const ZSTD_MAGIC = 0xfd2fb528;

/** Разбить файл на zstd-кадры, не распаковывая данные. */
export function splitFrames(buf) {
  const frames = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    if (buf.readUInt32LE(pos) !== ZSTD_MAGIC) return { frames, torn: buf.length - pos };
    const start = pos;
    pos += 4;
    if (pos >= buf.length) return { frames, torn: buf.length - start };
    const descriptor = buf[pos];
    pos += 1;
    const fcsFlag = descriptor >> 6;
    const singleSegment = (descriptor >> 5) & 1;
    const hasChecksum = (descriptor >> 2) & 1;
    const dictFlag = descriptor & 3;
    if (!singleSegment) pos += 1;
    pos += [0, 1, 2, 4][dictFlag];
    pos += fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag];
    let last = 0;
    while (!last) {
      if (pos + 3 > buf.length) return { frames, torn: buf.length - start };
      const header = buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16);
      pos += 3;
      last = header & 1;
      const type = (header >> 1) & 3;
      const size = header >>> 3;
      pos += type === 1 ? 1 : size;
      if (pos > buf.length) return { frames, torn: buf.length - start };
    }
    if (hasChecksum) pos += 4;
    if (pos > buf.length) return { frames, torn: buf.length - start };
    frames.push(buf.subarray(start, pos));
  }
  return { frames, torn: buf.length - pos };
}

/** Декодировать лог: `{ header, events, frames, torn, problems }`. */
export function decodeLog(buf) {
  const { frames, torn } = splitFrames(buf);
  const problems = [];
  const lines = [];
  if (frames.length === 0) problems.push("в файле нет ни одного zstd-кадра");
  frames.forEach((frame, index) => {
    try {
      const text = zlib.zstdDecompressSync(frame).toString("utf8");
      for (const line of text.split("\n")) {
        if (line.trim() !== "") lines.push(line);
      }
    } catch (error) {
      problems.push(`кадр №${index + 1} не распакован: ${error?.message ?? error}`);
    }
  });
  let header = null;
  const events = [];
  for (const line of lines) {
    let value;
    try {
      value = JSON.parse(line);
    } catch (error) {
      problems.push(`строка не JSON: ${error?.message ?? error}`);
      continue;
    }
    if (header === null && value && typeof value === "object" && value.type === "session") header = value;
    else events.push(value);
  }
  return { header, events, frames, torn, problems };
}

/** Открыт ли последний ход: последний `turn/start` новее закрытия. */
export function openTurnOf(events) {
  let start = -1;
  let end = -1;
  for (const event of events ?? []) {
    const seq = Number(event?.seq ?? 0);
    if (event?.type === "turn/start") start = Math.max(start, seq);
    else if (event?.type === "turn/end" || event?.type === "turn/aborted") end = Math.max(end, seq);
  }
  return start > end;
}

/** seq последнего `turn/start` — идентификатор открытого хода для дедупа. */
export function lastTurnStartSeq(events) {
  let start = -1;
  for (const event of events ?? []) {
    if (event?.type === "turn/start") start = Math.max(start, Number(event?.seq ?? 0));
  }
  return start;
}

/** Прочитать и декодировать лог по пути; null — файла нет. */
export function readLog(file) {
  try {
    return decodeLog(fs.readFileSync(file));
  } catch {
    return null;
  }
}

/** Время последнего события (мс) или 0. */
export function lastEventTime(events) {
  let at = 0;
  for (const event of events ?? []) {
    const time = Number(event?.time ?? 0);
    if (Number.isFinite(time) && time > at) at = time;
  }
  return at;
}

/** Тип последнего инструмента (для распознавания «ждал человека»). */
export function lastToolName(events) {
  let name = null;
  for (const event of events ?? []) {
    if (event?.type === "tool/call" && typeof event?.data?.name === "string") name = event.data.name;
    if (event?.type === "tool/result") name = null;
  }
  return name;
}
