#!/usr/bin/env node

/**
 * calc-metrics.js — автоматизированный расчёт метрик для create-report.
 *
 * Реализует алгоритм из algorithms/metric-calculation.md:
 *   1. Velocity (done_count / days_elapsed)
 *   2. Plan health (completion_pct - expected_pct)
 *   3. Distribution by type
 *   4. Anomalies detection
 *
 * Использование:
 *   node calc-metrics.js <PLAN-NNN>
 *
 * Вывод: JSON через маркеры ---RESULT---
 */

import fs from 'fs';
import path from 'path';
import { findProjectRoot } from 'workflow-ai/lib/find-root.mjs';
import { parseFrontmatter, printResult } from 'workflow-ai/lib/utils.mjs';
import { createLogger } from 'workflow-ai/lib/logger.mjs';

const logger = createLogger();

const PROJECT_DIR = findProjectRoot();
const TICKETS_DIR = path.join(PROJECT_DIR, '.workflow', 'tickets');
const PLANS_DIR = path.join(PROJECT_DIR, '.workflow', 'plans', 'current');
const TICKET_DIRS = ['done', 'in-progress', 'blocked', 'ready', 'backlog', 'archive'];

/**
 * Нормализует ID плана в формат PLAN-NNN
 */
function normalizePlanId(raw) {
  if (!raw) return null;
  const basename = path.basename(raw, '.md');
  const full = basename.match(/^plan-(\d+)$/i);
  if (full) return `PLAN-${String(parseInt(full[1], 10)).padStart(3, '0')}`;
  const num = raw.trim().match(/^(\d+)$/);
  if (num) return `PLAN-${String(parseInt(num[1], 10)).padStart(3, '0')}`;
  return null;
}

/**
 * Собирает все тикеты указанного плана из всех директорий tickets/
 */
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

/**
 * Находит файл плана по ID
 */
function findPlanFile(planId) {
  if (!fs.existsSync(PLANS_DIR)) return null;
  const files = fs.readdirSync(PLANS_DIR).filter(f => f.endsWith('.md'));
  const normalized = normalizePlanId(planId);
  return files.find(f => normalizePlanId(f) === normalized) || null;
}

/**
 * Парсит план и возвращает его метаданные
 */
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

/**
 * 1. Расчёт velocity: done_count / days_elapsed
 */
function calcVelocity(tickets, planData) {
  const doneTickets = tickets.filter(t => t.status === 'done' || t.status === 'archive');
  const doneCount = doneTickets.length;

  // Определяем days_elapsed
  let daysElapsed = 0;
  if (planData && planData.created_at) {
    const startDate = new Date(planData.created_at);
    const now = new Date();
    const diffMs = now.getTime() - startDate.getTime();
    daysElapsed = Math.max(diffMs / (1000 * 60 * 60 * 24), 1); // минимум 1 день
  } else {
    // Если нет дат плана — используем самую раннюю дату создания тикета
    const dates = tickets
      .map(t => t.created_at)
      .filter(Boolean)
      .map(d => new Date(d).getTime())
      .sort((a, b) => a - b);
    if (dates.length > 0) {
      const diffMs = Date.now() - dates[0];
      daysElapsed = Math.max(diffMs / (1000 * 60 * 60 * 24), 1);
    }
  }

  const velocityDay = daysElapsed > 0 ? doneCount / daysElapsed : 0;
  const velocityWeek = velocityDay * 7;

  return {
    done_count: doneCount,
    days_elapsed: Math.round(daysElapsed * 100) / 100,
    velocity_day: Math.round(velocityDay * 100) / 100,
    velocity_week: Math.round(velocityWeek * 100) / 100
  };
}

/**
 * 2. Расчёт plan health: completion_pct - expected_pct
 */
function calcPlanHealth(tickets, planData) {
  const totalTickets = tickets.length;
  const doneTickets = tickets.filter(t => t.status === 'done' || t.status === 'archive').length;

  const completionPct = totalTickets > 0 ? (doneTickets / totalTickets) * 100 : 0;

  let expectedPct = 100;
  let status = 'ON_TRACK';

  if (planData && planData.created_at) {
    const startDate = new Date(planData.created_at);
    const now = new Date();

    // Если в плане есть общая длительность или endDate — используем её
    // Иначе используем 14 дней как дефолт
    let totalDays = 14;
    if (planData.end_date) {
      const endDate = new Date(planData.end_date);
      totalDays = Math.max((endDate - startDate) / (1000 * 60 * 60 * 24), 1);
    } else if (planData.duration_days) {
      totalDays = planData.duration_days;
    }

    const daysSinceStart = Math.max((now - startDate) / (1000 * 60 * 60 * 24), 0);
    expectedPct = Math.min((daysSinceStart / totalDays) * 100, 100);

    const delta = completionPct - expectedPct;

    if (delta >= 0) {
      status = 'ON_TRACK';
    } else if (delta > -25) {
      status = 'AT_RISK';
    } else {
      status = 'OFF_TRACK';
    }
  }

  return {
    total_tickets: totalTickets,
    done_tickets: doneTickets,
    completion_pct: Math.round(completionPct * 100) / 100,
    expected_pct: Math.round(expectedPct * 100) / 100,
    delta: Math.round((completionPct - expectedPct) * 100) / 100,
    health_status: status
  };
}

/**
 * 3. Distribution by type
 */
function calcDistribution(tickets) {
  const total = tickets.length;
  if (total === 0) return {};

  const byType = {};
  for (const ticket of tickets) {
    const type = ticket.type || 'unknown';
    byType[type] = (byType[type] || 0) + 1;
  }

  const distribution = {};
  for (const [type, count] of Object.entries(byType)) {
    distribution[type] = {
      count,
      pct: Math.round((count / total) * 100 * 100) / 100
    };
  }

  return distribution;
}

/**
 * 4. Anomalies detection
 */
function detectAnomalies(tickets, velocity) {
  const anomalies = [];
  const now = new Date();

  // Velocity drop — нужно сравнить с предыдущим отчётом
  // Пока только zero velocity detection
  if (velocity.velocity_day === 0 && velocity.done_count === 0) {
    anomalies.push({
      type: 'zero_velocity',
      severity: 'HIGH',
      message: 'No tickets completed in the period'
    });
  }

  // Blocked accumulation
  const blockedTickets = tickets.filter(t => t.status === 'blocked');
  const totalTickets = tickets.length;
  if (totalTickets > 0) {
    const blockedRate = (blockedTickets.length / totalTickets) * 100;
    if (blockedRate > 25) {
      anomalies.push({
        type: 'blocked_accumulation',
        severity: 'HIGH',
        message: `Blocked rate ${Math.round(blockedRate * 100) / 100}% > 25% threshold`,
        blocked_count: blockedTickets.length,
        blocked_rate: Math.round(blockedRate * 100) / 100
      });
    }
  }

  // Stale in-progress — tickets with updated_at > 3 days ago
  const staleTickets = tickets.filter(t => {
    if (t.status !== 'in-progress') return false;
    if (!t.updated_at) return true; // нет updated_at = потенциально stale
    const updatedAt = new Date(t.updated_at);
    const daysSinceUpdate = (now - updatedAt) / (1000 * 60 * 60 * 24);
    return daysSinceUpdate > 3;
  });

  for (const ticket of staleTickets) {
    const daysSince = Math.round(((now - new Date(ticket.updated_at)) / (1000 * 60 * 60 * 24)) * 100) / 100;
    anomalies.push({
      type: 'stale_in_progress',
      severity: 'MEDIUM',
      message: `Ticket ${ticket.id} in-progress, last updated ${daysSince} days ago`,
      ticket_id: ticket.id,
      days_stale: daysSince
    });
  }

  // Result without move — in-progress с непустым Result
  const resultWithoutMove = tickets.filter(t => {
    if (t.status !== 'in-progress') return false;
    // Проверяем наличие секции Result / Результат выполнения
    const hasResult = /^##\s*(Результат выполнения|Result)\s*$/m.test(t.body || '');
    if (!hasResult) return false;
    // Проверяем, что секция содержит реальный контент
    const resultMatch = (t.body || '').match(/^##\s*(Результат выполнения|Result)\s*$/m);
    if (!resultMatch) return false;
    const afterResult = (t.body || '').substring(resultMatch.index);
    const nextSection = afterResult.match(/^##\s+/gm);
    const sectionContent = nextSection
      ? afterResult.substring(0, afterResult.search(/^##\s+/gm))
      : afterResult;
    const withoutComments = sectionContent.replace(/<!--[\s\S]*?-->/g, '').trim();
    return withoutComments.length > 0;
  });

  for (const ticket of resultWithoutMove) {
    anomalies.push({
      type: 'result_without_move',
      severity: 'MEDIUM',
      message: `Ticket ${ticket.id} has result but still in-progress`,
      ticket_id: ticket.id
    });
  }

  return anomalies;
}

/**
 * Основная функция
 */
async function main() {
  const planIdArg = process.argv[2];

  if (!planIdArg) {
    console.error('Ошибка: не указан ID плана');
    console.error('Использование: node calc-metrics.js <PLAN-NNN>');
    process.exit(1);
  }

  const planId = normalizePlanId(planIdArg);
  if (!planId) {
    console.error(`Ошибка: невалидный ID плана "${planIdArg}". Ожидается формат PLAN-NNN или число.`);
    process.exit(1);
  }

  logger.info(`Calculating metrics for ${planId}`);

  // Собираем тикеты
  const { tickets, warnings } = collectPlanTickets(planId);
  if (tickets.length === 0) {
    logger.warn(`No tickets found for plan ${planId}`);
  }

  // Ищем план
  const planFileName = findPlanFile(planId);
  const planData = parsePlan(planFileName);

  // Считаем метрики
  const velocity = calcVelocity(tickets, planData);
  const health = calcPlanHealth(tickets, planData);
  const distribution = calcDistribution(tickets);
  const anomalies = detectAnomalies(tickets, velocity);

  // Формируем результат
  const result = {
    plan_id: planId,
    total_tickets: tickets.length,
    velocity,
    plan_health: health,
    distribution,
    anomalies,
    warnings: warnings.length > 0 ? warnings : undefined
  };

  // Вывод через ---RESULT---
  console.log('---RESULT---');
  console.log(JSON.stringify(result, null, 2));
  console.log('---RESULT---');

  // Дополнительная информация в stderr
  logger.info(`Metrics calculated: ${tickets.length} tickets, ${anomalies.length} anomalies`);
}

main().catch(err => {
  console.error(`Ошибка: ${err.message}`);
  console.log('---RESULT---');
  console.log(JSON.stringify({ error: err.message }, null, 2));
  console.log('---RESULT---');
  process.exit(1);
});
