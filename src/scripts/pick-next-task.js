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
import { findProjectRoot } from '../lib/find-root.mjs';
import { parseFrontmatter, printResult, normalizePlanId, extractPlanId, getLastReviewStatus, serializeFrontmatter } from '../lib/utils.mjs';

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
const BACKLOG_DIR = path.join(TICKETS_DIR, 'backlog');


/**
 * Проверяет условие (condition) тикета
 */
function checkCondition(condition) {
  const { type, value } = condition;

  switch (type) {
    case 'file_exists':
      const filePath = path.join(PROJECT_DIR, value);
      return fs.existsSync(filePath);

    case 'file_not_exists':
      const filePath2 = path.join(PROJECT_DIR, value);
      return !fs.existsSync(filePath2);

    case 'tasks_completed':
      // Проверяет, что указанные задачи выполнены (находятся в done/)
      if (!value || (Array.isArray(value) && value.length === 0)) return true;
      const ids = Array.isArray(value) ? value : [value];
      return ids.every(taskId => {
        const donePath = path.join(DONE_DIR, `${taskId}.md`);
        return fs.existsSync(donePath);
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
      // Неизвестный тип условия - считаем выполненным
      console.error(`[WARN] Unknown condition type: ${type}`);
      return true;
  }
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
    return fs.existsSync(donePath);
  });
}

/**
 * Авто-коррекция тикетов на основе статуса ревью.
 * Сканирует все директории и перемещает тикеты по правилам:
 * - blocked → done (если review = passed)
 * - blocked → backlog (если review = failed, НЕ при null)
 * - done → backlog (если review = failed)
 * - review → done (если review = passed)
 * - in-progress → done (если review = passed)
 * - ready → done (если review = passed)
 *
 * @returns {object} Результат: { moved: Array<{id, from, to, reason}> }
 */
function autoCorrectTickets() {
  const moved = [];

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
      // Читаем содержимое
      const content = fs.readFileSync(fromPath, 'utf8');
      const { frontmatter, body } = parseFrontmatter(content);

      // Обновляем updated_at
      frontmatter.updated_at = new Date().toISOString();

      // Если перемещаем в done — ставим completed_at
      if (toDir === DONE_DIR && !frontmatter.completed_at) {
        frontmatter.completed_at = new Date().toISOString();
      }

      // Сериализуем и записываем в новую директорию
      const newContent = serializeFrontmatter(frontmatter) + body;
      fs.writeFileSync(toPath, newContent, 'utf8');

      // Удаляем старый файл
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
      console.error(`[ERROR] Failed to move ticket ${ticketId}: ${e.message}`);
      return false;
    }
  }

  /**
   * Обрабатывает тикеты в указанной директории
   */
  function processDirectory(dir, rules) {
    if (!fs.existsSync(dir)) return;

    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.md') && f !== '.gitkeep.md');

    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const { frontmatter } = parseFrontmatter(content);
        const ticketId = frontmatter.id || file.replace('.md', '');

        // Получаем статус ревью
        const reviewStatus = getLastReviewStatus(content);

        // Применяем правила
        for (const rule of rules) {
          if (rule.condition(reviewStatus)) {
            moveTicket(ticketId, dir, rule.toDir, rule.reason);
            break; // Только одно перемещение на тикет
          }
        }
      } catch (e) {
        console.error(`[WARN] Failed to process ticket ${file}: ${e.message}`);
      }
    }
  }

  // Правила для blocked/
  processDirectory(BLOCKED_DIR, [
    {
      condition: (status) => status === 'passed',
      toDir: DONE_DIR,
      reason: 'review passed'
    },
    {
      condition: (status) => status === 'failed',
      toDir: BACKLOG_DIR,
      reason: 'review failed'
    }
    // null (нет ревью) — не перемещаем
  ]);

  // Правила для done/
  processDirectory(DONE_DIR, [
    {
      condition: (status) => status === 'failed',
      toDir: BACKLOG_DIR,
      reason: 'review failed'
    }
    // passed или null — не перемещаем (важно для legacy-тикетов без ревью)
  ]);

  // Правила для review/
  processDirectory(REVIEW_DIR, [
    {
      condition: (status) => status === 'passed',
      toDir: DONE_DIR,
      reason: 'review passed'
    }
  ]);

  // Правила для in-progress/
  processDirectory(IN_PROGRESS_DIR, [
    {
      condition: (status) => status === 'passed',
      toDir: DONE_DIR,
      reason: 'review passed'
    }
  ]);

  // Правила для ready/
  processDirectory(READY_DIR, [
    {
      condition: (status) => status === 'passed',
      toDir: DONE_DIR,
      reason: 'review passed'
    }
  ]);

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
        console.log(`[INFO] Found completed ticket in in-progress/: ${first.id}`);
        return {
          status: 'completed_in_progress',
          ticket_id: first.id
        };
      }
    }

    if (reviewTickets.length > 0) {
      return {
        status: 'in_review',
        ticket_id: reviewTickets[0].id,
        priority: reviewTickets[0].frontmatter.priority,
        title: reviewTickets[0].frontmatter.title,
        type: reviewTickets[0].frontmatter.type
      };
    }
    return { status: 'empty', reason: 'No tickets in ready/' };
  }

  // Фильтрация по условиям и зависимостям
  const eligibleTickets = tickets.filter(ticket => {
    const { frontmatter } = ticket;

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
    type: selected.frontmatter.type
  };
}

// Main entry point
async function main() {
  const planId = extractPlanId();

  if (planId) {
    console.log(`[INFO] Filtering by plan_id: ${planId}`);
  }

  // Авто-коррекция тикетов перед выбором задачи
  console.log('[INFO] Running auto-correction...');
  const correctionResult = autoCorrectTickets();
  if (correctionResult.moved.length > 0) {
    console.log(`[INFO] Auto-corrected ${correctionResult.moved.length} ticket(s)`);
  }

  console.log(`[INFO] Scanning ready/ directory: ${READY_DIR}`);

  const result = pickNextTicket(planId);

  if (result.status === 'found') {
    console.log(`[INFO] Selected ticket: ${result.ticket_id} (${result.title})`);
    console.log(`[INFO] Priority: ${result.priority}, Type: ${result.type}`);
  } else {
    console.log(`[INFO] ${result.reason}`);
  }

  // Добавляем информацию о авто-коррекции в результат
  const finalResult = {
    ...result,
    auto_corrected: correctionResult.moved.length,
    moved_tickets: correctionResult.moved.map(m => m.id).join(',')
  };

  printResult(finalResult);

  if (result.status === 'empty') {
    process.exit(0);
  }
}

main().catch(e => {
  console.error(`[ERROR] ${e.message}`);
  printResult({ status: 'error', error: e.message });
  process.exit(1);
});
