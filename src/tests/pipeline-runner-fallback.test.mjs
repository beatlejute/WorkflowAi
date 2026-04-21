#!/usr/bin/env node
/**
 * Интеграционные тесты fallback-логики StageExecutor (PipelineRunner)
 *
 * Проверяют внутрипопыточный перебор агентов при exit≠0 без side-effect'ов.
 * Запуск: node --test src/tests/pipeline-runner-fallback.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'url';

import { StageExecutor } from '../runner.mjs';
import { isHealthy } from '../lib/agent-health-registry.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================================================
// Helpers
// ============================================================================

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'runner-fallback-'));
}

function cleanupDir(dir) {
  if (dir && fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Создаёт error-объект, имитирующий NON_ZERO_EXIT от callAgent */
function makeError(exitCode, stderr = '') {
  const err = new Error(`Agent exited with code ${exitCode}`);
  err.code = 'NON_ZERO_EXIT';
  err.exitCode = exitCode;
  err.stderr = stderr;
  return err;
}

/** Читает сырой agent-health.json */
function readHealthRaw(projectRoot) {
  const p = path.join(projectRoot, '.workflow', 'state', 'agent-health.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
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

// Тестовые агенты
const AGENTS = {
  'qwen-code':   { command: 'qwen',    args: ['-y', '-p'],                                              capabilities: ['text'] },
  'claude-sonnet': { command: 'claude', args: ['--model', 'claude-sonnet-4-6', '-p'],                  capabilities: ['text', 'multimodal'] },
  'kilo-glm':    { command: 'kilo',    args: ['-m', 'zai/glm-5.1', '--agent', 'code', 'run'],          capabilities: ['text'] },
  'kilo-code':   { command: 'kilo',    args: ['-m', 'kilo/kilo-auto/free', '--agent', 'orch', 'run'],  capabilities: ['text'] },
  'agent-a': { command: 'agent-a', args: ['-p'], capabilities: ['text'] },
  'agent-b': { command: 'agent-b', args: ['-p'], capabilities: ['text'] },
  'agent-c': { command: 'agent-c', args: ['-p'], capabilities: ['text'] },
  'agent-d': { command: 'agent-d', args: ['-p'], capabilities: ['text'] },
  'agent-e': { command: 'agent-e', args: ['-p'], capabilities: ['text'] },
  'agent-f': { command: 'agent-f', args: ['-p'], capabilities: ['text'] },
  'agent-g': { command: 'agent-g', args: ['-p'], capabilities: ['text'] },
};

const BASE_RULES_YAML = `version: "1.0"
common:
  - id: "net-econnreset"
    class: "transient"
    ttl: "5m"
    pattern: "ECONNRESET|ETIMEDOUT|EAI_AGAIN|connection reset by peer|socket hang up"
    exit_codes: "any"
  - id: "http-auth"
    class: "misconfigured"
    ttl: "1h"
    pattern: "\\\\b(401|403)\\\\b|Unauthorized|Forbidden"
    exit_codes: "any"
agents:
  qwen-code:
    rules:
      - id: "qwen-quota"
        class: "unavailable"
        ttl: "until_utc_midnight"
        pattern: "Qwen OAuth quota exceeded"
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
      name: 'test-fallback',
      version: '1.0',
      agents,
      execution: {
        artifact_snapshot_enabled: true,
        snapshot_paths: ['.workflow/tickets'],
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

function makeStage(agents, counter = null) {
  return { agents, instructions: 'Test stage', counter, skill: 'test-skill' };
}

function makeExecutor(config, projectRoot, context = {}, counters = {}) {
  return new StageExecutor(config, context, counters, {}, null, null, projectRoot);
}

// ============================================================================
// TC-001: Quota на qwen-code → fallback на claude-sonnet
// Ассерты: итог passed, qwen-code unhealthy, class=unavailable, rule=qwen-quota
// ============================================================================
test('TC-001: quota на qwen-code → fallback на claude-sonnet в той же attempt', async () => {
  const projectRoot = makeTmpDir();
  try {
    createRulesFile(projectRoot);
    const config = makeConfig(['qwen-code', 'claude-sonnet']);
    const executor = makeExecutor(config, projectRoot);
    const stage = makeStage(['qwen-code', 'claude-sonnet']);

    const callLog = [];
    executor.callAgent = async (agent) => {
      callLog.push(agent.command);
      if (agent.command === 'qwen') throw makeError(1, 'Qwen OAuth quota exceeded');
      return successResult();
    };

    const result = await executor.executeWithFallback('execute-task', stage);

    assert.strictEqual(result.status, 'passed', 'Итог должен быть passed через claude-sonnet');
    assert.deepStrictEqual(callLog, ['qwen', 'claude'], 'Сначала qwen, затем claude-sonnet');
    assert.strictEqual(isHealthy(projectRoot, 'qwen-code'), false, 'qwen-code должен быть unhealthy');

    const health = readHealthRaw(projectRoot);
    assert.strictEqual(health?.agents?.['qwen-code']?.class, 'unavailable', 'class=unavailable');
    assert.strictEqual(health?.agents?.['qwen-code']?.rule_id, 'qwen-quota', 'rule_id=qwen-quota');
  } finally {
    cleanupDir(projectRoot);
  }
});

// ============================================================================
// TC-002: ECONNRESET на claude-sonnet в review-result → fallback на kilo-glm
// Ассерты: итог passed, claude-sonnet unhealthy, class=transient
// ============================================================================
test('TC-002: ECONNRESET на claude-sonnet → fallback на kilo-glm', async () => {
  const projectRoot = makeTmpDir();
  try {
    createRulesFile(projectRoot);
    const config = makeConfig(['claude-sonnet', 'kilo-glm']);
    const executor = makeExecutor(config, projectRoot);
    const stage = makeStage(['claude-sonnet', 'kilo-glm']);

    const callLog = [];
    executor.callAgent = async (agent) => {
      callLog.push(agent.command);
      if (agent.command === 'claude') throw makeError(1, 'ECONNRESET');
      return successResult();
    };

    const result = await executor.executeWithFallback('review-result', stage);

    assert.strictEqual(result.status, 'passed', 'Итог должен быть passed через kilo-glm');
    assert.deepStrictEqual(callLog, ['claude', 'kilo'], 'kilo должен быть вызван как fallback');
    assert.strictEqual(isHealthy(projectRoot, 'claude-sonnet'), false, 'claude-sonnet должен быть unhealthy');

    const health = readHealthRaw(projectRoot);
    assert.strictEqual(health?.agents?.['claude-sonnet']?.class, 'transient', 'class=transient');
  } finally {
    cleanupDir(projectRoot);
  }
});

// ============================================================================
// TC-003: 401 Unauthorized на kilo-code → misconfigured, TTL=1h, fallback
// Ассерты: итог passed, kilo-code unhealthy, class=misconfigured, TTL ≥ 55 мин
// ============================================================================
test('TC-003: 401 Unauthorized на kilo-code → misconfigured, TTL≈1h', async () => {
  const projectRoot = makeTmpDir();
  try {
    createRulesFile(projectRoot);
    const config = makeConfig(['kilo-code', 'claude-sonnet']);
    const executor = makeExecutor(config, projectRoot);
    const stage = makeStage(['kilo-code', 'claude-sonnet']);

    executor.callAgent = async (agent) => {
      if (agent.command === 'kilo') throw makeError(1, '401 Unauthorized');
      return successResult();
    };

    const result = await executor.executeWithFallback('execute-task', stage);

    assert.strictEqual(result.status, 'passed', 'Итог должен быть passed');
    assert.strictEqual(isHealthy(projectRoot, 'kilo-code'), false, 'kilo-code должен быть unhealthy');

    const health = readHealthRaw(projectRoot);
    const kiloEntry = health?.agents?.['kilo-code'];
    assert.ok(kiloEntry, 'Запись kilo-code должна существовать в реестре');
    assert.strictEqual(kiloEntry.class, 'misconfigured', 'class=misconfigured');

    // TTL=1h: until должен быть ≥ 55 минут от сейчас
    const untilMs = new Date(kiloEntry.until).getTime();
    const minExpected = Date.now() + 55 * 60 * 1000;
    assert.ok(untilMs >= minExpected, `TTL должен быть ≥55 мин, until=${kiloEntry.until}`);
  } finally {
    cleanupDir(projectRoot);
  }
});

// ============================================================================
// TC-004: agents: [a, b] оба fail → re-throw lastErr (исчерпание списка)
// Ассерты: бросается ошибка (не blocked), оба агента вызваны
// ============================================================================
test('TC-004: оба агента fall с empty diff → re-throw lastErr', async () => {
  const projectRoot = makeTmpDir();
  try {
    createRulesFile(projectRoot);
    const config = makeConfig(['agent-a', 'agent-b']);
    const executor = makeExecutor(config, projectRoot);
    const stage = makeStage(['agent-a', 'agent-b']);

    const callLog = [];
    executor.callAgent = async (agent) => {
      callLog.push(agent.command);
      throw makeError(1, `${agent.command} failed`);
    };

    await assert.rejects(
      () => executor.executeWithFallback('execute-task', stage),
      (err) => {
        assert.ok(err.exitCode !== undefined, 'Должен быть NON_ZERO_EXIT error');
        return true;
      },
      'Должен выброситься lastErr при исчерпании всех агентов',
    );

    assert.deepStrictEqual(callLog, ['agent-a', 'agent-b'], 'Оба агента должны быть вызваны');
  } finally {
    cleanupDir(projectRoot);
  }
});

// ============================================================================
// TC-005: decompose-plan, claude-sonnet записывает файл и падает
// Ассерты: kilo-glm НЕ вызван, re-throw (артефакт заблокировал fallback)
// ============================================================================
test('TC-005: артефакт создан до падения → fallback заблокирован, re-throw', async () => {
  const projectRoot = makeTmpDir();
  try {
    createRulesFile(projectRoot);
    const config = makeConfig(['claude-sonnet', 'kilo-glm']);
    const executor = makeExecutor(config, projectRoot);
    const stage = makeStage(['claude-sonnet', 'kilo-glm']);

    const callLog = [];
    executor.callAgent = async (agent) => {
      callLog.push(agent.command);
      if (agent.command === 'claude') {
        // Создаём файл в snapshot-path ДО выброса ошибки
        const ticketsDir = path.join(projectRoot, '.workflow', 'tickets', 'backlog');
        fs.mkdirSync(ticketsDir, { recursive: true });
        fs.writeFileSync(path.join(ticketsDir, 'FEAT-001.md'), '# Feature ticket\n', 'utf-8');
        throw makeError(1, 'Internal error after writing');
      }
      return successResult();
    };

    await assert.rejects(
      () => executor.executeWithFallback('decompose-plan', stage),
      (err) => err.exitCode !== undefined,
      'Должен re-throw из-за непустого artifact diff',
    );

    assert.ok(!callLog.includes('kilo'), 'kilo-glm НЕ должен быть вызван');
    assert.strictEqual(callLog.length, 1, 'Должен быть вызван только один агент (claude-sonnet)');
  } finally {
    cleanupDir(projectRoot);
  }
});

// ============================================================================
// TC-006: unmatched error + empty diff → fallback активирован, агент НЕ marked unhealthy
// Ассерты: итог passed (через claude-sonnet), qwen-code НЕ в реестре
// ============================================================================
test('TC-006: unmatched error + empty diff → fallback, агент НЕ marked unhealthy', async () => {
  const projectRoot = makeTmpDir();
  try {
    createRulesFile(projectRoot);
    const config = makeConfig(['qwen-code', 'claude-sonnet']);
    const executor = makeExecutor(config, projectRoot);
    const stage = makeStage(['qwen-code', 'claude-sonnet']);

    executor.callAgent = async (agent) => {
      if (agent.command === 'qwen') {
        // Не матчится ни одному правилу в HEALTH_RULES_YAML
        throw makeError(1, 'Unexpected internal error: panic in runtime');
      }
      return successResult();
    };

    const result = await executor.executeWithFallback('execute-task', stage);

    assert.strictEqual(result.status, 'passed', 'Fallback должен сработать на claude-sonnet');
    // При unmatched classify → null → markUnhealthy не вызван
    assert.strictEqual(isHealthy(projectRoot, 'qwen-code'), true, 'qwen-code НЕ должен быть unhealthy при unmatched error');

    const health = readHealthRaw(projectRoot);
    assert.ok(!health?.agents?.['qwen-code'], 'Записи qwen-code не должно быть в реестре');
  } finally {
    cleanupDir(projectRoot);
  }
});

// ============================================================================
// TC-007: decompose-plan, claude-sonnet exit=1 без файлов → kilo-glm в той же attempt
// Ассерты: оба вызваны в одной attempt, итог passed
// ============================================================================
test('TC-007: decompose-plan: claude-sonnet fail без артефактов → kilo-glm в той же attempt', async () => {
  const projectRoot = makeTmpDir();
  try {
    createRulesFile(projectRoot);
    const config = makeConfig(['claude-sonnet', 'kilo-glm']);
    // counters['decompose-attempt'] = 0 → attempt=1 → cursor=0 → claude-sonnet первым.
    // Семантика counter: число УЖЕ ИСЧЕРПАННЫХ попыток, attempt = counter + 1.
    const executor = makeExecutor(config, projectRoot, {}, { 'decompose-attempt': 0 });
    const stage = makeStage(['claude-sonnet', 'kilo-glm'], 'decompose-attempt');

    const callLog = [];
    executor.callAgent = async (agent) => {
      callLog.push(agent.command);
      if (agent.command === 'claude') throw makeError(1, '');
      return successResult();
    };

    const result = await executor.executeWithFallback('decompose-plan', stage);

    assert.strictEqual(result.status, 'passed', 'kilo-glm должен завершиться успешно');
    assert.deepStrictEqual(callLog, ['claude', 'kilo'], 'claude-sonnet затем kilo-glm в одной attempt');
  } finally {
    cleanupDir(projectRoot);
  }
});

// ============================================================================
// TC-008: execute-task, 7 агентов, все fail с empty diff
// Ассерты: все 7 попробованы, одна ошибка (не 7) из executeWithFallback
// ============================================================================
test('TC-008: 7 агентов все fail → все 7 вызваны, ровно 1 throw из executeWithFallback', async () => {
  const projectRoot = makeTmpDir();
  try {
    createRulesFile(projectRoot);
    const sevenAgents = ['agent-a', 'agent-b', 'agent-c', 'agent-d', 'agent-e', 'agent-f', 'agent-g'];
    const config = makeConfig(sevenAgents);
    const executor = makeExecutor(config, projectRoot);
    const stage = makeStage(sevenAgents);

    const callLog = [];
    executor.callAgent = async (agent) => {
      callLog.push(agent.command);
      throw makeError(1, `${agent.command} failed`);
    };

    let caughtErrors = 0;
    try {
      await executor.executeWithFallback('execute-task', stage);
    } catch {
      caughtErrors++;
    }

    assert.strictEqual(callLog.length, 7, 'Все 7 агентов должны быть вызваны');
    assert.strictEqual(caughtErrors, 1, 'Ровно 1 throw из executeWithFallback (не 7)');
    assert.deepStrictEqual(
      callLog,
      sevenAgents.map(id => AGENTS[id].command),
      'Порядок вызовов должен совпадать с порядком списка агентов',
    );
  } finally {
    cleanupDir(projectRoot);
  }
});

// ============================================================================
// TC-009: resolveAgent unit с excludeAgents
// Ассерты: exclude qwen-code → claude-sonnet; exclude all → blocked: all_unhealthy
// ============================================================================
test('TC-009: resolveAgent с excludeAgents — правильный выбор и blocked при exclude all', () => {
  const projectRoot = makeTmpDir();
  try {
    createRulesFile(projectRoot);
    const config = makeConfig(['qwen-code', 'claude-sonnet']);
    const executor = makeExecutor(config, projectRoot, {}, {});
    const stage = makeStage(['qwen-code', 'claude-sonnet']);

    // exclude qwen-code → должен вернуть claude-sonnet
    const result1 = executor.resolveAgent(stage, 'execute-task', { excludeAgents: ['qwen-code'] });
    assert.ok(!result1.blocked, 'Не должен быть blocked при одном исключении');
    assert.strictEqual(result1.agentId, 'claude-sonnet', 'Должен выбрать claude-sonnet');

    // exclude all → blocked: all_unhealthy
    const result2 = executor.resolveAgent(stage, 'execute-task', { excludeAgents: ['qwen-code', 'claude-sonnet'] });
    assert.ok(result2.blocked, 'Должен быть blocked при исключении всех агентов');
    assert.strictEqual(result2.blocked, 'all_unhealthy', 'blocked reason=all_unhealthy');
  } finally {
    cleanupDir(projectRoot);
  }
});

// ============================================================================
// TC-010: Persistence health-реестра между attempt'ами
// Attempt=1: оба агента fall → маркируются unhealthy → re-throw (1 раз)
// Attempt=2: all_unhealthy с lastErr=null (первая итерация) → { status: 'blocked' }, НЕ throw
// Инвариант: task_attempts инкрементируется только при throw (attempt=1), не при blocked
// ============================================================================
test('TC-010: после exhaustion attempt=1 → throw; attempt=2 all_unhealthy → { status: blocked }', async () => {
  const projectRoot = makeTmpDir();
  try {
    createRulesFile(projectRoot);
    const config = makeConfig(['qwen-code', 'claude-sonnet']);
    const stage = makeStage(['qwen-code', 'claude-sonnet']);

    // ===== Attempt 1: оба агента fall =====
    const executor1 = makeExecutor(config, projectRoot);
    executor1.callAgent = async (agent) => {
      // qwen: quota-матч → unhealthy. claude: ECONNRESET → unhealthy
      const stderr = agent.command === 'qwen' ? 'Qwen OAuth quota exceeded' : 'ECONNRESET';
      throw makeError(1, stderr);
    };

    let attempt1Threw = false;
    try {
      await executor1.executeWithFallback('execute-task', stage);
    } catch {
      attempt1Threw = true;
    }

    assert.ok(attempt1Threw, 'Attempt=1: должен throw при исчерпании агентов');
    assert.strictEqual(isHealthy(projectRoot, 'qwen-code'), false, 'qwen-code unhealthy после attempt=1');
    assert.strictEqual(isHealthy(projectRoot, 'claude-sonnet'), false, 'claude-sonnet unhealthy после attempt=1');

    // ===== Attempt 2: реестр сохранён, агенты unhealthy →
    // resolveAgent возвращает all_unhealthy на ПЕРВОЙ итерации (lastErr=null) → { status: 'blocked' }
    const executor2 = makeExecutor(config, projectRoot);
    executor2.callAgent = async () => {
      throw new Error('callAgent НЕ должен быть вызван на attempt=2');
    };

    let attempt2Result = null;
    let attempt2Threw = false;
    try {
      attempt2Result = await executor2.executeWithFallback('execute-task', stage);
    } catch {
      attempt2Threw = true;
    }

    assert.ok(!attempt2Threw, 'Attempt=2: НЕ должен throw (нет lastErr → blocked, не re-throw)');
    assert.ok(attempt2Result, 'Attempt=2: должен вернуть результат');
    assert.strictEqual(attempt2Result.status, 'blocked', 'Attempt=2: status=blocked');
    assert.strictEqual(attempt2Result.blocked_reason, 'all_unhealthy', 'blocked_reason=all_unhealthy');
  } finally {
    cleanupDir(projectRoot);
  }
});
