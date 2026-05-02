#!/usr/bin/env node
/**
 * Integration test: timeout сценарий → запись статуса timeout в "История работы"
 *
 * QA-66: Mock агент зависает → runner убивает по timeout → в тикете запись со статусом `timeout`.
 * Зависит от IMPL-83 (hook для appendAgentRun в fallback-loop).
 *
 * Запуск: node --test src/tests/runner-timeout-audit.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'url';

import { StageExecutor } from '../runner.mjs';
import { parseAgentHistory } from '../../workflow-ai/src/lib/agent-history.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'runner-timeout-audit-'));
}

function cleanupDir(dir) {
  if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Создать stub, который зависает (никогда не завершается)
 */
function writeHangingStub(projectRoot) {
  const stubPath = path.join(projectRoot, 'hanging-stub.mjs');
  fs.writeFileSync(stubPath, `#!/usr/bin/env node
// Зависаем навсегда — никогда не выходим и не пишем в stdout
setTimeout(() => {}, 1000000);
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
title: "Test timeout ticket"
type: impl
created_at: "2026-05-02T00:00:00Z"
updated_at: "2026-05-02T00:00:00Z"
---

## Описание

Test ticket for timeout scenario.

## Definition of Done

- [ ] Проверить timeout обработку
`;
  fs.writeFileSync(ticketPath, content, 'utf-8');
  return ticketPath;
}

function makeConfig(agents) {
  return {
    pipeline: {
      name: 'timeout-audit-test',
      version: '1.0',
      agents,
      execution: {
        artifact_snapshot_enabled: false,
        timeout_per_stage: 0.1, // 100ms — очень короткий timeout для теста
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
// QA-66: timeout → запись статуса timeout в "История работы"
// ============================================================================
test('QA-66-001: Mock агент зависает → timeout → запись в "История работы"', async () => {
  const projectRoot = makeTmpDir();
  try {
    const hangingStub = writeHangingStub(projectRoot);
    const ticketId = 'TEST-TIMEOUT-001';
    const ticketPath = createTicket(projectRoot, ticketId);

    const config = makeConfig({
      'test-agent': { command: 'node', args: [hangingStub], capabilities: ['text'] },
    });
    const executor = makeExecutor(config, projectRoot);
    executor.context = { ticket_id: ticketId };

    const stage = { agents: ['test-agent'], instructions: 'Test timeout', skill: 'test-skill' };

    // Должны получить timeout-ошибку
    let timedOut = false;
    try {
      await executor.executeWithFallback('test-stage', stage);
    } catch (err) {
      if (err.message && err.message.includes('timed out')) {
        timedOut = true;
      }
    }

    assert.ok(timedOut, 'Stage должен завершиться с timeout-ошибкой');

    // Проверить, что в тикете добавилась запись в "История работы" со статусом timeout
    assert.ok(fs.existsSync(ticketPath), 'Тикет должен существовать');
    const content = fs.readFileSync(ticketPath, 'utf-8');
    assert.ok(content.includes('## История работы'), 'Должна быть секция "История работы"');
    assert.ok(content.includes('timeout'), 'Должна быть запись со статусом "timeout"');

    // Парсим историю
    const history = parseAgentHistory(content);
    assert.ok(history.length > 0, 'История должна содержать записи');
    assert.strictEqual(history[history.length - 1].status, 'timeout', 'Последняя запись должна иметь статус "timeout"');
    assert.strictEqual(history[history.length - 1].agent, 'test-agent', 'Агент должен быть "test-agent"');
    assert.strictEqual(history[history.length - 1].skill, 'test-skill', 'Скил должен быть "test-skill"');
  } finally {
    cleanupDir(projectRoot);
  }
});

test('QA-66-002: Файл "История работы" создаётся при первой записи timeout', async () => {
  const projectRoot = makeTmpDir();
  try {
    const hangingStub = writeHangingStub(projectRoot);
    const ticketId = 'TEST-TIMEOUT-002';
    const ticketPath = createTicket(projectRoot, ticketId);

    const config = makeConfig({
      'timeout-agent': { command: 'node', args: [hangingStub], capabilities: ['text'] },
    });
    const executor = makeExecutor(config, projectRoot);
    executor.context = { ticket_id: ticketId };

    const stage = { agents: ['timeout-agent'], instructions: 'Test timeout', skill: 'audit-test-skill' };

    let timedOut = false;
    try {
      await executor.executeWithFallback('test-stage', stage);
    } catch (err) {
      if (err.message && err.message.includes('timed out')) {
        timedOut = true;
      }
    }

    assert.ok(timedOut, 'Stage должен завершиться с timeout-ошибкой');

    // Проверить структуру "История работы"
    const content = fs.readFileSync(ticketPath, 'utf-8');
    const history = parseAgentHistory(content);

    assert.ok(history.length === 1, 'История должна содержать ровно 1 запись (первая попытка)');
    assert.ok(history[0].timestamp, 'Запись должна содержать timestamp');
    assert.strictEqual(history[0].status, 'timeout', 'Статус должен быть "timeout"');
    assert.strictEqual(history[0].skill, 'audit-test-skill', 'Скил должен сохраниться');
    assert.strictEqual(history[0].agent, 'timeout-agent', 'Агент должен сохраниться');
  } finally {
    cleanupDir(projectRoot);
  }
});
