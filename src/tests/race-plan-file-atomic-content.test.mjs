#!/usr/bin/env node

/**
 * Регресс: план и шаблон плана появляются в каталоге целиком.
 *
 * Три места писали файл плана прямой записью: закрытие плана
 * (checkAndClosePlan в src/lib/utils.mjs), создание плана из шаблона и
 * обновление last_triggered в шаблоне (src/scripts/check-plan-templates.js).
 * Прямая запись сначала обрезает файл до нуля.
 *
 * Здесь это дороже, чем у approval-файла. Читатели плана — listPlans и getPlan
 * из src/lib/operations/plans.mjs, то есть MCP list_plans и get_plan. try/catch
 * там стоит только вокруг чтения каталога (на случай ENOENT), а вокруг разбора
 * конкретного файла — нет, и ретраев нет никаких. При этом parseFrontmatter('')
 * не бросает: он возвращает пустой frontmatter. Значит в окно гонки MCP отдаёт
 * вызывающему план без id, заголовка и статуса — не ошибку, а правдоподобный
 * ответ. Решение по плану принимается на пустых данных, и в журнале нет ни
 * строки.
 *
 * Тест не измеряет время: наблюдатель встаёт вместо методов fs и после каждой
 * мутации читает план глазами getPlan.
 *
 * Запуск: node --test src/tests/race-plan-file-atomic-content.test.mjs
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  watchFsMutations,
  inspectMarkdownArtifact,
  listAsScanner,
  listRaw,
} from './_atomic-publish-observer.mjs';
import { checkAndClosePlan, createFileExclusiveSync, parsePublishTempName } from '../lib/utils.mjs';
import { getPlan, listPlans } from '../lib/operations/plans.mjs';

const PLAN_ID = 'PLAN-007';
const TEMPLATE_ID = 'TMPL-001';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHECK_PLAN_TEMPLATES = path.resolve(__dirname, '../scripts/check-plan-templates.js');

const TICKET_COLUMNS = ['backlog', 'ready', 'in-progress', 'blocked', 'review', 'done', 'archive'];

function planContent(id, status) {
  return `---\nid: ${id}\ntitle: План для проверки атомарности\nstatus: ${status}\n` +
    `author: tester\ncreated_at: 2026-09-24\nupdated_at: 2026-09-24\n---\n\n## Цель\n\nТело плана.\n`;
}

function ticketContent(id, planId) {
  return `---\nid: ${id}\ntitle: Тикет плана\nstatus: done\ntype: impl\n` +
    `parent_plan: plans/current/${planId}.md\ncompleted_at: 2026-09-24T00:00:00.000Z\n---\n\nТело.\n`;
}

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-atomic-'));
  const workflowDir = path.join(root, '.workflow');
  const plansDir = path.join(workflowDir, 'plans', 'current');
  const templatesDir = path.join(workflowDir, 'plans', 'templates');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.mkdirSync(templatesDir, { recursive: true });
  for (const column of TICKET_COLUMNS) {
    fs.mkdirSync(path.join(workflowDir, 'tickets', column), { recursive: true });
  }
  return { root, workflowDir, plansDir, templatesDir };
}

/** Снимок каталога планов глазами getPlan/listPlans. */
function makePlanInspector(plansDir, fileName) {
  return (label) => {
    const violations = inspectMarkdownArtifact(path.join(plansDir, fileName), label);
    for (const entry of listAsScanner(plansDir)) {
      if (entry !== fileName) {
        violations.push(`${label}: сканирование каталога планов видит посторонний файл "${entry}"`);
      }
    }
    return violations;
  };
}

describe('закрытие плана: читателю виден либо прежний план, либо закрытый', () => {
  it('checkAndClosePlan не показывает план без id и заголовка', async () => {
    const project = makeProject();
    const planFile = `${PLAN_ID}.md`;
    fs.writeFileSync(path.join(project.plansDir, planFile), planContent(PLAN_ID, 'approved'), 'utf8');
    fs.writeFileSync(
      path.join(project.workflowDir, 'tickets', 'done', 'IMPL-010.md'),
      ticketContent('IMPL-010', PLAN_ID),
      'utf8',
    );

    const observer = watchFsMutations(makePlanInspector(project.plansDir, planFile));
    let result;
    try {
      result = checkAndClosePlan(project.workflowDir, PLAN_ID);
    } finally {
      observer.restore();
    }

    try {
      assert.equal(result.closed, true, `план должен был закрыться: ${JSON.stringify(result)}`);
      assert.ok(observer.mutations > 0, 'наблюдатель не увидел ни одной мутации — тест ничего не проверил');
      assert.deepEqual(observer.violations, [], observer.violations.join('\n'));

      const plan = await getPlan(project.root, PLAN_ID);
      assert.equal(plan.frontmatter.status, 'completed');
      assert.equal(plan.frontmatter.title, 'План для проверки атомарности');
      assert.match(plan.body, /Тело плана/);

      const plans = await listPlans(project.root);
      assert.deepEqual(plans.map(p => p.id), [PLAN_ID], 'временный файл не должен попасть в список планов');

      const leftovers = listRaw(project.plansDir).filter(f => parsePublishTempName(f));
      assert.deepEqual(leftovers, [], `остались временные файлы: ${leftovers.join(', ')}`);
    } finally {
      fs.rmSync(project.root, { recursive: true, force: true });
    }
  });
});

// Скрипт считает корень проекта при импорте, поэтому временный проект заводится
// до импорта, а cwd возвращается сразу после.
const templatesProject = makeProject();
const cwdBeforeImport = process.cwd();
process.chdir(templatesProject.root);
const { createPlanFromTemplate, updateTemplateLastTriggered } =
  await import('../scripts/check-plan-templates.js');
process.chdir(cwdBeforeImport);

after(() => fs.rmSync(templatesProject.root, { recursive: true, force: true }));

describe('создание плана из шаблона и обновление шаблона', () => {
  const templateFm = {
    id: TEMPLATE_ID,
    title: 'Еженедельная уборка',
    type: 'template',
    enabled: true,
    author: 'tester',
    trigger: { type: 'daily', params: {} },
    last_triggered: '',
  };

  it('созданный план ни на миг не виден пустым', async () => {
    const planFile = `${PLAN_ID}.md`;
    const templatePath = path.join(templatesProject.templatesDir, `${TEMPLATE_ID}.md`);
    fs.writeFileSync(templatePath, planContent(TEMPLATE_ID, 'template'), 'utf8');

    const observer = watchFsMutations(makePlanInspector(templatesProject.plansDir, planFile));
    try {
      createPlanFromTemplate(templatePath, { ...templateFm }, '## Цель\n\nТело шаблона.\n', PLAN_ID, '2026-09-24');
    } finally {
      observer.restore();
    }

    assert.ok(observer.mutations > 0, 'наблюдатель не увидел ни одной мутации — тест ничего не проверил');
    assert.deepEqual(observer.violations, [], observer.violations.join('\n'));

    const plan = await getPlan(templatesProject.root, PLAN_ID);
    assert.equal(plan.frontmatter.status, 'approved');
    assert.match(plan.frontmatter.title, /Еженедельная уборка/);

    const leftovers = listRaw(templatesProject.plansDir).filter(f => parsePublishTempName(f));
    assert.deepEqual(leftovers, [], `остались временные файлы: ${leftovers.join(', ')}`);
  });

  it('занятый номер плана отвергается, а не затирается молча', () => {
    // Номер плана выдаёт сканирование каталога (generateNextPlanId). Если тот же
    // номер уже выдан соседнему прогону, перезапись означала бы потерянный план.
    // Поэтому здесь link, а не rename: занятое имя — отказ EEXIST.
    const existing = path.join(templatesProject.plansDir, `${PLAN_ID}.md`);
    const before = fs.readFileSync(existing, 'utf8');

    assert.throws(
      () => createFileExclusiveSync(existing, planContent(PLAN_ID, 'чужой план')),
      (err) => err.code === 'EEXIST',
      'создание плана поверх занятого номера обязано отказать, а не затереть чужой план',
    );

    assert.equal(fs.readFileSync(existing, 'utf8'), before, 'существующий план не должен пострадать');
    const leftovers = listRaw(templatesProject.plansDir).filter(f => parsePublishTempName(f));
    assert.deepEqual(leftovers, [], `после отказа остались временные файлы: ${leftovers.join(', ')}`);
  });

  it('обновление last_triggered не показывает шаблон без trigger', () => {
    const templateFile = `${TEMPLATE_ID}.md`;
    const templatePath = path.join(templatesProject.templatesDir, templateFile);
    const body = '## Цель\n\nТело шаблона.\n';
    fs.writeFileSync(
      templatePath,
      `---\nid: ${TEMPLATE_ID}\ntitle: Еженедельная уборка\ntype: template\nenabled: true\n` +
      `trigger:\n  type: daily\nlast_triggered: ''\n---\n\n${body}`,
      'utf8',
    );

    const observer = watchFsMutations(makePlanInspector(templatesProject.templatesDir, templateFile));
    try {
      updateTemplateLastTriggered(templatePath, { ...templateFm }, body, '2026-09-24');
    } finally {
      observer.restore();
    }

    assert.ok(observer.mutations > 0, 'наблюдатель не увидел ни одной мутации — тест ничего не проверил');
    assert.deepEqual(observer.violations, [], observer.violations.join('\n'));

    const updated = fs.readFileSync(templatePath, 'utf8');
    assert.match(updated, /last_triggered: ["']?2026-09-24["']?/, 'дата срабатывания должна записаться');
    assert.match(updated, /type: template/, 'шаблон должен остаться шаблоном');
    assert.match(updated, /Тело шаблона/);

    const leftovers = listRaw(templatesProject.templatesDir).filter(f => parsePublishTempName(f));
    assert.deepEqual(leftovers, [], `остались временные файлы: ${leftovers.join(', ')}`);
  });
});

describe('ни один пишущий путь не возвращает прямую запись поверх плана', () => {
  const SITES = [
    {
      file: path.resolve(__dirname, '../lib/utils.mjs'),
      forbidden: ['fs.writeFileSync(planPath', 'fs.writeFileSync(destPath'],
      required: 'replaceFileAtomicSync(planPath',
    },
    {
      file: CHECK_PLAN_TEMPLATES,
      forbidden: ['fs.writeFileSync(planPath', 'fs.writeFileSync(templatePath'],
      required: 'createFileExclusiveSync(planPath',
    },
  ];

  for (const site of SITES) {
    it(`${path.basename(site.file)} публикует план через общий помощник`, () => {
      const source = fs.readFileSync(site.file, 'utf8');
      for (const bad of site.forbidden) {
        assert.ok(
          !source.includes(bad),
          `${path.basename(site.file)}: вернулась прямая запись "${bad}" — MCP get_plan/list_plans ` +
          'в окно гонки отдают план без id и заголовка вместо ошибки'
        );
      }
      assert.ok(source.includes(site.required), `${path.basename(site.file)}: нет "${site.required}"`);
    });
  }
});
