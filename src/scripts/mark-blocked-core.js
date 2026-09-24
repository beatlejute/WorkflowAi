/**
 * mark-blocked-core.js — ядро mark-blocked.js, пригодное для импорта.
 *
 * Зачем отдельный модуль: mark-blocked.js при импорте ищет корень проекта, разбирает
 * argv и может завершить процесс (process.exit) — импортировать его из замера нельзя.
 * Поэтому замер держал рукописную копию: поиск тикета, чтение, правка frontmatter,
 * запись, дозапись в alerts.jsonl. Копия не ловила регресс в боевом коде и краснела
 * от любого расхождения с ним. Теперь логика одна, а CLI остаётся тонкой обёрткой:
 * разбор аргументов и печать сообщений.
 *
 * Модуль намеренно без побочных эффектов при импорте: пути и зависимости — аргументами.
 */

import fs from "fs";
import path from "path";
import { parseFrontmatter, serializeFrontmatter, replaceFileAtomicSync } from "workflow-ai/lib/utils.mjs";

/**
 * Рекурсивно ищет файл тикета по префиксу имени.
 *
 * @param {string} ticketId - ID тикета
 * @param {string} searchDir - корень поиска
 * @param {object} options
 * @param {object} [options.fsModule] - модуль fs (подмена для тестов и подсчёта операций)
 * @returns {string|null} путь к файлу или null
 */
export function findTicketFile(ticketId, searchDir, { fsModule = fs } = {}) {
  try {
    const files = fsModule.readdirSync(searchDir, { withFileTypes: true });

    for (const file of files) {
      const fullPath = path.join(searchDir, file.name);

      if (file.isDirectory()) {
        // Рекурсивный поиск в поддиректориях
        const found = findTicketFile(ticketId, fullPath, { fsModule });
        if (found) return found;
      } else if (file.isFile() && file.name.endsWith('.md') && file.name.startsWith(ticketId)) {
        return fullPath;
      }
    }
  } catch (error) {
    console.error(`Ошибка при чтении директории ${searchDir}:`, error.message);
  }

  return null;
}

/**
 * Помечает тикет как авто-заблокированный: правит frontmatter и дозаписывает алерт.
 *
 * Возвращает описание того, что произошло, — печать сообщений остаётся за вызывающим,
 * чтобы у CLI не менялся вывод, а замеры не платили за консоль.
 *
 * @param {object} params
 * @param {string} params.ticketId
 * @param {number|null} params.attempts
 * @param {string} params.reason
 * @param {string} params.ticketsDir - корень поиска тикета
 * @param {string} params.stateDir - директория .workflow/state
 * @param {string} params.alertsFile - путь к alerts.jsonl
 * @param {string} [params.project] - имя проекта для записи алерта
 * @param {object} [params.fsModule] - модуль fs
 * @returns {{ticketFile: string, blockedAt: string, stateDirCreated: boolean,
 *            alertWritten: boolean, alertError: string|null}}
 * @throws {Error} если тикет не найден
 */
export function markBlockedTicket({
  ticketId,
  attempts,
  reason,
  ticketsDir,
  stateDir,
  alertsFile,
  project,
  fsModule = fs,
}) {
  const ticketFile = findTicketFile(ticketId, ticketsDir, { fsModule });
  if (!ticketFile) {
    const error = new Error(`Тикет ${ticketId} не найден в ${ticketsDir}`);
    error.code = 'TICKET_NOT_FOUND';
    throw error;
  }

  // Чтение файла тикета
  const content = fsModule.readFileSync(ticketFile, 'utf8');
  const { frontmatter, body } = parseFrontmatter(content);

  // Обновление frontmatter
  const now = new Date().toISOString();
  frontmatter.auto_blocked_reason = reason;
  frontmatter.auto_blocked_attempts = attempts;
  frontmatter.auto_blocked_at = now;

  // Сериализация и запись обратно в файл.
  //
  // Не writeFileSync поверх тикета: он раскрывается в open(файл, 'w') и запись
  // вторым шагом, то есть усекает файл сразу, а содержимое отдаёт позже. В этом
  // окне сканер доски (pick-next-task readTicketsFromDir, check-conditions
  // readTickets, sync-ticket-status, check-anomalies) получает тикет нулевой
  // длины или с обрезанным хвостом — и молча считает неправду: id подставляется
  // из имени файла, статус и parent_plan пропадают, секция Result теряется, и
  // findCompletedInProgress перестаёт видеть тикет доделанным. Ни одна из этих
  // функций при этом не падает. Проверено прогоном без единой правки боевого
  // кода: конкурентный читатель за 4 с получил 3 пустых и 23 обрезанных чтения
  // из 275.
  //
  // Имя временного файла берётся общее (tempSiblingPath). Своё здесь было
  // заведено из-за длинных id: компонент пути длиннее 255 символов NTFS не
  // создаёт, а id тикета бывает больше 200 (src/tests/edge-ticket-id-long.test.mjs),
  // и общее имя выходило за предел — ENOENT на записи там, где прямая запись
  // проходила. С 2026-09-24 общий помощник имя урезает сам, поэтому копия
  // убрана: две формы временного имени означали бы, что исключение
  // artifact-snapshot нужно держать в двух местах, и второе про это забыло бы.
  //
  // Операция — rename поверх (внутри replaceFileAtomicSync), а не link: тикет
  // обновляется на месте, перезапись существующего файла здесь норма, и link
  // падал бы EEXIST на каждой блокировке. Про повторы rename на NTFS — в
  // комментарии к самому помощнику.
  const newContent = serializeFrontmatter(frontmatter) + body;
  replaceFileAtomicSync(ticketFile, newContent, { fsModule });

  const result = {
    ticketFile,
    blockedAt: now,
    stateDirCreated: false,
    alertWritten: false,
    alertError: null,
  };

  // Алерт — best effort: недоступный state/ не должен отменять правку тикета.
  try {
    if (!fsModule.existsSync(stateDir)) {
      fsModule.mkdirSync(stateDir, { recursive: true });
      result.stateDirCreated = true;
    }

    const alertEntry = {
      timestamp: now,
      severity: "warning",
      kind: "ticket_auto_blocked",
      project,
      ticket_id: ticketId,
      attempts: attempts,
      reason: reason,
      stage: "review-result"
    };

    // Append-only запись в alerts.jsonl
    fsModule.appendFileSync(alertsFile, JSON.stringify(alertEntry) + '\n', 'utf8');
    result.alertWritten = true;
  } catch (alertError) {
    result.alertError = alertError.message;
  }

  return result;
}
