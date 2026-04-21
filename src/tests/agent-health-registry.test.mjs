import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadHealth,
  markUnhealthy,
  markHealthy,
  isHealthy,
  unhealthy,
  pruneExpired,
  AgentHealthLockError
} from '../lib/agent-health-registry.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let projectRoot;

// Helper to cleanup tmp directory
function cleanup() {
  if (projectRoot && fs.existsSync(projectRoot)) {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'health-registry-test-'));
});

afterEach(() => {
  cleanup();
});

// Helper to read health file
function readHealthFile() {
  const filePath = path.join(projectRoot, '.workflow/state/agent-health.json');
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

test('TC-001: markUnhealthy + isHealthy — TTL expiry', async (t) => {
  const ttlMs = 5000; // 5 seconds

  // Test: before TTL expiry isHealthy returns false
  await t.test('before TTL expiry: isHealthy = false', () => {
    markUnhealthy(projectRoot, 'qwen', {
      class: 'unavailable',
      rule_id: 'health-check-failed',
      ttl: ttlMs,
      reason: 'Service unreachable'
    });

    // Should be unhealthy immediately
    const result = isHealthy(projectRoot, 'qwen', Date.now());
    assert.strictEqual(result, false, 'Should be unhealthy immediately after marking');
  });

  // Test: after TTL expiry isHealthy returns true
  await t.test('after TTL expiry: isHealthy = true', () => {
    markUnhealthy(projectRoot, 'qwen', {
      class: 'unavailable',
      rule_id: 'health-check-failed',
      ttl: ttlMs,
      reason: 'Service unreachable'
    });

    // Read the file to get the actual until timestamp
    const content = readHealthFile();
    const untilIso = content.agents.qwen.until;
    const untilMs = new Date(untilIso).getTime();

    // Check with time after expiry (1ms after until)
    const result = isHealthy(projectRoot, 'qwen', untilMs + 1);
    assert.strictEqual(result, true, 'Should be healthy after TTL expiry');
  });
});

test('TC-002: markHealthy — manual reset', () => {
  markUnhealthy(projectRoot, 'claude', {
    class: 'overloaded',
    rule_id: 'rate-limit-exceeded',
    ttl: 300000,
    reason: 'Too many requests'
  });

  // Verify marked as unhealthy
  assert.strictEqual(isHealthy(projectRoot, 'claude'), false, 'Should be unhealthy after markUnhealthy');

  // Call markHealthy
  markHealthy(projectRoot, 'claude');

  // Verify entry is deleted and isHealthy returns true
  assert.strictEqual(isHealthy(projectRoot, 'claude'), true, 'Should be healthy after markHealthy');

  // Verify file no longer contains the agent
  const content = readHealthFile();
  assert.strictEqual(content.agents.claude, undefined, 'Agent should be removed from file');
});

test('TC-003: unhealthy() returns only non-expired unhealthy agents', () => {
  const ttl1 = 1000; // 1 second
  const ttl2 = 100000; // 100 seconds

  // Add expired unhealthy agent
  markUnhealthy(projectRoot, 'old-agent', {
    class: 'defunct',
    ttl: ttl1,
    reason: 'Will expire soon'
  });

  // Add non-expired unhealthy agent
  markUnhealthy(projectRoot, 'qwen', {
    class: 'unavailable',
    ttl: ttl2,
    reason: 'Recently unhealthy'
  });

  // Get current timestamp and read file to calculate when first agent expires
  const content = readHealthFile();
  const firstUntilMs = new Date(content.agents['old-agent'].until).getTime();

  // Check at time after first agent expires but before second
  const checkTime = firstUntilMs + 100;
  const result = unhealthy(projectRoot, checkTime);

  // Filter to verify only qwen is returned (old-agent is expired)
  const ids = result.map(a => a.agentId);
  assert.strictEqual(ids.includes('qwen'), true, 'Should include non-expired agent qwen');
  assert.strictEqual(ids.includes('old-agent'), false, 'Should exclude expired agent old-agent');
});

test('TC-004: pruneExpired removes only expired entries', () => {
  const ttl1 = 1000; // expires soon
  const ttl2 = 100000; // expires later

  // Add one record that will expire and one that won't
  markUnhealthy(projectRoot, 'expired-agent', {
    class: 'defunct',
    ttl: ttl1,
    reason: 'To be pruned'
  });

  markUnhealthy(projectRoot, 'active-agent', {
    class: 'unavailable',
    ttl: ttl2,
    reason: 'Still active'
  });

  // Get time when first agent expires
  const content1 = readHealthFile();
  const expiredUntilMs = new Date(content1.agents['expired-agent'].until).getTime();

  // Call pruneExpired at a time after first expiry but before second
  const pruneTime = expiredUntilMs + 100;
  pruneExpired(projectRoot, pruneTime);

  // Verify file only contains active agent
  const content = readHealthFile();
  assert.strictEqual(content.agents['expired-agent'], undefined, 'Expired agent should be pruned');
  assert.notStrictEqual(content.agents['active-agent'], undefined, 'Active agent should remain');
});

test('TC-005: Concurrent writes to different agents succeed', () => {
  // Simulate concurrent writes by calling markUnhealthy sequentially for different agents
  markUnhealthy(projectRoot, 'qwen', {
    class: 'unavailable',
    ttl: 60000,
    reason: 'First write'
  });

  markUnhealthy(projectRoot, 'claude', {
    class: 'overloaded',
    ttl: 60000,
    reason: 'Second write'
  });

  // Verify both are in file
  const content = readHealthFile();

  assert.notStrictEqual(content.agents.qwen, undefined, 'First agent should be saved');
  assert.notStrictEqual(content.agents.claude, undefined, 'Second agent should be saved');
  assert.strictEqual(content.agents.qwen.status, 'unhealthy');
  assert.strictEqual(content.agents.claude.status, 'unhealthy');
});

test('TC-006: Corrupted JSON returns empty state without throwing', () => {
  // Create .workflow/state directory
  const stateDir = path.join(projectRoot, '.workflow/state');
  fs.mkdirSync(stateDir, { recursive: true });

  // Write invalid JSON to health file
  const filePath = path.join(stateDir, 'agent-health.json');
  fs.writeFileSync(filePath, '{invalid json content}', 'utf-8');

  // Call loadHealth — should not throw and return empty state
  assert.doesNotThrow(() => {
    const result = loadHealth(projectRoot);
    assert.deepStrictEqual(result, { agents: {} }, 'Should return empty agents object for corrupted JSON');
  }, 'Should not throw error for corrupted JSON');
});

test('TC-007: Missing file creates directory on first write', () => {
  // Verify .workflow/state doesn't exist yet
  const stateDir = path.join(projectRoot, '.workflow/state');
  assert.strictEqual(fs.existsSync(stateDir), false, 'State directory should not exist initially');

  // Call markUnhealthy — should create directory
  markUnhealthy(projectRoot, 'test-agent', {
    class: 'unavailable',
    ttl: 60000,
    reason: 'Testing directory creation'
  });

  // Verify directory was created
  assert.strictEqual(fs.existsSync(stateDir), true, 'State directory should be created');

  // Verify file was created with correct content
  const filePath = path.join(stateDir, 'agent-health.json');
  assert.strictEqual(fs.existsSync(filePath), true, 'Health file should be created');

  const content = readHealthFile();
  assert.notStrictEqual(content.agents['test-agent'], undefined, 'Agent should be in file');
});

test('TC-008: TTL until_utc_midnight calculates next midnight', () => {
  // Test that until_utc_midnight sets until to the next UTC midnight
  // Regardless of current time, it should be set to midnight of the next day

  markUnhealthy(projectRoot, 'midnight-test', {
    class: 'test',
    ttl: 'until_utc_midnight',
    reason: 'Testing midnight TTL'
  });

  const content = readHealthFile();
  const until = content.agents['midnight-test'].until;
  const untilMs = new Date(until).getTime();
  const now = Date.now();

  // Verify until is in the future
  assert.ok(untilMs > now, 'until should be after current time');

  // Verify until is a midnight (00:00:00 UTC)
  const untilDate = new Date(until);
  assert.strictEqual(untilDate.getUTCHours(), 0, 'Hours should be 0 (UTC)');
  assert.strictEqual(untilDate.getUTCMinutes(), 0, 'Minutes should be 0');
  assert.strictEqual(untilDate.getUTCSeconds(), 0, 'Seconds should be 0');

  // Verify the time difference is less than 24 hours (not more than a day away)
  const diffMs = untilMs - now;
  assert.ok(diffMs < 24 * 60 * 60 * 1000, 'until should be within 24 hours');
  assert.ok(diffMs > 0, 'until should be in the future');
});
