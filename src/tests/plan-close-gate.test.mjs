/**
 * Кто и когда закрывает план.
 *
 * 2026-09-30 PulseProxy PLAN-020: pick-next-task при заданном plan_id вызывал
 * checkAndClosePlan и закрыл план (status: completed, 36 тикетов в archive/) в 17:33 —
 * до create-report и analyze-report, в обход гейта критериев успеха разбора. complete-plan
 * после разбора completed ответил not_ready «Plan already completed». Там же QA-175
 * записал дефект подсказки geoBlockedTitle, три разбора его пропустили, и план закрыт с
 * дефектом в коде. Охраняется:
 *  - pick-next-task план только считает: все тикеты в done/ — план и тикеты не тронуты;
 *  - complete-plan на закрытом плане — completed с already_completed, файлы не тронуты;
 *  - checkAndClosePlan (единственный закрывающий — complete-plan) не закрывает план, пока
 *    готовый тикет плана записал в «### Найденные дефекты» дефект без исправления:
 *    исправление — более поздний готовый тикет того же плана, который называет записавший
 *    полем unblocks или supersedes либо фразой «исправление дефекта <ID>»; тикет, закрытый
 *    заменой (superseded_by), исправлен своей заменой; старые тикеты без подраздела и
 *    запись «нет» проходят.
 *
 * Запуск: node --test --import ./src/tests/_rails-home.mjs src/tests/plan-close-gate.test.mjs
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { checkAndClosePlan, countPlanTickets, recordedDefects } from '../lib/utils.mjs';
import { defectHeadline } from '../scripts/complete-plan.js';

const PICK = fileURLToPath(new URL('../scripts/pick-next-task.js', import.meta.url));
const COMPLETE = fileURLToPath(new URL('../scripts/complete-plan.js', import.meta.url));
const COLUMNS = ['backlog', 'ready', 'in-progress', 'blocked', 'review', 'done', 'archive'];
const ROOTS = [];
after(() => { for (const dir of ROOTS) fs.rmSync(dir, { recursive: true, force: true }); });

function makeProject(planStatus = 'active') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-close-gate-'));
  ROOTS.push(root);
  const workflowDir = path.join(root, '.workflow');
  const plansDir = path.join(workflowDir, 'plans', 'current');
  fs.mkdirSync(plansDir, { recursive: true });
  for (const column of COLUMNS) fs.mkdirSync(path.join(workflowDir, 'tickets', column), { recursive: true });
  const planFile = path.join(plansDir, 'PLAN-020.md');
  fs.writeFileSync(planFile, `---\nid: PLAN-020\ntitle: План\nstatus: ${planStatus}\n---\n\n# План\n`, 'utf8');
  return { root, workflowDir, planFile };
}

/** Тикет в колонке: frontmatter из пар `fm`, «## Описание» и секция результата. */
function putTicket(project, column, id, { fm = {}, description = 'Сделать.', defects, plan = 'PLAN-020' } = {}) {
  const lines = ['---', `id: ${id}`, `title: ${JSON.stringify(fm.title || `Тикет ${id}`)}`, `parent_plan: plans/current/${plan}.md`];
  for (const [key, value] of Object.entries(fm)) {
    if (key !== 'title') lines.push(`${key}: ${JSON.stringify(value)}`);
  }
  lines.push('---', '', '## Описание', '', description, '', '## Результат выполнения', '', '### Summary', '', 'Сценарий проведён.', '');
  if (defects !== undefined) lines.push('### Найденные дефекты', '', defects, '');
  lines.push('### Время выполнения', '', '- Completed: x', '', '## История работы', '');
  const file = path.join(project.workflowDir, 'tickets', column, `${id}.md`);
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return file;
}

function parseResult(stdout) {
  const block = stdout.split('---RESULT---')[1] ?? '';
  return Object.fromEntries(block.split(/\r?\n/).map((l) => /^(\w+):\s*(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].trim()]));
}

function runScript(script, root, arg) {
  const res = spawnSync(process.execPath, arg === undefined ? [script] : [script, arg], { cwd: root, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  return { stdout: res.stdout, result: parseResult(res.stdout) };
}

const DEFECT = '- подсказка вкладки при гео-блоке не равна `geoBlockedTitle`\n- вторая строка';

test('pick-next-task с plan_id: все тикеты в done/ — план не закрыт, тикеты не архивированы', () => {
  const project = makeProject();
  putTicket(project, 'done', 'IMPL-1', { fm: { completed_at: '2026-09-30T10:00:00Z' } });
  putTicket(project, 'done', 'QA-2', { fm: { completed_at: '2026-09-30T11:00:00Z' } });
  const planBefore = fs.readFileSync(project.planFile, 'utf8');

  const { stdout } = runScript(PICK, project.root, 'plan_id: PLAN-020');

  assert.equal(fs.readFileSync(project.planFile, 'utf8'), planBefore, 'выбор задачи переписал план');
  assert.deepEqual(fs.readdirSync(path.join(project.workflowDir, 'tickets', 'done')).sort(), ['IMPL-1.md', 'QA-2.md']);
  assert.deepEqual(fs.readdirSync(path.join(project.workflowDir, 'tickets', 'archive')), []);
  assert.match(stdout, /Plan PLAN-020: all 2 tickets done — closing is up to complete-plan/);
  assert.doesNotMatch(stdout, /Plan PLAN-020 closed/);
});

test('countPlanTickets: считает тикеты плана по колонкам и ничего не пишет', () => {
  const project = makeProject();
  putTicket(project, 'done', 'IMPL-1');
  putTicket(project, 'archive', 'IMPL-2');
  putTicket(project, 'blocked', 'QA-3');
  putTicket(project, 'done', 'IMPL-9', { plan: 'PLAN-021' });
  const planBefore = fs.readFileSync(project.planFile, 'utf8');
  assert.deepEqual(countPlanTickets(project.workflowDir, 'PLAN-020'), { total: 3, done: 2 });
  assert.deepEqual(countPlanTickets(project.workflowDir, null), { total: 0, done: 0 });
  assert.equal(fs.readFileSync(project.planFile, 'utf8'), planBefore);
});

test('complete-plan на закрытом плане — completed с already_completed, ничего не меняется', () => {
  const project = makeProject('completed');
  const ticket = putTicket(project, 'done', 'IMPL-1', { fm: { completed_at: '2026-09-30T10:00:00Z' } });
  const planBefore = fs.readFileSync(project.planFile, 'utf8');
  const ticketBefore = fs.readFileSync(ticket, 'utf8');

  const { result } = runScript(COMPLETE, project.root, 'plan_id: PLAN-020');

  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.already_completed, 'true');
  assert.equal(result.archived, '0');
  assert.equal(fs.readFileSync(project.planFile, 'utf8'), planBefore);
  assert.equal(fs.readFileSync(ticket, 'utf8'), ticketBefore, 'повтор тронул тикет');
});

test('complete-plan: дефект без исправления — not_ready с перечнем, план открыт, тикеты в done/', () => {
  const project = makeProject();
  putTicket(project, 'done', 'IMPL-1', { fm: { completed_at: '2026-09-30T05:00:00Z' } });
  putTicket(project, 'done', 'QA-175', { fm: { completed_at: '2026-09-30T06:44:00Z' }, defects: DEFECT });
  const planBefore = fs.readFileSync(project.planFile, 'utf8');

  const { stdout, result } = runScript(COMPLETE, project.root, 'plan_id: PLAN-020');

  assert.equal(result.status, 'not_ready', JSON.stringify(result));
  assert.equal(result.defects, 'QA-175');
  assert.match(result.reason, /QA-175/);
  assert.match(stdout, /\[WARN\] QA-175: записан дефект без исправления — - подсказка вкладки/);
  assert.match(stdout, /^\[WARN\] Plan PLAN-020 not closed: Unfixed defects: QA-175$/m);
  assert.equal(fs.readFileSync(project.planFile, 'utf8'), planBefore, 'план с дефектом закрыт');
  assert.deepEqual(fs.readdirSync(path.join(project.workflowDir, 'tickets', 'archive')), []);
});

test('checkAndClosePlan: запись «нет», пустой подраздел, комментарий шаблона и тикет без подраздела не держат план', () => {
  for (const defects of ['нет', 'Нет.', 'НЕТ', '- нет', '', '<!-- «нет» или список дефектов -->', undefined]) {
    const project = makeProject();
    putTicket(project, 'done', 'QA-1', { fm: { completed_at: '2026-09-30T06:00:00Z' }, defects });
    const result = checkAndClosePlan(project.workflowDir, 'PLAN-020');
    assert.equal(result.closed, true, `${JSON.stringify(defects)}: ${JSON.stringify(result)}`);
  }
});

test('checkAndClosePlan: дефект исправлен более поздним готовым тикетом плана — unblocks, supersedes, фраза в описании или заголовке', () => {
  const cases = [
    { name: 'unblocks', fixer: { fm: { unblocks: ['QA-175'], completed_at: '2026-09-30T08:00:00Z' } } },
    { name: 'supersedes', fixer: { fm: { supersedes: ['QA-175'], completed_at: '2026-09-30T08:00:00Z' } } },
    { name: 'описание', fixer: { fm: { completed_at: '2026-09-30T08:00:00Z' }, description: 'Исправление дефекта QA-175: подсказка на en.' } },
    { name: 'заголовок', fixer: { fm: { title: 'Исправление дефекта QA-175', completed_at: '2026-09-30T08:00:00Z' } } },
    { name: 'в archive/', column: 'archive', fixer: { fm: { unblocks: ['QA-175'], completed_at: '2026-09-30T08:00:00Z' } } },
  ];
  for (const { name, fixer, column = 'done' } of cases) {
    const project = makeProject();
    putTicket(project, 'done', 'QA-175', { fm: { completed_at: '2026-09-30T06:44:00Z' }, defects: DEFECT });
    putTicket(project, column, 'FIX-40', fixer);
    const result = checkAndClosePlan(project.workflowDir, 'PLAN-020');
    assert.equal(result.closed, true, `${name}: ${JSON.stringify(result)}`);
  }
});

test('checkAndClosePlan: не исправление — раньше дефекта, без времени, другой план, чужой id, испорченное поле', () => {
  const cases = [
    { name: 'закрыт раньше записи дефекта', fixer: { fm: { unblocks: ['QA-175'], completed_at: '2026-09-30T06:00:00Z' } } },
    { name: 'то же время', fixer: { fm: { unblocks: ['QA-175'], completed_at: '2026-09-30T06:44:00Z' } } },
    { name: 'без completed_at', fixer: { fm: { unblocks: ['QA-175'] } } },
    { name: 'тикет другого плана', fixer: { plan: 'PLAN-021', fm: { unblocks: ['QA-175'], completed_at: '2026-09-30T08:00:00Z' } } },
    { name: 'другой id с тем же началом', fixer: { fm: { completed_at: '2026-09-30T08:00:00Z' }, description: 'Исправление дефекта QA-1750.' } },
    { name: 'id без фразы', fixer: { fm: { completed_at: '2026-09-30T08:00:00Z' }, description: 'Дефект найден QA-175.' } },
    { name: 'unblocks строкой', fixer: { fm: { unblocks: 'QA-175', completed_at: '2026-09-30T08:00:00Z' } } },
    { name: 'закрыт заменой без rechecked_at', fixer: { fm: { unblocks: ['QA-175'], superseded_by: 'QA-9', completed_at: '2026-09-30T08:00:00Z' } } },
  ];
  for (const { name, fixer } of cases) {
    const project = makeProject();
    putTicket(project, 'done', 'QA-175', { fm: { completed_at: '2026-09-30T06:44:00Z' }, defects: DEFECT });
    putTicket(project, 'done', 'FIX-40', fixer);
    const planBefore = fs.readFileSync(project.planFile, 'utf8');
    const result = checkAndClosePlan(project.workflowDir, 'PLAN-020');
    assert.equal(result.closed, false, `${name}: ${JSON.stringify(result)}`);
    assert.deepEqual(result.defects, [{ id: 'QA-175', defects: DEFECT }], name);
    assert.equal(fs.readFileSync(project.planFile, 'utf8'), planBefore, name);
  }
});

// check-conditions.js закрывает заблокированный тикет тестирования заменой: T в done/ с
// superseded_by: R и completed_at позже, чем R. Запись T заменила проверка R — её
// подраздел и решает.
test('checkAndClosePlan: тикет, закрытый заменой, исправлен своей заменой; дефект самой замены держит план', () => {
  const project = makeProject();
  putTicket(project, 'done', 'QA-162', {
    fm: { superseded_by: 'QA-163', rechecked_at: '2026-09-30T08:00:00Z', completed_at: '2026-09-30T08:05:00Z' },
    defects: '- бейдж не сменился',
  });
  putTicket(project, 'done', 'QA-163', { fm: { supersedes: ['QA-162'], completed_at: '2026-09-30T08:00:00Z' }, defects: 'нет' });
  assert.equal(checkAndClosePlan(project.workflowDir, 'PLAN-020').closed, true);

  const second = makeProject();
  putTicket(second, 'done', 'QA-162', {
    fm: { superseded_by: 'QA-163', rechecked_at: '2026-09-30T08:00:00Z', completed_at: '2026-09-30T08:05:00Z' },
    defects: '- бейдж не сменился',
  });
  putTicket(second, 'done', 'QA-163', { fm: { supersedes: ['QA-162'], completed_at: '2026-09-30T08:00:00Z' }, defects: '- подсказка на ru' });
  const result = checkAndClosePlan(second.workflowDir, 'PLAN-020');
  assert.deepEqual(result.defects, [{ id: 'QA-163', defects: '- подсказка на ru' }]);
});

test('recordedDefects: подраздел ищется только в секции результата, до следующего заголовка', () => {
  assert.equal(recordedDefects('## Описание\n\n### Найденные дефекты\n\nбаг\n'), null, 'вне секции результата');
  assert.equal(recordedDefects('## Результат выполнения\n\n### Summary\n\nok\n'), null, 'подраздела нет');
  assert.equal(recordedDefects('## Результат выполнения\n\n### Найденные дефекты\n\n- баг\n\n### Время выполнения\n\n- x\n\n## История\n\nтекст\n'), '- баг');
  assert.equal(recordedDefects('## Результат выполнения\n\n### Найденные дефекты\n\nнет\n\n## История работы\n\n- баг\n'), null);
  assert.equal(recordedDefects(undefined), null);
});

// 2026-10-01 ревью: записи «дефектов нет» из тикетов PulseProxy читались дефектом и навсегда
// держали план в not_ready. Тексты QA-004 и QA-031 — дословно (первые строки подраздела).
const QA_004_NONE = 'Дефектов не обнаружено.\n\n**Задокументированные поведения:**\n\n- **[ПОВЕДЕНИЕ 4.4]** Создание пресета без прокси разрешено (`proxyId: null`). Валидация отсутствует.';
const QA_031_NONE = '**Дефектов не обнаружено.**';
const QA_002_TABLE = '| ID | Severity | Описание | Статус |\n|----|----------|----------|--------|\n| QA-002-BUG-001 | HIGH | Удаление прокси не сбрасывает proxyId у привязанных пресетов | Зафиксирован, тикет в `in-progress/` |';

const inResult = (defects, tail = '### Время выполнения\n\n- x\n\n## Ревью\n\n| Дата | Статус |\n') =>
  `## Описание\n\nСделать.\n\n## Результат выполнения\n\n### Summary\n\nok\n\n### Найденные дефекты\n\n${defects}\n\n${tail}`;

test('recordedDefects: «дефектов нет» в формулировках реальных тикетов и пустой пункт шаблона — не дефект', () => {
  for (const none of [QA_004_NONE, QA_031_NONE, '**Нет.**', '- **нет**', '* нет', '—', '-', '- —', '0', 'Не обнаружено', 'Дефекты не найдены.', 'нет дефектов', '_Нет_']) {
    assert.equal(recordedDefects(inResult(none)), null, JSON.stringify(none));
  }
});

test('recordedDefects: запись дефекта — не «дефектов нет»', () => {
  for (const defect of [QA_002_TABLE, '**DEF-005-01 (Severity: Low — UX)**: Отсутствует валидация', 'Нет подсказки geoBlockedTitle на вкладке', 'Дефектов не обнаружено, кроме одного: подсказка на en', '1']) {
    assert.equal(recordedDefects(inResult(defect)), defect, JSON.stringify(defect));
  }
});

test('recordedDefects: заголовки в блоках кода не обрывают ни секцию результата, ни подраздел', () => {
  const codeInResult = '## Результат выполнения\n\n### Summary\n\n```md\n## Не заголовок\n```\n\n### Найденные дефекты\n\n- баг\n\n## Ревью\n';
  assert.equal(recordedDefects(codeInResult), '- баг', '«## …» в коде оборвал секцию результата');
  const codeInRecord = '- баг в скрипте:\n\n```sh\n# шаг 1\nnode x.js\n```\n\n- второй баг';
  assert.equal(recordedDefects(inResult(codeInRecord)), codeInRecord, '«# …» в коде оборвал подраздел');
  const tildes = '- баг\n\n~~~\n### Время выполнения\n~~~\n\nхвост';
  assert.equal(recordedDefects(inResult(tildes)), tildes);
  // Блок кода, не закрытый до конца: всё после открытия — код.
  assert.equal(recordedDefects('## Результат выполнения\n\n```\n### Найденные дефекты\n\n- баг\n'), null);
});

// workflowAiVsCode QA-54: «## Результат выполнения» → «## Отчёт о тестировании: …» →
// «### Найденные дефекты» (пять дефектов) → «## История работы».
test('recordedDefects: свой H2 исполнителя внутри результата — подраздел после него виден; ревью и история — уже не результат', () => {
  const qa54 = '## Результат выполнения\n\nСм. отчёт.\n\n## Отчёт о тестировании: QA-54 Regression Sweep PLAN-027\n\n### Вердикт\n\nFAIL\n\n### Найденные дефекты\n\n| # | Дефект |\n|---|---|\n| 1 | DEFECT-001 |\n\n### Наблюдения\n\n- x\n\n## История работы\n\n- y\n';
  assert.equal(recordedDefects(qa54), '| # | Дефект |\n|---|---|\n| 1 | DEFECT-001 |');
  assert.equal(recordedDefects('## Результат выполнения\n\n### Summary\n\nok\n\n## Ревью\n\n### Найденные дефекты\n\n- замечание ревьюера\n'), null, 'подраздел в «## Ревью» — не запись исполнителя');
  assert.equal(recordedDefects('## Результат выполнения\n\nok\n\n## История работы\n\n### Найденные дефекты\n\n- x\n'), null);
  assert.equal(recordedDefects('## Result\n\nok\n\n## Review\n\n### Найденные дефекты\n\n- x\n'), null);
});

test('recordedDefects: повторное выполнение дописало результат — решает последний подраздел', () => {
  const retried = '## Результат выполнения\n\n### Найденные дефекты\n\n- баг\n\n## Результат выполнения (attempt 2)\n\n### Найденные дефекты\n\nнет\n\n## Ревью\n';
  assert.equal(recordedDefects(retried), null);
  const regressed = '## Результат выполнения\n\n### Найденные дефекты\n\nнет\n\n## Результат выполнения (attempt 2)\n\n### Найденные дефекты\n\n- регресс\n\n## Ревью\n';
  assert.equal(recordedDefects(regressed), '- регресс');
});

test('recordedDefects: тикет с CRLF', () => {
  assert.equal(recordedDefects(inResult('- баг').replace(/\n/g, '\r\n')), '- баг');
  assert.equal(recordedDefects(inResult('Нет.').replace(/\n/g, '\r\n')), null);
});

test('defectHeadline: у таблицы — первая строка данных, иначе первая непустая', () => {
  assert.equal(defectHeadline(QA_002_TABLE), '| QA-002-BUG-001 | HIGH | Удаление прокси не сбрасывает proxyId у привязанных пресетов | Зафиксирован, тикет в `in-progress/` |');
  assert.equal(defectHeadline('| ID | Описание |\n|:---|---:|\n| DEF-010-1 | ellipsis |'), '| DEF-010-1 | ellipsis |');
  assert.equal(defectHeadline('\n\n- подсказка\n- вторая'), '- подсказка');
  assert.equal(defectHeadline('| одна строка таблицы без шапки |'), '| одна строка таблицы без шапки |');
  assert.equal(defectHeadline('| A | B |\n|---|---|'), '');
  assert.equal(defectHeadline(''), '');
});

test('complete-plan: дефект таблицей — в WARN строка дефекта, а не шапка', () => {
  const project = makeProject();
  putTicket(project, 'done', 'QA-002', { fm: { completed_at: '2026-09-30T06:44:00Z' }, defects: QA_002_TABLE });
  const { stdout, result } = runScript(COMPLETE, project.root, 'plan_id: PLAN-020');
  assert.equal(result.status, 'not_ready');
  assert.match(stdout, /^\[WARN\] QA-002: записан дефект без исправления — \| QA-002-BUG-001 \| HIGH \|/m);
});

test('complete-plan: все тикеты готовы, дефектов нет — план закрыт, done-тикеты в archive/', () => {
  const project = makeProject();
  putTicket(project, 'done', 'IMPL-1', { fm: { completed_at: '2026-09-30T05:00:00Z' } });
  putTicket(project, 'archive', 'IMPL-2', { fm: { completed_at: '2026-09-29T05:00:00Z' } });
  putTicket(project, 'done', 'QA-3', { fm: { completed_at: '2026-09-30T06:00:00Z' }, defects: QA_031_NONE });

  const { stdout, result } = runScript(COMPLETE, project.root, 'plan_id: PLAN-020');

  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.plan_id, 'PLAN-020');
  assert.equal(result.total, '3');
  assert.equal(result.done, '3');
  assert.equal(result.archived, '2');
  assert.equal(result.already_completed, undefined);
  assert.match(stdout, /Plan PLAN-020 completed: 3\/3 tickets done, 2 archived/);
  assert.match(fs.readFileSync(project.planFile, 'utf8'), /^status: completed$/m);
  assert.deepEqual(fs.readdirSync(path.join(project.workflowDir, 'tickets', 'done')), []);
  assert.deepEqual(fs.readdirSync(path.join(project.workflowDir, 'tickets', 'archive')).sort(), ['IMPL-1.md', 'IMPL-2.md', 'QA-3.md']);
});

// 2026-10-01 ревью: после разбора completed прогон шёл complete-plan → not_ready «N-1/N» →
// end на каждом запуске, без строки о заблокированном тикете.
test('complete-plan: открытые тикеты — not_ready без defects; тикеты в blocked/ названы с причиной', () => {
  const project = makeProject();
  putTicket(project, 'done', 'IMPL-1', { fm: { completed_at: '2026-09-30T05:00:00Z' } });
  putTicket(project, 'blocked', 'DOCS-014', { fm: { blocked_reason: 'write_deny: .workflow/src/skills/**\nHuman action required' } });
  putTicket(project, 'blocked', 'QA-9');
  putTicket(project, 'ready', 'IMPL-2');
  const planBefore = fs.readFileSync(project.planFile, 'utf8');

  const { stdout, result } = runScript(COMPLETE, project.root, 'plan_id: PLAN-020');

  assert.equal(result.status, 'not_ready', JSON.stringify(result));
  assert.equal(result.reason, '1/4 tickets done');
  assert.equal(result.defects, undefined);
  assert.equal(result.blocked_tickets, 'DOCS-014, QA-9');
  assert.match(stdout, /^\[WARN\] DOCS-014: blocked — write_deny: \.workflow\/src\/skills\/\*\*$/m);
  assert.match(stdout, /^\[WARN\] QA-9: blocked — причина не записана$/m);
  assert.match(stdout, /^\[WARN\] Plan PLAN-020 not closed: 1\/4 tickets done$/m);
  assert.equal(fs.readFileSync(project.planFile, 'utf8'), planBefore);
});

test('complete-plan: открытый тикет без blocked/ — not_ready строкой INFO, без blocked_tickets', () => {
  const project = makeProject();
  putTicket(project, 'done', 'IMPL-1', { fm: { completed_at: '2026-09-30T05:00:00Z' } });
  putTicket(project, 'in-progress', 'IMPL-2');
  const { stdout, result } = runScript(COMPLETE, project.root, 'plan_id: PLAN-020');
  assert.equal(result.status, 'not_ready');
  assert.equal(result.blocked_tickets, undefined);
  assert.match(stdout, /^\[INFO\] Plan PLAN-020 not closed: 1\/2 tickets done$/m);
  assert.doesNotMatch(stdout, /\[WARN\]/);
});

test('complete-plan: у плана нет тикетов — not_ready «No tickets found for plan»', () => {
  const project = makeProject();
  const { result } = runScript(COMPLETE, project.root, 'PLAN-020');
  assert.equal(result.status, 'not_ready');
  assert.equal(result.reason, 'No tickets found for plan');
  assert.equal(result.blocked_tickets, undefined);
});

test('complete-plan: без plan_id находит активный план; нет ни плана, ни активного — no_plan', () => {
  const project = makeProject();
  putTicket(project, 'done', 'IMPL-1', { fm: { completed_at: '2026-09-30T05:00:00Z' } });
  const found = runScript(COMPLETE, project.root);
  assert.match(found.stdout, /No plan_id in context, searching for active plan/);
  assert.match(found.stdout, /Found active plan: PLAN-020/);
  assert.equal(found.result.status, 'completed');
  assert.equal(found.result.plan_id, 'PLAN-020');

  // Аргумент без plan_id тоже ведёт к поиску активного; после закрытия активного нет.
  const none = runScript(COMPLETE, project.root, 'контекст без плана');
  assert.equal(none.result.status, 'no_plan');
  assert.match(none.stdout, /No active plan found/);

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-close-gate-'));
  ROOTS.push(empty);
  fs.mkdirSync(path.join(empty, '.workflow'));
  assert.equal(runScript(COMPLETE, empty).result.status, 'no_plan', 'нет plans/current/ — no_plan');
});

test('checkAndClosePlan: не все тикеты готовы — blocked с первой строкой blocked_reason, у других плана — нет', () => {
  const project = makeProject();
  putTicket(project, 'blocked', 'DOCS-014', { fm: { blocked_reason: '\n  write_deny\n  second' } });
  putTicket(project, 'blocked', 'QA-9', { plan: 'PLAN-021', fm: { blocked_reason: 'чужой' } });
  putTicket(project, 'review', 'IMPL-3');
  const result = checkAndClosePlan(project.workflowDir, 'PLAN-020');
  assert.equal(result.closed, false);
  assert.deepEqual(result.blocked, [{ id: 'DOCS-014', reason: 'write_deny' }]);
});
