#!/usr/bin/env node

/**
 * calc-plan-metrics.js — аналитические метрики плана для analyze-report.
 *
 * Рассчитывает:
 *   1. Distribution by status
 *   2. Completion %
 *   3. Avg time-to-done
 *   4. Blocked rate
 *   5. Rework count
 *
 * Использование:
 *   node calc-plan-metrics.js <PLAN-NNN>
 *
 * Вывод: JSON через маркеры ---RESULT---
 */

import fs from 'fs';
import path from 'path';
import { findProjectRoot } from 'workflow-ai/lib/find-root.mjs';
import { parseFrontmatter } from 'workflow-ai/lib/utils.mjs';
import { createLogger } from 'workflow-ai/lib/logger.mjs';

const logger = createLogger();

const PROJECT_DIR = findProjectRoot();
const TICKETS_DIR = path.join(PROJECT_DIR, '.workflow', 'tickets');
const PLANS_DIR = path.join(PROJECT_DIR, '.workflow', 'plans', 'current');
const TICKET_DIRS = ['done', 'in-progress', 'blocked', 'ready', 'backlog', 'archive'];

function normalizePlanId(raw) {
  if (!raw) return null;
  const basename = path.basename(raw, '.md');
  const full = basename.match(/^plan-(\d+)$/i);
  if (full) return `PLAN-${String(parseInt(full[1], 10)).padStart(3, '0')}`;
  const num = raw.trim().match(/^(\d+)$/);
  if (num) return `PLAN-${String(parseInt(num[1], 10)).padStart(3, '0')}`;
  return null;
}

function collectPlanTickets(planId) {
  const tickets = [];
  const warnings = [];

  for (const dirName of TICKET_DIRS) {
    const dir = path.join(TICKETS_DIR, dirName);
    if (!fs.existsSync(dir)) continue;

    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md') && f !== '.gitkeep.md');
    for (const file of files) {
      const filePath = path.join(dir, file);
      let content;
      try {
        content = fs.readFileSync(filePath, 'utf8');
      } catch (e) {
        warnings.push(`Failed to read ${file}: ${e.message}`);
        continue;
      }

      let parsed;
      try {
        parsed = parseFrontmatter(content);
      } catch (e) {
        warnings.push(`Failed to parse frontmatter in ${file}: ${e.message}`);
        continue;
      }

      const { frontmatter } = parsed;
      if (!frontmatter || typeof frontmatter !== 'object') {
        warnings.push(`Invalid frontmatter in ${file}`);
        continue;
      }

      const ticketPlanId = normalizePlanId(frontmatter.parent_plan);
      if (ticketPlanId === normalizePlanId(planId)) {
        tickets.push({
          id: frontmatter.id || file.replace('.md', ''),
          title: frontmatter.title || 'Unknown',
          type: frontmatter.type || 'unknown',
          status: dirName,
          created_at: frontmatter.created_at || null,
          updated_at: frontmatter.updated_at || null,
          completed_at: frontmatter.completed_at || null,
          raw: frontmatter,
          body: parsed.body || ''
        });
      }
    }
  }

  return { tickets, warnings };
}

function findPlanFile(planId) {
  if (!fs.existsSync(PLANS_DIR)) return null;
  const files = fs.readdirSync(PLANS_DIR).filter(f => f.endsWith('.md'));
  const normalized = normalizePlanId(planId);
  return files.find(f => normalizePlanId(f) === normalized) || null;
}

function parsePlan(planFileName) {
  if (!planFileName) return null;
  const planPath = path.join(PLANS_DIR, planFileName);
  try {
    const content = fs.readFileSync(planPath, 'utf8');
    const { frontmatter } = parseFrontmatter(content);
    return frontmatter;
  } catch (e) {
    logger.warn(`Failed to parse plan ${planFileName}: ${e.message}`);
    return null;
  }
}

function calcDistributionByStatus(tickets) {
  const distribution = {};
  for (const dirName of TICKET_DIRS) {
    const count = tickets.filter(t => t.status === dirName).length;
    if (count > 0) {
      distribution[dirName] = count;
    }
  }
  return distribution;
}

function calcCompletionPct(tickets) {
  const total = tickets.length;
  const doneCount = tickets.filter(t => t.status === 'done' || t.status === 'archive').length;
  return total > 0 ? Math.round((doneCount / total) * 100 * 100) / 100 : 0;
}

function calcAvgTimeToDone(tickets) {
  const doneTickets = tickets.filter(t => t.status === 'done' || t.status === 'archive');
  const times = [];

  for (const ticket of doneTickets) {
    if (ticket.created_at && ticket.completed_at) {
      const created = new Date(ticket.created_at);
      const completed = new Date(ticket.completed_at);
      const diffMs = completed.getTime() - created.getTime();
      const diffDays = diffMs / (1000 * 60 * 60 * 24);
      if (diffDays >= 0) {
        times.push(diffDays);
      }
    }
  }

  if (times.length === 0) {
    return null;
  }

  const avg = times.reduce((sum, d) => sum + d, 0) / times.length;
  return Math.round(avg * 100) / 100;
}

function calcBlockedRate(tickets) {
  const total = tickets.length;
  const blockedCount = tickets.filter(t => t.status === 'blocked').length;
  return total > 0 ? Math.round((blockedCount / total) * 100 * 100) / 100 : 0;
}

function calcReworkCount(tickets) {
  let count = 0;
  for (const ticket of tickets) {
    const notes = ticket.raw?.notes || '';
    if (/повторная работа/i.test(notes) || /Повторная/i.test(notes)) {
      count++;
    }
  }
  return count;
}

async function main() {
  const planIdArg = process.argv[2];

  if (!planIdArg) {
    console.error('Ошибка: не указан ID плана');
    console.error('Использование: node calc-plan-metrics.js <PLAN-NNN>');
    process.exit(1);
  }

  const planId = normalizePlanId(planIdArg);
  if (!planId) {
    console.error(`Ошибка: невалидный ID плана "${planIdArg}". Ожидается формат PLAN-NNN или число.`);
    process.exit(1);
  }

  logger.info(`Calculating analytics for ${planId}`);

  const { tickets, warnings } = collectPlanTickets(planId);
  if (tickets.length === 0) {
    logger.warn(`No tickets found for plan ${planId}`);
  }

  const planFileName = findPlanFile(planId);
  const planData = parsePlan(planFileName);

  const distribution = calcDistributionByStatus(tickets);
  const completionPct = calcCompletionPct(tickets);
  const avgTimeToDone = calcAvgTimeToDone(tickets);
  const blockedRate = calcBlockedRate(tickets);
  const reworkCount = calcReworkCount(tickets);

  const result = {
    plan_id: planId,
    total_tickets: tickets.length,
    distribution,
    completion_pct: completionPct,
    avg_time_to_done: avgTimeToDone,
    avg_time_to_done_unit: 'days',
    blocked_rate: blockedRate,
    blocked_rate_unit: 'pct',
    rework_count: reworkCount,
    plan_data: planData ? {
      title: planData.title,
      status: planData.status
    } : null,
    warnings: warnings.length > 0 ? warnings : undefined
  };

  console.log('---RESULT---');
  console.log(JSON.stringify(result, null, 2));
  console.log('---RESULT---');

  logger.info(`Analytics calculated: ${tickets.length} tickets`);
}

main().catch(err => {
  console.error(`Ошибка: ${err.message}`);
  console.log('---RESULT---');
  console.log(JSON.stringify({ error: err.message }, null, 2));
  console.log('---RESULT---');
  process.exit(1);
});