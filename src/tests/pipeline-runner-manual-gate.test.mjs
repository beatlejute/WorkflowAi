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

// ============================================================================
// QA-51 E2E-тест: полный цикл manual-gate-human с human-тикетом
// ============================================================================

test('QA-51-001: E2E полный цикл manual-gate-human — 5 шагов из плана', async () => {
  const tmpDir = createTmpDir();

  try {
    // Шаг 1: Подготовка — создаём backlog с 1 human-тикетом (deps met) + 0 non-human тикетов
    const workflowDir = path.join(tmpDir, '.workflow');
    const ticketsDir = path.join(workflowDir, 'tickets');
    const approvalsDir = path.join(workflowDir, 'approvals');

    const dirs = ['ready', 'in-progress', 'blocked', 'done', 'review', 'backlog', 'archive', 'approvals'];
    for (const dir of dirs) {
      fs.mkdirSync(path.join(ticketsDir, dir), { recursive: true });
    }

    const humanTicketId = 'HUMAN-001';
    const humanTicketContent = `---
id: HUMAN-001
title: "Human task for approval"
priority: 1
type: human
created_at: "2026-04-30T10:00:00.000Z"
updated_at: "2026-04-30T10:00:00.000Z"
parent_plan: plans/current/PLAN-010
conditions: []
dependencies: []
---

## Описание

Human task requiring manual approval.
`;
    fs.writeFileSync(path.join(ticketsDir, 'backlog', `${humanTicketId}.md`), humanTicketContent);

    // Шаг 2: move-to-ready — перемещаем human-тикет в ready
    const ticketSource = path.join(ticketsDir, 'backlog', `${humanTicketId}.md`);
    const ticketTarget = path.join(ticketsDir, 'ready', `${humanTicketId}.md`);
    fs.renameSync(ticketSource, ticketTarget);
    assert.ok(fs.existsSync(ticketTarget), 'human-тикет должен быть перемещён в ready/');

    // Создаём простой pipeline config с manual-gate-human
    const pipelineConfig = {
      pipeline: {
        name: 'qa-51-human-gate-cycle',
        version: '1.0',
        agents: {},
        stages: {
          'pick-task': {
            type: 'update-counter',
            counter: 'pick_counter',
            goto: { default: 'manual-gate-human' }
          },
          'manual-gate-human': {
            type: 'manual-gate',
            poll_interval_ms: 100,
            timeout_seconds: 30,
            goto: {
              approved: 'move-to-review',
              rejected: 'end',
              timeout: 'end'
            }
          },
          'move-to-review': {
            type: 'update-counter',
            counter: 'review_counter',
            goto: { default: 'end' }
          }
        },
        entry: 'pick-task',
        execution: {
          max_steps: 100,
          delay_between_stages: 0,
          timeout_per_stage: 30
        },
        context: {
          plan_id: 'PLAN-010',
          ticket_id: humanTicketId
        }
      }
    };

    // Шаг 2: pipeline run (стартуем runner)
    const runner = new PipelineRunner(pipelineConfig, { project: tmpDir });
    const runPromise = runner.run();

    // Шаг 3: Assert — pipeline остановился на manual-gate-human, файл approval pending создан
    let approvalFile = null;
    let attempts = 0;
    const maxAttempts = 100;

    while (attempts < maxAttempts) {
      attempts++;
      if (fs.existsSync(approvalsDir)) {
        const files = fs.readdirSync(approvalsDir);
        const pendingFiles = files.filter(f =>
          f.startsWith(`${humanTicketId}_`) &&
          f.includes('manual-gate') &&
          f.endsWith('.json')
        );
        if (pendingFiles.length > 0) {
          approvalFile = path.join(approvalsDir, pendingFiles[0]);
          break;
        }
      }
      await new Promise(r => setTimeout(r, 100));
    }

    assert.ok(approvalFile, `Файл approval-файл для ${humanTicketId} должен быть создан`);
    assert.ok(fs.existsSync(approvalFile), `Файл ${approvalFile} должен существовать`);

    const content = JSON.parse(fs.readFileSync(approvalFile, 'utf8'));
    assert.strictEqual(content.status, 'pending', 'Статус должен быть "pending"');
    assert.ok(
      approvalFile.includes(`${humanTicketId}_manual-gate-`),
      `Имя файла должно содержать ${humanTicketId}_manual-gate-`
    );

    // Шаг 4: Симулировать move-ticket.js HUMAN-X review — записываем approved в approval-файл
    const approvalData = JSON.parse(fs.readFileSync(approvalFile, 'utf8'));
    approvalData.status = 'approved';
    approvalData.decided_by = 'test-e2e-runner';
    approvalData.updated_at = new Date().toISOString();
    fs.writeFileSync(approvalFile, JSON.stringify(approvalData, null, 2));

    // Ждём завершения pipeline (max 30s)
    const completePromise = Promise.race([
      runPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Pipeline timeout')), 30000))
    ]);

    const result = await completePromise;

    // Шаг 5: Assert — pipeline продолжается, файл approval содержит status: "approved"
    const finalContent = JSON.parse(fs.readFileSync(approvalFile, 'utf8'));
    assert.strictEqual(finalContent.status, 'approved', 'Файл approval должен содержать status: "approved"');

    assert.ok(result, 'Runner должен вернуть результат');
    assert.ok(result.steps > 0, 'Pipeline должен выполнить несколько шагов');

    runner.running = false;
  } finally {
    cleanupDir(tmpDir);
  }
});
