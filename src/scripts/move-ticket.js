#!/usr/bin/env node

/**
 * move-ticket.js - Скрипт для перемещения тикетов между директориями канбан-доски
 *
 * Использование:
 *   node move-ticket.js <ticket_id> <target>
 *
 * Пример:
 *   node move-ticket.js IMPL-001 in-progress
 */

import fs from 'fs';
import path from 'path';
import YAML from '../lib/js-yaml.mjs';
import { findProjectRoot } from '../lib/find-root.mjs';
import { parseFrontmatter, printResult, serializeFrontmatter } from '../lib/utils.mjs';

// Корень проекта
const PROJECT_DIR = findProjectRoot();
// Базовая директория workflow
const WORKFLOW_DIR = path.join(PROJECT_DIR, '.workflow');
const TICKETS_DIR = path.join(WORKFLOW_DIR, 'tickets');

// Доступные статусы
const VALID_STATUSES = ['backlog', 'ready', 'in-progress', 'blocked', 'review', 'done'];

// Таблица допустимых переходов
const VALID_TRANSITIONS = {
  'backlog': ['ready', 'blocked', 'done'],
  'ready': ['in-progress', 'review', 'backlog'],
  'in-progress': ['done', 'blocked', 'review'],
  'blocked': ['ready'],
  'review': ['done', 'ready', 'in-progress', 'blocked'],
  'done': ['ready', 'blocked']
};

/**
 * Определяет текущий статус тикета по расположению файла
 */
function getStatusFromPath(filePath) {
  const fileName = path.basename(filePath);
  for (const status of VALID_STATUSES) {
    const statusDir = path.join(TICKETS_DIR, status);
    const expectedPath = path.join(statusDir, fileName);
    if (filePath === expectedPath) {
      return status;
    }
  }
  return null;
}

/**
 * Проверяет допустимость перехода
 */
function isValidTransition(from, to) {
  if (!VALID_STATUSES.includes(from)) {
    return { valid: false, error: `Неверный исходный статус: ${from}` };
  }
  if (!VALID_STATUSES.includes(to)) {
    return { valid: false, error: `Неверный целевой статус: ${to}. Доступные: ${VALID_STATUSES.join(', ')}` };
  }

  const allowedTransitions = VALID_TRANSITIONS[from] || [];
  if (!allowedTransitions.includes(to)) {
    return {
      valid: false,
      error: `Переход из ${from} в ${to} недопустим. Доступные переходы: ${allowedTransitions.join(', ') || 'нет'}`
    };
  }

  return { valid: true };
}

/**
 * Основная функция перемещения тикета
 */
async function moveTicket(ticketId, target) {
  // Поиск файла тикета во всех директориях
  let sourceDir = null;
  let currentStatus = null;

  for (const status of VALID_STATUSES) {
    const statusDir = path.join(TICKETS_DIR, status);
    const ticketPath = path.join(statusDir, `${ticketId}.md`);
    if (fs.existsSync(ticketPath)) {
      sourceDir = statusDir;
      currentStatus = status;
      break;
    }
  }

  if (!sourceDir) {
    return {
      status: 'error',
      ticket_id: ticketId,
      error: `Тикет ${ticketId} не найден ни в одной из директорий`
    };
  }

  // Проверка допустимости перехода
  const transitionCheck = isValidTransition(currentStatus, target);
  if (!transitionCheck.valid) {
    return {
      status: 'error',
      ticket_id: ticketId,
      from: currentStatus,
      to: target,
      error: transitionCheck.error
    };
  }

  const sourcePath = path.join(sourceDir, `${ticketId}.md`);
  const targetDir = path.join(TICKETS_DIR, target);
  const targetPath = path.join(targetDir, `${ticketId}.md`);

  // Чтение файла тикета
  let content;
  try {
    content = fs.readFileSync(sourcePath, 'utf8');
  } catch (e) {
    return {
      status: 'error',
      ticket_id: ticketId,
      error: `Не удалось прочитать файл: ${e.message}`
    };
  }

  // Парсинг frontmatter
  let frontmatter, body;
  try {
    ({ frontmatter, body } = parseFrontmatter(content));
  } catch (e) {
    return {
      status: 'error',
      ticket_id: ticketId,
      error: e.message
    };
  }

  // Обновление frontmatter
  const now = new Date().toISOString();
  frontmatter.updated_at = now;

  // Если переход в done, добавляем completed_at
  if (target === 'done' && currentStatus !== 'done') {
    frontmatter.completed_at = now;
  }

  // Если переход из blocked, удаляем blocked_reason
  if (currentStatus === 'blocked' && frontmatter.blocked_reason) {
    delete frontmatter.blocked_reason;
  }

  // Сериализация нового контента
  const newContent = serializeFrontmatter(frontmatter) + body;

  // Создание целевой директории если не существует
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // Перемещение файла
  try {
    fs.renameSync(sourcePath, targetPath);
  } catch (e) {
    return {
      status: 'error',
      ticket_id: ticketId,
      error: `Не удалось переместить файл: ${e.message}`
    };
  }

  // Запись обновлённого контента
  try {
    fs.writeFileSync(targetPath, newContent, 'utf8');
  } catch (e) {
    return {
      status: 'error',
      ticket_id: ticketId,
      error: `Не удалось записать файл: ${e.message}`
    };
  }

  return {
    status: 'moved',
    ticket_id: ticketId,
    from: currentStatus,
    to: target
  };
}

// Main entry point
const rawArgs = process.argv.slice(2);
let ticketId, target;

if (rawArgs.length >= 2) {
  // Прямой вызов: node move-ticket.js IMPL-001 in-progress
  ticketId = rawArgs[0];
  target = rawArgs[1];
} else if (rawArgs.length === 1) {
  // Вызов через pipeline runner: один аргумент — промпт с контекстом
  // Формат: "skill-name\n\nContext:\n  ticket_id: X\n  target: Y\n..."
  const prompt = rawArgs[0];
  const ticketMatch = prompt.match(/ticket_id:\s*(\S+)/);
  const targetMatch = prompt.match(/target:\s*(\S+)/);
  ticketId = ticketMatch?.[1];
  target = targetMatch?.[1];
  if (!ticketId || !target) {
    console.error('[ERROR] Cannot parse ticket_id or target from pipeline context');
    printResult({ status: 'error', error: 'Missing ticket_id or target in pipeline context' });
    process.exit(1);
  }
} else {
  console.error('Usage: node move-ticket.js <ticket_id> <target>');
  console.error('Example: node move-ticket.js IMPL-001 in-progress');
  console.error('Available targets:', VALID_STATUSES.join(', '));
  printResult({ status: 'error', error: 'Missing arguments' });
  process.exit(1);
}

moveTicket(ticketId, target).then(result => {
  printResult(result);
  if (result.status === 'error') {
    process.exit(1);
  }
});
