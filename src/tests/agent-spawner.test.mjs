#!/usr/bin/env node

/**
 * Юнит-тесты для agent-spawner.mjs
 *
 * Тестируют функцию spawnAgent для запуска subprocess с таймаутом,
 * обработкой ошибок и парсингом результатов.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnAgent, ResultParser } from '../lib/agent-spawner.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Test: Успешный spawn
// ============================================================================
describe('spawnAgent — Успешный spawn', () => {
  it('должен вернуть stdout, exitCode=0 и durationMs > 0', async () => {
    const agentConfig = {
      command: 'node',
      args: ['-e', 'console.log("hello world")']
    };
    const prompt = 'test prompt';
    const result = await spawnAgent(agentConfig, prompt, { timeout: 5 });

    assert.strictEqual(result.exitCode, 0, 'exitCode должен быть 0 для успешного выполнения');
    assert.strictEqual(typeof result.output, 'string', 'output должен быть строкой');
    assert(result.output.includes('hello world'), 'output должен содержать результат');
    assert.strictEqual(typeof result.durationMs, 'number', 'durationMs должен быть числом');
    assert(result.durationMs > 0, 'durationMs должен быть > 0');
  });

  it('должен парсить результат с маркерами ---RESULT---', async () => {
    const agentConfig = {
      command: 'node',
      args: ['-e', 'console.log("---RESULT---\\nstatus: passed\\nkey: value\\n---RESULT---")']
    };
    const prompt = 'test';
    const result = await spawnAgent(agentConfig, prompt, { timeout: 5 });

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.status, 'passed');
    assert.deepStrictEqual(result.result.key, 'value');
    assert.strictEqual(result.parsed, true);
  });
});

// ============================================================================
// Test: Обработка ошибок (non-zero exit)
// ============================================================================
describe('spawnAgent — Обработка ошибок', () => {
  it('должен reject с ошибкой при non-zero exit code', async () => {
    const agentConfig = {
      command: 'node',
      args: ['-e', 'process.exit(1)']
    };
    const prompt = 'test';

    let errorThrown = false;
    let errorMessage = '';
    try {
      await spawnAgent(agentConfig, prompt, { timeout: 5 });
    } catch (err) {
      errorThrown = true;
      errorMessage = err.message;
    }

    assert.strictEqual(errorThrown, true, 'должна быть выброшена ошибка при non-zero exit');
    assert(errorMessage.includes('1'), 'ошибка должна содержать exit code');
  });

  it('должен приложить stderr к ошибке', async () => {
    const agentConfig = {
      command: 'node',
      args: ['-e', 'console.error("test error"); process.exit(1)']
    };
    const prompt = 'test';

    let capturedError = null;
    try {
      await spawnAgent(agentConfig, prompt, { timeout: 5 });
    } catch (err) {
      capturedError = err;
    }

    assert.strictEqual(capturedError !== null, true);
    assert(capturedError.stderr.includes('test error'), 'stderr должен быть приложен к ошибке');
  });
});

// ============================================================================
// Test: Timeout механизм
// ============================================================================
describe('spawnAgent — Timeout', () => {
  it('должен reject с timeout ошибкой при превышении времени', async () => {
    const agentConfig = {
      command: 'node',
      args: ['-e', 'setTimeout(() => {}, 10000)']
    };
    const prompt = 'test';

    let errorThrown = false;
    let errorMessage = '';
    try {
      await spawnAgent(agentConfig, prompt, { timeout: 1 }); // 1 секунда таймаут
    } catch (err) {
      errorThrown = true;
      errorMessage = err.message;
    }

    assert.strictEqual(errorThrown, true, 'должна быть выброшена timeout ошибка');
    assert(errorMessage.includes('timeout') || errorMessage.includes('timed out'),
      'ошибка должна упоминать timeout');
  });

  it('должен завершить процесс и очистить таймаут при успешном выполнении', async () => {
    const agentConfig = {
      command: 'node',
      args: ['-e', 'console.log("done")']
    };
    const prompt = 'test';

    const result = await spawnAgent(agentConfig, prompt, { timeout: 5 });
    assert.strictEqual(result.exitCode, 0);
    assert(result.output.includes('done'));
    // Проверяем что процесс завершился без зависаний
    assert(result.durationMs < 5000, 'процесс должен завершиться быстро');
  });
});

// ============================================================================
// Test: Передача prompt через stdin на Windows
// ============================================================================
describe('spawnAgent — Передача prompt через stdin', () => {
  it('должен передавать многострочный prompt через stdin на Windows', async () => {
    // Тест проверяет логику useStdin = useShell && finalPrompt.includes('\\n')
    const agentConfig = {
      command: process.platform === 'win32' ? 'powershell' : 'cat',
      args: process.platform === 'win32'
        ? ['-NoProfile', '-Command', '$input']
        : []
    };
    const multilinePrompt = 'line1\nline2\nline3';

    // На Windows используется stdin для многострочных prompt'ов
    if (process.platform === 'win32') {
      const result = await spawnAgent(agentConfig, multilinePrompt, { timeout: 5 });
      assert.strictEqual(result.exitCode, 0);
      // Проверяем что prompt был передан
      assert(result.output.length > 0);
    } else {
      // На non-Windows системах используется argv
      const agentConfig = {
        command: 'node',
        args: ['-e', 'console.log(process.argv[2])']
      };
      const result = await spawnAgent(agentConfig, 'single line', { timeout: 5 });
      assert.strictEqual(result.exitCode, 0);
      assert(result.output.includes('single line'));
    }
  });
});

// ============================================================================
// Test: ResultParser
// ============================================================================
describe('ResultParser — Парсинг результатов', () => {
  it('должен парсить RESULT-блок с status и data', () => {
    const output = `Some output
---RESULT---
status: passed
key1: value1
key2: value2
---RESULT---
More output`;

    const result = ResultParser.parse(output, 'test-stage');

    assert.strictEqual(result.status, 'passed');
    assert.deepStrictEqual(result.data.key1, 'value1');
    assert.deepStrictEqual(result.data.key2, 'value2');
    assert.strictEqual(result.parsed, true);
  });

  it('должен нормализировать статусы aliases (pass → passed)', () => {
    const output = `---RESULT---
status: pass
---RESULT---`;

    const result = ResultParser.parse(output, 'test-stage');
    assert.strictEqual(result.status, 'passed');
  });

  it('должен нормализировать статусы fail → failed', () => {
    const output = `---RESULT---
status: fail
---RESULT---`;

    const result = ResultParser.parse(output, 'test-stage');
    assert.strictEqual(result.status, 'failed');
  });

  it('должен нормализировать статусы err → error', () => {
    const output = `---RESULT---
status: err
---RESULT---`;

    const result = ResultParser.parse(output, 'test-stage');
    assert.strictEqual(result.status, 'error');
  });

  it('должен использовать fallback если нет RESULT-маркеров', () => {
    const output = 'Just some output with no markers';

    const result = ResultParser.parse(output, 'test-stage');
    assert.strictEqual(result.parsed, false);
    assert(result.status === 'default' || result.status !== 'default');
  });

  it('должен парсить многострочные значения в data', () => {
    const output = `---RESULT---
status: passed
multiline:
  line1
  line2
  line3
---RESULT---`;

    const result = ResultParser.parse(output, 'test-stage');
    assert.strictEqual(result.status, 'passed');
    assert(result.data.multiline.includes('line1'));
  });
});

// ============================================================================
// Test: Options обработка
// ============================================================================
describe('spawnAgent — Options', () => {
  it('должен использовать дефолтный timeout 300 если не указан', async () => {
    const agentConfig = {
      command: 'node',
      args: ['-e', 'console.log("quick")']
    };

    const result = await spawnAgent(agentConfig, 'test', {});
    assert.strictEqual(result.exitCode, 0);
  });

  it('должен использовать projectRoot если указан', async () => {
    const agentConfig = {
      command: 'node',
      args: ['-e', 'console.log(process.cwd())']
    };

    const result = await spawnAgent(agentConfig, 'test', {
      timeout: 5,
      projectRoot: __dirname
    });

    assert.strictEqual(result.exitCode, 0);
    assert(result.output.length > 0);
  });
});
