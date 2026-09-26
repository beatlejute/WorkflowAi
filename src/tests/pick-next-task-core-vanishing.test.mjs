/**
 * Выбор тикета (src/scripts/pick-next-task-core.js), когда файл тикета исчезает
 * между листингом колонки и чтением: другой процесс пайплайна (move-ticket,
 * авто-коррекция, MCP) переносит его в этот момент. Прежде эти ветки проходили
 * только гоночные тесты и только иногда: покрытие ветвей модуля в двух полных
 * прогонах coverage 2026-09-26 дало 78.23% и 78.08% на одном коде. Здесь окно
 * детерминировано — модуль fs подменён (опция fsModule контекста): чтение
 * отмеченного файла падает с ENOENT, как у исчезнувшего.
 *
 * Что охраняется: исчезнувший тикет пропускается, проход не падает и выбирает из
 * оставшихся; сбой переноса дубликата в archive/ не останавливает выбор.
 *
 * Запуск: node --test --import ./src/tests/_rails-home.mjs src/tests/pick-next-task-core-vanishing.test.mjs
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createTicketContext,
  readReadyTickets,
  findCompletedInProgress,
  calculateReviewMetrics,
  pickNextTicket,
} from '../scripts/pick-next-task-core.js';

let root;

function ticket(id, body = '') {
  return `---\nid: ${id}\ntitle: ${id}\npriority: 2\ntype: impl\ncreated_at: "2026-09-20T10:00:00Z"\nconditions: []\ndependencies: []\n---\n\n## Описание\n\n${id}\n${body}`;
}

const DONE_RESULT = '\n## Результат выполнения\n\n### Summary\n\nСделано.\n';
const REVIEW_ROW = '\n## Ревью\n\n| Дата | Статус | Самари | Агент |\n|------|--------|--------|-------|\n| 2026-09-21 10:00 | ✅ passed | ок | review-agent |\n';

function write(column, id, body) {
  const dir = path.join(root, '.workflow', 'tickets', column);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.md`), ticket(id, body));
}

/** fs, у которого файлы с VANISH в имени есть в листинге, но не читаются. */
function vanishingFs({ renameFails = false } = {}) {
  return {
    ...fs,
    readFileSync(file, ...rest) {
      if (String(file).includes('VANISH')) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, open '${file}'`), { code: 'ENOENT' });
      }
      return fs.readFileSync(file, ...rest);
    },
    renameSync(from, to) {
      if (renameFails) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      return fs.renameSync(from, to);
    },
  };
}

const quietLogger = { info() {}, warn() {}, error() {} };

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-core-vanishing-'));
  write('ready', 'IMPL-1');
  write('ready', 'VANISH-2');
  write('in-progress', 'IMPL-3', DONE_RESULT);
  write('in-progress', 'VANISH-4', DONE_RESULT);
  write('done', 'IMPL-5', REVIEW_ROW);
  write('done', 'VANISH-6', REVIEW_ROW);
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

test('исчезнувший тикет колонки пропускается, остальные читаются', () => {
  const ctx = createTicketContext(root, { fsModule: vanishingFs(), logger: quietLogger });
  assert.deepEqual(readReadyTickets(ctx).map((t) => t.id), ['IMPL-1']);
  assert.deepEqual(findCompletedInProgress(ctx).map((t) => t.id), ['IMPL-3']);
});

test('метрики ревью считаются без исчезнувшего тикета', () => {
  const ctx = createTicketContext(root, { fsModule: vanishingFs(), logger: quietLogger });
  const metrics = calculateReviewMetrics(ctx);
  assert.deepEqual(metrics.iterations_per_ticket, { 'IMPL-5': 1 });
  assert.equal(metrics.total_passed, 1);
});

test('выбор идёт из оставшихся тикетов', () => {
  const ctx = createTicketContext(root, { fsModule: vanishingFs(), logger: quietLogger });
  const picked = pickNextTicket(ctx, null);
  assert.equal(picked.ticket_id, 'IMPL-1');
});

test('сбой переноса дубликата в archive/ не останавливает выбор', () => {
  write('ready', 'IMPL-7');
  write('review', 'IMPL-7');
  const errors = [];
  const logger = { info() {}, warn() {}, error: (message) => errors.push(message) };
  const ctx = createTicketContext(root, { fsModule: vanishingFs({ renameFails: true }), logger });
  try {
    const picked = pickNextTicket(ctx, null);
    assert.equal(picked.ticket_id, 'IMPL-1', 'дубликат пропущен, выбран следующий тикет');
    assert.match(errors.join('\n'), /Failed to archive duplicate IMPL-7: EBUSY/);
    assert.ok(fs.existsSync(path.join(root, '.workflow', 'tickets', 'ready', 'IMPL-7.md')), 'копия осталась на месте');
  } finally {
    fs.rmSync(path.join(root, '.workflow', 'tickets', 'ready', 'IMPL-7.md'), { force: true });
    fs.rmSync(path.join(root, '.workflow', 'tickets', 'review', 'IMPL-7.md'), { force: true });
  }
});
