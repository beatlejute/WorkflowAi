#!/usr/bin/env node
/**
 * Интеграционный тест fallback-цепочки с audit-log
 *
 * Проверяет запись в ## История работы и metrics при fallback:
 * - Первый агент: rate_limit (429 Too Many Requests)
 * - Второй агент: ok (exit 0)
 *
 * Запуск: node --test workflow-ai/src/tests/runner-fallback-audit.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'url';

import { StageExecutor } from '../../../src/runner.mjs';
import { parseAgentHistory } from '../lib/agent-history.mjs';
import { readMetricsFile } from '../lib/metrics-incremental.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================================================
// Helpers
// ============================================================================

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'runner-audit-'));
}

function cleanupDir(dir) {
  if (dir && fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Результат успешного агента */
function successResult() {
  return {
    status: 'passed',
    output: '---RESULT---\nstatus: passed\n---RESULT---',
    exitCode: 0,
    parsed: true,
    result: { status: 'passed' },
  };
}

/** Создаёт error-объект для rate_limit */
function makeRateLimitError() {
  const err = new Error('Agent exited with code 1');
  err.code = 'NON_ZERO_EXIT';
  err.exitCode = 1;
  err.stderr = '429 Too Many Requests';
  return err;
}

// Тестовые агенты
const AGENTS = {
  'agent-a': { command: 'agent-a', args: ['-p'], capabilities: ['text'] },
  'agent-b': { command: 'agent-b', args: ['-p'], capabilities: ['text'] },
};

const BASE_RULES_YAML = `version: "1.0"
common:
  - id: "rate-limit"
    class: "transient"
    ttl: "5m"
    pattern: "429|rate.?limit"
    exit_codes: "any"
`;

function createRulesFile(projectRoot, yaml = BASE_RULES_YAML) {
  const dir = path.join(projectRoot, '.workflow', 'config');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent-health-rules.yaml'), yaml, 'utf-8');
}

function makeConfig(agentIds, execOverride = {}) {
  const agents = {};
  for (const id of agentIds) {
    if (AGENTS[id]) agents[id] = AGENTS[id];
  }
  return {
    pipeline: {
      name: 'test-audit',
      version: '1.0',
      agents,
      execution: {
        snapshot_paths: ['src', 'configs'],
        timeout_per_stage: 30,
        ...execOverride,
      },
      stages: {},
      entry: 'none',
      context: {},
      default_agents: agentIds,
    },
  };
}

function makeStage(agents) {
  return { agents, instructions: 'Test stage', skill: 'execute-task' };
}

function makeExecutor(config, projectRoot, ticketId = 'TEST-001', context = {}, counters = {}) {
  return new StageExecutor(
    config,
    { ticket_id: ticketId, ...context },
    counters,
    {},
    null,
    null,
    projectRoot
  );
}

function createTestTicket(projectRoot, ticketId = 'TEST-001') {
  const ticketDir = path.join(projectRoot, '.workflow', 'tickets', 'in-progress');
  fs.mkdirSync(ticketDir, { recursive: true });

  const ticketContent = `---
id: ${ticketId}
title: "Test ticket"
priority: 1
type: qa
---
## Описание
Test ticket for fallback audit
`;

  fs.writeFileSync(path.join(ticketDir, `${ticketId}.md`), ticketContent, 'utf-8');
  return path.join(ticketDir, `${ticketId}.md`);
}

// ============================================================================
// TC-001: Fallback-цепочка (rate_limit → ok)
// Ассерты: 2 строки в История работы (rate_limit + ok), metrics счётчики
// ============================================================================
test('TC-001: fallback-цепочка → 2 строки в История работы + metrics', async () => {
  const projectRoot = makeTmpDir();
  try {
    createRulesFile(projectRoot);
    const config = makeConfig(['agent-a', 'agent-b']);
    const ticketId = 'TEST-001';
    const ticketPath = createTestTicket(projectRoot, ticketId);

    const executor = makeExecutor(config, projectRoot, ticketId);
    const stage = makeStage(['agent-a', 'agent-b']);

    const callLog = [];
    executor.callAgent = async (agent) => {
      callLog.push(agent.command);
      if (agent.command === 'agent-a') {
        throw makeRateLimitError();
      }
      return successResult();
    };

    const result = await executor.executeWithFallback('execute-task', stage);

    // Ассерт 1: Итог должен быть passed
    assert.strictEqual(result.status, 'passed', 'Итог должен быть passed через agent-b');

    // Ассерт 2: Оба агента должны быть вызваны
    assert.deepStrictEqual(callLog, ['agent-a', 'agent-b'], 'agent-a должен выбросить, agent-b должен пройти');

    // Ассерт 3: Прочитаем тикет и проверим История работы
    const ticketContent = fs.readFileSync(ticketPath, 'utf-8');
    const history = parseAgentHistory(ticketContent);

    assert.strictEqual(history.length, 2, `В История работы должно быть 2 строки, найдено: ${history.length}`);

    // Первая строка должна быть rate_limit
    assert.strictEqual(history[0].status, 'rate_limit',
      `Первая строка должна быть rate_limit, найдено: ${history[0].status}`);
    assert.strictEqual(history[0].agent, 'agent-a',
      `Первый агент должен быть agent-a, найдено: ${history[0].agent}`);
    assert.strictEqual(history[0].skill, 'execute-task',
      `Скил должен быть execute-task, найдено: ${history[0].skill}`);

    // Вторая строка должна быть ok
    assert.strictEqual(history[1].status, 'ok',
      `Вторая строка должна быть ok, найдено: ${history[1].status}`);
    assert.strictEqual(history[1].agent, 'agent-b',
      `Второй агент должен быть agent-b, найдено: ${history[1].agent}`);
    assert.strictEqual(history[1].skill, 'execute-task',
      `Скил должен быть execute-task, найдено: ${history[1].skill}`);

    // Ассерт 4: Проверим metrics файл
    const metrics = readMetricsFile(projectRoot);
    assert.ok(metrics.agent_history, 'metrics должны содержать agent_history');
    assert.strictEqual(
      metrics.agent_history.by_status.rate_limit,
      1,
      `by_status.rate_limit должен быть 1, найдено: ${metrics.agent_history.by_status.rate_limit}`
    );
    assert.strictEqual(
      metrics.agent_history.by_status.ok,
      1,
      `by_status.ok должен быть 1, найдено: ${metrics.agent_history.by_status.ok}`
    );
    assert.strictEqual(
      metrics.agent_history.total_attempts,
      2,
      `total_attempts должны быть 2, найдено: ${metrics.agent_history.total_attempts}`
    );

  } finally {
    cleanupDir(projectRoot);
  }
});
