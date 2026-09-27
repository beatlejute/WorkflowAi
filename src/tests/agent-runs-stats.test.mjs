/**
 * Таблица статистики по модели и типу тикета (statsTable, src/lib/agent-runs.mjs,
 * PLAN-003, задача 25) — числа по градациям, доли и активные запреты на массиве
 * событий журнала, для двух моделей и двух типов тикетов, включая строку с
 * `model: null`.
 *
 * Что охраняется:
 *  - число запусков по каждой градации, включая `stopped`, `throttled` и `pending`,
 *    совпадает с ручным подсчётом по фикстуре; проваленный контроль после запуска
 *    `throttled` в долю пройденного контроля не входит;
 *  - `artifacts_success_rate` — доля `artifacts_passed: true` среди запусков, где
 *    контроль вынес вердикт (`artifacts_passed` не null), а не среди всех запусков
 *    строки;
 *  - `review_accept_rate` — доля вердикта ревью `passed` среди запусков, у которых
 *    было ревью с вердиктом (для сведения, не влияет на запреты); `all_green` ревью не
 *    проходит и в долю не входит;
 *  - действующий постоянный запрет пары виден в строке этой пары; действующий
 *    временный запрет — запрет на модель целиком, поэтому виден во всех строках этой
 *    модели, даже с чистым по своим неудачам типом тикета;
 *  - запуски с `model: null` — отдельной строкой «модель неизвестна», без запретов.
 *
 * Тесты — чистые функции на массиве событий в памяти, файловой системы не касаются.
 *
 * Запуск: node --import ./src/tests/_rails-home.mjs --test src/tests/agent-runs-stats.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { statsTable, EXECUTOR_SKILL } from '../lib/agent-runs.mjs';

let ticketSeq = 0;
const nextTicket = () => `IMPL-${++ticketSeq}`;

function runEvent(model, ticketType, overrides = {}) {
  const { ticket = nextTicket(), ...rest } = overrides;
  return {
    type: 'run',
    ts: new Date().toISOString(),
    skill: EXECUTOR_SKILL,
    ticket,
    ticket_type: ticketType,
    agent: 'agent-a',
    model,
    status: 'ok',
    changed_files: 1,
    ...rest,
  };
}

function verifyEvent(ticket, ticketType, overrides = {}) {
  return {
    type: 'verify', ts: new Date().toISOString(), ticket, ticket_type: ticketType,
    status: 'passed', fail_reasons: [], ...overrides,
  };
}

function reviewEvent(ticket, ticketType, overrides = {}) {
  return {
    type: 'review', ts: new Date().toISOString(), ticket, ticket_type: ticketType,
    stage: 'review-result', status: 'passed', agent: 'reviewer-a', model: 'model-a', ...overrides,
  };
}

function accepted(model, ticketType) {
  const ticket = nextTicket();
  return [
    runEvent(model, ticketType, { ticket, changed_files: 2 }),
    verifyEvent(ticket, ticketType, { status: 'all_green' }),
  ];
}
function acceptedReviewed(model, ticketType) {
  const ticket = nextTicket();
  return [
    runEvent(model, ticketType, { ticket, changed_files: 2 }),
    verifyEvent(ticket, ticketType, { status: 'passed' }),
    reviewEvent(ticket, ticketType, { status: 'passed' }),
  ];
}
function reviewFailed(model, ticketType) {
  const ticket = nextTicket();
  return [
    runEvent(model, ticketType, { ticket, changed_files: 2 }),
    verifyEvent(ticket, ticketType, { status: 'passed' }),
    reviewEvent(ticket, ticketType, { status: 'failed' }),
  ];
}
function pendingWithVerify(model, ticketType) {
  const ticket = nextTicket();
  return [
    runEvent(model, ticketType, { ticket, changed_files: 2 }),
    verifyEvent(ticket, ticketType, { status: 'passed' }),
  ];
}
function pendingNoVerify(model, ticketType) {
  return [runEvent(model, ticketType, { changed_files: 2 })];
}
function emptyRun(model, ticketType) {
  return [runEvent(model, ticketType, { changed_files: 0 })];
}
function artifactsFailed(model, ticketType) {
  const ticket = nextTicket();
  return [
    runEvent(model, ticketType, { ticket, changed_files: 2 }),
    verifyEvent(ticket, ticketType, { status: 'failed', fail_reasons: ['missing_files'] }),
  ];
}
function stoppedRun(model, ticketType) {
  return [runEvent(model, ticketType, { status: 'model_banned', changed_files: 0 })];
}
// Ограничение провайдера после части работы; проваленный следом контроль модели не засчитывается.
function throttledRun(model, ticketType) {
  const ticket = nextTicket();
  return [
    runEvent(model, ticketType, { ticket, status: 'rate_limit', exit_code: 1, changed_files: 2 }),
    verifyEvent(ticket, ticketType, { status: 'failed', fail_reasons: ['missing_files'] }),
  ];
}
function refusedRun(model, ticketType) {
  return [runEvent(model, ticketType, { status: 'blocked', changed_files: 0 })];
}
function crashedRun(model, ticketType, ts) {
  return [runEvent(model, ticketType, { status: 'error', changed_files: 0, ts })];
}

const flat = (...groups) => groups.flat();

function findRow(rows, model, ticketType) {
  return rows.find((r) => r.model === model && r.ticket_type === ticketType);
}

describe('statsTable: числа по градациям и доли на model-a/model-b × code/text', () => {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  // Модель — последний по журналу запуск определяет временный запрет (crashBans
  // смотрит на самый свежий запуск модели, независимо от типа тикета), поэтому
  // сбойный запуск model-b идёт в фикстуре последним для этой модели.
  const events = flat(
    // model-a / code — вся палитра градаций, без запрета.
    accepted('model-a', 'code'),
    acceptedReviewed('model-a', 'code'),
    reviewFailed('model-a', 'code'),
    pendingWithVerify('model-a', 'code'),
    pendingNoVerify('model-a', 'code'),
    emptyRun('model-a', 'code'),
    artifactsFailed('model-a', 'code'),
    stoppedRun('model-a', 'code'),
    throttledRun('model-a', 'code'),
    refusedRun('model-a', 'code'),
    // model-a / text — три неудачи подряд без успеха — постоянный запрет по правилу 1.
    emptyRun('model-a', 'text'),
    emptyRun('model-a', 'text'),
    emptyRun('model-a', 'text'),
    // model-b / text — принят, до сбоя модели.
    accepted('model-b', 'text'),
    // model-b / code — свежий сбой, последний запуск модели — временный запрет целиком.
    crashedRun('model-b', 'code', nowIso),
    // модель kilo не прочитана.
    emptyRun(null, 'code'),
    emptyRun(null, 'code'),
  );

  const rows = statsTable(events, now);

  test('всего строк — пять: по числу пар модель+тип плюс строка model: null', () => {
    assert.equal(rows.length, 5);
  });

  test('model-a / code: числа по градациям (включая stopped, throttled и pending) и доли, без запрета', () => {
    const row = findRow(rows, 'model-a', 'code');
    assert.ok(row, 'строка найдена');
    assert.equal(row.runs, 10);
    assert.deepEqual(row.grades, {
      crashed: 0, refused: 1, stopped: 1, throttled: 1, empty: 1, artifacts_failed: 1, review_failed: 1, accepted: 2, pending: 2,
    });
    assert.equal(row.artifacts_success_rate, 4 / 5);
    // Ревью с вердиктом — у двух запусков (passed и failed); all_green в долю не входит.
    assert.equal(row.review_accept_rate, 1 / 2);
    assert.deepEqual(row.bans, []);
  });

  test('model-a / text: три неудачи подряд — постоянный запрет по правилу 1', () => {
    const row = findRow(rows, 'model-a', 'text');
    assert.ok(row);
    assert.equal(row.runs, 3);
    assert.equal(row.grades.empty, 3);
    assert.equal(row.artifacts_success_rate, null);
    assert.equal(row.review_accept_rate, null);
    assert.equal(row.bans.length, 1);
    assert.equal(row.bans[0].kind, 'permanent');
    assert.equal(row.bans[0].rule, 1);
    assert.equal(row.bans[0].ticket_type, 'text');
  });

  test('model-b / code: свежий сбой модели — временный запрет модели целиком', () => {
    const row = findRow(rows, 'model-b', 'code');
    assert.ok(row);
    assert.equal(row.runs, 1);
    assert.equal(row.grades.crashed, 1);
    assert.equal(row.bans.length, 1);
    assert.equal(row.bans[0].kind, 'crash');
    assert.equal(row.bans[0].model, 'model-b');
  });

  test('model-b / text: свой тип чист, но временный запрет модели виден и здесь', () => {
    const row = findRow(rows, 'model-b', 'text');
    assert.ok(row);
    assert.equal(row.runs, 1);
    assert.equal(row.grades.accepted, 1);
    assert.equal(row.artifacts_success_rate, 1);
    assert.equal(row.review_accept_rate, null, 'all_green — ревью не было');
    assert.equal(row.bans.length, 1);
    assert.equal(row.bans[0].kind, 'crash');
    assert.equal(row.bans[0].model, 'model-b');
  });

  test('model: null — отдельная строка «модель неизвестна», без запретов', () => {
    const row = findRow(rows, null, 'code');
    assert.ok(row);
    assert.equal(row.runs, 2);
    assert.equal(row.grades.empty, 2);
    assert.deepEqual(row.bans, []);
  });
});
