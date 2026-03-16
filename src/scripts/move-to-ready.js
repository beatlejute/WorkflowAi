#!/usr/bin/env node

/**
 * move-to-ready.js — Перемещает тикеты из backlog/ в ready/
 *
 * Читает список ticket IDs из контекста (поле ready_tickets),
 * переданного pipeline runner'ом, и перемещает каждый тикет.
 *
 * Формат ready_tickets: "IMPL-002, DOCS-001" (через запятую)
 *
 * Выводит результат:
 *   ---RESULT---
 *   status: moved | default
 *   moved: 2
 *   ---RESULT---
 */

import fs from 'fs';
import path from 'path';
import YAML from '../lib/js-yaml.mjs';
import { findProjectRoot } from '../lib/find-root.mjs';
import { parseFrontmatter, serializeFrontmatter } from '../lib/utils.mjs';

// Корень проекта
const PROJECT_DIR = findProjectRoot();
const TICKETS_DIR = path.join(PROJECT_DIR, '.workflow', 'tickets');
const BACKLOG_DIR = path.join(TICKETS_DIR, 'backlog');
const READY_DIR = path.join(TICKETS_DIR, 'ready');

/**
 * Парсит список ticket IDs из промпта (контекста pipeline runner)
 */
function parseReadyTickets(prompt) {
  const match = prompt.match(/ready_tickets:\s*(.+)/);
  if (!match || !match[1].trim()) return [];
  return match[1].split(',').map(id => id.trim()).filter(Boolean);
}

/**
 * Перемещает один тикет из backlog/ в ready/
 */
function moveToReady(ticketId) {
  const sourcePath = path.join(BACKLOG_DIR, `${ticketId}.md`);
  const targetPath = path.join(READY_DIR, `${ticketId}.md`);

  if (!fs.existsSync(sourcePath)) {
    console.error(`[WARN] ${ticketId}: not found in backlog/, skipping`);
    return false;
  }

  const content = fs.readFileSync(sourcePath, 'utf8');
  const { frontmatter, body } = parseFrontmatter(content);

  frontmatter.updated_at = new Date().toISOString();

  const newContent = serializeFrontmatter(frontmatter) + body;

  if (!fs.existsSync(READY_DIR)) {
    fs.mkdirSync(READY_DIR, { recursive: true });
  }

  fs.renameSync(sourcePath, targetPath);
  fs.writeFileSync(targetPath, newContent, 'utf8');
  return true;
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
  for (const id of ticketIds) {
    try {
      if (moveToReady(id)) {
        console.log(`[INFO] ${id}: backlog/ → ready/`);
        moved++;
      }
    } catch (e) {
      console.error(`[ERROR] ${id}: ${e.message}`);
    }
  }

  console.log(`[INFO] Moved: ${moved}/${ticketIds.length}`);
  printResult({ status: moved > 0 ? 'moved' : 'default', moved });
}

main().catch(e => {
  console.error(`[ERROR] ${e.message}`);
  printResult({ status: 'error', error: e.message });
  process.exit(1);
});
