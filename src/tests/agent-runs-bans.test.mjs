/**
 * Постоянные запреты пары «модель + тип тикета» (permanentBans, src/lib/agent-runs.mjs,
 * PLAN-003, задача 15) — правила 1 и 2 на массивах событий журнала.
 *
 * Что охраняется:
 *  - правило 1: запрет с третьей неудачи подряд без единого успеха, двух ещё мало;
 *  - правило 2 действует только при не меньше 10 оценённых запусках пары с последнего
 *    снятия («С десяти запусков», решение 2026-09-26, вопрос 1) — при 9 и меньше
 *    запрета нет, даже с одним успехом; в полном окне из 10 запрет даёт меньше 3
 *    успехов, 3 успеха уже снимают запрет;
 *  - провал проверки пункта DoD (`fail_reasons: ["dod_items_failed=…"]`) — неудача
 *    наравне с провалом контроля по отсутствующим файлам (решение 2026-09-26, вопрос 2);
 *  - для правил достаточно, что контроль артефактов пройден (`artifacts_passed: true`),
 *    даже если итоговая градация — `pending` (ревью ещё не было) или `review_failed`
 *    (ревью не прошло);
 *  - запуски с `model: null` и градацией `stopped` (`model_banned`, `aborted` с
 *    `interrupted: true`) не входят ни в неудачи, ни в успехи, ни в счёт окна;
 *  - счёт ведётся по паре «модель + тип тикета» отдельно — неудачи одного типа не
 *    запрещают другой;
 *  - `unban` пары обнуляет счёт: правило 2 после снятия ждёт новых 10 запусков «с
 *    нуля», правило 1 продолжает считать неудачи без успеха с той же точки.
 *
 * Тесты — чистые функции на массивах событий в памяти, файловой системы не касаются.
 *
 * Запуск: node --import ./src/tests/_rails-home.mjs --test src/tests/agent-runs-bans.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  permanentBans, EXECUTOR_SKILL, RULE1_MIN_FAILURES, RULE2_WINDOW, RULE2_MIN_SUCCESS,
} from '../lib/agent-runs.mjs';

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

// Неудача — «пусто» (нет изменений).
function failureEmpty(model, ticketType) {
  return [runEvent(model, ticketType, { changed_files: 0 })];
}

// Неудача — контроль артефактов failed с причинами (в т.ч. провал пункта DoD).
function failureArtifacts(model, ticketType, failReasons = ['missing_files']) {
  const ticket = nextTicket();
  return [
    runEvent(model, ticketType, { ticket, changed_files: 2 }),
    verifyEvent(ticket, ticketType, { status: 'failed', fail_reasons: failReasons }),
  ];
}

// Успех — принят без ревью (all_green).
function successAccepted(model, ticketType) {
  const ticket = nextTicket();
  return [
    runEvent(model, ticketType, { ticket, changed_files: 2 }),
    verifyEvent(ticket, ticketType, { status: 'all_green' }),
  ];
}

// Успех — контроль пройден, ревью ещё не было (градация pending, artifacts_passed: true).
function successPending(model, ticketType) {
  const ticket = nextTicket();
  return [
    runEvent(model, ticketType, { ticket, changed_files: 2 }),
    verifyEvent(ticket, ticketType, { status: 'passed' }),
  ];
}

// Успех — контроль пройден, ревью не прошло (градация review_failed, artifacts_passed: true).
function successReviewFailed(model, ticketType) {
  const ticket = nextTicket();
  return [
    runEvent(model, ticketType, { ticket, changed_files: 2 }),
    verifyEvent(ticket, ticketType, { status: 'passed' }),
    reviewEvent(ticket, ticketType, { status: 'failed' }),
  ];
}

// Остановка роутера — запрещённая модель уже выбиралась и была снята.
function stoppedBanned(model, ticketType) {
  return [runEvent(model, ticketType, { status: 'model_banned', changed_files: 0 })];
}

// Остановка пайплайна, дозаписанная следующим стартом (задача 34).
function stoppedInterrupted(model, ticketType) {
  return [runEvent(model, ticketType, { status: 'aborted', interrupted: true, changed_files: null })];
}

// Модель kilo не прочитана — не входит ни в одно правило.
function nullModelFailure(ticketType) {
  return [runEvent(null, ticketType, { changed_files: 0 })];
}

function unbanEvent(model, ticketType, reason = 'снято для теста') {
  return {
    type: 'unban', ts: new Date().toISOString(), model,
    ...(ticketType ? { ticket_type: ticketType } : {}), reason,
  };
}

const flat = (...groups) => groups.flat();
const repeat = (n, fn) => Array.from({ length: n }, fn).flat();

function findBan(bans, model, ticketType) {
  return bans.find((b) => b.model === model && b.ticket_type === ticketType);
}

describe('permanentBans: правило 1 — граница трёх неудач подряд без успеха', () => {
  test(`${RULE1_MIN_FAILURES - 1} неудачи без успеха — без запрета`, () => {
    const events = repeat(RULE1_MIN_FAILURES - 1, () => failureEmpty('model-a', 'code'));
    assert.deepEqual(permanentBans(events), []);
  });

  test(`${RULE1_MIN_FAILURES} неудачи без успеха — запрет по правилу 1`, () => {
    const events = repeat(RULE1_MIN_FAILURES, () => failureEmpty('model-a', 'code'));
    const bans = permanentBans(events);
    assert.equal(bans.length, 1);
    const ban = bans[0];
    assert.equal(ban.model, 'model-a');
    assert.equal(ban.ticket_type, 'code');
    assert.equal(ban.rule, 1);
    assert.equal(ban.failures, RULE1_MIN_FAILURES);
    assert.equal(ban.successes, 0);
    assert.equal(ban.evidence.length, RULE1_MIN_FAILURES);
  });
});

describe('permanentBans: правило 2 — полное окно из 10, граница трёх успехов', () => {
  test(`${RULE2_MIN_SUCCESS - 1} успеха из ${RULE2_WINDOW} — запрет по правилу 2`, () => {
    const events = flat(
      successAccepted('model-a', 'code'),
      successPending('model-a', 'code'),
      repeat(RULE2_WINDOW - (RULE2_MIN_SUCCESS - 1), () => failureEmpty('model-a', 'code')),
    );
    // RULE2_MIN_SUCCESS - 1 успехов и остаток неудач — ровно RULE2_WINDOW оценённых запусков.
    const bans = permanentBans(events);
    assert.equal(bans.length, 1);
    assert.equal(bans[0].rule, 2);
    assert.equal(bans[0].successes, RULE2_MIN_SUCCESS - 1);
  });

  test(`${RULE2_MIN_SUCCESS} успеха в последних ${RULE2_WINDOW} (в т.ч. pending и review_failed) — без запрета`, () => {
    // Оценённых запусков больше окна: не засчитай код успех review_failed или
    // pending — в последние 10 вошла бы ещё одна неудача, успехов стало бы меньше
    // трёх, и правило 2 запретило бы модель.
    const events = flat(
      repeat(RULE2_WINDOW - RULE2_MIN_SUCCESS + 1, () => failureEmpty('model-a', 'code')),
      successAccepted('model-a', 'code'),
      successReviewFailed('model-a', 'code'),
      successPending('model-a', 'code'),
    );
    assert.deepEqual(permanentBans(events), []);

    const withoutReviewFailed = flat(
      repeat(RULE2_WINDOW - RULE2_MIN_SUCCESS + 1, () => failureEmpty('model-a', 'code')),
      successAccepted('model-a', 'code'),
      failureEmpty('model-a', 'code'),
      successPending('model-a', 'code'),
    );
    assert.equal(permanentBans(withoutReviewFailed)[0]?.rule, 2, 'контроль: та же последовательность с неудачей вместо review_failed запрещается');
  });

  test('ревью без вердикта (default) после пройденного контроля — успех', () => {
    const successReviewDefault = (model, ticketType) => {
      const ticket = nextTicket();
      return [
        runEvent(model, ticketType, { ticket, changed_files: 2 }),
        verifyEvent(ticket, ticketType, { status: 'passed' }),
        reviewEvent(ticket, ticketType, { status: 'default' }),
      ];
    };
    const events = flat(
      repeat(RULE2_WINDOW - RULE2_MIN_SUCCESS, () => failureEmpty('model-a', 'code')),
      successAccepted('model-a', 'code'),
      successAccepted('model-a', 'code'),
      successReviewDefault('model-a', 'code'),
    );
    assert.deepEqual(permanentBans(events), []);
  });
});

describe('permanentBans: правило 2 — неполное окно (решение 2026-09-26, вопрос 1)', () => {
  test(`${RULE2_WINDOW - 1} оценённых запусков с одним успехом — без запрета, ${RULE2_WINDOW}-й (неудача) — запрет по правилу 2`, () => {
    const nine = flat(
      successAccepted('model-a', 'bug'),
      repeat(RULE2_WINDOW - 2, () => failureEmpty('model-a', 'bug')),
    );
    // 9 оценённых запусков (1 успех + 8 неудач; `successAccepted` пишет ещё событие
    // `verify` тем же запуском) — правило 2 требует не меньше RULE2_WINDOW.
    assert.deepEqual(permanentBans(nine), []);

    const ten = flat(nine, failureEmpty('model-a', 'bug'));
    const bans = permanentBans(ten);
    assert.equal(bans.length, 1);
    assert.equal(bans[0].rule, 2);
    assert.equal(bans[0].successes, 1);
  });
});

describe('permanentBans: неполное окно после unban', () => {
  test('после unban правило 2 ждёт новых 10 запусков, правило 1 считает неудачи с той же точки', () => {
    // до снятия: полное окно из 10 с одним успехом — уже запрет по правилу 2.
    const before = flat(
      successAccepted('model-a', 'text'),
      repeat(RULE2_WINDOW - 1, () => failureEmpty('model-a', 'text')),
    );
    assert.equal(permanentBans(before).length, 1);

    const unban = unbanEvent('model-a', 'text');

    // после снятия: 1 успех и 8 неудач — 9 оценённых запусков, меньше окна: правило 2
    // не применяется, а правило 1 не может сработать при ненулевом числе успехов.
    const afterPartialWindow = flat(
      before, [unban],
      successAccepted('model-a', 'text'),
      repeat(RULE2_WINDOW - 2, () => failureEmpty('model-a', 'text')),
    );
    assert.deepEqual(permanentBans(afterPartialWindow), []);

    // после того же unban — чистые неудачи: двух мало, третья запрещает по правилу 1.
    const afterTwoFailures = flat(before, [unban], repeat(RULE1_MIN_FAILURES - 1, () => failureEmpty('model-a', 'text')));
    assert.deepEqual(permanentBans(afterTwoFailures), []);

    const afterThreeFailures = flat(afterTwoFailures, failureEmpty('model-a', 'text'));
    const bans = permanentBans(afterThreeFailures);
    assert.equal(bans.length, 1);
    assert.equal(bans[0].rule, 1);
    assert.equal(bans[0].failures, RULE1_MIN_FAILURES);
  });
});

describe('permanentBans: провал проверки DoD — неудача наравне с отсутствующими файлами', () => {
  test('запрет по правилу 1 из смеси dod_items_failed, отсутствующих файлов и пустого запуска', () => {
    const events = flat(
      failureArtifacts('model-a', 'code', ['dod_items_failed=2,3']),
      failureArtifacts('model-a', 'code', ['missing_files']),
      failureEmpty('model-a', 'code'),
    );
    const bans = permanentBans(events);
    assert.equal(bans.length, 1);
    assert.equal(bans[0].rule, 1);
    assert.equal(bans[0].failures, 3);
  });
});

describe('permanentBans: model: null и stopped вне правил', () => {
  test('лишние запуски не входят в счёт неудач', () => {
    const noise = flat(
      nullModelFailure('code'),
      nullModelFailure('code'),
      stoppedBanned('model-a', 'code'),
      stoppedInterrupted('model-a', 'code'),
    );
    const twoFailures = flat(noise, repeat(RULE1_MIN_FAILURES - 1, () => failureEmpty('model-a', 'code')));
    assert.deepEqual(permanentBans(twoFailures), []);

    const threeFailures = flat(twoFailures, failureEmpty('model-a', 'code'));
    const bans = permanentBans(threeFailures);
    assert.equal(bans.length, 1);
    assert.equal(bans[0].failures, RULE1_MIN_FAILURES);
  });

  test('запуски с model: null сами запрета не дают — ни по правилу 1, ни по правилу 2', () => {
    const rule1 = repeat(RULE1_MIN_FAILURES, () => nullModelFailure('code'));
    assert.deepEqual(permanentBans(rule1), []);
    const rule2 = flat(
      [runEvent(null, 'code', { ticket: 'IMPL-N1', changed_files: 2 }), verifyEvent('IMPL-N1', 'code', { status: 'all_green' })],
      repeat(RULE2_WINDOW - 1, () => nullModelFailure('code')),
    );
    assert.deepEqual(permanentBans(rule2), []);
  });

  test('остановленные запуски одной модели сами запрета не дают', () => {
    const events = flat(
      repeat(RULE1_MIN_FAILURES, () => stoppedBanned('model-a', 'code')),
      repeat(RULE1_MIN_FAILURES, () => stoppedInterrupted('model-a', 'code')),
    );
    assert.deepEqual(permanentBans(events), []);
  });
});

describe('permanentBans: раздельный счёт по типу тикета', () => {
  test('неудачи одного типа не запрещают другой', () => {
    const events = flat(
      repeat(RULE1_MIN_FAILURES, () => failureEmpty('model-a', 'code')),
      repeat(RULE1_MIN_FAILURES - 1, () => failureEmpty('model-a', 'text')),
    );
    const bans = permanentBans(events);
    assert.equal(bans.length, 1);
    assert.equal(bans[0].ticket_type, 'code');
    assert.equal(findBan(bans, 'model-a', 'text'), undefined);
  });
});
