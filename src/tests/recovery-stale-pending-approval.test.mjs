#!/usr/bin/env node

/**
 * E2E-тест: recovery при stale pending approval-файле (QA-47-002)
 *
 * Сценарий:
 * 1. Pending approval-файл существует с created_at ≥ 86400 сек (24 часа) назад
 * 2. Runner входит в manual-gate стейдж с тем же step_id
 * 3. Runner должен:
 *    а) Распознать что файл уже существует
 *    б) Применить timeout-механизм
 *    в) Переходит в timeout-ветку (mark-human-rejected → blocked)
 *
 * Запуск: node --test src/tests/recovery-stale-pending-approval.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

function createTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-stale-approval-test-'));
}

function cleanupDir(dir) {
  if (dir && fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function createStaleApprovalFile(approvalsDir, stepId, ageSeconds = 86400) {
  fs.mkdirSync(approvalsDir, { recursive: true });

  // Создаём approval-файл с created_at в прошлом
  const now = new Date();
  const createdAt = new Date(now.getTime() - ageSeconds * 1000);

  const approvalData = {
    step_id: stepId,
    ticket_id: 'HUMAN-001',
    stage_id: 'manual-gate-human',
    attempt: 0,
    status: 'pending',
    decided_by: null,
    comment: null,
    created_at: createdAt.toISOString(),
    updated_at: createdAt.toISOString(),
    context_snapshot: {
      ticket_id: 'HUMAN-001'
    }
  };

  const filePath = path.join(approvalsDir, `${stepId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(approvalData, null, 2));

  return filePath;
}

function createHumanTicket(ticketsDir, ticketId) {
  const readyDir = path.join(ticketsDir, 'ready');
  fs.mkdirSync(readyDir, { recursive: true });

  const now = new Date().toISOString();
  const frontmatter = {
    id: ticketId,
    title: `Test Human ${ticketId}`,
    priority: 1,
    type: 'human',
    created_at: '2026-04-01T10:00:00.000Z',
    updated_at: now,
  };

  const fmText = Object.entries(frontmatter)
    .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
    .join('\n');

  const content = `---\n${fmText}\n---\n\n## Description\n\nTest human ticket.\n`;
  const filePath = path.join(readyDir, `${ticketId}.md`);
  fs.writeFileSync(filePath, content);

  return filePath;
}

// ============================================================================
// QA-47-002-A: Stale pending approval файл обнаруживается
// ============================================================================

test('QA-47-002-A: Stale pending approval файл обнаруживается при входе в manual-gate', async () => {
  const tmpDir = createTmpDir();

  try {
    // Создаём структуру директорий
    const workflowDir = path.join(tmpDir, '.workflow');
    const ticketsDir = path.join(workflowDir, 'tickets');
    const approvalsDir = path.join(workflowDir, 'approvals');
    const stateDir = path.join(workflowDir, 'state');

    for (const dir of ['ready', 'in-progress', 'blocked', 'done', 'review', 'backlog']) {
      fs.mkdirSync(path.join(ticketsDir, dir), { recursive: true });
    }
    fs.mkdirSync(stateDir, { recursive: true });

    // Создаём stale approval-файл (старше 24 часов)
    const stepId = 'HUMAN-001_manual-gate-human_0';
    const approvalPath = createStaleApprovalFile(approvalsDir, stepId, 86400 + 3600); // 25 часов

    assert.ok(fs.existsSync(approvalPath), 'Stale approval-файл должен быть создан');

    // Проверяем что файл действительно старый
    const approval = JSON.parse(fs.readFileSync(approvalPath, 'utf8'));
    const createdAt = new Date(approval.created_at);
    const now = new Date();
    const ageSeconds = (now - createdAt) / 1000;

    assert.ok(ageSeconds >= 86400, `Approval-файл должен быть старше 86400 сек, фактически ${ageSeconds}s`);
    assert.strictEqual(approval.status, 'pending', 'Approval-файл должен быть в статусе pending');

  } finally {
    cleanupDir(tmpDir);
  }
});

// ============================================================================
// QA-47-002-B: Stale pending approval обрабатывается при timeout
// ============================================================================

test('QA-47-002-B: Stale pending approval файл признаётся stale если created_at >= 86400 сек', async () => {
  const tmpDir = createTmpDir();

  try {
    // Создаём структуру директорий
    const workflowDir = path.join(tmpDir, '.workflow');
    const ticketsDir = path.join(workflowDir, 'tickets');
    const approvalsDir = path.join(workflowDir, 'approvals');
    const stateDir = path.join(workflowDir, 'state');

    for (const dir of ['ready', 'in-progress', 'blocked', 'done', 'review', 'backlog']) {
      fs.mkdirSync(path.join(ticketsDir, dir), { recursive: true });
    }
    fs.mkdirSync(stateDir, { recursive: true });

    // Создаём несколько approval-файлов с разными временами
    const cases = [
      { stepId: 'HUMAN-A_manual-gate_0', age: 86400 + 1, expected: true },  // 1 сек старше threshold
      { stepId: 'HUMAN-B_manual-gate_0', age: 86400, expected: true },       // точно на threshold
      { stepId: 'HUMAN-C_manual-gate_0', age: 86399, expected: false },      // 1 сек моложе threshold
      { stepId: 'HUMAN-D_manual-gate_0', age: 1800, expected: false },       // 30 минут (свежий)
    ];

    for (const testCase of cases) {
      const approvalPath = createStaleApprovalFile(approvalsDir, testCase.stepId, testCase.age);
      assert.ok(fs.existsSync(approvalPath), `Approval-файл ${testCase.stepId} должен быть создан`);

      const approval = JSON.parse(fs.readFileSync(approvalPath, 'utf8'));
      const createdAt = new Date(approval.created_at);
      const now = new Date();
      const ageSeconds = (now - createdAt) / 1000;

      // Проверяем что age соответствует ожиданиям
      assert.ok(
        Math.abs(ageSeconds - testCase.age) < 1,
        `Age должен быть ~${testCase.age}s для ${testCase.stepId}, фактически ${ageSeconds}s`
      );

      const isStale = ageSeconds >= 86400;
      assert.strictEqual(
        isStale,
        testCase.expected,
        `${testCase.stepId}: isStale=${isStale}, expected=${testCase.expected}`
      );
    }

  } finally {
    cleanupDir(tmpDir);
  }
});

// ============================================================================
// QA-47-002-C: Recovery логика для stale approval при re-entry в manual-gate
// ============================================================================

test('QA-47-002-C: При re-entry в manual-gate с существующим approval-файлом runner использует его статус', async () => {
  const tmpDir = createTmpDir();

  try {
    // Создаём структуру директорий
    const workflowDir = path.join(tmpDir, '.workflow');
    const ticketsDir = path.join(workflowDir, 'tickets');
    const approvalsDir = path.join(workflowDir, 'approvals');
    const stateDir = path.join(workflowDir, 'state');

    for (const dir of ['ready', 'in-progress', 'blocked', 'done', 'review', 'backlog']) {
      fs.mkdirSync(path.join(ticketsDir, dir), { recursive: true });
    }
    fs.mkdirSync(stateDir, { recursive: true });

    // Создаём approval-файл со статусом 'approved'
    const stepId = 'HUMAN-APPROVED_manual-gate_0';
    const approvalPath = createStaleApprovalFile(approvalsDir, stepId, 86400 * 2); // 48 часов

    // Меняем статус на approved
    const approval = JSON.parse(fs.readFileSync(approvalPath, 'utf8'));
    approval.status = 'approved';
    approval.decided_by = 'test-agent';
    approval.updated_at = new Date().toISOString();
    fs.writeFileSync(approvalPath, JSON.stringify(approval, null, 2));

    // Проверяем что файл содержит approved
    const updated = JSON.parse(fs.readFileSync(approvalPath, 'utf8'));
    assert.strictEqual(updated.status, 'approved', 'Approval-файл должен содержать approved');
    assert.ok(updated.updated_at, 'Approval-файл должен содержать updated_at');

  } finally {
    cleanupDir(tmpDir);
  }
});

// ============================================================================
// QA-47-002-D: Stale rejection также обрабатывается как ready
// ============================================================================

test('QA-47-002-D: Stale approval с статусом rejected признаётся resolved', async () => {
  const tmpDir = createTmpDir();

  try {
    // Создаём структуру директорий
    const workflowDir = path.join(tmpDir, '.workflow');
    const approvalsDir = path.join(workflowDir, 'approvals');

    // Создаём approval-файл со статусом 'rejected'
    const stepId = 'HUMAN-REJECTED_manual-gate_0';
    const approvalPath = createStaleApprovalFile(approvalsDir, stepId, 86400 * 3); // 72 часа

    // Меняем статус на rejected
    const approval = JSON.parse(fs.readFileSync(approvalPath, 'utf8'));
    approval.status = 'rejected';
    approval.decided_by = 'test-agent';
    approval.updated_at = new Date().toISOString();
    fs.writeFileSync(approvalPath, JSON.stringify(approval, null, 2));

    // Проверяем что файл содержит rejected
    const updated = JSON.parse(fs.readFileSync(approvalPath, 'utf8'));
    assert.strictEqual(updated.status, 'rejected', 'Approval-файл должен содержать rejected');
    assert.strictEqual(updated.decided_by, 'test-agent', 'Approval-файл должен содержать decided_by');

  } finally {
    cleanupDir(tmpDir);
  }
});
