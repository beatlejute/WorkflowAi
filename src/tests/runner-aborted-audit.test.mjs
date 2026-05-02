#!/usr/bin/env node
/**
 * Integration test: aborted (SIGTERM) сценарий → запись статуса aborted в "История работы"
 *
 * QA-67: Mock агент получает SIGTERM → в тикете запись со статусом `aborted`.
 * Зависит от IMPL-83 (hook для appendAgentRun в fallback-loop).
 *
 * Запуск: node --test src/tests/runner-aborted-audit.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'url';

import { StageExecutor } from '../runner.mjs';
import { parseAgentHistory } from '../lib/agent-history.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'runner-aborted-audit-'));
}

function cleanupDir(dir) {
  if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Создать stub, который может быть убит сигналом (бежит и не завершается сам)
 */
function writeLongRunningStub(projectRoot) {
  const stubPath = path.join(projectRoot, 'long-running-stub.mjs');
  fs.writeFileSync(stubPath, `#!/usr/bin/env node
// Долго бегущий процесс — может быть убит сигналом
const startTime = Date.now();
process.on('SIGTERM', () => {
  // Обработчик сигнала — позволяет корректно завершиться
  process.exit(143); // 128 + 15 (SIGTERM) = 143
});

// Бежим долго — в тесте его убьём через несколько ms
const interval = setInterval(() => {
  const elapsed = Date.now() - startTime;
  if (elapsed > 10000) {
    clearInterval(interval);
    process.exit(0);
  }
}, 100);
`);
  return stubPath;
}

/**
 * Создать fixture-тикет для проверки
 */
function createTicket(projectRoot, ticketId) {
  const dir = path.join(projectRoot, '.workflow', 'tickets', 'in-progress');
  fs.mkdirSync(dir, { recursive: true });
  const ticketPath = path.join(dir, `${ticketId}.md`);
  const content = `---
id: ${ticketId}
title: "Test aborted ticket"
type: impl
created_at: "2026-05-02T00:00:00Z"
updated_at: "2026-05-02T00:00:00Z"
---

## Описание

Test ticket for aborted scenario.

## Definition of Done

- [ ] Проверить обработку SIGTERM
`;
  fs.writeFileSync(ticketPath, content, 'utf-8');
  return ticketPath;
}

function makeConfig(agents) {
  return {
    pipeline: {
      name: 'aborted-audit-test',
      version: '1.0',
      agents,
      execution: {
        artifact_snapshot_enabled: false,
        timeout_per_stage: 300, // 300s — долгий timeout, чтобы тест самостоятельно убил процесс
      },
      stages: {},
      entry: 'none',
      context: {},
    },
  };
}

function makeExecutor(config, projectRoot) {
  return new StageExecutor(config, {}, {}, {}, null, null, projectRoot);
}

// ============================================================================
// QA-67: SIGTERM → запись статуса aborted в "История работы"
// ============================================================================

test('QA-67-001: Mock агент получает SIGTERM → aborted → запись в "История работы"', async () => {
  const projectRoot = makeTmpDir();
  try {
    const longRunningStub = writeLongRunningStub(projectRoot);
    const ticketId = 'TEST-ABORTED-001';
    const ticketPath = createTicket(projectRoot, ticketId);

    const config = makeConfig({
      'test-agent': { command: 'node', args: [longRunningStub], capabilities: ['text'] },
    });
    const executor = makeExecutor(config, projectRoot);
    executor.context = { ticket_id: ticketId };

    const stage = { agents: ['test-agent'], instructions: 'Test aborted', skill: 'test-skill' };

    // Запускаем стейдж и убьём его через небольшую задержку
    let aborted = false;
    const executePromise = executor.executeWithFallback('test-stage', stage).catch(err => {
      // Ошибка при убийстве процесса — нормально
    });

    // Даём процессу время на запуск
    await new Promise(resolve => setTimeout(resolve, 100));

    // Убиваем текущий child process
    if (executor.currentChild) {
      executor.currentChild.kill('SIGTERM');
      aborted = true;
    }

    // Ждём завершения executeWithFallback
    try {
      await executePromise;
    } catch (err) {
      // Ожидается ошибка при SIGTERM
    }

    assert.ok(aborted, 'Процесс должен был быть убит');

    // Проверить, что в тикете добавилась запись в "История работы" со статусом aborted
    assert.ok(fs.existsSync(ticketPath), 'Тикет должен существовать');
    const content = fs.readFileSync(ticketPath, 'utf-8');
    assert.ok(content.includes('## История работы'), 'Должна быть секция "История работы"');
    assert.ok(content.includes('aborted'), 'Должна быть запись со статусом "aborted"');

    // Парсим историю
    const history = parseAgentHistory(content);
    assert.ok(history.length > 0, 'История должна содержать записи');

    // Последняя запись должна иметь статус aborted
    const lastEntry = history[history.length - 1];
    assert.strictEqual(lastEntry.status, 'aborted', 'Последняя запись должна иметь статус "aborted"');
    assert.strictEqual(lastEntry.agent, 'test-agent', 'Агент должен быть "test-agent"');
    assert.strictEqual(lastEntry.skill, 'test-skill', 'Скил должен быть "test-skill"');
    assert.ok(lastEntry.timestamp, 'Запись должна содержать timestamp');
  } finally {
    cleanupDir(projectRoot);
  }
});

test('QA-67-002: Структура "История работы" при SIGTERM', async () => {
  const projectRoot = makeTmpDir();
  try {
    const longRunningStub = writeLongRunningStub(projectRoot);
    const ticketId = 'TEST-ABORTED-002';
    const ticketPath = createTicket(projectRoot, ticketId);

    const config = makeConfig({
      'aborted-agent': { command: 'node', args: [longRunningStub], capabilities: ['text'] },
    });
    const executor = makeExecutor(config, projectRoot);
    executor.context = { ticket_id: ticketId };

    const stage = { agents: ['aborted-agent'], instructions: 'Test aborted', skill: 'audit-skill' };

    const executePromise = executor.executeWithFallback('test-stage', stage).catch(() => {
      // Ожидается ошибка
    });

    // Даём процессу время на запуск
    await new Promise(resolve => setTimeout(resolve, 100));

    // Убиваем процесс
    if (executor.currentChild) {
      executor.currentChild.kill('SIGTERM');
    }

    try {
      await executePromise;
    } catch (err) {
      // Ожидается ошибка при SIGTERM
    }

    // Проверить структуру "История работы"
    const content = fs.readFileSync(ticketPath, 'utf-8');
    const history = parseAgentHistory(content);

    assert.ok(history.length >= 1, 'История должна содержать записи');

    // Проверяем последнюю запись
    const lastEntry = history[history.length - 1];
    assert.strictEqual(lastEntry.status, 'aborted', 'Статус должен быть "aborted"');
    assert.strictEqual(lastEntry.skill, 'audit-skill', 'Скил должен сохраниться');
    assert.strictEqual(lastEntry.agent, 'aborted-agent', 'Агент должен сохраниться');
    assert.ok(lastEntry.timestamp, 'Timestamp должен существовать');

    // Проверяем формат timestamp (YYYY-MM-DD HH:MM:SS)
    const tsRegex = /^\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2}$/;
    assert.match(lastEntry.timestamp, tsRegex, 'Timestamp должен быть в формате YYYY-MM-DD HH:MM:SS');
  } finally {
    cleanupDir(projectRoot);
  }
});
