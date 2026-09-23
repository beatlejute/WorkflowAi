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
import * as core from './pick-next-task-core.js';

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

// Контекст ядра: те же пути, тот же логгер. Ядро лежит в pick-next-task-core.js,
// чтобы замеры звали боевую функцию, а не свою копию: копия в замере была легче
// (без дедупликации, условий и зависимостей) и регресс здесь не ловила.
const CTX = core.createTicketContext(PROJECT_DIR, { logger });


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

        // FIX-69: не откатываем из done/ тикет, закрытый штатно пайплайном.
        // Признак штатного закрытия — заполненный completed_at (его проставляет move-ticket).
        // Review-агент может вынести passed-вердикт и не дописать строку в таблицу "## Ревью"
        // (наблюдалось у claude-haiku и при пустом выводе стейджа) — тогда без этой защиты
        // закрытый тикет уезжал на новый круг (HUMAN-4 2026-08-04, HUMAN-5 2026-08-04).
        if (dir === DONE_DIR && frontmatter.completed_at) {
          logger.info(`[AUTO-CORRECT] ${ticketId}: skipped (completed_at=${frontmatter.completed_at}, review=${reviewStatus || 'none'})`);
          continue;
        }

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

  const result = core.pickNextTicket(CTX, planId);

  if (result.status === 'found') {
    logger.info(`Selected ticket: ${result.ticket_id} (${result.title})`);
    logger.info(`Priority: ${result.priority}, Type: ${result.type}`);
  } else {
    logger.info(result.reason);
  }

  logger.info('Calculating review metrics...');
  const reviewMetrics = core.calculateReviewMetrics(CTX);
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

// Экспортируем функции для тестирования
// Экспорт «для тестов» остаётся на месте, но ведёт прямо в ядро: обёртки поверх него
// никто не звал (импортирующих в репозитории нет — проверено grep'ом), а каждая
// непокрытая обёртка роняет файл ниже порога функций в гейте покрытия. Функции ядра
// первым аргументом принимают контекст (createTicketContext).
export {
  pickNextTicket,
  readReadyTickets,
  readReviewTickets,
  readInProgressTickets,
  findCompletedInProgress,
  filterByPlan,
} from './pick-next-task-core.js';

main().catch(e => {
  logger.error(e.message);
  printResult({ status: 'error', error: e.message });
  process.exit(1);
});
