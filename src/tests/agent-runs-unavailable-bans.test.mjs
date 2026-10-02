/**
 * Временный запрет «модель недоступна» по серии неудачных запусков подряд
 * (unavailableBans, src/lib/agent-runs.mjs; 2026-10-01, разбор прогонов PulseProxy
 * PLAN-020 и ListeningGlass PLAN-001 29–30.09: модели без единого успеха снова и снова
 * шли в пул — временный запрет за сбой смотрит только на последний запуск, и сбои между
 * собой не складывались). Серия — только сбои процесса `error` и `timeout` (PLAN-004
 * «rate_limit запрета модели не даёт»): модель, которая упирается в ограничение
 * провайдера, правило из выбора не выводит — это делают health-реестр и шлагбаум
 * места-пула `models.gate`.
 *
 * Что охраняется:
 *  - серия из UNAVAILABLE_MIN_FAILURES сбоев `error` и `timeout` подряд — запрет на
 *    модель целиком (тип тикета не учитывается), на одну меньше — запрета нет;
 *  - ограничения провайдера (`rate_limit`) и сбои `network_error`, `auth_error`, `aborted`
 *    без остановки запрета не дают, как бы их ни было много, и серию не прерывают;
 *    пройденный контроль после них — успех, серию обнуляет;
 *  - TTL: час на первой серии, каждый следующий неудачный запуск без успеха — вдвое
 *    больше, не больше суток; отсчёт от последнего запуска серии; истёкший не действует;
 *  - доказательства — последние UNAVAILABLE_EVIDENCE_MAX запусков серии, длина серии — в
 *    `failures`;
 *  - успех (пройденный контроль, в том числе после сбоя с правками) серию обнуляет, и
 *    новая серия начинается с часа; ответ модели без сбоя (`empty`) тоже обнуляет;
 *  - `stopped` (model_banned, остановка пайплайна) серию не прерывает; model: null в
 *    серию не идёт;
 *  - `reset` модели и `unban` без типа тикета снимают запрет и обнуляют серию; `unban`
 *    с типом — нет;
 *  - запрет лежит в `crash` activeBans с `rule: 'unavailable'` — его видят statsTable
 *    (get_model_stats) и снятие recordUnban; findBan из двух временных запретов
 *    отдаёт более поздний; describeBan называет серию;
 *  - выбор агента на стадии исполнителя (resolveAgent) пропускает агента с моделью под
 *    таким запретом.
 *
 * Имена моделей и агентов — нейтральные. Файловые тесты — во временном проекте в
 * os.tmpdir(), снимается в afterEach.
 *
 * Запуск: node --import ./src/tests/_rails-home.mjs --test src/tests/agent-runs-unavailable-bans.test.mjs
 */

import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  unavailableBans, unavailableTtlMs, activeBans, findBan, describeBan, statsTable, recordUnban,
  readRunEvents, EXECUTOR_SKILL, UNAVAILABLE_MIN_FAILURES, UNAVAILABLE_TTL_BASE_MS, UNAVAILABLE_TTL_MAX_MS,
  UNAVAILABLE_EVIDENCE_MAX,
} from '../lib/agent-runs.mjs';
import { StageExecutor } from '../runner.mjs';

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const minutesAgo = (m, now = NOW) => new Date(now - m * MIN).toISOString();

let seq = 0;
/** Событие `run` исполнителя; по умолчанию — сбой без правок 10 минут назад. */
function runEvent(overrides = {}) {
  seq += 1;
  return {
    type: 'run', ts: minutesAgo(10), run_key: `rk-${seq}`, pipeline_run: 'pr-1', stage: 'execute-task',
    skill: EXECUTOR_SKILL, ticket: `IMPL-${seq}`, ticket_type: 'impl', attempt: 1, agent: 'agent-a',
    model: 'model-a', status: 'error', exit_code: 1, changed_files: 0, duration_ms: 1000, ...overrides,
  };
}

// Серия: сбои `error` и `timeout` вперемешку, по минуте друг от друга, последний —
// `lastAgo` минут назад. `status` — один статус на все запуски.
function failures(count, { lastAgo = 10, model = 'model-a', ticketType = 'impl', status = null } = {}) {
  return Array.from({ length: count }, (_, i) => runEvent({
    model,
    ticket_type: ticketType,
    ts: minutesAgo(lastAgo + (count - 1 - i)),
    status: status ?? (i % 2 === 0 ? 'error' : 'timeout'),
  }));
}

// Запуски, которые серию не продолжают и не прерывают, — по одному каждого вида.
const NEUTRAL = [
  { status: 'rate_limit' },
  { status: 'network_error' },
  { status: 'auth_error' },
  { status: 'aborted', exit_code: 143 },
  { status: 'model_banned' },
  { status: 'aborted', stop_requested: true },
];

// Успех: правки и контроль all_green.
function success({ model = 'model-a', ago = 30 } = {}) {
  const run = runEvent({ model, status: 'ok', exit_code: 0, changed_files: 2, ts: minutesAgo(ago) });
  return [run, { type: 'verify', ts: minutesAgo(ago - 0.5), ticket: run.ticket, ticket_type: 'impl', status: 'all_green', fail_reasons: [] }];
}

const unban = (overrides = {}) => ({ type: 'unban', ts: minutesAgo(5), model: 'model-a', reason: 'проверено', ...overrides });
const reset = (overrides = {}) => ({ type: 'reset', ts: minutesAgo(5), model: 'model-a', reason: 'обнулено', ...overrides });

describe('unavailableBans: порог серии', () => {
  test(`${UNAVAILABLE_MIN_FAILURES - 1} неудачи подряд — запрета нет`, () => {
    assert.deepEqual(unavailableBans(failures(UNAVAILABLE_MIN_FAILURES - 1), NOW), []);
  });

  test(`${UNAVAILABLE_MIN_FAILURES} сбоя error и timeout подряд — запрет на час от последнего`, () => {
    const events = failures(UNAVAILABLE_MIN_FAILURES, { lastAgo: 10 });
    const bans = unavailableBans(events, NOW);
    assert.equal(bans.length, 1);
    const [ban] = bans;
    assert.equal(ban.model, 'model-a');
    assert.equal(ban.rule, 'unavailable');
    assert.equal(ban.series, 1);
    assert.equal(ban.failures, UNAVAILABLE_MIN_FAILURES);
    assert.equal(ban.crash_ttl_ms, UNAVAILABLE_TTL_BASE_MS);
    assert.equal(ban.until, new Date(Date.parse(minutesAgo(10)) + UNAVAILABLE_TTL_BASE_MS).toISOString());
    assert.deepEqual(ban.evidence.map((e) => e.grade), events.map(() => 'crashed'));
  });

  test('одни error, одни timeout — тоже серия', () => {
    assert.equal(unavailableBans(failures(UNAVAILABLE_MIN_FAILURES, { status: 'error' }), NOW).length, 1);
    assert.equal(unavailableBans(failures(UNAVAILABLE_MIN_FAILURES, { status: 'timeout' }), NOW).length, 1);
  });

  for (const status of ['rate_limit', 'network_error', 'auth_error']) {
    test(`одни ${status} — запрета нет, сколько бы их ни было`, () => {
      assert.deepEqual(unavailableBans(failures(12, { status }), NOW), []);
    });
  }

  test('aborted без остановки (снят сигналом) — запрета нет', () => {
    const events = Array.from({ length: 5 }, () => runEvent({ status: 'aborted', exit_code: 143 }));
    assert.deepEqual(unavailableBans(events, NOW), []);
  });

  test('модель целиком: серия из разных типов тикетов', () => {
    const events = [
      runEvent({ ticket_type: 'impl', status: 'timeout' }),
      runEvent({ ticket_type: 'docs', status: 'error' }),
      runEvent({ ticket_type: 'test', status: 'error' }),
    ];
    const bans = unavailableBans(events, NOW);
    assert.equal(bans.length, 1);
    assert.equal(bans[0].ticket_type, undefined);
  });

  test('model: null в серию не идёт', () => {
    const events = [...failures(UNAVAILABLE_MIN_FAILURES - 1), runEvent({ model: null })];
    assert.deepEqual(unavailableBans(events, NOW), []);
    assert.deepEqual(unavailableBans(failures(5, { model: null }), NOW), []);
  });
});

describe('unavailableBans: TTL растёт вдвое на каждой следующей серии', () => {
  test('unavailableTtlMs: час, два, четыре… не больше суток', () => {
    assert.equal(unavailableTtlMs(1), UNAVAILABLE_TTL_BASE_MS);
    assert.equal(unavailableTtlMs(2), 2 * UNAVAILABLE_TTL_BASE_MS);
    assert.equal(unavailableTtlMs(3), 4 * UNAVAILABLE_TTL_BASE_MS);
    assert.equal(UNAVAILABLE_TTL_BASE_MS, HOUR);
    assert.equal(UNAVAILABLE_TTL_MAX_MS, 24 * HOUR);
    assert.equal(unavailableTtlMs(6), 24 * HOUR, '32 ч срезаются до суток');
    assert.equal(unavailableTtlMs(5000), 24 * HOUR);
  });

  test('ещё одна неудача после конца первого запрета — запрет на два часа от неё', () => {
    // Первая серия закончилась 3 часа назад (часовой запрет истёк), модель снова упала.
    const first = failures(UNAVAILABLE_MIN_FAILURES, { lastAgo: 180 });
    assert.deepEqual(unavailableBans(first, NOW), [], 'часовой запрет первой серии истёк');
    const events = [...first, runEvent({ ts: minutesAgo(10), status: 'timeout' })];
    const [ban] = unavailableBans(events, NOW);
    assert.equal(ban.series, 2);
    assert.equal(ban.failures, UNAVAILABLE_MIN_FAILURES + 1);
    assert.equal(ban.crash_ttl_ms, 2 * HOUR);
    assert.equal(ban.until, new Date(Date.parse(minutesAgo(10)) + 2 * HOUR).toISOString());
  });

  test('длинная серия — сутки, не больше', () => {
    const [ban] = unavailableBans(failures(12, { lastAgo: 60 }), NOW);
    assert.equal(ban.series, 12 - UNAVAILABLE_MIN_FAILURES + 1);
    assert.equal(ban.crash_ttl_ms, 24 * HOUR);
    assert.equal(ban.until, new Date(Date.parse(minutesAgo(60)) + 24 * HOUR).toISOString());
  });

  test('истёкший запрет не действует', () => {
    assert.deepEqual(unavailableBans(failures(UNAVAILABLE_MIN_FAILURES, { lastAgo: 61 }), NOW), []);
  });
});

describe('unavailableBans: доказательства — последние запуски серии', () => {
  // Ревью 2026-10-01: вся серия в evidence раздувала get_model_stats — запрет
  // повторяется в каждой строке модели.
  test(`серия длиннее ${UNAVAILABLE_EVIDENCE_MAX} — в evidence последние ${UNAVAILABLE_EVIDENCE_MAX}, в failures — вся`, () => {
    const count = UNAVAILABLE_EVIDENCE_MAX * 2 + 5;
    const events = failures(count, { lastAgo: 10 });
    const [ban] = unavailableBans(events, NOW);
    assert.equal(ban.failures, count);
    assert.equal(ban.series, count - UNAVAILABLE_MIN_FAILURES + 1);
    assert.deepEqual(ban.evidence.map((e) => e.run_key), events.slice(-UNAVAILABLE_EVIDENCE_MAX).map((e) => e.run_key));
    assert.equal(
      describeBan({ kind: 'crash', ...ban }),
      `temporary ban until ${ban.until} (unavailable: ${count} failed runs in a row, series ${ban.series}, last at ${minutesAgo(10)})`,
    );
    const rows = statsTable(events, NOW);
    assert.deepEqual(rows.map((r) => r.bans.map((b) => [b.rule ?? null, b.evidence.length])), [[[null, 1], ['unavailable', UNAVAILABLE_EVIDENCE_MAX]]]);
  });

  test(`серия не длиннее ${UNAVAILABLE_EVIDENCE_MAX} — в evidence вся`, () => {
    const events = failures(UNAVAILABLE_EVIDENCE_MAX, { lastAgo: 10 });
    const [ban] = unavailableBans(events, NOW);
    assert.deepEqual(ban.evidence.map((e) => e.run_key), events.map((e) => e.run_key));
  });
});

describe('unavailableBans: что обнуляет и что не прерывает серию', () => {
  test('успех после серии — запрета нет; новая серия после успеха — снова час', () => {
    const events = [...failures(6, { lastAgo: 300 }), ...success({ ago: 200 })];
    assert.deepEqual(unavailableBans(events, NOW), []);
    const [ban] = unavailableBans([...events, ...failures(UNAVAILABLE_MIN_FAILURES)], NOW);
    assert.equal(ban.series, 1);
    assert.equal(ban.crash_ttl_ms, HOUR);
    assert.equal(ban.failures, UNAVAILABLE_MIN_FAILURES);
  });

  test('ответ модели без сбоя (empty) серию обнуляет', () => {
    const events = [
      ...failures(UNAVAILABLE_MIN_FAILURES - 1, { lastAgo: 20 }),
      runEvent({ status: 'ok', exit_code: 0, changed_files: 0, ts: minutesAgo(15) }),
      runEvent({ status: 'timeout', ts: minutesAgo(10) }),
    ];
    assert.deepEqual(unavailableBans(events, NOW), []);
  });

  test('сбой с правками: пройденный контроль — успех, без контроля — неудача серии', () => {
    const passed = runEvent({ status: 'timeout', changed_files: 3, ts: minutesAgo(12) });
    const withPass = [
      ...failures(UNAVAILABLE_MIN_FAILURES - 1, { lastAgo: 20 }),
      passed,
      { type: 'verify', ts: minutesAgo(11), ticket: passed.ticket, ticket_type: 'impl', status: 'all_green', fail_reasons: [] },
      runEvent({ status: 'error', ts: minutesAgo(10) }),
    ];
    assert.deepEqual(unavailableBans(withPass, NOW), []);

    const withoutVerify = [
      ...failures(UNAVAILABLE_MIN_FAILURES - 1, { lastAgo: 20 }),
      runEvent({ status: 'timeout', changed_files: 3, ts: minutesAgo(10) }),
    ];
    assert.equal(unavailableBans(withoutVerify, NOW).length, 1);
  });

  test('stopped (model_banned, остановка пайплайна) серию не прерывает', () => {
    const events = [
      runEvent({ status: 'error', ts: minutesAgo(14) }),
      runEvent({ status: 'model_banned', changed_files: 2, ts: minutesAgo(13) }),
      runEvent({ status: 'timeout', ts: minutesAgo(12) }),
      runEvent({ status: 'aborted', stop_requested: true, ts: minutesAgo(11) }),
      runEvent({ status: 'aborted', interrupted: true, changed_files: null, ts: minutesAgo(11) }),
      runEvent({ status: 'error', ts: minutesAgo(10) }),
    ];
    const [ban] = unavailableBans(events, NOW);
    assert.equal(ban.failures, 3);
  });

  test('rate_limit, network_error, auth_error, aborted сигналом — серию не прерывают и в неё не идут', () => {
    // Между каждой парой сбоев error/timeout — все виды «нейтральных» запусков, с правками
    // и без: серия остаётся из UNAVAILABLE_MIN_FAILURES сбоев, доказательства — только они.
    const crashes = failures(UNAVAILABLE_MIN_FAILURES, { lastAgo: 10 });
    const events = [];
    crashes.forEach((crash, i) => {
      if (i > 0) {
        for (const [j, neutral] of NEUTRAL.entries()) {
          events.push(runEvent({ ...neutral, changed_files: j % 2, ts: minutesAgo(10 + UNAVAILABLE_MIN_FAILURES - i) }));
        }
      }
      events.push(crash);
    });
    const [ban] = unavailableBans(events, NOW);
    assert.ok(ban, 'нейтральные запуски серию не прервали');
    assert.equal(ban.failures, UNAVAILABLE_MIN_FAILURES);
    assert.equal(ban.series, 1);
    assert.deepEqual(ban.evidence.map((e) => e.run_key), crashes.map((e) => e.run_key));
    assert.equal(ban.until, new Date(Date.parse(minutesAgo(10)) + HOUR).toISOString());
  });

  test('нейтральный запуск после серии срок не продлевает', () => {
    const series = failures(UNAVAILABLE_MIN_FAILURES, { lastAgo: 50 });
    const events = [...series, ...NEUTRAL.map((neutral) => runEvent({ ...neutral, ts: minutesAgo(5) }))];
    const [ban] = unavailableBans(events, NOW);
    assert.equal(ban.series, 1);
    assert.equal(ban.until, new Date(Date.parse(minutesAgo(50)) + HOUR).toISOString());
    assert.deepEqual(unavailableBans(events, NOW + 11 * MIN), [], 'истёк через час от последнего сбоя серии');
  });

  test('network_error с правками и пройденным контролем — успех, серию обнуляет', () => {
    const passed = runEvent({ status: 'network_error', changed_files: 3, ts: minutesAgo(12) });
    const events = [
      ...failures(UNAVAILABLE_MIN_FAILURES - 1, { lastAgo: 20 }),
      passed,
      { type: 'verify', ts: minutesAgo(11), ticket: passed.ticket, ticket_type: 'impl', status: 'all_green', fail_reasons: [] },
      runEvent({ status: 'error', ts: minutesAgo(10) }),
    ];
    assert.deepEqual(unavailableBans(events, NOW), []);
  });

  test('серия одной модели не трогает другую', () => {
    const events = [...failures(UNAVAILABLE_MIN_FAILURES), ...success({ model: 'model-b', ago: 5 })];
    assert.deepEqual(unavailableBans(events, NOW).map((b) => b.model), ['model-a']);
  });

  test('reset модели снимает запрет; серия после reset — снова с часа', () => {
    const events = [...failures(6, { lastAgo: 20 }), reset({ ts: minutesAgo(15) })];
    assert.deepEqual(unavailableBans(events, NOW), []);
    const [ban] = unavailableBans([...events, ...failures(UNAVAILABLE_MIN_FAILURES)], NOW);
    assert.equal(ban.series, 1);
    assert.equal(ban.crash_ttl_ms, HOUR);
  });

  test('unban без типа снимает и обнуляет серию; unban с типом — нет', () => {
    const series = failures(5, { lastAgo: 20 });
    assert.deepEqual(unavailableBans([...series, unban()], NOW), []);
    assert.deepEqual(unavailableBans([...series, unban(), ...failures(UNAVAILABLE_MIN_FAILURES - 1)], NOW), []);
    const [again] = unavailableBans([...series, unban(), ...failures(UNAVAILABLE_MIN_FAILURES)], NOW);
    assert.equal(again.series, 1);
    assert.equal(unavailableBans([...series, unban({ ticket_type: 'impl' })], NOW).length, 1);
  });
});

describe('запрет «недоступна» в общих запретах', () => {
  test('activeBans: в crash с rule unavailable; findBan — более поздний из двух временных; describeBan', () => {
    // Последний запуск — сбой с TTL 15 мин (временный запрет за сбой) и серия из 5 (4 ч).
    const events = [...failures(4, { lastAgo: 11 }), runEvent({ status: 'error', ts: minutesAgo(10), crash_ttl_ms: 15 * MIN })];
    const bans = activeBans(events, NOW);
    assert.deepEqual(bans.crash.map((b) => [b.model, b.rule ?? null]), [['model-a', null], ['model-a', 'unavailable']]);
    const ban = findBan(bans, 'model-a', 'docs');
    assert.equal(ban.kind, 'crash');
    assert.equal(ban.rule, 'unavailable');
    assert.equal(ban.until, new Date(Date.parse(minutesAgo(10)) + 4 * HOUR).toISOString());
    assert.equal(
      describeBan(ban),
      `temporary ban until ${ban.until} (unavailable: 5 failed runs in a row, series 3, last at ${minutesAgo(10)})`,
    );
  });

  test('statsTable: запрет виден в строках модели всех типов тикетов', () => {
    const events = [...success({ ago: 100 }), runEvent({ ticket_type: 'docs', status: 'timeout', ts: minutesAgo(12) }), ...failures(2)];
    const rows = statsTable(events, NOW);
    assert.deepEqual(rows.map((r) => [r.ticket_type, r.bans.map((b) => [b.kind, b.rule ?? null])]), [
      ['impl', [['crash', null], ['crash', 'unavailable']]],
      ['docs', [['crash', null], ['crash', 'unavailable']]],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Файловые: снятие и выбор агента
// ---------------------------------------------------------------------------

const TEMPS = [];
afterEach(() => {
  for (const dir of TEMPS.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function projectWith(events) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runs-unavailable-'));
  TEMPS.push(root);
  const file = path.join(root, '.workflow', 'metrics', 'agent-runs.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return root;
}

describe('recordUnban: запрет «недоступна»', () => {
  test('у модели только запрет серии (запрет за сбой истёк) — unban без типа снимает его', () => {
    const now = Date.now();
    // TTL сбоя — минута: временного запрета за последний сбой уже нет, есть только серия.
    const events = Array.from({ length: UNAVAILABLE_MIN_FAILURES }, (_, i) => runEvent({ status: 'error', crash_ttl_ms: MIN, ts: minutesAgo(10 - i, now) }));
    const root = projectWith(events);
    assert.deepEqual(activeBans(readRunEvents(root), now).crash.map((b) => b.rule ?? null), ['unavailable']);
    const result = recordUnban(root, { model: 'model-a', reason: 'квота восстановлена' }, now);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(activeBans(readRunEvents(root), now).crash, []);
  });
});

describe('resolveAgent: запрет «недоступна» на стадии исполнителя', () => {
  const AGENTS = {
    'agent-n': { command: 'node', args: ['agent.mjs', '--model', 'prov/model-b'], capabilities: ['text'] },
    'agent-m': { command: 'node', args: ['agent.mjs', '--model', 'prov/model-c'], capabilities: ['text'] },
  };

  function resolve(root) {
    const lines = [];
    const push = (level) => (message) => lines.push(`${level} ${message}`);
    const logger = { info: push('INFO'), warn: push('WARN'), error: push('ERROR'), debug: push('DEBUG'), stageStart() {}, stageComplete() {}, timeout() {}, cliCall() {} };
    const config = {
      pipeline: {
        name: 'agent-runs-unavailable', version: '1.0', agents: AGENTS,
        execution: { artifact_snapshot_enabled: true, timeout_per_stage: 60 }, stages: {}, entry: 'none', context: {},
      },
    };
    const executor = new StageExecutor(config, { ticket_id: 'IMPL-9' }, {}, {}, null, logger, root);
    const resolved = executor.resolveAgent({ agents: ['agent-n', 'agent-m'], instructions: 'Выполни тикет', skill: EXECUTOR_SKILL }, 'execute-task');
    return { resolved, lines };
  }

  test('серия сбоев error — агент пропущен с причиной; на одну меньше — выбран', () => {
    const now = Date.now();
    // TTL сбоя — минута: пропуск агента — только по запрету серии.
    const series = (n) => Array.from({ length: n }, (_, i) => runEvent({ agent: 'agent-n', model: 'prov/model-b', status: 'error', crash_ttl_ms: MIN, ts: minutesAgo(10 - i, now) }));

    const banned = resolve(projectWith(series(UNAVAILABLE_MIN_FAILURES)));
    assert.equal(banned.resolved.agentId, 'agent-m', JSON.stringify(banned.resolved));
    assert.deepEqual(banned.resolved.compatible, ['agent-m']);
    const skipped = banned.lines.filter((l) => / skipped: model /.test(l));
    assert.equal(skipped.length, 1, banned.lines.join('\n'));
    assert.match(skipped[0], /agent agent-n skipped: model "prov\/model-b" — temporary ban until .* \(unavailable: 3 failed runs in a row, series 1, /);

    const short = resolve(projectWith(series(UNAVAILABLE_MIN_FAILURES - 1)));
    assert.equal(short.resolved.agentId, 'agent-n', JSON.stringify(short.resolved));
  });

  test('ночь запусков rate_limit и network_error — агент не пропущен', () => {
    const now = Date.now();
    // Временный запрет за последний network_error истёк (TTL минута): запрета серии нет.
    const events = Array.from({ length: 10 }, (_, i) => runEvent({
      agent: 'agent-n', model: 'prov/model-b', status: i % 2 === 0 ? 'rate_limit' : 'network_error',
      crash_ttl_ms: MIN, ts: minutesAgo(20 - i, now),
    }));
    const night = resolve(projectWith(events));
    assert.equal(night.resolved.agentId, 'agent-n', JSON.stringify(night.resolved));
    assert.deepEqual(night.lines.filter((l) => / skipped: model /.test(l)), []);
  });
});
