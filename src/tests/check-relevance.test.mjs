/**
 * Проверка актуальности тикета (src/scripts/check-relevance.js) — развилка перед
 * выполнением: relevant — тикет идёт в работу, irrelevant — получает строку ревью
 * «skipped» и не выполняется. До этого файла скрипт не имел ни одного теста: покрытие 0%
 * (база храповика, коммит 1156f42).
 *
 * Цена ошибки в обе стороны:
 *  - ложный irrelevant — работа молча не делается, а тикет помечается пропущенным;
 *  - ложный relevant — сделанная работа выполняется второй раз.
 * Поэтому каждое правило развилки проверено своим сценарием, а поломки чтения тикета —
 * отдельно: при любой из них скрипт обязан выбрать relevant (fail-safe), а не пропуск.
 *
 * Дефект, найденный этими тестами и закрытый тем же изменением (проверено запуском
 * 2026-09-24): конец секции искался якорем `\z`, которого в JS-регэкспах нет, — это
 * буква «z». Секция критериев готовности, стоящая последней, не находилась вовсе, а
 * секция с буквой z обрезалась на ней, и невыполненный пункт после этого места не
 * считался. Тесты «критерии последней секцией» и «буква z» краснели на старом коде.
 *
 * Запуск: node --test --import ./src/tests/_rails-home.mjs src/tests/check-relevance.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { getLastReviewStatus } from 'workflow-ai/lib/utils.mjs';

// Каталоги вычисляются от корня проекта при импорте — импорт из временного проекта,
// cwd возвращается назад (приём из check-plan-templates.test.mjs).
// realpath: на macOS tmpdir — ссылка /var → /private/var, а `cwd` после chdir — настоящий
// путь; без него каталоги скрипта и пути теста расходились (CI macOS 2026-09-25).
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'check-relevance-')));
const WF = path.join(ROOT, '.workflow');
const TICKETS = path.join(WF, 'tickets');
for (const dir of ['backlog', 'ready', 'in-progress', 'blocked', 'review', 'done', 'archive']) {
  fs.mkdirSync(path.join(TICKETS, dir), { recursive: true });
}
fs.mkdirSync(path.join(WF, 'plans', 'current'), { recursive: true });
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));
const cwdBefore = process.cwd();
process.chdir(ROOT);
const mod = await import('../scripts/check-relevance.js');
process.chdir(cwdBefore);
const { checkRelevance, getDodCompletion, getBlockedSection, resolveTicketArg, getCurrentStatus, extractPlanId, addSkippedReview } = mod;

const REVIEW = (status) => `## Ревью\n\n| Дата | Статус | Самари | Агент |\n|------|--------|--------|-------|\n| 2026-09-24 | ${status} | — | a |\n`;

function ticket({ fm = {}, body = '# Тикет\n' } = {}) {
  const lines = ['---', 'id: "IMPL-001"', 'title: "Задача"'];
  for (const [k, v] of Object.entries(fm)) lines.push(`${k}: ${JSON.stringify(v)}`);
  lines.push('---', '', body);
  return lines.join('\n');
}

function put(dir, id, content) {
  const file = path.join(TICKETS, dir, `${id}.md`);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

function putPlan(id, status) {
  fs.writeFileSync(path.join(WF, 'plans', 'current', `${id}.md`), `---\nid: "${id}"\nstatus: ${status}\n---\n`, 'utf8');
}

function quiet(fn) {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = warn;
  }
}

// ---------- чтение секций ----------

test('критерии готовности: все отмечены — выполнено, есть неотмеченный — нет', () => {
  const all = '## Критерии готовности\n\n- [x] a\n- [X] b\n\n## Result\n';
  assert.deepEqual(getDodCompletion(all), { completed: true, total: 2, checked: 2 });
  const partial = '## Критерии готовности\n\n- [x] a\n- [ ] b\n\n## Result\n';
  assert.deepEqual(getDodCompletion(partial), { completed: false, total: 2, checked: 1 });
  assert.deepEqual(getDodCompletion('# без секции\n'), { completed: false, total: 0, checked: 0 });
});

test('критерии готовности последней секцией находятся (прежде якорь \\z её терял)', () => {
  const last = '# Тикет\n\n## Критерии готовности\n\n- [x] a\n- [x] b\n';
  assert.deepEqual(getDodCompletion(last), { completed: true, total: 2, checked: 2 });
});

test('буква z в тексте критерия не обрезает секцию (прежде невыполненный пункт терялся)', () => {
  const withZ = '## Критерии готовности\n\n- [x] size ok\n- [ ] второй пункт\n\n## Result\n';
  assert.deepEqual(getDodCompletion(withZ), { completed: false, total: 2, checked: 1 });
});

test('секция блокировок: текст до следующего заголовка и последней секцией', () => {
  assert.equal(getBlockedSection('## Блокировки\n\nждём ключ API\n\n## Result\n'), 'ждём ключ API');
  assert.equal(getBlockedSection('## Блокировки\n\nждём ключ от zone-сервиса\n'), 'ждём ключ от zone-сервиса');
  assert.equal(getBlockedSection('# без секции\n'), '');
});

test('resolveTicketArg: контекст стадии и голый ID ведут в in-progress, путь — как есть', () => {
  const inProgress = path.join(TICKETS, 'in-progress', 'IMPL-042.md');
  assert.equal(resolveTicketArg('ticket_id: IMPL-042\nplan_id: PLAN-001'), inProgress);
  assert.equal(resolveTicketArg('IMPL-042'), inProgress);
  assert.equal(resolveTicketArg('some/ticket.md', ROOT), path.resolve(ROOT, 'some/ticket.md'));
  const abs = path.join(ROOT, 'x.md');
  assert.equal(resolveTicketArg(abs), abs);
});

test('getCurrentStatus и extractPlanId: колонка по пути, план по имени', () => {
  assert.equal(getCurrentStatus(path.join(TICKETS, 'ready', 'IMPL-1.md')), 'ready');
  assert.equal(getCurrentStatus(path.join(ROOT, 'elsewhere', 'IMPL-1.md')), null);
  assert.equal(extractPlanId('plans/current/PLAN-7.md'), 'PLAN-007');
  assert.equal(extractPlanId('custom-plan'), 'custom-plan');
  assert.equal(extractPlanId(''), null);
});

// ---------- развилка ----------

test('файла нет — relevant/file_not_found: пайплайн идёт дальше, а не пропускает работу', async () => {
  const r = await checkRelevance(path.join(TICKETS, 'in-progress', 'NOPE-1.md'));
  assert.equal(r.verdict, 'relevant');
  assert.equal(r.reason, 'file_not_found');
});

test('битый frontmatter — relevant (fail-safe)', async () => {
  const file = put('in-progress', 'IMPL-010', '---\nid: "IMPL-010"\n  status: [сломано\n---\n\nтело\n');
  const r = await checkRelevance(file);
  assert.equal(r.verdict, 'relevant');
  assert.equal(r.reason, 'invalid_frontmatter');
});

test('последнее ревью skipped — irrelevant/already_skipped', async () => {
  const file = put('in-progress', 'IMPL-011', ticket({ body: `# Тикет\n\n${REVIEW('⏭️ skipped')}` }));
  assert.deepEqual(await checkRelevance(file), { verdict: 'irrelevant', reason: 'already_skipped' });
});

test('последнее ревью failed — relevant: нужна доработка', async () => {
  const file = put('in-progress', 'IMPL-012', ticket({ body: `# Тикет\n\n${REVIEW('❌ failed')}` }));
  assert.deepEqual(await checkRelevance(file), { verdict: 'relevant', reason: 'review_failed_needs_rework' });
});

test('флаг blocked и непустая секция блокировок — relevant/blocked', async () => {
  const flagged = put('in-progress', 'IMPL-013', ticket({ fm: { blocked: true } }));
  assert.deepEqual(await checkRelevance(flagged), { verdict: 'relevant', reason: 'blocked' });
  const section = put('in-progress', 'IMPL-014', ticket({ body: '# Тикет\n\n## Блокировки\n\nждём доступ к стенду\n' }));
  assert.deepEqual(await checkRelevance(section), { verdict: 'relevant', reason: 'blocked' });
});

test('план закрыт — irrelevant/plan_inactive; план активен — дальше по правилам', async () => {
  putPlan('PLAN-020', 'completed');
  const closed = put('in-progress', 'IMPL-020', ticket({ fm: { parent_plan: 'PLAN-020' } }));
  assert.deepEqual(await checkRelevance(closed), { verdict: 'irrelevant', reason: 'plan_inactive' });

  putPlan('PLAN-021', 'active');
  const open = put('in-progress', 'IMPL-021', ticket({ fm: { parent_plan: 'PLAN-021' } }));
  assert.deepEqual(await checkRelevance(open), { verdict: 'relevant', reason: 'all_checks_passed' });
});

test('критерии выполнены и результат есть: с пройденным ревью — irrelevant, без ревью — на ревью', async () => {
  const body = '# Тикет\n\n## Критерии готовности\n\n- [x] a\n\n## Result\n\nСделано.\n';
  const reviewed = put('in-progress', 'IMPL-030', ticket({ body: `${body}\n${REVIEW('✅ passed')}` }));
  assert.deepEqual(await checkRelevance(reviewed), { verdict: 'irrelevant', reason: 'dod_completed' });

  const unreviewed = put('in-progress', 'IMPL-031', ticket({ body }));
  const r = await quiet(() => checkRelevance(unreviewed));
  assert.deepEqual(r, { verdict: 'relevant', reason: 'needs_review' });
});

test('невыполненный критерий после буквы z не даёт пропустить тикет с пройденным ревью', async () => {
  const body = '# Тикет\n\n## Критерии готовности\n\n- [x] size ok\n- [ ] второй пункт\n\n## Result\n\nСделано.\n';
  const file = put('in-progress', 'IMPL-032', ticket({ body: `${body}\n${REVIEW('✅ passed')}` }));
  const r = await checkRelevance(file);
  assert.notEqual(r.reason, 'dod_completed', 'пункт после буквы z не выполнен — тикет не закрыт');
});

test('зависимость исчезла с доски — irrelevant/dependencies_inactive', async () => {
  const file = put('in-progress', 'IMPL-040', ticket({ fm: { dependencies: ['IMPL-999'] } }));
  assert.deepEqual(await quiet(() => checkRelevance(file)), { verdict: 'irrelevant', reason: 'dependencies_inactive' });
});

test('зависимость заблокирована как неактуальная — irrelevant; просто заблокирована — relevant', async () => {
  // Маркер — буквальная подстрока «неактуально» в теле (регистр не важен);
  // «неактуальным» её не содержит, поэтому в фикстуре именно маркер.
  put('blocked', 'IMPL-041', ticket({ body: '# Тикет\n\nСтатус: НЕАКТУАЛЬНО.\n' }));
  const onDead = put('in-progress', 'IMPL-042', ticket({ fm: { dependencies: ['IMPL-041'] } }));
  assert.deepEqual(await quiet(() => checkRelevance(onDead)), { verdict: 'irrelevant', reason: 'dependencies_inactive' });

  put('blocked', 'IMPL-043', ticket({ body: '# Тикет\n\nЖдём доступ.\n' }));
  const onBlocked = put('in-progress', 'IMPL-044', ticket({ fm: { dependencies: ['IMPL-043'] } }));
  assert.deepEqual(await quiet(() => checkRelevance(onBlocked)), { verdict: 'relevant', reason: 'all_checks_passed' });
});

test('addSkippedReview: строка ревью skipped дописывается в тикет', () => {
  const file = put('in-progress', 'IMPL-050', ticket());
  addSkippedReview(file, 'plan_inactive');
  assert.equal(quiet(() => getLastReviewStatus(fs.readFileSync(file, 'utf8'))), 'skipped');
  assert.match(fs.readFileSync(file, 'utf8'), /script-check-relevance/);
});

test('addSkippedReview: тикета нет — исключение, а не молчаливый пропуск', () => {
  assert.throws(() => addSkippedReview(path.join(TICKETS, 'in-progress', 'NOPE-2.md'), 'x'), /addSkippedReview failed: FILE_NOT_FOUND/);
});
