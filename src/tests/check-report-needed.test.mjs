/**
 * Стадия check-report-needed (src/scripts/check-report-needed.js) перед create-report.
 *
 * Без неё каждый запуск пайплайна без работы писал новый отчёт на той же доске:
 * 2026-09-28 PulseProxy, REPORT-024…026 подряд и начатый четвёртый. Охраняется:
 *  - доска — подпись колонок и полей updated_at/completed_at тикетов: переезд и новый
 *    тикет её меняют, строка «Истории работы» (время файла) — нет;
 *  - отчёт по той же доске с удачным разбором после него — unchanged, без разбора
 *    (оборванный, `aborted`) — analyze с id отчёта, иначе needed;
 *  - без файла состояния отчёт относится к доске, если он новее всех перемещений;
 *  - скрипт пишет состояние, отправляя на create-report, и засевает его по отчёту;
 *  - в действующем configs/pipeline.yaml check-conditions.empty ведёт в эту стадию,
 *    unchanged — в end, analyze — в analyze-report с report_id.
 *
 * Запуск: node --test src/tests/check-report-needed.test.mjs
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import yaml from '../lib/js-yaml.mjs';
import { boardTickets, boardSignature, latestReport, analyzedAfter, decide, STATE_FILE } from '../scripts/check-report-needed.js';

const SCRIPT = fileURLToPath(new URL('../scripts/check-report-needed.js', import.meta.url));
const CONFIG = fileURLToPath(new URL('../../configs/pipeline.yaml', import.meta.url));
const ROOTS = [];
after(() => { for (const dir of ROOTS) fs.rmSync(dir, { recursive: true, force: true }); });

const T0 = Date.parse('2026-09-28T10:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const ticket = (column, id, updated = T0, completed = '') => ({ column, id, updated_at: iso(updated), completed_at: completed ? iso(completed) : '' });
const run = (ts, status = 'ok', skill = 'analyze-report') => ({ type: 'run', skill, stage: skill, status, ts: iso(ts) });

test('подпись доски: переезд и новый тикет меняют её, порядок одинаковых данных — нет', () => {
  const base = [ticket('done', 'FIX-1'), ticket('backlog', 'QA-2')];
  assert.equal(boardSignature(base), boardSignature([ticket('done', 'FIX-1'), ticket('backlog', 'QA-2')]));
  assert.notEqual(boardSignature(base), boardSignature([ticket('done', 'FIX-1'), ticket('ready', 'QA-2', T0 + 1)]));
  assert.notEqual(boardSignature(base), boardSignature([...base, ticket('backlog', 'QA-3')]));
});

test('разбор после отчёта: только удачный analyze-report, начатый позже отчёта', () => {
  assert.equal(analyzedAfter([run(T0 + 10)], T0), true);
  assert.equal(analyzedAfter([run(T0 + 10, 'aborted')], T0), false, 'оборванный разбор');
  assert.equal(analyzedAfter([run(T0 - 10)], T0), false, 'разбор прежнего отчёта');
  assert.equal(analyzedAfter([run(T0 + 10, 'ok', 'create-report')], T0), false, 'не та стадия');
});

test('решение: отчёта нет, доска та же с разбором и без, доска изменилась', () => {
  const tickets = [ticket('done', 'FIX-1')];
  const report = { id: 'REPORT-7', mtimeMs: T0 + 100 };
  const state = { signature: boardSignature(tickets), requested_at: iso(T0 + 50) };

  assert.equal(decide({ tickets, report: null, state, events: [] }).status, 'needed');
  assert.deepEqual(
    { ...decide({ tickets, report, state, events: [run(T0 + 200)] }), reason: undefined },
    { status: 'unchanged', report_id: 'REPORT-7', reason: undefined },
  );
  assert.equal(decide({ tickets, report, state, events: [run(T0 + 200, 'aborted')] }).status, 'analyze');
  assert.equal(decide({ tickets: [...tickets, ticket('backlog', 'QA-9')], report, state, events: [run(T0 + 200)] }).status, 'needed', 'новый тикет');
  assert.equal(decide({ tickets, report, state: { ...state, requested_at: iso(T0 + 150) }, events: [] }).status, 'needed', 'отчёт старше запроса');
});

test('без состояния: отчёт новее всех перемещений — по этой доске, старше — нужен новый', () => {
  const tickets = [ticket('done', 'FIX-1', T0, T0 + 20)];
  assert.equal(decide({ tickets, report: { id: 'REPORT-7', mtimeMs: T0 + 100 }, state: null, events: [] }).status, 'analyze');
  assert.equal(decide({ tickets, report: { id: 'REPORT-7', mtimeMs: T0 + 10 }, state: null, events: [] }).status, 'needed');
});

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-report-needed-'));
  ROOTS.push(root);
  const w = path.join(root, '.workflow');
  for (const dir of ['tickets/done', 'tickets/backlog', 'reports', 'metrics', 'state']) fs.mkdirSync(path.join(w, dir), { recursive: true });
  fs.writeFileSync(path.join(w, 'tickets/done/FIX-1.md'), `---\nid: FIX-1\nupdated_at: "${iso(T0)}"\ncompleted_at: "${iso(T0)}"\n---\n\n## История работы\n`);
  return root;
}

function cli(root) {
  const res = spawnSync(process.execPath, [SCRIPT, 'check-report-needed\n\nContext:\n  plan_id: PLAN-1\n'], { cwd: root, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const block = res.stdout.split('---RESULT---')[1] ?? '';
  return Object.fromEntries(block.split(/\r?\n/).map((l) => /^(\w+):\s*(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].trim()]));
}

test('скрипт: needed пишет состояние, отчёт по той же доске — analyze, после разбора — unchanged', () => {
  const root = makeProject();
  const reports = path.join(root, '.workflow', 'reports');
  fs.writeFileSync(path.join(reports, 'REPORT-1.md'), 'old');
  fs.utimesSync(path.join(reports, 'REPORT-1.md'), new Date(T0 - 60_000), new Date(T0 - 60_000));

  assert.equal(cli(root).status, 'needed', 'отчёт старше перемещения FIX-1');
  const state = JSON.parse(fs.readFileSync(path.join(root, STATE_FILE), 'utf8'));
  assert.equal(state.signature, boardSignature(boardTickets(path.join(root, '.workflow', 'tickets'))));

  // create-report написал отчёт после запроса; раннер дописал тикету строку истории.
  const later = new Date(Date.now() + 60_000);
  fs.writeFileSync(path.join(reports, 'REPORT-2.md'), 'new');
  fs.utimesSync(path.join(reports, 'REPORT-2.md'), later, later);
  fs.appendFileSync(path.join(root, '.workflow/tickets/done/FIX-1.md'), '| 2026-09-28 | create-report | a | ok |\n');
  assert.equal(latestReport(reports).id, 'REPORT-2');
  assert.deepEqual(cli(root), { status: 'analyze', report_id: 'REPORT-2', reason: 'доска не менялась с REPORT-2, разбора по нему нет' });

  fs.writeFileSync(path.join(root, '.workflow/metrics/agent-runs.jsonl'), JSON.stringify(run(later.getTime() + 1000)) + '\n');
  assert.equal(cli(root).status, 'unchanged');

  fs.writeFileSync(path.join(root, '.workflow/tickets/backlog/QA-2.md'), '---\nid: QA-2\ncreated_at: "2026-09-28T00:00:00Z"\n---\n');
  assert.equal(cli(root).status, 'needed', 'новый тикет с полуночным created_at');
});

test('скрипт без состояния: отчёт новее перемещений — состояние засеяно по нему', () => {
  const root = makeProject();
  const file = path.join(root, '.workflow', 'reports', 'REPORT-5.md');
  fs.writeFileSync(file, 'r');
  fs.utimesSync(file, new Date(T0 + 60_000), new Date(T0 + 60_000));

  assert.equal(cli(root).status, 'analyze');
  const state = JSON.parse(fs.readFileSync(path.join(root, STATE_FILE), 'utf8'));
  assert.ok(Date.parse(state.requested_at) < T0 + 60_000, state.requested_at);
  assert.equal(cli(root).status, 'analyze', 'дальше решает подпись');
});

test('действующий конфиг: check-conditions.empty → check-report-needed; unchanged → end, analyze → analyze-report', () => {
  const { stages, agents } = yaml.load(fs.readFileSync(CONFIG, 'utf8')).pipeline;
  assert.equal(stages['check-conditions'].goto.empty, 'check-report-needed');
  const gate = stages['check-report-needed'];
  assert.equal(gate.goto.needed, 'create-report');
  assert.equal(gate.goto.unchanged, 'end');
  assert.deepEqual(gate.goto.analyze, { stage: 'analyze-report', params: { report_id: '$result.report_id' } });
  assert.equal(gate.goto.default, 'create-report');
  assert.deepEqual(agents[gate.agent].args, ['.workflow/src/scripts/check-report-needed.js']);
});
