/**
 * Закрытие плана (src/scripts/complete-plan.js) — стадия, после которой план считается
 * выполненным, а его done-тикеты уезжают в архив. До этого файла скрипт не имел ни одного
 * теста: покрытие 0% (база храповика, коммит 1156f42).
 *
 * Своей логики у скрипта две части, обе здесь и проверяются:
 *  - разбор plan_id: пайплайн передаёт весь контекст стадии строкой, человек — ID или
 *    номер;
 *  - поиск активного плана, когда plan_id не передан. Ошибка здесь дороже всего: скрипт
 *    закрыл бы не тот план. Поэтому отдельно проверяется, что план в другом статусе не
 *    считается активным, битый файл плана пропускается, а не роняет поиск, и что при
 *    отсутствии активного плана возвращается null (стадия отвечает no_plan, а не
 *    закрывает что попало).
 *
 * Само закрытие — checkAndClosePlan из src/lib/utils.mjs, у него свои тесты.
 *
 * Запуск: node --test --import ./src/tests/_rails-home.mjs src/tests/complete-plan.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Каталог планов вычисляется от корня проекта при импорте — импорт идёт из временного
// проекта, cwd возвращается назад (приём из check-plan-templates.test.mjs).
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'complete-plan-'));
const PLANS = path.join(ROOT, '.workflow', 'plans', 'current');
fs.mkdirSync(PLANS, { recursive: true });
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));
const cwdBefore = process.cwd();
process.chdir(ROOT);
const { findActivePlan, parsePlanArg } = await import('../scripts/complete-plan.js');
process.chdir(cwdBefore);

function putPlan(id, status) {
  const text = ['---', `id: "${id}"`, 'title: "План"', `status: ${status}`, '---', '', '# План', ''].join('\n');
  fs.writeFileSync(path.join(PLANS, `${id}.md`), text, 'utf8');
}

function clearPlans() {
  for (const name of fs.readdirSync(PLANS)) fs.unlinkSync(path.join(PLANS, name));
}

test('parsePlanArg: контекст стадии, полный ID и короткая форма', () => {
  assert.equal(parsePlanArg('plan_id: PLAN-009\nstage: complete-plan'), 'PLAN-009');
  assert.equal(parsePlanArg('PLAN-011'), 'PLAN-011');
  assert.equal(parsePlanArg('9'), 'PLAN-009');
  assert.equal(parsePlanArg(''), null);
  assert.equal(parsePlanArg(undefined), null);
});

test('findActivePlan: активный план найден по статусу', () => {
  clearPlans();
  putPlan('PLAN-007', 'active');
  assert.equal(findActivePlan(), 'PLAN-007');
});

test('findActivePlan: план в другом статусе активным не считается', () => {
  clearPlans();
  putPlan('PLAN-008', 'approved');
  putPlan('PLAN-009', 'completed');
  assert.equal(findActivePlan(), null);
});

test('findActivePlan: битый файл плана пропускается, активный рядом находится', () => {
  clearPlans();
  fs.writeFileSync(path.join(PLANS, 'PLAN-010.md'), '---\nid: "PLAN-010"\n  status: [сломано\n---\n\nтело\n', 'utf8');
  putPlan('PLAN-011', 'active');
  assert.equal(findActivePlan(), 'PLAN-011');
});

test('findActivePlan: в каталоге только не-md файлы — null', () => {
  clearPlans();
  fs.writeFileSync(path.join(PLANS, 'notes.txt'), 'не план\n', 'utf8');
  assert.equal(findActivePlan(), null);
  clearPlans();
});

test('findActivePlan: пустой каталог планов — null, стадия отвечает no_plan', () => {
  clearPlans();
  assert.equal(findActivePlan(), null);
});
