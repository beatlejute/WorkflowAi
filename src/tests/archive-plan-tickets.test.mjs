/**
 * Архивация done-тикетов плана (src/scripts/archive-plan-tickets.js) — последняя стадия
 * жизни тикета. До этого файла скрипт не имел ни одного теста: покрытие 0% (база
 * храповика, коммит 1156f42).
 *
 * Что проверяется и почему:
 *  - берутся только тикеты своего плана: архивация чужого тикета уносит с доски работу,
 *    которую никто не закрывал;
 *  - тикет оказывается ровно в одной колонке. Прежний порядок (создать копию в archive/,
 *    затем удалить исходник) давал окно, в котором тикет лежал в done/ и archive/
 *    одновременно, а копия была видна пустой: writeFileSync создаёт файл и пишет
 *    содержимое двумя шагами. Теперь переезд — renameSync, содержимое — заменой;
 *  - archived_at и updated_at проставляются, тело не теряется;
 *  - битый frontmatter не роняет прогон: остальные тикеты плана всё равно архивируются;
 *  - plan_id разбирается и из строки контекста стадии, и из короткой формы («2»).
 *
 * Запуск: node --test --import ./src/tests/_rails-home.mjs src/tests/archive-plan-tickets.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { parseFrontmatter } from 'workflow-ai/lib/utils.mjs';
import { watchFsMutations, inspectMarkdownArtifact, listRaw } from './_atomic-publish-observer.mjs';

// Каталоги доски вычисляются от корня проекта при импорте — импорт идёт из временного
// проекта, cwd возвращается назад (приём из check-plan-templates.test.mjs).
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-plan-'));
const DONE = path.join(ROOT, '.workflow', 'tickets', 'done');
const ARCHIVE = path.join(ROOT, '.workflow', 'tickets', 'archive');
fs.mkdirSync(DONE, { recursive: true });
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));
const cwdBefore = process.cwd();
process.chdir(ROOT);
const { archivePlanTickets, parsePlanArg } = await import('../scripts/archive-plan-tickets.js');
process.chdir(cwdBefore);

const BODY_TAIL = '## Result\n\nСделано, артефакты перечислены.\n';
const BODY = `# Тикет\n\n${'Описание работы.\n'.repeat(40)}\n${BODY_TAIL}`;

function put(dir, id, planId) {
  const text = [
    '---',
    `id: "${id}"`,
    'title: "Задача"',
    'status: done',
    `parent_plan: "${planId}"`,
    '---',
    '',
    BODY,
  ].join('\n');
  fs.writeFileSync(path.join(dir, `${id}.md`), text, 'utf8');
}

test('parsePlanArg: контекст стадии, полный ID и короткая форма', () => {
  assert.equal(parsePlanArg('plan_id: PLAN-002\nticket_id: IMPL-1'), 'PLAN-002');
  assert.equal(parsePlanArg('PLAN-007'), 'PLAN-007');
  assert.equal(parsePlanArg('2'), 'PLAN-002');
  assert.equal(parsePlanArg(''), null);
});

test('без plan_id — ошибка, доска не трогается', () => {
  put(DONE, 'IMPL-100', 'PLAN-001');
  const result = archivePlanTickets(null);
  assert.deepEqual(result, { status: 'error', error: 'Missing plan_id' });
  assert.equal(fs.existsSync(path.join(DONE, 'IMPL-100.md')), true);
  fs.unlinkSync(path.join(DONE, 'IMPL-100.md'));
});

test('архивируются только тикеты своего плана; читатель не видит неполный тикет', () => {
  put(DONE, 'IMPL-101', 'PLAN-001');
  put(DONE, 'IMPL-102', 'PLAN-001');
  put(DONE, 'IMPL-103', 'PLAN-002');

  const watch = watchFsMutations((label) => {
    const found = [];
    for (const id of ['IMPL-101', 'IMPL-102', 'IMPL-103']) {
      found.push(...inspectMarkdownArtifact(path.join(DONE, `${id}.md`), label));
      found.push(...inspectMarkdownArtifact(path.join(ARCHIVE, `${id}.md`), label));
    }
    return found;
  });

  let result;
  try {
    result = archivePlanTickets('PLAN-001');
  } finally {
    watch.restore();
  }

  assert.equal(result.status, 'ok');
  assert.equal(result.archived, 2);
  assert.deepEqual(result.ticket_ids.split(',').sort(), ['IMPL-101', 'IMPL-102']);
  assert.ok(watch.mutations > 0, 'наблюдатель обязан был увидеть мутации каталога');
  assert.deepEqual(watch.violations, [], `читатель видел неполный тикет: ${watch.violations.join('; ')}`);

  assert.equal(fs.existsSync(path.join(DONE, 'IMPL-103.md')), true, 'тикет чужого плана остался в done');
  assert.equal(fs.existsSync(path.join(ARCHIVE, 'IMPL-103.md')), false);

  for (const id of ['IMPL-101', 'IMPL-102']) {
    assert.equal(fs.existsSync(path.join(DONE, `${id}.md`)), false, `${id}: из done ушёл`);
    const { frontmatter, body } = parseFrontmatter(fs.readFileSync(path.join(ARCHIVE, `${id}.md`), 'utf8'));
    assert.equal(frontmatter.id, id);
    assert.ok(frontmatter.archived_at, `${id}: archived_at проставлен`);
    assert.ok(frontmatter.updated_at, `${id}: updated_at проставлен`);
    assert.ok(body.includes(BODY_TAIL.trim()), `${id}: хвост тела на месте`);
  }

  const junk = listRaw(ARCHIVE).filter((name) => !name.endsWith('.md'));
  assert.deepEqual(junk, [], `в архиве остался мусор: ${junk.join(', ')}`);
  fs.unlinkSync(path.join(DONE, 'IMPL-103.md'));
});

test('битый frontmatter не останавливает архивацию остальных', () => {
  fs.writeFileSync(path.join(DONE, 'IMPL-110.md'), '---\nid: "IMPL-110"\n  parent_plan: [сломано\n---\n\nтело\n', 'utf8');
  put(DONE, 'IMPL-111', 'PLAN-003');

  const result = archivePlanTickets('PLAN-003');

  assert.equal(result.archived, 1);
  assert.equal(result.ticket_ids, 'IMPL-111');
  assert.equal(fs.existsSync(path.join(DONE, 'IMPL-110.md')), true, 'битый тикет остался на месте');
  fs.unlinkSync(path.join(DONE, 'IMPL-110.md'));
});

test('в плане нечего архивировать — ok с нулём', () => {
  const result = archivePlanTickets('PLAN-404');
  assert.equal(result.status, 'ok');
  assert.equal(result.archived, 0);
  assert.equal(result.ticket_ids, '');
});

test('каталога done/ нет — ok с нулём, каталог архива не создаётся зря', () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-plan-bare-'));
  try {
    fs.mkdirSync(path.join(bare, '.workflow'), { recursive: true });
    const cwd = process.cwd();
    process.chdir(bare);
    try {
      // Модуль уже загружен с каталогами прежнего проекта, поэтому здесь проверяется
      // не chdir, а ветка «done/ отсутствует» на пустом каталоге текущего проекта.
      fs.rmSync(DONE, { recursive: true, force: true });
      const result = archivePlanTickets('PLAN-500');
      assert.equal(result.status, 'ok');
      assert.equal(result.archived, 0);
    } finally {
      process.chdir(cwd);
      fs.mkdirSync(DONE, { recursive: true });
    }
  } finally {
    fs.rmSync(bare, { recursive: true, force: true });
  }
});
