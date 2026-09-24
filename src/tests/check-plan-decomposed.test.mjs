/**
 * Маршрут стадии по состоянию декомпозиции плана (src/scripts/check-plan-decomposed.js).
 * До этого файла скрипт не имел ни одного теста: покрытие 0% (база храповика, коммит
 * 1156f42), а решает он, куда пойдёт пайплайн — на декомпозицию, на проверку атомарности
 * или в работу.
 *
 * Цена ошибки в каждом исходе:
 *  - needs_decomposition вместо decomposed — план декомпозируется второй раз, тикеты
 *    дублируются;
 *  - decomposed вместо needs_decomposition — план с нулём тикетов уходит «в работу», и
 *    пайплайн крутится вхолостую;
 *  - потерянный awaiting_atomicity — тикеты идут в работу без подтверждения атомарности,
 *    то есть ровно мимо той проверки, ради которой статус approved и отделён от active;
 *  - active без тикетов не должен возвращать никакой маршрут: это аномалия (тикеты уже
 *    закрыты и заархивированы), и стадия обязана её пропустить, а не зациклиться.
 *
 * Решение вынесено в decidePlan/decideAllPlans, чтобы проверять его без перехвата stdout.
 *
 * Запуск: node --test --import ./src/tests/_rails-home.mjs src/tests/check-plan-decomposed.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { normalizePlanId } from 'workflow-ai/lib/utils.mjs';

// Каталоги вычисляются от корня проекта при импорте — импорт из временного проекта,
// cwd возвращается назад (приём из check-plan-templates.test.mjs).
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-decomposed-'));
const PLANS = path.join(ROOT, '.workflow', 'plans', 'current');
const TICKETS = path.join(ROOT, '.workflow', 'tickets');
fs.mkdirSync(PLANS, { recursive: true });
for (const dir of ['backlog', 'ready', 'in-progress', 'review', 'done', 'blocked']) {
  fs.mkdirSync(path.join(TICKETS, dir), { recursive: true });
}
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));
const cwdBefore = process.cwd();
process.chdir(ROOT);
const { decidePlan, decideAllPlans, findPlanFile, getPlanStatus, hasTicketsForPlan, getAllPlanFiles } =
  await import('../scripts/check-plan-decomposed.js');
process.chdir(cwdBefore);

function putPlan(id, status, fileName = `${id}.md`) {
  const text = ['---', `id: "${id}"`, 'title: "План"', `status: ${status}`, '---', '', '# План', ''].join('\n');
  fs.writeFileSync(path.join(PLANS, fileName), text, 'utf8');
}

function putTicket(dir, id, planId) {
  const text = ['---', `id: "${id}"`, 'title: "Задача"', `status: ${dir}`, `parent_plan: "${planId}"`, '---', '', '# Тикет', ''].join('\n');
  fs.writeFileSync(path.join(TICKETS, dir, `${id}.md`), text, 'utf8');
}

function reset() {
  for (const name of fs.readdirSync(PLANS)) fs.unlinkSync(path.join(PLANS, name));
  for (const dir of ['backlog', 'ready', 'in-progress', 'review', 'done', 'blocked']) {
    for (const name of fs.readdirSync(path.join(TICKETS, dir))) fs.unlinkSync(path.join(TICKETS, dir, name));
  }
}

test('режим одного плана: файла плана нет — no_plan', () => {
  reset();
  assert.deepEqual(decidePlan('PLAN-404'), { status: 'no_plan' });
});

test('режим одного плана: approved без тикетов — на декомпозицию', () => {
  reset();
  putPlan('PLAN-001', 'approved');
  assert.deepEqual(decidePlan('PLAN-001'), { status: 'needs_decomposition', plan_file: 'plans/current/PLAN-001.md' });
});

test('режим одного плана: approved с тикетами — на проверку атомарности', () => {
  reset();
  putPlan('PLAN-002', 'approved');
  putTicket('backlog', 'IMPL-001', 'PLAN-002');
  assert.deepEqual(decidePlan('PLAN-002'), { status: 'awaiting_atomicity', plan_file: 'plans/current/PLAN-002.md' });
});

test('режим одного плана: active с тикетами — decomposed', () => {
  reset();
  putPlan('PLAN-003', 'active');
  putTicket('in-progress', 'IMPL-002', 'PLAN-003');
  assert.deepEqual(decidePlan('PLAN-003'), { status: 'decomposed' });
});

test('режим одного плана: тикеты есть, статус посторонний — decomposed', () => {
  reset();
  putPlan('PLAN-004', 'completed');
  putTicket('done', 'IMPL-003', 'PLAN-004');
  assert.deepEqual(decidePlan('PLAN-004'), { status: 'decomposed' });
});

test('тикет другого плана не считается тикетом этого плана', () => {
  reset();
  putPlan('PLAN-005', 'approved');
  putTicket('backlog', 'IMPL-004', 'PLAN-006');
  assert.equal(hasTicketsForPlan('PLAN-005'), false);
  assert.deepEqual(decidePlan('PLAN-005'), { status: 'needs_decomposition', plan_file: 'plans/current/PLAN-005.md' });
});

test('битый тикет не роняет поиск: тикет плана рядом всё равно найден', () => {
  reset();
  putPlan('PLAN-007', 'approved');
  fs.writeFileSync(path.join(TICKETS, 'backlog', 'IMPL-005.md'), '---\nid: "IMPL-005"\n  parent_plan: [сломано\n---\n\nтело\n', 'utf8');
  putTicket('backlog', 'IMPL-006', 'PLAN-007');
  assert.equal(hasTicketsForPlan('PLAN-007'), true);
});

// Имя в другом регистре: на NTFS точная проверка существования проходит сама
// (файловая система регистр не различает, проверено этим тестом на Windows), на
// Linux срабатывает запасной перебор файлов каталога с normalizePlanId. Оба пути
// обязаны привести к тому же плану, поэтому сверяется не буква имени, а его
// нормализованный ID. Имя с суффиксом — PLAN-008-refactor.md — не опознаётся ни
// точным совпадением, ни перебором: normalizePlanId принимает ровно
// `plan-<цифры>` (src/lib/utils.mjs:428).
test('findPlanFile: имя в другом регистре ведёт к тому же плану, имя с суффиксом — нет', () => {
  reset();
  putPlan('PLAN-008', 'active', 'plan-008.md');
  const found = findPlanFile('PLAN-008');
  assert.ok(found, 'план в нижнем регистре обязан находиться');
  assert.equal(normalizePlanId(found), 'PLAN-008');
  assert.equal(getPlanStatus(found), 'active');
  assert.equal(getPlanStatus('plans/current/нет-такого.md'), null);

  reset();
  putPlan('PLAN-008', 'active', 'PLAN-008-refactor.md');
  assert.equal(findPlanFile('PLAN-008'), null, 'имя с суффиксом планом не считается');
});

test('getAllPlanFiles: не-md и файлы без номера плана отбрасываются', () => {
  reset();
  putPlan('PLAN-009', 'approved');
  fs.writeFileSync(path.join(PLANS, 'README.md'), '# заметка\n', 'utf8');
  fs.writeFileSync(path.join(PLANS, 'notes.txt'), 'не план\n', 'utf8');
  assert.deepEqual(getAllPlanFiles(), [{ planId: 'PLAN-009', planFile: 'plans/current/PLAN-009.md' }]);
});

test('режим всех планов: планов нет — no_plan', () => {
  reset();
  assert.deepEqual(decideAllPlans(), { status: 'no_plan' });
});

test('режим всех планов: draft и completed пропускаются, approved без тикетов даёт маршрут', () => {
  reset();
  putPlan('PLAN-010', 'draft');
  putPlan('PLAN-011', 'completed');
  putPlan('PLAN-012', 'approved');
  assert.deepEqual(decideAllPlans(), { status: 'needs_decomposition', plan_file: 'plans/current/PLAN-012.md' });
});

test('режим всех планов: active без тикетов — аномалия, пропуск, а не маршрут', () => {
  reset();
  putPlan('PLAN-013', 'active');
  assert.deepEqual(decideAllPlans(), { status: 'decomposed' });
});

test('режим всех планов: все активные планы с тикетами — decomposed', () => {
  reset();
  putPlan('PLAN-014', 'active');
  putTicket('review', 'IMPL-007', 'PLAN-014');
  assert.deepEqual(decideAllPlans(), { status: 'decomposed' });
});
