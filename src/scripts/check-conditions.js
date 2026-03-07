#!/usr/bin/env node

/**
 * check-conditions.js — Проверяет условия тикетов в backlog/ и выводит список готовых
 *
 * Использование:
 *   node check-conditions.js
 *
 * Выводит результат в формате:
 *   ---RESULT---
 *   status: has_ready
 *   ready_tickets: IMPL-002, DOCS-001
 *   ---RESULT---
 *
 * или если готовых нет, но есть тикеты в ready/:
 *   ---RESULT---
 *   status: default
 *   ready_tickets:
 *   ---RESULT---
 *
 * или если backlog пуст и нет тикетов в ready/:
 *   ---RESULT---
 *   status: empty
 *   ready_tickets:
 *   ---RESULT---
 */

import fs from 'fs';
import path from 'path';
import { findProjectRoot } from '../lib/find-root.mjs';
import { parseFrontmatter, printResult } from '../lib/utils.mjs';

const PROJECT_DIR = findProjectRoot();
const WORKFLOW_DIR = path.join(PROJECT_DIR, '.workflow');
const TICKETS_DIR = path.join(WORKFLOW_DIR, 'tickets');
const BACKLOG_DIR = path.join(TICKETS_DIR, 'backlog');
const READY_DIR = path.join(TICKETS_DIR, 'ready');
const DONE_DIR = path.join(TICKETS_DIR, 'done');

/**
 * Проверяет одно условие тикета
 */
function checkCondition(condition) {
  const { type, value } = condition;

  switch (type) {
    case 'file_exists':
      return fs.existsSync(path.join(PROJECT_DIR, value));

    case 'file_not_exists':
      return !fs.existsSync(path.join(PROJECT_DIR, value));

    case 'tasks_completed': {
      if (!value || (Array.isArray(value) && value.length === 0)) return true;
      const ids = Array.isArray(value) ? value : [value];
      return ids.every(taskId => fs.existsSync(path.join(DONE_DIR, `${taskId}.md`)));
    }

    case 'date_after':
      return new Date() > new Date(value);

    case 'date_before':
      return new Date() < new Date(value);

    case 'manual_approval':
      return false;

    default:
      console.error(`[WARN] Unknown condition type: ${type}`);
      return true;
  }
}

/**
 * Проверяет зависимости тикета
 */
function checkDependencies(dependencies) {
  if (!dependencies || dependencies.length === 0) return true;
  return dependencies.every(depId => fs.existsSync(path.join(DONE_DIR, `${depId}.md`)));
}

/**
 * Считывает все тикеты из директории
 */
function readTickets(dir) {
  if (!fs.existsSync(dir)) return [];

  const tickets = [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md') && f !== '.gitkeep.md');

  for (const file of files) {
    const filePath = path.join(dir, file);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const { frontmatter } = parseFrontmatter(content);
      tickets.push({ id: frontmatter.id || file.replace('.md', ''), frontmatter });
    } catch (e) {
      console.error(`[WARN] Failed to read ticket ${file}: ${e.message}`);
    }
  }

  return tickets;
}

/**
 * Нормализует входное значение в формат PLAN-NNN.
 * Принимает: "PLAN-007", "7", "007", "plan-7", "plans/PLAN-007.md", "/abs/path/PLAN-007.md"
 */
function normalizePlanId(raw) {
  if (!raw) return null;

  // Извлекаем имя файла если передан путь
  const basename = path.basename(raw, '.md');

  // Уже в формате PLAN-NNN (регистронезависимо)
  const full = basename.match(/^plan-(\d+)$/i);
  if (full) return `PLAN-${String(parseInt(full[1], 10)).padStart(3, '0')}`;

  // Просто цифра или число: "7", "007"
  const num = raw.trim().match(/^(\d+)$/);
  if (num) return `PLAN-${String(parseInt(num[1], 10)).padStart(3, '0')}`;

  return null;
}

/**
 * Извлекает plan_id из аргументов командной строки (контекст пайплайна)
 */
function extractPlanId() {
  const prompt = process.argv.slice(2)[0] || '';
  const match = prompt.match(/plan_id:\s*(\S+)/i);
  return match ? normalizePlanId(match[1]) : null;
}

/**
 * Проверяет все тикеты в backlog/ и возвращает список готовых
 */
function checkBacklog(planId) {
  const allTickets = readTickets(BACKLOG_DIR);
  const tickets = planId
    ? allTickets.filter(t => t.frontmatter.parent_plan === planId)
    : allTickets;

  const ready = [];
  const waiting = [];

  for (const ticket of tickets) {
    const { frontmatter, id } = ticket;
    const conditions = frontmatter.conditions || [];
    const dependencies = frontmatter.dependencies || [];

    const depsMet = checkDependencies(dependencies);
    const conditionsMet = conditions.every(checkCondition);

    if (depsMet && conditionsMet) {
      ready.push(id);
    } else {
      const reasons = [];
      if (!depsMet) reasons.push(`ждёт зависимости: ${dependencies.join(', ')}`);
      conditions.forEach(c => {
        if (!checkCondition(c)) reasons.push(`условие не выполнено: ${c.type}`);
      });
      waiting.push({ id, reasons });
    }
  }

  return { ready, waiting, total: tickets.length };
}

async function main() {
  const planId = extractPlanId();

  if (planId) {
    console.log(`[INFO] Filtering by plan_id: ${planId}`);
  }

  console.log(`[INFO] Scanning backlog/: ${BACKLOG_DIR}`);

  const { ready, waiting, total } = checkBacklog(planId);

  console.log(`[INFO] Total in backlog${planId ? ` (plan ${planId})` : ''}: ${total}`);
  console.log(`[INFO] Ready: ${ready.length}, Waiting: ${waiting.length}`);

  if (ready.length > 0) {
    console.log(`[INFO] Ready tickets: ${ready.join(', ')}`);
  }

  for (const { id, reasons } of waiting) {
    console.log(`[INFO] ${id}: ${reasons.join('; ')}`);
  }

  if (ready.length > 0) {
    printResult({ status: 'has_ready', ready_tickets: ready.join(', ') });
    return;
  }

  // Нет готовых — проверяем есть ли что-то в ready/
  const readyDirTickets = readTickets(READY_DIR);
  if (readyDirTickets.length > 0) {
    console.log(`[INFO] No new ready tickets, but ready/ has ${readyDirTickets.length} ticket(s)`);
    printResult({ status: 'default', ready_tickets: '' });
  } else {
    console.log('[INFO] No ready tickets and ready/ is empty');
    printResult({ status: 'empty', ready_tickets: '' });
  }
}

main().catch(e => {
  console.error(`[ERROR] ${e.message}`);
  printResult({ status: 'error', error: e.message });
  process.exit(1);
});
