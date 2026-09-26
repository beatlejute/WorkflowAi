/**
 * Проверка атомарности тикетов (src/skills/decompose-plan/scripts/verify-atomicity.js) —
 * формы проверок в DoD тикетов `dod_format: 2` (PLAN-002, задачи 10–11).
 *
 * Что охраняется:
 *  - пункт DoD тикета `dod_format: 2` без ровно одной полной формы проверки (check +
 *    expect, prose, visual) — FAIL с id тикета и номером пункта;
 *  - тикет `dod_format: 2` из одних регрессионных проверок — FAIL `only_regression_checks`;
 *    с проверкой результата рядом — проходит;
 *  - тикет `dod_format: 2` с пустой секцией DoD или без неё — FAIL `no_dod_items`;
 *  - тикет без `dod_format` с тем же DoD — прежний результат, без FAIL;
 *  - вложенные строки проверок не считаются пунктами при пороге DoD: 7 пунктов и
 *    7 строк проверки — предупреждение порога 5, не FAIL порога 7.
 *
 * Скрипт берёт plan_file из промпта раннера, а тикеты плана — из .workflow/tickets/backlog/
 * корня проекта, найденного от cwd, поэтому запускается дочерним процессом с cwd во
 * временном корне. Результат сводит все тикеты плана — у каждого случая свой план.
 * Временный корень создаётся в before и удаляется в after.
 *
 * Запуск: node --import ./src/tests/_rails-home.mjs --test src/tests/verify-atomicity.test.mjs
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import YAML from 'workflow-ai/lib/js-yaml.mjs';

const SCRIPT = fileURLToPath(new URL('../skills/decompose-plan/scripts/verify-atomicity.js', import.meta.url));

let root;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-atomicity-'));
  fs.mkdirSync(path.join(root, '.workflow', 'tickets', 'backlog'), { recursive: true });
  fs.mkdirSync(path.join(root, '.workflow', 'plans', 'current'), { recursive: true });
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * План planId и его тикет id в backlog/. dod — строки секции DoD как есть (пункты и
 * вложенные проверки), null — тикет без секции; dodFormat null — тикет без поля.
 */
function putPlanWithTicket(planId, id, { dodFormat = 2, dod }) {
  const plan = ['---', `id: "${planId}"`, 'status: approved', '---', '', `# ${planId}`, ''].join('\n');
  fs.writeFileSync(path.join(root, '.workflow', 'plans', 'current', `${planId}.md`), plan, 'utf8');

  const ticket = [
    '---',
    `id: "${id}"`,
    'title: "Задача"',
    `parent_plan: "${planId}"`,
    ...(dodFormat === null ? [] : [`dod_format: ${dodFormat}`]),
    '---',
    '',
    `# ${id}`,
    '',
    ...(dod === null ? [] : ['## Критерии готовности (Definition of Done)', '', ...dod, '']),
    '## Результат выполнения',
    ''
  ].join('\n');
  fs.writeFileSync(path.join(root, '.workflow', 'tickets', 'backlog', `${id}.md`), ticket, 'utf8');
}

/** Стадия verify-atomicity по плану planId; блок ---RESULT--- — объектом. */
function verify(planId) {
  const prompt = `verify-atomicity\n\nContext:\n  plan_file: plans/current/${planId}.md`;
  const run = spawnSync(process.execPath, [SCRIPT, prompt], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const block = run.stdout.split('---RESULT---')[1];
  assert.ok(block, run.stdout);
  return YAML.load(block);
}

// Проверки из atomicity_failures одним списком, с id тикета в каждой.
const failedChecks = result =>
  (result.atomicity_failures ?? []).flatMap(failure => failure.checks.map(check => ({ ticket: failure.ticket, ...check })));

// DoD, где рядом с полными формами — пункт без проверки, check без expect и две формы.
const MIXED_DOD = [
  '- [ ] Команда печатает отчёт',
  '  - check: `node -e "process.exit(1)"`, expect: `exit 0`',
  '- [ ] Пункт без проверки',
  '- [ ] Текст понятен пользователю',
  '  - prose: `понятность командой не проверить`',
  '- [ ] Проверка без ожидания',
  '  - check: `npm test`',
  '- [ ] Две формы у одного пункта',
  '  - prose: `причина`',
  '  - visual: `.workflow/evidence/screens/x.png`'
];

const formFailure = (id, index, error) => ({
  ticket: id,
  check: 'dod_check_form',
  result: 'FAIL',
  detail: `${id}: пункт DoD ${index} без ровно одной полной формы проверки (${error})`
});

test('dod_format: 2 — пункт без полной формы проверки даёт FAIL с id тикета и номером пункта', () => {
  putPlanWithTicket('PLAN-101', 'IMPL-101', { dod: MIXED_DOD });
  const result = verify('PLAN-101');
  assert.equal(result.status, 'failed');
  assert.equal(result.tickets_failed, 1);
  assert.deepEqual(failedChecks(result), [
    formFailure('IMPL-101', 2, 'no_form'),
    formFailure('IMPL-101', 4, 'check_without_expect'),
    formFailure('IMPL-101', 5, 'multiple_forms')
  ]);
});

test('dod_format: 2 — только регрессионные проверки дают FAIL only_regression_checks', () => {
  const regression = [
    '- [ ] Прежние тесты зелёные',
    '  - check: `npm test`, expect: `exit 0`, regression: `true`',
    '- [ ] Тесты раннера зелёные',
    '  - check: `node --test src/tests/x.test.mjs`, expect: `exit 0`, regression: `true`'
  ];
  putPlanWithTicket('PLAN-102', 'IMPL-102', { dod: regression });
  const result = verify('PLAN-102');
  assert.equal(result.status, 'failed');
  assert.deepEqual(failedChecks(result), [
    { ticket: 'IMPL-102', check: 'dod_check_form', result: 'FAIL', detail: 'only_regression_checks' }
  ]);

  // Рядом с регрессионными — проверка результата: тикет проходит.
  putPlanWithTicket('PLAN-103', 'IMPL-103', {
    dod: [...regression, '- [ ] Отчёт создан', '  - check: `node -e "process.exit(1)"`, expect: `exit 0`']
  });
  const withResult = verify('PLAN-103');
  assert.equal(withResult.status, 'passed');
  assert.deepEqual(failedChecks(withResult), []);
});

test('dod_format: 2 — пустая секция DoD или её отсутствие дают FAIL no_dod_items', () => {
  putPlanWithTicket('PLAN-106', 'IMPL-106', { dod: [] });
  const empty = verify('PLAN-106');
  assert.equal(empty.status, 'failed');
  assert.deepEqual(failedChecks(empty), [
    { ticket: 'IMPL-106', check: 'dod_check_form', result: 'FAIL', detail: 'no_dod_items' }
  ]);

  putPlanWithTicket('PLAN-107', 'IMPL-107', { dod: null });
  const missing = verify('PLAN-107');
  assert.equal(missing.status, 'failed');
  assert.deepEqual(failedChecks(missing), [
    { ticket: 'IMPL-107', check: 'dod_check_form', result: 'FAIL', detail: 'no_dod_items' }
  ]);
});

test('тикет без dod_format с тем же DoD — прежний результат, без FAIL', () => {
  putPlanWithTicket('PLAN-104', 'IMPL-104', { dodFormat: null, dod: MIXED_DOD });
  const result = verify('PLAN-104');
  assert.equal(result.status, 'passed');
  assert.equal(result.tickets_checked, 1);
  assert.deepEqual(failedChecks(result), []);
});

test('dod_format: 2 — 7 пунктов и 7 строк проверки проходят порог DoD', () => {
  const dod = Array.from({ length: 7 }, (_, i) => [
    `- [ ] Пункт ${i + 1}`,
    `  - check: \`rg -c "пункт-${i + 1}" docs/x.md\`, expect: \`stdout matches /^[1-9]/\``
  ]).flat();
  putPlanWithTicket('PLAN-105', 'IMPL-105', { dod });
  const result = verify('PLAN-105');
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.warnings, [
    { ticket: 'IMPL-105', check: 'dod_items', detail: 'DoD содержит 7 пунктов (порог: 5)' }
  ]);
});
