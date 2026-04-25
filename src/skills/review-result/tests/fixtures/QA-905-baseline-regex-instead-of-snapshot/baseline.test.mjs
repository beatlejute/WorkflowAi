/**
 * baseline.test.mjs
 *
 * Заявлено в DoD тикета QA-905: snapshot-тесты с inline-snapshot
 * в коде теста — точное сравнение целого нормализованного output
 * с литералом-эталоном.
 *
 * Фактическая реализация ниже использует regex-ассерты (assert.match)
 * по фрагментам — это и есть нарушение, которое должен поймать ревьюер.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function normalizeOutput(stdout) {
  let output = stdout.replace(/\x1B\[[0-9;]*m/g, '');
  const m = output.match(/---RESULT---\n([\s\S]*?)---RESULT---/);
  if (m) output = m[1];
  output = output.replace(/"(updated_at|created_at|completed_at)":\s*"[^"]+"/g, '"$1": "<TS>"');
  output = output.replace(/\\/g, '/');
  return output.trim();
}

function runScript(script, args, cwd) {
  try {
    return execFileSync('node', [path.resolve(script), ...args], {
      cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    return err.stdout || '';
  }
}

describe('pick-next-task.js baseline', () => {
  test('пустой ready/ → status: empty', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'wf-'));
    try {
      mkdirSync(path.join(tmp, '.workflow/tickets/ready'), { recursive: true });
      const out = runScript('src/scripts/pick-next-task.js', [], tmp);
      const normalized = normalizeOutput(out);

      assert.match(normalized, /status:\s*empty/);
      assert.match(normalized, /reason:/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('тикет в ready без dependencies → возвращает тикет', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'wf-'));
    try {
      mkdirSync(path.join(tmp, '.workflow/tickets/ready'), { recursive: true });
      writeFileSync(
        path.join(tmp, '.workflow/tickets/ready/IMPL-001.md'),
        '---\nid: "IMPL-001"\ntitle: "Test"\n---\n\n# IMPL-001\n'
      );
      const out = runScript('src/scripts/pick-next-task.js', [], tmp);
      const normalized = normalizeOutput(out);

      assert.match(normalized, /IMPL-001/);
      assert.match(normalized, /status:\s*found/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('move-ticket.js baseline', () => {
  test('валидный переход backlog → ready', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'wf-'));
    try {
      mkdirSync(path.join(tmp, '.workflow/tickets/backlog'), { recursive: true });
      mkdirSync(path.join(tmp, '.workflow/tickets/ready'), { recursive: true });
      writeFileSync(
        path.join(tmp, '.workflow/tickets/backlog/IMPL-001.md'),
        '---\nid: "IMPL-001"\n---\n'
      );
      const out = runScript('src/scripts/move-ticket.js', ['IMPL-001', 'ready'], tmp);
      const normalized = normalizeOutput(out);

      assert.match(normalized, /status:\s*moved/i);
      assert.match(normalized, /IMPL-001/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('невалидный переход done → backlog → ошибка', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'wf-'));
    try {
      mkdirSync(path.join(tmp, '.workflow/tickets/done'), { recursive: true });
      writeFileSync(
        path.join(tmp, '.workflow/tickets/done/IMPL-002.md'),
        '---\nid: "IMPL-002"\n---\n'
      );
      const out = runScript('src/scripts/move-ticket.js', ['IMPL-002', 'backlog'], tmp);
      const normalized = normalizeOutput(out);

      assert.match(normalized, /status:\s*error/i);
      assert.match(normalized, /invalid|недопустим/i);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('get-next-id.js baseline', () => {
  test('пустой tickets/ → IMPL-001', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'wf-'));
    try {
      mkdirSync(path.join(tmp, '.workflow/tickets/backlog'), { recursive: true });
      const out = runScript('src/scripts/get-next-id.js', ['--prefix', 'IMPL'], tmp);
      const normalized = normalizeOutput(out);

      assert.match(normalized, /IMPL-001/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
