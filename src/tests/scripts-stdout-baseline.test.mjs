/**
 * scripts-stdout-baseline.test.mjs
 *
 * Snapshot-тесты для baseline stdout CLI-скриптов ДО рефакторинга.
 * Эти тесты фиксируют эталонный output и служат reference при рефакторинге.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Нормализует stdout скрипта для snapshot-сравнения:
 * - timestamp-поля заменяются на <TS>
 * - пути с \ заменяются на /
 * - удаляет ANSI-коды цветов
 * - извлекает только блок ---RESULT---
 */
function normalizeOutput(stdout) {
  // Удаляем ANSI-коды цветов
  let output = stdout.replace(/\x1B\[[0-9;]*m/g, '');

  // Извлекаем блок ---RESULT---
  const resultMatch = output.match(/---RESULT---\n([\s\S]*?)---RESULT---/);
  if (resultMatch) {
    output = resultMatch[1];
  }

  // Нормализация timestamp-полей
  output = output.replace(/"(updated_at|created_at|completed_at)":\s*"[^"]+"/g, '"$1": "<TS>"');

  // Нормализация пути
  output = output.replace(/\\/g, '/');

  // Удаляем строки со временем логирования
  output = output.split('\n')
    .filter(line => !line.match(/\[\d{4}-\d{2}-\d{2}/))
    .join('\n')
    .trim();

  return output;
}

/**
 * Безопасно выполняет скрипт и возвращает stdout (игнорирует exit code)
 */
function runScript(script, args, cwd) {
  try {
    return execFileSync('node', [path.resolve(script), ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    // Возвращаем stdout даже если exit code 1
    return err.stdout || '';
  }
}

/**
 * Создаёт минимальную структуру .workflow для тестов
 */
function createWorkflowStructure(projectDir) {
  const dirs = [
    '.workflow',
    '.workflow/tickets',
    '.workflow/tickets/backlog',
    '.workflow/tickets/ready',
    '.workflow/tickets/in-progress',
    '.workflow/tickets/review',
    '.workflow/tickets/done',
    '.workflow/tickets/blocked',
    '.workflow/tickets/archive',
    '.workflow/plans',
    '.workflow/plans/current',
    '.workflow/plans/archive',
    '.workflow/config',
    '.workflow/metrics',
  ];

  dirs.forEach(dir => {
    mkdirSync(path.join(projectDir, dir), { recursive: true });
  });

  // Создаём минимальный config.yaml
  const configContent = `task_types:
  IMPL:
    prefix: IMPL
  QA:
    prefix: QA
  FIX:
    prefix: FIX
  REVIEW:
    prefix: REVIEW
`;
  writeFileSync(path.join(projectDir, '.workflow/config/config.yaml'), configContent);

  // Создаём ticket-movement-rules.yaml
  const rulesContent = `transitions:
  backlog:
    - ready
    - blocked
    - done
  ready:
    - in-progress
    - review
    - backlog
  in-progress:
    - done
    - blocked
    - review
  blocked:
    - ready
  review:
    - done
    - ready
    - in-progress
    - blocked
  done:
    - ready
    - blocked
    - archive
  archive:
    - backlog
`;
  writeFileSync(path.join(projectDir, '.workflow/config/ticket-movement-rules.yaml'), rulesContent);
}

/**
 * Создаёт тикет с фронтматтером
 */
function createTicket(projectDir, dir, id, data = {}) {
  const defaults = {
    id,
    title: `Test ticket ${id}`,
    type: 'impl',
    created_at: '2026-04-24T10:00:00Z',
    updated_at: '2026-04-24T10:00:00Z',
    completed_at: '',
    ...data,
  };

  const frontmatter = Object.entries(defaults)
    .map(([k, v]) => `${k}: "${v}"`)
    .join('\n');

  const content = `---
${frontmatter}
---

# ${id}

Test content`;

  const filePath = path.join(projectDir, `.workflow/tickets/${dir}/${id}.md`);
  writeFileSync(filePath, content);
}

describe('pick-next-task.js baseline', () => {
  let tmpDir;
  let projectRoot;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'workflow-test-'));
    projectRoot = tmpDir;
    createWorkflowStructure(projectRoot);
  });

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('pick-next-task: пустой ready/ → status: empty', () => {
    const result = runScript('src/scripts/pick-next-task.js', [], projectRoot);
    const normalized = normalizeOutput(result);

    assert.match(normalized, /status:\s*empty/);
    assert.match(normalized, /reason:/);
  });

  test('pick-next-task: тикет в ready без dependencies → возвращает тикет', () => {
    createTicket(projectRoot, 'ready', 'IMPL-001');

    const result = runScript('src/scripts/pick-next-task.js', [], projectRoot);
    const normalized = normalizeOutput(result);

    assert.match(normalized, /IMPL-001/);
    assert.match(normalized, /status:\s*found/);
  });

  test('pick-next-task: несколько тикетов в ready → первый возвращается', () => {
    createTicket(projectRoot, 'ready', 'IMPL-002');
    createTicket(projectRoot, 'ready', 'IMPL-003');

    const result = runScript('src/scripts/pick-next-task.js', [], projectRoot);
    const normalized = normalizeOutput(result);

    // Должен вернуть первый тикет
    assert.match(normalized, /status:\s*found/);
    assert.match(normalized, /(IMPL-002|IMPL-003)/);
  });
});

describe('move-ticket.js baseline', () => {
  let tmpDir;
  let projectRoot;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'workflow-test-'));
    projectRoot = tmpDir;
    createWorkflowStructure(projectRoot);
  });

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('move-ticket: валидный переход backlog → ready', () => {
    createTicket(projectRoot, 'backlog', 'IMPL-001');

    const result = runScript('src/scripts/move-ticket.js', ['IMPL-001', 'ready'], projectRoot);
    const normalized = normalizeOutput(result);

    assert.match(normalized, /status:\s*moved/i);
    assert.match(normalized, /IMPL-001/);
  });

  test('move-ticket: невалидный переход done → backlog → ошибка', () => {
    createTicket(projectRoot, 'done', 'IMPL-002');

    const result = runScript('src/scripts/move-ticket.js', ['IMPL-002', 'backlog'], projectRoot);
    const normalized = normalizeOutput(result);

    assert.match(normalized, /status:\s*error/i);
    assert.match(normalized, /недопустим|invalid/i);
  });

  test('move-ticket: отсутствующий id → ошибка', () => {
    const result = runScript('src/scripts/move-ticket.js', ['IMPL-999', 'ready'], projectRoot);
    const normalized = normalizeOutput(result);

    assert.match(normalized, /status:\s*error/i);
    assert.match(normalized, /не найден|not found/i);
  });
});

describe('get-next-id.js baseline', () => {
  let tmpDir;
  let projectRoot;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'workflow-test-'));
    projectRoot = tmpDir;
    createWorkflowStructure(projectRoot);
  });

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('get-next-id: пустой tickets/ → IMPL-001', () => {
    const result = runScript('src/scripts/get-next-id.js', ['--prefix', 'IMPL', '--dir', 'tickets'], projectRoot);
    const normalized = normalizeOutput(result);

    assert.match(normalized, /IMPL-001/);
    assert.match(normalized, /status:\s*success/i);
  });

  test('get-next-id: существуют IMPL-001, IMPL-003 (gap) → IMPL-004', () => {
    createTicket(projectRoot, 'backlog', 'IMPL-001');
    createTicket(projectRoot, 'backlog', 'IMPL-003');

    const result = runScript('src/scripts/get-next-id.js', ['--prefix', 'IMPL', '--dir', 'tickets'], projectRoot);
    const normalized = normalizeOutput(result);

    assert.match(normalized, /IMPL-004/);
  });

  test('get-next-id: --all-from-config возвращает id_ranges', () => {
    createTicket(projectRoot, 'backlog', 'IMPL-001');
    createTicket(projectRoot, 'backlog', 'QA-001');

    const result = runScript('src/scripts/get-next-id.js', ['--all-from-config'], projectRoot);
    const normalized = normalizeOutput(result);

    // Должны содержать id_ranges с IMPL и QA
    assert.match(normalized, /id_ranges/i);
    assert.match(normalized, /IMPL/);
    assert.match(normalized, /QA/);
  });

  test('get-next-id: несколько типов независимых инкрементов', () => {
    createTicket(projectRoot, 'backlog', 'IMPL-001');
    createTicket(projectRoot, 'backlog', 'IMPL-005');
    createTicket(projectRoot, 'backlog', 'QA-001');
    createTicket(projectRoot, 'backlog', 'QA-002');

    const resultImpl = runScript('src/scripts/get-next-id.js', ['--prefix', 'IMPL', '--dir', 'tickets'], projectRoot);
    const resultQa = runScript('src/scripts/get-next-id.js', ['--prefix', 'QA', '--dir', 'tickets'], projectRoot);

    const normalizedImpl = normalizeOutput(resultImpl);
    const normalizedQa = normalizeOutput(resultQa);

    assert.match(normalizedImpl, /IMPL-006/);
    assert.match(normalizedQa, /QA-003/);
  });
});
