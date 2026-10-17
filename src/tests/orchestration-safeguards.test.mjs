import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StageExecutor, PipelineRunner } from '../runner.mjs';
import { boardTickets, decide, boardSignature } from '../scripts/check-report-needed.js';
import { checkPlanReadiness } from '../lib/utils.mjs';
import { prepareReportInput } from '../lib/report-input.mjs';
import { readRunEvents } from '../lib/agent-runs.mjs';

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-orchestration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ['tickets/done', 'tickets/blocked', 'tickets/review', 'plans/current', 'reports']) {
    fs.mkdirSync(path.join(root, '.workflow', dir), { recursive: true });
  }
  fs.writeFileSync(path.join(root, '.workflow/plans/current/PLAN-001.md'), '---\nid: PLAN-001\nstatus: active\n---\n');
  return root;
}

function ticket(root, column, id) {
  fs.writeFileSync(path.join(root, '.workflow/tickets', column, `${id}.md`), `---\nid: ${id}\nparent_plan: plans/current/PLAN-001.md\n---\n`);
}

function config(stages = {}) {
  return { pipeline: {
    name: 'safeguards', version: '1.0', entry: 'execute-task', context: {},
    agents: { a: { command: 'node', args: [], capabilities: ['text'] } },
    default_agents: ['a'], stages,
    execution: { artifact_snapshot_enabled: false, delay_between_stages: 0 },
  } };
}

test('infrastructure blocked result preserves nested diagnostics without running an agent', async (t) => {
  const root = project(t);
  const executor = new StageExecutor(config(), { required_capabilities: '["vision"]' }, {}, {}, null, null, root);
  executor.callAgent = () => assert.fail('no compatible agent may run');
  const result = await executor.executeWithFallback('execute-task', { agents: ['a'] });
  assert.equal(result.status, 'blocked');
  assert.equal(result.result.blocked_reason, 'no_capable_agent');
  assert.ok(result.result.reason);
  assert.equal(result.result.attempts, 0);
});

test('failed board scan is not an empty board', () => {
  assert.throws(() => boardTickets(path.join(os.tmpdir(), 'missing-board-' + process.pid)), /ENOENT/);
});

test('readiness is read-only and includes review and blocked tickets', (t) => {
  const root = project(t);
  ticket(root, 'done', 'IMPL-001');
  ticket(root, 'review', 'QA-001');
  ticket(root, 'blocked', 'QA-002');
  const plan = path.join(root, '.workflow/plans/current/PLAN-001.md');
  const before = fs.readFileSync(plan, 'utf8');
  const result = checkPlanReadiness(path.join(root, '.workflow'), 'PLAN-001');
  assert.equal(result.ready, false);
  assert.equal(result.total, 3);
  assert.equal(result.done, 1);
  assert.deepEqual(result.blocked.map(t => t.id), ['QA-002']);
  assert.equal(fs.readFileSync(plan, 'utf8'), before);
});

test('report input selects the only active plan without changing runner context', (t) => {
  const root = project(t);
  ticket(root, 'review', 'QA-001');
  const context = { plan_id: '' };
  const input = prepareReportInput(root, context);
  assert.equal(input.project_root, root);
  assert.equal(input.report_scope, 'plan');
  assert.equal(input.plan_id, 'PLAN-001');
  assert.equal(input.board_total, 1);
  assert.equal(JSON.parse(input.board_counts).review, 1);
  assert.deepEqual(context, { plan_id: '' });
  assert.throws(() => prepareReportInput(root, { plan_id: 'PLAN-999' }), /not found/);
  assert.throws(() => prepareReportInput('.', {}), /absolute/);
});

// HegelCodec 2026-10-11: рядом с планом лежит вынесенный из него справочник
// PLAN-001-reference.md. Имя не вида PLAN-NNN — это не испорченный план, и ронять на нём
// стадию create-report нельзя: прогон завершался «reporting attempts exhausted».
test('report input: не-план рядом с планом не считается испорченным планом', (t) => {
  const root = project(t);
  ticket(root, 'review', 'QA-001');
  fs.writeFileSync(
    path.join(root, '.workflow/plans/current/PLAN-001-reference.md'),
    '# Справочные данные\n\nВынесено из плана отдельным файлом.\n',
    'utf8',
  );
  const input = prepareReportInput(root, { plan_id: 'PLAN-001' });
  assert.equal(input.plan_id, 'PLAN-001');
  assert.equal(input.board_total, 1);
});

test('report input permits verified empty board but rejects missing and malformed data', (t) => {
  const root = project(t);
  fs.unlinkSync(path.join(root, '.workflow/plans/current/PLAN-001.md'));
  assert.equal(prepareReportInput(root, {}).report_scope, 'board');
  assert.equal(prepareReportInput(root, {}).board_total, 0);
  fs.writeFileSync(path.join(root, '.workflow/tickets/review/QA-001.md'), '');
  assert.throws(() => prepareReportInput(root, {}), /Invalid ticket/);
});

test('report plan conflict and ambiguous active plans never pick the first plan', (t) => {
  const root = project(t);
  fs.writeFileSync(path.join(root, '.workflow/plans/current/PLAN-002.md'), '---\nid: PLAN-002\nstatus: active\n---\n');
  assert.equal(prepareReportInput(root, {}).report_scope, 'board');
  fs.writeFileSync(path.join(root, '.workflow/reports/REPORT-001.md'), '---\nid: REPORT-001\nrelated_plan: PLAN-002\n---\n');
  assert.throws(() => prepareReportInput(root, { plan_id: 'PLAN-001', report_id: 'REPORT-001' }), /conflicts/);
});

test('false analysis completed never enters the successful run journal', async (t) => {
  const root = project(t);
  ticket(root, 'done', 'IMPL-001');
  ticket(root, 'blocked', 'QA-001');
  const stage = { agents: ['a'], skill: 'analyze-report' };
  const cfg = config({ 'analyze-report': stage });
  fs.writeFileSync(path.join(root, '.workflow/reports/REPORT-001.md'), '---\nid: REPORT-001\nrelated_plan: PLAN-001\n---\n');
  const executor = new StageExecutor(cfg, { plan_id: 'PLAN-001', report_id: 'REPORT-001' }, {}, {}, null, null, root);
  executor.callAgent = async () => ({ status: 'completed', result: { status: 'completed' }, output: 'completed', exitCode: 0 });
  await assert.rejects(executor.execute('analyze-report'), /Analysis completion rejected: 1\/2 tickets done/);
  const events = readRunEvents(root).filter(e => e.type === 'run');
  assert.ok(events.length);
  assert.ok(events.every(e => e.status !== 'ok' && e.result_status !== 'completed'));
});

test('completed analysis passes only when all plan tickets are finished', (t) => {
  const root = project(t);
  ticket(root, 'done', 'IMPL-001');
  const executor = new StageExecutor(config(), { plan_id: 'PLAN-001' }, {}, {}, null, null, root);
  assert.doesNotThrow(() => executor.checkReportCompletion({ skill: 'analyze-report' }, { status: 'completed' }));
  executor.context.plan_id = '';
  assert.throws(() => executor.checkReportCompletion({ skill: 'analyze-report' }, { status: 'completed' }), /valid plan/);
});

test('cached completed analysis cannot bypass the current board', () => {
  const tickets = [{ column: 'blocked', id: 'QA-001', plan: 'PLAN-001', updated_at: '', completed_at: '' }];
  const report = { id: 'REPORT-001', planId: 'PLAN-001', mtimeMs: 2000 };
  const state = { signature: boardSignature(tickets), requested_at: new Date(1000).toISOString() };
  const events = [{ type: 'run', skill: 'analyze-report', status: 'ok', result_status: 'completed', ts: new Date(3000).toISOString() }];
  assert.equal(decide({ tickets, report, state, events }).status, 'analyze');
  assert.equal(decide({ tickets, report: { ...report, planId: null }, state, events }).status, 'needed');
});

test('existing unlinked report stays board scoped even with a ready active plan', (t) => {
  const root = project(t);
  ticket(root, 'done', 'IMPL-001');
  fs.writeFileSync(path.join(root, '.workflow/reports/REPORT-001.md'), '---\nid: REPORT-001\nrelated_plan: ""\n---\n');
  const input = prepareReportInput(root, { report_id: 'REPORT-001' }, 'analyze-report');
  assert.equal(input.report_scope, 'board');
  assert.equal(input.plan_id, '');
  assert.throws(() => prepareReportInput(root, { report_id: 'REPORT-001', plan_id: 'PLAN-001' }, 'analyze-report'), /binding/);
});

test('report input rejects non-mapping report frontmatter with the report filename', (t) => {
  const root = project(t);
  for (const frontmatter of ['null', '- item', 'scalar', '2026-10-16']) {
    fs.writeFileSync(path.join(root, '.workflow/reports/REPORT-001.md'), `---\n${frontmatter}\n---\n`);
    assert.throws(
      () => prepareReportInput(root, { report_id: 'REPORT-001' }, 'analyze-report'),
      /Invalid report frontmatter: REPORT-001\.md/,
    );
  }
});

test('report input rejects non-string and empty plan statuses with the plan filename', (t) => {
  const root = project(t);
  const plan = path.join(root, '.workflow/plans/current/PLAN-001.md');
  for (const status of ['[]', '{}', '""', 'null']) {
    fs.writeFileSync(plan, `---\nid: PLAN-001\nstatus: ${status}\n---\n`);
    assert.throws(() => prepareReportInput(root, {}), /Invalid plan status: PLAN-001\.md/);
  }
});

test('report input rejects non-mapping plan frontmatter with the plan filename', (t) => {
  const root = project(t);
  const plan = path.join(root, '.workflow/plans/current/PLAN-001.md');
  for (const frontmatter of ['[]', '2026-10-16']) {
    fs.writeFileSync(plan, `---\n${frontmatter}\n---\n`);
    assert.throws(() => prepareReportInput(root, {}), /Invalid plan frontmatter: PLAN-001\.md/);
  }
});

test('verified empty board analysis completes without invoking plan closure', async (t) => {
  const root = project(t);
  fs.unlinkSync(path.join(root, '.workflow/plans/current/PLAN-001.md'));
  fs.writeFileSync(path.join(root, '.workflow/reports/REPORT-001.md'), '---\nid: REPORT-001\nrelated_plan: ""\n---\n');
  const stage = { agents: ['a'], skill: 'analyze-report' };
  const executor = new StageExecutor(config({ 'analyze-report': stage, 'complete-plan': { agent: 'a' } }), { report_id: 'REPORT-001' }, {}, {}, null, null, root);
  executor.callAgent = async () => ({ status: 'completed', result: { status: 'completed' }, output: 'completed', exitCode: 0 });
  const result = await executor.execute('analyze-report');
  assert.equal(result.status, 'completed');
  assert.equal(result.result.report_scope, 'board');
  executor.callAgent = () => assert.fail('board analysis must never invoke plan closure');
  assert.equal((await executor.execute('complete-plan')).status, 'no_plan');
});

test('new report may infer a plan but its generated report must bind that plan', (t) => {
  const root = project(t);
  ticket(root, 'done', 'IMPL-001');
  const input = prepareReportInput(root, {}, 'create-report');
  assert.equal(input.plan_id, 'PLAN-001');
  fs.writeFileSync(path.join(root, '.workflow/reports/REPORT-001.md'), '---\nid: REPORT-001\nrelated_plan: PLAN-001\n---\n');
  assert.equal(prepareReportInput(root, { plan_id: input.plan_id, report_id: 'REPORT-001' }, 'analyze-report').plan_id, 'PLAN-001');
  assert.throws(() => prepareReportInput(root, {}, 'analyze-report'), /report_id/);
});

test('existing board report preserves scope with zero, one or several active plans', (t) => {
  const root = project(t);
  fs.writeFileSync(path.join(root, '.workflow/reports/REPORT-001.md'), '---\nid: REPORT-001\nrelated_plan: ""\n---\n');
  for (const count of [1, 2, 0]) {
    if (count === 2) fs.writeFileSync(path.join(root, '.workflow/plans/current/PLAN-002.md'), '---\nid: PLAN-002\nstatus: active\n---\n');
    if (count === 0) {
      fs.unlinkSync(path.join(root, '.workflow/plans/current/PLAN-001.md'));
      fs.unlinkSync(path.join(root, '.workflow/plans/current/PLAN-002.md'));
    }
    const input = prepareReportInput(root, { report_id: 'REPORT-001' }, 'analyze-report');
    assert.equal(input.report_scope, 'board');
    assert.equal(input.plan_id, '');
  }
});

test('generated report binding is checked before accepting creation', (t) => {
  const root = project(t);
  const executor = new StageExecutor(config(), prepareReportInput(root, {}, 'create-report'), {}, {}, null, null, root);
  const report = path.join(root, '.workflow/reports/REPORT-001.md');
  const result = { status: 'default', result: { report_id: 'REPORT-001' } };
  fs.writeFileSync(report, '---\nid: REPORT-001\nrelated_plan: ""\n---\n');
  assert.throws(() => executor.checkReportCompletion({ skill: 'create-report' }, result), /binding/);
  fs.writeFileSync(report, '---\nid: REPORT-001\nrelated_plan: PLAN-001\n---\n');
  assert.doesNotThrow(() => executor.checkReportCompletion({ skill: 'create-report' }, result));
  executor.context = { ...executor.context, plan_id: '', report_scope: 'board' };
  assert.throws(() => executor.checkReportCompletion({ skill: 'create-report' }, result), /scope conflicts/);
});

test('board resolution survives stage context and cannot choose a ready unrelated plan', async (t) => {
  const root = project(t);
  ticket(root, 'done', 'IMPL-001');
  fs.writeFileSync(path.join(root, '.workflow/reports/REPORT-001.md'), '---\nid: REPORT-001\nrelated_plan: ""\n---\n');
  const runner = Object.create(PipelineRunner.prototype);
  runner.projectRoot = root;
  runner.context = { report_id: 'REPORT-001', report_scope: 'board', report_plan_id: '', plan_id: '' };
  runner.logger = { info() {} };
  const view = runner.stageContext('complete-plan', { scope: 'plan' });
  assert.equal(view.plan_id, '');
  assert.equal(view.report_scope, 'board');
  const executor = new StageExecutor(config({ 'complete-plan': { agent: 'a' } }), view, {}, {}, null, null, root);
  executor.callAgent = () => assert.fail('unrelated plan must not be closed');
  assert.equal((await executor.execute('complete-plan')).status, 'no_plan');
  assert.match(fs.readFileSync(path.join(root, '.workflow/plans/current/PLAN-001.md'), 'utf8'), /status: active/);
  assert.ok(fs.existsSync(path.join(root, '.workflow/tickets/done/IMPL-001.md')));
});

test('board completion marker crosses runner stages without closing the active plan', async (t) => {
  const root = project(t);
  ticket(root, 'done', 'IMPL-001');
  const plan = path.join(root, '.workflow/plans/current/PLAN-001.md');
  const before = fs.readFileSync(plan, 'utf8');
  fs.writeFileSync(path.join(root, '.workflow/reports/REPORT-001.md'), '---\nid: REPORT-001\nrelated_plan: ""\n---\n');
  const cfg = config({
    'analyze-report': { agents: ['a'], skill: 'analyze-report', scope: 'plan', goto: { completed: 'complete-plan' } },
    'complete-plan': { agent: 'a', scope: 'plan', goto: { no_plan: 'end' } },
  });
  cfg.pipeline.entry = 'analyze-report';
  cfg.pipeline.context = { report_id: 'REPORT-001' };
  const original = StageExecutor.prototype.callAgent;
  const calls = [];
  StageExecutor.prototype.callAgent = async (_agent, _prompt, stageId) => {
    calls.push(stageId);
    return { status: 'completed', result: { status: 'completed' }, output: 'completed', exitCode: 0 };
  };
  t.after(() => { StageExecutor.prototype.callAgent = original; });
  const runner = new PipelineRunner(cfg, { project: root });
  try {
    const outcome = await runner.run();
    assert.equal(outcome.failed, false);
    assert.equal(outcome.stuck, false);
    assert.equal(runner.endedBy.status, 'no_plan');
    assert.equal(outcome.context.report_scope, 'board');
    assert.deepEqual(calls, ['analyze-report']);
    assert.equal(fs.readFileSync(plan, 'utf8'), before);
    assert.ok(fs.existsSync(path.join(root, '.workflow/tickets/done/IMPL-001.md')));
  } finally {
    runner.disposeSignalHandlers();
  }
});

test('zero actual attempts survives goto parameter substitution', () => {
  const runner = Object.create(PipelineRunner.prototype);
  runner.context = {};
  runner.counters = {};
  runner.updateContext({ attempts: '$result.attempts' }, { attempts: 0 });
  assert.equal(runner.context.attempts, '0');
});

test('terminal not_ready and report blocked are not success', () => {
  const runner = Object.create(PipelineRunner.prototype);
  runner.context = {};
  runner.endedBy = { stage: 'complete-plan', status: 'not_ready', data: { plan_id: 'PLAN-001', reason: '45/49 tickets done' } };
  assert.match(runner.stuckEnd(), /45\/49 tickets done/);
  runner.endedBy = { stage: 'create-report', status: 'blocked', data: { reason: 'All agents unavailable' } };
  assert.match(runner.stuckEnd(), /All agents unavailable/);
});
