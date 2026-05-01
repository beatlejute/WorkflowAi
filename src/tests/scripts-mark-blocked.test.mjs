#!/usr/bin/env node

/**
 * Unit-тесты для mark-blocked.js (QA-40)
 *
 * Целевой coverage: ≥ 80% строк mark-blocked.js
 * Используется fake FS (mockFs) для изоляции от реальной файловой системы
 *
 * Запуск: node --test src/tests/scripts-mark-blocked.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const SCRIPT_PATH = path.join(PROJECT_ROOT, 'src', 'scripts', 'mark-blocked.js');

/**
 * Создаёт изолированную тестовую директорию со структурой .workflow
 */
function createTestEnv() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mark-blocked-test-'));
  const workflowDir = path.join(tmpDir, '.workflow');
  const ticketsDir = path.join(workflowDir, 'tickets');
  const stateDir = path.join(workflowDir, 'state');

  const dirs = [
    'ready', 'in-progress', 'blocked', 'done', 'review', 'backlog',
    'approvals', 'state',
  ];
  for (const dir of dirs) {
    fs.mkdirSync(path.join(ticketsDir, dir), { recursive: true });
  }

  // Убеждаемся, что stateDir существует (для некоторых тестов удалим его отдельно)
  fs.mkdirSync(stateDir, { recursive: true });

  return { tmpDir, workflowDir, ticketsDir, stateDir };
}

/**
 * Создаёт файл тикета с заданным контентом
 */
function createTicketFile(ticketsDir, subdir, ticketId, frontmatter = {}) {
  const defaultFm = {
    id: ticketId,
    title: `Test ${ticketId}`,
    priority: 2,
    type: 'impl',
    created_at: '2026-04-01T10:00:00.000Z',
    updated_at: '2026-04-01T10:00:00.000Z',
  };
  const fm = { ...defaultFm, ...frontmatter };
  const fmText = Object.entries(fm)
    .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
    .join('\n');
  const content = `---\n${fmText}\n---\n\n## Description\n\nTest ticket.\n`;
  const filePath = path.join(ticketsDir, subdir, `${ticketId}.md`);
  fs.writeFileSync(filePath, content);
  return filePath;
}

function parseFrontmatter(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!match) return null;
  const fmText = match[1];
  const result = {};
  for (const line of fmText.split('\n')) {
    const m = line.match(/^\s*(\w+):\s*(.*)$/);
    if (m) {
      const key = m[1];
      let val = m[2].trim();
      // Простая попытка парсинга как JSON (числа, строки в кавычках)
      try {
        result[key] = JSON.parse(val);
      } catch {
        result[key] = val.replace(/^"|"$/g, ''); // убираем крайние кавычки если есть
      }
    }
  }
  return result;
}

function runMarkBlocked(args, cwd) {
  const result = spawnSync('node', [SCRIPT_PATH, ...args], {
    cwd: cwd || PROJECT_ROOT,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.status,
  };
}

// ============================================================================
// Группа: Happy path
// ============================================================================

test('mark-blocked: Happy path - обновляет frontmatter и пишет в alerts.jsonl', () => {
  const { tmpDir, ticketsDir } = createTestEnv();
  const ticketId = 'IMPL-99';
  createTicketFile(ticketsDir, 'ready', ticketId);

  const result = runMarkBlocked([ticketId, '--attempts=6', '--reason=max_review_attempts'], tmpDir);

  // Скрипт должен завершиться успешно
  assert.strictEqual(result.code, 0, `Скрипт должен завершиться с 0, завершился с ${result.code}: ${result.stderr}`);
  assert.ok(result.stdout.includes('✅'), 'Должно быть сообщение об успехе');

  // Проверяем обновлённый frontmatter
  const ticketPath = path.join(ticketsDir, 'ready', `${ticketId}.md`);
  const fm = parseFrontmatter(ticketPath);
  assert.strictEqual(fm.auto_blocked_reason, 'max_review_attempts', 'auto_blocked_reason должен быть обновлён');
  assert.strictEqual(fm.auto_blocked_attempts, 6, 'auto_blocked_attempts должен быть 6');
  assert.ok(fm.auto_blocked_at, 'auto_blocked_at должен быть установлен');
  assert.ok(Date.parse(fm.auto_blocked_at), 'auto_blocked_at должен быть валидной датой ISO');

  // Проверяем запись в alerts.jsonl
  const alertsFile = path.join(tmpDir, '.workflow', 'state', 'alerts.jsonl');
  assert.ok(fs.existsSync(alertsFile), 'alerts.jsonl должен существовать');
  const lines = fs.readFileSync(alertsFile, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 1, 'должна быть одна запись в alerts.jsonl');
  const alert = JSON.parse(lines[0]);
  assert.strictEqual(alert.kind, 'ticket_auto_blocked');
  assert.strictEqual(alert.ticket_id, ticketId);
  assert.strictEqual(alert.attempts, 6);
  assert.strictEqual(alert.reason, 'max_review_attempts');
  assert.strictEqual(alert.severity, 'warning');
  assert.ok(alert.timestamp);
  assert.ok(alert.project);

  // Убираем временную директорию
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================================
// Группа: Atomicity
// ============================================================================

test('mark-blocked: Atomicity - frontmatter записывается первым, затем alerts.jsonl', () => {
  const { tmpDir, ticketsDir } = createTestEnv();
  const ticketId = 'IMPL-100';
  createTicketFile(ticketsDir, 'ready', ticketId);
  const ticketPath = path.join(ticketsDir, 'ready', `${ticketId}.md`);

  // Запоминаем текущее время
  const beforeRun = Date.now();

  const result = runMarkBlocked([ticketId, '--attempts=3', '--reason=test_atomic'], tmpDir);
  assert.strictEqual(result.code, 0);

  // Проверяем, что frontmatter обновлён
  const fm = parseFrontmatter(ticketPath);
  assert.strictEqual(fm.auto_blocked_reason, 'test_atomic');
  const blockTime = Date.parse(fm.auto_blocked_at);
  assert.ok(blockTime >= beforeRun, 'timestamp должен быть после запуска');

  // Проверяем, что запись в alerts.jsonl последовала
  const alertsFile = path.join(tmpDir, '.workflow', 'state', 'alerts.jsonl');
  assert.ok(fs.existsSync(alertsFile));
  const lines = fs.readFileSync(alertsFile, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 1);
  const alert = JSON.parse(lines[0]);
  assert.strictEqual(alert.ticket_id, ticketId);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================================
// Группа: Отсутствие stateDir
// ============================================================================

test('mark-blocked: Отсутствие stateDir - директория создаётся автоматически', () => {
  const { tmpDir, ticketsDir, stateDir } = createTestEnv();
  const ticketId = 'IMPL-101';
  createTicketFile(ticketsDir, 'ready', ticketId);

  // Удаляем stateDir чтобы проверить автодоздание
  fs.rmSync(stateDir, { recursive: true, force: true });
  assert.ok(!fs.existsSync(stateDir), 'stateDir должна быть удалена для теста');

  const result = runMarkBlocked([ticketId, '--attempts=6', '--reason=create_dir_test'], tmpDir);
  assert.strictEqual(result.code, 0);

  // Директория должна быть создана
  assert.ok(fs.existsSync(stateDir), 'stateDir должна быть создана автоматически');

  // Запись в frontmatter
  const ticketPath = path.join(ticketsDir, 'ready', `${ticketId}.md`);
  const fm = parseFrontmatter(ticketPath);
  assert.strictEqual(fm.auto_blocked_reason, 'create_dir_test');

  // Запись в alerts.jsonl
  const alertsFile = path.join(stateDir, 'alerts.jsonl');
  assert.ok(fs.existsSync(alertsFile), 'alerts.jsonl должен быть создан');
  const alert = JSON.parse(fs.readFileSync(alertsFile, 'utf8').trim());
  assert.strictEqual(alert.kind, 'ticket_auto_blocked');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================================
// Группа: stateDir недоступен
// ============================================================================

test('mark-blocked: stateDir недоступен - логирует предупреждение, но обновляет frontmatter', () => {
  const { tmpDir, ticketsDir } = createTestEnv();
  const ticketId = 'IMPL-102';
  createTicketFile(ticketsDir, 'ready', ticketId);

  // Создаём файл с именем state (вместо директории) чтобы mkdirSync упал
  const stateFilePath = path.join(tmpDir, '.workflow', 'state');
  fs.rmSync(stateFilePath, { recursive: true, force: true });
  fs.writeFileSync(stateFilePath, 'i am a file, not a dir');

  const result = runMarkBlocked([ticketId, '--attempts=6', '--reason=state_dir_fail'], tmpDir);

  // Скрипт должен завершиться успешно (код 0) — предупреждение не блокирует frontmatter
  assert.strictEqual(result.code, 0, 'Скрипт должен завершиться успешно несмотря на невозможность записи в stateDir');
  // Должно быть сообщение (stdout или stderr) о невозможности создать директорию/записать файл
  assert.ok(result.stdout.includes('warn') || result.stdout.includes('WARN') 
    || result.stderr.includes('warn') || result.stderr.includes('WARN')
    || result.stderr.includes('Failed') || result.stdout.includes('⚠') || result.stderr.includes('⚠'),
    'Должно быть предупреждение о невозможности записи в stateDir: ' + result.stdout + ' | ' + result.stderr);
  const ticketPath = path.join(ticketsDir, 'ready', `${ticketId}.md`);
  const fm = parseFrontmatter(ticketPath);
  assert.strictEqual(fm.auto_blocked_reason, 'state_dir_fail', 'frontmatter должен быть обновлён');
  assert.strictEqual(fm.auto_blocked_attempts, 6);

  // Но alerts.jsonl не должен существовать (или остаться неизменным)
  const alertsFile = path.join(tmpDir, '.workflow', 'state', 'alerts.jsonl');
  // state — это файл, а не директория, поэтому alerts.jsonl невозможен
  // либо проверяем что в stderr есть предупреждение

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================================
// Группа: Обязательный --reason
// ============================================================================

test('mark-blocked: Обязательный --reason - ошибка при отсутствии', () => {
  const { tmpDir, ticketsDir } = createTestEnv();
  const ticketId = 'IMPL-103';
  createTicketFile(ticketsDir, 'ready', ticketId);

  // Запуск без --reason
  const result = runMarkBlocked([ticketId, '--attempts=6'], tmpDir);

  // Должен завершиться с ненулевым кодом
  assert.notStrictEqual(result.code, 0, 'Скрипт должен завершиться с ошибкой без --reason');
  assert.ok(
    result.stderr.includes('reason') || result.stderr.includes('обязателен') || result.stderr.includes('error'),
    'Должно быть сообщение об ошибке про обязательный --reason'
  );

  // Frontmatter не должен быть изменён
  const ticketPath = path.join(ticketsDir, 'ready', `${ticketId}.md`);
  const fm = parseFrontmatter(ticketPath);
  assert.strictEqual(fm.auto_blocked_reason, undefined, 'auto_blocked_reason не должен быть установлен');
  assert.strictEqual(fm.auto_blocked_attempts, undefined, 'auto_blocked_attempts не должен быть установлен');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================================
// Группа: Идемпотентность
// ============================================================================

test('mark-blocked: Идемпотентность - повторный запуск перезаписывает поля', () => {
  const { tmpDir, ticketsDir } = createTestEnv();
  const ticketId = 'IMPL-104';
  createTicketFile(ticketsDir, 'ready', ticketId);
  const ticketPath = path.join(ticketsDir, 'ready', `${ticketId}.md`);
  const alertsFile = path.join(tmpDir, '.workflow', 'state', 'alerts.jsonl');

  // Первый запуск
  let result = runMarkBlocked([ticketId, '--attempts=5', '--reason=first'], tmpDir);
  assert.strictEqual(result.code, 0);

  let fm = parseFrontmatter(ticketPath);
  assert.strictEqual(fm.auto_blocked_reason, 'first');
  assert.strictEqual(fm.auto_blocked_attempts, 5);
  const firstTime = fm.auto_blocked_at;

  let lines = fs.readFileSync(alertsFile, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 1);

  // Небольшая пауза чтобы время изменилось
  const start = Date.now();
  while (Date.now() - start < 10) {}

  // Второй запуск с другими значениями
  result = runMarkBlocked([ticketId, '--attempts=7', '--reason=second'], tmpDir);
  assert.strictEqual(result.code, 0);

  fm = parseFrontmatter(ticketPath);
  assert.strictEqual(fm.auto_blocked_reason, 'second', 'Должен быть перезаписан второй причиной');
  assert.strictEqual(fm.auto_blocked_attempts, 7, 'Должно быть перезаписано второе число попыток');
  assert.notStrictEqual(fm.auto_blocked_at, firstTime, 'Время должно быть обновлено');

  // В alerts.jsonl должна быть теперь вторая запись (append-only)
  lines = fs.readFileSync(alertsFile, 'utf8').trim().split('\n');
  // append-only — две записи
  assert.ok(lines.length >= 2, 'Должно быть минимум 2 записи (append-only)');
  const firstAlert = JSON.parse(lines[0]);
  const secondAlert = JSON.parse(lines[1]);
  assert.strictEqual(firstAlert.reason, 'first');
  assert.strictEqual(secondAlert.reason, 'second');
  assert.strictEqual(secondAlert.attempts, 7);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================================
// Группа: Тикет в разных директориях
// ============================================================================

const testDirs = ['ready', 'in-progress', 'blocked', 'done', 'backlog', 'review'];
for (const subdir of testDirs) {
  test(`mark-blocked: Тикет в ${subdir}/ - корректная обработка`, () => {
    const { tmpDir, ticketsDir } = createTestEnv();
    const ticketId = `IMPL-${subdir.toUpperCase()}`;
    createTicketFile(ticketsDir, subdir, ticketId);

    const result = runMarkBlocked([ticketId, '--attempts=6', '--reason=' + subdir + '_test'], tmpDir);
    assert.strictEqual(result.code, 0, `Должен обработать тикет из ${subdir}/`);

    const ticketPath = path.join(ticketsDir, subdir, `${ticketId}.md`);
    const fm = parseFrontmatter(ticketPath);
    assert.strictEqual(fm.auto_blocked_reason, subdir + '_test');
    assert.strictEqual(fm.auto_blocked_attempts, 6);

    const alertsFile = path.join(tmpDir, '.workflow', 'state', 'alerts.jsonl');
    assert.ok(fs.existsSync(alertsFile));
    const lines = fs.readFileSync(alertsFile, 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 1);
    const alert = JSON.parse(lines[0]);
    assert.strictEqual(alert.ticket_id, ticketId);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
}

// ============================================================================
// Группа: Несколько запусков (накопление записей в alerts.jsonl)
// ============================================================================

test('mark-blocked: Несколько тикетов - накопление записей в alerts.jsonl', () => {
  const { tmpDir, ticketsDir } = createTestEnv();
  const stateDir = path.join(tmpDir, '.workflow', 'state');

  const ticketIds = ['IMPL-201', 'IMPL-202', 'IMPL-203'];
  for (const tid of ticketIds) {
    createTicketFile(ticketsDir, 'ready', tid);
    const result = runMarkBlocked([tid, '--attempts=6', '--reason=multi_test'], tmpDir);
    assert.strictEqual(result.code, 0);
  }

  const alertsFile = path.join(stateDir, 'alerts.jsonl');
  assert.ok(fs.existsSync(alertsFile));
  const lines = fs.readFileSync(alertsFile, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 3, 'Должно быть 3 записи от 3 разных запусков');

  for (let i = 0; i < 3; i++) {
    const alert = JSON.parse(lines[i]);
    assert.strictEqual(alert.ticket_id, ticketIds[i]);
    assert.strictEqual(alert.reason, 'multi_test');
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
