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
import { findProjectRoot } from '../lib/find-root.mjs';
import { parseFrontmatter, serializeFrontmatter, normalizePlanId, extractPlanId, printResult } from '../lib/utils.mjs';

const PROJECT_DIR = findProjectRoot();
const WORKFLOW_DIR = path.join(PROJECT_DIR, '.workflow');
const TICKETS_DIR = path.join(WORKFLOW_DIR, 'tickets');
const DONE_DIR = path.join(TICKETS_DIR, 'done');
const ARCHIVE_DIR = path.join(TICKETS_DIR, 'archive');

/**
 * Архивирует все done-тикеты указанного плана
 */
function archivePlanTickets(planId) {
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

      const destPath = path.join(ARCHIVE_DIR, file);
      fs.writeFileSync(destPath, serializeFrontmatter(frontmatter) + body, 'utf8');
      fs.unlinkSync(filePath);

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

// Main entry point
const rawArgs = process.argv.slice(2);
let planId;

if (rawArgs.length >= 1) {
  // Прямой вызов или pipeline context
  const arg = rawArgs[0];
  const planMatch = arg.match(/plan_id:\s*(\S+)/i);
  planId = planMatch ? normalizePlanId(planMatch[1]) : normalizePlanId(arg);
} else {
  planId = extractPlanId();
}

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
