/**
 * Событие `reset` — обнуление истории модели в журнале запусков (src/lib/agent-runs.mjs,
 * PLAN-004, задачи 24–26, решение 1).
 *
 * Что охраняется:
 *  - «reset: градации» (gradeIndexed через gradeRuns, permanentBans, crashBans,
 *    statsTable): запуски модели, записанные в журнале раньше последнего `reset` этой
 *    модели, в градации не попадают, а значит — ни в постоянные и временные запреты, ни
 *    в таблицу статистики. «Раньше» — по позиции в журнале, а не по `ts`. Окна
 *    `verify`/`review` строятся со всеми запусками: контроль исключённого запуска
 *    не достаётся соседнему запуску того же тикета. `reset` без запусков модели и
 *    `reset` другой модели ни на что не влияют; запуск после `reset` учитывается;
 *    `unban` до `reset` результата не меняет; строка `model: null` остаётся;
 *  - «reset: запись» (recordReset): вызов для модели с событиями `run` дописывает
 *    ровно одну строку `{"type":"reset",…}`; без `model` или `reason` — BAD_INPUT, без
 *    событий `run` модели — NO_RUNS (защита от опечатки), нечитаемый журнал —
 *    READ_FAILED, журнал только для чтения — WRITE_FAILED; при отказе строка не пишется.
 *
 * Изоляция: градации — чистые функции на массивах событий в памяти; запись — временный
 * проект в каталоге ОС на тест, teardown в afterEach.
 *
 * Запуск: node --import ./src/tests/_rails-home.mjs --test src/tests/agent-runs-reset.test.mjs
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as agentRuns from '../lib/agent-runs.mjs';

const {
  gradeRuns, permanentBans, crashBans, statsTable, activeBans,
  appendRunEvent, readRunEvents, runsLogPath, EXECUTOR_SKILL,
} = agentRuns;
// Через объект модуля, а не именованным импортом: без функции записи (задача 26) файл
// всё равно загружается, и describe градаций прогоняется отдельно (задача 25).
const recordReset = (...args) => agentRuns.recordReset(...args);

const NOW = Date.parse('2026-09-28T12:00:00.000Z');
const MIN = 60 * 1000;
const minutesAgo = (m) => new Date(NOW - m * MIN).toISOString();

let ticketSeq = 0;
const nextTicket = () => `IMPL-${++ticketSeq}`;

/** Событие `run` стадии исполнителя; по умолчанию — неудача `empty`. */
function runEvent(model, overrides = {}) {
  const { ticket = nextTicket(), ...rest } = overrides;
  return {
    type: 'run',
    ts: minutesAgo(10),
    skill: EXECUTOR_SKILL,
    ticket,
    ticket_type: 'impl',
    agent: 'agent-a',
    model,
    status: 'ok',
    changed_files: 0,
    ...rest,
  };
}

function verifyEvent(ticket, overrides = {}) {
  return { type: 'verify', ts: minutesAgo(9), ticket, ticket_type: 'impl', status: 'all_green', fail_reasons: [], ...overrides };
}

function resetEvent(model, overrides = {}) {
  return { type: 'reset', ts: minutesAgo(5), model, reason: 'обнуление истории', ...overrides };
}

function unbanEvent(model, overrides = {}) {
  return { type: 'unban', ts: minutesAgo(6), model, ticket_type: 'impl', reason: 'снятие', ...overrides };
}

const failures = (model, n) => Array.from({ length: n }, () => runEvent(model));
const rowOf = (table, model) => table.filter((row) => row.model === model);
const summary = (table) => table.map(({ model, ticket_type, runs, grades }) => ({ model, ticket_type, runs, grades }));

describe('reset: градации', () => {
  test('3 неудачи empty модели → reset: постоянного запрета нет, строки модели в статистике нет', () => {
    const before = failures('model-a', 3);
    assert.equal(permanentBans(before).length, 1, 'до reset запрет по правилу 1 есть');
    assert.equal(rowOf(statsTable(before, NOW), 'model-a')[0].runs, 3, 'до reset в строке 3 запуска');

    const events = [...before, resetEvent('model-a')];
    assert.deepEqual(permanentBans(events), []);
    assert.deepEqual(rowOf(statsTable(events, NOW), 'model-a'), []);
    assert.deepEqual(gradeRuns(events), []);
  });

  test('сбой модели → reset: временного запрета нет', () => {
    const before = [runEvent('model-a', { status: 'error', ts: minutesAgo(1) })];
    assert.equal(crashBans(before, NOW).length, 1, 'до reset временный запрет есть');

    const events = [...before, resetEvent('model-a')];
    assert.deepEqual(crashBans(events, NOW), []);
    assert.deepEqual(activeBans(events, NOW), { permanent: [], crash: [] });
  });

  test('«раньше» — по позиции в журнале, а не по ts', () => {
    // ts запусков позже ts события reset, но в файле они стоят раньше.
    const events = [
      ...failures('model-a', 3).map((run) => ({ ...run, ts: minutesAgo(1) })),
      resetEvent('model-a', { ts: minutesAgo(30) }),
    ];
    assert.deepEqual(permanentBans(events), []);
    assert.deepEqual(rowOf(statsTable(events, NOW), 'model-a'), []);
  });

  test('запуск после reset учитывается, счёт правила 1 начинается заново', () => {
    const events = [...failures('model-a', 3), resetEvent('model-a'), runEvent('model-a')];
    assert.deepEqual(permanentBans(events), [], 'после reset одна неудача — запрета нет');
    const [row] = rowOf(statsTable(events, NOW), 'model-a');
    assert.equal(row.runs, 1);
    assert.equal(row.grades.empty, 1);

    const more = [...events, ...failures('model-a', 2)];
    const bans = permanentBans(more);
    assert.equal(bans.length, 1);
    assert.equal(bans[0].rule, 1);
    assert.equal(bans[0].failures, 3, 'в счёт идут только три неудачи после reset');
    assert.equal(rowOf(statsTable(more, NOW), 'model-a')[0].runs, 3);
  });

  test('действует последний reset модели', () => {
    const events = [
      runEvent('model-a'), resetEvent('model-a'),
      runEvent('model-a'), runEvent('model-a'), resetEvent('model-a'),
      runEvent('model-a', { changed_files: 2 }),
    ];
    const runs = gradeRuns(events);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].grade, 'pending');
    assert.equal(rowOf(statsTable(events, NOW), 'model-a')[0].runs, 1);
  });

  test('reset без запусков модели — без эффекта', () => {
    const base = [...failures('model-a', 3), runEvent('model-b', { status: 'error', ts: minutesAgo(1) })];
    const events = [resetEvent('model-c'), ...base, resetEvent('model-c')];
    assert.deepEqual(summary(statsTable(events, NOW)), summary(statsTable(base, NOW)));
    assert.deepEqual(activeBans(events, NOW), activeBans(base, NOW));
    assert.equal(permanentBans(events).length, 1);
    assert.equal(crashBans(events, NOW).length, 1);
  });

  test('reset двух моделей независимы', () => {
    const base = [...failures('model-a', 3), ...failures('model-b', 3)];
    assert.equal(permanentBans(base).length, 2);

    const resetA = [...base, resetEvent('model-a')];
    const bansA = permanentBans(resetA);
    assert.deepEqual(bansA.map((b) => b.model), ['model-b']);
    assert.equal(bansA[0].failures, 3);
    const tableA = statsTable(resetA, NOW);
    assert.deepEqual(rowOf(tableA, 'model-a'), []);
    assert.equal(rowOf(tableA, 'model-b')[0].runs, 3);
    assert.equal(rowOf(tableA, 'model-b')[0].grades.empty, 3);

    const resetBoth = [...resetA, resetEvent('model-b')];
    assert.deepEqual(permanentBans(resetBoth), []);
    assert.deepEqual(statsTable(resetBoth, NOW), []);
  });

  test('unban до reset на результат не влияет', () => {
    const withUnban = [
      ...failures('model-a', 3), unbanEvent('model-a'),
      ...failures('model-a', 1), resetEvent('model-a'),
      ...failures('model-a', 3),
    ];
    const withoutUnban = withUnban.filter((event) => event.type !== 'unban');
    const bans = permanentBans(withUnban);
    assert.equal(bans.length, 1);
    assert.equal(bans[0].failures, 3);
    assert.deepEqual(bans, permanentBans(withoutUnban));
    assert.deepEqual(summary(statsTable(withUnban, NOW)), summary(statsTable(withoutUnban, NOW)));
    assert.equal(rowOf(statsTable(withUnban, NOW), 'model-a')[0].runs, 3);
  });

  test('контроль исключённого запуска не достаётся предыдущему запуску тикета', () => {
    // Окно запуска модели A держит свой verify: иначе all_green достался бы запуску
    // модели B того же тикета, и тот стал бы принятым.
    const ticket = nextTicket();
    const events = [
      runEvent('model-b', { ticket, changed_files: 1 }),
      runEvent('model-a', { ticket, changed_files: 2 }),
      verifyEvent(ticket),
      resetEvent('model-a'),
    ];
    const runs = gradeRuns(events);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].model, 'model-b');
    assert.equal(runs[0].grade, 'pending');
    assert.equal(runs[0].verify, null);

    const [row] = rowOf(statsTable(events, NOW), 'model-b');
    assert.equal(row.runs, 1);
    assert.equal(row.grades.pending, 1);
    assert.equal(row.grades.accepted, 0);
    assert.equal(row.artifacts_success_rate, null);
  });

  test('verify запуска до reset не прикрепляется к запуску после', () => {
    const ticket = nextTicket();
    const events = [
      runEvent('model-a', { ticket, changed_files: 2 }),
      verifyEvent(ticket, { status: 'failed', fail_reasons: ['тест красный'] }),
      resetEvent('model-a'),
      runEvent('model-a', { ticket, changed_files: 2 }),
    ];
    const runs = gradeRuns(events);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].grade, 'pending');
    assert.equal(runs[0].verify, null);
    assert.equal(runs[0].artifacts_passed, null);

    const [row] = rowOf(statsTable(events, NOW), 'model-a');
    assert.equal(row.runs, 1);
    assert.equal(row.grades.artifacts_failed, 0);
    assert.equal(row.grades.pending, 1);
  });

  test('строка model: null остаётся, остальные строки не меняются', () => {
    const base = [
      runEvent(null, { status: 'error' }),
      runEvent(null),
      ...failures('model-a', 2),
      ...failures('model-b', 1),
    ];
    const events = [...base, resetEvent('model-a')];
    const table = statsTable(events, NOW);
    const [nullRow] = rowOf(table, null);
    assert.equal(nullRow.runs, 2);
    assert.equal(nullRow.grades.crashed, 1);
    assert.equal(nullRow.grades.empty, 1);
    assert.deepEqual(rowOf(table, 'model-a'), []);
    assert.deepEqual(summary(rowOf(table, 'model-b')), summary(rowOf(statsTable(base, NOW), 'model-b')));
  });
});

let root = null;
afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = null;
});

function newProject() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runs-reset-'));
  return root;
}

function seed(project, event) {
  const written = appendRunEvent(project, event);
  assert.equal(written.ok, true, written.error);
}

function fileLines(project) {
  try {
    return fs.readFileSync(runsLogPath(project), 'utf8').split('\n').filter((l) => l.trim());
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

describe('reset: запись', () => {
  test('модель с событиями run — ровно одна строка reset', () => {
    const project = newProject();
    seed(project, runEvent('vendor/model-x:free'));
    seed(project, runEvent('vendor/model-x:free'));
    seed(project, runEvent('vendor/model-x:free'));
    seed(project, runEvent('model-b'));
    const before = fileLines(project);
    assert.equal(permanentBans(readRunEvents(project)).length, 1);

    const result = recordReset(project, { model: 'vendor/model-x:free', reason: '  чистый лист  ' }, NOW);
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.event, {
      type: 'reset', ts: new Date(NOW).toISOString(), model: 'vendor/model-x:free', reason: 'чистый лист',
    });

    const after = fileLines(project);
    assert.equal(after.length, before.length + 1, 'дописана ровно одна строка');
    assert.deepEqual(after.slice(0, before.length), before, 'прежние строки не тронуты');
    assert.deepEqual(JSON.parse(after.at(-1)), result.event);

    const events = readRunEvents(project);
    assert.deepEqual(permanentBans(events), []);
    const table = statsTable(events, NOW);
    assert.deepEqual(rowOf(table, 'vendor/model-x:free'), []);
    assert.equal(rowOf(table, 'model-b')[0].runs, 1);
  });

  test('без model или reason — BAD_INPUT, строка не пишется', () => {
    const project = newProject();
    seed(project, runEvent('model-a'));
    const before = fileLines(project);

    for (const input of [
      { reason: 'x' },
      { model: '', reason: 'x' },
      { model: 42, reason: 'x' },
      { model: 'model-a' },
      { model: 'model-a', reason: '   ' },
      undefined,
    ]) {
      const result = recordReset(project, input, NOW);
      assert.equal(result.ok, false, JSON.stringify(input));
      assert.equal(result.code, 'BAD_INPUT', JSON.stringify(input));
      assert.equal(typeof result.error, 'string');
    }
    assert.deepEqual(fileLines(project), before);
  });

  test('модель без событий run — NO_RUNS, строка не пишется', () => {
    const project = newProject();

    // Журнала нет вовсе — файл не создаётся.
    const noFile = recordReset(project, { model: 'model-a', reason: 'x' }, NOW);
    assert.equal(noFile.ok, false);
    assert.equal(noFile.code, 'NO_RUNS');
    assert.equal(fs.existsSync(runsLogPath(project)), false, 'отказ не создаёт файл журнала');

    // Модель есть только в событии review (модель ревьюера) и в reset — это не запуски.
    seed(project, runEvent('model-b'));
    seed(project, { type: 'review', ts: minutesAgo(1), ticket: 'IMPL-900', status: 'passed', model: 'model-a' });
    seed(project, resetEvent('model-c'));
    const before = fileLines(project);

    for (const model of ['model-a', 'model-c', 'model-B']) {
      const result = recordReset(project, { model, reason: 'x' }, NOW);
      assert.equal(result.ok, false, model);
      assert.equal(result.code, 'NO_RUNS', model);
    }
    assert.deepEqual(fileLines(project), before, 'строка reset не дописана');
  });

  test('журнал не читается — READ_FAILED', () => {
    const project = newProject();
    // На месте файла журнала — каталог: чтение бросает не ENOENT.
    fs.mkdirSync(runsLogPath(project), { recursive: true });
    const result = recordReset(project, { model: 'model-a', reason: 'x' }, NOW);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'READ_FAILED');
  });

  test('журнал читается, но не пишется — WRITE_FAILED, файл не меняется', (t) => {
    const project = newProject();
    seed(project, runEvent('model-a'));
    const file = runsLogPath(project);
    const before = fileLines(project);
    fs.chmodSync(file, 0o444);
    try {
      try {
        fs.accessSync(file, fs.constants.W_OK);
        t.skip('файл только для чтения остаётся доступным на запись (запуск от root)');
        return;
      } catch {
        // запись запрещена — проверяем отказ
      }
      const result = recordReset(project, { model: 'model-a', reason: 'x' }, NOW);
      assert.equal(result.ok, false);
      assert.equal(result.code, 'WRITE_FAILED');
      assert.ok(result.error, 'причина отказа');
      assert.deepEqual(fileLines(project), before, 'строка reset не дописана');
    } finally {
      fs.chmodSync(file, 0o644);
    }
  });
});
