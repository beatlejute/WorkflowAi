import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { incrementMetrics, readMetricsFile } from '../lib/metrics-incremental.mjs';

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'test-metrics-'));
}

function cleanup(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function getMetricsFile(projectRoot) {
  return path.join(projectRoot, '.workflow/metrics/review-metrics.json');
}

test('incrementMetrics: file does not exist → creates with correct agent_history structure', () => {
  const tempDir = createTempDir();
  try {
    const metricsFile = getMetricsFile(tempDir);
    assert.strictEqual(fs.existsSync(metricsFile), false, 'metrics file should not exist initially');

    const entry = {
      status: 'ok',
      agent: 'claude-sonnet',
      skill: 'execute-task'
    };

    const result = incrementMetrics(tempDir, entry, 'TEST-001');
    assert.strictEqual(result.ok, true, 'incrementMetrics should succeed');
    assert.strictEqual(fs.existsSync(metricsFile), true, 'metrics file should be created');

    const metrics = JSON.parse(fs.readFileSync(metricsFile, 'utf8'));
    assert.ok(metrics.agent_history, 'agent_history should exist');
    assert.strictEqual(metrics.agent_history.total_attempts, 1);
    assert.strictEqual(metrics.agent_history.by_status.ok, 1);
    assert.ok(metrics.agent_history.by_agent['claude-sonnet']);
    assert.strictEqual(metrics.agent_history.by_agent['claude-sonnet'].ok, 1);
    assert.ok(metrics.agent_history.by_skill['execute-task']);
    assert.strictEqual(metrics.agent_history.by_skill['execute-task'].ok, 1);
  } finally {
    cleanup(tempDir);
  }
});

test('incrementMetrics: file exists with old structure → preserves old keys, adds agent_history', () => {
  const tempDir = createTempDir();
  try {
    const metricsFile = getMetricsFile(tempDir);
    const metricsDir = path.dirname(metricsFile);
    fs.mkdirSync(metricsDir, { recursive: true });

    const oldMetrics = {
      iterations_per_ticket: 2,
      total_failed: 5,
      some_other_key: 'preserved'
    };
    fs.writeFileSync(metricsFile, JSON.stringify(oldMetrics), 'utf8');

    const entry = {
      status: 'ok',
      agent: 'claude-opus',
      skill: 'coach'
    };

    const result = incrementMetrics(tempDir, entry, 'TEST-002');
    assert.strictEqual(result.ok, true);

    const metrics = JSON.parse(fs.readFileSync(metricsFile, 'utf8'));
    assert.strictEqual(metrics.iterations_per_ticket, 2, 'old key iterations_per_ticket should be preserved');
    assert.strictEqual(metrics.total_failed, 5, 'old key total_failed should be preserved');
    assert.strictEqual(metrics.some_other_key, 'preserved', 'other old keys should be preserved');
    assert.ok(metrics.agent_history, 'agent_history should be added');
    assert.strictEqual(metrics.agent_history.by_agent['claude-opus'].ok, 1);
  } finally {
    cleanup(tempDir);
  }
});

test('incrementMetrics: file contains invalid JSON → warns, starts fresh, writes metrics without error', () => {
  const tempDir = createTempDir();
  try {
    const metricsFile = getMetricsFile(tempDir);
    const metricsDir = path.dirname(metricsFile);
    fs.mkdirSync(metricsDir, { recursive: true });

    // Write corrupted JSON
    fs.writeFileSync(metricsFile, '{invalid json}', 'utf8');

    // Capture console.warn
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (msg) => warnings.push(msg);

    try {
      const entry = {
        status: 'failed',
        agent: 'test-agent',
        skill: 'test-skill'
      };

      let error;
      try {
        const result = incrementMetrics(tempDir, entry, 'TEST-003');
        assert.strictEqual(result.ok, true, 'incrementMetrics should not throw error');
      } catch (err) {
        error = err;
      }

      assert.strictEqual(error, undefined, 'function should not throw on corrupted JSON');
      assert.ok(warnings.some(w => w.includes('corrupted')), 'should warn about corrupted JSON');

      const metrics = JSON.parse(fs.readFileSync(metricsFile, 'utf8'));
      assert.ok(metrics.agent_history, 'should create fresh agent_history');
      assert.strictEqual(metrics.agent_history.by_status.failed, 1);
    } finally {
      console.warn = originalWarn;
    }
  } finally {
    cleanup(tempDir);
  }
});

test('incrementMetrics: multiple sequential increments → counters accumulate correctly', () => {
  const tempDir = createTempDir();
  try {
    // First increment
    let entry = {
      status: 'ok',
      agent: 'agent-1',
      skill: 'skill-1'
    };
    let result = incrementMetrics(tempDir, entry, 'TICKET-1');
    assert.strictEqual(result.ok, true);

    // Second increment — same status
    entry = {
      status: 'ok',
      agent: 'agent-1',
      skill: 'skill-1'
    };
    result = incrementMetrics(tempDir, entry, 'TICKET-2');
    assert.strictEqual(result.ok, true);

    // Third increment — same status
    entry = {
      status: 'ok',
      agent: 'agent-1',
      skill: 'skill-1'
    };
    result = incrementMetrics(tempDir, entry, 'TICKET-3');
    assert.strictEqual(result.ok, true);

    // Verify accumulated counters
    const metricsFile = path.join(tempDir, '.workflow/metrics/review-metrics.json');
    const metrics = JSON.parse(fs.readFileSync(metricsFile, 'utf8'));
    const ah = metrics.agent_history;

    assert.strictEqual(ah.total_attempts, 3, 'total_attempts should be 3');
    assert.strictEqual(ah.by_status.ok, 3, 'by_status.ok should be 3');
    assert.strictEqual(ah.by_agent['agent-1'].ok, 3, 'by_agent[agent-1].ok should be 3');
    assert.strictEqual(ah.by_skill['skill-1'].ok, 3, 'by_skill[skill-1].ok should be 3');
    assert.strictEqual(
      ah.by_skill_by_agent['skill-1']['agent-1'].ok,
      3,
      'by_skill_by_agent[skill-1][agent-1].ok should be 3'
    );
  } finally {
    cleanup(tempDir);
  }
});
