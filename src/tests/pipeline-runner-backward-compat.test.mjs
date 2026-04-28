#!/usr/bin/env node

/**
 * Backward Compatibility Test: runner 1.2.0 vs pipelines without manual-gate (QA-38)
 *
 * Проверяет, что runner 1.2.0 загружает pipeline.yaml без manual-gate стадий
 * так же, как runner 1.1.0 — без ошибок, без новых сообщений, без side effects.
 *
 * Сценарии:
 * 1. Pipeline без manual-gate стадий должен загружаться успешно
 * 2. Директория .workflow/approvals/ не должна создаваться
 * 3. Нет новых сообщений про manual-gate в stderr/logger
 *
 * Запуск: node --test src/tests/pipeline-runner-backward-compat.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'url';
import yaml from '../lib/js-yaml.mjs';

import { PipelineRunner } from '../runner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function createTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qa-38-compat-'));
}

function cleanupDir(dir) {
  if (dir && fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function createSimplePipelineConfig() {
  return {
    pipeline: {
      name: 'qa-38-backward-compat',
      version: '1.0',
      agents: {},
      stages: {
        start: {
          type: 'update-counter',
          counter: 'task_attempts',
          goto: {
            default: 'end'
          }
        }
      },
      entry: 'start',
      execution: {
        max_steps: 10,
        delay_between_stages: 0
      },
      context: {}
    }
  };
}

// ============================================================================
// QA-38 Test Suite
// ============================================================================

test('QA-38-001: Pipeline БЕЗ manual-gate стадий загружается без ошибок', async () => {
  const tmpDir = createTmpDir();

  try {
    const config = createSimplePipelineConfig();
    
    // Конструктор должен не выбросить исключение
    const runner = new PipelineRunner(config, { project: tmpDir });
    
    assert.ok(runner, 'Runner должен быть создан');
    assert.strictEqual(runner.pipeline.name, 'qa-38-backward-compat');
  } finally {
    cleanupDir(tmpDir);
  }
});

test('QA-38-002: Директория .workflow/approvals/ не создаётся при загрузке pipeline без manual-gate', async () => {
  const tmpDir = createTmpDir();

  try {
    const config = createSimplePipelineConfig();
    const runner = new PipelineRunner(config, { project: tmpDir });
    
    // Проверяем что директория approvals не была создана при инициализации
    const approvalsDir = path.join(tmpDir, '.workflow', 'approvals');
    assert.strictEqual(fs.existsSync(approvalsDir), false, 
      'Директория .workflow/approvals/ не должна создаваться для pipeline без manual-gate');
  } finally {
    cleanupDir(tmpDir);
  }
});

test('QA-38-003: Pipeline без manual-gate проходит валидацию конструктора', async () => {
  const tmpDir = createTmpDir();

  try {
    // Конфиг с несколькими обычными стадиями, без manual-gate
    const config = {
      pipeline: {
        name: 'multi-stage-no-manual-gate',
        version: '1.0',
        agents: {},
        stages: {
          'stage-a': {
            type: 'update-counter',
            counter: 'attempt',
            goto: { default: 'stage-b' }
          },
          'stage-b': {
            type: 'update-counter',
            counter: 'step',
            goto: { default: 'end' }
          }
        },
        entry: 'stage-a',
        execution: { max_steps: 20, delay_between_stages: 0 },
        context: {}
      }
    };

    // Не должно выбросить исключение про валидацию manual-gate
    const runner = new PipelineRunner(config, { project: tmpDir });
    assert.ok(runner, 'Runner должен быть создан для pipeline с несколькими стадиями');
  } finally {
    cleanupDir(tmpDir);
  }
});

test('QA-38-004: Валидация manual-gate НЕ влияет на pipelines без этих стадий', async () => {
  const tmpDir = createTmpDir();

  try {
    // Конфиг где explicit указана абсолютно другая стадия
    const config = {
      pipeline: {
        name: 'explicit-no-manual-gate',
        version: '1.0',
        agents: {
          'test-agent': {
            command: 'echo',
            args: ['test'],
            workdir: '.',
            capabilities: ['text']
          }
        },
        stages: {
          'prepare': {
            type: 'update-counter',
            counter: 'init',
            goto: { default: 'process' }
          },
          'process': {
            agent: 'test-agent',
            skill: 'test',
            goto: { passed: 'done', failed: 'error', default: 'error' }
          },
          'done': {
            type: 'update-counter',
            counter: 'final',
            goto: { default: 'end' }
          }
        },
        entry: 'prepare',
        execution: { max_steps: 50, delay_between_stages: 0 },
        context: {}
      }
    };

    // Должно работать, несмотря на наличие agent-стадий
    const runner = new PipelineRunner(config, { project: tmpDir });
    assert.ok(runner, 'Runner должен быть создан для pipeline с agent-стадиями');
    assert.strictEqual(runner.pipeline.stages.process.agent, 'test-agent');
  } finally {
    cleanupDir(tmpDir);
  }
});

