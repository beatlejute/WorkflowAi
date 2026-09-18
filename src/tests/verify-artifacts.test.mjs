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

// ============================================================================
// FIX-68: битая точка отсчёта (created_at в будущем).
// LLM-агенты пишут в created_at локальное время с суффиксом Z — тогда ЛЮБОЙ
// свежий артефакт формально «старше» тикета и ложно попадает в unchanged_files.
// ============================================================================

const HOUR_MS = 60 * 60 * 1000;

test('verify-artifacts: created_at в будущем + свежий файл → unchanged не выставляется', () => {
  const tmpDir = join(PROJECT_ROOT, '.tmp-verify-artifacts-future-created');
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  const deliverableRel = '.tmp-verify-artifacts-future-created/deliverable.txt';
  const deliverableAbs = join(PROJECT_ROOT, deliverableRel);
  writeFileSync(deliverableAbs, 'payload', 'utf8');

  // Живой кейс HUMAN-5: агент записал локальное время (+5ч) с суффиксом Z
  // в обе метки, файл при этом реально изменён только что.
  const now = Date.now();
  const brokenStamp = new Date(now + 5 * HOUR_MS);
  const fileMtime = new Date(now - 60 * 1000);
  utimesSync(deliverableAbs, fileMtime, fileMtime);

  const ticketPath = makeTicket(tmpDir, {
    id: 'QA-904',
    createdAt: brokenStamp.toISOString(),
    updatedAt: brokenStamp.toISOString(),
    deliverablePath: deliverableRel,
    dod: '- [x] deliverable создан',
  });

  try {
    const result = runScript(ticketPath);
    assert.equal(
      result.unchanged_files,
      '',
      `unchanged_files должен быть пустым при битой метке, получили "${result.unchanged_files}"`
    );
    assert.doesNotMatch(
      result.fail_reasons || '',
      /file_unchanged/,
      'не должно быть fail по file_unchanged'
    );
    assert.equal(
      result.status,
      'passed',
      `Ожидался passed, получили ${result.status}. fail_reasons=${result.fail_reasons || ''}`
    );
    assert.match(result.warnings || '', /created_at/, 'должно быть предупреждение о битой метке');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('verify-artifacts: created_at в будущем → fallback на updated_at (unchanged всё ещё детектится)', () => {
  const tmpDir = join(PROJECT_ROOT, '.tmp-verify-artifacts-future-fallback');
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  const deliverableRel = '.tmp-verify-artifacts-future-fallback/deliverable.txt';
  const deliverableAbs = join(PROJECT_ROOT, deliverableRel);
  writeFileSync(deliverableAbs, 'payload', 'utf8');

  const now = Date.now();
  const fileMtime = new Date(now - 10 * HOUR_MS);
  utimesSync(deliverableAbs, fileMtime, fileMtime);

  const ticketPath = makeTicket(tmpDir, {
    id: 'QA-905',
    createdAt: new Date(now + 5 * HOUR_MS).toISOString(), // битая метка
    updatedAt: new Date(now - 1 * HOUR_MS).toISOString(), // валидная метка
    deliverablePath: deliverableRel,
    dod: '- [x] deliverable создан',
  });

  try {
    const result = runScript(ticketPath);
    assert.equal(result.status, 'failed', 'Ожидался failed: файл старше updated_at');
    assert.match(result.unchanged_files || '', /deliverable\.txt/);
    assert.match(result.warnings || '', /created_at/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('verify-artifacts: регресс — валидный created_at в прошлом + старый файл → unchanged детектится', () => {
  const tmpDir = join(PROJECT_ROOT, '.tmp-verify-artifacts-past-regress');
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  const deliverableRel = '.tmp-verify-artifacts-past-regress/deliverable.txt';
  const deliverableAbs = join(PROJECT_ROOT, deliverableRel);
  writeFileSync(deliverableAbs, 'payload', 'utf8');

  const now = Date.now();
  const fileMtime = new Date(now - 5 * HOUR_MS);
  utimesSync(deliverableAbs, fileMtime, fileMtime);

  const ticketPath = makeTicket(tmpDir, {
    id: 'QA-906',
    createdAt: new Date(now - 2 * HOUR_MS).toISOString(),
    updatedAt: new Date(now - 1 * HOUR_MS).toISOString(),
    deliverablePath: deliverableRel,
    dod: '- [x] deliverable создан',
  });

  try {
    const result = runScript(ticketPath);
    assert.equal(result.status, 'failed', 'Ожидался failed по unchanged');
    assert.match(result.unchanged_files || '', /deliverable\.txt/);
    assert.equal(result.warnings, undefined, 'при валидных метках предупреждений быть не должно');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// E2E-gate против ghost-execution (предотвращение регрессий IMPL-35/36/42).
// Парсит `### Implementation assertions`, динамически импортирует модуль
// и проверяет, что заявленные экспорт/метод действительно существуют.
// ============================================================================

function makeTicketWithAssertions(dir, { id, createdAt, deliverablePath, assertions }) {
  mkdirSync(dir, { recursive: true });
  const ticketPath = join(dir, `${id}.md`);
  const content = `---
id: ${id}
title: "fixture"
priority: 3
type: impl
required_capabilities: []
created_at: "${createdAt}"
updated_at: "${createdAt}"
completed_at: "${createdAt}"
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

- [x] реализовано

## Результат выполнения

### Summary
fixture summary.

### Изменённые файлы

- \`${deliverablePath}\`

### Implementation assertions

${assertions}
`;
  writeFileSync(ticketPath, content, 'utf8');
  return ticketPath;
}

test('verify-artifacts: E2E-gate passed когда заявленный метод реально существует', () => {
  const tmpDir = join(PROJECT_ROOT, '.tmp-verify-artifacts-e2e-passed');
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  // Создаём живой модуль с классом и методом
  const modRel = '.tmp-verify-artifacts-e2e-passed/real-module.mjs';
  const modAbs = join(PROJECT_ROOT, modRel);
  writeFileSync(modAbs, `export class RealClass {
  realMethod() { return 42; }
}
export const realHelper = () => 'ok';
`, 'utf8');

  const ticketPath = makeTicketWithAssertions(tmpDir, {
    id: 'IMPL-990',
    createdAt: '2026-04-21T00:00:00Z',
    deliverablePath: modRel,
    assertions: [
      `- module: \`${modRel}\`, export: \`RealClass\`, method: \`realMethod\``,
      `- module: \`${modRel}\`, export: \`realHelper\`, type: \`function\``,
    ].join('\n'),
  });

  try {
    const result = runScript(ticketPath);
    assert.equal(result.status, 'passed', `Ожидался passed. fail_reasons=${result.fail_reasons || ''}`);
    assert.equal(result.assertions_total, '2', '2 assertions выполнено');
    assert.equal(result.assertions_failed, '0', '0 failed');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('verify-artifacts: E2E-gate failed когда метод не существует (ghost execution)', () => {
  const tmpDir = join(PROJECT_ROOT, '.tmp-verify-artifacts-e2e-ghost');
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  // Модуль есть, но заявленного метода нет — имитируем ghost execution
  const modRel = '.tmp-verify-artifacts-e2e-ghost/real-module.mjs';
  const modAbs = join(PROJECT_ROOT, modRel);
  writeFileSync(modAbs, `export class RealClass {
  actuallyExistingMethod() { return 1; }
}
`, 'utf8');

  const ticketPath = makeTicketWithAssertions(tmpDir, {
    id: 'IMPL-991',
    createdAt: '2026-04-21T00:00:00Z',
    deliverablePath: modRel,
    assertions: `- module: \`${modRel}\`, export: \`RealClass\`, method: \`executeWithFallback\``,
  });

  try {
    const result = runScript(ticketPath);
    assert.equal(result.status, 'failed', 'Должен упасть: заявленный метод отсутствует');
    assert.equal(result.assertions_failed, '1', 'Одна assertion провалена');
    assert.match(result.fail_reasons || '', /assertion_failed/);
    assert.match(result.issues || '', /executeWithFallback/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('verify-artifacts: E2E-gate failed когда модуль не найден', () => {
  const tmpDir = join(PROJECT_ROOT, '.tmp-verify-artifacts-e2e-missing-mod');
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  const deliverableRel = '.tmp-verify-artifacts-e2e-missing-mod/deliverable.mjs';
  const deliverableAbs = join(PROJECT_ROOT, deliverableRel);
  writeFileSync(deliverableAbs, 'export const x = 1;\n', 'utf8');

  const ticketPath = makeTicketWithAssertions(tmpDir, {
    id: 'IMPL-992',
    createdAt: '2026-04-21T00:00:00Z',
    deliverablePath: deliverableRel,
    assertions: `- module: \`.tmp-verify-artifacts-e2e-missing-mod/does-not-exist.mjs\`, export: \`foo\`, type: \`function\``,
  });

  try {
    const result = runScript(ticketPath);
    assert.equal(result.status, 'failed');
    assert.match(result.issues || '', /module_not_found/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('verify-artifacts: тикет без секции Implementation assertions проходит (опциональность)', () => {
  const tmpDir = join(PROJECT_ROOT, '.tmp-verify-artifacts-e2e-none');
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  const deliverableRel = '.tmp-verify-artifacts-e2e-none/deliverable.txt';
  const deliverableAbs = join(PROJECT_ROOT, deliverableRel);
  writeFileSync(deliverableAbs, 'payload', 'utf8');

  const ticketPath = makeTicket(tmpDir, {
    id: 'DOCS-999',
    createdAt: '2026-04-21T00:00:00Z',
    updatedAt: '2026-04-21T10:00:00Z',
    deliverablePath: deliverableRel,
    dod: '- [x] deliverable создан',
  });

  try {
    const result = runScript(ticketPath);
    assert.equal(result.status, 'passed', 'Тикет без секции assertions должен проходить');
    assert.equal(result.assertions_total, '0', 'Нет assertions');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// D4: Source-grounding gate
// Регрессионные тесты на детекцию UI/контракт-DoD без source-ссылок в Result.
// Инцидент-основание: QA-54/HUMAN-4 — сфабрикованные UI-assertions без сверки
// с package.json прошли через verify-artifacts и review-result.
// ============================================================================

function makeTicketWithResult(dir, { id, dod, resultContent }) {
  mkdirSync(dir, { recursive: true });
  const ticketPath = join(dir, `${id}.md`);
  const content = `---
id: ${id}
title: "fixture"
priority: 3
type: qa
required_capabilities: []
created_at: "2026-04-21T00:00:00Z"
updated_at: "2026-04-21T10:00:00Z"
completed_at: ""
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

${resultContent}

### Изменённые файлы

`;
  writeFileSync(ticketPath, content, 'utf8');
  return ticketPath;
}

test('verify-artifacts: D4 негативный — UI-DoD без source-ссылок в Result → failed (source_grounding_missing)', () => {
  const tmpDir = join(PROJECT_ROOT, '.tmp-verify-artifacts-d4-negative');
  rmSync(tmpDir, { recursive: true, force: true });

  const ticketPath = makeTicketWithResult(tmpDir, {
    id: 'QA-910',
    dod: '- [x] Команда "Move Next" видна в контекстном меню тикета',
    resultContent: 'Проверено вручную, Move Next работает корректно.',
  });

  try {
    const result = runScript(ticketPath);
    assert.equal(
      result.status,
      'failed',
      `Ожидался failed (source_grounding_missing), получили ${result.status}. fail_reasons=${result.fail_reasons || ''}`
    );
    assert.match(
      result.fail_reasons || '',
      /source_grounding_missing/,
      'fail_reasons должен содержать source_grounding_missing'
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('verify-artifacts: D4 позитивный — UI-DoD с file:line ссылкой в Result → passed', () => {
  const tmpDir = join(PROJECT_ROOT, '.tmp-verify-artifacts-d4-positive');
  rmSync(tmpDir, { recursive: true, force: true });

  const ticketPath = makeTicketWithResult(tmpDir, {
    id: 'QA-911',
    dod: '- [x] Команда "Move Next" видна в контекстном меню тикета',
    resultContent: [
      'Проверено по package.json:42 — команда workflow.moveTicketNext зарегистрирована',
      'с group: "inline", что соответствует hover-кнопке, а не ПКМ-меню.',
      'Команда передаётся через contributes.menus.view/item/context.',
    ].join('\n'),
  });

  try {
    const result = runScript(ticketPath);
    assert.equal(
      result.status,
      'passed',
      `Ожидался passed, получили ${result.status}. fail_reasons=${result.fail_reasons || ''}`
    );
    assert.doesNotMatch(
      result.fail_reasons || '',
      /source_grounding_missing/,
      'source_grounding_missing не должен быть в fail_reasons при наличии ссылки на source'
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('verify-artifacts: D4 пропускает тикеты без UI/контракт-DoD (нет ложных срабатываний)', () => {
  const tmpDir = join(PROJECT_ROOT, '.tmp-verify-artifacts-d4-skip');
  rmSync(tmpDir, { recursive: true, force: true });

  const ticketPath = makeTicketWithResult(tmpDir, {
    id: 'IMPL-912',
    dod: '- [x] Функция parseConfig возвращает корректный объект',
    resultContent: 'Функция реализована и покрыта юнит-тестами. Все тесты зелёные.',
  });

  try {
    const result = runScript(ticketPath);
    assert.equal(
      result.status,
      'passed',
      `Ожидался passed (нет UI/контракт-DoD), получили ${result.status}. fail_reasons=${result.fail_reasons || ''}`
    );
    assert.doesNotMatch(
      result.fail_reasons || '',
      /source_grounding/,
      'source_grounding не должен срабатывать для non-UI DoD'
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
