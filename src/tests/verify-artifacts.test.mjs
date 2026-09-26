import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getLastReviewStatus } from '../lib/review-section.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, 'src', 'skills', 'review-result', 'scripts', 'verify-artifacts.js');

/**
 * Корень проекта для скрипта — временный, со своим `.workflow/`.
 *
 * Скрипт ищет корень при импорте (`findProjectRoot()` от `cwd`). Прежде тесты
 * запускали его из корня репозитория и держали фикстуры там же — это работало
 * только на машине, где в корне репозитория лежит рабочая `.workflow/`. На
 * чистом клоне (CI) все 17 проверок падали с `Could not find .workflow/`.
 */
const PROJECT_ROOT = mkdtempSync(join(tmpdir(), 'verify-artifacts-'));
mkdirSync(join(PROJECT_ROOT, '.workflow'), { recursive: true });
process.on('exit', () => rmSync(PROJECT_ROOT, { recursive: true, force: true }));

function runScript(ticketPath, cwd = PROJECT_ROOT) {
  const out = execFileSync('node', [SCRIPT, ticketPath], { encoding: 'utf8', cwd });
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
      'legacy',
      `Ожидался legacy, получили ${result.status}. fail_reasons=${result.fail_reasons || ''}`
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
      'legacy',
      `Ожидался legacy, получили ${result.status}. fail_reasons=${result.fail_reasons || ''}`
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
    assert.equal(result.status, 'legacy', `Ожидался legacy. fail_reasons=${result.fail_reasons || ''}`);
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
    assert.equal(result.status, 'legacy', 'Тикет без секции assertions должен проходить');
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
      'legacy',
      `Ожидался legacy, получили ${result.status}. fail_reasons=${result.fail_reasons || ''}`
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
      'legacy',
      `Ожидался legacy (нет UI/контракт-DoD), получили ${result.status}. fail_reasons=${result.fail_reasons || ''}`
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

// ---------------------------------------------------------------------------
// Маркер призрачного выполнения.
//
// Детекторы workflow-mcp (`list_ghost_executions` и health-детектор
// `ghost-execution`) ищут в логе пайплайна структурный токен
// `[GHOST-EXECUTION]`. Писать его было некому: детекторы работали вхолостую с
// самого начала. Теперь его печатает verify-artifacts — единственное место,
// где призрак вообще обнаруживается механически.
//
// Токен обязан стоять обособленно: детектор намеренно не ловит прозаические
// упоминания (тег тикета, commit message, имя файла) — на этом он уже обжёгся
// двенадцатью ложными срабатываниями (FIX-001).
// ---------------------------------------------------------------------------

/** Полный stdout скрипта: маркер печатается вне RESULT-блока. */
function runScriptRaw(ticketPath) {
  return execFileSync('node', [SCRIPT, ticketPath], { encoding: 'utf8', cwd: PROJECT_ROOT });
}

/** Строка маркера, если она есть. */
function ghostLine(stdout) {
  return stdout.split('\n').find((line) => line.includes('[GHOST-EXECUTION]')) || null;
}

test('ghost-маркер: файл не трогали — маркер в stdout', () => {
  const tmpDir = join(PROJECT_ROOT, '.tmp-ghost-marker-unchanged');
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  const deliverableRel = '.tmp-ghost-marker-unchanged/deliverable.txt';
  const deliverableAbs = join(PROJECT_ROOT, deliverableRel);
  writeFileSync(deliverableAbs, 'payload', 'utf8');

  const fileMtime = new Date('2026-04-20T00:00:00Z');
  utimesSync(deliverableAbs, fileMtime, fileMtime);

  const ticketPath = makeTicket(tmpDir, {
    id: 'QA-903',
    createdAt: '2026-04-21T00:00:00Z',
    updatedAt: '2026-04-21T10:00:00Z',
    deliverablePath: deliverableRel,
    dod: '- [x] deliverable создан',
  });

  try {
    const line = ghostLine(runScriptRaw(ticketPath));

    assert.ok(line, 'маркер не напечатан');
    // Токен — первое слово строки и отделён пробелом: ровно то, что ищет
    // детектор. Строка с `тут про [GHOST-EXECUTION]-гейт` ему не подойдёт.
    assert.ok(line.startsWith('[GHOST-EXECUTION] '), line);
    assert.match(line, /ticket=QA-903/);
    assert.match(line, /reason=file_unchanged/);
    assert.match(line, /unchanged_files=[^\s]*deliverable\.txt/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ghost-маркер: заявленного метода нет — маркер с reason=assertion_failed', () => {
  const tmpDir = join(PROJECT_ROOT, '.tmp-ghost-marker-assertion');
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  const modRel = '.tmp-ghost-marker-assertion/real-module.mjs';
  writeFileSync(join(PROJECT_ROOT, modRel), `export class RealClass {
  actuallyExistingMethod() { return 1; }
}
`, 'utf8');

  const ticketPath = makeTicketWithAssertions(tmpDir, {
    id: 'IMPL-993',
    createdAt: '2026-04-21T00:00:00Z',
    deliverablePath: modRel,
    assertions: `- module: \`${modRel}\`, export: \`RealClass\`, method: \`neverImplemented\``,
  });

  try {
    const line = ghostLine(runScriptRaw(ticketPath));

    assert.ok(line, 'маркер не напечатан');
    assert.match(line, /reason=assertion_failed/);
    assert.match(line, /ghost_assertions=1/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ghost-маркер: честно выполненный тикет маркера не даёт', () => {
  const tmpDir = join(PROJECT_ROOT, '.tmp-ghost-marker-clean');
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  const deliverableRel = '.tmp-ghost-marker-clean/deliverable.txt';
  const deliverableAbs = join(PROJECT_ROOT, deliverableRel);

  const ticketPath = makeTicket(tmpDir, {
    id: 'QA-904',
    createdAt: '2026-04-21T00:00:00Z',
    updatedAt: '2026-04-21T10:00:00Z',
    deliverablePath: deliverableRel,
    dod: '- [x] deliverable создан',
  });
  // Файл создан ПОСЛЕ created_at тикета — работа настоящая.
  writeFileSync(deliverableAbs, 'payload', 'utf8');

  try {
    const stdout = runScriptRaw(ticketPath);

    assert.equal(ghostLine(stdout), null, `лишний маркер:\n${stdout}`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ghost-маркер: сломанный импорт призраком не считается', () => {
  // `module_not_found`, `import_failed`, `type_mismatch` говорят о сломанном
  // окружении проверки или о неверно записанном assertion'е. Тикет валится,
  // как и раньше, но `critical`-алерт в workflow-mcp по такому поводу звал бы
  // человека на чужую беду.
  const tmpDir = join(PROJECT_ROOT, '.tmp-ghost-marker-import');
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  const deliverableRel = '.tmp-ghost-marker-import/deliverable.mjs';
  writeFileSync(join(PROJECT_ROOT, deliverableRel), 'export const x = 1;\n', 'utf8');

  const ticketPath = makeTicketWithAssertions(tmpDir, {
    id: 'IMPL-994',
    createdAt: '2026-04-21T00:00:00Z',
    deliverablePath: deliverableRel,
    assertions: `- module: \`.tmp-ghost-marker-import/does-not-exist.mjs\`, export: \`foo\`, type: \`function\``,
  });

  try {
    const stdout = runScriptRaw(ticketPath);

    assert.equal(ghostLine(stdout), null, `лишний маркер:\n${stdout}`);
    // Тикет всё равно не проходит — проверка не ослаблена.
    const block = stdout.match(/---RESULT---([\s\S]*?)---RESULT---/)[1];
    assert.match(block, /status: failed/);
    assert.match(block, /module_not_found/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// PLAN-002: тикет `dod_format: 2` — evidence по пунктам DoD и статусы
// all_green / passed / failed; тикет без поля — legacy.
//
// Свой временный корень проекта: evidence пишется в его
// `.workflow/state/evidence/`, проверки исполняются с `cwd` в нём.
// ---------------------------------------------------------------------------

describe('verify-artifacts: dod_format: 2', () => {
  let root;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'verify-artifacts-dod2-'));
    mkdirSync(join(root, '.workflow', 'tickets', 'review'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    const lines = Array.from({ length: 20 }, (_, i) => `const line${i + 1} = ${i + 1};`);
    writeFileSync(join(root, 'src', 'lib.js'), `${lines.join('\n')}\n`, 'utf8');
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  const reviewTicket = (id) => join(root, '.workflow', 'tickets', 'review', `${id}.md`);

  /**
   * Тикет в `review/` корня. Заявленный файл пишется сейчас — после created_at,
   * так что прежние гейты (файлы, baseline) его пропускают.
   */
  function makeDod2Ticket(id, { dod, capabilities = '[]', summary = 'fixture summary.', dodFormat = 'dod_format: 2' }) {
    const deliverable = `out/${id}.txt`;
    mkdirSync(join(root, 'out'), { recursive: true });
    writeFileSync(join(root, deliverable), 'payload', 'utf8');

    const ticketPath = reviewTicket(id);
    writeFileSync(ticketPath, `---
id: ${id}
title: "fixture"
priority: 3
type: impl
required_capabilities: ${capabilities}
${dodFormat}
created_at: "2026-04-21T00:00:00Z"
updated_at: "2026-04-21T10:00:00Z"
completed_at: ""
parent_plan: ""
parent_task: ""
dependencies: []
conditions: []
complexity: simple
tags: []
---
## Описание

fixture

## Критерии готовности (Definition of Done)

${dod}

## Результат выполнения

### Summary
${summary}

### Изменённые файлы

- \`${deliverable}\`
`, 'utf8');
    return ticketPath;
  }

  const readEvidence = (id, projectRoot = root) =>
    JSON.parse(readFileSync(join(projectRoot, '.workflow', 'state', 'evidence', `${id}.json`), 'utf8'));

  const GREEN = '- [x] Скрипт завершается без ошибки\n  - check: `node -e "process.exit(0)"`, expect: `exit 0`';

  test('две зелёные проверки → all_green, строка passed в «Ревью» с путём evidence', () => {
    const ticketPath = makeDod2Ticket('IMPL-801', {
      dod: [
        GREEN,
        '- [x] Прежний набор зелёный',
        "  - check: `node -e \"console.log('suite ok')\"`, expect: `stdout contains suite ok`, regression: `true`",
      ].join('\n'),
    });

    // Промпт стадии, как его собирает раннер: ticket_id и attempt в блоке Context.
    const result = runScript('verify-artifacts\n\nContext:\n  ticket_id: IMPL-801\n  attempt: 2', root);

    assert.equal(result.status, 'all_green', `fail_reasons=${result.fail_reasons || ''}`);
    assert.equal(result.evidence_file, '.workflow/state/evidence/IMPL-801.json');
    assert.equal(result.dod_check_total, '2');
    assert.equal(result.dod_check_failed, '0');
    assert.equal(result.review_note_written, 'true');

    const evidence = readEvidence('IMPL-801');
    assert.equal(evidence.ticket_id, 'IMPL-801');
    assert.equal(evidence.attempt, 2);
    assert.deepEqual(evidence.items.map((item) => [item.kind, item.status, item.exit_code]), [
      ['check', 'passed', 0],
      ['check', 'passed', 0],
    ]);
    assert.equal(evidence.items[1].regression, true);
    assert.match(evidence.items[1].stdout, /suite ok/);
    assert.deepEqual(evidence.review, { agent: null, model: null, items: {} });

    const ticket = readFileSync(ticketPath, 'utf8');
    // Последняя строка ревью читается как passed — move-ticket при переходе в
    // done не допишет свою fallback-строку без ссылки на evidence.
    assert.equal(getLastReviewStatus(ticket), 'passed');
    const reviewRow = ticket.split('\n').find((line) => line.includes('✅ passed'));
    assert.match(reviewRow, /\.workflow\/state\/evidence\/IMPL-801\.json/);
    assert.match(reviewRow, /\| script-verify-artifacts \|$/);
  });

  test('одна красная проверка → failed, пункт с кодом возврата в evidence', () => {
    makeDod2Ticket('IMPL-802', {
      dod: [GREEN, '- [x] Второй скрипт завершается без ошибки', '  - check: `node -e "process.exit(3)"`, expect: `exit 0`'].join('\n'),
    });

    const result = runScript(reviewTicket('IMPL-802'), root);

    assert.equal(result.status, 'failed');
    assert.equal(result.dod_check_failed, '1');
    assert.match(result.fail_reasons, /dod_items_failed=2/);
    const item = readEvidence('IMPL-802').items[1];
    assert.equal(item.status, 'failed');
    assert.equal(item.exit_code, 3);
    // Ревью-заметка при failed — как у прежних гейтов, с пунктом и путём evidence.
    assert.match(
      readFileSync(reviewTicket('IMPL-802'), 'utf8'),
      /❌ failed \| verify-artifacts: не пройдены пункты DoD: пункт 2 — failed: .*evidence: \.workflow\/state\/evidence\/IMPL-802\.json \|/
    );
  });

  test('пункт prose → passed, required_capabilities без multimodal', () => {
    makeDod2Ticket('IMPL-803', {
      capabilities: '[text]',
      dod: [GREEN, '- [x] Текст ошибки понятен пользователю', '  - prose: `понятность формулировки командой не проверить`'].join('\n'),
    });

    const result = runScript(reviewTicket('IMPL-803'), root);

    assert.equal(result.status, 'passed', `fail_reasons=${result.fail_reasons || ''}`);
    assert.deepEqual(JSON.parse(result.required_capabilities), ['text']);
    assert.equal(result.dod_prose_total, '1');
    assert.equal(result.dod_visual_total, '0');
    const item = readEvidence('IMPL-803').items[1];
    assert.deepEqual([item.kind, item.status, item.reason], ['prose', 'pending', 'понятность формулировки командой не проверить']);
  });

  test('пункт visual с существующим PNG → passed, required_capabilities с multimodal', () => {
    const screens = join(root, '.workflow', 'evidence', 'screens');
    mkdirSync(screens, { recursive: true });
    writeFileSync(join(screens, 'IMPL-804-export.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    makeDod2Ticket('IMPL-804', {
      capabilities: '[text]',
      dod: '- [x] Экспорт стоит справа от поиска\n  - visual: `.workflow/evidence/screens/IMPL-804-*.png`',
    });

    const result = runScript(reviewTicket('IMPL-804'), root);

    assert.equal(result.status, 'passed', `fail_reasons=${result.fail_reasons || ''}`);
    assert.deepEqual(JSON.parse(result.required_capabilities), ['text', 'multimodal']);
    assert.equal(result.dod_visual_total, '1');
    const item = readEvidence('IMPL-804').items[0];
    assert.equal(item.status, 'pending');
    assert.deepEqual(item.images, ['.workflow/evidence/screens/IMPL-804-export.png']);
  });

  test('пункт visual без файла → failed, image_missing', () => {
    makeDod2Ticket('IMPL-805', {
      dod: '- [x] Экспорт стоит справа от поиска\n  - visual: `.workflow/evidence/screens/IMPL-805-*.png`',
    });

    const result = runScript(reviewTicket('IMPL-805'), root);

    assert.equal(result.status, 'failed');
    assert.match(result.issues, /нет изображений по маске/);
    const item = readEvidence('IMPL-805').items[0];
    assert.deepEqual([item.status, item.images], ['image_missing', []]);
  });

  test('проверка вне ограничений исполнителя → denied, тикет failed', () => {
    makeDod2Ticket('IMPL-806', {
      dod: '- [x] Сервис отвечает\n  - check: `curl https://example.com`, expect: `exit 0`',
    });

    const result = runScript(reviewTicket('IMPL-806'), root);

    assert.equal(result.status, 'failed');
    assert.equal(result.dod_check_failed, '1');
    const item = readEvidence('IMPL-806').items[0];
    assert.equal(item.status, 'denied');
    assert.match(item.reason, /executable_not_allowed: curl/);
  });

  test('пункт без записи проверки → failed без запуска', () => {
    makeDod2Ticket('IMPL-807', { dod: `${GREEN}\n- [x] Пункт без проверки` });

    const result = runScript(reviewTicket('IMPL-807'), root);

    assert.equal(result.status, 'failed');
    assert.match(result.fail_reasons, /dod_items_failed=2/);
    assert.equal(readEvidence('IMPL-807').items[1].reason, 'dod_record_invalid: no_form');
  });

  test('source_refs: существующая строка — фрагмент ±5 строк, несуществующие — missing; текста Result в evidence нет', () => {
    makeDod2Ticket('IMPL-808', {
      dod: GREEN,
      summary: 'ЗАЯВЛЕНИЕ-ИСПОЛНИТЕЛЯ: сделано в src/lib.js:3, src/lib.js:999 и src/nope.js:1.',
    });

    runScript(reviewTicket('IMPL-808'), root);

    const evidence = readEvidence('IMPL-808');
    const byRef = Object.fromEntries(evidence.source_refs.map((r) => [r.ref, r]));
    assert.equal(byRef['src/lib.js:3'].status, 'found');
    assert.deepEqual(
      byRef['src/lib.js:3'].excerpt.split('\n').map((line) => line.split(':')[0]),
      ['1', '2', '3', '4', '5', '6', '7', '8']
    );
    assert.match(byRef['src/lib.js:3'].excerpt, /^3: const line3 = 3;$/m);
    assert.equal(byRef['src/lib.js:999'].status, 'missing');
    assert.equal(byRef['src/nope.js:1'].status, 'missing');
    assert.doesNotMatch(JSON.stringify(evidence), /ЗАЯВЛЕНИЕ-ИСПОЛНИТЕЛЯ/);
  });

  /** Отдельный git-репозиторий со своим .workflow/: корень проекта скрипт ищет от cwd. */
  function makeGitRepo() {
    const repo = mkdtempSync(join(root, 'git-'));
    mkdirSync(join(repo, '.workflow', 'tickets', 'review'), { recursive: true });
    const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' });
    git('init', '-q');
    const commit = () => git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
    return { repo, git, commit };
  }

  /** Тикет `dod_format: 2` в `review/` репозитория с заданными «Изменёнными файлами». */
  function writeGitTicket(repo, id, { dod = GREEN, summary = 'fixture summary.', files }) {
    const ticketPath = join(repo, '.workflow', 'tickets', 'review', `${id}.md`);
    writeFileSync(ticketPath, `---
id: ${id}
dod_format: 2
created_at: "2026-04-21T00:00:00Z"
---
## Критерии готовности (Definition of Done)

${dod}

## Результат выполнения

### Summary
${summary}

### Изменённые файлы

${files.map((file) => `- \`${file}\``).join('\n')}
`, 'utf8');
    return ticketPath;
  }

  test('дифф: изменённый отслеживаемый файл и новый файл, сверх лимита — пометка усечения', () => {
    const { repo, git, commit } = makeGitRepo();
    writeFileSync(join(repo, 'tracked.txt'), 'one\n', 'utf8');
    git('add', 'tracked.txt');
    commit();
    writeFileSync(join(repo, 'tracked.txt'), 'one\nTRACKED-CHANGE\n', 'utf8');
    writeFileSync(join(repo, 'big.txt'), `${'x'.repeat(70000)}\n`, 'utf8');
    const ticketPath = writeGitTicket(repo, 'IMPL-809', { files: ['tracked.txt', 'big.txt'] });

    const result = runScript(ticketPath, repo);

    assert.equal(result.status, 'all_green', `fail_reasons=${result.fail_reasons || ''} warnings=${result.warnings || ''}`);
    const evidence = readEvidence('IMPL-809', repo);
    assert.deepEqual(evidence.changed_files, ['tracked.txt', 'big.txt']);
    assert.match(evidence.diff, /^\+TRACKED-CHANGE$/m);
    assert.match(evidence.diff, /\+\+\+ b\/big\.txt/);
    assert.equal(evidence.diff.length, 60000);
    assert.equal(evidence.diff_truncated.shown_chars, 60000);
    assert.ok(evidence.diff_truncated.total_chars > 70000, JSON.stringify(evidence.diff_truncated));
    assert.equal(evidence.diff_error, null);
  });

  test('дифф: тикет и каталог тикетов в «Изменённых файлах» Result не приносят; путь вне корня — в diff_error, остальное собрано', () => {
    const { repo, git, commit } = makeGitRepo();
    // Тикеты хранятся в git: копия тикета прошлой попытки лежит в HEAD под in-progress/.
    const inProgress = join(repo, '.workflow', 'tickets', 'in-progress');
    mkdirSync(inProgress, { recursive: true });
    writeFileSync(join(inProgress, 'IMPL-811.md'), '## Результат выполнения\n\nПРОШЛАЯ-ПОПЫТКА: всё сделано.\n', 'utf8');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'a.js'), 'one\n', 'utf8');
    git('add', '.');
    commit();
    rmSync(join(inProgress, 'IMPL-811.md'));
    writeFileSync(join(repo, 'src', 'a.js'), 'one\nA-CHANGE\n', 'utf8');
    const outside = join(root, 'outside-811.txt');
    writeFileSync(outside, 'outside\n', 'utf8');
    const ticketPath = writeGitTicket(repo, 'IMPL-811', {
      dod: '- [x] Текст ошибки понятен пользователю\n  - prose: `понятность формулировки командой не проверить`',
      summary: 'ЗАЯВЛЕНИЕ-ИСПОЛНИТЕЛЯ: всё сделано и проверено.',
      files: ['src/a.js', '.workflow/tickets/review/IMPL-811.md', '.workflow/tickets', outside],
    });

    const result = runScript(ticketPath, repo);

    assert.equal(result.status, 'passed', `fail_reasons=${result.fail_reasons || ''} warnings=${result.warnings || ''}`);
    const evidence = readEvidence('IMPL-811', repo);
    assert.match(evidence.diff, /^\+A-CHANGE$/m);
    const serialized = JSON.stringify(evidence);
    assert.doesNotMatch(serialized, /ЗАЯВЛЕНИЕ-ИСПОЛНИТЕЛЯ/);
    assert.doesNotMatch(serialized, /ПРОШЛАЯ-ПОПЫТКА/);
    assert.equal(evidence.diff_error, `не внутри корня проекта: ${outside}`);
    assert.match(result.warnings, /дифф неполон: не внутри корня проекта/);
  });

  test('дифф: репозиторий без коммитов — дифф пуст, причина в diff_error', () => {
    const { repo } = makeGitRepo();
    writeFileSync(join(repo, 'new.txt'), 'NEW\n', 'utf8');
    const ticketPath = writeGitTicket(repo, 'IMPL-812', { files: ['new.txt'] });

    const result = runScript(ticketPath, repo);

    assert.equal(result.status, 'all_green', `fail_reasons=${result.fail_reasons || ''}`);
    const evidence = readEvidence('IMPL-812', repo);
    assert.deepEqual([evidence.diff, evidence.diff_truncated], ['', null]);
    // git 2.52 отвечает «fatal: bad revision 'HEAD'»; проверяется только упоминание HEAD.
    assert.match(evidence.diff_error, /HEAD/);
  });

  test('дифф: проект не в репозитории git — дифф пуст, причина в diff_error короткой строкой', () => {
    // Вне репозитория `git diff HEAD -- <пути>` уходит в режим --no-index и
    // печатает справку по опциям на ~4 тыс. символов: она попадала в diff_error и
    // оттуда в данные модели ревью (проба 2026-09-26).
    const ticketPath = makeDod2Ticket('IMPL-813', { dod: GREEN });

    const result = runScript(ticketPath, root);

    assert.equal(result.status, 'all_green', `fail_reasons=${result.fail_reasons || ''}`);
    const evidence = readEvidence('IMPL-813');
    assert.equal(evidence.diff, '');
    assert.equal(evidence.diff_error, 'проект не в репозитории git');
  });

  test('тикет без dod_format с заполненным Result → legacy, без evidence и без строки ревью', () => {
    const ticketPath = makeDod2Ticket('IMPL-810', { dod: '- [x] deliverable создан', dodFormat: '' });

    const result = runScript(ticketPath, root);

    assert.equal(result.status, 'legacy', `fail_reasons=${result.fail_reasons || ''}`);
    assert.equal(result.evidence_file, undefined);
    assert.ok(!existsSync(join(root, '.workflow', 'state', 'evidence', 'IMPL-810.json')), 'у legacy-тикета не должно быть evidence');
    assert.doesNotMatch(readFileSync(ticketPath, 'utf8'), /## Ревью/);
  });
});
