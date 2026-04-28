#!/usr/bin/env node

/**
 * pick-next-task.js - Скрипт для выбора следующего тикета из директории ready/
 *
 * Использование:
 *   node pick-next-task.js
 *
 * Выводит результат в формате:
 *   ---RESULT---
 *   status: found
 *   ticket_id: IMPL-001
 *   ---RESULT---
 *
 * или если задач нет:
 *   ---RESULT---
 *   status: empty
 *   ---RESULT---
 */

import fs from 'fs';
import path from 'path';
import { findProjectRoot } from 'workflow-ai/lib/find-root.mjs';
import { parseFrontmatter, printResult, normalizePlanId, extractPlanId, getLastReviewStatus, serializeFrontmatter, loadTicketMovementRules, checkAndClosePlan } from 'workflow-ai/lib/utils.mjs';
import { createLogger } from 'workflow-ai/lib/logger.mjs';

const logger = createLogger();

// Корень проекта
const PROJECT_DIR = findProjectRoot();
// Базовая директория workflow
const WORKFLOW_DIR = path.join(PROJECT_DIR, '.workflow');
const TICKETS_DIR = path.join(WORKFLOW_DIR, 'tickets');
const READY_DIR = path.join(TICKETS_DIR, 'ready');
const DONE_DIR = path.join(TICKETS_DIR, 'done');
const IN_PROGRESS_DIR = path.join(TICKETS_DIR, 'in-progress');
const BLOCKED_DIR = path.join(TICKETS_DIR, 'blocked');
const REVIEW_DIR = path.join(TICKETS_DIR, 'review');
const ARCHIVE_DIR = path.join(TICKETS_DIR, 'archive');
const BACKLOG_DIR = path.join(TICKETS_DIR, 'backlog');


/**
 * Проверяет условие (condition) тикета
 */
function checkCondition(condition) {
  const { type, value } = condition;

  switch (type) {
    case 'file_exists':
      const filePath = path.isAbsolute(value) ? value : path.join(PROJECT_DIR, value);
      return fs.existsSync(filePath);

    case 'file_not_exists':
      const filePath2 = path.isAbsolute(value) ? value : path.join(PROJECT_DIR, value);
      return !fs.existsSync(filePath2);

    case 'tasks_completed':
      // Проверяет, что указанные задачи выполнены (находятся в done/)
      if (!value || (Array.isArray(value) && value.length === 0)) return true;
      const ids = Array.isArray(value) ? value : [value];
      return ids.every(taskId => {
        const donePath = path.join(DONE_DIR, `${taskId}.md`);
        const archivePath = path.join(ARCHIVE_DIR, `${taskId}.md`);
        return fs.existsSync(donePath) || fs.existsSync(archivePath);
      });

    case 'date_after':
      return new Date() > new Date(value);

    case 'date_before':
      return new Date() < new Date(value);

    case 'manual_approval':
      // Для ручного подтверждения всегда возвращаем false
      // Требуется явное одобрение
      return false;

    default:
      logger.warn(`Unknown condition type: ${type}`);
      return true;
  }
}

/**
 * Парсит секцию "## Ревью" тикета и возвращает все записи ревью.
 * @param {string} content - Содержимое тикета
 * @returns {Array<{date: string, status: string, comment: string}>}
 */
function parseReviewSection(content) {
  if (!content) return [];

  const headerIdx = content.search(/^##\s*Ревью\s*$/m);
  if (headerIdx === -1) return [];

  const bodyStart = content.indexOf('\n', headerIdx);
  if (bodyStart === -1) return [];

  const nextH2 = content.indexOf('\n## ', bodyStart);
  const reviewSection = (nextH2 === -1
    ? content.slice(bodyStart + 1)
    : content.slice(bodyStart + 1, nextH2)).trim();

  const reviews = [];

  const tableRows = reviewSection.split('\n').filter(line => line.trim().startsWith('|'));
  if (tableRows.length >= 2) {
    const dataRows = tableRows.slice(2).filter(row => {
      const cells = row.split('|').map(c => c.trim()).filter(c => c);
      return cells.length >= 2;
    });

    for (const row of dataRows) {
      const cells = row.split('|').map(c => c.trim()).filter(c => c);
      const date = cells[0] || '';
      const statusRaw = cells[1]?.toLowerCase() || '';
      const comment = cells[2] || '';
      let status = null;
      if (statusRaw.includes('passed')) status = 'passed';
      else if (statusRaw.includes('failed')) status = 'failed';
      else if (statusRaw.includes('skipped')) status = 'skipped';

      if (status) {
        reviews.push({ date, status, comment });
      }
    }
  }

  const listItems = reviewSection.split('\n').filter(line => line.trim().match(/^[-*]\s/));
  for (const item of listItems) {
    const trimmed = item.trim();
    const dateMatch = trimmed.match(/^[-*]\s*(\d{4}-\d{2}-\d{2})/);
    const statusMatch = trimmed.match(/:\s*(passed|failed|skipped)\b/i);
    if (dateMatch && statusMatch) {
      reviews.push({
        date: dateMatch[1],
        status: statusMatch[1].toLowerCase(),
        comment: trimmed.replace(/^[-*]\s*\d{4}-\d{2}-\d{2}:\s*(passed|failed|skipped)\b/i, '').trim()
      });
    }
  }

  return reviews;
}

/**
 * Вычисляет метрики ревью-итераций для всех тикетов
 * @returns {object} Метрики: iterations, avgTimeToFirstPassed, failedVsPassed
 */
function calculateReviewMetrics() {
  const allDirs = [BACKLOG_DIR, READY_DIR, IN_PROGRESS_DIR, BLOCKED_DIR, REVIEW_DIR, DONE_DIR, ARCHIVE_DIR];
  const ticketMetrics = {};
  let totalFailed = 0;
  let totalPassed = 0;
  let firstPassedTimes = [];

  for (const dir of allDirs) {
    if (!fs.existsSync(dir)) continue;

    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md') && f !== '.gitkeep.md');

    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const { frontmatter } = parseFrontmatter(content);
        const ticketId = frontmatter.id || file.replace('.md', '');

        const reviews = parseReviewSection(content);
        if (reviews.length === 0) continue;

        ticketMetrics[ticketId] = reviews.length;

        for (const review of reviews) {
          if (review.status === 'failed') totalFailed++;
          else if (review.status === 'passed') totalPassed++;
        }

        const firstPassed = reviews.find(r => r.status === 'passed');
        if (firstPassed && firstPassed.date) {
          const ticketCreated = new Date(frontmatter.created_at || '1970-01-01');
          const passedDate = new Date(firstPassed.date);
          const daysToPass = Math.floor((passedDate - ticketCreated) / (1000 * 60 * 60 * 24));
          if (daysToPass >= 0) {
            firstPassedTimes.push(daysToPass);
          }
        }
      } catch (e) {
        // Skip errors
      }
    }
  }

  const avgTimeToFirstPassed = firstPassedTimes.length > 0
    ? Math.round(firstPassedTimes.reduce((a, b) => a + b, 0) / firstPassedTimes.length)
    : null;

  return {
    iterations_per_ticket: ticketMetrics,
    total_failed: totalFailed,
    total_passed: totalPassed,
    avg_time_to_first_passed_days: avgTimeToFirstPassed,
    tickets_with_reviews: Object.keys(ticketMetrics).length
  };
}

/**
 * Проверяет зависимости тикета
 */
function checkDependencies(dependencies) {
  if (!dependencies || dependencies.length === 0) {
    return true;
  }

  return dependencies.every(depId => {
    const donePath = path.join(DONE_DIR, `${depId}.md`);
    const archivePath = path.join(ARCHIVE_DIR, `${depId}.md`);
    return fs.existsSync(donePath) || fs.existsSync(archivePath);
  });
}

/**
 * Авто-коррекция тикетов на основе статуса ревью.
 * Сканирует все директории и перемещает тикеты по правилам из конфига.
 *
 * @param {object} config - Конфигурация правил перемещения
 * @returns {object} Результат: { moved: Array<{id, from, to, reason}> }
 */
function autoCorrectTickets(config) {
  const moved = [];

  const dirMap = {
    backlog: BACKLOG_DIR,
    ready: READY_DIR,
    in_progress: IN_PROGRESS_DIR,
    blocked: BLOCKED_DIR,
    review: REVIEW_DIR,
    done: DONE_DIR,
    archive: ARCHIVE_DIR
  };

  /**
   * Перемещает тикет из одной директории в другую
   */
  function moveTicket(ticketId, fromDir, toDir, reason) {
    const fromPath = path.join(fromDir, `${ticketId}.md`);
    const toPath = path.join(toDir, `${ticketId}.md`);

    if (!fs.existsSync(fromPath)) {
      return false;
    }

    try {
      const content = fs.readFileSync(fromPath, 'utf8');
      const { frontmatter, body } = parseFrontmatter(content);

      frontmatter.updated_at = new Date().toISOString();

      if (toDir === DONE_DIR && !frontmatter.completed_at) {
        frontmatter.completed_at = new Date().toISOString();
      }

      const newContent = serializeFrontmatter(frontmatter) + body;
      fs.writeFileSync(toPath, newContent, 'utf8');

      fs.unlinkSync(fromPath);

      console.log(`[AUTO-CORRECT] ${ticketId}: ${path.basename(fromDir)} → ${path.basename(toDir)} (${reason})`);

      moved.push({
        id: ticketId,
        from: path.basename(fromDir),
        to: path.basename(toDir),
        reason
      });

      return true;
    } catch (e) {
      logger.error(`Failed to move ticket ${ticketId}: ${e.message}`);
      return false;
    }
  }

  /**
   * Обрабатывает тикеты в указанной директории
   */
  function processDirectory(dir, rules, dirName) {
    if (!fs.existsSync(dir)) return;

    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.md') && f !== '.gitkeep.md');

    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const { frontmatter } = parseFrontmatter(content);
        const ticketId = frontmatter.id || file.replace('.md', '');

        const reviewStatus = getLastReviewStatus(content);

        for (const rule of rules) {
          const ruleCondition = rule.condition;
          let shouldMove = false;

          if (ruleCondition === null) {
            shouldMove = reviewStatus === null;
          } else {
            shouldMove = reviewStatus === ruleCondition;
          }

          if (shouldMove) {
            const targetDirName = rule.to_dir;
            const targetDir = dirMap[targetDirName];
            if (targetDir) {
              moveTicket(ticketId, dir, targetDir, rule.reason);
            }
            break;
          }
        }
      } catch (e) {
        logger.warn(`Failed to process ticket ${file}: ${e.message}`);
      }
    }
  }

  if (!config || !config.rules) {
    logger.error('Ticket movement rules config not loaded');
    return { moved };
  }

  const rulesConfig = config.rules;

  for (const [dirName, rules] of Object.entries(rulesConfig)) {
    const dir = dirMap[dirName];
    if (dir) {
      processDirectory(dir, rules, dirName);
    }
  }

  return { moved };
}

/**
 * Считывает все тикеты из директории ready/
 */
function readReadyTickets() {
  if (!fs.existsSync(READY_DIR)) {
    return [];
  }

  const files = fs.readdirSync(READY_DIR)
    .filter(f => f.endsWith('.md') && f !== '.gitkeep.md');

  const tickets = [];

  for (const file of files) {
    const filePath = path.join(READY_DIR, file);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const { frontmatter } = parseFrontmatter(content);

      tickets.push({
        id: frontmatter.id || file.replace('.md', ''),
        frontmatter,
        filePath
      });
    } catch (e) {
      console.error(`[WARN] Failed to read ticket ${file}: ${e.message}`);
    }
  }

  return tickets;
}

/**
 * Считывает все тикеты из директории review/
 */
function readReviewTickets() {
  if (!fs.existsSync(path.join(TICKETS_DIR, 'review'))) {
    return [];
  }

  const files = fs.readdirSync(path.join(TICKETS_DIR, 'review'))
    .filter(f => f.endsWith('.md') && f !== '.gitkeep.md');

  const tickets = [];

  for (const file of files) {
    const filePath = path.join(TICKETS_DIR, 'review', file);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const { frontmatter } = parseFrontmatter(content);

      tickets.push({
        id: frontmatter.id || file.replace('.md', ''),
        frontmatter,
        filePath
      });
    } catch (e) {
      console.error(`[WARN] Failed to read ticket ${file}: ${e.message}`);
    }
  }

  return tickets;
}

/**
 * Считывает все тикеты из директории in-progress/
 */
function readInProgressTickets() {
  if (!fs.existsSync(IN_PROGRESS_DIR)) {
    return [];
  }

  const files = fs.readdirSync(IN_PROGRESS_DIR)
    .filter(f => f.endsWith('.md') && f !== '.gitkeep.md');

  const tickets = [];

  for (const file of files) {
    const filePath = path.join(IN_PROGRESS_DIR, file);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const { frontmatter } = parseFrontmatter(content);

      tickets.push({
        id: frontmatter.id || file.replace('.md', ''),
        frontmatter,
        filePath
      });
    } catch (e) {
      console.error(`[WARN] Failed to read in-progress ticket ${file}: ${e.message}`);
    }
  }

  return tickets;
}

/**
 * Проверяет, заполнен ли раздел результатов (Summary) в тикете
 */
function hasFilledResult(body) {
  const resultSectionRegex = /^##\s*(Результат выполнения|Result)\s*$/m;
  const sectionStart = body.search(resultSectionRegex);

  if (sectionStart === -1) {
    return false;
  }

  const nextSectionRegex = /^##\s+/gm;
  nextSectionRegex.lastIndex = sectionStart + 1;
  const nextSectionMatch = nextSectionRegex.exec(body);
  const sectionEnd = nextSectionMatch ? nextSectionMatch.index : body.length;

  const sectionContent = body.substring(sectionStart, sectionEnd);

  const summaryRegex = /^###\s*(Summary|Что сделано)\s*$/m;
  const summaryStart = sectionContent.search(summaryRegex);

  if (summaryStart === -1) {
    return false;
  }

  const nextSubsectionRegex = /^###\s+/gm;
  nextSubsectionRegex.lastIndex = summaryStart + 1;
  const nextSubsectionMatch = nextSubsectionRegex.exec(sectionContent);
  const summaryEnd = nextSubsectionMatch ? nextSubsectionMatch.index : sectionContent.length;

  const summaryContent = sectionContent.substring(summaryStart, summaryEnd);
  const withoutComments = summaryContent.replace(/<!--[\s\S]*?-->/g, '').trim();

  return withoutComments.length > 0;
}

/**
 * Находит завершённые тикеты в in-progress/ (с заполненным Summary)
 * Возвращает массив id тикетов
 */
function findCompletedInProgress() {
  if (!fs.existsSync(IN_PROGRESS_DIR)) {
    return [];
  }

  const files = fs.readdirSync(IN_PROGRESS_DIR)
    .filter(f => f.endsWith('.md') && f !== '.gitkeep.md');

  const completed = [];

  for (const file of files) {
    const filePath = path.join(IN_PROGRESS_DIR, file);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const { frontmatter, body } = parseFrontmatter(content);

      if (!hasFilledResult(body)) {
        continue;
      }

      completed.push({
        id: frontmatter.id || file.replace('.md', ''),
        frontmatter,
        filePath
      });
    } catch (e) {
      console.error(`[WARN] Failed to read in-progress ticket ${file}: ${e.message}`);
    }
  }

  return completed;
}

/**
 * Выбирает следующий тикет для выполнения
 */
function filterByPlan(tickets, planId) {
  if (!planId) return tickets;
  return tickets.filter(t => normalizePlanId(t.frontmatter.parent_plan) === planId);
}

function pickNextTicket(planId) {
  const tickets = filterByPlan(readReadyTickets(), planId);

  if (tickets.length === 0) {
    // Если ready/ пуст, проверяем review/ — нужно завершить ревью
    let reviewTickets = filterByPlan(readReviewTickets(), planId);

    if (reviewTickets.length === 0) {
      // Нет тикетов ни в ready/, ни в review/ — проверяем in-progress/
      // на завершённые тикеты (с заполненным Summary)
      const completedInProgress = filterByPlan(findCompletedInProgress(), planId);
      if (completedInProgress.length > 0) {
        const first = completedInProgress[0];
        logger.info(`Found completed ticket in in-progress/: ${first.id}`);
        return {
          status: 'completed_in_progress',
          ticket_id: first.id
        };
      }

      // Нет завершённых — проверяем незавершённые тикеты в in-progress/
      const allInProgress = filterByPlan(readInProgressTickets(), planId);
      if (allInProgress.length > 0) {
        const first = allInProgress[0];
        logger.info(`Found incomplete ticket in in-progress/: ${first.id}`);
        return {
          status: 'in_progress',
          ticket_id: first.id,
          priority: first.frontmatter.priority,
          title: first.frontmatter.title,
          type: first.frontmatter.type,
          required_capabilities: JSON.stringify(first.frontmatter.required_capabilities || [])
        };
      }
    }

    if (reviewTickets.length > 0) {
      return {
        status: 'in_review',
        ticket_id: reviewTickets[0].id,
        priority: reviewTickets[0].frontmatter.priority,
        title: reviewTickets[0].frontmatter.title,
        type: reviewTickets[0].frontmatter.type,
        required_capabilities: JSON.stringify(reviewTickets[0].frontmatter.required_capabilities || [])
      };
    }
    return { status: 'empty', reason: 'No tickets in ready/' };
  }

  // Фильтрация по условиям и зависимостям
  const eligibleTickets = tickets.filter(ticket => {
    const { frontmatter } = ticket;

    // Пропускаем тикеты, требующие ручного выполнения
    if (frontmatter.type === 'human') {
      logger.info(`Skipping ticket ${ticket.id}: type is 'human' (requires manual execution)`);
      return false;
    }

    // Проверка условий
    const conditions = frontmatter.conditions || [];
    const conditionsMet = conditions.every(checkCondition);
    if (!conditionsMet) {
      return false;
    }

    // Проверка зависимостей
    const dependencies = frontmatter.dependencies || [];
    const depsMet = checkDependencies(dependencies);
    if (!depsMet) {
      return false;
    }

    // Обнаружение и удаление дубликатов: тикет не должен существовать в других колонках
    const ticketFileName = `${ticket.id}.md`;
    const otherDirs = [DONE_DIR, IN_PROGRESS_DIR, REVIEW_DIR, BLOCKED_DIR];
    const duplicateDir = otherDirs.find(dir =>
      fs.existsSync(path.join(dir, ticketFileName))
    );
    if (duplicateDir) {
      const dirName = path.basename(duplicateDir);
      logger.warn(`Duplicate detected: ${ticket.id} exists in ready/ and ${dirName}/. Moving ready/ copy to archive/`);
      const archivePath = path.join(ARCHIVE_DIR, ticketFileName);
      try {
        fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
        fs.renameSync(ticket.filePath, archivePath);
      } catch (err) {
        logger.error(`Failed to archive duplicate ${ticket.id}: ${err.message}`);
      }
      return false;
    }

    return true;
  });

  if (eligibleTickets.length === 0) {
    return {
      status: 'empty',
      reason: 'No eligible tickets (conditions/dependencies not met)'
    };
  }

  // Сортировка по приоритету (меньше = важнее), затем по created_at
  eligibleTickets.sort((a, b) => {
    const priorityA = a.frontmatter.priority || 999;
    const priorityB = b.frontmatter.priority || 999;

    if (priorityA !== priorityB) {
      return priorityA - priorityB;
    }

    // При равном приоритете - по дате создания (старые первые)
    const dateA = new Date(a.frontmatter.created_at || '9999-12-31');
    const dateB = new Date(b.frontmatter.created_at || '9999-12-31');
    return dateA - dateB;
  });

  const selected = eligibleTickets[0];

  return {
    status: 'found',
    ticket_id: selected.id,
    priority: selected.frontmatter.priority,
    title: selected.frontmatter.title,
    type: selected.frontmatter.type,
    required_capabilities: JSON.stringify(selected.frontmatter.required_capabilities || [])
  };
}

/**
 * Архивирует все done-тикеты, принадлежащие архивным планам (plans/archive/).
 * Сканирует все планы в plans/archive/, находит их тикеты в done/ и перемещает в archive/.
 */
function archiveTicketsOfArchivedPlans() {
  const archivedPlansDir = path.join(WORKFLOW_DIR, 'plans', 'archive');
  if (!fs.existsSync(archivedPlansDir)) return { archived: [] };

  // Собираем ID всех архивных планов
  const archivedPlanIds = new Set();
  const planFiles = fs.readdirSync(archivedPlansDir).filter(f => f.endsWith('.md'));
  for (const file of planFiles) {
    const id = normalizePlanId(file);
    if (id) archivedPlanIds.add(id);
  }

  if (archivedPlanIds.size === 0) return { archived: [] };

  if (!fs.existsSync(DONE_DIR)) return { archived: [] };

  if (!fs.existsSync(ARCHIVE_DIR)) {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  }

  const archived = [];
  const files = fs.readdirSync(DONE_DIR).filter(f => f.endsWith('.md') && f !== '.gitkeep.md');

  for (const file of files) {
    const filePath = path.join(DONE_DIR, file);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const { frontmatter, body } = parseFrontmatter(content);
      const ticketPlanId = normalizePlanId(frontmatter.parent_plan);

      if (!ticketPlanId || !archivedPlanIds.has(ticketPlanId)) continue;

      const ticketId = frontmatter.id || file.replace('.md', '');

      frontmatter.updated_at = new Date().toISOString();
      frontmatter.archived_at = new Date().toISOString();

      const destPath = path.join(ARCHIVE_DIR, file);
      fs.writeFileSync(destPath, serializeFrontmatter(frontmatter) + body, 'utf8');
      fs.unlinkSync(filePath);

      archived.push(ticketId);
      logger.info(`[ARCHIVE] ${ticketId}: done → archive (plan ${ticketPlanId} is archived)`);
    } catch (e) {
      logger.warn(`Failed to archive ticket ${file}: ${e.message}`);
    }
  }

  return { archived };
}

// Main entry point
async function main() {
  const planId = extractPlanId();

  if (planId) {
    logger.info(`Filtering by plan_id: ${planId}`);
  }

  const configPath = path.join(WORKFLOW_DIR, 'config', 'ticket-movement-rules.yaml');
  let movementConfig = null;
  try {
    movementConfig = loadTicketMovementRules(configPath);
    logger.info('Loaded ticket movement rules from config');
  } catch (e) {
    logger.warn(`Failed to load ticket movement config: ${e.message}`);
  }

  logger.info('Running auto-correction...');
  const correctionResult = autoCorrectTickets(movementConfig);
  if (correctionResult.moved.length > 0) {
    logger.info(`Auto-corrected ${correctionResult.moved.length} ticket(s)`);
  }

  // Архивируем done-тикеты архивных планов
  const archiveResult = archiveTicketsOfArchivedPlans();
  if (archiveResult.archived.length > 0) {
    logger.info(`Archived ${archiveResult.archived.length} ticket(s) from archived plans: ${archiveResult.archived.join(', ')}`);
  }

  if (planId) {
    const closeResult = checkAndClosePlan(WORKFLOW_DIR, planId);
    if (closeResult.closed) {
      logger.info(`Plan ${planId} closed: all ${closeResult.total} tickets done`);
    } else if (closeResult.total > 0) {
      logger.info(`Plan ${planId} progress: ${closeResult.done}/${closeResult.total} tickets done`);
    }
  }

  logger.info(`Scanning ready/ directory: ${READY_DIR}`);

  const result = pickNextTicket(planId);

  if (result.status === 'found') {
    logger.info(`Selected ticket: ${result.ticket_id} (${result.title})`);
    logger.info(`Priority: ${result.priority}, Type: ${result.type}`);
  } else {
    logger.info(result.reason);
  }

  logger.info('Calculating review metrics...');
  const reviewMetrics = calculateReviewMetrics();
  logger.info(`Found ${reviewMetrics.tickets_with_reviews} tickets with reviews`);
  logger.info(`Total failed: ${reviewMetrics.total_failed}, passed: ${reviewMetrics.total_passed}`);

  const metricsDir = path.join(WORKFLOW_DIR, 'metrics');
  if (!fs.existsSync(metricsDir)) {
    fs.mkdirSync(metricsDir, { recursive: true });
  }
  const metricsFile = path.join(metricsDir, 'review-metrics.json');
  fs.writeFileSync(metricsFile, JSON.stringify(reviewMetrics, null, 2), 'utf8');
  logger.info(`Metrics saved to ${metricsFile}`);

  const finalResult = {
    ...result,
    auto_corrected: correctionResult.moved.length,
    moved_tickets: correctionResult.moved.map(m => m.id).join(','),
    review_metrics: JSON.stringify(reviewMetrics)
  };

  printResult(finalResult);

  if (result.status === 'empty') {
    process.exit(0);
  }
}

main().catch(e => {
  logger.error(e.message);
  printResult({ status: 'error', error: e.message });
  process.exit(1);
});
