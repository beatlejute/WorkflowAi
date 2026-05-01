#!/usr/bin/env node

/**
 * Unit-тесты для edge case'ов с длинными ticket_id (QA-48)
 *
 * Проверяет:
 * - mark-blocked.js корректно обрабатывает ticket_id длиной > 200 символов (превышающий POSIX limit ~255)
 * - move-ticket.js корректно работает с длинными ticket_id в approval-hook
 * - Graceful failure или truncation без зависания/необработанного исключения
 *
 * POSIX limit на имя файла обычно 255 символов.
 * Если ticket_id + суффикс > 255 — либо валидация отклонит, либо graceful truncation
 *
 * Запуск: node --test src/tests/edge-ticket-id-long.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const MARK_BLOCKED_SCRIPT = path.join(PROJECT_ROOT, 'src', 'scripts', 'mark-blocked.js');
const MOVE_TICKET_SCRIPT = path.join(PROJECT_ROOT, 'src', 'scripts', 'move-ticket.js');

/**
 * Создаёт изолированную тестовую директорию
 */
function createTestEnv() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-long-test-'));
  const workflowDir = path.join(tmpDir, '.workflow');
  const ticketsDir = path.join(workflowDir, 'tickets');
  const stateDir = path.join(workflowDir, 'state');

  const dirs = [
    'ready', 'in-progress', 'blocked', 'done', 'review', 'backlog',
    'approvals', 'state',
  ];
  for (const dir of dirs) {
    fs.mkdirSync(path.join(ticketsDir, dir), { recursive: true });
  }

  fs.mkdirSync(stateDir, { recursive: true });

  return { tmpDir, workflowDir, ticketsDir, stateDir };
}

/**
 * Создаёт файл тикета с заданным ID
 */
function createTicketFile(ticketsDir, subdir, ticketId, frontmatter = {}) {
  const defaultFm = {
    id: ticketId,
    title: `Long ID test: ${ticketId.substring(0, 30)}...`,
    priority: 2,
    type: 'impl',
    created_at: '2026-04-01T10:00:00.000Z',
    updated_at: '2026-04-01T10:00:00.000Z',
  };
  const fm = { ...defaultFm, ...frontmatter };
  const fmText = Object.entries(fm)
    .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
    .join('\n');
  const content = `---\n${fmText}\n---\n\n## Description\n\nLong ID edge case.\n`;
  const filePath = path.join(ticketsDir, subdir, `${ticketId}.md`);

  try {
    fs.writeFileSync(filePath, content);
    return filePath;
  } catch (error) {
    // Если ОС не поддерживает файл с таким длинным именем
    return null;
  }
}

function parseFrontmatter(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!match) return null;
  const fmText = match[1];
  const result = {};
  for (const line of fmText.split('\n')) {
    const m = line.match(/^\s*(\w+):\s*(.*)$/);
    if (m) {
      const key = m[1];
      let val = m[2].trim();
      try {
        result[key] = JSON.parse(val);
      } catch {
        result[key] = val.replace(/^"|"$/g, '');
      }
    }
  }
  return result;
}

function runMarkBlocked(args, cwd) {
  const result = spawnSync('node', [MARK_BLOCKED_SCRIPT, ...args], {
    cwd: cwd || PROJECT_ROOT,
    encoding: 'utf8',
  });
  return {
    code: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function runMoveTicket(args, cwd) {
  const result = spawnSync('node', [MOVE_TICKET_SCRIPT, ...args], {
    cwd: cwd || PROJECT_ROOT,
    encoding: 'utf8',
  });
  return {
    code: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

// ============================================================================
// Группа: Long ticket_id (200+ символов)
// ============================================================================

test('edge-long-id: mark-blocked.js с ticket_id длиной 200 символов', () => {
  const { tmpDir, ticketsDir } = createTestEnv();
  // Создаём ID ровно 200 символов
  const ticketId = 'IMPL-' + 'A'.repeat(195);
  const ticketPath = createTicketFile(ticketsDir, 'ready', ticketId);

  if (!ticketPath) {
    console.log('Test skipped: FS does not support filename this long');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return;
  }

  const result = runMarkBlocked([ticketId, '--attempts=6', '--reason=long_id_200'], tmpDir);

  // Скрипт должен либо завершиться успешно, либо вернуть понятную ошибку
  // Не должен зависнуть или выбросить необработанное исключение
  assert.ok(result.code === 0 || result.code !== null, 'Скрипт должен завершиться с определённым кодом');

  if (result.code === 0) {
    const fm = parseFrontmatter(ticketPath);
    assert.strictEqual(fm.auto_blocked_reason, 'long_id_200');
    assert.strictEqual(fm.auto_blocked_attempts, 6);
  } else {
    // При ошибке должно быть сообщение
    assert.ok(result.stderr.length > 0 || result.stdout.length > 0);
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('edge-long-id: mark-blocked.js с ticket_id длиной 201 символ (превышает обычный limit)', () => {
  const { tmpDir, ticketsDir } = createTestEnv();
  // 201 символ — превышает многие обычные ограничения FS
  const ticketId = 'IMPL-' + 'A'.repeat(196);
  assert.strictEqual(ticketId.length, 201);

  const ticketPath = createTicketFile(ticketsDir, 'ready', ticketId);

  if (!ticketPath) {
    // Нормально для ОС которые не поддерживают такой длинный filename
    console.log('Test note: FS does not support filename > 200 chars (expected on many systems)');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return;
  }

  const result = runMarkBlocked([ticketId, '--attempts=6', '--reason=long_id_201'], tmpDir);

  // Главное — не зависнуть, не выбросить необработанное исключение
  assert.ok(result.code !== null, 'Скрипт должен завершиться (не зависнуть)');

  if (result.code === 0) {
    // Если скрипт справился
    const fm = parseFrontmatter(ticketPath);
    assert.strictEqual(fm.auto_blocked_reason, 'long_id_201');
  } else {
    // Если скрипт вернул ошибку — это нормально, важно что ошибка понятна
    assert.ok(result.stderr.length > 0, 'Должно быть сообщение об ошибке');
    // Сообщение не должно быть пустой (что указывало бы на необработанное исключение)
    assert.ok(result.stderr.includes('error') || result.stderr.includes('Error') || result.stderr.includes('Error'));
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('edge-long-id: mark-blocked.js с ticket_id длиной 255+ символов', () => {
  const { tmpDir, ticketsDir } = createTestEnv();
  // 255+ символов — явно превышает POSIX limit
  const ticketId = 'IMPL-' + 'A'.repeat(251);
  assert.ok(ticketId.length >= 255);

  const ticketPath = createTicketFile(ticketsDir, 'ready', ticketId);

  if (!ticketPath) {
    // На большинстве систем такой файл создать невозможно
    console.log('Test note: FS does not support filename >= 255 chars (expected)');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return;
  }

  const result = runMarkBlocked([ticketId, '--attempts=6', '--reason=long_id_255'], tmpDir);

  // Не должен зависнуть
  assert.ok(result.code !== null);

  if (result.code === 0) {
    const fm = parseFrontmatter(ticketPath);
    assert.strictEqual(fm.auto_blocked_reason, 'long_id_255');
  } else {
    // Ошибка — нормально
    assert.ok(result.stderr.length > 0, 'Должно быть понятное сообщение об ошибке');
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================================
// Группа: Approval-hook с длинным ticket_id
// ============================================================================

test('edge-long-id: move-ticket.js approval-hook с ticket_id длиной 200 символов', () => {
  const { tmpDir, ticketsDir, workflowDir } = createTestEnv();
  const ticketId = 'IMPL-' + 'A'.repeat(195);
  const ticketPath = createTicketFile(ticketsDir, 'ready', ticketId);

  if (!ticketPath) {
    console.log('Test skipped: FS does not support filename this long');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return;
  }

  const approvalsDir = path.join(workflowDir, 'approvals');
  fs.mkdirSync(approvalsDir, { recursive: true });

  // Создаём approval-файл с длинным ticket_id
  const approvalFileName = `${ticketId}_manual-gate-human_0.json`;

  // На некоторых ОС даже этот файл может быть слишком длинным
  // Но попытаемся
  try {
    const approvalPath = path.join(approvalsDir, approvalFileName);
    const approvalData = {
      ticket_id: ticketId,
      status: 'pending',
      created_at: new Date().toISOString(),
    };
    fs.writeFileSync(approvalPath, JSON.stringify(approvalData, null, 2));

    const result = runMoveTicket([ticketId, 'in-progress'], tmpDir);

    // move-ticket должен завершиться
    assert.ok(result.code !== null);

    if (result.code === 0 && fs.existsSync(approvalPath)) {
      const updated = JSON.parse(fs.readFileSync(approvalPath, 'utf8'));
      assert.strictEqual(updated.status, 'approved');
    }
  } catch (error) {
    // Если FS не поддерживает файл — пропускаем
    if (error.code === 'ENAMETOOLONG') {
      console.log('Test note: FS does not support approval filename this long (expected)');
    } else {
      throw error;
    }
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================================
// Группа: Performance — не должно зависнуть на длинных ID
// ============================================================================

test('edge-long-id: mark-blocked.js не зависает на очень длинном ticket_id', () => {
  const { tmpDir, ticketsDir } = createTestEnv();
  const ticketId = 'IMPL-' + 'A'.repeat(100);
  const ticketPath = createTicketFile(ticketsDir, 'ready', ticketId);

  if (!ticketPath) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return;
  }

  const startTime = Date.now();
  const result = runMarkBlocked([ticketId, '--attempts=6', '--reason=perf_test'], tmpDir);
  const elapsed = Date.now() - startTime;

  // Скрипт должен завершиться быстро (не более 5 сек)
  assert.ok(elapsed < 5000, `Скрипт не должен зависнуть (выполнялся ${elapsed}мс)`);

  // Должен либо пройти успешно, либо вернуть быструю ошибку
  assert.ok(result.code === 0 || (result.code !== null && elapsed < 1000));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================================
// Группа: Граничные случаи
// ============================================================================

test('edge-long-id: mark-blocked.js с ticket_id ровно 255 символов', () => {
  const { tmpDir, ticketsDir } = createTestEnv();
  // Ровно 255 — на границе лимита
  const ticketId = 'IMPL-' + 'A'.repeat(250);
  assert.strictEqual(ticketId.length, 255);

  const ticketPath = createTicketFile(ticketsDir, 'ready', ticketId);

  if (!ticketPath) {
    console.log('Test note: FS does not support filename exactly 255 chars');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return;
  }

  const result = runMarkBlocked([ticketId, '--attempts=6', '--reason=boundary_255'], tmpDir);

  if (result.code === 0) {
    const fm = parseFrontmatter(ticketPath);
    assert.strictEqual(fm.auto_blocked_reason, 'boundary_255');
  } else {
    // Ошибка при таком лимите — нормально
    assert.ok(result.stderr.length > 0);
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

console.log('✅ Edge case tests for long ticket_id loaded successfully');
