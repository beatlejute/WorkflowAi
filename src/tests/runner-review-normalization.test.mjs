#!/usr/bin/env node
/**
 * Integration test: review-result agent_id нормализация runner'ом
 *
 * Сценарий:
 * 1. Mock review-result агент пишет неправильное имя агента (wrong-name) в колонку Агент секции ## Ревью
 * 2. Фактически resolved агент — claude-sonnet
 * 3. После завершения review-result стейджа runner вызывает normalizeReviewAgentId hook
 * 4. Ассерты проверяют, что последняя строка ## Ревью содержит claude-sonnet в колонке Агент
 * 5. Ассерты проверяют, что wrong-name НЕ присутствует в последней строке
 *
 * Запуск: node --test src/tests/runner-review-normalization.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'url';

import { StageExecutor } from '../runner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================================================
// Helpers
// ============================================================================

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'runner-review-norm-'));
}

function cleanupDir(dir) {
  if (dir && fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function makeConfig(agentIds) {
  const agents = {};
  for (const id of agentIds) {
    agents[id] = {
      command: id.toLowerCase().replace(/-/g, ''),
      args: ['-p'],
      capabilities: ['text', 'multimodal']
    };
  }
  return {
    pipeline: {
      name: 'test-review-norm',
      version: '1.0',
      agents,
      execution: {
        artifact_snapshot_enabled: true,
        snapshot_paths: ['.workflow/tickets'],
        timeout_per_stage: 30,
      },
      stages: {},
      entry: 'none',
      context: {},
      default_agents: agentIds,
    },
  };
}

function makeStage(agents) {
  return {
    agents,
    instructions: 'Review stage',
    skill: 'review-result'  // ВАЖНО: skill должен быть review-result для триггера hook'а
  };
}

function makeExecutor(config, projectRoot, context = {}) {
  return new StageExecutor(config, context, {}, {}, null, null, projectRoot);
}

/**
 * Создаёт структуру тикета с ## Ревью секцией
 * ticket_id будет использован для поиска файла тикета в hook'е
 */
function createTicketWithReviewSection(projectRoot, ticketId, initialReviewEntry) {
  const ticketsDir = path.join(projectRoot, '.workflow', 'tickets', 'in-progress');
  fs.mkdirSync(ticketsDir, { recursive: true });

  const ticketPath = path.join(ticketsDir, `${ticketId}.md`);
  const frontmatter = `---
id: ${ticketId}
title: Test Ticket
---

## Описание

Test ticket for review normalization.

## Ревью

| Дата | Статус | Самари | Агент |
|------|--------|--------|-------|
${initialReviewEntry}
`;

  fs.writeFileSync(ticketPath, frontmatter, 'utf8');
  return ticketPath;
}

/**
 * Читает последнюю строку ## Ревью секции из тикета
 */
function getLastReviewLine(ticketPath) {
  const content = fs.readFileSync(ticketPath, 'utf8');
  const reviewMatch = content.match(/##\s+Ревью\s*\r?\n([\s\S]*?)(?=\r?\n##\s+|$)/i);
  if (!reviewMatch) return null;

  const sectionBody = reviewMatch[1];
  const lines = sectionBody.split('\n').filter(l => l.trim());

  // Ищем последнюю data-строку (пропускаем header и separator)
  let lastDataLine = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith('|') && line.endsWith('|')) {
      // Пропускаем separator (строка с дефисами)
      if (!/^\s*\|[\s|-]+\|\s*$/.test(line)) {
        lastDataLine = line;
        break;
      }
    }
  }

  return lastDataLine;
}

/**
 * Извлекает значение из колонки Агент из строки ## Ревью
 */
function extractAgentFromReviewLine(reviewLine) {
  if (!reviewLine) return null;
  const cells = reviewLine.slice(1, -1).split('|').map(c => c.trim());
  // Стандартный порядок: | Дата | Статус | Самари | Агент |
  // Индекс Агента = 3 (0: дата, 1: статус, 2: самари, 3: агент)
  return cells[3] || null;
}

// ============================================================================
// Test Cases
// ============================================================================

test('TC-REVIEW-NORM-001: mock agent пишет wrong-name, hook нормализует на claude-sonnet', async () => {
  const projectRoot = makeTmpDir();
  try {
    const ticketId = 'TEST-REVIEW-001';
    const config = makeConfig(['claude-sonnet']);

    // Создаём тикет с initial review entry (wrong-name в Агент колонке)
    const initialEntry = '| 2026-05-02 | ✅ passed | Test review | wrong-name |';
    const ticketPath = createTicketWithReviewSection(projectRoot, ticketId, initialEntry);

    // Проверяем что initial entry содержит wrong-name
    const beforeLine = getLastReviewLine(ticketPath);
    assert.ok(beforeLine, 'Initial review line должна существовать');
    assert.ok(beforeLine.includes('wrong-name'), 'Initial entry должен содержать wrong-name');

    const executor = makeExecutor(config, projectRoot, {
      ticket_id: ticketId
    });

    const stage = makeStage(['claude-sonnet']);

    // Mock callAgent — возвращает успешный результат без изменений
    executor.callAgent = async (agent) => {
      return {
        status: 'passed',
        output: '---RESULT---\nstatus: passed\n---RESULT---',
        exitCode: 0,
        parsed: true,
        result: { status: 'passed' },
      };
    };

    // Выполняем stage (должен вызвать normalizeReviewAgentId hook)
    const result = await executor.executeWithFallback('review-result', stage);

    assert.strictEqual(result.status, 'passed', 'Stage должен завершиться с passed');

    // После hook'а проверяем что last line нормализована
    const afterLine = getLastReviewLine(ticketPath);
    assert.ok(afterLine, 'Review line должна существовать после нормализации');

    const agentInLine = extractAgentFromReviewLine(afterLine);
    assert.strictEqual(agentInLine, 'claude-sonnet', 'Агент должен быть нормализован на claude-sonnet');
    assert.ok(!afterLine.includes('wrong-name'), 'wrong-name НЕ должно быть в last line');

    console.log('✅ TC-REVIEW-NORM-001 PASSED');
    console.log('   Before:', beforeLine);
    console.log('   After: ', afterLine);
  } finally {
    cleanupDir(projectRoot);
  }
});

test('TC-REVIEW-NORM-002: если agent уже правильный, hook не меняет Агент колонку', async () => {
  const projectRoot = makeTmpDir();
  try {
    const ticketId = 'TEST-REVIEW-002';
    const config = makeConfig(['claude-sonnet']);

    // Создаём тикет с correct agent (claude-sonnet)
    const initialEntry = '| 2026-05-02 | ✅ passed | Test review | claude-sonnet |';
    const ticketPath = createTicketWithReviewSection(projectRoot, ticketId, initialEntry);

    const beforeLine = getLastReviewLine(ticketPath);

    const executor = makeExecutor(config, projectRoot, {
      ticket_id: ticketId
    });

    const stage = makeStage(['claude-sonnet']);

    executor.callAgent = async (agent) => {
      return {
        status: 'passed',
        output: '---RESULT---\nstatus: passed\n---RESULT---',
        exitCode: 0,
        parsed: true,
        result: { status: 'passed' },
      };
    };

    const result = await executor.executeWithFallback('review-result', stage);

    assert.strictEqual(result.status, 'passed', 'Stage должен завершиться с passed');

    const afterLine = getLastReviewLine(ticketPath);
    // Проверяем что Агент колонка осталась правильной
    const agentInLine = extractAgentFromReviewLine(afterLine);
    assert.strictEqual(agentInLine, 'claude-sonnet', 'Агент должен остаться claude-sonnet');

    // Проверяем что сама строка не изменилась (важно для hook'а с changed=false)
    assert.strictEqual(beforeLine, afterLine, 'Строка ## Ревью не должна измениться если agent уже правильный');

    console.log('✅ TC-REVIEW-NORM-002 PASSED');
  } finally {
    cleanupDir(projectRoot);
  }
});

test('TC-REVIEW-NORM-003: hook НЕ срабатывает для non-review-result стейджа', async () => {
  const projectRoot = makeTmpDir();
  try {
    const ticketId = 'TEST-REVIEW-003';
    const config = makeConfig(['claude-sonnet']);

    // Создаём тикет с wrong-name в Агент колонке
    const initialEntry = '| 2026-05-02 | ✅ passed | Test review | wrong-name |';
    const ticketPath = createTicketWithReviewSection(projectRoot, ticketId, initialEntry);

    const beforeLine = getLastReviewLine(ticketPath);

    const executor = makeExecutor(config, projectRoot, {
      ticket_id: ticketId
    });

    // Stage c skill != 'review-result'
    const stage = {
      agents: ['claude-sonnet'],
      instructions: 'Execute task',
      skill: 'execute-task'  // НЕ review-result — hook не должен сработать
    };

    executor.callAgent = async (agent) => {
      return {
        status: 'passed',
        output: '---RESULT---\nstatus: passed\n---RESULT---',
        exitCode: 0,
        parsed: true,
        result: { status: 'passed' },
      };
    };

    const result = await executor.executeWithFallback('execute-task', stage);

    assert.strictEqual(result.status, 'passed', 'Stage должен завершиться с passed');

    // Для non-review-result стейджа hook не срабатывает, поэтому Агент колонка НЕ меняется
    const afterLine = getLastReviewLine(ticketPath);
    const agentInLine = extractAgentFromReviewLine(afterLine);
    assert.strictEqual(agentInLine, 'wrong-name', 'Агент должен остаться wrong-name (hook не сработал для execute-task)');

    // Проверяем что строка ## Ревью не изменилась
    assert.strictEqual(beforeLine, afterLine, 'Строка ## Ревью должна остаться неизменной для non-review-result стейджа');

    console.log('✅ TC-REVIEW-NORM-003 PASSED');
  } finally {
    cleanupDir(projectRoot);
  }
});
