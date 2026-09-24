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

import path from 'path';
import { findProjectRoot } from 'workflow-ai/lib/find-root.mjs';
import { printResult } from 'workflow-ai/lib/utils.mjs';
import { syncProject } from './sync-ticket-status-core.js';

function parseArgs(argv) {
  const args = { apply: false, project: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') args.apply = true;
    else if (argv[i] === '--project') args.project = argv[++i];
  }
  return args;
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
