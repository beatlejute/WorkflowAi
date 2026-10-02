/**
 * Стадия check-report-needed: план стоит на заблокированном тикете.
 *
 * 2026-09-30 PulseProxy: DOCS-014 стоял в blocked/ из-за write_deny, decompose-gaps по
 * канону отнёс пробел «вне scope» и тикетов не завёл, check-conditions → empty →
 * check-report-needed → unchanged → end, и прогон кончился «Pipeline completed
 * successfully!» — ни строки о том, что план стоит и ждёт человека. Охраняется:
 *  - доска та же, после разбора было разбиение, у плана отчёта есть тикеты в blocked/ —
 *    статус stuck с их id и первой строкой blocked_reason, скрипт пишет WARN и
 *    blocked_tickets;
 *  - blocked-тикет другого плана и отчёт без плана — прежний unchanged;
 *  - подпись доски от плана и blocked_reason не зависит;
 *  - статус этого исхода действующий configs/pipeline.yaml ведёт в end: неизвестный статус
 *    ушёл бы в default: create-report — платный отчёт и разбор на той же доске;
 *  - прогон, ушедший в end по stuck, раннер кончает строкой «Pipeline stopped: plan … is
 *    stuck (…) — needs a human decision» с планом и тикетами, а не «Pipeline completed
 *    successfully!», и run() отдаёт stuck: true; по unchanged — прежний успех.
 *
 * Запуск: node --test src/tests/check-report-needed-stuck.test.mjs
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import yaml from '../lib/js-yaml.mjs';
import { boardTickets, boardSignature, decide, STATE_FILE, SIGNATURE_FORMAT } from '../scripts/check-report-needed.js';
import { PipelineRunner } from '../runner.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/check-report-needed.js', import.meta.url));
const CONFIG = fileURLToPath(new URL('../../configs/pipeline.yaml', import.meta.url));
const ROOTS = [];
after(() => { for (const dir of ROOTS) fs.rmSync(dir, { recursive: true, force: true }); });

const T0 = Date.parse('2026-09-30T13:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const run = (ts, skill, resultStatus) =>
  ({ type: 'run', skill, stage: skill, status: 'ok', ts: iso(ts), ...(resultStatus ? { result_status: resultStatus } : {}) });
const EVENTS = [run(T0 + 200, 'analyze-report', 'has_gaps'), run(T0 + 300, 'decompose-gaps')];
const REPORT = { id: 'REPORT-031', mtimeMs: T0 + 100, planId: 'PLAN-020' };

function board(extra = []) {
  return [
    { column: 'done', id: 'QA-180', updated_at: iso(T0), completed_at: iso(T0), plan: 'PLAN-020', blocked_reason: '' },
    ...extra,
  ];
}
const blockedTicket = (id, plan, reason) => ({ column: 'blocked', id, updated_at: iso(T0), completed_at: '', plan, blocked_reason: reason });

function gate(tickets) {
  return decide({ tickets, report: REPORT, state: { signature: boardSignature(tickets), requested_at: iso(T0 + 50) }, events: EVENTS });
}

test('решение: у плана отчёта тикет в blocked/ на той же доске — stuck с id и причиной', () => {
  const tickets = board([blockedTicket('DOCS-014', 'PLAN-020', 'write_deny: .workflow/src/skills/**')]);
  const result = gate(tickets);
  assert.equal(result.status, 'stuck');
  assert.equal(result.plan_id, 'PLAN-020');
  assert.deepEqual(result.blocked, [{ id: 'DOCS-014', reason: 'write_deny: .workflow/src/skills/**' }]);
  assert.equal(result.reason, 'план PLAN-020 стоит: в blocked/ DOCS-014 (write_deny: .workflow/src/skills/**) — доска не менялась с REPORT-031, разбор и разбиение по нему есть; нужно решение человека');

  const noReason = gate(board([blockedTicket('DOCS-014', 'PLAN-020', '')]));
  assert.deepEqual(noReason.blocked, [{ id: 'DOCS-014', reason: '' }]);
  assert.match(noReason.reason, /в blocked\/ DOCS-014 — доска/);
});

test('решение: blocked-тикет другого плана или отчёт без плана — прежний unchanged', () => {
  const other = board([blockedTicket('QA-9', 'PLAN-019', 'чужой')]);
  assert.deepEqual(gate(other), { status: 'unchanged', report_id: 'REPORT-031', reason: 'доска не менялась с REPORT-031, разбор и разбиение по нему есть' });
  const tickets = board([blockedTicket('DOCS-014', 'PLAN-020', 'x')]);
  const noPlan = decide({ tickets, report: { ...REPORT, planId: null }, state: { signature: boardSignature(tickets), requested_at: iso(T0 + 50) }, events: EVENTS });
  assert.deepEqual(noPlan, { status: 'unchanged', report_id: 'REPORT-031', reason: 'доска не менялась с REPORT-031, разбор и разбиение по нему есть' });
});

test('решение: разбиения после разбора нет — analyze, а не «план стоит»', () => {
  const tickets = board([blockedTicket('DOCS-014', 'PLAN-020', 'x')]);
  const result = decide({ tickets, report: REPORT, state: { signature: boardSignature(tickets), requested_at: iso(T0 + 50) }, events: [EVENTS[0]] });
  assert.equal(result.status, 'analyze');
  assert.equal(result.blocked, undefined);
});

test('действующий конфиг: статус исхода «план стоит» ведёт в end, а не в default: create-report', () => {
  const { stages } = yaml.load(fs.readFileSync(CONFIG, 'utf8')).pipeline;
  const status = gate(board([blockedTicket('DOCS-014', 'PLAN-020', 'x')])).status;
  assert.equal(stages['check-report-needed'].goto[status], 'end', `статус ${status} уходит не в end`);
});

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-report-needed-stuck-'));
  ROOTS.push(root);
  const w = path.join(root, '.workflow');
  for (const dir of ['tickets/done', 'tickets/blocked', 'reports', 'metrics', 'state']) fs.mkdirSync(path.join(w, dir), { recursive: true });
  fs.writeFileSync(path.join(w, 'tickets/done/QA-180.md'),
    `---\nid: QA-180\nparent_plan: plans/current/PLAN-020.md\nupdated_at: "${iso(T0)}"\ncompleted_at: "${iso(T0)}"\n---\n`);
  fs.writeFileSync(path.join(w, 'tickets/blocked/DOCS-014.md'),
    `---\nid: DOCS-014\nparent_plan: plans/current/PLAN-020.md\nupdated_at: "${iso(T0)}"\nblocked_reason: |-\n  write_deny: .workflow/src/skills/**\n  Human action required: narrow write_deny\n---\n`);
  const report = path.join(w, 'reports', 'REPORT-031.md');
  fs.writeFileSync(report, '---\nid: REPORT-031\nrelated_plan: plans/current/PLAN-020.md\n---\n# Отчёт\n');
  fs.utimesSync(report, new Date(T0 + 100), new Date(T0 + 100));
  const tickets = boardTickets(path.join(w, 'tickets'));
  fs.writeFileSync(path.join(root, STATE_FILE), JSON.stringify({ signature_format: SIGNATURE_FORMAT, signature: boardSignature(tickets), requested_at: iso(T0 + 50) }));
  fs.writeFileSync(path.join(w, 'metrics/agent-runs.jsonl'), EVENTS.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return root;
}

test('доска: план и первая строка blocked_reason прочитаны, подпись от них не зависит', () => {
  const root = makeProject();
  const tickets = boardTickets(path.join(root, '.workflow', 'tickets'));
  const docs = tickets.find((t) => t.id === 'DOCS-014');
  assert.equal(docs.plan, 'PLAN-020');
  assert.equal(docs.blocked_reason, 'write_deny: .workflow/src/skills/**');
  const bare = tickets.map(({ column, id, updated_at, completed_at }) => ({ column, id, updated_at, completed_at }));
  assert.equal(boardSignature(tickets), boardSignature(bare));
});

test('скрипт: план стоит — WARN с id и причиной, blocked_tickets в RESULT, статус stuck', () => {
  const root = makeProject();
  const res = spawnSync(process.execPath, [SCRIPT, 'check-report-needed\n\nContext:\n  plan_id: PLAN-020\n'], { cwd: root, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^\[WARN\] DOCS-014: blocked — write_deny: \.workflow\/src\/skills\/\*\*$/m);
  assert.match(res.stdout, /^\[WARN\] план PLAN-020 стоит: в blocked\/ DOCS-014 \(write_deny: \.workflow\/src\/skills\/\*\*\)/m);
  const block = res.stdout.split('---RESULT---')[1] ?? '';
  const result = Object.fromEntries(block.split(/\r?\n/).map((l) => /^(\w+):\s*(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].trim()]));
  assert.equal(result.status, 'stuck');
  assert.equal(result.plan_id, 'PLAN-020');
  assert.equal(result.blocked_tickets, 'DOCS-014');
  assert.equal(result.report_id, 'REPORT-031');
});

/**
 * Прогон из одной стадии-скрипта, которая отвечает RESULT `fields` и уходит в end:
 * итог раннера (run()) и текст лога.
 */
async function runGate(fields) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-report-needed-stuck-run-'));
  ROOTS.push(root);
  const script = path.join(root, 'gate.mjs');
  const block = Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n');
  fs.writeFileSync(script, `console.log(${JSON.stringify(`---RESULT---\n${block}\n---RESULT---`)});\n`);
  const config = {
    pipeline: {
      name: 'stuck-end', version: '1.0', entry: 'check-report-needed', context: {},
      execution: { delay_between_stages: 0, timeout_per_stage: 30, artifact_snapshot_enabled: false },
      agents: { 'script-gate': { command: 'node', args: [script] } },
      stages: { 'check-report-needed': { agent: 'script-gate', goto: { stuck: 'end', unchanged: 'end', default: 'end' } } },
    },
  };
  const runner = new PipelineRunner(config, { project: root });
  let result;
  try {
    result = await runner.run();
  } finally {
    runner.disposeSignalHandlers();
  }
  return { result, log: fs.readFileSync(runner.logFilePath, 'utf8') };
}

test('раннер: прогон кончился на stuck — итог «Pipeline stopped: … is stuck», не успех', async () => {
  const { result, log } = await runGate({ status: 'stuck', report_id: 'REPORT-031', plan_id: 'PLAN-020', blocked_tickets: 'DOCS-014, QA-9' });
  assert.equal(result.stuck, true);
  assert.equal(result.failed, false);
  assert.match(log, /\[WARN\] \[PipelineRunner\] Pipeline stopped: plan PLAN-020 is stuck \(check-report-needed: stuck, blocked: DOCS-014, QA-9\) — needs a human decision$/m);
  assert.doesNotMatch(log, /Pipeline completed successfully!/);
});

test('раннер: прогон кончился на unchanged — прежний «Pipeline completed successfully!»', async () => {
  const { result, log } = await runGate({ status: 'unchanged', report_id: 'REPORT-031' });
  assert.equal(result.stuck, false);
  assert.match(log, /\[INFO\] \[PipelineRunner\] Pipeline completed successfully!$/m);
  assert.doesNotMatch(log, /is stuck/);
});
