/**
 * sync-ticket-status-core.js — синхронизация frontmatter.status тикетов с папкой доски.
 *
 * Вынесено из sync-ticket-status.js, чтобы поведение проверялось тестом: сам
 * скрипт вызывает main() при импорте и для теста непригоден (тот же приём, что
 * mark-blocked-core.js и pick-next-task-core.js).
 */

import fs from 'fs';
import path from 'path';
import { parseFrontmatter, serializeFrontmatter, replaceFileAtomicSync } from 'workflow-ai/lib/utils.mjs';

// Папки доски == допустимые значения status (см. VALID_STATUSES в move-ticket.js).
// archive/ намеренно исключён: там лежат тикеты закрытых планов, их status
// отражает состояние на момент архивации.
export const BOARD_DIRS = ['backlog', 'ready', 'in-progress', 'review', 'blocked', 'done'];

/**
 * Синхронизирует статусы тикетов одного проекта.
 *
 * @param {string} projectRoot
 * @param {boolean} apply - false = только отчёт
 * @returns {{statusFixed: Array, completedFilled: Array, scanned: number}}
 */
export function syncProject(projectRoot, apply) {
  const ticketsDir = path.join(projectRoot, '.workflow', 'tickets');
  const statusFixed = [];
  const completedFilled = [];
  let scanned = 0;

  for (const dir of BOARD_DIRS) {
    const dirPath = path.join(ticketsDir, dir);
    if (!fs.existsSync(dirPath)) continue;

    for (const file of fs.readdirSync(dirPath)) {
      if (!file.endsWith('.md') || file === '.gitkeep.md') continue;

      const filePath = path.join(dirPath, file);
      let content;
      try {
        content = fs.readFileSync(filePath, 'utf8');
      } catch (e) {
        console.error(`[WARN] ${file}: не читается — ${e.message}`);
        continue;
      }

      let parsed;
      try {
        parsed = parseFrontmatter(content);
      } catch (e) {
        console.error(`[WARN] ${file}: битый frontmatter — ${e.message}`);
        continue;
      }

      const { frontmatter, body } = parsed;
      if (!frontmatter || Object.keys(frontmatter).length === 0) continue;

      scanned++;
      const id = frontmatter.id || file.replace('.md', '');
      let changed = false;

      if (frontmatter.status !== dir) {
        statusFixed.push({ id, dir, was: frontmatter.status || '(нет)' });
        frontmatter.status = dir;
        changed = true;
      }

      if (dir === 'done' && !frontmatter.completed_at) {
        const mtime = fs.statSync(filePath).mtime.toISOString();
        completedFilled.push({ id, mtime });
        frontmatter.completed_at = mtime;
        changed = true;
      }

      if (changed && apply) {
        frontmatter.updated_at = new Date().toISOString();
        // Тикет заменяется целиком, а не перезаписывается на месте: writeFileSync —
        // это open(файл, 'w') с усечением до нуля плюс запись вторым шагом, и в этом
        // окне читатель получает тикет пустым или обрезанным. Скрипт проходит по всей
        // доске, а доску одновременно сканируют pick-next-task (readTicketsFromDir),
        // check-conditions (readTickets) и MCP get_ticket: пустой тикет теряет
        // frontmatter целиком (статус и parent_plan пропадают, id подставляется из
        // имени файла), обрезанный теряет хвост тела — секцию Result, по которой
        // findCompletedInProgress решает, что тикет доделан. Ни одна из этих функций
        // не падает — все считают неправду. Тот же класс, что инциденты 2026-09-24:
        // маркер запущенного пайплайна и approval-файл ручного гейта.
        replaceFileAtomicSync(filePath, serializeFrontmatter(frontmatter) + body);
      }
    }
  }

  return { statusFixed, completedFilled, scanned };
}
