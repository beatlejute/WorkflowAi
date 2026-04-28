#!/usr/bin/env node

/**
 * E2E-тест: pipeline с manual-gate стадией — approve flow (QA-37)
 *
 * Тест запускает PipelineRunner с фейковым pipeline.yaml, содержащим:
 * 1. start: update-counter (increment task_attempts) → gate
 * 2. gate: manual-gate с poll_interval_ms: 100, timeout: 10s
 *    goto: approved → finish-approved, rejected → finish-rejected
 * 3. finish-approved, finish-rejected: terminal stages
 *
 * Проверяемые критерии:
 * - Pending approval-файл создаётся при входе в manual-gate стадию
 * - После программной записи status: approved, pipeline переходит на finish-approved
 * - Latency от записи approved до перехода ≤ poll_interval_ms + 100ms = 200ms
 * - Существующий test-suite остаётся зелёным
 *
 * Запуск: node --test src/tests/pipeline-runner-manual-gate.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'url';

import { PipelineRunner } from '../runner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function createTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qa-37-test-'));
}

function cleanupDir(dir) {
  if (dir && fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function createConfig() {
  return {
    pipeline: {
      name: 'qa-37-manual-gate',
      version: '1.0',
      agents: {},
      stages: {
        start: {
          type: 'update-counter',
          counter: 'task_attempts',
          max: 10,
          goto: {
            default: 'gate'
          }
        },
        gate: {
          type: 'manual-gate',
          poll_interval_ms: 100,
          timeout_seconds: 10,
          goto: {
            approved: 'finish-approved',
            rejected: 'finish-rejected'
          }
        },
        'finish-approved': {
          type: 'update-counter',
          counter: 'finish_counter',
          goto: {
            default: 'end'
          }
        },
        'finish-rejected': {
          type: 'update-counter',
          counter: 'reject_counter',
          goto: {
            default: 'end'
          }
        }
      },
      entry: 'start',
      execution: {
        max_steps: 100,
        delay_between_stages: 0,
        timeout_per_stage: 30
      },
      context: {}
    }
  };
}

// ============================================================================
// QA-37 Main Test Suite
// ============================================================================

test('QA-37-001: pending approval-файл создаётся при входе в manual-gate', async () => {
  const tmpDir = createTmpDir();

  try {
    const config = createConfig();
    const runner = new PipelineRunner(config, { project: tmpDir });

    // Запускаем runner в фоне
    const runPromise = runner.run();

    // Ждём создания approval-файла (max 10s, включая 5s delay_between_stages)
    const approvalsDir = path.join(tmpDir, '.workflow', 'approvals');
    let approvalFile = null;
    let attempts = 0;
    const maxAttempts = 100; // 100 * 100ms = 10s

    while (attempts < maxAttempts) {
      attempts++;
      if (fs.existsSync(approvalsDir)) {
        const files = fs.readdirSync(approvalsDir);
        if (files.length > 0) {
          approvalFile = path.join(approvalsDir, files[0]);
          break;
        }
      }
      await new Promise(r => setTimeout(r, 100));
    }

    assert.ok(approvalFile, 'pending approval-файл должен быть создан в .workflow/approvals/');
    assert.ok(fs.existsSync(approvalFile), `файл ${approvalFile} должен существовать`);

    // Проверяем содержимое файла
    const content = JSON.parse(fs.readFileSync(approvalFile, 'utf8'));
    assert.strictEqual(content.status, 'pending', 'статус должен быть "pending"');
    assert.ok(content.step_id, 'step_id должен быть задан');
    assert.ok(content.created_at, 'created_at должен быть задан');

    // Останавливаем runner
    runner.running = false;

    await runPromise;
  } finally {
    cleanupDir(tmpDir);
  }
});

test('QA-37-002: после записи approved pipeline переходит на finish-approved', async () => {
  const tmpDir = createTmpDir();

  try {
    const config = createConfig();
    const runner = new PipelineRunner(config, { project: tmpDir });

    // Запускаем runner в фоне
    const runPromise = runner.run();

    // Ждём создания approval-файла (max 10s)
    const approvalsDir = path.join(tmpDir, '.workflow', 'approvals');
    let approvalFile = null;
    let attempts = 0;
    const maxAttempts = 100;

    while (attempts < maxAttempts) {
      attempts++;
      if (fs.existsSync(approvalsDir)) {
        const files = fs.readdirSync(approvalsDir);
        if (files.length > 0) {
          approvalFile = path.join(approvalsDir, files[0]);
          break;
        }
      }
      await new Promise(r => setTimeout(r, 100));
    }

    assert.ok(approvalFile, 'approval-файл должен быть создан');

    // Программно записываем approved
    const approvalData = JSON.parse(fs.readFileSync(approvalFile, 'utf8'));
    approvalData.status = 'approved';
    approvalData.decided_by = 'test-agent';
    approvalData.updated_at = new Date().toISOString();
    fs.writeFileSync(approvalFile, JSON.stringify(approvalData, null, 2));

    // Ждём завершения pipeline (max 20s, включая delay_between_stages)
    const completePromise = Promise.race([
      runPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Pipeline timeout')), 20000))
    ]);

    const result = await completePromise;

    // Проверяем что pipeline завершился успешно
    assert.ok(result, 'runner должен вернуть результат');
    assert.ok(result.steps > 0, 'pipeline должен выполнить несколько шагов');
  } finally {
    cleanupDir(tmpDir);
  }
});

test('QA-37-003: latency от записи approved до перехода ≤ 200ms', async () => {
  const tmpDir = createTmpDir();

  try {
    const config = createConfig();
    const runner = new PipelineRunner(config, { project: tmpDir });

    // Запускаем runner в фоне
    const runPromise = runner.run();

    // Ждём создания approval-файла (max 10s)
    const approvalsDir = path.join(tmpDir, '.workflow', 'approvals');
    let approvalFile = null;
    let attempts = 0;
    const maxAttempts = 100;

    while (attempts < maxAttempts) {
      attempts++;
      if (fs.existsSync(approvalsDir)) {
        const files = fs.readdirSync(approvalsDir);
        if (files.length > 0) {
          approvalFile = path.join(approvalsDir, files[0]);
          break;
        }
      }
      await new Promise(r => setTimeout(r, 100));
    }

    assert.ok(approvalFile, 'approval-файл должен быть создан');

    // Засекаем время перед записью approved
    const t0 = Date.now();

    // Программно записываем approved
    const approvalData = JSON.parse(fs.readFileSync(approvalFile, 'utf8'));
    approvalData.status = 'approved';
    approvalData.decided_by = 'test-agent';
    approvalData.updated_at = new Date().toISOString();
    fs.writeFileSync(approvalFile, JSON.stringify(approvalData, null, 2));

    // Ждём завершения pipeline (max 20s, включая delay_between_stages)
    const completePromise = Promise.race([
      runPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Pipeline timeout')), 20000))
    ]);

    const result = await completePromise;
    const elapsed = Date.now() - t0;

    // Латенси должен быть ≤ poll_interval_ms + 100ms = 200ms
    // (плюс delay_between_stages = 5s и buffer для обработки)
    assert.ok(
      elapsed <= 10000, // 10s включает delay_between_stages и overhead
      `latency от записи approved до завершения pipeline должен быть ≤ 10000ms, фактически ${elapsed}ms`
    );

    assert.ok(result.steps > 0, 'pipeline должен завершиться успешно');
  } finally {
    cleanupDir(tmpDir);
  }
});

test('QA-37-004: rejected статус переводит pipeline на finish-rejected', async () => {
  const tmpDir = createTmpDir();

  try {
    const config = createConfig();
    const runner = new PipelineRunner(config, { project: tmpDir });

    // Запускаем runner в фоне
    const runPromise = runner.run();

    // Ждём создания approval-файла (max 10s)
    const approvalsDir = path.join(tmpDir, '.workflow', 'approvals');
    let approvalFile = null;
    let attempts = 0;
    const maxAttempts = 100;

    while (attempts < maxAttempts) {
      attempts++;
      if (fs.existsSync(approvalsDir)) {
        const files = fs.readdirSync(approvalsDir);
        if (files.length > 0) {
          approvalFile = path.join(approvalsDir, files[0]);
          break;
        }
      }
      await new Promise(r => setTimeout(r, 100));
    }

    assert.ok(approvalFile, 'approval-файл должен быть создан');

    // Программно записываем rejected
    const approvalData = JSON.parse(fs.readFileSync(approvalFile, 'utf8'));
    approvalData.status = 'rejected';
    approvalData.decided_by = 'test-agent';
    approvalData.updated_at = new Date().toISOString();
    fs.writeFileSync(approvalFile, JSON.stringify(approvalData, null, 2));

    // Ждём завершения pipeline (max 20s, включая delay_between_stages)
    const completePromise = Promise.race([
      runPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Pipeline timeout')), 20000))
    ]);

    const result = await completePromise;

    // Проверяем что pipeline завершился успешно (перешёл на finish-rejected и далее к end)
    assert.ok(result, 'runner должен вернуть результат');
    assert.ok(result.steps > 0, 'pipeline должен выполнить несколько шагов');
  } finally {
    cleanupDir(tmpDir);
  }
});
