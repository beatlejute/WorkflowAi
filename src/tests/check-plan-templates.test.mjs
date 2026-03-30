import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { evaluateTrigger, generateNextPlanId } from '../../.workflow/src/scripts/check-plan-templates.js';

// ============ evaluateTrigger tests ============

// --- daily ---

test('daily trigger fires when never triggered', () => {
  const trigger = { type: 'daily', params: {} };
  assert.strictEqual(evaluateTrigger(trigger, ''), true);
});

test('daily trigger fires when last triggered yesterday', () => {
  const trigger = { type: 'daily', params: {} };
  const now = new Date('2026-03-29T10:00:00Z');
  assert.strictEqual(evaluateTrigger(trigger, '2026-03-28', now), true);
});

test('daily trigger does NOT fire when already triggered today', () => {
  const trigger = { type: 'daily', params: {} };
  const now = new Date('2026-03-29T10:00:00Z');
  assert.strictEqual(evaluateTrigger(trigger, '2026-03-29', now), false);
});

// --- weekly ---

test('weekly trigger fires on target day when not triggered today', () => {
  const trigger = { type: 'weekly', params: { days_of_week: [0] } }; // Sunday
  const now = new Date('2026-03-29T10:00:00Z'); // Sunday
  assert.strictEqual(evaluateTrigger(trigger, '2026-03-22', now), true);
});

test('weekly trigger does NOT fire on non-target day', () => {
  const trigger = { type: 'weekly', params: { days_of_week: [1, 3, 5] } }; // Mon, Wed, Fri
  const now = new Date('2026-03-29T10:00:00Z'); // Sunday = 0
  assert.strictEqual(evaluateTrigger(trigger, '', now), false);
});

test('weekly trigger does NOT fire when already triggered today', () => {
  const trigger = { type: 'weekly', params: { days_of_week: [0] } }; // Sunday
  const now = new Date('2026-03-29T10:00:00Z'); // Sunday
  assert.strictEqual(evaluateTrigger(trigger, '2026-03-29', now), false);
});

test('weekly trigger defaults to Monday when days_of_week not set', () => {
  const trigger = { type: 'weekly', params: {} };
  const monday = new Date('2026-03-30T10:00:00Z'); // Monday
  assert.strictEqual(evaluateTrigger(trigger, '', monday), true);
});

// --- date_after ---

test('date_after fires when date has passed and never triggered', () => {
  const trigger = { type: 'date_after', params: { date: '2026-03-01' } };
  const now = new Date('2026-03-29T10:00:00Z');
  assert.strictEqual(evaluateTrigger(trigger, '', now), true);
});

test('date_after does NOT fire when date has not arrived', () => {
  const trigger = { type: 'date_after', params: { date: '2026-04-01' } };
  const now = new Date('2026-03-29T10:00:00Z');
  assert.strictEqual(evaluateTrigger(trigger, '', now), false);
});

test('date_after does NOT fire when already triggered after date', () => {
  const trigger = { type: 'date_after', params: { date: '2026-03-01' } };
  const now = new Date('2026-03-29T10:00:00Z');
  assert.strictEqual(evaluateTrigger(trigger, '2026-03-15', now), false);
});

test('date_after returns false when no date param', () => {
  const trigger = { type: 'date_after', params: {} };
  const now = new Date('2026-03-29T10:00:00Z');
  assert.strictEqual(evaluateTrigger(trigger, '', now), false);
});

// --- interval_days ---

test('interval_days fires when never triggered', () => {
  const trigger = { type: 'interval_days', params: { days: 3 } };
  assert.strictEqual(evaluateTrigger(trigger, ''), true);
});

test('interval_days fires when enough days have passed', () => {
  const trigger = { type: 'interval_days', params: { days: 3 } };
  const now = new Date('2026-03-29T10:00:00Z');
  assert.strictEqual(evaluateTrigger(trigger, '2026-03-25', now), true);
});

test('interval_days does NOT fire when not enough days', () => {
  const trigger = { type: 'interval_days', params: { days: 3 } };
  const now = new Date('2026-03-29T10:00:00Z');
  assert.strictEqual(evaluateTrigger(trigger, '2026-03-28', now), false);
});

// --- edge cases ---

test('unknown trigger type returns false', () => {
  const trigger = { type: 'cron', params: {} };
  assert.strictEqual(evaluateTrigger(trigger, ''), false);
});

test('null trigger returns false', () => {
  assert.strictEqual(evaluateTrigger(null, ''), false);
});

test('trigger without type returns false', () => {
  assert.strictEqual(evaluateTrigger({}, ''), false);
});

// ============ generateNextPlanId tests ============

function createPlansStructure() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plans-root-'));
  const currentDir = path.join(root, 'current');
  const archiveDir = path.join(root, 'archive');
  fs.mkdirSync(currentDir);
  fs.mkdirSync(archiveDir);
  return { root, currentDir, archiveDir };
}

test('generateNextPlanId returns PLAN-001 for empty directory', () => {
  const { root, currentDir } = createPlansStructure();
  try {
    assert.strictEqual(generateNextPlanId(currentDir), 'PLAN-001');
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test('generateNextPlanId returns PLAN-001 for non-existent directory', () => {
  assert.strictEqual(generateNextPlanId('/non/existent/current'), 'PLAN-001');
});

test('generateNextPlanId increments from existing plan', () => {
  const { root, currentDir } = createPlansStructure();
  try {
    fs.writeFileSync(path.join(currentDir, 'PLAN-001.md'), '# Plan 1');
    assert.strictEqual(generateNextPlanId(currentDir), 'PLAN-002');
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test('generateNextPlanId finds max with gaps', () => {
  const { root, currentDir } = createPlansStructure();
  try {
    fs.writeFileSync(path.join(currentDir, 'PLAN-001.md'), '# Plan 1');
    fs.writeFileSync(path.join(currentDir, 'PLAN-003.md'), '# Plan 3');
    assert.strictEqual(generateNextPlanId(currentDir), 'PLAN-004');
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test('generateNextPlanId ignores non-plan files', () => {
  const { root, currentDir } = createPlansStructure();
  try {
    fs.writeFileSync(path.join(currentDir, 'PLAN-002.md'), '# Plan 2');
    fs.writeFileSync(path.join(currentDir, 'README.md'), '# Readme');
    fs.writeFileSync(path.join(currentDir, 'TMPL-001.md'), '# Template');
    assert.strictEqual(generateNextPlanId(currentDir), 'PLAN-003');
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test('generateNextPlanId considers archive directory', () => {
  const { root, currentDir, archiveDir } = createPlansStructure();
  try {
    fs.writeFileSync(path.join(archiveDir, 'PLAN-005.md'), '# Plan 5');
    assert.strictEqual(generateNextPlanId(currentDir), 'PLAN-006');
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test('generateNextPlanId picks max across current and archive', () => {
  const { root, currentDir, archiveDir } = createPlansStructure();
  try {
    fs.writeFileSync(path.join(currentDir, 'PLAN-002.md'), '# Plan 2');
    fs.writeFileSync(path.join(archiveDir, 'PLAN-007.md'), '# Plan 7');
    assert.strictEqual(generateNextPlanId(currentDir), 'PLAN-008');
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});
