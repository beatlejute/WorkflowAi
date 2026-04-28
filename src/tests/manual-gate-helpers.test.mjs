#!/usr/bin/env node

/**
 * Юнит-тесты для helper-функций manual-gate:
 * - computeStepId: детерминированность и крайние случаи
 * - writeApprovalPending: создание файла, idempotency
 * - readApprovalFile: корректная обработка corrupt JSON
 * - executeManualGate: recovery при уже approved/rejected
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { PipelineRunner } from '../runner.mjs';

function createTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mg-test-'));
}

function createMinimalRunner(tmpDir, overrides = {}) {
  const runner = Object.create(PipelineRunner.prototype);
  runner.context = overrides.context || { ticket_id: 'QA-12' };
  runner.counters = overrides.counters || { task_attempts: 0 };
  runner.projectRoot = tmpDir;
  runner.running = true;
  runner.logger = null;
  return runner;
}

// ============================================================================
// computeStepId
// ============================================================================
describe('computeStepId', () => {
  const runner = Object.create(PipelineRunner.prototype);

  it('should return correct step_id with ticket_id present', () => {
    const result = runner.computeStepId(
      { ticket_id: 'QA-12' },
      'manual-approve',
      { task_attempts: 0 }
    );
    assert.strictEqual(result, 'QA-12_manual-approve_0');
  });

  it('should use "no-ticket" fallback when ticket_id is undefined', () => {
    const result = runner.computeStepId(
      { ticket_id: undefined },
      'gate',
      { task_attempts: 2 }
    );
    assert.strictEqual(result, 'no-ticket_gate_2');
  });

  it('should default task_attempts to 0 when undefined', () => {
    const result = runner.computeStepId(
      { ticket_id: 'IMPL-55' },
      'deploy',
      {}
    );
    assert.strictEqual(result, 'IMPL-55_deploy_0');
  });

  it('should use empty string ticket_id as "no-ticket"', () => {
    const result = runner.computeStepId(
      { ticket_id: '' },
      'review',
      { task_attempts: 1 }
    );
    assert.strictEqual(result, 'no-ticket_review_1');
  });
});

// ============================================================================
// writeApprovalPending — создание нового файла
// ============================================================================
describe('writeApprovalPending — new file creation', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should create file with status=pending and required fields', async () => {
    const runner = createMinimalRunner(tmpDir);
    const filePath = path.join(tmpDir, 'approvals', 'QA-12_gate_0.json');

    const payload = {
      step_id: 'QA-12_gate_0',
      ticket_id: 'QA-12',
      stage_id: 'gate',
      attempt: 0,
      context_snapshot: { ticket_id: 'QA-12', task_type: 'qa' }
    };

    const result = await runner.writeApprovalPending(filePath, payload);

    assert.strictEqual(result.status, 'pending');
    assert.strictEqual(result.step_id, 'QA-12_gate_0');
    assert.strictEqual(result.ticket_id, 'QA-12');
    assert.strictEqual(result.stage_id, 'gate');
    assert.strictEqual(result.attempt, 0);
    assert.strictEqual(result.decided_by, null);
    assert.strictEqual(result.comment, null);
    assert.ok(result.created_at);
    assert.ok(result.updated_at);

    assert.ok(fs.existsSync(filePath), 'approval file should exist on disk');

    const diskContent = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.strictEqual(diskContent.status, 'pending');
    assert.strictEqual(diskContent.step_id, 'QA-12_gate_0');
  });
});

// ============================================================================
// writeApprovalPending — idempotency
// ============================================================================
describe('writeApprovalPending — idempotency', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should NOT overwrite existing file — content preserved after second call', async () => {
    const runner = createMinimalRunner(tmpDir);
    const filePath = path.join(tmpDir, 'approvals', 'QA-12_gate_0.json');

    const payload = {
      step_id: 'QA-12_gate_0',
      ticket_id: 'QA-12',
      stage_id: 'gate',
      attempt: 0
    };

    await runner.writeApprovalPending(filePath, payload);

    const originalContent = fs.readFileSync(filePath, 'utf8');

    await runner.writeApprovalPending(filePath, payload);

    const contentAfterSecondCall = fs.readFileSync(filePath, 'utf8');

    assert.strictEqual(
      contentAfterSecondCall,
      originalContent,
      'file content must be identical after second writeApprovalPending call'
    );
  });

  it('should return existing content when file already exists', async () => {
    const runner = createMinimalRunner(tmpDir);
    const filePath = path.join(tmpDir, 'approvals', 'QA-12_gate_0.json');

    const payload = {
      step_id: 'QA-12_gate_0',
      ticket_id: 'QA-12',
      stage_id: 'gate',
      attempt: 0
    };

    await runner.writeApprovalPending(filePath, payload);

    const existingData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    existingData.status = 'approved';
    existingData.decided_by = 'admin';
    fs.writeFileSync(filePath, JSON.stringify(existingData, null, 2));

    const result = await runner.writeApprovalPending(filePath, payload);

    assert.strictEqual(result.status, 'approved');
    assert.strictEqual(result.decided_by, 'admin');
  });
});

// ============================================================================
// readApprovalFile — corrupt JSON
// ============================================================================
describe('readApprovalFile — corrupt JSON', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should throw Error with "corrupt approval file at" and path in message', async () => {
    const runner = createMinimalRunner(tmpDir);
    const filePath = path.join(tmpDir, 'corrupt.json');

    fs.writeFileSync(filePath, '{ invalid json !!!');

    await assert.rejects(
      () => runner.readApprovalFile(filePath),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes('corrupt approval file at'),
          `message should contain "corrupt approval file at", got: "${err.message}"`
        );
        assert.ok(
          err.message.includes(filePath),
          `message should contain file path, got: "${err.message}"`
        );
        return true;
      }
    );
  });

  it('should return null for non-existent file', async () => {
    const runner = createMinimalRunner(tmpDir);
    const filePath = path.join(tmpDir, 'nonexistent.json');

    const result = await runner.readApprovalFile(filePath);
    assert.strictEqual(result, null);
  });

  it('should return parsed object for valid JSON', async () => {
    const runner = createMinimalRunner(tmpDir);
    const filePath = path.join(tmpDir, 'valid.json');
    const data = { status: 'approved', decided_by: 'admin' };

    fs.writeFileSync(filePath, JSON.stringify(data));

    const result = await runner.readApprovalFile(filePath);
    assert.strictEqual(result.status, 'approved');
    assert.strictEqual(result.decided_by, 'admin');
  });
});

// ============================================================================
// executeManualGate — recovery (already approved)
// ============================================================================
describe('executeManualGate — recovery (already approved)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return {status: "approved"} immediately without polling when file is already approved', async () => {
    const runner = createMinimalRunner(tmpDir);
    const approvalsDir = path.join(tmpDir, '.workflow', 'approvals');
    fs.mkdirSync(approvalsDir, { recursive: true });

    const stepId = 'QA-12_manual-approve_0';
    const filePath = path.join(approvalsDir, `${stepId}.json`);

    const approvedData = {
      step_id: stepId,
      ticket_id: 'QA-12',
      stage_id: 'manual-approve',
      attempt: 0,
      status: 'approved',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      decided_by: 'admin-user',
      comment: 'LGTM'
    };
    fs.writeFileSync(filePath, JSON.stringify(approvedData, null, 2));

    const startTime = Date.now();

    const result = await runner.executeManualGate('manual-approve', {
      type: 'manual-gate',
      poll_interval_ms: 2000,
      goto: { approved: 'next', rejected: 'rollback' }
    });

    const elapsed = Date.now() - startTime;

    assert.strictEqual(result.status, 'approved');
    assert.strictEqual(result.result.step_id, stepId);
    assert.strictEqual(result.result.decided_by, 'admin-user');
    assert.strictEqual(result.result.comment, 'LGTM');
    assert.ok(elapsed < 100, `should return within 100ms (recovery path), took ${elapsed}ms`);
  });

  it('should return {status: "rejected"} immediately when file is already rejected', async () => {
    const runner = createMinimalRunner(tmpDir);
    const approvalsDir = path.join(tmpDir, '.workflow', 'approvals');
    fs.mkdirSync(approvalsDir, { recursive: true });

    const stepId = 'QA-12_gate_0';
    const filePath = path.join(approvalsDir, `${stepId}.json`);

    const rejectedData = {
      step_id: stepId,
      ticket_id: 'QA-12',
      stage_id: 'gate',
      attempt: 0,
      status: 'rejected',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      decided_by: 'reviewer',
      comment: 'needs rework'
    };
    fs.writeFileSync(filePath, JSON.stringify(rejectedData, null, 2));

    const result = await runner.executeManualGate('gate', {
      type: 'manual-gate',
      poll_interval_ms: 2000,
      goto: { approved: 'next', rejected: 'rollback' }
    });

    assert.strictEqual(result.status, 'rejected');
    assert.strictEqual(result.result.step_id, stepId);
    assert.strictEqual(result.result.decided_by, 'reviewer');
    assert.strictEqual(result.result.comment, 'needs rework');
  });
});

// ============================================================================
// executeManualGate — approved (with polling)
// ============================================================================
describe('executeManualGate — approved (with polling)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return {status: "approved"} with correct data when file is updated during polling', async () => {
    const runner = createMinimalRunner(tmpDir);
    const approvalsDir = path.join(tmpDir, '.workflow', 'approvals');
    fs.mkdirSync(approvalsDir, { recursive: true });

    const stepId = 'QA-12_approve_0';
    const filePath = path.join(approvalsDir, `${stepId}.json`);

    // Start polling, then update file after first iteration
    const updateTimeout = setTimeout(() => {
      const approvedData = {
        step_id: stepId,
        ticket_id: 'QA-12',
        stage_id: 'approve',
        attempt: 0,
        status: 'approved',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        decided_by: 'test-user',
        comment: 'LGTM'
      };
      fs.writeFileSync(filePath, JSON.stringify(approvedData, null, 2));
    }, 75); // Update after first poll (50ms) + some margin

    try {
      const result = await runner.executeManualGate('approve', {
        type: 'manual-gate',
        poll_interval_ms: 50,
        goto: { approved: 'next', rejected: 'rollback' }
      });

      assert.strictEqual(result.status, 'approved');
      assert.strictEqual(result.result.step_id, stepId);
      assert.strictEqual(result.result.decided_by, 'test-user');
      assert.strictEqual(result.result.comment, 'LGTM');
    } finally {
      clearTimeout(updateTimeout);
    }
  });
});

// ============================================================================
// executeManualGate — rejected (with polling)
// ============================================================================
describe('executeManualGate — rejected (with polling)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return {status: "rejected"} with correct data when file is updated during polling', async () => {
    const runner = createMinimalRunner(tmpDir);
    const approvalsDir = path.join(tmpDir, '.workflow', 'approvals');
    fs.mkdirSync(approvalsDir, { recursive: true });

    const stepId = 'QA-12_review_0';
    const filePath = path.join(approvalsDir, `${stepId}.json`);

    // Start polling, then update file after first iteration
    const updateTimeout = setTimeout(() => {
      const rejectedData = {
        step_id: stepId,
        ticket_id: 'QA-12',
        stage_id: 'review',
        attempt: 0,
        status: 'rejected',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        decided_by: 'reviewer',
        comment: 'needs rework'
      };
      fs.writeFileSync(filePath, JSON.stringify(rejectedData, null, 2));
    }, 75);

    try {
      const result = await runner.executeManualGate('review', {
        type: 'manual-gate',
        poll_interval_ms: 50,
        goto: { approved: 'next', rejected: 'rollback' }
      });

      assert.strictEqual(result.status, 'rejected');
      assert.strictEqual(result.result.step_id, stepId);
      assert.strictEqual(result.result.decided_by, 'reviewer');
      assert.strictEqual(result.result.comment, 'needs rework');
    } finally {
      clearTimeout(updateTimeout);
    }
  });
});

// ============================================================================
// executeManualGate — timeout
// ============================================================================
describe('executeManualGate — timeout', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return {status: "timeout"} when timeout_seconds elapses without decision', async () => {
    const runner = createMinimalRunner(tmpDir);
    const approvalsDir = path.join(tmpDir, '.workflow', 'approvals');
    fs.mkdirSync(approvalsDir, { recursive: true });

    const stepId = 'QA-12_gate_0';
    const filePath = path.join(approvalsDir, `${stepId}.json`);

    const startTime = Date.now();

    const result = await runner.executeManualGate('gate', {
      type: 'manual-gate',
      poll_interval_ms: 50,
      timeout_seconds: 0.15, // ~150ms to allow 2-3 iterations before timeout
      goto: { approved: 'next', rejected: 'rollback' }
    });

    const elapsed = Date.now() - startTime;

    assert.strictEqual(result.status, 'timeout');
    assert.strictEqual(result.result.step_id, stepId);
    // Verify timeout occurred within reasonable bounds (150-400ms)
    assert.ok(elapsed >= 150, `timeout should take at least 150ms, took ${elapsed}ms`);
    assert.ok(elapsed < 400, `timeout should complete within 400ms, took ${elapsed}ms`);
  });

  it('should return {status: "timeout"} with correct step_id in result', async () => {
    const runner = createMinimalRunner(tmpDir, {
      context: { ticket_id: 'IMPL-55' },
      counters: { task_attempts: 2 }
    });
    const approvalsDir = path.join(tmpDir, '.workflow', 'approvals');
    fs.mkdirSync(approvalsDir, { recursive: true });

    const result = await runner.executeManualGate('deploy', {
      type: 'manual-gate',
      poll_interval_ms: 40,
      timeout_seconds: 0.1,
      goto: { approved: 'next', rejected: 'rollback' }
    });

    assert.strictEqual(result.status, 'timeout');
    assert.strictEqual(result.result.step_id, 'IMPL-55_deploy_2');
  });
});

// ============================================================================
// executeManualGate — aborted
// ============================================================================
describe('executeManualGate — aborted', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return {status: "aborted"} when this.running is set to false during polling', async () => {
    const runner = createMinimalRunner(tmpDir);
    const approvalsDir = path.join(tmpDir, '.workflow', 'approvals');
    fs.mkdirSync(approvalsDir, { recursive: true });

    const stepId = 'QA-12_gate_0';

    // Set runner.running = false after first iteration
    const abortTimeout = setTimeout(() => {
      runner.running = false;
    }, 75);

    try {
      const result = await runner.executeManualGate('gate', {
        type: 'manual-gate',
        poll_interval_ms: 50,
        goto: { approved: 'next', rejected: 'rollback' }
      });

      assert.strictEqual(result.status, 'aborted');
      assert.strictEqual(result.result.step_id, stepId);
    } finally {
      clearTimeout(abortTimeout);
    }
  });

  it('should return {status: "aborted"} with correct step_id when runner is stopped', async () => {
    const runner = createMinimalRunner(tmpDir, {
      context: { ticket_id: 'IMPL-42' },
      counters: { task_attempts: 1 }
    });
    const approvalsDir = path.join(tmpDir, '.workflow', 'approvals');
    fs.mkdirSync(approvalsDir, { recursive: true });

    // Abort after 80ms (more than one poll interval)
    const abortTimeout = setTimeout(() => {
      runner.running = false;
    }, 80);

    try {
      const result = await runner.executeManualGate('review', {
        type: 'manual-gate',
        poll_interval_ms: 50,
        goto: { approved: 'next', rejected: 'rollback' }
      });

      assert.strictEqual(result.status, 'aborted');
      assert.strictEqual(result.result.step_id, 'IMPL-42_review_1');
    } finally {
      clearTimeout(abortTimeout);
    }
  });

});
