import fs from 'fs';
import path from 'path';

/**
 * Запрос паузы пайплайна.
 *
 * Файл пишет тот, кто управляет запуском со стороны (расширение VS Code),
 * раннер только читает его между стадиями. Пока файл есть и адресован этому
 * раннеру, следующая стадия не начинается; удаление файла снимает паузу.
 *
 * Адресат — pid раннера: запрос, оставшийся от прошлого запуска, не должен
 * останавливать новый. Формат: `{ "pid": 1234, "requested_at": "…", "requested_by": "extension" }`.
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
 */
export function readPauseRequest(projectRoot, pid) {
  try {
    const data = JSON.parse(fs.readFileSync(pauseRequestPath(projectRoot), 'utf8'));
    return data && data.pid === pid ? data : null;
  } catch {
    return null;
  }
}
