/**
 * Перевод тикета из in-progress/ в review/ (src/scripts/move-to-review.js) — стадия
 * пайплайна между выполнением и ревью. До этого файла скрипт не имел ни одного теста:
 * покрытие 0% (база храповика, коммит 1156f42).
 *
 * Проверяются все пять исходов, потому что каждый меняет состояние доски:
 *  - обычный переезд из in-progress/;
 *  - тикет уже в review/ — пропуск, а не ошибка (агент мог переместить его сам);
 *  - тикет в done/ без секции ревью — агент закрыл его самовольно, тикет возвращается
 *    в review/, иначе работа уходит в done, минуя проверку;
 *  - тикет в done/ с ревью — пропуск, ревью уже состоялось;
 *  - тикета нет ни в одной колонке — ошибка, стадия обязана упасть, а не промолчать.
 *
 * Отдельно проверяется, что updated_at не меняется: verify-artifacts сравнивает mtime
 * файлов с updated_at, чтобы убедиться, что их правил агент. Обновление поля здесь
 * ложно отклонило бы все легитимные правки.
 *
 * Запуск: node --test --import ./src/tests/_rails-home.mjs src/tests/move-to-review.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { parseFrontmatter } from 'workflow-ai/lib/utils.mjs';

// Скрипт вычисляет каталоги доски от корня проекта при импорте, поэтому импорт идёт из
// временного проекта, а cwd возвращается назад (приём из check-plan-templates.test.mjs).
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'move-to-review-'));
const TICKETS = path.join(ROOT, '.workflow', 'tickets');
for (const dir of ['in-progress', 'review', 'done', 'archive']) {
  fs.mkdirSync(path.join(TICKETS, dir), { recursive: true });
}
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));
const cwdBefore = process.cwd();
process.chdir(ROOT);
const { moveToReview, parseTicketId } = await import('../scripts/move-to-review.js');
process.chdir(cwdBefore);

const UPDATED_AT = '2026-09-24T08:00:00.000Z';

function ticketText(id, { review = null } = {}) {
  const head = [
    '---',
    `id: "${id}"`,
    'title: "Задача"',
    'status: in-progress',
    'parent_plan: "PLAN-001"',
    `updated_at: "${UPDATED_AT}"`,
    '---',
    '',
    '# Тикет',
    '',
    '## Result',
    '',
    'Сделано.',
    '',
  ].join('\n');
  if (!review) return head;
  // Статус в канонической форме со значком: getLastReviewStatus распознаёт только её
  // (src/lib/review-section.mjs — `✅ passed`, `❌ failed`, `⏭️ skipped`), а голое
  // слово в ячейке читается как «ревью нет».
  return `${head}\n## Ревью\n\n| Дата | Статус | Самари | Агент |\n|------|--------|--------|-------|\n| 2026-09-24 | ${review} | всё хорошо | claude-sonnet |\n`;
}

const at = (dir, id) => path.join(TICKETS, dir, `${id}.md`);
const put = (dir, id, opts) => fs.writeFileSync(at(dir, id), ticketText(id, opts), 'utf8');

test('parseTicketId: берёт id из контекста раннера, иначе null', () => {
  assert.equal(parseTicketId('Твоя роль: ревью\nticket_id: IMPL-042\nplan_id: PLAN-001'), 'IMPL-042');
  assert.equal(parseTicketId('ticket_id:QA-7'), 'QA-7');
  assert.equal(parseTicketId('без идентификатора'), null);
  assert.equal(parseTicketId(''), null);
});

test('обычный переезд: тикет уходит в review/, содержимое и updated_at целы', () => {
  const id = 'IMPL-001';
  put('in-progress', id);

  const result = moveToReview(id);

  assert.deepEqual(result, { status: 'moved', ticket_id: id, from: 'in-progress', to: 'review' });
  assert.equal(fs.existsSync(at('in-progress', id)), false, 'из in-progress тикет ушёл');
  const content = fs.readFileSync(at('review', id), 'utf8');
  const { frontmatter } = parseFrontmatter(content);
  assert.equal(frontmatter.id, id);
  assert.equal(frontmatter.updated_at, UPDATED_AT, 'updated_at не трогается: на него смотрит verify-artifacts');
  assert.match(content, /## Result/);
});

test('тикет уже в review/: пропуск с причиной, а не ошибка', () => {
  const id = 'IMPL-002';
  put('review', id);

  const result = moveToReview(id);

  assert.equal(result.status, 'skipped');
  assert.match(result.reason, /already in review/);
});

test('тикет в done/ без ревью: возвращается в review/ — иначе работа минует проверку', () => {
  const id = 'IMPL-003';
  put('done', id);

  const result = moveToReview(id);

  assert.deepEqual(result, { status: 'moved', ticket_id: id, from: 'done', to: 'review' });
  assert.equal(fs.existsSync(at('done', id)), false);
  assert.equal(fs.existsSync(at('review', id)), true);
});

test('тикет в done/ с ревью: пропуск — проверка уже состоялась', () => {
  const id = 'IMPL-004';
  put('done', id, { review: '✅ passed' });

  const result = moveToReview(id);

  assert.equal(result.status, 'skipped');
  assert.match(result.reason, /already in done\/ with review/);
  assert.equal(fs.existsSync(at('done', id)), true, 'тикет остался в done');
});

test('тикет в archive/: пропуск с причиной', () => {
  const id = 'IMPL-005';
  put('archive', id, { review: '✅ passed' });

  const result = moveToReview(id);

  assert.equal(result.status, 'skipped');
  assert.match(result.reason, /already in archive/);
});

test('тикета нет ни в одной колонке: ошибка, стадия падает', () => {
  const result = moveToReview('IMPL-999');

  assert.equal(result.status, 'error');
  assert.match(result.error, /not found in in-progress/);
});

test('переезд не оставляет рядом временных файлов', () => {
  const id = 'IMPL-006';
  put('in-progress', id);

  moveToReview(id);

  const junk = fs.readdirSync(path.join(TICKETS, 'review')).filter((name) => !name.endsWith('.md') || name.startsWith('.'));
  assert.deepEqual(junk, [], `в колонке остался мусор: ${junk.join(', ')}`);
});
