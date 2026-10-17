/**
 * Date-range model-run report (runStatsTable, src/lib/agent-runs.mjs): all recorded
 * starts in a half-open timestamp interval, raw process statuses for all stages, and
 * derived executor grades after evaluating the full journal.
 *
 * What this protects:
 *  - the start instant (`started_at` for interrupted events, otherwise `ts`) is included
 *    at `fromMs` and excluded at `toMs`;
 *  - verify/review events after the selected interval still determine a run's grade;
 *  - `process_ok` and executor `accepted` are separate measures;
 *  - all nine executor grades and raw process statuses are counted, including non-executor
 *    model runs and unknown model IDs;
 *  - date-range history retains runs before `reset`, while gradeRuns' default still respects
 *    reset for the existing quality/bans report;
 *  - an open run counts as pending, and a matching journal `run_key` is not double-counted.
 *
 * Run: node --import ./src/tests/_rails-home.mjs --test src/tests/agent-runs-range.test.mjs
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXECUTOR_SKILL, GRADES, gradeRuns, readOpenRun, readRunEvents, runStatsTable, openRunPath } from '../lib/agent-runs.mjs';

const FROM = Date.parse('2026-10-11T00:00:00.000Z');
const TO = Date.parse('2026-10-13T00:00:00.000Z');
let seq = 0;
const nextTicket = () => `QA-${++seq}`;

function run(model, overrides = {}) {
  const ts = overrides.ts ?? '2026-10-11T12:00:00.000Z';
  return {
    type: 'run',
    ts,
    started_at: overrides.started_at ?? ts,
    run_key: `run-${++seq}`,
    stage: 'execute-task',
    skill: EXECUTOR_SKILL,
    ticket: nextTicket(),
    ticket_type: 'qa',
    agent: 'agent-a',
    model,
    status: 'ok',
    changed_files: 1,
    ...overrides,
  };
}

function verify(ticket, status, extra = {}) {
  return { type: 'verify', ts: '2026-10-13T00:30:00.000Z', ticket, status, fail_reasons: status === 'failed' ? ['check_failed'] : [], ...extra };
}

function review(ticket, status) {
  return { type: 'review', ts: '2026-10-13T00:45:00.000Z', ticket, status, stage: 'review-result' };
}

function rowFor(rows, model) {
  return rows.find((row) => row.model === model);
}

const tempRoots = [];
after(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
});

describe('runStatsTable: date bounds and result semantics', () => {
  it('uses inclusive start and exclusive end, and grades with verify/review after the range', () => {
    const inRange = run('model-a', { ticket: 'QA-IN', ts: '2026-10-11T00:00:00.000Z' });
    const atEnd = run('model-a', { ticket: 'QA-OUT', ts: '2026-10-13T00:00:00.000Z' });
    const events = [
      inRange,
      verify(inRange.ticket, 'passed'),
      review(inRange.ticket, 'passed'),
      atEnd,
      verify(atEnd.ticket, 'all_green'),
    ];

    const report = runStatsTable(events, { fromMs: FROM, toMs: TO, project: 'PulseProxy' });
    assert.equal(report.totals.starts, 1);
    assert.equal(report.totals.executor_grades.accepted, 1);
    assert.deepEqual(report.rows, [{
      model: 'model-a', agents: ['agent-a'], projects: ['PulseProxy'], ticket_types: ['qa'],
      starts: 1, estimated_starts: 0, process_ok: 1, process_statuses: { ok: 1 },
      executor_starts: 1, executor_graded: 1, executor_ungraded: 0,
      executor_grades: Object.fromEntries(GRADES.map((grade) => [grade, grade === 'accepted' ? 1 : 0])),
      open_starts: 0, rails_unverified: 0,
    }]);
  });

  it('reconstructs a legacy launch time from its completion timestamp and duration', () => {
    const legacy = run('model-legacy', {
      ticket: 'QA-LEGACY', ts: '2026-10-13T00:30:00.000Z', started_at: null, duration_ms: 90 * 60_000,
    });
    const report = runStatsTable([legacy], { fromMs: FROM, toMs: TO });
    const row = rowFor(report.rows, 'model-legacy');
    assert.equal(row.starts, 1, 'start at 2026-10-12T23:00Z is in range even though completion is after it');
    assert.equal(row.estimated_starts, 1);
    assert.equal(report.unplaced_starts, 0);
  });

  it('counts every executor grade and keeps process status separate from accepted work', () => {
    const acceptedRun = run('model-a', { ticket: 'QA-ACCEPTED', status: 'error', changed_files: 2 });
    const crashedRun = run('model-a', { ticket: 'QA-CRASHED', status: 'error', changed_files: 0 });
    const refusedRun = run('model-a', { ticket: 'QA-REFUSED', status: 'blocked', changed_files: 0 });
    const stoppedRun = run('model-a', { ticket: 'QA-STOPPED', status: 'aborted', stop_requested: true, changed_files: 0 });
    const throttledRun = run('model-a', { ticket: 'QA-THROTTLED', status: 'rate_limit', changed_files: 2 });
    const emptyRun = run('model-a', { ticket: 'QA-EMPTY', changed_files: 0 });
    const artifactRun = run('model-a', { ticket: 'QA-ARTIFACTS', changed_files: 2 });
    const reviewRun = run('model-a', { ticket: 'QA-REVIEW', changed_files: 2 });
    const pendingRun = run('model-a', { ticket: 'QA-PENDING', changed_files: 2 });
    const events = [
      acceptedRun, verify(acceptedRun.ticket, 'all_green'),
      crashedRun,
      refusedRun,
      stoppedRun,
      throttledRun, verify(throttledRun.ticket, 'failed'),
      emptyRun,
      artifactRun, verify(artifactRun.ticket, 'failed'),
      reviewRun, verify(reviewRun.ticket, 'passed'), review(reviewRun.ticket, 'failed'),
      pendingRun,
    ];

    const row = rowFor(runStatsTable(events, { fromMs: FROM, toMs: TO }).rows, 'model-a');
    assert.equal(row.starts, 9);
    assert.equal(row.process_ok, 4);
    assert.deepEqual(row.process_statuses, { error: 2, blocked: 1, aborted: 1, rate_limit: 1, ok: 4 });
    assert.equal(row.executor_starts, 9);
    assert.equal(row.executor_graded, 9);
    assert.deepEqual(row.executor_grades, Object.fromEntries(GRADES.map((grade) => [grade, 1])));
    assert.equal(row.executor_grades.accepted, 1, 'accepted is the work outcome, not process exit status');
  });

  it('counts non-executor model starts and unknown models in separate rows', () => {
    const executor = run(null, { ticket: 'QA-UNKNOWN', model: null });
    const judge = {
      type: 'run', ts: '2026-10-12T11:00:00.000Z', started_at: '2026-10-12T11:00:00.000Z', run_key: 'review-run',
      stage: 'review-result', skill: 'review-result', ticket: 'QA-UNKNOWN',
      ticket_type: 'qa', agent: 'judge-a', model: 'judge-model', status: 'ok', changed_files: null,
    };
    const report = runStatsTable([executor, judge], { fromMs: FROM, toMs: TO, project: 'HegelCodec' });
    const unknown = rowFor(report.rows, null);
    const reviewer = rowFor(report.rows, 'judge-model');
    assert.deepEqual([unknown.starts, unknown.executor_starts, unknown.executor_ungraded], [1, 1, 0]);
    assert.deepEqual([reviewer.starts, reviewer.process_ok, reviewer.executor_starts], [1, 1, 0]);
    assert.equal(report.totals.starts, 2);
  });

  it('uses started_at for an interrupted event and reports an invalid timestamp separately', () => {
    const interrupted = run('model-a', {
      ticket: 'QA-INTERRUPTED', ts: '2026-10-13T02:00:00.000Z',
      started_at: '2026-10-12T23:59:59.000Z', status: 'aborted', interrupted: true,
    });
    const invalid = run('model-b', { ticket: 'QA-BAD-TS', ts: 'not-a-date' });
    const report = runStatsTable([interrupted, invalid], { fromMs: FROM, toMs: TO });
    assert.equal(report.totals.starts, 1);
    assert.equal(report.totals.executor_grades.stopped, 1);
    assert.equal(report.unplaced_starts, 1);
  });

  it('retains pre-reset launches in history mode without changing existing gradeRuns defaults', () => {
    const oldRun = run('model-a', { ticket: 'QA-RESET-OLD', ts: '2026-10-11T01:00:00.000Z' });
    const newRun = run('model-a', { ticket: 'QA-RESET-NEW', ts: '2026-10-11T02:00:00.000Z' });
    const events = [
      oldRun, verify(oldRun.ticket, 'all_green'),
      { type: 'reset', ts: '2026-10-11T01:30:00.000Z', model: 'model-a' },
      newRun, verify(newRun.ticket, 'all_green'),
    ];
    assert.equal(gradeRuns(events).length, 1, 'existing stats retain reset semantics');
    assert.equal(gradeRuns(events, { respectResets: false }).length, 2);
    const row = rowFor(runStatsTable(events, { fromMs: FROM, toMs: TO }).rows, 'model-a');
    assert.equal(row.starts, 2);
    assert.equal(row.executor_grades.accepted, 2);
  });

  it('counts an open run as pending and deduplicates it after journal closure', () => {
    const openRun = {
      run_key: 'open-run-1', ts: '2026-10-12T12:00:00.000Z',
      stage: 'execute-task', skill: EXECUTOR_SKILL, ticket: 'QA-OPEN', ticket_type: 'qa',
      agent: 'agent-a', model: 'model-a',
    };
    const pending = runStatsTable([], { fromMs: FROM, toMs: TO, openRun, project: 'PulseProxy' });
    const pendingRow = rowFor(pending.rows, 'model-a');
    assert.deepEqual([pendingRow.starts, pendingRow.open_starts, pendingRow.executor_grades.pending], [1, 1, 1]);

    const closed = { ...openRun, type: 'run', started_at: openRun.ts, status: 'ok', changed_files: 1 };
    const closedReport = runStatsTable([closed], { fromMs: FROM, toMs: TO, openRun });
    const closedRow = rowFor(closedReport.rows, 'model-a');
    assert.deepEqual([closedRow.starts, closedRow.open_starts], [1, 0]);
  });
});

describe('readOpenRun', () => {
  it('returns null when the open-run state file is absent and parses a valid record', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-agent-open-run-'));
    tempRoots.push(root);
    assert.equal(readOpenRun(root), null);
    const record = { run_key: 'open-run-2', ts: '2026-10-12T12:00:00.000Z', model: null };
    fs.mkdirSync(path.dirname(openRunPath(root)), { recursive: true });
    fs.writeFileSync(openRunPath(root), `${JSON.stringify(record)}\n`);
    assert.deepEqual(readOpenRun(root), record);
  });

  it('rejects a malformed open-run state file instead of silently omitting the launch', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-agent-open-run-bad-'));
    tempRoots.push(root);
    fs.mkdirSync(path.dirname(openRunPath(root)), { recursive: true });
    fs.writeFileSync(openRunPath(root), '{broken\n');
    assert.throws(() => readOpenRun(root), /not valid JSON/);
  });
});

describe('runStatsTable: untrusted raw status keys', () => {
  it('counts constructor and __proto__ as numeric own properties', () => {
    const events = ['constructor', '__proto__'].map((status, index) => ({
      type: 'run', ts: '2026-10-11T12:00:00.000Z', started_at: '2026-10-11T12:00:00.000Z', run_key: `raw-${index}`,
      stage: 'review-result', skill: 'review-result', ticket: `QA-RAW-${index}`,
      agent: 'reviewer', model: 'special-model', status,
    }));
    const row = rowFor(runStatsTable(events, { fromMs: FROM, toMs: TO }).rows, 'special-model');
    assert.equal(Object.hasOwn(row.process_statuses, 'constructor'), true);
    assert.equal(row.process_statuses.constructor, 1);
    assert.equal(Object.hasOwn(row.process_statuses, '__proto__'), true);
    assert.equal(row.process_statuses.__proto__, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(row.process_statuses)), JSON.parse('{"constructor":1,"__proto__":1}'));
  });
});

describe('readRunEvents malformed-line diagnostics', () => {
  it('reports invalid JSON and invalid event objects when diagnostics are requested', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-agent-runs-corrupt-'));
    tempRoots.push(root);
    const file = path.join(root, '.workflow', 'metrics', 'agent-runs.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ type: 'run', ts: '2026-10-11T12:00:00.000Z' })}\n{broken\n${JSON.stringify({ status: 'ok' })}\n`);

    const issues = [];
    const events = readRunEvents(root, { onMalformedLine: (issue) => issues.push(issue) });
    assert.equal(events.length, 1);
    assert.deepEqual(issues.map((issue) => issue.line_number), [2, 3]);
    assert.equal(readRunEvents(root).length, 1, 'existing callers retain the skip-and-continue behavior');
  });
});
