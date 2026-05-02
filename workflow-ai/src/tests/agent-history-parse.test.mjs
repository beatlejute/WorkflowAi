import { test } from 'node:test';
import assert from 'node:assert';
import { parseAgentHistory } from '../lib/agent-history.mjs';

// TC-001: Empty content → []
test('TC-001: parseAgentHistory should return empty array for empty content', () => {
  const result = parseAgentHistory('');
  assert.deepStrictEqual(result, []);
});

// TC-002: Content without "## История работы" section → []
test('TC-002: parseAgentHistory should return empty array when section is missing', () => {
  const content = `# Some Title
## Other Section
Some content here`;
  const result = parseAgentHistory(content);
  assert.deepStrictEqual(result, []);
});

// TC-003: 4-column table with 3 rows → array of 3 objects with correct fields
test('TC-003: parseAgentHistory should parse 4-column table with 3 rows correctly', () => {
  const content = `# Test
## История работы

| Дата/время | Скил | Агент | Статус |
|------------|------|-------|--------|
| 2026-05-01 10:00:00 | create-plan | claude-sonnet | ok |
| 2026-05-01 11:00:00 | execute-task | claude-opus | error |
| 2026-05-01 12:00:00 | review-result | claude-haiku | blocked |`;

  const result = parseAgentHistory(content);
  assert.strictEqual(result.length, 3);

  assert.deepStrictEqual(result[0], {
    timestamp: '2026-05-01 10:00:00',
    skill: 'create-plan',
    agent: 'claude-sonnet',
    status: 'ok'
  });

  assert.deepStrictEqual(result[1], {
    timestamp: '2026-05-01 11:00:00',
    skill: 'execute-task',
    agent: 'claude-opus',
    status: 'error'
  });

  assert.deepStrictEqual(result[2], {
    timestamp: '2026-05-01 12:00:00',
    skill: 'review-result',
    agent: 'claude-haiku',
    status: 'blocked'
  });
});

// TC-004: Legacy 3-column table → array with status === 'unknown'
test('TC-004: parseAgentHistory should parse legacy 3-column table with status unknown', () => {
  const content = `# Test
## История работы

| Дата/время | Скил | Агент |
|------------|------|-------|
| 2026-05-01 10:00:00 | coach | claude-sonnet |
| 2026-05-01 11:00:00 | analyze-report | claude-opus |`;

  const result = parseAgentHistory(content);
  assert.strictEqual(result.length, 2);

  result.forEach(entry => {
    assert.strictEqual(entry.status, 'unknown');
  });

  assert.deepStrictEqual(result[0], {
    timestamp: '2026-05-01 10:00:00',
    skill: 'coach',
    agent: 'claude-sonnet',
    status: 'unknown'
  });

  assert.deepStrictEqual(result[1], {
    timestamp: '2026-05-01 11:00:00',
    skill: 'analyze-report',
    agent: 'claude-opus',
    status: 'unknown'
  });
});

// TC-005: Row with \| escape in cell → escape \| is preserved as | in value
test('TC-005: parseAgentHistory should preserve escaped pipe characters in cell values', () => {
  const content = `# Test
## История работы

| Дата/время | Скил | Агент | Статус |
|------------|------|-------|--------|
| 2026-05-01\\|10:00:00 | create\\|plan | agent\\|name | ok |`;

  const result = parseAgentHistory(content);
  assert.strictEqual(result.length, 1);

  const entry = result[0];
  assert.strictEqual(entry.timestamp, '2026-05-01|10:00:00');
  assert.strictEqual(entry.skill, 'create|plan');
  assert.strictEqual(entry.agent, 'agent|name');
  assert.strictEqual(entry.status, 'ok');
});

// TC-006: Corrupted row (invalid number of cells) → skip with warn, parse remaining rows
test('TC-006: parseAgentHistory should skip corrupted rows and parse valid rows', () => {
  const originalWarn = console.warn;
  const warnCalls = [];
  console.warn = (...args) => {
    warnCalls.push(args.join(' '));
  };

  try {
    const content = `# Test
## История работы

| Дата/время | Скил | Агент | Статус |
|------------|------|-------|--------|
| 2026-05-01 10:00:00 | create-plan | claude-sonnet | ok |
| 2026-05-01 11:00:00 | execute-task |
| 2026-05-01 12:00:00 | review-result | claude-haiku | blocked |`;

    const result = parseAgentHistory(content);

    assert.strictEqual(result.length, 2);

    assert.deepStrictEqual(result[0], {
      timestamp: '2026-05-01 10:00:00',
      skill: 'create-plan',
      agent: 'claude-sonnet',
      status: 'ok'
    });

    assert.deepStrictEqual(result[1], {
      timestamp: '2026-05-01 12:00:00',
      skill: 'review-result',
      agent: 'claude-haiku',
      status: 'blocked'
    });

    assert(warnCalls.length > 0, 'console.warn should have been called');
    assert(warnCalls.some(call => call.includes('Invalid row')), 'Should warn about invalid row');
  } finally {
    console.warn = originalWarn;
  }
});
