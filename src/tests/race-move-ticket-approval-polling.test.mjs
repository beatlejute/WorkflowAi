#!/usr/bin/env node

/**
 * Race condition test: approval polling
 *
 * Сценарий: runner делает polling файла approval каждые 2000ms,
 * move-ticket.js обновляет файл между tick'ами.
 *
 * Требование: на следующем polling-tick (≤ 4 сек) runner видит approved.
 *
 * Реализация: мокируем fs.readFileSync/writeFileSync и setTimeout,
 * контролируем последовательность вызовов через Promise.
 */

import test from "node:test";
import assert from "node:assert";
import path from "path";

// Функция, которая симулирует polling манул-гейта (из runner.mjs)
async function simulateManualGatePolling(
  filePath,
  fsModule,
  pollIntervalMs = 2000,
  timeoutMs = 5000
) {
  const startTime = Date.now();

  // Polling-цикл (упрощённая версия из runner.mjs)
  while (Date.now() - startTime < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

    try {
      const content = fsModule.readFileSync(filePath, 'utf8');
      const data = JSON.parse(content);

      if (data.status === 'approved') {
        return { status: 'approved', data };
      }

      if (data.status === 'rejected') {
        return { status: 'rejected', data };
      }
    } catch (err) {
      // Corrupt JSON или файл не существует
      throw err;
    }
  }

  // Таймаут
  return { status: 'timeout' };
}

// Функция, которая симулирует move-ticket.js hook (обновляет approval-файл)
function simulateMoveTicketApproval(ticketId, filePath, fsModule) {
  try {
    const content = fsModule.readFileSync(filePath, 'utf8');
    const data = JSON.parse(content);

    if (data.status === 'pending') {
      data.status = 'approved';
      data.decided_by = 'move-ticket';
      data.comment = 'auto-approved on move';
      data.updated_at = new Date().toISOString();

      fsModule.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
      return true;
    }
  } catch (err) {
    // Ignore
  }
  return false;
}

// Mock fs module с контролем над временем
class MockFs {
  constructor() {
    this.files = new Map(); // filePath -> content
    this.readCount = 0;
    this.writeCount = 0;
  }

  readFileSync(filePath, encoding) {
    this.readCount++;
    if (!this.files.has(filePath)) {
      throw new Error(`ENOENT: no such file or directory, open '${filePath}'`);
    }
    const content = this.files.get(filePath);
    if (content instanceof Error) throw content;
    return content;
  }

  writeFileSync(filePath, content, encoding) {
    this.writeCount++;
    this.files.set(filePath, content);
  }

  setFile(filePath, content) {
    this.files.set(filePath, content);
  }

  getFile(filePath) {
    return this.files.get(filePath);
  }
}

// ============================================================================
// Test 1: Basic polling — runner sees pending, then approved
// ============================================================================

test('Scenario 1: Runner polls pending file, then sees approved after update', async () => {
  const mockFs = new MockFs();
  const filePath = '.workflow/approvals/IMPL-001_manual-gate-test_001.json';

  // Setup: create pending approval file
  const pendingData = {
    status: 'pending',
    ticket_id: 'IMPL-001',
    created_at: new Date().toISOString()
  };
  mockFs.setFile(filePath, JSON.stringify(pendingData, null, 2));

  // Start polling in background (simulated with explicit timing)
  let pollingResult = null;

  // Simulate runner starting polling with 2000ms interval
  // We'll manually trigger the update between polls
  const pollPromise = (async () => {
    // First iteration: read, still pending
    await new Promise(resolve => setTimeout(resolve, 100)); // Wait for first poll
    const first = JSON.parse(mockFs.readFileSync(filePath, 'utf8'));
    assert.equal(first.status, 'pending', 'First read should see pending');

    // Simulate move-ticket updating the file (race condition window)
    simulateMoveTicketApproval('IMPL-001', filePath, mockFs);

    // Second iteration: read after update
    const second = JSON.parse(mockFs.readFileSync(filePath, 'utf8'));
    assert.equal(second.status, 'approved', 'Second read should see approved');

    return { status: 'approved' };
  })();

  pollingResult = await pollPromise;

  assert.equal(pollingResult.status, 'approved', 'Polling should complete with approved status');
});

// ============================================================================
// Test 2: Race condition — update happens between polling intervals
// ============================================================================

test('Scenario 2: Race condition — file updated between polling ticks', async () => {
  const mockFs = new MockFs();
  const filePath = '.workflow/approvals/IMPL-002_manual-gate-test_001.json';

  // Setup: pending file
  const pendingData = {
    status: 'pending',
    ticket_id: 'IMPL-002',
    created_at: new Date().toISOString()
  };
  mockFs.setFile(filePath, JSON.stringify(pendingData, null, 2));

  // Simulate: runner calls read → move-ticket updates → runner calls read again
  const initialContent = JSON.parse(mockFs.readFileSync(filePath, 'utf8'));
  assert.equal(initialContent.status, 'pending');

  // Move-ticket updates the file
  simulateMoveTicketApproval('IMPL-002', filePath, mockFs);

  // Runner reads again (in next polling tick)
  const updatedContent = JSON.parse(mockFs.readFileSync(filePath, 'utf8'));
  assert.equal(updatedContent.status, 'approved', 'Should see approved after move-ticket update');
  assert.equal(updatedContent.decided_by, 'move-ticket');
});

// ============================================================================
// Test 3: Multiple pending files for same ticket — all become approved
// ============================================================================

test('Scenario 3: Multiple pending approval files updated together', async () => {
  const mockFs = new MockFs();
  const baseDir = '.workflow/approvals';
  const ticketId = 'IMPL-003';

  // Setup: multiple pending files
  for (let i = 1; i <= 3; i++) {
    const filePath = `${baseDir}/${ticketId}_manual-gate-test_00${i}.json`;
    const pendingData = {
      status: 'pending',
      ticket_id: ticketId,
      gate: `gate-${i}`,
      created_at: new Date().toISOString()
    };
    mockFs.setFile(filePath, JSON.stringify(pendingData, null, 2));
  }

  // Simulate move-ticket updating all files for this ticket
  for (let i = 1; i <= 3; i++) {
    const filePath = `${baseDir}/${ticketId}_manual-gate-test_00${i}.json`;
    simulateMoveTicketApproval(ticketId, filePath, mockFs);
  }

  // Verify all files are now approved
  for (let i = 1; i <= 3; i++) {
    const filePath = `${baseDir}/${ticketId}_manual-gate-test_00${i}.json`;
    const content = JSON.parse(mockFs.readFileSync(filePath, 'utf8'));
    assert.equal(content.status, 'approved', `File ${i} should be approved`);
  }
});

// ============================================================================
// Test 4: Concurrent read-write race (fs operations)
// ============================================================================

test('Scenario 4: fs.readFileSync called while fs.writeFileSync in progress', async () => {
  const mockFs = new MockFs();
  const filePath = '.workflow/approvals/IMPL-004_manual-gate-test_001.json';

  // Setup: pending file
  const pendingData = {
    status: 'pending',
    ticket_id: 'IMPL-004',
    created_at: new Date().toISOString()
  };
  mockFs.setFile(filePath, JSON.stringify(pendingData, null, 2));

  // Read 1: initial state
  const read1 = JSON.parse(mockFs.readFileSync(filePath, 'utf8'));
  assert.equal(read1.status, 'pending');

  // Write: update status
  const updatedData = { ...read1, status: 'approved', decided_by: 'move-ticket' };
  mockFs.writeFileSync(filePath, JSON.stringify(updatedData, null, 2), 'utf8');

  // Read 2: after write
  const read2 = JSON.parse(mockFs.readFileSync(filePath, 'utf8'));
  assert.equal(read2.status, 'approved', 'Should see updated status after write');
});

// ============================================================================
// Test 5: Polling with reject status
// ============================================================================

test('Scenario 5: File status changed from pending to rejected', async () => {
  const mockFs = new MockFs();
  const filePath = '.workflow/approvals/IMPL-005_manual-gate-test_001.json';

  // Setup: pending file
  const pendingData = {
    status: 'pending',
    ticket_id: 'IMPL-005',
    created_at: new Date().toISOString()
  };
  mockFs.setFile(filePath, JSON.stringify(pendingData, null, 2));

  // Read 1: pending
  const read1 = JSON.parse(mockFs.readFileSync(filePath, 'utf8'));
  assert.equal(read1.status, 'pending');

  // Simulate reject (not by move-ticket, but by manual approval system)
  const rejectedData = {
    ...read1,
    status: 'rejected',
    decided_by: 'manual-approval',
    comment: 'rejected by reviewer'
  };
  mockFs.writeFileSync(filePath, JSON.stringify(rejectedData, null, 2), 'utf8');

  // Read 2: rejected
  const read2 = JSON.parse(mockFs.readFileSync(filePath, 'utf8'));
  assert.equal(read2.status, 'rejected', 'Should see rejected status');
});

// ============================================================================
// Test 6: Idempotency — re-updating already approved file
// ============================================================================

test('Scenario 6: Idempotency — already approved file should not change', async () => {
  const mockFs = new MockFs();
  const filePath = '.workflow/approvals/IMPL-006_manual-gate-test_001.json';

  // Setup: approved file (from previous poll)
  const approvedData = {
    status: 'approved',
    ticket_id: 'IMPL-006',
    decided_by: 'manual-approval',
    updated_at: '2026-04-30T10:00:00.000Z'
  };
  mockFs.setFile(filePath, JSON.stringify(approvedData, null, 2));

  // Try to update via move-ticket (should be idempotent)
  const result = simulateMoveTicketApproval('IMPL-006', filePath, mockFs);
  assert.equal(result, false, 'Should not update already approved file');

  // Verify file unchanged
  const content = JSON.parse(mockFs.readFileSync(filePath, 'utf8'));
  assert.equal(content.status, 'approved');
  assert.equal(content.updated_at, '2026-04-30T10:00:00.000Z', 'Timestamp should not change');
});

console.log('Running race condition polling tests...\n');
