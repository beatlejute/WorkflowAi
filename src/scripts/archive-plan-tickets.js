#!/usr/bin/env node

/**
 * archive-plan-tickets.js - Архивирует все done-тикеты указанного плана
 *
 * Использование:
 *   node archive-plan-tickets.js <plan_id>
 *
 * Пример:
 *   node archive-plan-tickets.js PLAN-002
 *   node archive-plan-tickets.js 2
 */

import fs from 'fs';
import path from 'path';
import { findProjectRoot } from 'workflow-ai/lib/find-root.mjs';
import { parseFrontmatter, serializeFrontmatter, normalizePlanId, extractPlanId, printResult, replaceFileAtomicSync } from 'workflow-ai/lib/utils.mjs';

const PROJECT_DIR = findProjectRoot();
const WORKFLOW_DIR = path.join(PROJECT_DIR, '.workflow');
const TICKETS_DIR = path.join(WORKFLOW_DIR, 'tickets');
const DONE_DIR = path.join(TICKETS_DIR, 'done');
const ARCHIVE_DIR = path.join(TICKETS_DIR, 'archive');

/**
 * Архивирует все done-тикеты указанного плана
 *
 * Экспортируется для теста (src/tests/archive-plan-tickets.test.mjs).
 */
export function archivePlanTickets(planId) {
  if (!planId) {
    return { status: 'error', error: 'Missing plan_id' };
  }

  if (!fs.existsSync(DONE_DIR)) {
    return { status: 'ok', plan_id: planId, archived: 0, ticket_ids: '' };
  }

  if (!fs.existsSync(ARCHIVE_DIR)) {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  }

  const files = fs.readdirSync(DONE_DIR).filter(f => f.endsWith('.md') && f !== '.gitkeep.md');
  const archived = [];

  for (const file of files) {
    const filePath = path.join(DONE_DIR, file);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const { frontmatter, body } = parseFrontmatter(content);

      const ticketPlanId = normalizePlanId(frontmatter.parent_plan);
      if (ticketPlanId !== planId) continue;

      const ticketId = frontmatter.id || file.replace('.md', '');

      frontmatter.updated_at = new Date().toISOString();
      frontmatter.archived_at = new Date().toISOString();

      // Сначала переезд, потом содержимое — как в move-to-review.js. Прежний порядок
      // (создать копию в archive/, затем удалить исходник) давал два окна: тикет
      // существовал сразу в двух колонках, а копия в это время была видна пустой или
      // обрезанной — writeFileSync создаёт файл и пишет содержимое двумя шагами.
      // Читатели tickets/archive/: pick-next-task-core.js (зависимость считается
      // закрытой, если тикет в done/ или archive/), move-to-review.js и
      // check-relevance.js (ищут тикет по колонкам, archive/ среди них).
      const destPath = path.join(ARCHIVE_DIR, file);
      fs.renameSync(filePath, destPath);
      replaceFileAtomicSync(destPath, serializeFrontmatter(frontmatter) + body);

      archived.push(ticketId);
      console.log(`[ARCHIVE] ${ticketId}: done → archive`);
    } catch (e) {
      console.error(`[ERROR] Failed to archive ${file}: ${e.message}`);
    }
  }

  return {
    status: 'ok',
    plan_id: planId,
    archived: archived.length,
    ticket_ids: archived.join(',')
  };
}

/**
 * Достаёт plan_id из аргумента: пайплайн передаёт весь контекст стадии строкой
 * («plan_id: PLAN-002 …»), человек — сам ID или его номер.
 *
 * Экспортируется для теста.
 */
export function parsePlanArg(arg) {
  if (!arg) return null;
  const planMatch = arg.match(/plan_id:\s*(\S+)/i);
  return planMatch ? normalizePlanId(planMatch[1]) : normalizePlanId(arg);
}

function main() {
  const rawArgs = process.argv.slice(2);
  const planId = rawArgs.length >= 1 ? parsePlanArg(rawArgs[0]) : extractPlanId();

  if (!planId) {
    console.error('Usage: node archive-plan-tickets.js <plan_id>');
    console.error('Example: node archive-plan-tickets.js PLAN-002');
    printResult({ status: 'error', error: 'Missing plan_id argument' });
    process.exit(1);
  }

  const result = archivePlanTickets(planId);
  printResult(result);

  if (result.status === 'error') {
    process.exit(1);
  }
}

// Запуск main() только при прямом вызове (не при импорте) — тот же приём, что в
// check-plan-templates.js, check-conditions.js и move-to-review.js.
const isDirectRun = process.argv[1] && (
  process.argv[1].endsWith('archive-plan-tickets.js') ||
  process.argv[1].endsWith('archive-plan-tickets')
);

if (isDirectRun) {
  main();
}
