/**
 * Градации запусков исполнителя по журналу (gradeRuns, src/lib/agent-runs.mjs).
 *
 * gradeRuns — чистая функция: события журнала → запуски исполнителя (стадия со
 * скилом execute-task) с градацией. Правила — «Справочные данные → Градации
 * запуска исполнителя», PLAN-003. Тесты работают на массивах событий в памяти,
 * без файлов: журнал, файл открытого запуска и раннер здесь не участвуют.
 *
 * Что охраняется:
 *  - все восемь градаций (crashed, refused, stopped, empty, artifacts_failed,
 *    review_failed, accepted, pending) и поле artifacts_passed в каждой;
 *  - «ближайшее» окно контроля и ревью при нескольких запусках по одному
 *    тикету — fallback другого агента внутри той же попытки и повторная
 *    попытка тикета после провала получают каждый свою градацию и своё окно;
 *  - control all_green без события ревью и control legacy с ревью passed —
 *    обе ветки дают accepted;
 *  - ревью default и error — не вердикт; control failed без fail_reasons —
 *    сбой самого контроля, тоже не вердикт;
 *  - сбой при changed_files: null — crashed_after_work (не crashed), и всё
 *    равно взводит флаг crash (временный запрет считает по нему, не по имени
 *    градации);
 *  - aborted с interrupted: true и changed_files: null — stopped, а не
 *    crashed_after_work; aborted без stop_requested и interrupted (агент снят
 *    сигналом не остановкой пайплайна) — сбой, не stopped;
 *  - запуски вне стадии исполнителя (другой skill или без тикета) градации не
 *    получают и в результат не попадают.
 *
 * Запуск: node --import ./src/tests/_rails-home.mjs --test src/tests/agent-runs-grades.test.mjs
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { gradeRuns } from '../lib/agent-runs.mjs';

let seq = 0;
function nextTs() {
  seq += 1;
  return `2026-09-27T00:00:${String(seq).padStart(2, '0')}.000Z`;
}

/** Событие `run` стадии исполнителя с разумными умолчаниями. */
function runEvent(overrides = {}) {
  return {
    type: 'run',
    ts: nextTs(),
    run_key: `run-${seq}`,
    pipeline_run: 'pr-1',
    stage: 'execute',
    skill: 'execute-task',
    ticket: 'IMPL-1',
    ticket_type: 'impl',
    attempt: 1,
    agent: 'agent-a',
    requested: 'agent-a',
    models: null,
    model: 'model-a',
    status: 'ok',
    exit_code: 0,
    changed_files: 5,
    duration_ms: 1000,
    ...overrides,
  };
}

function verifyEvent(overrides = {}) {
  return {
    type: 'verify',
    ts: nextTs(),
    pipeline_run: 'pr-1',
    ticket: 'IMPL-1',
    ticket_type: 'impl',
    status: 'passed',
    fail_reasons: [],
    ...overrides,
  };
}

function reviewEvent(overrides = {}) {
  return {
    type: 'review',
    ts: nextTs(),
    pipeline_run: 'pr-1',
    ticket: 'IMPL-1',
    ticket_type: 'impl',
    stage: 'review-result',
    status: 'passed',
    agent: 'agent-a',
    model: 'model-a',
    ...overrides,
  };
}

describe('gradeRuns: все восемь градаций и artifacts_passed', () => {
  test('crashed: сбой процесса, ни одного изменённого файла', () => {
    const [run] = gradeRuns([runEvent({ status: 'error', changed_files: 0 })]);
    assert.equal(run.grade, 'crashed');
    assert.equal(run.artifacts_passed, null);
    assert.equal(run.crashed_after_work, false);
    assert.equal(run.crash, true);
  });

  test('refused: агент вернул status blocked', () => {
    const [run] = gradeRuns([runEvent({ status: 'blocked', changed_files: 0 })]);
    assert.equal(run.grade, 'refused');
    assert.equal(run.artifacts_passed, null);
  });

  test('stopped: остановка model_banned', () => {
    const [run] = gradeRuns([runEvent({ status: 'model_banned', changed_files: 3 })]);
    assert.equal(run.grade, 'stopped');
    assert.equal(run.artifacts_passed, null);
  });

  test('empty: не сбой, не blocked, не остановка, файлов не изменено', () => {
    const [run] = gradeRuns([runEvent({ status: 'ok', changed_files: 0 })]);
    assert.equal(run.grade, 'empty');
    assert.equal(run.artifacts_passed, null);
  });

  test('artifacts_failed: control failed с fail_reasons', () => {
    const events = [runEvent({ changed_files: 3 }), verifyEvent({ status: 'failed', fail_reasons: ['missing_files'] })];
    const [run] = gradeRuns(events);
    assert.equal(run.grade, 'artifacts_failed');
    assert.equal(run.artifacts_passed, false);
  });

  test('review_failed: control пройден, ревью failed', () => {
    const events = [runEvent({ changed_files: 3 }), verifyEvent({ status: 'passed' }), reviewEvent({ status: 'failed' })];
    const [run] = gradeRuns(events);
    assert.equal(run.grade, 'review_failed');
    assert.equal(run.artifacts_passed, true);
  });

  test('accepted: control all_green, ревью нет', () => {
    const events = [runEvent({ changed_files: 3 }), verifyEvent({ status: 'all_green' })];
    const [run] = gradeRuns(events);
    assert.equal(run.grade, 'accepted');
    assert.equal(run.artifacts_passed, true);
  });

  test('pending: контроля ещё не было', () => {
    const [run] = gradeRuns([runEvent({ changed_files: 3 })]);
    assert.equal(run.grade, 'pending');
    assert.equal(run.artifacts_passed, null);
  });
});

describe('gradeRuns: частные случаи и стыки правил', () => {
  test('legacy с ревью passed — accepted, как обычный passed', () => {
    const events = [runEvent({ changed_files: 2 }), verifyEvent({ status: 'legacy' }), reviewEvent({ status: 'passed' })];
    const [run] = gradeRuns(events);
    assert.equal(run.grade, 'accepted');
    assert.equal(run.artifacts_passed, true);
  });

  test('ревью default и error — не вердикт, запуск остаётся pending с пройденным контролем', () => {
    for (const reviewStatus of ['default', 'error']) {
      const events = [runEvent({ changed_files: 2 }), verifyEvent({ status: 'passed' }), reviewEvent({ status: reviewStatus })];
      const [run] = gradeRuns(events);
      assert.equal(run.grade, 'pending', reviewStatus);
      assert.equal(run.artifacts_passed, true, reviewStatus);
    }
  });

  test('сбой самого контроля (failed без fail_reasons) — не вердикт, запуск остаётся pending', () => {
    const events = [runEvent({ changed_files: 2 }), verifyEvent({ status: 'failed', fail_reasons: [], reason: 'ticket_path_unresolved' })];
    const [run] = gradeRuns(events);
    assert.equal(run.grade, 'pending');
    assert.equal(run.artifacts_passed, null);
  });

  test('сбой при changed_files: null — crashed_after_work (не crashed), но флаг crash взведён', () => {
    const [run] = gradeRuns([runEvent({ status: 'error', changed_files: null })]);
    assert.equal(run.grade, 'pending');
    assert.equal(run.crashed_after_work, true);
    assert.equal(run.crash, true);
    assert.equal(run.artifacts_passed, null);
  });

  test('сбой, изменения и пройденное ревью — accepted с crashed_after_work: true', () => {
    const events = [runEvent({ status: 'error', changed_files: 4 }), verifyEvent({ status: 'passed' }), reviewEvent({ status: 'passed' })];
    const [run] = gradeRuns(events);
    assert.equal(run.grade, 'accepted');
    assert.equal(run.crashed_after_work, true);
    assert.equal(run.crash, true);
    assert.equal(run.artifacts_passed, true);
  });

  test('stopped при любых изменениях: model_banned с изменёнными файлами — не accepted и не empty', () => {
    const [withChanges] = gradeRuns([runEvent({ status: 'model_banned', changed_files: 9 })]);
    assert.equal(withChanges.grade, 'stopped');
    const [noChanges] = gradeRuns([runEvent({ status: 'model_banned', changed_files: 0 })]);
    assert.equal(noChanges.grade, 'stopped');
  });

  test('aborted с stop_requested: true — stopped, а не empty', () => {
    const [run] = gradeRuns([runEvent({ status: 'aborted', stop_requested: true, changed_files: 0 })]);
    assert.equal(run.grade, 'stopped');
    assert.equal(run.artifacts_passed, null);
  });

  test('aborted с interrupted: true и changed_files: null — stopped, не crashed_after_work', () => {
    const [run] = gradeRuns([runEvent({ status: 'aborted', interrupted: true, changed_files: null })]);
    assert.equal(run.grade, 'stopped');
    assert.equal(run.crashed_after_work, false);
    assert.equal(run.crash, false);
    assert.equal(run.artifacts_passed, null);
  });

  test('aborted без stop_requested и interrupted — сбой (crashed), не stopped', () => {
    const [run] = gradeRuns([runEvent({ status: 'aborted', changed_files: 0 })]);
    assert.equal(run.grade, 'crashed');
    assert.equal(run.crash, true);
  });

  test('fallback внутри стадии: второй агент той же попытки получает свою градацию и своё окно контроля', () => {
    const events = [
      runEvent({ run_key: 'run-1', agent: 'agent-a', attempt: 1, status: 'empty_response', changed_files: 0 }),
      // agent-a не справился, стадия внутри той же попытки перешла к agent-b (in-stage fallback).
      runEvent({ run_key: 'run-2', agent: 'agent-b', attempt: 1, status: 'ok', changed_files: 6 }),
      verifyEvent({ status: 'passed' }),
      reviewEvent({ status: 'passed', agent: 'agent-b', model: 'model-a' }),
    ];
    const [first, second] = gradeRuns(events);
    assert.equal(first.agent, 'agent-a');
    assert.equal(first.grade, 'empty');
    assert.equal(first.verify, null);
    assert.equal(first.review, null);
    assert.equal(second.agent, 'agent-b');
    assert.equal(second.grade, 'accepted');
    assert.equal(second.verify.status, 'passed');
    assert.equal(second.review.status, 'passed');
  });

  test('повторная попытка тикета: новый запуск после провала получает отдельную градацию и не наследует старое окно', () => {
    const events = [
      runEvent({ run_key: 'run-1', attempt: 1, changed_files: 2 }),
      verifyEvent({ status: 'failed', fail_reasons: ['missing_files'] }),
      // Тикет вернулся в очередь, следующий пайплайн запускает исполнителя снова.
      runEvent({ run_key: 'run-2', attempt: 2, changed_files: 5 }),
      verifyEvent({ status: 'all_green' }),
    ];
    const [first, second] = gradeRuns(events);
    assert.equal(first.attempt, 1);
    assert.equal(first.grade, 'artifacts_failed');
    assert.equal(first.artifacts_passed, false);
    assert.equal(second.attempt, 2);
    assert.equal(second.grade, 'accepted');
    assert.equal(second.artifacts_passed, true);
    assert.equal(second.verify.status, 'all_green');
  });

  test('запуски вне стадии исполнителя (другой skill, без тикета) градации не получают', () => {
    const events = [
      runEvent({ skill: 'review-result', ticket: 'IMPL-2' }),
      runEvent({ ticket: null }),
      runEvent({ status: 'ok', changed_files: 1 }),
    ];
    const result = gradeRuns(events);
    assert.equal(result.length, 1);
    assert.equal(result[0].ticket, 'IMPL-1');
  });
});
