import fs from 'fs';
import path from 'path';

/**
 * Запрос паузы пайплайна.
 *
 * Файл пишет тот, кто управляет запуском со стороны (расширение VS Code),
 * раннер только читает его между стадиями. Пока файл есть и адресован этому
 * раннеру, следующая стадия не начинается; удаление файла снимает паузу.
 *
 * Адресат — pid раннера, и запрос должен быть моложе старта раннера: файл,
 * оставшийся от прошлого запуска (его раннер убили, не дав убрать за собой),
 * не должен останавливать новый, даже если система выдала тот же pid.
 * Формат: `{ "pid": 1234, "requested_at": "…", "requested_by": "extension" }`.
 */
export const PAUSE_REQUEST_FILE = '.workflow/state/pause-request.json';

/** Что раннер умеет сверх базового протокола — пишется в lock (`capabilities`). */
export const RUNNER_CAPABILITIES = Object.freeze(['pause-request']);

export function pauseRequestPath(projectRoot) {
  return path.join(projectRoot, PAUSE_REQUEST_FILE);
}

/**
 * Запрос паузы, адресованный процессу `pid`, или null.
 * Нечитаемый файл — не запрос: его мог оставить оборванный на середине writer,
 * и вечная пауза из-за мусора хуже пропущенной.
 *
 * @param {string} projectRoot
 * @param {number} pid
 * @param {number} [notBeforeMs] старт раннера: запрос старше него — чужой
 */
export function readPauseRequest(projectRoot, pid, notBeforeMs) {
  try {
    const data = JSON.parse(fs.readFileSync(pauseRequestPath(projectRoot), 'utf8'));
    if (!data || data.pid !== pid) { return null; }
    if (notBeforeMs !== undefined) {
      const requestedAt = Date.parse(data.requested_at);
      if (Number.isNaN(requestedAt) || requestedAt < notBeforeMs) { return null; }
    }
    return data;
  } catch {
    return null;
  }
}
