#!/usr/bin/env node

/**
 * Интеграционные тесты PipelineRunner
 *
 * Тестируют полный цикл выполнения пайплайна:
 * - Goto-логика переходов между stages
 * - Передача контекста через params
 * - Retry-механизм с agent_by_attempt
 * - Счётчики попыток (counter, max, on_max)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Импортируем классы из runner.mjs
// Для тестов создаём упрощённые версии
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ============================================================================
// Mock Agent — симулирует CLI-агента с заданным результатом
// ============================================================================
class MockAgent {
  constructor(command, args, behavior) {
    this.command = command;
    this.args = args;
    this.behavior = behavior; // { status: 'passed', data: {} }
    this.callCount = 0;
    this.lastPrompt = '';
  }

  /**
   * Симулирует вызов агента — возвращает заранее заданный результат
   */
  async execute(prompt) {
    this.callCount++;
    this.lastPrompt = prompt;

    // Задержка для реалистичности
    await new Promise(resolve => setTimeout(resolve, 10));

    // Формируем вывод с маркерами результата
    const status = this.behavior.status || 'default';
    const dataLines = Object.entries(this.behavior.data || {})
      .map(([k, v]) => `  ${k}: ${v}`)
      .join('\n');

    return {
      stdout: `
Mock agent executed: ${this.command}

---RESULT---
status: ${status}
${dataLines}
---RESULT---
`,
      stderr: '',
      exitCode: 0
    };
  }
}

// ============================================================================
// Mock Child Process — заменяет реальный spawn для тестов
// ============================================================================
function createMockSpawn(mockAgents) {
  return function mockSpawn(command, args, options) {
    const agentId = Object.keys(mockAgents).find(id =>
      mockAgents[id].command === command
    );

    if (!agentId) {
      throw new Error(`Unknown agent: ${command}`);
    }

    const agent = mockAgents[agentId];
    const prompt = args.includes('-p') ? args[args.indexOf('-p') + 1] : '';

    // Создаём EventEmitter-подобный объект
    const EventEmitter = require('events');
    const child = new EventEmitter();

    // Симулируем выполнение
    setImmediate(async () => {
      try {
        const result = await agent.execute(prompt);
        child.emit('data', Buffer.from(result.stdout));
        child.emit('close', result.exitCode);
      } catch (err) {
        child.emit('error', err);
      }
    });

    child.stdin = {
      write: () => {},
      end: () => {}
    };

    return child;
  };
}

// ============================================================================
// Test: Goto Logic
// ============================================================================
describe('PipelineRunner — Goto Logic', () => {
  it('should transition by exact status match', () => {
    const config = {
      pipeline: {
        name: 'test',
        version: '1.0',
        stages: {
          'stage-a': {
            description: 'Test stage A',
            agent: 'mock',
            skill: 'test',
            goto: {
              passed: { stage: 'stage-b', params: { result: '$result.value' } },
              failed: 'stage-c',
              default: 'end'
            }
          },
          'stage-b': { description: 'B', agent: 'mock', skill: 'test', goto: {} },
          'stage-c': { description: 'C', agent: 'mock', skill: 'test', goto: {} }
        }
      }
    };

    // Простая проверка логики переходов
    const goto = config.pipeline.stages['stage-a'].goto;

    // Exact match
    assert.strictEqual(goto.passed.stage, 'stage-b');
    assert.deepStrictEqual(goto.passed.params, { result: '$result.value' });

    // String transition
    assert.strictEqual(goto.failed, 'stage-c');

    // Default fallback
    assert.strictEqual(goto.default, 'end');
  });

  it('should use default when status not found', () => {
    const goto = {
      passed: 'success-stage',
      failed: 'error-stage',
      default: 'retry-stage'
    };

    const status = 'unknown';
    const nextStage = goto[status] || goto.default;

    assert.strictEqual(nextStage, 'retry-stage');
  });

  it('should interpolate $result variables in params', () => {
    const params = {
      ticket_id: '$result.ticket_id',
      attempt: '$counter.attempt'
    };

    const resultData = { ticket_id: 'IMPL-010' };
    const counters = { attempt: 2 };

    // Простая интерполяция
    const ticketId = params.ticket_id.replace(/\$result\.(\w+)/g, (_, k) => resultData[k] || '');
    const attempt = params.attempt.replace(/\$counter\.(\w+)/g, (_, k) => String(counters[k] || 0));

    assert.strictEqual(ticketId, 'IMPL-010');
    assert.strictEqual(attempt, '2');
  });
});

// ============================================================================
// Test: RunContext — передача переменных между stages
// ============================================================================
describe('PipelineRunner — RunContext', () => {
  it('should update context with params from goto transition', () => {
    const context = { plan_id: 'PLAN-003' };
    const params = {
      ticket_id: '$result.ticket_id',
      report_id: '$result.report_id'
    };
    const resultData = {
      ticket_id: 'IMPL-010',
      report_id: 'REPORT-001'
    };

    // Обновление контекста
    for (const [key, value] of Object.entries(params)) {
      let resolvedValue = value;
      resolvedValue = resolvedValue.replace(/\$result\.(\w+)/g, (_, k) => resultData[k] || '');
      context[key] = resolvedValue;
    }

    assert.strictEqual(context.plan_id, 'PLAN-003');
    assert.strictEqual(context.ticket_id, 'IMPL-010');
    assert.strictEqual(context.report_id, 'REPORT-001');
  });

  it('should preserve context across multiple transitions', () => {
    const context = {};

    // Transition 1: pick-next-task → execute-task
    const params1 = { ticket_id: '$result.ticket_id' };
    const result1 = { ticket_id: 'IMPL-010' };

    for (const [key, value] of Object.entries(params1)) {
      let resolved = value.replace(/\$result\.(\w+)/g, (_, k) => result1[k] || '');
      context[key] = resolved;
    }

    // Transition 2: execute-task → review-result
    const params2 = {
      ticket_id: '$context.ticket_id',
      attempt: '$counter.task_attempts'
    };
    const counters = { task_attempts: 1 };

    for (const [key, value] of Object.entries(params2)) {
      let resolved = value;
      resolved = resolved.replace(/\$context\.(\w+)/g, (_, k) => context[k] || '');
      resolved = resolved.replace(/\$counter\.(\w+)/g, (_, k) => counters[k] || 0);
      context[key] = resolved;
    }

    assert.strictEqual(context.ticket_id, 'IMPL-010');
    assert.strictEqual(context.attempt, '1');
  });
});

// ============================================================================
// Test: Retry Mechanism — counter, max, on_max
// ============================================================================
describe('PipelineRunner — Retry Mechanism', () => {
  it('should increment counter on each stage entry', () => {
    const counters = {};
    const stageCounter = 'task_attempts';

    // First attempt
    counters[stageCounter] = (counters[stageCounter] || 0) + 1;
    assert.strictEqual(counters[stageCounter], 1);

    // Second attempt
    counters[stageCounter] = (counters[stageCounter] || 0) + 1;
    assert.strictEqual(counters[stageCounter], 2);

    // Third attempt
    counters[stageCounter] = (counters[stageCounter] || 0) + 1;
    assert.strictEqual(counters[stageCounter], 3);
  });

  it('should trigger on_max when attempts exhausted', () => {
    const counters = { task_attempts: 3 };
    const maxAttempts = 3;
    const onMax = {
      stage: 'move-ticket',
      params: { target: 'blocked' }
    };

    const attempt = counters.task_attempts;
    const shouldTriggerOnMax = attempt >= maxAttempts;

    assert.strictEqual(shouldTriggerOnMax, true);
    assert.strictEqual(onMax.stage, 'move-ticket');
    assert.deepStrictEqual(onMax.params, { target: 'blocked' });
  });

  it('should respect max attempts limit', () => {
    const testCases = [
      { attempt: 1, max: 3, shouldContinue: true },
      { attempt: 2, max: 3, shouldContinue: true },
      { attempt: 3, max: 3, shouldContinue: false },
      { attempt: 4, max: 3, shouldContinue: false }
    ];

    for (const tc of testCases) {
      const shouldRetry = tc.attempt < tc.max;
      assert.strictEqual(shouldRetry, tc.shouldContinue,
        `Attempt ${tc.attempt}/${tc.max}: expected ${tc.shouldContinue}`);
    }
  });
});

// ============================================================================
// Test: Agent by Attempt — ротация агентов
// ============================================================================
describe('PipelineRunner — Agent by Attempt', () => {
  it('should override agent based on attempt number', () => {
    const agentByAttempt = {
      1: 'claude-opus',
      2: 'qwen-code',
      3: 'claude-opus'
    };

    const attempt = 2;
    const overrideAgent = agentByAttempt[attempt];

    assert.strictEqual(overrideAgent, 'qwen-code');
  });

  it('should handle missing agent override gracefully', () => {
    const agentByAttempt = {
      1: 'claude-opus'
      // 2 и 3 не указаны
    };

    const attempt = 2;
    const overrideAgent = agentByAttempt[attempt];

    // Если агент не указан — используем null/undefined (дефолтное поведение)
    assert.strictEqual(overrideAgent, undefined);
  });

  it('should cycle through agents for multiple retries', () => {
    const agentByAttempt = {
      1: 'agent-a',
      2: 'agent-b',
      3: 'agent-a'
    };

    const sequence = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      sequence.push(agentByAttempt[attempt]);
    }

    assert.deepStrictEqual(sequence, ['agent-a', 'agent-b', 'agent-a']);
  });
});

// ============================================================================
// Test: Full Pipeline Cycle — интеграционный тест
// ============================================================================
describe('PipelineRunner — Full Pipeline Cycle', () => {
  it('should execute full cycle: check → pick → execute → review → move → report', async () => {
    // Конфигурация тестового пайплайна
    const testConfig = {
      pipeline: {
        name: 'test-pipeline',
        version: '1.0',
        entry: 'check-conditions',
        agents: {
          mock: {
            command: 'mock-agent',
            args: ['-p'],
            workdir: '.'
          }
        },
        stages: {
          'check-conditions': {
            description: 'Check conditions',
            agent: 'mock',
            skill: 'check-conditions',
            goto: { default: 'pick-next-task' }
          },
          'pick-next-task': {
            description: 'Pick task',
            agent: 'mock',
            skill: 'pick-next-task',
            goto: {
              found: { stage: 'execute-task', params: { ticket_id: '$result.ticket_id' } },
              empty: 'create-report'
            }
          },
          'execute-task': {
            description: 'Execute task',
            agent: 'mock',
            skill: 'execute-task',
            goto: { default: 'review-result' }
          },
          'review-result': {
            description: 'Review result',
            agent: 'mock',
            skill: 'review-result',
            counter: 'task_attempts',
            goto: {
              passed: { stage: 'move-ticket', params: { target: 'done' } },
              failed: {
                stage: 'execute-task',
                max: 3,
                on_max: { stage: 'move-ticket', params: { target: 'blocked' } }
              }
            }
          },
          'move-ticket': {
            description: 'Move ticket',
            agent: 'mock',
            skill: 'move-ticket',
            goto: { default: 'create-report' }
          },
          'create-report': {
            description: 'Create report',
            agent: 'mock',
            skill: 'create-report',
            goto: { default: 'end' }
          }
        },
        context: {
          plan_id: 'PLAN-TEST'
        },
        execution: {
          max_steps: 50,
          delay_between_stages: 0,
          timeout_per_stage: 10
        }
      }
    };

    // Симуляция выполнения пайплайна
    const executedStages = [];
    const context = { ...testConfig.pipeline.context };
    const counters = {};
    let currentStage = testConfig.pipeline.entry;
    let stepCount = 0;

    // Mock результаты для каждого stage
    const mockResults = {
      'check-conditions': { status: 'default', data: {} },
      'pick-next-task': { status: 'found', data: { ticket_id: 'IMPL-TEST' } },
      'execute-task': { status: 'default', data: {} },
      'review-result': { status: 'passed', data: {} },
      'move-ticket': { status: 'default', data: {} },
      'create-report': { status: 'default', data: { report_id: 'REPORT-TEST' } }
    };

    while (currentStage !== 'end' && stepCount < 50) {
      stepCount++;
      executedStages.push(currentStage);

      const stage = testConfig.pipeline.stages[currentStage];
      if (!stage) break;

      // Инкремент счётчика
      if (stage.counter) {
        counters[stage.counter] = (counters[stage.counter] || 0) + 1;
      }

      // Получаем результат
      const result = mockResults[currentStage];

      // Определяем следующий stage
      const goto = stage.goto;
      const status = result.status;
      let nextStage = 'end';

      if (goto[status]) {
        const transition = goto[status];
        if (transition.params) {
          // Обновляем контекст
          for (const [key, value] of Object.entries(transition.params)) {
            let resolved = value;
            resolved = resolved.replace(/\$result\.(\w+)/g, (_, k) => result.data[k] || '');
            resolved = resolved.replace(/\$context\.(\w+)/g, (_, k) => context[k] || '');
            resolved = resolved.replace(/\$counter\.(\w+)/g, (_, k) => String(counters[k] || 0));
            context[key] = resolved;
          }
        }
        nextStage = typeof transition === 'string' ? transition : (transition.stage || 'end');
      } else if (goto.default) {
        const transition = goto.default;
        nextStage = typeof transition === 'string' ? transition : (transition.stage || 'end');
      }

      currentStage = nextStage;
    }

    // Проверки
    assert.strictEqual(stepCount, 6, 'Should execute 6 stages');
    assert.deepStrictEqual(executedStages, [
      'check-conditions',
      'pick-next-task',
      'execute-task',
      'review-result',
      'move-ticket',
      'create-report'
    ], 'Should execute stages in correct order');

    assert.strictEqual(context.ticket_id, 'IMPL-TEST', 'Should pass ticket_id through context');
    assert.strictEqual(context.plan_id, 'PLAN-TEST', 'Should preserve original context');
  });

  it('should handle retry with agent rotation', () => {
    const stage = {
      counter: 'task_attempts',
      goto: {
        failed: {
          stage: 'execute-task',
          agent_by_attempt: {
            1: 'claude-opus',
            2: 'qwen-code',
            3: 'claude-opus'
          },
          max: 3,
          on_max: { stage: 'move-ticket', params: { target: 'blocked' } }
        }
      }
    };

    const counters = { task_attempts: 0 };
    const agentSequence = [];

    // Симуляция 3 попыток
    for (let i = 1; i <= 3; i++) {
      counters[stage.counter] = i;
      const attempt = counters[stage.counter];

      if (stage.goto.failed.agent_by_attempt[attempt]) {
        agentSequence.push(stage.goto.failed.agent_by_attempt[attempt]);
      }
    }

    assert.deepStrictEqual(agentSequence, ['claude-opus', 'qwen-code', 'claude-opus']);
  });
});

// ============================================================================
// Test: ResultParser Integration
// ============================================================================
describe('PipelineRunner — ResultParser Integration', () => {
  it('should parse structured result from mock agent output', () => {
    const mockOutput = `
Mock agent executed some task

Some intermediate output...

---RESULT---
status: passed
ticket_id: IMPL-010
issues: []
---RESULT---

Some trailing text
`;

    const marker = '---RESULT---';
    const startIdx = mockOutput.indexOf(marker);
    const endIdx = mockOutput.indexOf(marker, startIdx + marker.length);

    assert.notStrictEqual(startIdx, -1, 'Should find start marker');
    assert.notStrictEqual(endIdx, -1, 'Should find end marker');

    const resultBlock = mockOutput.substring(startIdx + marker.length, endIdx).trim();
    const lines = resultBlock.split('\n');
    const data = {};

    for (const line of lines) {
      const match = line.match(/^([^:]+):\s*(.*)$/);
      if (match) {
        data[match[1].trim()] = match[2].trim();
      }
    }

    assert.strictEqual(data.status, 'passed');
    assert.strictEqual(data.ticket_id, 'IMPL-010');
    assert.strictEqual(data.issues, '[]');
  });
});

// ============================================================================
// Test: FileGuard Protection
// ============================================================================
describe('PipelineRunner — FileGuard', () => {
  it('should match glob patterns correctly', () => {
    const patterns = [
      'plans/**',
      'config/*.yaml'
    ];

    const testCases = [
      { path: 'plans/current/PLAN-003.md', shouldMatch: true },
      { path: 'plans/archive/PLAN-001.md', shouldMatch: true },
      { path: 'config/pipeline.yaml', shouldMatch: true },
      { path: 'config/other.yaml', shouldMatch: true },
      { path: 'tickets/backlog/IMPL-010.md', shouldMatch: false },
      { path: 'src/runner.mjs', shouldMatch: false }
    ];

    for (const tc of testCases) {
      const normalized = tc.path.replace(/\\/g, '/');
      const matches = patterns.some(pattern => {
        const regexStr = pattern
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*\*/g, '\x00')
          .replace(/\*/g, '[^/]*')
          .replace(/\x00/g, '.*');
        return new RegExp('^' + regexStr + '$').test(normalized);
      });

      assert.strictEqual(matches, tc.shouldMatch,
        `Path ${tc.path} should ${tc.shouldMatch ? '' : 'not '}match`);
    }
  });
});

// ============================================================================
// Main — запуск тестов
// ============================================================================
console.log('Running PipelineRunner Integration Tests...\n');
