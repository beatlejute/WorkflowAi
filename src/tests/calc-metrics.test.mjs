/**
 * Метрики отчёта create-report (src/skills/create-report/scripts/calc-metrics.js).
 *
 * Отчёты 2026-09-29…30 давали «ожидаемое выполнение» 7,43% и 12,81% от горизонта 14 дней,
 * которого у плана нет, и писали «проблем нет» при 23 строках ❌ «## Ревью» у 12 из 36
 * тикетов плана. Что охраняется:
 *  - calcPlanHealth: горизонт только из end_date или duration_days плана, иначе n/a;
 *  - velocityStart/calcVelocity: начало — самая ранняя запись «Истории работы» (местное
 *    время), затем created_at плана, затем самая ранняя created_at тикета (null не эпоха 0);
 *  - parseHistoryRows/buildTicketRows: попытки по статусам, первая запись — самая ранняя,
 *    возвраты с ревью, записанные дефекты, заметки и Summary с обрезкой;
 *  - buildProblemTickets: только тикеты с возвратами, дефектом или попытками error;
 *  - pageRows, buildOutput, parseFromArg, formatResult и CLI: страница не больше бюджета,
 *    страницы по tickets_next_from покрывают все строки ровно по разу;
 *  - detectAnomalies: review_rework с 25% тикетов плана.
 * isAbsenceRecord и extractRecordedDefects обоих скриптов — в calc-plan-metrics.test.mjs.
 *
 * Функции импортируются без запуска main. Временный проект — в каталоге ОС, удаляется в after.
 *
 * Запуск: node --import ./src/tests/_rails-home.mjs --test src/tests/calc-metrics.test.mjs
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  calcPlanHealth,
  velocityStart,
  calcVelocity,
  parseHistoryRows,
  buildTicketRows,
  buildProblemTickets,
  detectAnomalies,
  pageRows,
  buildOutput,
  parseFromArg,
  formatResult,
} from '../skills/create-report/scripts/calc-metrics.js';

const SCRIPT = fileURLToPath(new URL('../skills/create-report/scripts/calc-metrics.js', import.meta.url));
const DAY_MS = 24 * 60 * 60 * 1000;

const tickets = (done, total) => Array.from({ length: total }, (_, i) => ({ id: `T-${i + 1}`, status: i < done ? 'done' : 'ready' }));

// ---------------------------------------------------------------------------
// calcPlanHealth
// ---------------------------------------------------------------------------

describe('calcPlanHealth', () => {
  const created = new Date('2026-09-20T00:00:00Z');

  test('без end_date и duration_days, без created_at и без плана — n/a, expected_pct и delta null', () => {
    for (const plan of [{ created_at: created.toISOString() }, { end_date: '2026-10-10' }, null]) {
      const health = calcPlanHealth(tickets(1, 2), plan, new Date('2026-09-25T00:00:00Z'));
      assert.equal(health.health_status, 'n/a', JSON.stringify(plan));
      assert.equal(health.expected_pct, null);
      assert.equal(health.delta, null);
      assert.equal(health.horizon_source, 'none');
      assert.equal(health.completion_pct, 50);
    }
  });

  test('end_date через 10 дней, now в середине, половина тикетов done — expected_pct 50, ON_TRACK', () => {
    const plan = { created_at: created.toISOString(), end_date: new Date(created.getTime() + 10 * DAY_MS).toISOString() };
    const health = calcPlanHealth(tickets(2, 4), plan, new Date(created.getTime() + 5 * DAY_MS));
    assert.equal(health.expected_pct, 50);
    assert.equal(health.delta, 0);
    assert.equal(health.horizon_source, 'end_date');
    assert.equal(health.horizon_days, 10);
    assert.equal(health.health_status, 'ON_TRACK');
  });

  test('duration_days 10, 0 из 1 done на 5-й день — OFF_TRACK', () => {
    const plan = { created_at: created.toISOString(), duration_days: 10 };
    const health = calcPlanHealth(tickets(0, 1), plan, new Date(created.getTime() + 5 * DAY_MS));
    assert.equal(health.expected_pct, 50);
    assert.equal(health.delta, -50);
    assert.equal(health.horizon_source, 'duration_days');
    assert.equal(health.health_status, 'OFF_TRACK');
  });
});

// ---------------------------------------------------------------------------
// velocityStart и calcVelocity
// ---------------------------------------------------------------------------

describe('velocityStart и calcVelocity', () => {
  test('первая запись истории «2026-09-30 12:00:00» (местное время), now через 2 дня — days_elapsed 2, first_run', () => {
    const now = new Date('2026-10-02T12:00:00').getTime();
    const v = calcVelocity(tickets(4, 4), { created_at: '2026-09-01T00:00:00Z' }, [{ first_run_at: '2026-09-30 12:00:00' }, { first_run_at: null }], now);
    assert.equal(v.days_elapsed, 2);
    assert.equal(v.start_source, 'first_run');
    assert.equal(v.velocity_day, 2);
    assert.equal(v.started_at, new Date('2026-09-30T12:00:00').toISOString());
  });

  test('без истории — created_at плана; без плана — самая ранняя created_at тикета, null пропускается', () => {
    assert.equal(velocityStart([], [], { created_at: '2026-09-28T00:00:00Z' }).source, 'plan_created_at');
    const fromTickets = velocityStart(
      [{ created_at: null }, { created_at: '2026-09-29T00:00:00Z' }, { created_at: new Date('2026-09-29T06:00:00Z') }],
      [],
      null
    );
    assert.deepEqual(fromTickets, { start: Date.parse('2026-09-29T00:00:00Z'), source: 'ticket_created_at' });
  });

  test('ничего нет — none, velocity_day 0', () => {
    const v = calcVelocity([{ status: 'done', created_at: null }], null, [], Date.now());
    assert.equal(v.start_source, 'none');
    assert.equal(v.velocity_day, 0);
    assert.equal(v.days_elapsed, 0);
    assert.equal(v.started_at, null);
  });
});

// ---------------------------------------------------------------------------
// parseHistoryRows и buildTicketRows
// ---------------------------------------------------------------------------

const HISTORY = [
  '## История работы',
  '',
  '| Дата/время | Скил | Агент | Статус |',
  '|------------|------|-------|--------|',
  '| 2026-09-30 14:00:00 | execute-task | model-a | error |',
  '| 2026-09-30 09:00:00 | execute-task | model-b | ok |',
  '',
].join('\n');

const REVIEW = (summary) => [
  '## Ревью',
  '',
  '| Дата | Статус | Самари | Агент |',
  '|---|---|---|---|',
  `| d1 | ❌ failed | ${summary} | opus |`,
  '| d2 | ❌ failed | второй возврат | opus |',
  '| d3 | ✅ passed | ок | opus |',
  '',
].join('\n');

describe('parseHistoryRows и buildTicketRows', () => {
  test('parseHistoryRows: время и статус по заголовку колонок', () => {
    assert.deepEqual(parseHistoryRows(HISTORY), [
      { at: '2026-09-30 14:00:00', status: 'error' },
      { at: '2026-09-30 09:00:00', status: 'ok' },
    ]);
    assert.deepEqual(parseHistoryRows('## Описание\n'), []);
  });

  test('строка тикета: попытки, самая ранняя запись, возвраты, дефекты, заметки из комментария — null, Summary с обрезкой', () => {
    const body = [
      '## Результат выполнения',
      '',
      '### Summary',
      '',
      'S'.repeat(160),
      '',
      '### Найденные дефекты',
      '',
      'кнопка не работает',
      '',
      '### Заметки для следующих задач',
      '',
      '<!-- что важно знать следующему исполнителю -->',
      '',
      REVIEW('Р'.repeat(130)),
      HISTORY,
    ].join('\n');

    const [row] = buildTicketRows([{ id: 'QA-1', title: 'Проверка', type: 'qa', status: 'done', completed_at: '2026-09-30', body }]);

    assert.equal(row.attempts, 2);
    assert.deepEqual(row.attempt_statuses, { error: 1, ok: 1 });
    assert.equal(row.first_run_at, '2026-09-30 09:00:00', 'самая ранняя, а не первая по порядку');
    assert.equal(row.review_failed, 2);
    assert.deepEqual(row.review_failed_summaries, [`${'Р'.repeat(120)} …`, 'второй возврат']);
    assert.equal(row.defects, 'кнопка не работает');
    assert.equal(row.defects_section, true);
    assert.equal(row.notes, null);
    assert.equal(row.summary, `${'S'.repeat(150)} …`);
  });

  test('Summary из «### Что сделано», заметки обрезаются до 200 символов', () => {
    const body = '## Результат выполнения\n\n### Что сделано\n\nсделано\n\n### Заметки\n\n' + 'з'.repeat(210) + '\n';
    const [row] = buildTicketRows([{ id: 'IMPL-1', status: 'done', body }]);
    assert.equal(row.summary, 'сделано');
    assert.equal(row.notes, `${'з'.repeat(200)} …`);
    assert.equal(row.attempts, 0);
    assert.equal(row.first_run_at, null);
    assert.equal(row.defects_section, false);
  });
});

// ---------------------------------------------------------------------------
// buildProblemTickets
// ---------------------------------------------------------------------------

test('buildProblemTickets: только возвраты с ревью, записанный дефект или попытки error; запись без текста', () => {
  const row = (id, extra) => ({ id, status: 'done', review_failed: 0, defects: null, attempt_statuses: { ok: 1 }, notes: null, ...extra });
  const problems = buildProblemTickets([
    row('A', { review_failed: 2 }),
    row('B', { defects: 'кнопка не работает', notes: 'заметка' }),
    row('C', { attempt_statuses: { error: 2, ok: 1 } }),
    row('D', { notes: 'только заметка' }),
    row('E', {}),
  ]);
  assert.deepEqual(problems, [
    { id: 'A', status: 'done', review_failed: 2, defects: false, error_attempts: 0, notes: false },
    { id: 'B', status: 'done', review_failed: 0, defects: true, error_attempts: 0, notes: true },
    { id: 'C', status: 'done', review_failed: 0, defects: false, error_attempts: 2, notes: false },
  ]);
});

// ---------------------------------------------------------------------------
// Постраничный вывод
// ---------------------------------------------------------------------------

describe('pageRows, buildOutput, parseFromArg, formatResult', () => {
  const head = { plan_id: 'PLAN-001', total_tickets: 50 };
  const rows = Array.from({ length: 50 }, (_, i) => ({ id: `IMPL-${String(i + 1).padStart(3, '0')}`, summary: 'x'.repeat(880) }));

  test('50 строк по ~900 символов при бюджете 10000: каждая страница ≤ 10000, все ID ровно по разу', () => {
    assert.ok(JSON.stringify(rows[0]).length > 890, 'строка ~900 символов');
    const seen = [];
    let from = 0;
    let pages = 0;
    while (from !== null) {
      const page = buildOutput(head, rows, from, 10000);
      assert.equal(page.tickets_from, from);
      assert.ok(formatResult(page).length <= 10000, `страница с ${from}: ${formatResult(page).length} символов`);
      assert.ok(page.tickets.length > 0);
      seen.push(...page.tickets.map((t) => t.id));
      from = page.tickets_next_from;
      pages += 1;
      assert.ok(pages <= 50, 'листание не сходится');
    }
    assert.ok(pages > 1, 'фикстура не умещается в одну страницу');
    assert.deepEqual(seen, rows.map((r) => r.id));
  });

  test('одна строка больше бюджета — страница из одной строки, tickets_next_from null', () => {
    const big = [{ id: 'BIG', text: 'x'.repeat(20000) }];
    const page = buildOutput(head, big, 0, 10000);
    assert.deepEqual(page.tickets.map((t) => t.id), ['BIG']);
    assert.equal(page.tickets_next_from, null);
    assert.deepEqual(pageRows(big, 0, 100), { page: big, next: null });
  });

  test('parseFromArg: без флага 0, целое ≥ 0 — число, иначе null', () => {
    assert.equal(parseFromArg([]), 0);
    assert.equal(parseFromArg(['--from', '12']), 12);
    assert.equal(parseFromArg(['--from', '0']), 0);
    for (const bad of [['--from'], ['--from', '-1'], ['--from', '2.5'], ['--from', 'x']]) {
      assert.equal(parseFromArg(bad), null, JSON.stringify(bad));
    }
  });

  test('formatResult: валидный JSON, равный объекту; problem_tickets и tickets — по строке на элемент', () => {
    const result = { ...head, problem_tickets: [{ id: 'A', review_failed: 1 }], tickets_from: 0, tickets_next_from: null, tickets: rows.slice(0, 2) };
    const out = formatResult(result);
    assert.deepEqual(JSON.parse(out), result);
    for (const r of [...result.problem_tickets, ...result.tickets]) assert.ok(out.includes(`\n    ${JSON.stringify(r)}`));
    assert.match(formatResult({ tickets: [] }), /"tickets": \[\]/);
  });
});

// ---------------------------------------------------------------------------
// detectAnomalies
// ---------------------------------------------------------------------------

test('detectAnomalies: review_rework с 25% тикетов плана, 20% — нет', () => {
  const velocity = { velocity_day: 1, done_count: 1 };
  const rowsWith = (n) => Array.from({ length: n }, (_, i) => ({ id: `T-${i + 1}`, review_failed: i === 0 ? 1 : 0 }));

  const four = detectAnomalies(tickets(4, 4), velocity, rowsWith(4)).filter((a) => a.type === 'review_rework');
  assert.equal(four.length, 1);
  assert.equal(four[0].severity, 'MEDIUM');
  assert.equal(four[0].rework_rate, 25);
  assert.deepEqual(four[0].ticket_ids, ['T-1']);

  const five = detectAnomalies(tickets(5, 5), velocity, rowsWith(5)).filter((a) => a.type === 'review_rework');
  assert.deepEqual(five, []);
});

// ---------------------------------------------------------------------------
// Запуск во временном проекте
// ---------------------------------------------------------------------------

describe('calc-metrics.js во временном проекте', () => {
  let root;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'calc-metrics-'));
    fs.mkdirSync(path.join(root, '.workflow', 'tickets', 'done'), { recursive: true });
    fs.mkdirSync(path.join(root, '.workflow', 'plans', 'current'), { recursive: true });
    fs.writeFileSync(path.join(root, '.workflow', 'plans', 'current', 'PLAN-001.md'),
      '---\nid: "PLAN-001"\ntitle: "План"\nstatus: active\ncreated_at: "2026-09-20T00:00:00Z"\n---\n', 'utf8');
    for (let i = 1; i <= 3; i += 1) {
      fs.writeFileSync(path.join(root, '.workflow', 'tickets', 'done', `IMPL-00${i}.md`), [
        '---', `id: IMPL-00${i}`, 'type: impl', 'parent_plan: "plans/current/PLAN-001.md"', '---', '',
        i === 1 ? REVIEW('нет теста') : '', HISTORY,
      ].join('\n'), 'utf8');
    }
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  function run(...args) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: 'utf8' });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, result: r.status === 0 ? JSON.parse(r.stdout.split('---RESULT---')[1]) : null };
  }

  test('без --from — метрики, problem_tickets до tickets; с --from N — только страница строк', () => {
    const first = run('PLAN-001');
    assert.equal(first.code, 0, first.stderr);
    const keys = Object.keys(first.result);
    for (const key of ['velocity', 'plan_health', 'anomalies', 'problem_tickets']) {
      assert.ok(keys.includes(key), `нет поля ${key}`);
      assert.ok(keys.indexOf(key) < keys.indexOf('tickets'), `${key} после tickets`);
    }
    assert.equal(first.result.total_tickets, 3);
    assert.equal(first.result.plan_health.health_status, 'n/a');
    assert.deepEqual(first.result.problem_tickets.map((p) => p.id).sort(), ['IMPL-001', 'IMPL-002', 'IMPL-003']);
    assert.equal(first.result.tickets.length, 3);

    const next = run('PLAN-001', '--from', '1');
    assert.equal(next.code, 0, next.stderr);
    assert.deepEqual(Object.keys(next.result), ['plan_id', 'total_tickets', 'tickets_from', 'tickets_next_from', 'tickets']);
    assert.equal(next.result.tickets_from, 1);
    assert.equal(next.result.tickets.length, 2);
  });

  test('--from x — код выхода 1', () => {
    const bad = run('PLAN-001', '--from', 'x');
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /--from ожидает целое число/);
  });
});
