/**
 * Стадия check-report-needed (src/scripts/check-report-needed.js) перед create-report.
 *
 * Без неё каждый запуск пайплайна без работы писал новый отчёт на той же доске:
 * 2026-09-28 PulseProxy, REPORT-024…026 подряд и начатый четвёртый. Охраняется:
 *  - доска — подпись колонок и полей updated_at/completed_at открытых тикетов и completed_at
 *    готовых: переезд и новый тикет её меняют, строка «Истории работы» (время файла) и
 *    перенос готового тикета в архив при закрытии плана — нет;
 *  - последний отчёт — наибольший номер, а не свежий файл;
 *  - разбор completed не ждёт разбиения, разбор с пробелами и событие без result_status — ждут;
 *  - состояние прежнего формата подписи решается как отсутствующее;
 *  - отчёт по той же доске с удачным разбором и удачным разбиением пробелов после разбора —
 *    unchanged; без разбора (оборванный, `aborted`) или без разбиения после него — analyze
 *    с id отчёта; доска изменилась — needed;
 *  - без файла состояния отчёт относится к доске, если он новее всех перемещений;
 *  - скрипт пишет состояние, отправляя на create-report, и засевает его по отчёту;
 *  - в действующем configs/pipeline.yaml check-conditions.empty ведёт в эту стадию,
 *    unchanged — в end, close_plan — в complete-plan, analyze — в analyze-report с report_id.
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
import { boardTickets, boardSignature, latestReport, lastOkRunAfter, decide, STATE_FILE, SIGNATURE_FORMAT } from '../scripts/check-report-needed.js';

const SCRIPT = fileURLToPath(new URL('../scripts/check-report-needed.js', import.meta.url));
const CONFIG = fileURLToPath(new URL('../../configs/pipeline.yaml', import.meta.url));
const ROOTS = [];
after(() => { for (const dir of ROOTS) fs.rmSync(dir, { recursive: true, force: true }); });

const T0 = Date.parse('2026-09-28T10:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const ticket = (column, id, updated = T0, completed = '') => ({ column, id, updated_at: iso(updated), completed_at: completed ? iso(completed) : '' });
const run = (ts, status = 'ok', skill = 'analyze-report', resultStatus) =>
  ({ type: 'run', skill, stage: skill, status, ts: iso(ts), ...(resultStatus ? { result_status: resultStatus } : {}) });

test('подпись доски: переезд и новый тикет меняют её, порядок одинаковых данных — нет', () => {
  const base = [ticket('done', 'FIX-1'), ticket('backlog', 'QA-2')];
  assert.equal(boardSignature(base), boardSignature([ticket('done', 'FIX-1'), ticket('backlog', 'QA-2')]));
  assert.notEqual(boardSignature(base), boardSignature([ticket('done', 'FIX-1'), ticket('ready', 'QA-2', T0 + 1)]));
  assert.notEqual(boardSignature(base), boardSignature([...base, ticket('backlog', 'QA-3')]));
});

// Ревью 2026-09-28: закрытие плана переносит done-тикеты в archive/ с новым updated_at,
// и следующий запуск без работы писал бы платные отчёт и разбор по той же работе.
test('подпись доски: перенос готового тикета в архив с новым updated_at её не меняет, новое завершение — меняет', () => {
  const before = [ticket('done', 'FIX-1', T0, T0 + 5), ticket('blocked', 'QA-2')];
  assert.equal(boardSignature(before), boardSignature([ticket('blocked', 'QA-2'), ticket('archive', 'FIX-1', T0 + 900, T0 + 5)]));
  assert.notEqual(boardSignature(before), boardSignature([ticket('done', 'FIX-1', T0, T0 + 6), ticket('blocked', 'QA-2')]));
  assert.notEqual(boardSignature(before), boardSignature([ticket('done', 'FIX-1', T0, T0 + 5), ticket('done', 'QA-2', T0 + 9, T0 + 9)]));
});

test('последний отчёт — наибольший номер, а не свежий файл: ручная правка старого отчёта его не подменяет', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-report-needed-reports-'));
  ROOTS.push(dir);
  fs.writeFileSync(path.join(dir, 'REPORT-9.md'), 'a');
  fs.writeFileSync(path.join(dir, 'REPORT-27.md'), 'b');
  fs.writeFileSync(path.join(dir, 'REPORT-PLAN-3.md'), 'c');
  fs.utimesSync(path.join(dir, 'REPORT-27.md'), new Date(T0), new Date(T0));
  fs.utimesSync(path.join(dir, 'REPORT-9.md'), new Date(T0 + 60_000), new Date(T0 + 60_000));
  assert.deepEqual(latestReport(dir), { id: 'REPORT-27', mtimeMs: T0, planId: null });
});

test('последний удачный запуск скила после момента: оборванный, прежний и чужой не в счёт', () => {
  assert.equal(lastOkRunAfter([run(T0 + 30), run(T0 + 10)], 'analyze-report', T0).ts, T0 + 30);
  assert.equal(lastOkRunAfter([run(T0 + 30), run(T0 + 40, 'aborted')], 'analyze-report', T0).ts, T0 + 30, 'оборванный позже удачного');
  assert.equal(lastOkRunAfter([run(T0 + 10, 'aborted')], 'analyze-report', T0), null, 'оборванный разбор');
  assert.equal(lastOkRunAfter([run(T0 - 10)], 'analyze-report', T0), null, 'разбор прежнего отчёта');
  assert.equal(lastOkRunAfter([run(T0 + 10, 'ok', 'create-report')], 'analyze-report', T0), null, 'не та стадия');
});

// Ревью 2026-09-28, второй раунд: решает последний разбор отчёта. Разбор с пробелами без
// разбиения (лимит plan_iterations) и следующий разбор completed иначе давали бы analyze
// на каждом запуске без работы.
test('решение по последнему разбору: прежний без разбиения и новый completed — close_plan, completed и новый с пробелами — analyze', () => {
  const tickets = [ticket('blocked', 'QA-1')];
  const report = { id: 'REPORT-7', mtimeMs: T0 + 100, planId: 'PLAN-3' };
  const state = { signature: boardSignature(tickets), requested_at: iso(T0 + 50) };
  const completed = (ts) => run(ts, 'ok', 'analyze-report', 'completed');

  assert.equal(decide({ tickets, report, state, events: [run(T0 + 200), completed(T0 + 400)] }).status, 'close_plan', 'событие без result_status, затем completed');
  assert.equal(decide({ tickets, report, state, events: [run(T0 + 200, 'ok', 'analyze-report', 'has_gaps'), run(T0 + 300, 'aborted', 'decompose-gaps'), completed(T0 + 400)] }).status, 'close_plan');
  assert.equal(decide({ tickets, report, state, events: [completed(T0 + 200), run(T0 + 400, 'ok', 'analyze-report', 'has_gaps')] }).status, 'analyze');
  assert.equal(decide({ tickets, report, state, events: [run(T0 + 200, 'ok', 'analyze-report', 'has_gaps'), run(T0 + 300, 'ok', 'decompose-gaps'), run(T0 + 400, 'ok', 'analyze-report', 'has_gaps')] }).status, 'analyze', 'разбиение было до последнего разбора');
});

// Ревью 2026-09-28, второй раунд: без состояния (и с состоянием 1.16.4–1.16.5) архив,
// переписавший updated_at при закрытии плана, не должен заказывать отчёт.
test('без состояния: updated_at архива не в счёт, новое завершение после отчёта — в счёт', () => {
  const report = { id: 'REPORT-7', mtimeMs: T0 + 100, planId: 'PLAN-3' };
  const events = [run(T0 + 200, 'ok', 'analyze-report', 'completed')];
  const archived = [ticket('blocked', 'QA-1'), ticket('archive', 'FIX-1', T0 + 500, T0)];
  assert.equal(decide({ tickets: archived, report, state: null, events }).status, 'close_plan');
  assert.equal(decide({ tickets: [ticket('blocked', 'QA-1'), ticket('done', 'FIX-1', T0 + 500, T0 + 150)], report, state: null, events }).status, 'needed');
});

// 2026-09-28 PulseProxy: второй разбор прогона нашёл пробел, plan_iterations дошёл до max,
// и пайплайн завершился без decompose-gaps — «разбор есть» не значит «пробелы разобраны».
test('решение: отчёта нет, доска та же с разбором и разбиением, без разбиения, без разбора, доска изменилась', () => {
  const tickets = [ticket('done', 'FIX-1')];
  const report = { id: 'REPORT-7', mtimeMs: T0 + 100 };
  const state = { signature: boardSignature(tickets), requested_at: iso(T0 + 50) };
  const analyzed = [run(T0 + 200), run(T0 + 300, 'ok', 'decompose-gaps')];

  assert.equal(decide({ tickets, report: null, state, events: [] }).status, 'needed');
  assert.deepEqual(
    { ...decide({ tickets, report, state, events: analyzed }), reason: undefined },
    { status: 'unchanged', report_id: 'REPORT-7', reason: undefined },
  );
  const noDecompose = decide({ tickets, report, state, events: [run(T0 + 200)] });
  assert.deepEqual(noDecompose, { status: 'analyze', report_id: 'REPORT-7', reason: 'доска не менялась с REPORT-7, после разбора не было разбиения пробелов' });
  assert.equal(decide({ tickets, report, state, events: [run(T0 + 150, 'ok', 'decompose-gaps'), run(T0 + 200)] }).status, 'analyze', 'разбиение до разбора');
  assert.equal(decide({ tickets, report, state, events: [run(T0 + 200), run(T0 + 300, 'aborted', 'decompose-gaps')] }).status, 'analyze', 'разбиение оборвано');
  assert.equal(decide({ tickets, report, state, events: [run(T0 + 200, 'aborted')] }).status, 'analyze');
  assert.equal(decide({ tickets: [...tickets, ticket('backlog', 'QA-9')], report, state, events: analyzed }).status, 'needed', 'новый тикет');
  assert.equal(decide({ tickets, report, state: { ...state, requested_at: iso(T0 + 150) }, events: [] }).status, 'needed', 'отчёт старше запроса');
});

// Ревью 2026-09-28: разбор completed ведёт в complete-plan, а не в разбиение; при
// complete-plan → no_plan или not_ready доска не меняется, и ожидание разбиения
// оплачивало бы новый разбор на каждом запуске без работы.
test('решение: разбор completed — close_plan без разбиения (повтор complete-plan бесплатен); has_gaps и событие без result_status ждут разбиения', () => {
  const tickets = [ticket('done', 'FIX-1')];
  const report = { id: 'REPORT-7', mtimeMs: T0 + 100, planId: 'PLAN-3' };
  const state = { signature: boardSignature(tickets), requested_at: iso(T0 + 50) };

  assert.deepEqual(
    decide({ tickets, report, state, events: [run(T0 + 200, 'ok', 'analyze-report', 'completed')] }),
    { status: 'close_plan', report_id: 'REPORT-7', plan_id: 'PLAN-3', reason: 'доска не менялась с REPORT-7, разбор по нему — completed' },
  );
  assert.equal(decide({ tickets, report, state, events: [run(T0 + 200, 'ok', 'analyze-report', 'has_gaps')] }).status, 'analyze');
  assert.equal(decide({ tickets, report, state, events: [run(T0 + 200)] }).status, 'analyze', 'раннер до 1.16.6');
  // Ревью, четвёртый раунд: закрывается план отчёта; отчёт без related_plan — закрывать нечего.
  assert.equal(decide({ tickets, report: { ...report, planId: null }, state, events: [run(T0 + 200, 'ok', 'analyze-report', 'completed')] }).status, 'unchanged');
});

// Ревью 2026-09-28, четвёртый раунд: create-report закончился удачно без нового файла
// (ветка «данных за период нет»), и гейт заказывал create-report и разбор на каждом запуске.
test('решение: удачный create-report после запроса без нового файла — отчёт для этой доски', () => {
  const tickets = [ticket('blocked', 'QA-1')];
  const report = { id: 'REPORT-7', mtimeMs: T0, planId: 'PLAN-3' };
  const state = { signature: boardSignature(tickets), requested_at: iso(T0 + 50) };
  const created = run(T0 + 100, 'ok', 'create-report');

  assert.equal(decide({ tickets, report, state, events: [] }).status, 'needed', 'запуска нет — отчёт не сделан');
  assert.equal(decide({ tickets, report, state, events: [run(T0 + 100, 'error', 'create-report')] }).status, 'needed', 'сбой — повтор');
  // Пятый раунд ревью: код выхода 0 и класс ok, но RESULT error/blocked — отчёт не сделан.
  assert.equal(decide({ tickets, report, state, events: [run(T0 + 100, 'ok', 'create-report', 'error')] }).status, 'needed', 'RESULT error');
  assert.equal(decide({ tickets, report, state, events: [run(T0 + 100, 'ok', 'create-report', 'blocked')] }).status, 'needed', 'RESULT blocked');
  assert.equal(decide({ tickets, report, state, events: [run(T0 + 100, 'ok', 'create-report', 'default')] }).status, 'analyze', 'RESULT default');
  assert.equal(decide({ tickets, report, state, events: [created] }).status, 'analyze');
  assert.equal(decide({ tickets, report, state, events: [created, run(T0 + 200, 'ok', 'analyze-report', 'completed')] }).status, 'close_plan');
  assert.equal(decide({ tickets, report, state, events: [run(T0 + 80, 'ok', 'analyze-report', 'completed'), created] }).status, 'analyze', 'разбор до этого create-report не в счёт');
});

test('последний отчёт: план из related_plan', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-report-needed-plan-'));
  ROOTS.push(dir);
  fs.writeFileSync(path.join(dir, 'REPORT-3.md'), '---\nid: REPORT-3\nrelated_plan: plans/current/PLAN-017.md\n---\n# Отчёт\n');
  assert.equal(latestReport(dir).planId, 'PLAN-017');
  // YAML не разбирается (неэкранированное двоеточие в заголовке) — поле берётся строкой.
  fs.writeFileSync(path.join(dir, 'REPORT-4.md'), '---\nid: REPORT-4\ntitle: Отчёт: итерация: PLAN-018\n  bad: [\nrelated_plan: "plans/current/PLAN-018.md"\n---\n');
  assert.equal(latestReport(dir).planId, 'PLAN-018');
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

test('скрипт: needed пишет состояние, отчёт по той же доске — analyze, после разбора и разбиения — unchanged', () => {
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
  assert.deepEqual(cli(root), { status: 'analyze', report_id: 'REPORT-2', plan_id: '', reason: 'доска не менялась с REPORT-2, разбора по нему нет' });

  const journal = path.join(root, '.workflow/metrics/agent-runs.jsonl');
  fs.writeFileSync(journal, JSON.stringify(run(later.getTime() + 1000)) + '\n');
  assert.equal(cli(root).reason, 'доска не менялась с REPORT-2, после разбора не было разбиения пробелов');
  fs.appendFileSync(journal, JSON.stringify(run(later.getTime() + 2000, 'ok', 'decompose-gaps')) + '\n');
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
  assert.equal(state.signature_format, SIGNATURE_FORMAT);
  assert.equal(cli(root).status, 'analyze', 'дальше решает подпись');
});

test('состояние прежнего формата подписи — как без состояния: смена формата сама отчёт не заказывает', () => {
  const root = makeProject();
  const file = path.join(root, '.workflow', 'reports', 'REPORT-5.md');
  fs.writeFileSync(file, 'r');
  fs.utimesSync(file, new Date(T0 + 60_000), new Date(T0 + 60_000));
  fs.writeFileSync(path.join(root, STATE_FILE), JSON.stringify({ signature: 'old-format', requested_at: iso(T0) }));

  assert.equal(cli(root).status, 'analyze', 'отчёт новее перемещений');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, STATE_FILE), 'utf8')).signature_format, SIGNATURE_FORMAT, 'засеяно в новом формате');
});

test('действующий конфиг: check-conditions.empty → check-report-needed; unchanged → end, close_plan → complete-plan, analyze → analyze-report', () => {
  const { stages, agents } = yaml.load(fs.readFileSync(CONFIG, 'utf8')).pipeline;
  assert.equal(stages['check-conditions'].goto.empty, 'check-report-needed');
  const gate = stages['check-report-needed'];
  assert.equal(gate.goto.needed, 'create-report');
  assert.equal(gate.goto.unchanged, 'end');
  assert.deepEqual(gate.goto.close_plan, { stage: 'complete-plan', params: { plan_id: '$result.plan_id' } });
  // Повтор complete-plan бесплатен и ничего не меняет, только если все его исходы — конец.
  assert.deepEqual([...new Set(Object.values(stages['complete-plan'].goto))], ['end']);
  assert.deepEqual(gate.goto.analyze, { stage: 'analyze-report', params: { report_id: '$result.report_id' } });
  assert.equal(gate.goto.default, 'create-report');
  assert.deepEqual(agents[gate.agent].args, ['.workflow/src/scripts/check-report-needed.js']);
});
