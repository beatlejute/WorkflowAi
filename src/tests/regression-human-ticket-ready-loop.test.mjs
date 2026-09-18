#!/usr/bin/env node

/**
 * Regression FIX-70: холостой цикл check-conditions ↔ pick-next-task вокруг human-тикетов
 * и перезатирание approval-файла на повторном заходе в manual-gate.
 *
 * Баг 1: check-conditions логировал "type is 'human', moved to ready/" и отдавал has_ready,
 *        но ничего не перемещал (перенос делает move-to-ready.js), а move-to-ready человеческие
 *        тикеты пропускал → moved: 0 → pick-next-task (empty) → снова check-conditions.
 *        Цикл крутился до max_steps.
 *
 * Баг 2: каждый заход на manual-gate создавал pending approval-файл поверх уже существующего,
 *        затирая принятое человеком решение (status/decided_by/comment).
 *
 * Запуск: node --test src/tests/regression-human-ticket-ready-loop.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'url';
import { spawnSync } from 'node:child_process';

import { PipelineRunner } from '../runner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const CHECK_CONDITIONS = path.join(PROJECT_ROOT, 'src', 'scripts', 'check-conditions.js');
const MOVE_TO_READY = path.join(PROJECT_ROOT, 'src', 'scripts', 'move-to-ready.js');

/**
 * Создаёт изолированную тестовую директорию со структурой .workflow/tickets
 */
function createTestEnv(prefix = 'fix-70-') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const ticketsDir = path.join(tmpDir, '.workflow', 'tickets');
  for (const dir of ['backlog', 'ready', 'in-progress', 'review', 'done', 'archive', 'blocked']) {
    fs.mkdirSync(path.join(ticketsDir, dir), { recursive: true });
  }
  return { tmpDir, ticketsDir };
}

function cleanup(dir) {
  if (dir && fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Создаёт файл тикета. fileName позволяет намеренно разойтись с frontmatter.id
 */
function createTicket(ticketsDir, subdir, ticketId, frontmatter = {}, fileName = `${ticketId}.md`) {
  const fm = {
    id: ticketId,
    title: `Test ${ticketId}`,
    priority: 2,
    type: 'impl',
    created_at: '2026-08-01T10:00:00.000Z',
    updated_at: '2026-08-01T10:00:00.000Z',
    ...frontmatter
  };
  const fmText = Object.entries(fm)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join('\n');
  const filePath = path.join(ticketsDir, subdir, fileName);
  fs.writeFileSync(filePath, `---\n${fmText}\n---\n\n## Description\n\nTest ticket.\n`, 'utf8');
  return filePath;
}

function runScript(scriptPath, args, cwd) {
  const result = spawnSync('node', [scriptPath, ...args], { cwd, encoding: 'utf8' });
  return { code: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

/**
 * Достаёт значение поля из блока ---RESULT---
 */
function resultField(stdout, key) {
  const match = stdout.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'));
  return match ? match[1].trim() : null;
}

/**
 * Минимальный runner для прямого вызова executeManualGate
 */
function createMinimalRunner(tmpDir, context, counters, logs) {
  const runner = Object.create(PipelineRunner.prototype);
  runner.context = context;
  runner.counters = counters;
  runner.projectRoot = tmpDir;
  runner.running = true;
  runner.logger = logs
    ? {
        level: 'info',
        info: (msg) => logs.push(msg),
        warn: (msg) => logs.push(msg),
        debug: (msg) => logs.push(msg)
      }
    : null;
  return runner;
}

// ============================================================================
// Баг 1: холостой цикл вокруг human-тикета
// ============================================================================

test('FIX-70-001: check-conditions не рапортует о перемещении, которого не делал', () => {
  const { tmpDir, ticketsDir } = createTestEnv();
  try {
    createTicket(ticketsDir, 'backlog', 'HUMAN-1', { type: 'human' });

    const res = runScript(CHECK_CONDITIONS, [], tmpDir);

    assert.strictEqual(res.code, 0, `check-conditions должен завершиться с 0: ${res.stderr}`);
    assert.ok(
      !res.stdout.includes('moved to ready/'),
      `check-conditions ничего не перемещает — лог не должен утверждать обратное:\n${res.stdout}`
    );
    // тикет действительно остался в backlog/ — перенос делает move-to-ready
    assert.ok(fs.existsSync(path.join(ticketsDir, 'backlog', 'HUMAN-1.md')), 'тикет остаётся в backlog/');
    assert.ok(!fs.existsSync(path.join(ticketsDir, 'ready', 'HUMAN-1.md')), 'check-conditions не создаёт файл в ready/');

    assert.strictEqual(resultField(res.stdout, 'status'), 'has_ready');
    assert.strictEqual(resultField(res.stdout, 'ready_tickets'), 'HUMAN-1');
  } finally {
    cleanup(tmpDir);
  }
});

test('FIX-70-002: move-to-ready реально переносит human-тикет — has_ready не повторяется', () => {
  const { tmpDir, ticketsDir } = createTestEnv();
  try {
    createTicket(ticketsDir, 'backlog', 'HUMAN-1', { type: 'human' });

    // Оборот 1: check-conditions → has_ready
    const check1 = runScript(CHECK_CONDITIONS, [], tmpDir);
    assert.strictEqual(resultField(check1.stdout, 'status'), 'has_ready');

    // move-to-ready по списку из check-conditions
    const move = runScript(MOVE_TO_READY, ['move-to-ready\n\nContext:\n  ready_tickets: HUMAN-1\n'], tmpDir);
    assert.strictEqual(move.code, 0, `move-to-ready должен завершиться с 0: ${move.stderr}`);
    assert.strictEqual(resultField(move.stdout, 'moved'), '1', `human-тикет должен быть перемещён:\n${move.stdout}`);
    assert.strictEqual(resultField(move.stdout, 'status'), 'moved');
    assert.ok(fs.existsSync(path.join(ticketsDir, 'ready', 'HUMAN-1.md')), 'тикет должен оказаться в ready/');
    assert.ok(!fs.existsSync(path.join(ticketsDir, 'backlog', 'HUMAN-1.md')), 'тикета не должно остаться в backlog/');

    // Оборот 2: backlog пуст → has_ready больше не выдаётся (цикл разорван)
    const check2 = runScript(CHECK_CONDITIONS, [], tmpDir);
    assert.notStrictEqual(
      resultField(check2.stdout, 'status'),
      'has_ready',
      `повторный check-conditions не должен снова отдавать has_ready:\n${check2.stdout}`
    );
    assert.strictEqual(resultField(check2.stdout, 'ready_tickets'), '');
  } finally {
    cleanup(tmpDir);
  }
});

test('FIX-70-003: тикет, который move-to-ready не найдёт, не попадает в has_ready', () => {
  const { tmpDir, ticketsDir } = createTestEnv();
  try {
    // frontmatter.id разошёлся с именем файла — move-to-ready ищет `${id}.md` и вернёт moved: 0
    createTicket(ticketsDir, 'backlog', 'HUMAN-2', { type: 'human' }, 'human-2-draft.md');

    const check = runScript(CHECK_CONDITIONS, [], tmpDir);

    assert.strictEqual(resultField(check.stdout, 'status'), 'empty', `не должно быть has_ready:\n${check.stdout}`);
    assert.strictEqual(resultField(check.stdout, 'ready_tickets'), '');
    assert.ok(check.stderr.includes('HUMAN-2'), `должно быть предупреждение о несовпадении id:\n${check.stderr}`);

    // и move-to-ready честно рапортует skipped, если такой тикет всё же придёт извне
    const move = runScript(MOVE_TO_READY, ['move-to-ready\n\nContext:\n  ready_tickets: HUMAN-2\n'], tmpDir);
    assert.strictEqual(resultField(move.stdout, 'moved'), '0');
    assert.strictEqual(resultField(move.stdout, 'skipped'), '1');
  } finally {
    cleanup(tmpDir);
  }
});

// ============================================================================
// Баг 2: повторный заход на manual-gate не затирает approval
// ============================================================================

test('FIX-70-004: повторный заход на manual-gate не затирает approved-файл', async () => {
  const { tmpDir } = createTestEnv('fix-70-gate-');
  try {
    const approvalsDir = path.join(tmpDir, '.workflow', 'approvals');
    fs.mkdirSync(approvalsDir, { recursive: true });

    const stepId = 'HUMAN-4_manual-gate-human_1';
    const filePath = path.join(approvalsDir, `${stepId}.json`);
    const approved = {
      step_id: stepId,
      ticket_id: 'HUMAN-4',
      stage_id: 'manual-gate-human',
      attempt: 1,
      status: 'approved',
      created_at: '2026-08-04T14:10:55.947Z',
      updated_at: '2026-08-04T14:39:00.000Z',
      decided_by: 'stakeholder',
      comment: 'HUMAN-4 выполнен, Result-секция заполнена',
      context_snapshot: { ticket_id: 'HUMAN-4' }
    };
    fs.writeFileSync(filePath, JSON.stringify(approved, null, 2), 'utf8');
    const before = fs.readFileSync(filePath, 'utf8');

    const runner = createMinimalRunner(tmpDir, { ticket_id: 'HUMAN-4' }, { task_attempts: 1 });

    const result = await runner.executeManualGate('manual-gate-human', {
      type: 'manual-gate',
      poll_interval_ms: 30,
      goto: { approved: 'next', rejected: 'rollback' }
    });

    assert.strictEqual(result.status, 'approved');
    assert.strictEqual(result.result.decided_by, 'stakeholder');
    assert.strictEqual(result.result.comment, 'HUMAN-4 выполнен, Result-секция заполнена');
    assert.strictEqual(
      fs.readFileSync(filePath, 'utf8'),
      before,
      'approval-файл не должен быть перезаписан pending-ом'
    );
  } finally {
    cleanup(tmpDir);
  }
});

test('FIX-70-005: существующий pending-файл переиспользуется, а не создаётся заново', async () => {
  const { tmpDir } = createTestEnv('fix-70-gate-');
  try {
    const approvalsDir = path.join(tmpDir, '.workflow', 'approvals');
    fs.mkdirSync(approvalsDir, { recursive: true });

    const stepId = 'HUMAN-5_manual-gate-human_0';
    const filePath = path.join(approvalsDir, `${stepId}.json`);
    const pending = {
      step_id: stepId,
      ticket_id: 'HUMAN-5',
      stage_id: 'manual-gate-human',
      attempt: 0,
      status: 'pending',
      created_at: '2026-08-04T22:00:00.000Z',
      updated_at: '2026-08-04T22:00:00.000Z',
      decided_by: null,
      comment: null,
      context_snapshot: { ticket_id: 'HUMAN-5', target: 'ready' }
    };
    fs.writeFileSync(filePath, JSON.stringify(pending, null, 2), 'utf8');
    const before = fs.readFileSync(filePath, 'utf8');

    const logs = [];
    const runner = createMinimalRunner(tmpDir, { ticket_id: 'HUMAN-5' }, { task_attempts: 0 }, logs);

    const result = await runner.executeManualGate('manual-gate-human', {
      type: 'manual-gate',
      poll_interval_ms: 30,
      timeout_seconds: 0.1,
      goto: { approved: 'next', rejected: 'rollback', timeout: 'end' }
    });

    assert.strictEqual(result.status, 'timeout');
    assert.strictEqual(
      fs.readFileSync(filePath, 'utf8'),
      before,
      'существующий pending-файл (в т.ч. created_at и context_snapshot) не должен перезаписываться'
    );
    assert.ok(
      logs.some(m => m.includes('reusing existing approval')),
      `лог должен сообщать о переиспользовании, а не о создании:\n${logs.join('\n')}`
    );
    assert.ok(
      !logs.some(m => m.includes('created pending approval')),
      `лог не должен утверждать о создании файла, которого не создавал:\n${logs.join('\n')}`
    );
  } finally {
    cleanup(tmpDir);
  }
});

test('FIX-70-006: первый заход на manual-gate по-прежнему создаёт pending-файл', async () => {
  const { tmpDir } = createTestEnv('fix-70-gate-');
  try {
    const approvalsDir = path.join(tmpDir, '.workflow', 'approvals');
    fs.mkdirSync(approvalsDir, { recursive: true });

    const logs = [];
    const runner = createMinimalRunner(tmpDir, { ticket_id: 'HUMAN-6' }, { task_attempts: 0 }, logs);

    const result = await runner.executeManualGate('manual-gate-human', {
      type: 'manual-gate',
      poll_interval_ms: 30,
      timeout_seconds: 0.1,
      goto: { approved: 'next', rejected: 'rollback', timeout: 'end' }
    });

    assert.strictEqual(result.status, 'timeout');
    const filePath = path.join(approvalsDir, 'HUMAN-6_manual-gate-human_0.json');
    assert.ok(fs.existsSync(filePath), 'pending-файл должен быть создан на первом заходе');
    assert.strictEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')).status, 'pending');
    assert.ok(
      logs.some(m => m.includes('created pending approval')),
      `первый заход должен логировать создание:\n${logs.join('\n')}`
    );
  } finally {
    cleanup(tmpDir);
  }
});
