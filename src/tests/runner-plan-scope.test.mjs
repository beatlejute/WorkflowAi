/**
 * Контекст стадий уровня плана (`scope: plan`, src/runner.mjs — PipelineRunner.stageContext)
 * и история работы закрытого тикета (StageExecutor._auditAgentRun).
 *
 * 2026-09-29/30 (ListeningGlass PLAN-001, PulseProxy PLAN-020): контекст раннера между
 * стадиями не очищается, и create-report, analyze-report и decompose-gaps получали
 * ticket_id и task_type последнего тикета (HUMAN-003 / fix, QA-180 / qa) — в промпте, в
 * журнале запусков и строками «История работы» закрытого тикета; decompose-gaps шла без
 * plan_id, которого требует её скил (P0R2, P0Q1), — план из --plan при запуске без плана
 * пуст, а related_plan отчёта до стадии не доходил.
 *
 * Что охраняется:
 *  - стадия `scope: plan` получает копию контекста без ключей тикета; сам контекст раннера
 *    не меняется (по прежнему ticket_id updateContext сбрасывает счётчики попыток);
 *  - plan_id пуст и есть report_id — копии достаётся план отчёта (related_plan,
 *    нормализованный); plan_id из --plan не перекрывается; чужой report_id, отчёт без
 *    файла или без поля — plan_id нет;
 *  - сквозной прогон: промпт стадии без ticket_id и task_type и с plan_id отчёта; устаревший
 *    required_capabilities не блокирует стадию; событие run без тикета; файл закрытого
 *    тикета не тронут;
 *  - стадия тикета со ticket_id закрытого тикета (done/) историю ему не дописывает, тикету
 *    в работе — дописывает;
 *  - validateConfig: scope — только `plan`;
 *  - поставляемый configs/pipeline.yaml: стадии ветки отчёта объявлены `scope: plan`;
 *    instructions стадий не ссылаются на «шаг N.N» и называют только существующие узлы
 *    графа своего скила; у decompose-plan нет подстановки atomicity_failures, которая на
 *    первом проходе давала «При наличии  —».
 *
 * Агент — node-скрипт во временном каталоге ОС: пишет промпт из stdin в файл и отвечает
 * RESULT. Имена агентов нейтральные.
 *
 * Запуск: node --import ./src/tests/_rails-home.mjs --test src/tests/runner-plan-scope.test.mjs
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import yaml from '../lib/js-yaml.mjs';
import { PipelineRunner, StageExecutor, validateConfig } from '../runner.mjs';
import { readRunEvents } from '../lib/agent-runs.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHIPPED_CONFIG = path.join(REPO, 'configs', 'pipeline.yaml');
const ROOTS = [];
after(() => { for (const dir of ROOTS) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

const DONE_TICKET = `---
id: HUMAN-003
title: "Закрытый тикет"
type: human
---

## Описание

Текст.
`;

function makeRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  ROOTS.push(root);
  for (const dir of ['reports', 'tickets/done', 'tickets/in-progress', 'logs', 'state']) {
    fs.mkdirSync(path.join(root, '.workflow', dir), { recursive: true });
  }
  fs.mkdirSync(path.join(root, 'run'), { recursive: true });
  return root;
}

function writeReport(root, id, relatedPlan) {
  const field = relatedPlan === null ? '' : `related_plan: "${relatedPlan}"\n`;
  fs.writeFileSync(path.join(root, '.workflow', 'reports', `${id}.md`), `---\nid: "${id}"\n${field}---\n\n# Отчёт\n`);
}

/** Агент: промпт из stdin — в run/prompt-<n>.txt, ответ — RESULT со статусом `status`. */
function writePromptAgent(root, status = 'default') {
  const file = path.join(root, 'run', 'agent.mjs');
  fs.writeFileSync(file, `import fs from 'node:fs';
import path from 'node:path';
let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  const dir = ${JSON.stringify(path.join(root, 'run'))};
  const n = fs.readdirSync(dir).filter((f) => f.startsWith('prompt-')).length + 1;
  fs.writeFileSync(path.join(dir, 'prompt-' + n + '.txt'), input);
  console.log('---RESULT---\\nstatus: ${status}\\n---RESULT---');
});
`);
  return file;
}

function configOf(root, { context = {}, stages }) {
  return {
    pipeline: {
      name: 'plan-scope', version: '1.0', entry: Object.keys(stages)[0], context,
      execution: { delay_between_stages: 0, timeout_per_stage: 30, artifact_snapshot_enabled: false, log_file: '.workflow/logs/pipeline.log' },
      agents: {
        'agent-a': { command: 'node', args: [writePromptAgent(root)], prompt_stdin: true, capabilities: ['text'] },
      },
      stages,
    },
  };
}

function withRunner(config, root, fn, args = {}) {
  const runner = new PipelineRunner(config, { project: root, ...args });
  try {
    return fn(runner);
  } finally {
    runner.disposeSignalHandlers();
  }
}

const TICKET_CONTEXT = {
  ticket_id: 'HUMAN-003', task_type: 'fix', required_capabilities: '["typescript","i18n"]', target: 'done',
  attempt: '1', evidence_file: '.workflow/evidence/HUMAN-003.json', ready_tickets: 'IMPL-1',
};

describe('stageContext: стадия scope: plan', () => {
  it('копия без ключей тикета, plan_id из related_plan отчёта; контекст раннера прежний', () => {
    const root = makeRoot('wf-plan-scope-view-');
    writeReport(root, 'REPORT-031', 'plans/current/PLAN-020.md');
    const stage = { agents: ['agent-a'], skill: 'decompose-gaps', scope: 'plan' };
    const config = configOf(root, { context: { plan_id: '', mcp_require_for: 'qa' }, stages: { gaps: stage } });
    withRunner(config, root, (runner) => {
      Object.assign(runner.context, TICKET_CONTEXT, { report_id: 'REPORT-031', gaps: 'пробел' });
      const before = { ...runner.context };
      const view = runner.stageContext('gaps', stage);
      assert.deepEqual(view, { plan_id: 'PLAN-020', mcp_require_for: 'qa', report_id: 'REPORT-031', gaps: 'пробел' });
      assert.deepEqual(runner.context, before, 'контекст раннера не меняется');
      const log = fs.readFileSync(runner.logFilePath, 'utf8');
      assert.match(log, /scope=plan stage="gaps" ticket context not passed \(ticket_id task_type required_capabilities target attempt evidence_file ready_tickets\)/);
      assert.match(log, /scope=plan stage="gaps" plan_id=PLAN-020 from related_plan of REPORT-031/);
    });
  });

  it('plan_id из --plan не перекрывается; отчёт чужого вида, без файла или без поля — plan_id нет', () => {
    const root = makeRoot('wf-plan-scope-plan-');
    writeReport(root, 'REPORT-031', 'plans/current/PLAN-020.md');
    writeReport(root, 'REPORT-032', null);
    const stage = { agents: ['agent-a'], scope: 'plan' };
    const config = configOf(root, { context: { plan_id: '' }, stages: { gaps: stage } });
    withRunner(config, root, (runner) => {
      runner.context.report_id = 'REPORT-031';
      assert.equal(runner.stageContext('gaps', stage).plan_id, 'PLAN-007');
    }, { plan: 'PLAN-007' });
    withRunner(config, root, (runner) => {
      for (const reportId of ['REPORT-032', 'REPORT-099', '../reports/REPORT-031', 'report-031']) {
        runner.context.report_id = reportId;
        assert.equal(runner.stageContext('gaps', stage).plan_id, '', reportId);
      }
    });
  });

  it('стадия без scope — сам контекст раннера', () => {
    const root = makeRoot('wf-plan-scope-none-');
    const stage = { agents: ['agent-a'] };
    withRunner(configOf(root, { stages: { work: stage } }), root, (runner) => {
      assert.equal(runner.stageContext('work', stage), runner.context);
    });
  });
});

describe('сквозной прогон стадии scope: plan', () => {
  it('промпт без тикета и с планом отчёта, устаревшие capabilities не блокируют, закрытый тикет не тронут', async () => {
    const root = makeRoot('wf-plan-scope-run-');
    writeReport(root, 'REPORT-031', 'plans/current/PLAN-020.md');
    const ticketFile = path.join(root, '.workflow', 'tickets', 'done', 'HUMAN-003.md');
    fs.writeFileSync(ticketFile, DONE_TICKET);
    const config = configOf(root, {
      context: { plan_id: '', ...TICKET_CONTEXT, report_id: 'REPORT-031', gaps: 'пробел' },
      stages: {
        'decompose-gaps': { agents: ['agent-a'], skill: 'decompose-gaps', scope: 'plan', goto: { default: 'end' } },
      },
    });
    const runner = new PipelineRunner(config, { project: root });
    try {
      await runner.run();
    } finally {
      runner.disposeSignalHandlers();
    }
    const prompt = fs.readFileSync(path.join(root, 'run', 'prompt-1.txt'), 'utf8');
    for (const key of Object.keys(TICKET_CONTEXT)) assert.ok(!prompt.includes(`  ${key}:`), `${key} в промпте:\n${prompt}`);
    assert.match(prompt, /^ {2}plan_id: PLAN-020$/m);
    assert.match(prompt, /^ {2}report_id: REPORT-031$/m);

    const events = readRunEvents(root).filter((e) => e.type === 'run');
    assert.equal(events.length, 1, JSON.stringify(events));
    assert.equal(events[0].ticket, null);
    assert.equal(events[0].ticket_type, null);
    assert.equal(fs.readFileSync(ticketFile, 'utf8'), DONE_TICKET, 'история работы в закрытый тикет не дописана');
    assert.equal(runner.context.ticket_id, 'HUMAN-003', 'контекст раннера прежний');
  });
});

describe('история работы: закрытый тикет', () => {
  const stage = { agents: ['agent-a'], instructions: 'x', skill: 'test-skill' };
  const run = async (root, ticketId) => {
    const config = configOf(root, { stages: { review: stage } });
    const executor = new StageExecutor(config, { ticket_id: ticketId }, {}, {}, null, null, root);
    return executor.executeWithFallback('review', stage);
  };

  it('ticket_id тикета из done/ — строки нет; тикет в работе — строка есть', async () => {
    const root = makeRoot('wf-plan-scope-audit-');
    const done = path.join(root, '.workflow', 'tickets', 'done', 'HUMAN-003.md');
    fs.writeFileSync(done, DONE_TICKET);
    const inProgress = path.join(root, '.workflow', 'tickets', 'in-progress', 'IMPL-5.md');
    fs.writeFileSync(inProgress, DONE_TICKET.replace('HUMAN-003', 'IMPL-5').replace('type: human', 'type: impl'));

    await run(root, 'HUMAN-003');
    assert.equal(fs.readFileSync(done, 'utf8'), DONE_TICKET);

    await run(root, 'IMPL-5');
    assert.match(fs.readFileSync(inProgress, 'utf8'), /\| test-skill \| agent-a \| /);
  });
});

describe('validateConfig: scope', () => {
  const base = (scope) => ({
    pipeline: {
      name: 'x', version: '1', entry: 'a', agents: { 'agent-a': { command: 'node', args: [] } },
      stages: { a: { agents: ['agent-a'], ...(scope === undefined ? {} : { scope }) } },
    },
  });
  it('plan и отсутствие поля — без ошибок; другое значение — ошибка', () => {
    assert.deepEqual(validateConfig(base(undefined)).filter((e) => e.includes('scope')), []);
    assert.deepEqual(validateConfig(base('plan')).filter((e) => e.includes('scope')), []);
    assert.deepEqual(validateConfig(base('ticket')), ['Stage "a" has invalid scope: "ticket" (only "plan" is supported)']);
  });
});

describe('поставляемый configs/pipeline.yaml', () => {
  const { pipeline } = yaml.load(fs.readFileSync(SHIPPED_CONFIG, 'utf8'));

  it('стадии ветки отчёта — scope: plan', () => {
    for (const id of ['create-report', 'analyze-report', 'decompose-gaps', 'complete-plan']) {
      assert.equal(pipeline.stages[id].scope, 'plan', id);
    }
    assert.deepEqual(validateConfig({ pipeline }, REPO).filter((e) => e.includes('scope')), []);
  });

  it('instructions: без «шаг N.N», узлы графа — существующие в скиле стадии', () => {
    for (const [id, stage] of Object.entries(pipeline.stages)) {
      const texts = [stage.instructions, ...Object.values(stage.agents_by_type ?? {}).map((t) => t?.instructions)].filter(Boolean);
      for (const text of texts) {
        assert.doesNotMatch(text, /шаг \d+\.\d+/i, `${id}: ссылка на нумерованный шаг`);
        const nodes = text.match(/\bP\d+[A-Z]+\d+\b/g) ?? [];
        if (nodes.length === 0) continue;
        const skillDir = path.join(REPO, 'src', 'skills', stage.skill);
        const sources = [path.join(skillDir, 'SKILL.md'), ...fs.readdirSync(path.join(skillDir, 'workflows')).map((f) => path.join(skillDir, 'workflows', f))]
          .map((f) => fs.readFileSync(f, 'utf8')).join('\n');
        for (const node of nodes) assert.match(sources, new RegExp(`\\b${node}[\\[{(]`), `${id}: узла ${node} нет в графе скила ${stage.skill}`);
      }
    }
  });

  it('decompose-plan: без подстановки atomicity_failures — на первом проходе фраза не пустеет', () => {
    const text = pipeline.stages['decompose-plan'].instructions;
    assert.doesNotMatch(text, /\$context\.atomicity_failures/);
    assert.match(text, /гейт нумерации P10G3/);
    assert.match(text, /Если в Context есть atomicity_failures/);
  });
});
