import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, utimesSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..', '..');
const SCRIPT = join(PROJECT_ROOT, 'src', 'skills', 'review-result', 'scripts', 'verify-artifacts.js');

function runScript(ticketPath) {
  const out = execFileSync('node', [SCRIPT, ticketPath], { encoding: 'utf8' });
  const block = out.match(/---RESULT---([\s\S]*?)---RESULT---/);
  assert.ok(block, `verify-artifacts не выдал RESULT-блок:\n${out}`);
  const fields = {};
  for (const line of block[1].split('\n')) {
    const m = line.match(/^\s*([a-z_]+):\s*(.*)$/i);
    if (m) fields[m[1]] = m[2].trim();
  }
  return fields;
}

function makeTicket(dir, { id, createdAt, updatedAt, deliverablePath, dod }) {
  mkdirSync(dir, { recursive: true });
  const ticketPath = join(dir, `${id}.md`);
  const content = `---
id: ${id}
title: "fixture"
priority: 3
type: impl
required_capabilities: []
created_at: "${createdAt}"
updated_at: "${updatedAt}"
completed_at: "${updatedAt}"
parent_plan: ""
parent_task: ""
dependencies: []
conditions: []
context:
  files: []
  references: []
  notes: ""
complexity: simple
tags: []
---
## Описание

fixture

## Критерии готовности (Definition of Done)

${dod}

## Результат выполнения

### Summary
fixture summary.

### Изменённые файлы

- \`${deliverablePath}\`
`;
  writeFileSync(ticketPath, content, 'utf8');
  return ticketPath;
}

test('verify-artifacts: файл с mtime между created_at и updated_at проходит (retry-цикл)', () => {
  const tmpDir = join(PROJECT_ROOT, '.tmp-verify-artifacts-retry');
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  const deliverableRel = '.tmp-verify-artifacts-retry/deliverable.txt';
  const deliverableAbs = join(PROJECT_ROOT, deliverableRel);
  writeFileSync(deliverableAbs, 'payload', 'utf8');

  // Симуляция retry-цикла:
  //   created_at = момент создания тикета (00:00)
  //   файл модифицирован агентом в attempt 2   (05:00)
  //   updated_at = последний move-ticket при retry (10:00, обновлён move-to-ready
  //     после возврата из blocked → ready → in-progress)
  const createdAt = new Date('2026-04-21T00:00:00Z');
  const fileMtime = new Date('2026-04-21T05:00:00Z');
  const updatedAt = new Date('2026-04-21T10:00:00Z');
  utimesSync(deliverableAbs, fileMtime, fileMtime);

  const ticketPath = makeTicket(tmpDir, {
    id: 'QA-901',
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    deliverablePath: deliverableRel,
    dod: '- [x] deliverable создан',
  });

  try {
    const result = runScript(ticketPath);
    assert.equal(
      result.status,
      'passed',
      `Ожидался passed, получили ${result.status}. fail_reasons=${result.fail_reasons || ''}`
    );
    assert.equal(result.unchanged_files, '', 'unchanged_files должен быть пустым');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('verify-artifacts: файл с mtime до created_at валит (ghost execution — агент не трогал файл)', () => {
  const tmpDir = join(PROJECT_ROOT, '.tmp-verify-artifacts-ghost');
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  const deliverableRel = '.tmp-verify-artifacts-ghost/deliverable.txt';
  const deliverableAbs = join(PROJECT_ROOT, deliverableRel);
  writeFileSync(deliverableAbs, 'payload', 'utf8');

  const fileMtime = new Date('2026-04-20T00:00:00Z');
  const createdAt = new Date('2026-04-21T00:00:00Z');
  const updatedAt = new Date('2026-04-21T10:00:00Z');
  utimesSync(deliverableAbs, fileMtime, fileMtime);

  const ticketPath = makeTicket(tmpDir, {
    id: 'QA-902',
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    deliverablePath: deliverableRel,
    dod: '- [x] deliverable создан',
  });

  try {
    const result = runScript(ticketPath);
    assert.equal(result.status, 'failed', 'Ожидался failed по unchanged');
    assert.match(
      result.unchanged_files || '',
      /deliverable\.txt/,
      'deliverable должен быть в unchanged_files'
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('verify-artifacts: отсутствующий файл всегда валит (missing)', () => {
  const tmpDir = join(PROJECT_ROOT, '.tmp-verify-artifacts-missing');
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  const ticketPath = makeTicket(tmpDir, {
    id: 'QA-903',
    createdAt: '2026-04-21T00:00:00Z',
    updatedAt: '2026-04-21T10:00:00Z',
    deliverablePath: '.tmp-verify-artifacts-missing/does-not-exist.txt',
    dod: '- [x] deliverable создан',
  });

  try {
    const result = runScript(ticketPath);
    assert.equal(result.status, 'failed');
    assert.match(result.missing_files || '', /does-not-exist\.txt/);
    assert.ok(
      !existsSync(join(PROJECT_ROOT, '.tmp-verify-artifacts-missing', 'does-not-exist.txt')),
      'sanity: файл действительно отсутствует'
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
