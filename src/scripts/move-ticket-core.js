/**
 * move-ticket-core.js — ядро approval-хука из move-ticket.js, пригодное для импорта.
 *
 * Зачем отдельный модуль: сам move-ticket.js при импорте вычисляет корень проекта
 * (findProjectRoot) и разбирает argv, поэтому замеры не могли его импортировать и
 * держали у себя рукописную копию хука. Копия жила отдельной жизнью: регресс в
 * боевом хуке замеры не видели, а расхождение копии с оригиналом давало ложную
 * тревогу. Здесь лежит один экземпляр логики — и CLI, и замеры зовут его.
 *
 * Модуль намеренно без побочных эффектов при импорте: ни поиска корня, ни чтения
 * argv, ни записи в файлы. Все пути и зависимости приходят аргументами.
 */

import fs from "fs";
import path from "path";
import { replaceFileAtomicSync, approvalTempPath } from "../lib/utils.mjs";

// Хук вызывается из CLI, где у каждого сообщения свой префикс, и из замеров, где
// логи не нужны. Заглушка по умолчанию избавляет замеры от подмены консоли.
// Обе ручки — одна и та же пустая функция: отдельные стрелки на слот остаются
// непокрытыми и роняют файл ниже порога функций в гейте покрытия.
const noop = () => {};
const SILENT_LOGGER = { info: noop, warn: noop };

/**
 * Обновляет approval-файлы тикета при перемещении: pending → approved.
 *
 * @param {string} ticketId - ID тикета
 * @param {string} target - целевой статус
 * @param {object} fsModule - модуль fs (для mock в тестах и для подсчёта операций)
 * @param {string} workflowDir - директория .workflow
 * @param {object} logger - приёмник сообщений (info/warn)
 */
export function updateApprovalFilesHook(
  ticketId,
  target,
  fsModule = fs,
  workflowDir,
  logger = SILENT_LOGGER,
) {
  try {
    const approvalsDir = path.join(workflowDir, "approvals");
    if (fsModule.existsSync(approvalsDir)) {
      const files = fsModule.readdirSync(approvalsDir);
      const escapedTicketId = ticketId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`^${escapedTicketId}_manual-gate-.*_\\d+\\.json$`);
      for (const file of files) {
        if (!pattern.test(file)) continue;
        const filePath = path.join(approvalsDir, file);
        try {
          const data = JSON.parse(fsModule.readFileSync(filePath, "utf8"));
          if (data.status === "pending") {
            data.status = "approved";
            data.decided_by = "move-ticket";
            data.comment = `auto-approved on move to ${target}`;
            data.updated_at = new Date().toISOString();
            // Решение вписывается заменой файла целиком. Прямая запись обрезала
            // approval-файл до нуля, и раннер в poll-цикле гейта читал пустую
            // строку: readApprovalFile отвечает на это «corrupt approval file» и
            // уводит стадию в goto.error ровно в тот момент, когда человек нажал
            // approve (инцидент QA-37-003). Ретраи на стороне чтения (25 и 50 мс) —
            // страховка, а не решение: под нагрузкой они не успевают.
            replaceFileAtomicSync(filePath, JSON.stringify(data, null, 2), {
              fsModule,
              tmpPath: approvalTempPath(workflowDir),
            });
            logger.info(`Approval file ${file} auto-approved on move to ${target}`);
          }
        } catch (err) {
          logger.warn(`Corrupt approval file ${file}: ${err.message}`);
          // продолжаем, не падаем
        }
      }
    }
  } catch (err) {
    // Ошибка hook'а не должна фейлить само перемещение
    logger.warn(`Approval hook error: ${err.message}`);
  }
}
