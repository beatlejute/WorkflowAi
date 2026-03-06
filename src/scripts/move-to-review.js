#!/usr/bin/env node

/**
 * move-to-review.js — Перемещает тикет из in-progress/ в review/
 *
 * Читает ticket_id из контекста pipeline runner'а.
 *
 * Выводит результат:
 *   ---RESULT---
 *   status: moved | error
 *   ticket_id: IMPL-001
 *   ---RESULT---
 */

import fs from 'fs';
import path from 'path';
import { findProjectRoot } from '../lib/find-root.mjs';
import { parseFrontmatter, serializeFrontmatter, printResult } from '../lib/utils.mjs';

// Корень проекта
const PROJECT_DIR = findProjectRoot();
const TICKETS_DIR = path.join(PROJECT_DIR, '.workflow', 'tickets');
const IN_PROGRESS_DIR = path.join(TICKETS_DIR, 'in-progress');
const REVIEW_DIR = path.join(TICKETS_DIR, 'review');

/**
 * Парсит ticket_id из промпта (контекста pipeline runner)
 */
function parseTicketId(prompt) {
  const match = prompt.match(/ticket_id:\s*(\S+)/);
  return match ? match[1].trim() : null;
}

/**
 * Перемещает тикет из in-progress/ в review/
 */
function moveToReview(ticketId) {
  const sourcePath = path.join(IN_PROGRESS_DIR, `${ticketId}.md`);
  const targetPath = path.join(REVIEW_DIR, `${ticketId}.md`);

  if (!fs.existsSync(sourcePath)) {
    // Ticket may have been moved directly to done/ by the agent — treat as already done
    const donePath = path.join(TICKETS_DIR, 'done', `${ticketId}.md`);
    if (fs.existsSync(donePath)) {
      return { status: 'skipped', ticket_id: ticketId, reason: `${ticketId} already in done/` };
    }
    return { status: 'error', ticket_id: ticketId, error: `${ticketId} not found in in-progress/` };
  }

  const content = fs.readFileSync(sourcePath, 'utf8');
  const { frontmatter, body } = parseFrontmatter(content);

  frontmatter.updated_at = new Date().toISOString();

  const newContent = serializeFrontmatter(frontmatter) + body;

  if (!fs.existsSync(REVIEW_DIR)) {
    fs.mkdirSync(REVIEW_DIR, { recursive: true });
  }

  fs.renameSync(sourcePath, targetPath);
  fs.writeFileSync(targetPath, newContent, 'utf8');

  return { status: 'moved', ticket_id: ticketId, from: 'in-progress', to: 'review' };
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const prompt = rawArgs[0] || '';

  const ticketId = parseTicketId(prompt);

  if (!ticketId) {
    console.error('[ERROR] No ticket_id in context');
    printResult({ status: 'error', error: 'Missing ticket_id' });
    process.exit(1);
  }

  console.log(`[INFO] Moving ${ticketId}: in-progress/ → review/`);
  const result = moveToReview(ticketId);
  printResult(result);

  if (result.status === 'error') {
    process.exit(1);
  }

  if (result.status === 'skipped') {
    console.log(`[INFO] Skipped: ${result.reason}`);
  }
}

main().catch(e => {
  console.error(`[ERROR] ${e.message}`);
  printResult({ status: 'error', error: e.message });
  process.exit(1);
});
