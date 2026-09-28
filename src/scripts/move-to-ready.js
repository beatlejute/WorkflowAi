#!/usr/bin/env node

/**
 * move-to-ready.js — Перемещает тикеты из backlog/ в ready/
 *
 * Читает список ticket IDs из контекста (поле ready_tickets),
 * переданного pipeline runner'ом, и перемещает каждый тикет.
 *
 * Формат ready_tickets: "IMPL-002, DOCS-001" (через запятую)
 *
 * Тикет с `dod_format: 2` (кроме `type: human`) перед переносом проходит гейт:
 * проверки `check` его DoD без пометки `regression` исполняются и обязаны быть
 * красными — работа ещё не начата. Зелёная, отклонённая (`denied`), упавшая по
 * таймауту или неполная проверка отправляет тикет в blocked/ с причиной в
 * `blocked_reason` (PLAN-002, задача 18). Туда же — любая проверка `check`, в том
 * числе регрессионная, которую исполнитель отклонит или которой нет исполняемого
 * файла на машине: она красная всегда.
 *
 * Выводит результат:
 *   ---RESULT---
 *   status: moved | default
 *   moved: 2
 *   skipped: 0
 *   blocked: 0
 *   ---RESULT---
 */

import fs from 'fs';
import path from 'path';
import YAML from 'workflow-ai/lib/js-yaml.mjs';
import { findProjectRoot } from 'workflow-ai/lib/find-root.mjs';
import { parseFrontmatter, serializeFrontmatter, replaceFileAtomicSync } from 'workflow-ai/lib/utils.mjs';
import { dodStartProblems, isDodFormat2 } from '../lib/check-runner.mjs';

// Корень проекта
const PROJECT_DIR = findProjectRoot();
const TICKETS_DIR = path.join(PROJECT_DIR, '.workflow', 'tickets');
const BACKLOG_DIR = path.join(TICKETS_DIR, 'backlog');
const READY_DIR = path.join(TICKETS_DIR, 'ready');
const BLOCKED_DIR = path.join(TICKETS_DIR, 'blocked');

/**
 * Парсит список ticket IDs из промпта (контекста pipeline runner)
 */
function parseReadyTickets(prompt) {
  const match = prompt.match(/ready_tickets:\s*(.+)/);
  if (!match || !match[1].trim()) return [];
  return match[1].split(',').map(id => id.trim()).filter(Boolean);
}

/**
 * Перемещает один тикет из backlog/ в ready/, а не прошедший гейт — в blocked/
 *
 * @returns {Promise<'moved'|'blocked'|'not_found'>}
 */
async function moveToReady(ticketId) {
  const sourcePath = path.join(BACKLOG_DIR, `${ticketId}.md`);

  if (!fs.existsSync(sourcePath)) {
    console.error(`[WARN] ${ticketId}: not found in backlog/, skipping`);
    return 'not_found';
  }

  const content = fs.readFileSync(sourcePath, 'utf8');
  const { frontmatter, body } = parseFrontmatter(content);

  // human-тикеты тоже переносим в ready/: оттуда их забирает pick-next-task
  // со статусом human_ready и отправляет на стейдж manual-gate-human.
  // Раньше они здесь пропускались и навсегда оставались в backlog/, из-за чего
  // связка check-conditions (has_ready) → move-to-ready (moved: 0) →
  // pick-next-task (empty) → check-conditions крутилась вхолостую до max_steps.
  let targetDir = READY_DIR;
  if (frontmatter.type === 'human') {
    console.log(`[INFO] ${ticketId}: type is 'human' (выполняется человеком через manual-gate)`);
  } else if (isDodFormat2(frontmatter)) {
    // Гейт — dodStartProblems (lib/check-runner.mjs); его же зовёт автор тикета через check-ticket-dod.js.
    const problems = await dodStartProblems({ body, projectRoot: PROJECT_DIR });
    if (problems.length > 0) {
      // blocked_reason снимают move-ticket.js и operations/tickets.mjs при выходе из blocked/.
      frontmatter.blocked_reason = problems.join('; ');
      targetDir = BLOCKED_DIR;
      console.log(`[WARN] ${ticketId}: ${frontmatter.blocked_reason}`);
    }
  }

  frontmatter.updated_at = new Date().toISOString();

  const newContent = serializeFrontmatter(frontmatter) + body;
  const targetPath = path.join(targetDir, `${ticketId}.md`);

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // Сначала переезд, потом содержимое: тикет всё время лежит ровно в одной
  // колонке. Прямая запись поверх только что переехавшего файла обрезала его до
  // нуля, и check-conditions/pick-next-task видели в ready/ тикет с пустым
  // frontmatter — без статуса, без типа и без зависимостей.
  fs.renameSync(sourcePath, targetPath);
  replaceFileAtomicSync(targetPath, newContent);
  return targetDir === BLOCKED_DIR ? 'blocked' : 'moved';
}

function printResult(result) {
  console.log('---RESULT---');
  for (const [key, value] of Object.entries(result)) {
    console.log(`${key}: ${value}`);
  }
  console.log('---RESULT---');
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const prompt = rawArgs[0] || '';

  const ticketIds = parseReadyTickets(prompt);

  if (ticketIds.length === 0) {
    console.log('[INFO] No tickets to move');
    printResult({ status: 'default', moved: 0 });
    return;
  }

  console.log(`[INFO] Moving ${ticketIds.length} ticket(s) to ready/`);

  let moved = 0;
  let blocked = 0;
  for (const id of ticketIds) {
    try {
      const outcome = await moveToReady(id);
      if (outcome === 'moved') {
        console.log(`[INFO] ${id}: backlog/ → ready/`);
        moved++;
      } else if (outcome === 'blocked') {
        console.log(`[INFO] ${id}: backlog/ → blocked/`);
        blocked++;
      }
    } catch (e) {
      console.error(`[ERROR] ${id}: ${e.message}`);
    }
  }

  const skipped = ticketIds.length - moved - blocked;
  console.log(`[INFO] Moved: ${moved}/${ticketIds.length}`);
  if (blocked > 0) {
    console.log(`[WARN] Blocked: ${blocked}/${ticketIds.length} (проверки DoD не прошли гейт до начала работы)`);
  }
  if (skipped > 0) {
    console.log(`[WARN] Not moved: ${skipped}/${ticketIds.length} (тикеты не найдены в backlog/)`);
  }
  printResult({ status: moved > 0 ? 'moved' : 'default', moved, skipped, blocked });
}

main().catch(e => {
  console.error(`[ERROR] ${e.message}`);
  printResult({ status: 'error', error: e.message });
  process.exit(1);
});
