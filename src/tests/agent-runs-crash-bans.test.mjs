/**
 * Временные запреты модели за сбои (crashBans, src/lib/agent-runs.mjs).
 *
 * Модель под временным запретом, если её последний запуск исполнителя без
 * градации stopped после последнего unban этой модели без ticket_type — сбой
 * (crashed или crashed_after_work), и now ещё не дошло до ts + crash_ttl_ms.
 * Тип тикета не учитывается — запрет на модель целиком. Тесты — на массивах
 * событий в памяти с фиксированным now; crashBans сам вызывает gradeIndexed,
 * так что промежуточные градации здесь отдельно не проверяются (это делает
 * agent-runs-grades.test.mjs).
 *
 * Что охраняется:
 *  - TTL: сбой недавно — запрет; тот же сбой после истечения TTL — нет;
 *    без crash_ttl_ms в событии — TTL по умолчанию (1 час);
 *  - «последний запуск» смотрит мимо stopped: model_banned и aborted
 *    остановки пайплайна (stop_requested/interrupted) после сбоя запрет не
 *    снимают, а сами по себе, без предшествующего сбоя, запрета не дают;
 *  - успешный запуск той же модели после сбоя снимает запрет, тип тикета
 *    роли не играет;
 *  - aborted без stop_requested и interrupted (агент снят сигналом не
 *    остановкой пайплайна) — сбой и даёт запрет;
 *  - unban модели без ticket_type снимает запрет; unban с ticket_type снимает
 *    только постоянный запрет пары и этого запрета не трогает;
 *  - crashed_after_work (changed_files: null, без вердикта) уходит во
 *    временный запрет так же, как обычный crashed;
 *  - запуск с model: null во временный запрет не идёт.
 *
 * Запуск: node --import ./src/tests/_rails-home.mjs --test src/tests/agent-runs-crash-bans.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { crashBans, CRASH_TTL_DEFAULT_MS } from '../lib/agent-runs.mjs';

const NOW = Date.parse('2026-09-27T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

const minutesAgo = (m) => new Date(NOW - m * MIN).toISOString();
const hoursAgo = (h) => new Date(NOW - h * HOUR).toISOString();

let seq = 0;
/** Событие `run` стадии исполнителя с разумными умолчаниями. */
function runEvent(overrides = {}) {
  seq += 1;
  return {
    type: 'run',
    ts: minutesAgo(0),
    run_key: `run-${seq}`,
    pipeline_run: 'pr-1',
    stage: 'execute',
    skill: 'execute-task',
    ticket: 'IMPL-1',
    ticket_type: 'impl',
    attempt: 1,
    agent: 'agent-a',
    requested: 'agent-a',
    model: 'model-a',
    status: 'ok',
    exit_code: 0,
    changed_files: 3,
    duration_ms: 500,
    ...overrides,
  };
}

function verifyEvent(overrides = {}) {
  return {
    type: 'verify',
    ts: minutesAgo(0),
    pipeline_run: 'pr-1',
    ticket: 'IMPL-1',
    ticket_type: 'impl',
    status: 'all_green',
    fail_reasons: [],
    ...overrides,
  };
}

function unbanEvent(overrides = {}) {
  return { type: 'unban', ts: minutesAgo(0), model: 'model-a', reason: 'человек снял запрет', ...overrides };
}

test('сбой 10 минут назад с TTL 1 час — запрет', () => {
  const events = [runEvent({ status: 'error', changed_files: 0, ts: minutesAgo(10), crash_ttl_ms: HOUR })];
  const bans = crashBans(events, NOW);
  assert.equal(bans.length, 1);
  assert.equal(bans[0].model, 'model-a');
  assert.equal(bans[0].crash_ttl_ms, HOUR);
  assert.equal(bans[0].until, new Date(Date.parse(minutesAgo(10)) + HOUR).toISOString());
  assert.equal(bans[0].evidence.length, 1);
  assert.equal(bans[0].evidence[0].ticket, 'IMPL-1');
  assert.equal(bans[0].evidence[0].grade, 'crashed');
});

test('тот же сбой, но now на 2 часа позже старта TTL — запрета нет', () => {
  const events = [runEvent({ status: 'error', changed_files: 0, ts: minutesAgo(10), crash_ttl_ms: HOUR })];
  const laterNow = NOW + 2 * HOUR;
  assert.deepEqual(crashBans(events, laterNow), []);
});

test('нет crash_ttl_ms в событии — используется TTL по умолчанию (1 час)', () => {
  const events = [runEvent({ status: 'error', changed_files: 0, ts: minutesAgo(10) })];
  const bans = crashBans(events, NOW);
  assert.equal(bans.length, 1);
  assert.equal(bans[0].crash_ttl_ms, CRASH_TTL_DEFAULT_MS);
});

test('сбой, за которым успешный запуск той же модели — запрета нет (тип тикета не учитывается)', () => {
  const events = [
    runEvent({ ticket: 'IMPL-1', ticket_type: 'impl', status: 'error', changed_files: 0, ts: hoursAgo(1) }),
    runEvent({ ticket: 'TEST-1', ticket_type: 'test', status: 'ok', changed_files: 4, ts: minutesAgo(5) }),
    verifyEvent({ ticket: 'TEST-1', ticket_type: 'test', status: 'all_green', ts: minutesAgo(4) }),
  ];
  assert.deepEqual(crashBans(events, NOW), []);
});

test('сбой, за которым model_banned той же модели — запрет остаётся', () => {
  const events = [
    runEvent({ ticket: 'IMPL-1', status: 'error', changed_files: 0, ts: minutesAgo(10) }),
    runEvent({ ticket: 'IMPL-2', status: 'model_banned', changed_files: 2, ts: minutesAgo(5) }),
  ];
  const bans = crashBans(events, NOW);
  assert.equal(bans.length, 1);
  assert.equal(bans[0].evidence[0].ticket, 'IMPL-1');
});

test('сбой, за которым aborted той же модели (остановка пайплайна, stop_requested) — запрет остаётся', () => {
  const events = [
    runEvent({ ticket: 'IMPL-1', status: 'error', changed_files: 0, ts: minutesAgo(10) }),
    runEvent({ ticket: 'IMPL-2', status: 'aborted', stop_requested: true, changed_files: 0, ts: minutesAgo(5) }),
  ];
  const bans = crashBans(events, NOW);
  assert.equal(bans.length, 1);
  assert.equal(bans[0].evidence[0].ticket, 'IMPL-1');
});

test('сбой, за которым aborted той же модели с interrupted: true — запрет остаётся', () => {
  const events = [
    runEvent({ ticket: 'IMPL-1', status: 'error', changed_files: 0, ts: minutesAgo(10) }),
    runEvent({ ticket: 'IMPL-2', status: 'aborted', interrupted: true, changed_files: null, ts: minutesAgo(5) }),
  ];
  const bans = crashBans(events, NOW);
  assert.equal(bans.length, 1);
  assert.equal(bans[0].evidence[0].ticket, 'IMPL-1');
});

test('model_banned и aborted остановки пайплайна сами по себе, без предшествующего сбоя, запрета не дают', () => {
  const cases = [
    { status: 'model_banned', changed_files: 3 },
    { status: 'aborted', stop_requested: true, changed_files: 0 },
    { status: 'aborted', interrupted: true, changed_files: null },
  ];
  for (const overrides of cases) {
    const events = [runEvent({ ticket: 'IMPL-1', ts: minutesAgo(10), ...overrides })];
    assert.deepEqual(crashBans(events, NOW), [], JSON.stringify(overrides));
  }
});

test('aborted без stop_requested и interrupted (агент снят сигналом не остановкой пайплайна) — сбой, даёт запрет', () => {
  const events = [runEvent({ ticket: 'IMPL-1', status: 'aborted', changed_files: 0, ts: minutesAgo(10) })];
  const bans = crashBans(events, NOW);
  assert.equal(bans.length, 1);
  assert.equal(bans[0].model, 'model-a');
});

test('unban модели без ticket_type снимает временный запрет', () => {
  const events = [
    runEvent({ ticket: 'IMPL-1', status: 'error', changed_files: 0, ts: minutesAgo(30) }),
    unbanEvent({ ts: minutesAgo(20) }),
  ];
  assert.deepEqual(crashBans(events, NOW), []);
});

test('unban с ticket_type временный запрет не снимает (снимает только постоянный запрет пары)', () => {
  const events = [
    runEvent({ ticket: 'IMPL-1', status: 'error', changed_files: 0, ts: minutesAgo(30) }),
    unbanEvent({ ts: minutesAgo(20), ticket_type: 'impl' }),
  ];
  const bans = crashBans(events, NOW);
  assert.equal(bans.length, 1);
});

test('unban до сбоя не мешает: новый сбой после unban всё равно даёт запрет', () => {
  const events = [
    unbanEvent({ ts: minutesAgo(30) }),
    runEvent({ ticket: 'IMPL-1', status: 'error', changed_files: 0, ts: minutesAgo(10) }),
  ];
  const bans = crashBans(events, NOW);
  assert.equal(bans.length, 1);
});

test('crashed_after_work (changed_files: null, без вердикта) — тоже временный запрет', () => {
  const events = [runEvent({ ticket: 'IMPL-1', status: 'error', changed_files: null, ts: minutesAgo(10) })];
  const bans = crashBans(events, NOW);
  assert.equal(bans.length, 1);
  assert.equal(bans[0].model, 'model-a');
});

test('запуск с model: null во временный запрет не идёт', () => {
  const events = [runEvent({ ticket: 'IMPL-1', status: 'error', changed_files: 0, model: null, ts: minutesAgo(10) })];
  assert.deepEqual(crashBans(events, NOW), []);
});

test('TTL за пределами Date (правило health с ttl: infinite) — запрет без исключения, конец — наибольшая дата', () => {
  const events = [runEvent({ ticket: 'IMPL-1', status: 'error', changed_files: 0, ts: minutesAgo(10), crash_ttl_ms: Number.MAX_SAFE_INTEGER })];
  const bans = crashBans(events, NOW);
  assert.equal(bans.length, 1);
  assert.equal(bans[0].until, new Date(8.64e15).toISOString());
});
