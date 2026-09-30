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
 *  - тикет без `dod_format` с записями проверки под пунктами DoD — FAIL
 *    `dod_format_missing` (PulseProxy QA-180, 2026-09-29: пайплайн таких записей не
 *    исполняет); тикет без поля и без записей и тикет human — без FAIL;
 *  - запись check, которую исполнитель проверок отклонит (флаг скрипта до `--`) или без
 *    исполняемого файла на машине, — FAIL `check_denied` / `check_tool_missing`;
 *  - вложенные строки проверок не считаются пунктами при пороге DoD: 7 пунктов и
 *    7 строк проверки — предупреждение порога 5, не FAIL порога 7;
 *  - план переходит в active только с флагом --activate (его передаёт args агента стадии
 *    в поставляемом конфиге): без флага, при failed и при уже активном плане статус не
 *    меняется, флаг внутри текста промпта флагом не считается, один флаг без промпта —
 *    код 1 и Usage.
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
function putPlanWithTicket(planId, id, { dodFormat = 2, dod, type = null, planStatus = 'approved' }) {
  const plan = ['---', `id: "${planId}"`, `status: ${planStatus}`, '---', '', `# ${planId}`, ''].join('\n');
  fs.writeFileSync(path.join(root, '.workflow', 'plans', 'current', `${planId}.md`), plan, 'utf8');

  const ticket = [
    '---',
    `id: "${id}"`,
    'title: "Задача"',
    `parent_plan: "${planId}"`,
    ...(type === null ? [] : [`type: ${type}`]),
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
function verify(planId, flags = []) {
  const prompt = `verify-atomicity\n\nContext:\n  plan_file: plans/current/${planId}.md`;
  const run = spawnSync(process.execPath, [SCRIPT, ...flags, prompt], { cwd: root, encoding: 'utf8' });
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

// PulseProxy QA-180, 2026-09-29: декомпозиция написала сводному тикету записи проверки
// и не поставила dod_format: 2 — пайплайн их не исполнил, гейт перед ready/ тикет пропустил.
test('тикет без dod_format с записями проверки под пунктами DoD — FAIL dod_format_missing', () => {
  putPlanWithTicket('PLAN-104', 'IMPL-104', { dodFormat: null, dod: MIXED_DOD });
  const result = verify('PLAN-104');
  assert.equal(result.status, 'failed');
  assert.equal(result.tickets_checked, 1);
  assert.deepEqual(failedChecks(result), [{
    ticket: 'IMPL-104',
    check: 'dod_format',
    result: 'FAIL',
    detail: 'IMPL-104: dod_format_missing — под пунктами DoD есть записи проверки, а dod_format: 2 во frontmatter нет'
  }]);
});

test('тикет без dod_format и без записей и тикет human с записями — без FAIL', () => {
  putPlanWithTicket('PLAN-108', 'IMPL-108', { dodFormat: null, dod: ['- [ ] Сделано', '- [ ] Проверено'] });
  const plain = verify('PLAN-108');
  assert.equal(plain.status, 'passed');
  assert.deepEqual(failedChecks(plain), []);

  putPlanWithTicket('PLAN-109', 'HUMAN-109', {
    dodFormat: null,
    type: 'human',
    dod: ['- [ ] Проверено на телефоне', '  - prose: `вручную`']
  });
  const human = verify('PLAN-109');
  assert.equal(human.status, 'passed');
  assert.deepEqual(failedChecks(human), []);
});

// PulseProxy QA-180: `npm test --json` — флаг до `--` забирает npm, исполнитель проверок
// такую запись отклоняет, пункт красный при любой работе.
test('dod_format: 2 — запись, которую исполнитель проверок отклонит или без программы на машине, — FAIL', () => {
  putPlanWithTicket('PLAN-110', 'IMPL-110', {
    dod: [
      '- [ ] Unit-тесты зелёные',
      '  - check: `npm test --json`, expect: `stdout matches /"numFailedTests":0/`',
      '- [ ] Запуск без программы',
      '  - check: `no-such-tool-xyz --version`, expect: `exit 0`',
      '- [ ] Аргументы после --',
      '  - check: `npm test -- --json`, expect: `stdout matches /"numFailedTests":0/`'
    ]
  });
  const result = verify('PLAN-110');
  assert.equal(result.status, 'failed');
  const details = failedChecks(result).map(check => check.detail);
  assert.equal(details.length, 2, JSON.stringify(details));
  assert.match(details[0], /^IMPL-110: пункт DoD 1 — check_denied \(/);
  assert.match(details[1], /^IMPL-110: пункт DoD 2 — check_(denied|tool_missing) \(/);
});

test('dod_format: 2 — 7 пунктов и 7 строк проверки проходят порог DoD', () => {
  const dod = Array.from({ length: 7 }, (_, i) => [
    `- [ ] Пункт ${i + 1}`,
    `  - check: \`git grep -q --untracked -F "пункт-${i + 1}" -- docs/x.md\`, expect: \`exit 0\``
  ]).flat();
  putPlanWithTicket('PLAN-105', 'IMPL-105', { dod });
  const result = verify('PLAN-105');
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.warnings, [
    { ticket: 'IMPL-105', check: 'dod_items', detail: 'DoD содержит 7 пунктов (порог: 5)' }
  ]);
});

// PulseProxy PLAN-020, 2026-09-29: агент декомпозиции запустил скрипт для самопроверки,
// и тот перевёл план в active внутри стадии декомпозиции. План активирует только стадия
// пайплайна — флагом --activate в args своего агента.
const planFile = planId => path.join(root, '.workflow', 'plans', 'current', `${planId}.md`);
// Запись полной формы: скрипт проверяет форму и наличие исполняемого файла, команду не
// запускает — код выхода самой команды здесь не важен
const WELL_FORMED_DOD = ['- [ ] Отчёт создан', '  - check: `node -e "process.exit(1)"`, expect: `exit 0`'];

test('без --activate скрипт только проверяет: passed, план не тронут', () => {
  putPlanWithTicket('PLAN-111', 'IMPL-111', { dod: WELL_FORMED_DOD });
  const before = fs.readFileSync(planFile('PLAN-111'), 'utf8');
  const result = verify('PLAN-111');
  assert.equal(result.status, 'passed');
  assert.equal(result.plan_status_unchanged, true);
  assert.equal(result.plan_status_reason, 'activation_not_requested');
  assert.equal(fs.readFileSync(planFile('PLAN-111'), 'utf8'), before);
});

test('args агента стадии из поставляемого конфига активируют план при passed', () => {
  const CONFIG = fileURLToPath(new URL('../../configs/pipeline.yaml', import.meta.url));
  const { agents } = YAML.load(fs.readFileSync(CONFIG, 'utf8')).pipeline;
  const flags = agents['script-verify-atomicity'].args.slice(1);
  assert.deepEqual(flags, ['--activate'], 'стадия передаёт флаг');

  putPlanWithTicket('PLAN-112', 'IMPL-112', { dod: WELL_FORMED_DOD });
  const result = verify('PLAN-112', flags);
  assert.equal(result.status, 'passed');
  assert.equal(result.plan_status, 'active');
  assert.equal(result.plan_previous_status, 'approved');
  assert.match(fs.readFileSync(planFile('PLAN-112'), 'utf8'), /^status: active$/m);
});

test('--activate при failed и при уже активном плане статус не меняет; флаг внутри промпта не считается', () => {
  putPlanWithTicket('PLAN-113', 'IMPL-113', { dod: ['- [ ] Без записи', '  - check: `npm test`'] });
  const failed = verify('PLAN-113', ['--activate']);
  assert.equal(failed.status, 'failed');
  assert.match(fs.readFileSync(planFile('PLAN-113'), 'utf8'), /^status: approved$/m);

  putPlanWithTicket('PLAN-114', 'IMPL-114', { dod: WELL_FORMED_DOD, planStatus: 'active' });
  const already = verify('PLAN-114', ['--activate']);
  assert.equal(already.plan_status_reason, 'already_terminal_status');

  putPlanWithTicket('PLAN-115', 'IMPL-115', { dod: WELL_FORMED_DOD });
  const prompt = `verify-atomicity --activate\n\nContext:\n  plan_file: plans/current/PLAN-115.md`;
  const run = spawnSync(process.execPath, [SCRIPT, prompt], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /plan_status_reason: activation_not_requested/);
  assert.match(fs.readFileSync(planFile('PLAN-115'), 'utf8'), /^status: approved$/m);
});

test('только флаг без промпта — код 1 и строка Usage', () => {
  const run = spawnSync(process.execPath, [SCRIPT, '--activate'], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Usage: node verify-atomicity\.js \[--activate\]/);
});
