/**
 * Стоимость выбора следующего тикета на большой доске (боевые функции из
 * src/scripts/pick-next-task-core.js, их же зовёт pick-next-task.js).
 *
 * Инцидент: раньше здесь стоял бюджет «p95 ≤ 500 мс за 100 итераций» и рукописная
 * копия выбора. Копия была легче боевой функции — без дедупликации, проверки
 * условий и зависимостей, — то есть охраняла не тот код: регресс в
 * pick-next-task.js она увидеть не могла. А часы мерили загрузку машины: те же
 * операции под полным набором идут в разы дольше, чем в изоляции.
 *
 * Здесь считается число обращений к диску — оно не зависит от соседей по прогону.
 * Бюджет линеен по числу тикетов: один проход чтения для выбора, один для метрик,
 * по одной проверке каждой соседней колонки на дубль. Лишний проход по каталогу
 * или повторное чтение всех тикетов ломают точную цифру. Часы остались в
 * src/tests/perf-*.bench.mjs (npm run bench:perf, по одному замеру за раз).
 *
 * Запуск: node --test src/tests/perf-pick-next-task-large-backlog.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  createTicketContext,
  pickNextTicket,
  calculateReviewMetrics,
  DUPLICATE_SCAN_DIR_KEYS,
  METRICS_DIR_KEYS,
} from '../scripts/pick-next-task-core.js';
import { createCountingFs } from './_fs-op-counter.mjs';

const TICKET_COUNT = 100;
const COLUMNS = ['ready', 'done', 'in-progress', 'review', 'blocked', 'archive', 'backlog'];

function ticketContent(id, type, priority) {
  return `---
id: "${id}"
title: "Benchmark ${id}"
priority: ${priority}
type: "${type}"
created_at: "2026-04-01T10:00:00.000Z"
updated_at: "2026-04-01T10:00:00.000Z"
conditions: []
dependencies: []
tags: []
---

## Description

Benchmark ticket ${id}.

## Критерии готовности (Definition of Done)

- [ ] Done
`;
}

/** Доска с `count` тикетами в ready/: 70% impl, 30% human, приоритеты по кругу 1-5. */
function createBacklog(count) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-pick-next-task-'));
  const ticketsDir = path.join(tmpDir, '.workflow', 'tickets');
  for (const column of COLUMNS) {
    fs.mkdirSync(path.join(ticketsDir, column), { recursive: true });
  }

  const readyDir = path.join(ticketsDir, 'ready');
  const humanFrom = Math.round(count * 0.7);
  for (let i = 0; i < count; i++) {
    const id = `BENCH-${String(i + 1).padStart(3, '0')}`;
    fs.writeFileSync(path.join(readyDir, `${id}.md`), ticketContent(id, i < humanFrom ? 'impl' : 'human', (i % 5) + 1));
  }

  return { tmpDir, projectDir: tmpDir };
}

test(`pick-next-task: цена выбора на ${TICKET_COUNT} тикетах — ровно два прохода чтения и одна проверка дубля на колонку`, () => {
  const board = createBacklog(TICKET_COUNT);
  const counter = createCountingFs();
  const ctx = createTicketContext(board.projectDir, { fsModule: counter.fs });

  try {
    const result = pickNextTicket(ctx);
    const metrics = calculateReviewMetrics(ctx);

    // Работа сделана: без этого цифры ниже ничего не охраняют.
    assert.equal(result.status, 'found', `ожидался найденный тикет, получено "${result.status}"`);
    assert.equal(result.ticket_id, 'BENCH-001', 'при равных датах выбирается тикет с высшим приоритетом');
    assert.equal(metrics.tickets_with_reviews, 0, 'у бенчмарковых тикетов нет секции ревью');

    // readdir: ready/ при выборе + по разу на каждую колонку в метриках.
    const expectedReaddirs = 1 + METRICS_DIR_KEYS.length;
    // readFileSync: один проход по ready/ при выборе + один проход метрик по всем
    // колонкам (тикеты лежат только в ready/).
    const expectedReads = TICKET_COUNT * 2;
    // existsSync: ready/ при выборе + дедупликация каждого тикета по соседним
    // колонкам + проверка каждой колонки в метриках.
    const expectedExists = 1 + TICKET_COUNT * DUPLICATE_SCAN_DIR_KEYS.length + METRICS_DIR_KEYS.length;

    assert.equal(
      counter.op('readdirSync'), expectedReaddirs,
      `каталоги читаются по разу, лишний проход — регресс: ${counter.describe()}`,
    );
    assert.equal(
      counter.op('readFileSync'), expectedReads,
      `каждый тикет читается дважды (выбор + метрики), третий проход — регресс: ${counter.describe()}`,
    );
    assert.equal(
      counter.op('existsSync'), expectedExists,
      `проверок существования должно быть ${expectedExists}: ${counter.describe()}`,
    );
    assert.equal(counter.op('writeFileSync'), 0, `выбор тикета не пишет на диск: ${counter.describe()}`);
    assert.equal(counter.op('renameSync'), 0, `дублей нет — перемещать нечего: ${counter.describe()}`);
  } finally {
    fs.rmSync(board.tmpDir, { recursive: true, force: true });
  }
});

test('pick-next-task: цена линейна по числу тикетов (25 против 100, без квадратичного роста)', () => {
  const smallBoard = createBacklog(25);
  const largeBoard = createBacklog(TICKET_COUNT);
  const smallCounter = createCountingFs();
  const largeCounter = createCountingFs();

  try {
    for (const [board, counter] of [[smallBoard, smallCounter], [largeBoard, largeCounter]]) {
      const ctx = createTicketContext(board.projectDir, { fsModule: counter.fs });
      pickNextTicket(ctx);
      calculateReviewMetrics(ctx);
    }

    // Квадратичный регресс (проход по всем тикетам внутри цикла по тикетам) даёт
    // рост в 16 раз при четырёхкратной доске — линейный ровно в 4.
    const growth = largeCounter.op('readFileSync') / smallCounter.op('readFileSync');
    assert.equal(
      growth, 4,
      'тикетов в 4 раза больше — чтений тоже в 4 раза, не больше: ' +
      `25 тикетов → ${smallCounter.describe()}; ${TICKET_COUNT} тикетов → ${largeCounter.describe()}`,
    );
    assert.equal(
      largeCounter.op('readdirSync'), smallCounter.op('readdirSync'),
      `число обходов каталогов от размера доски не зависит: ${largeCounter.describe()}`,
    );
  } finally {
    fs.rmSync(smallBoard.tmpDir, { recursive: true, force: true });
    fs.rmSync(largeBoard.tmpDir, { recursive: true, force: true });
  }
});
