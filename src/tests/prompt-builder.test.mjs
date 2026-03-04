#!/usr/bin/env node

/**
 * Unit tests for PromptBuilder
 *
 * Run with: node result/src/tests/prompt-builder.test.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// PromptBuilder class (copied from runner.mjs for testing)
// ============================================================================

class PromptBuilder {
  constructor(context, counters, previousResults = {}) {
    this.context = context;
    this.counters = counters;
    this.previousResults = previousResults;
  }

  /**
   * Формирует промпт для агента на основе skill инструкции
   */
  build(stage, stageId) {
    const skillPath = path.join(__dirname, '..', 'skills', stage.skill, 'SKILL.md');

    let skillInstruction = '';
    if (fs.existsSync(skillPath)) {
      skillInstruction = fs.readFileSync(skillPath, 'utf8');
    } else {
      skillInstruction = `Skill "${stage.skill}" not found. Execute: ${stage.description}`;
    }

    // Формируем основную часть промпта
    const basePrompt = `
${skillInstruction}

## Контекст выполнения

План: ${this.context.plan_id || 'N/A'}
Stage: ${stage.skill}
Ticket: ${this.context.ticket_id || 'N/A'}

### Переменные контекста:
${this.formatContext()}

### Счётчики:
${this.formatCounters()}

### Результаты предыдущих stages:
${this.formatPreviousResults()}

## Инструкция

Выполни задачу согласно инструкции из skill. Результат выводи в формате:

---RESULT---
status: <status>
<ключ>: <значение>
---RESULT---

Где <status> — один из ключей goto для этого stage.
`;

    return basePrompt;
  }

  /**
   * Форматирует контекст для вывода
   */
  formatContext() {
    const entries = Object.entries(this.context)
      .filter(([_, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `  ${k}: ${v}`);
    return entries.length > 0 ? entries.join('\n') : '  (пусто)';
  }

  /**
   * Форматирует счётчики для вывода
   */
  formatCounters() {
    const entries = Object.entries(this.counters)
      .map(([k, v]) => `  ${k}: ${v}`);
    return entries.length > 0 ? entries.join('\n') : '  (пусто)';
  }

  /**
   * Форматирует результаты предыдущих stages
   */
  formatPreviousResults() {
    const entries = Object.entries(this.previousResults)
      .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`);
    return entries.length > 0 ? entries.join('\n') : '  (нет результатов)';
  }

  /**
   * Интерполирует переменные в строке
   * Поддерживает: $result.field, $context.field, $counter.field
   */
  interpolate(template, resultData = {}) {
    if (typeof template !== 'string') {
      return template;
    }

    let resolved = template;

    // $result.* - подстановка из результата
    resolved = resolved.replace(/\$result\.(\w+)/g, (_, key) => {
      return resultData[key] !== undefined ? resultData[key] : '';
    });

    // $context.* - подстановка из контекста
    resolved = resolved.replace(/\$context\.(\w+)/g, (_, key) => {
      return this.context[key] !== undefined ? this.context[key] : '';
    });

    // $counter.* - подстановка из счётчиков
    resolved = resolved.replace(/\$counter\.(\w+)/g, (_, key) => {
      return this.counters[key] !== undefined ? this.counters[key] : 0;
    });

    return resolved;
  }
}

// ============================================================================
// Test runner utilities
// ============================================================================

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.message}`);
    failed++;
  }
}

function assertEqual(actual, expected, message = '') {
  const actualStr = JSON.stringify(actual);
  const expectedStr = JSON.stringify(expected);
  if (actualStr !== expectedStr) {
    throw new Error(`${message}\n  Expected: ${expectedStr}\n  Actual: ${actualStr}`);
  }
}

function assertTrue(value, message = '') {
  if (!value) {
    throw new Error(message || 'Expected truthy value');
  }
}

function assertFalse(value, message = '') {
  if (value) {
    throw new Error(message || 'Expected falsy value');
  }
}

// ============================================================================
// Tests
// ============================================================================

console.log('\n=== PromptBuilder Unit Tests ===\n');

console.log('Test 1: Context interpolation\n');

test('Interpolates $context variables', () => {
  const builder = new PromptBuilder(
    { plan_id: 'PLAN-001', ticket_id: 'IMPL-005', author: 'test' },
    {},
    {}
  );

  const template = 'Execute for plan $context.plan_id and ticket $context.ticket_id';
  const result = builder.interpolate(template);

  assertEqual(result, 'Execute for plan PLAN-001 and ticket IMPL-005');
});

test('Interpolates $counter variables', () => {
  const builder = new PromptBuilder(
    {},
    { task_attempts: 2, plan_iterations: 1 },
    {}
  );

  const template = 'Attempt $counter.task_attempts of max $counter.plan_iterations';
  const result = builder.interpolate(template);

  assertEqual(result, 'Attempt 2 of max 1');
});

test('Interpolates $result variables', () => {
  const builder = new PromptBuilder({}, {}, {});
  const resultData = { ticket_id: 'IMPL-007', status: 'done', issues: 'none' };

  const template = 'Ticket $result.ticket_id completed with status $result.status';
  const result = builder.interpolate(template, resultData);

  assertEqual(result, 'Ticket IMPL-007 completed with status done');
});

test('Interpolates mixed variables', () => {
  const builder = new PromptBuilder(
    { plan_id: 'PLAN-003' },
    { task_attempts: 1 },
    {}
  );
  const resultData = { ticket_id: 'IMPL-009' };

  const template = 'Plan $context.plan_id, ticket $result.ticket_id, attempt $counter.task_attempts';
  const result = builder.interpolate(template, resultData);

  assertEqual(result, 'Plan PLAN-003, ticket IMPL-009, attempt 1');
});

test('Handles missing variables gracefully', () => {
  const builder = new PromptBuilder(
    { plan_id: 'PLAN-001' },
    {},
    {}
  );

  const template = 'Plan $context.plan_id, ticket $context.missing, counter $counter.missing';
  const result = builder.interpolate(template);

  assertEqual(result, 'Plan PLAN-001, ticket , counter 0');
});

test('Returns non-string values unchanged', () => {
  const builder = new PromptBuilder({}, {}, {});

  assertEqual(builder.interpolate(null), null);
  assertEqual(builder.interpolate(undefined), undefined);
  assertEqual(builder.interpolate(123), 123);
  assertEqual(builder.interpolate({ key: 'value' }), { key: 'value' });
});

console.log('\nTest 2: Format context for prompt\n');

test('Formats context entries', () => {
  const builder = new PromptBuilder(
    { plan_id: 'PLAN-001', ticket_id: 'IMPL-005', empty: '' },
    {},
    {}
  );

  const formatted = builder.formatContext();

  assertTrue(formatted.includes('plan_id: PLAN-001'));
  assertTrue(formatted.includes('ticket_id: IMPL-005'));
  assertFalse(formatted.includes('empty:'));
});

test('Filters out null and undefined values', () => {
  const builder = new PromptBuilder(
    { plan_id: 'PLAN-001', nullVal: null, undefVal: undefined },
    {},
    {}
  );

  const formatted = builder.formatContext();

  assertTrue(formatted.includes('plan_id'));
  assertFalse(formatted.includes('nullVal'));
  assertFalse(formatted.includes('undefVal'));
});

test('Returns empty message when no context', () => {
  const builder = new PromptBuilder({}, {}, {});

  const formatted = builder.formatContext();

  assertEqual(formatted, '  (пусто)');
});

console.log('\nTest 3: Format counters\n');

test('Formats counter entries', () => {
  const builder = new PromptBuilder(
    {},
    { task_attempts: 3, plan_iterations: 2 },
    {}
  );

  const formatted = builder.formatCounters();

  assertTrue(formatted.includes('task_attempts: 3'));
  assertTrue(formatted.includes('plan_iterations: 2'));
});

test('Returns empty message when no counters', () => {
  const builder = new PromptBuilder({}, {}, {});

  const formatted = builder.formatCounters();

  assertEqual(formatted, '  (пусто)');
});

console.log('\nTest 4: Format previous results\n');

test('Formats previous results as JSON', () => {
  const builder = new PromptBuilder(
    {},
    {},
    { execute_task: { status: 'done', ticket_id: 'IMPL-001' } }
  );

  const formatted = builder.formatPreviousResults();

  assertTrue(formatted.includes('execute_task'));
  assertTrue(formatted.includes('status'));
  assertTrue(formatted.includes('ticket_id'));
});

test('Returns empty message when no previous results', () => {
  const builder = new PromptBuilder({}, {}, {});

  const formatted = builder.formatPreviousResults();

  assertEqual(formatted, '  (нет результатов)');
});

console.log('\nTest 5: Build full prompt\n');

test('Builds prompt with skill instruction', () => {
  const builder = new PromptBuilder(
    { plan_id: 'PLAN-003', ticket_id: 'IMPL-009' },
    { task_attempts: 1 },
    {}
  );

  const stage = {
    skill: 'execute-task',
    description: 'Execute a task from ticket'
  };

  const prompt = builder.build(stage, 'execute-task');

  // Verify prompt structure
  assertTrue(prompt.includes('## Контекст выполнения'), 'Should contain context header');
  assertTrue(prompt.includes('План: PLAN-003'), 'Should contain plan ID');
  assertTrue(prompt.includes('Ticket: IMPL-009'), 'Should contain ticket ID');
  assertTrue(prompt.includes('---RESULT---'), 'Should contain result markers');
  assertTrue(prompt.length > 100, 'Prompt should be substantial');
});

// ============================================================================
// Summary
// ============================================================================

console.log('\n=== Test Summary ===\n');
console.log(`Total: ${passed + failed}`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed > 0) {
  console.log('\n❌ Some tests failed\n');
  process.exit(1);
} else {
  console.log('\n✅ All tests passed\n');
  process.exit(0);
}
