/**
 * Стоимость mark-blocked (боевая функция из src/scripts/mark-blocked-core.js,
 * её же зовёт CLI mark-blocked.js).
 *
 * Инцидент: раньше здесь стоял бюджет «p95 ≤ 200 мс за 100 итераций» и рукописная
 * копия скрипта — поиск тикета, чтение, правка frontmatter, запись, дозапись
 * алерта. Копия жила отдельно от боевого кода: регресс в скрипте замер не видел,
 * а любое расхождение с ним давало ложную тревогу. Часы же мерили не код, а
 * загрузку машины: под полным набором те же операции идут в разы дольше.
 *
 * Здесь считается число обращений к диску — от соседей по прогону оно не зависит.
 * Цена блокировки тикета: один обход дерева тикетов до находки, одно чтение, одна
 * запись во временный файл, одна замена тикета этим файлом и одна дозапись
 * алерта. Часы остались в src/tests/perf-*.bench.mjs (npm run bench:perf, по
 * одному замеру за раз).
 *
 * Запуск: node --test src/tests/perf-mark-blocked-latency.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseFrontmatter } from 'workflow-ai/lib/utils.mjs';
import { markBlockedTicket } from '../scripts/mark-blocked-core.js';
import { createCountingFs } from './_fs-op-counter.mjs';

const TICKET_ID = 'BENCH-001';
const COLUMNS = ['ready', 'in-progress', 'blocked', 'done', 'review', 'backlog', 'approvals'];

function ticketContent(id) {
  return `---
id: "${id}"
title: "Benchmark ${id}"
priority: 2
type: "impl"
created_at: "2026-04-01T10:00:00.000Z"
updated_at: "2026-04-01T10:00:00.000Z"
---

## Description

Benchmark test ticket.
`;
}

/** Готовит доску: тикет в ready/ и `noiseTickets` посторонних тикетов в done/. */
function createBoard(noiseTickets) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-mark-blocked-'));
  const ticketsDir = path.join(tmpDir, '.workflow', 'tickets');
  const stateDir = path.join(tmpDir, '.workflow', 'state');

  for (const column of COLUMNS) {
    fs.mkdirSync(path.join(ticketsDir, column), { recursive: true });
  }
  fs.mkdirSync(stateDir, { recursive: true });

  fs.writeFileSync(path.join(ticketsDir, 'ready', `${TICKET_ID}.md`), ticketContent(TICKET_ID));
  for (let i = 0; i < noiseTickets; i++) {
    const id = `OTHER-${String(i + 1).padStart(3, '0')}`;
    fs.writeFileSync(path.join(ticketsDir, 'done', `${id}.md`), ticketContent(id));
  }

  return {
    tmpDir,
    ticketsDir,
    stateDir,
    alertsFile: path.join(stateDir, 'alerts.jsonl'),
  };
}

function markBlockedCounted(board, counter, attempts = 6) {
  return markBlockedTicket({
    ticketId: TICKET_ID,
    attempts,
    reason: 'perf_cost_probe',
    ticketsDir: board.ticketsDir,
    stateDir: board.stateDir,
    alertsFile: board.alertsFile,
    project: 'perf',
    fsModule: counter.fs,
  });
}

test('mark-blocked: цена блокировки — один обход дерева, одно чтение, одна публикация, один алерт', () => {
  const board = createBoard(0);
  const counter = createCountingFs();

  try {
    const result = markBlockedCounted(board, counter);

    // Работа сделана: без этого цифры ниже ничего не охраняют.
    const { frontmatter } = parseFrontmatter(fs.readFileSync(result.ticketFile, 'utf8'));
    assert.equal(frontmatter.auto_blocked_reason, 'perf_cost_probe');
    assert.equal(frontmatter.auto_blocked_attempts, 6);
    assert.equal(result.alertWritten, true, 'алерт должен быть дозаписан');

    assert.equal(counter.op('readFileSync'), 1, `тикет читается один раз: ${counter.describe()}`);
    // Публикация тикета идёт через временный файл: writeFileSync во временный путь
    // плюс renameSync поверх тикета. Шестая операция — цена атомарности, принятая
    // осознанно 2026-09-24: прямая запись усекала тикет до нуля, и сканеры доски
    // (pick-next-task, check-conditions, sync-ticket-status, check-anomalies)
    // читали тикет без статуса и без зависимостей, не падая и ничего не записывая
    // в журнал. Формулировка «тикет пишется один раз» здесь была бы неправдой:
    // единственная запись идёт во ВРЕМЕННЫЙ файл, а тикет получает её rename'ом.
    assert.equal(counter.op('writeFileSync'), 1, `содержимое пишется один раз, во временный файл: ${counter.describe()}`);
    assert.equal(counter.op('renameSync'), 1, `публикация тикета — одна операция замены: ${counter.describe()}`);
    assert.equal(counter.op('appendFileSync'), 1, `алерт дозаписывается один раз: ${counter.describe()}`);
    assert.equal(counter.op('existsSync'), 1, `наличие state/ проверяется один раз: ${counter.describe()}`);

    // Потолок на всё остальное. Без него цена растёт молча: новое обращение к
    // диску, которого нет в списке выше, ни один assert не заметил бы — именно так
    // прошёл незамеченным renameSync, когда запись тикета переехала на временный
    // файл. readdirSync вынесен из суммы: число обходов зависит от того, в каком
    // порядке файловая система выдаёт колонки, и охраняется отдельным потолком ниже.
    assert.deepEqual(
      Object.keys(counter.counts).sort(),
      ['appendFileSync', 'existsSync', 'readFileSync', 'readdirSync', 'renameSync', 'writeFileSync'],
      `набор обращений к диску изменился: ${counter.describe()}`,
    );
    assert.equal(
      counter.total() - counter.op('readdirSync'),
      5,
      `цена блокировки помимо обхода дерева — ровно 5 операций: ${counter.describe()}`,
    );

    // Обход прекращается на найденном тикете, поэтому точное число readdir зависит
    // от порядка выдачи каталогов файловой системой. Потолок — один проход по дереву:
    // второй проход (или повторный обход после записи) в него не влезет.
    const maxTraversal = 1 + COLUMNS.length;
    assert.ok(
      counter.op('readdirSync') <= maxTraversal,
      `обход дерева тикетов должен быть один: readdirSync=${counter.op('readdirSync')} > ${maxTraversal}; ${counter.describe()}`,
    );
  } finally {
    fs.rmSync(board.tmpDir, { recursive: true, force: true });
  }
});

test('mark-blocked: цена не растёт вместе с доской (0 посторонних тикетов против 200)', () => {
  const emptyBoard = createBoard(0);
  const fullBoard = createBoard(200);
  const emptyCounter = createCountingFs();
  const fullCounter = createCountingFs();

  try {
    markBlockedCounted(emptyBoard, emptyCounter);
    markBlockedCounted(fullBoard, fullCounter);

    assert.deepEqual(
      { ...fullCounter.counts },
      { ...emptyCounter.counts },
      'на доске 200 лишних тикетов, а обращений к диску должно быть столько же: ' +
      `пустая доска → ${emptyCounter.describe()}; полная → ${fullCounter.describe()}`,
    );
  } finally {
    fs.rmSync(emptyBoard.tmpDir, { recursive: true, force: true });
    fs.rmSync(fullBoard.tmpDir, { recursive: true, force: true });
  }
});
