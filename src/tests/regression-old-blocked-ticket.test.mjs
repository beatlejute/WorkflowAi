#!/usr/bin/env node

/**
 * Backward Compatibility Test: старые тикеты без auto_blocked_* полей (QA-45)
 *
 * Проверяет, что тикеты в blocked/, созданные до внедрения полей
 * auto_blocked_reason, auto_blocked_attempts, auto_blocked_at,
 * парсируются без ошибок, а эти поля просто отсутствуют (undefined).
 *
 * Сценарий: legacy-тикет без новых полей должен корректно десериализоваться.
 * Ожидание: парсинг успешен, поля undefined, никаких ошибок.
 *
 * Запуск: node --test src/tests/regression-old-blocked-ticket.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'url';
import yaml from '../lib/js-yaml.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

function createTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qa-45-old-ticket-'));
}

function cleanupDir(dir) {
  if (dir && fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Создаёт тикет в стиле 1.2.x БЕЗ auto_blocked_* полей
 */
function createOldBlockedTicketContent(id, title) {
  return `---
id: ${id}
title: ${title}
priority: 2
type: impl
created_at: "2026-04-20T10:00:00.000Z"
updated_at: "2026-04-20T11:30:00.000Z"
parent_plan: plans/current/PLAN-010.md
parent_task: ""
dependencies: []
conditions: []
tags:
  - workflow-ai
  - tests
---

## Описание

Старый тикет в формате до внедрения auto_blocked_* полей.

## Критерии готовности (Definition of Done)

- [x] Первый критерий выполнен

## Результат выполнения

### Summary
Тикет был заблокирован по старому сценарию.

### Изменённые файлы
- src/example.js

### Заметки
Тикет был забыт перед миграцией схемы frontmatter.
`;
}

/**
 * Создаёт новый формат тикета С auto_blocked_* полями
 */
function createNewBlockedTicketContent(id, title) {
  return `---
id: ${id}
title: ${title}
priority: 2
type: impl
created_at: "2026-04-20T10:00:00.000Z"
updated_at: "2026-04-20T11:30:00.000Z"
parent_plan: plans/current/PLAN-010.md
parent_task: ""
dependencies: []
conditions: []
tags:
  - workflow-ai
  - tests
auto_blocked_reason: "max_review_attempts"
auto_blocked_attempts: 6
auto_blocked_at: "2026-04-20T11:30:00.000Z"
---

## Описание

Новый тикет с auto_blocked_* полями.

## Критерии готовности (Definition of Done)

- [x] Первый критерий выполнен

## Результат выполнения

### Summary
Тикет был заблокирован с логированием в frontmatter.

### Изменённые файлы
- src/example.js

### Заметки
Тикет был заблокирован автоматически с полной информацией.
`;
}

/**
 * Парсит frontmatter из контента тикета
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!match) {
    throw new Error('Невозможно найти frontmatter в содержимом тикета');
  }

  const fmText = match[1];
  try {
    const parsed = yaml.load(fmText);
    return parsed;
  } catch (err) {
    throw new Error(`Ошибка парсинга YAML frontmatter: ${err.message}`);
  }
}

// ============================================================================
// QA-45-002 Test Suite: backward-compat для old blocked tickets
// ============================================================================

test('QA-45-006: Старый тикет БЕЗ auto_blocked_* полей парсируется без ошибок', async () => {
  const tmpDir = createTmpDir();

  try {
    // Создаём файл старого формата тикета
    const ticketContent = createOldBlockedTicketContent('IMPL-001', 'Old blocked ticket');
    const ticketPath = path.join(tmpDir, 'old-blocked-ticket.md');
    fs.writeFileSync(ticketPath, ticketContent);

    // Парсим его
    const fm = parseFrontmatter(ticketContent);

    // Должны получить объект с базовыми полями
    assert.strictEqual(fm.id, 'IMPL-001');
    assert.strictEqual(fm.title, 'Old blocked ticket');
    assert.ok(fm.created_at, 'created_at должна быть');
  } finally {
    cleanupDir(tmpDir);
  }
});

test('QA-45-007: auto_blocked_reason в старом тикете == undefined (не ошибка)', async () => {
  const tmpDir = createTmpDir();

  try {
    const ticketContent = createOldBlockedTicketContent('IMPL-002', 'Old without auto_blocked');
    const fm = parseFrontmatter(ticketContent);

    // Поля НЕ должны быть в frontmatter
    assert.strictEqual(fm.auto_blocked_reason, undefined,
      'auto_blocked_reason должна быть undefined в старом тикете');
  } finally {
    cleanupDir(tmpDir);
  }
});

test('QA-45-008: auto_blocked_attempts в старом тикете == undefined', async () => {
  const tmpDir = createTmpDir();

  try {
    const ticketContent = createOldBlockedTicketContent('IMPL-003', 'Old without attempts');
    const fm = parseFrontmatter(ticketContent);

    assert.strictEqual(fm.auto_blocked_attempts, undefined,
      'auto_blocked_attempts должна быть undefined в старом тикете');
  } finally {
    cleanupDir(tmpDir);
  }
});

test('QA-45-009: auto_blocked_at в старом тикете == undefined', async () => {
  const tmpDir = createTmpDir();

  try {
    const ticketContent = createOldBlockedTicketContent('IMPL-004', 'Old without timestamp');
    const fm = parseFrontmatter(ticketContent);

    assert.strictEqual(fm.auto_blocked_at, undefined,
      'auto_blocked_at должна быть undefined в старом тикете');
  } finally {
    cleanupDir(tmpDir);
  }
});

test('QA-45-010: Все три поля (auto_blocked_*) == undefined одновременно', async () => {
  const tmpDir = createTmpDir();

  try {
    const ticketContent = createOldBlockedTicketContent('IMPL-005', 'Old all undefined');
    const fm = parseFrontmatter(ticketContent);

    // Убеждаемся что все три поля одновременно undefined
    const missingFields = {
      auto_blocked_reason: fm.auto_blocked_reason,
      auto_blocked_attempts: fm.auto_blocked_attempts,
      auto_blocked_at: fm.auto_blocked_at
    };

    assert.strictEqual(missingFields.auto_blocked_reason, undefined);
    assert.strictEqual(missingFields.auto_blocked_attempts, undefined);
    assert.strictEqual(missingFields.auto_blocked_at, undefined);
  } finally {
    cleanupDir(tmpDir);
  }
});

test('QA-45-011: Новый тикет С auto_blocked_* полями парсируется и содержит значения', async () => {
  const tmpDir = createTmpDir();

  try {
    const ticketContent = createNewBlockedTicketContent('IMPL-006', 'New with auto_blocked');
    const fm = parseFrontmatter(ticketContent);

    // Новые поля ДОЛЖНЫ быть определены
    assert.strictEqual(fm.auto_blocked_reason, 'max_review_attempts',
      'auto_blocked_reason должна быть определена в новом тикете');
    assert.strictEqual(fm.auto_blocked_attempts, 6,
      'auto_blocked_attempts должна быть определена в новом тикете');
    assert.ok(fm.auto_blocked_at,
      'auto_blocked_at должна быть определена в новом тикете');
  } finally {
    cleanupDir(tmpDir);
  }
});

test('QA-45-012: Парсинг обоих форматов не выбросит YAML-ошибку', async () => {
  const tmpDir = createTmpDir();

  try {
    const oldContent = createOldBlockedTicketContent('IMPL-007', 'Old format test');
    const newContent = createNewBlockedTicketContent('IMPL-008', 'New format test');

    // Оба должны парситься без исключений
    const oldFm = parseFrontmatter(oldContent);
    const newFm = parseFrontmatter(newContent);

    assert.ok(oldFm, 'Старый format должен спарситься');
    assert.ok(newFm, 'Новый format должен спарситься');

    // Проверяем базовые свойства в обоих
    assert.ok(oldFm.id && newFm.id, 'Оба должны иметь id');
    assert.ok(oldFm.title && newFm.title, 'Оба должны иметь title');
  } finally {
    cleanupDir(tmpDir);
  }
});

test('QA-45-013: Safe access pattern для auto_blocked_reason', async () => {
  const tmpDir = createTmpDir();

  try {
    const oldContent = createOldBlockedTicketContent('IMPL-009', 'Safe access old');
    const newContent = createNewBlockedTicketContent('IMPL-010', 'Safe access new');

    const oldFm = parseFrontmatter(oldContent);
    const newFm = parseFrontmatter(newContent);

    // Safe pattern: использовать `?.` или проверку undefined
    const oldReason = oldFm?.auto_blocked_reason ?? 'unknown';
    const newReason = newFm?.auto_blocked_reason ?? 'unknown';

    assert.strictEqual(oldReason, 'unknown', 'Старый тикет должен вернуть fallback');
    assert.strictEqual(newReason, 'max_review_attempts', 'Новый тикет должен вернуть значение');
  } finally {
    cleanupDir(tmpDir);
  }
});

test('QA-45-014: Backward-compat: при перечислении полей не возникает ошибок', async () => {
  const tmpDir = createTmpDir();

  try {
    const ticketContent = createOldBlockedTicketContent('IMPL-011', 'Iteration test');
    const fm = parseFrontmatter(ticketContent);

    // Перебираем все ключи frontmatter — не должно быть никаких ошибок
    const keys = Object.keys(fm);
    const valueCount = Object.values(fm).length;

    assert.ok(keys.length > 0, 'Frontmatter должен иметь ключи');
    assert.strictEqual(keys.length, valueCount, 'Количество ключей == количеству значений');

    // Убеждаемся что основные ключи есть
    assert.ok(keys.includes('id'), 'id должен быть в ключах');
    assert.ok(keys.includes('title'), 'title должен быть в ключах');

    // А auto_blocked_* ключей НЕ должно быть в старом тикете
    const hasAutoBlockedReason = keys.includes('auto_blocked_reason');
    assert.strictEqual(hasAutoBlockedReason, false,
      'auto_blocked_reason не должен быть в старом тикете');
  } finally {
    cleanupDir(tmpDir);
  }
});
