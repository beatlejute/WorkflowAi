#!/usr/bin/env node

/**
 * FIX-69: рассинхрон status/ревью.
 *
 * Часть A — move-ticket.js синхронизирует frontmatter.status с целевой папкой.
 * Часть B — auto-correct в pick-next-task.js не откатывает из done/ тикет,
 *           у которого заполнен completed_at (штатное закрытие пайплайном).
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'url';
import { parseFrontmatter } from 'workflow-ai/lib/utils.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const MOVE_TICKET_PATH = path.join(PROJECT_ROOT, 'src', 'scripts', 'move-ticket.js');
const PICK_NEXT_TASK_PATH = path.join(PROJECT_ROOT, 'src', 'scripts', 'pick-next-task.js');
const MOVEMENT_RULES_SRC = path.join(PROJECT_ROOT, 'configs', 'ticket-movement-rules.yaml');

/**
 * Создаёт временную .workflow-структуру с копией правил перемещения тикетов.
 */
function createTempWorkflow(baseDir) {
  const workflowDir = path.join(baseDir, '.workflow');
  const ticketsDir = path.join(workflowDir, 'tickets');

  for (const dir of ['backlog', 'ready', 'in-progress', 'blocked', 'review', 'done', 'archive']) {
    fs.mkdirSync(path.join(ticketsDir, dir), { recursive: true });
  }
  fs.mkdirSync(path.join(workflowDir, 'config'), { recursive: true });
  fs.mkdirSync(path.join(workflowDir, 'plans', 'current'), { recursive: true });

  fs.copyFileSync(
    MOVEMENT_RULES_SRC,
    path.join(workflowDir, 'config', 'ticket-movement-rules.yaml')
  );

  return { workflowDir, ticketsDir };
}

/**
 * Пишет тикет в указанную колонку.
 * @param {string} ticketsDir - .workflow/tickets
 * @param {string} status - имя колонки
 * @param {string} ticketId - ID тикета
 * @param {object} opts - { frontmatterStatus, completedAt, reviewStatus }
 */
function writeTicket(ticketsDir, status, ticketId, opts = {}) {
  const { frontmatterStatus = status, completedAt = null, reviewStatus = null } = opts;

  let frontmatter = `---\nid: ${ticketId}\ntitle: Test ${ticketId}\nstatus: ${frontmatterStatus}\npriority: 2\ntype: impl\ncreated_at: "2026-08-04T10:00:00Z"\nupdated_at: "2026-08-04T10:00:00Z"\nconditions: []\ndependencies: []\ntags: []\n`;
  if (completedAt) {
    frontmatter += `completed_at: "${completedAt}"\n`;
  }
  frontmatter += '---\n';

  let body = `\n## Описание\n\nTest ticket ${ticketId}.\n`;
  if (reviewStatus) {
    const display = reviewStatus === 'failed' ? '❌ failed' : '✅ passed';
    body += `\n## Ревью\n\n| Дата | Статус | Самари | Агент |\n|------|--------|--------|-------|\n| 2026-08-04 15:32 | ${display} | Проверка | reviewer |\n`;
  }

  fs.writeFileSync(path.join(ticketsDir, status, `${ticketId}.md`), frontmatter + body, 'utf8');
}

function runScript(scriptPath, workdir, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [scriptPath, ...args], {
      cwd: workdir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('close', (code) => { resolve({ code, stdout, stderr }); });
    child.on('error', (err) => { reject(err); });

    setTimeout(() => reject(new Error(`Timeout: ${path.basename(scriptPath)} exceeded 10s`)), 10000);
  });
}

function readFrontmatter(filePath) {
  const { frontmatter } = parseFrontmatter(fs.readFileSync(filePath, 'utf8'));
  return frontmatter;
}

// ============================================================================
// Часть A — move-ticket.js синхронизирует frontmatter.status
// ============================================================================

test('FIX-69 A: move-ticket ready → in-progress проставляет status: in-progress', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix69-move-'));
  try {
    const { ticketsDir } = createTempWorkflow(tempDir);
    writeTicket(ticketsDir, 'ready', 'IMPL-A01', { frontmatterStatus: 'ready' });

    const result = await runScript(MOVE_TICKET_PATH, tempDir, ['IMPL-A01', 'in-progress']);
    assert.equal(result.code, 0, `move-ticket должен завершиться успешно: ${result.stdout}${result.stderr}`);

    const movedPath = path.join(ticketsDir, 'in-progress', 'IMPL-A01.md');
    assert(fs.existsSync(movedPath), 'Тикет должен лежать в in-progress/');

    const frontmatter = readFrontmatter(movedPath);
    assert.equal(frontmatter.status, 'in-progress', 'frontmatter.status должен быть синхронизирован с целевой папкой');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('FIX-69 A: move-ticket review → done проставляет status: done вместе с completed_at', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix69-move-'));
  try {
    const { ticketsDir } = createTempWorkflow(tempDir);
    writeTicket(ticketsDir, 'review', 'IMPL-A02', { frontmatterStatus: 'ready', reviewStatus: 'passed' });

    const result = await runScript(MOVE_TICKET_PATH, tempDir, ['IMPL-A02', 'done']);
    assert.equal(result.code, 0, `move-ticket должен завершиться успешно: ${result.stdout}${result.stderr}`);

    const frontmatter = readFrontmatter(path.join(ticketsDir, 'done', 'IMPL-A02.md'));
    assert.equal(frontmatter.status, 'done', 'В done/ не должно оставаться фантомного status: ready');
    assert(frontmatter.completed_at, 'completed_at должен быть проставлен');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ============================================================================
// Часть B — auto-correct не откатывает штатно закрытые тикеты
// ============================================================================

test('FIX-69 B: done-тикет с completed_at и failed-ревью НЕ откатывается auto-correct', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix69-pick-'));
  try {
    const { ticketsDir } = createTempWorkflow(tempDir);
    writeTicket(ticketsDir, 'done', 'HUMAN-4', {
      frontmatterStatus: 'done',
      completedAt: '2026-08-04T15:32:00Z',
      reviewStatus: 'failed',
    });

    const result = await runScript(PICK_NEXT_TASK_PATH, tempDir);

    assert(
      fs.existsSync(path.join(ticketsDir, 'done', 'HUMAN-4.md')),
      'Закрытый тикет должен остаться в done/'
    );
    assert(
      !fs.existsSync(path.join(ticketsDir, 'backlog', 'HUMAN-4.md')),
      'Закрытый тикет не должен уехать в backlog/'
    );
    assert.match(
      result.stdout + result.stderr,
      /\[AUTO-CORRECT\] HUMAN-4: skipped \(completed_at=/,
      'Пропуск авто-коррекции должен быть залогирован'
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('FIX-69 B: done-тикет с completed_at и БЕЗ секции ревью тоже НЕ откатывается', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix69-pick-'));
  try {
    const { ticketsDir } = createTempWorkflow(tempDir);
    writeTicket(ticketsDir, 'done', 'HUMAN-5', {
      frontmatterStatus: 'done',
      completedAt: '2026-08-04T18:31:00Z',
      reviewStatus: null,
    });

    await runScript(PICK_NEXT_TASK_PATH, tempDir);

    assert(
      fs.existsSync(path.join(ticketsDir, 'done', 'HUMAN-5.md')),
      'Тикет без записи ревью, но с completed_at, должен остаться в done/'
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('FIX-69 B (регресс): done-тикет БЕЗ completed_at с failed-ревью по-прежнему откатывается', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix69-pick-'));
  try {
    const { ticketsDir } = createTempWorkflow(tempDir);
    writeTicket(ticketsDir, 'done', 'IMPL-B03', {
      frontmatterStatus: 'done',
      completedAt: null,
      reviewStatus: 'failed',
    });

    const result = await runScript(PICK_NEXT_TASK_PATH, tempDir);

    assert(
      !fs.existsSync(path.join(ticketsDir, 'done', 'IMPL-B03.md')),
      'Тикет без completed_at должен уехать из done/'
    );
    assert(
      fs.existsSync(path.join(ticketsDir, 'backlog', 'IMPL-B03.md')),
      'Тикет без completed_at должен быть откачен в backlog/'
    );
    assert.match(
      result.stdout + result.stderr,
      /\[AUTO-CORRECT\] IMPL-B03: done → backlog \(review failed\)/,
      'Откат должен быть залогирован как раньше'
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
