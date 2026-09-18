#!/usr/bin/env node

/**
 * sync-ticket-status.js — Приводит frontmatter.status тикетов в соответствие с папкой.
 *
 * Разовая миграция для FIX-69: до фикса move-ticket.js обновлял только
 * updated_at/completed_at и не трогал status, поэтому в done/ накапливались тикеты
 * со `status: ready` и `status: in-progress`. Потребители frontmatter
 * (MCP get_ticket_stats, check-conditions, валидатор VS Code расширения) видели
 * фантомное состояние доски.
 *
 * Дополнительно проставляет completed_at тикетам в done/, у которых его нет:
 * без него auto-correct в pick-next-task не отличает штатно закрытый тикет от
 * недозакрытого и может откатить его в backlog.
 *
 * ВАЖНО: completed_at восстановить точно неоткуда, поэтому берётся mtime файла —
 * это приближение, а не реальное время закрытия. Тикеты, которым проставлен
 * приближённый completed_at, перечисляются в выводе.
 *
 * Запуск:
 *   node sync-ticket-status.js              # dry-run, только отчёт
 *   node sync-ticket-status.js --apply      # записать изменения
 *   node sync-ticket-status.js --project D:\Dev\PulseProxy --apply
 *
 * Выводит результат:
 *   ---RESULT---
 *   status: synced | clean
 *   status_fixed: <int>
 *   completed_at_filled: <int>
 *   ---RESULT---
 */

import fs from 'fs';
import path from 'path';
import { findProjectRoot } from 'workflow-ai/lib/find-root.mjs';
import { parseFrontmatter, serializeFrontmatter, printResult } from 'workflow-ai/lib/utils.mjs';

// Папки доски == допустимые значения status (см. VALID_STATUSES в move-ticket.js).
// archive/ намеренно исключён: там лежат тикеты закрытых планов, их status
// отражает состояние на момент архивации.
const BOARD_DIRS = ['backlog', 'ready', 'in-progress', 'review', 'blocked', 'done'];

function parseArgs(argv) {
  const args = { apply: false, project: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') args.apply = true;
    else if (argv[i] === '--project') args.project = argv[++i];
  }
  return args;
}

/**
 * Синхронизирует статусы тикетов одного проекта.
 *
 * @param {string} projectRoot
 * @param {boolean} apply - false = только отчёт
 * @returns {{statusFixed: Array, completedFilled: Array, scanned: number}}
 */
function syncProject(projectRoot, apply) {
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
        fs.writeFileSync(filePath, serializeFrontmatter(frontmatter) + body, 'utf8');
      }
    }
  }

  return { statusFixed, completedFilled, scanned };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectRoot = args.project ? path.resolve(args.project) : findProjectRoot();

  console.log(`[INFO] Проект: ${projectRoot}`);
  console.log(`[INFO] Режим: ${args.apply ? 'запись' : 'dry-run (для записи добавь --apply)'}`);

  const { statusFixed, completedFilled, scanned } = syncProject(projectRoot, args.apply);

  console.log(`[INFO] Просмотрено тикетов: ${scanned}`);

  if (statusFixed.length > 0) {
    console.log(`[INFO] Рассинхрон status → папка: ${statusFixed.length}`);
    for (const { id, dir, was } of statusFixed) {
      console.log(`  ${id}: ${was} → ${dir}`);
    }
  }

  if (completedFilled.length > 0) {
    console.log(`[WARN] completed_at проставлен по mtime файла (приближение): ${completedFilled.length}`);
    for (const { id, mtime } of completedFilled) {
      console.log(`  ${id}: ${mtime}`);
    }
  }

  const total = statusFixed.length + completedFilled.length;
  if (total === 0) {
    console.log('[INFO] Расхождений нет');
  }

  printResult({
    status: total > 0 ? 'synced' : 'clean',
    status_fixed: statusFixed.length,
    completed_at_filled: completedFilled.length
  });
}

main();
