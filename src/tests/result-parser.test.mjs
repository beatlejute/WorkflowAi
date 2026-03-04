#!/usr/bin/env node

/**
 * Unit tests for ResultParser
 *
 * Run with: node result/src/tests/result-parser.test.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// ResultParser class (copied from runner.mjs for testing)
// ============================================================================

class ResultParser {
  /**
   * Парсит вывод агента и извлекает результат между маркерами
   */
  parse(output, stageId) {
    const marker = '---RESULT---';

    // Попытка найти парные маркеры
    const startIdx = output.indexOf(marker);
    const endIdx = startIdx !== -1 ? output.indexOf(marker, startIdx + marker.length) : -1;

    if (startIdx !== -1 && endIdx !== -1) {
      // Найдены маркеры — парсим структурированный блок
      const resultBlock = output.substring(startIdx + marker.length, endIdx).trim();
      const data = this.parseResultBlock(resultBlock);

      console.log(`[ResultParser] Parsed structured result for ${stageId}: status=${data.status}`);

      return {
        status: data.status || 'default',
        data: data.data || {},
        raw: output,
        parsed: true
      };
    }

    // Fallback: пытаемся парсить текстовый вывод
    console.log(`[ResultParser] No result markers found for ${stageId}, attempting fallback parsing`);
    return this.fallbackParse(output, stageId);
  }

  /**
   * Парсит блок результата в формате key: value
   */
  parseResultBlock(block) {
    const lines = block.split('\n');
    const data = {};
    let status = 'default';

    for (const line of lines) {
      const match = line.match(/^([^:]+):\s*(.*)$/);
      if (match) {
        const key = match[1].trim();
        const value = match[2].trim();

        if (key === 'status') {
          status = value;
        } else {
          data[key] = value;
        }
      }
    }

    return { status, data };
  }

  /**
   * Fallback-парсинг для вывода без маркеров
   */
  fallbackParse(output, stageId) {
    const lines = output.split('\n');
    let status = 'default';
    const extractedData = {};
    let inResultSection = false;

    // Ищем паттерны вида "status: xxx" или "Status: xxx" в любом месте вывода
    for (const line of lines) {
      const trimmedLine = line.trim();

      // Паттерн для извлечения статуса
      const statusMatch = trimmedLine.match(/^(?:status|Status):\s*(\w+)/i);
      if (statusMatch) {
        status = statusMatch[1];
        inResultSection = true;
        continue;
      }

      // Если нашли статус, пытаемся извлечь дополнительные данные
      if (inResultSection) {
        const dataMatch = trimmedLine.match(/^(\w+):\s*(.+)$/i);
        if (dataMatch && dataMatch[1].toLowerCase() !== 'status') {
          extractedData[dataMatch[1]] = dataMatch[2];
        }
      }
    }

    // Если статус не найден, пытаемся определить по ключевым словам
    if (status === 'default') {
      const lowerOutput = output.toLowerCase();
      if (lowerOutput.includes('completed') || lowerOutput.includes('success') || lowerOutput.includes('done')) {
        status = 'default';
        extractedData._inferred = 'success_keywords';
      } else if (lowerOutput.includes('error') || lowerOutput.includes('failed')) {
        status = 'error';
        extractedData._inferred = 'error_keywords';
      }
    }

    console.log(`[ResultParser] Fallback parsing for ${stageId}: status=${status}`);

    return {
      status,
      data: extractedData,
      raw: output,
      parsed: false
    };
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

console.log('\n=== ResultParser Unit Tests ===\n');

console.log('Test 1: Parse structured result with markers\n');

test('Parses simple status', () => {
  const parser = new ResultParser();
  const output = `
Some agent output here
---RESULT---
status: success
ticket_id: IMPL-001
---RESULT---
More output
`;
  const result = parser.parse(output, 'test-stage');

  assertEqual(result.status, 'success', 'Status should be extracted');
  assertEqual(result.data.ticket_id, 'IMPL-001', 'Ticket ID should be extracted');
  assertTrue(result.parsed, 'Should be marked as parsed');
});

test('Parses multiple data fields', () => {
  const parser = new ResultParser();
  const output = `
---RESULT---
status: done
ticket_id: IMPL-002
report_id: RPT-001
issues: none
---RESULT---
`;
  const result = parser.parse(output, 'test-stage');

  assertEqual(result.status, 'done');
  assertEqual(result.data.ticket_id, 'IMPL-002');
  assertEqual(result.data.report_id, 'RPT-001');
  assertEqual(result.data.issues, 'none');
});

test('Returns default status when no status field', () => {
  const parser = new ResultParser();
  const output = `
---RESULT---
ticket_id: IMPL-003
data: some_value
---RESULT---
`;
  const result = parser.parse(output, 'test-stage');

  assertEqual(result.status, 'default', 'Should return default status');
  assertEqual(result.data.ticket_id, 'IMPL-003');
});

test('Handles empty result block', () => {
  const parser = new ResultParser();
  const output = `
---RESULT---
---RESULT---
`;
  const result = parser.parse(output, 'test-stage');

  assertEqual(result.status, 'default');
  assertEqual(Object.keys(result.data).length, 0);
});

console.log('\nTest 2: Fallback parsing without markers\n');

test('Parses status from unstructured output', () => {
  const parser = new ResultParser();
  const output = `
Agent is processing...
Processing complete.
status: success
Ticket IMPL-004 has been executed.
`;
  const result = parser.parse(output, 'test-stage');

  assertEqual(result.status, 'success');
  assertTrue(!result.parsed, 'Should be marked as not parsed (fallback)');
});

test('Extracts data after status in fallback mode', () => {
  const parser = new ResultParser();
  const output = `
Working on task...
status: done
ticket_id: IMPL-005
result: completed successfully
`;
  const result = parser.parse(output, 'test-stage');

  assertEqual(result.status, 'done');
  assertEqual(result.data.ticket_id, 'IMPL-005');
  assertEqual(result.data.result, 'completed successfully');
});

test('Infers success from keywords', () => {
  const parser = new ResultParser();
  const output = `
Task completed successfully.
All operations done.
`;
  const result = parser.parse(output, 'test-stage');

  assertEqual(result.status, 'default');
  assertEqual(result.data._inferred, 'success_keywords');
});

test('Infers error from keywords', () => {
  const parser = new ResultParser();
  const output = `
Processing failed with error.
Operation failed.
`;
  const result = parser.parse(output, 'test-stage');

  assertEqual(result.status, 'error');
  assertEqual(result.data._inferred, 'error_keywords');
});

test('Returns default for empty output', () => {
  const parser = new ResultParser();
  const output = '';
  const result = parser.parse(output, 'test-stage');

  assertEqual(result.status, 'default');
  assertEqual(Object.keys(result.data).length, 0);
});

console.log('\nTest 3: Edge cases\n');

test('Handles single marker (no closing)', () => {
  const parser = new ResultParser();
  const output = `
---RESULT---
status: success
No closing marker
`;
  const result = parser.parse(output, 'test-stage');

  // Should fall back to fallback parsing
  assertTrue(!result.parsed || result.status === 'default');
});

test('Handles multiple result blocks (uses first)', () => {
  const parser = new ResultParser();
  const output = `
---RESULT---
status: first
---RESULT---
Some text
---RESULT---
status: second
---RESULT---
`;
  const result = parser.parse(output, 'test-stage');

  assertEqual(result.status, 'first', 'Should use first result block');
});

test('Handles whitespace in result block', () => {
  const parser = new ResultParser();
  const output = `
---RESULT---
  status:   success
  ticket_id:   IMPL-006
---RESULT---
`;
  const result = parser.parse(output, 'test-stage');

  assertEqual(result.status, 'success');
  assertEqual(result.data.ticket_id, 'IMPL-006');
});

test('Case insensitive status matching in fallback', () => {
  const parser = new ResultParser();
  const output = `
STATUS: Done
Ticket processed
`;
  const result = parser.parse(output, 'test-stage');

  assertEqual(result.status, 'Done');
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
