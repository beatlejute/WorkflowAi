/**
 * Выбор участника пула на место в списке стадии (PLAN-004, задачи 19–20):
 * StageExecutor.resolveAgent и executeWithFallback (src/runner.mjs).
 *
 * Пул занимает одно место в списке стадии, а не разворачивается в участников: курсор
 * попыток `(attempt-1) % length` иначе отдал бы бесплатным моделям все попытки. Место
 * пула проходит фильтры выбора, если проходит хотя бы один участник; выбирается первый
 * по маске участник, который:
 *   1. покрывает required_capabilities тикета;
 *   2. здоров по health-реестру (ключ `<пул>@<id>`);
 *   3. не под запретом модели (только стадия исполнителя);
 *   4. не пробовался в этой попытке;
 *   5. ещё не запускался на этом тикете (событие run журнала с тем же ticket и model).
 * Фильтр 5 мягкий (П9): прошедших п. 1–5 нет, а прошедшие п. 1–4 есть — первый из них
 * по маске. Место исключается из попытки, когда в ней уже max_per_attempt участников
 * пула (по умолчанию 3) или подходящих непробованных участников не осталось. Раздел
 * плана «Справочные данные» → «Выбор участника».
 *
 * Порядок запусков проверяется по значениям: `agent` событий run журнала
 * `.workflow/metrics/agent-runs.jsonl` временного проекта. Участники и агент-b —
 * фейковые node-агенты, которые выходят с кодом 1 без изменений (пустой diff), поэтому
 * стадия переходит к следующему кандидату внутри попытки.
 *
 * Корень — временный каталог ОС, снимается в afterEach. Имена моделей и агентов —
 * нейтральные.
 *
 * Запуск: node --import ./src/tests/_rails-home.mjs --test src/tests/model-pools-resolve.test.mjs
 */

import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { StageExecutor } from '../runner.mjs';
import { expandModelPools } from '../lib/model-pools.mjs';
import { readRunEvents } from '../lib/agent-runs.mjs';
import { markUnhealthy } from '../lib/agent-health-registry.mjs';

const TEMPS = [];
afterEach(() => {
  for (const dir of TEMPS.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// Команда списка: печатает свои аргументы, по одному на строку.
const LIST_SCRIPT = `process.stdout.write(process.argv.slice(2).join('\\n') + '\\n');\n`;
// Участник и агент-b: выход 1 без изменений и без RESULT.
const FAIL_AGENT = `process.exit(1);\n`;

function makeTemp() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'model-pools-resolve-'));
  TEMPS.push(base);
  const root = path.join(base, 'project');
  const tools = path.join(base, 'tools');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(tools, { recursive: true });
  const listScript = path.join(tools, 'list-models.cjs');
  const failAgent = path.join(tools, 'fail-agent.cjs');
  fs.writeFileSync(listScript, LIST_SCRIPT);
  fs.writeFileSync(failAgent, FAIL_AGENT);
  return { root, listScript, failAgent };
}

const M = (n) => `prov/vendor/m-${n}`;
const member = (n) => `pool-a@${M(n)}`;
const mm = (n) => JSON.stringify({ id: M(n), capabilities: ['multimodal'] });

/** Пул pool-a по списку `lines` и агент-b; всё запускает fail-agent. */
function agentsOf(env, lines, models = {}) {
  return {
    'pool-a': {
      command: 'node',
      args: [env.failAgent, '--model', '{model}'],
      capabilities: ['text'],
      models: { list: ['node', env.listScript, ...lines], match: ['^prov/vendor/'], ...models },
    },
    'agent-b': { command: 'node', args: [env.failAgent, '--model', 'prov/other/b'], capabilities: ['text'] },
  };
}

function captureLogger() {
  const lines = [];
  const push = (level) => (message) => lines.push(`${level} ${message}`);
  return {
    lines,
    info: push('INFO'), warn: push('WARN'), error: push('ERROR'), debug: push('DEBUG'),
    stageStart() {}, stageComplete() {}, timeout() {}, cliCall() {},
  };
}

function journalPath(root) {
  return path.join(root, '.workflow', 'metrics', 'agent-runs.jsonl');
}

function writeJournal(root, events) {
  const file = journalPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

let seq = 0;
/** Событие run исполнителя; по умолчанию — «пусто» (статус ok, ни одного изменённого файла). */
function runEvent({ model, agent, ticket = `IMPL-${500 + seq}`, status = 'ok' }) {
  seq += 1;
  return {
    type: 'run', ts: new Date(Date.now() - 30 * 60 * 1000).toISOString(), run_key: `rk-${seq}`,
    pipeline_run: 'pr-1', stage: 'execute-task', skill: 'execute-task', ticket, ticket_type: 'impl',
    attempt: 1, agent, requested: model, models: null, model, status,
    exit_code: status === 'ok' ? 0 : 1, changed_files: 0, duration_ms: 1000,
  };
}

/** Три «пусто» без успеха на чужих тикетах — постоянный запрет модели для impl (правило 1). */
const permanentBan = (n) => [0, 1, 2].map(() => runEvent({ model: M(n), agent: member(n) }));

const executorStage = (agents, extra = {}) => ({ agents, instructions: 'Выполни тикет', skill: 'execute-task', ...extra });

/**
 * Раскрытие пулов и прогон стадии через executeWithFallback. Возвращает результат или
 * ошибку стадии и `agent` событий run, дописанных прогоном, — в порядке журнала.
 */
async function runStage(root, agents, stage, { context = { ticket_id: 'IMPL-1' }, counters = {} } = {}) {
  const logger = captureLogger();
  const config = {
    pipeline: {
      name: 'model-pools-resolve', version: '1.0', agents,
      execution: { artifact_snapshot_enabled: true, timeout_per_stage: 30 },
      stages: {}, entry: 'none', context: {},
    },
  };
  await expandModelPools(config.pipeline, { projectRoot: root, logger });
  const before = readRunEvents(root).length;
  const executor = new StageExecutor(config, context, counters, {}, null, logger, root);
  let result = null;
  let error = null;
  try {
    result = await executor.executeWithFallback('execute-task', stage);
  } catch (err) {
    error = err;
  }
  const runs = readRunEvents(root).slice(before).filter((e) => e.type === 'run').map((e) => e.agent);
  return { result, error, runs, logger, executor, config };
}

const FOUR = [M(1), M(2), M(3), M(4)];

// ---------------------------------------------------------------------------

describe('место пула в списке стадии', () => {
  test('[пул, агент-b]: три разных участника пула подряд, затем агент-b; строка Agent selected с id участника', async () => {
    const env = makeTemp();
    const { error, runs, logger } = await runStage(env.root, agentsOf(env, FOUR), executorStage(['pool-a', 'agent-b']));
    assert.deepEqual(runs, [member(1), member(2), member(3), 'agent-b']);
    assert.ok(error, 'все кандидаты попытки упали — ошибка стадии');
    assert.ok(
      logger.lines.includes(`INFO Agent selected: ${member(1)} (attempt 1, compatible=[pool-a, agent-b])`),
      logger.lines.join('\n'),
    );
    assert.ok(logger.lines.includes(`INFO Agent selected: ${member(3)} (attempt 1, compatible=[pool-a, agent-b])`));
  });

  test('max_per_attempt: 1 — один участник пула, затем агент-b', async () => {
    const env = makeTemp();
    const { runs } = await runStage(env.root, agentsOf(env, FOUR, { max_per_attempt: 1 }), executorStage(['pool-a', 'agent-b']));
    assert.deepEqual(runs, [member(1), 'agent-b']);
  });

  test('пул — одно место: вторая попытка начинает с агента-b, затем участники пула', async () => {
    const env = makeTemp();
    const stage = executorStage(['pool-a', 'agent-b'], { counter: 'task_attempts' });
    const { runs } = await runStage(env.root, agentsOf(env, FOUR), stage, { counters: { task_attempts: 1 } });
    assert.deepEqual(runs, ['agent-b', member(1), member(2), member(3)]);
  });

  test('пул в списке дважды — общие участники и общий счёт max_per_attempt', async () => {
    const env = makeTemp();
    const { runs } = await runStage(env.root, agentsOf(env, FOUR), executorStage(['pool-a', 'agent-b', 'pool-a']));
    assert.deepEqual(runs, [member(1), member(2), member(3), 'agent-b']);
  });

  test('пул без участников — место не выбирается; единственное место — no_capable_agent', async () => {
    const env = makeTemp();
    const agents = agentsOf(env, ['other/vendor/x-1']);
    const withB = await runStage(env.root, agents, executorStage(['pool-a', 'agent-b']));
    assert.deepEqual(withB.runs, ['agent-b']);

    const alone = await runStage(env.root, agentsOf(env, ['other/vendor/x-1']), executorStage(['pool-a']));
    assert.equal(alone.error, null);
    assert.equal(alone.result.status, 'blocked');
    assert.equal(alone.result.blocked_reason, 'no_capable_agent');
    assert.match(alone.result.reason, /; model pools without members: pool-a$/);
    assert.deepEqual(alone.runs, []);
  });
});

describe('фильтры участника', () => {
  test('1: required_capabilities [multimodal] — только участники с multimodal', async () => {
    const env = makeTemp();
    const agents = agentsOf(env, [M(1), M(2), mm(3), mm(4)]);
    const { runs, error } = await runStage(env.root, agents, executorStage(['pool-a', 'agent-b']), {
      context: { ticket_id: 'IMPL-1', required_capabilities: '["multimodal"]' },
    });
    assert.deepEqual(runs, [member(3), member(4)]);
    assert.ok(error);
  });

  test('2: нездоровый участник пропускается; нездоровый id пула закрывает место', async () => {
    const env = makeTemp();
    markUnhealthy(env.root, member(1), { class: 'unavailable', rule_id: 'rule-x', ttl: '15m', reason: 'test' });
    const { runs } = await runStage(env.root, agentsOf(env, FOUR), executorStage(['pool-a', 'agent-b']));
    assert.deepEqual(runs, [member(2), member(3), member(4), 'agent-b']);

    const closed = makeTemp();
    markUnhealthy(closed.root, 'pool-a', { class: 'unavailable', rule_id: 'rule-y', ttl: '15m', reason: 'test' });
    const place = await runStage(closed.root, agentsOf(closed, FOUR), executorStage(['pool-a', 'agent-b']));
    assert.deepEqual(place.runs, ['agent-b']);
  });

  test('3: участник с запретом модели пропускается с причиной в логе — только на стадии исполнителя', async () => {
    const env = makeTemp();
    writeJournal(env.root, permanentBan(1));
    const { runs, logger } = await runStage(env.root, agentsOf(env, FOUR), executorStage(['pool-a', 'agent-b']));
    assert.deepEqual(runs, [member(2), member(3), member(4), 'agent-b']);
    assert.ok(
      logger.lines.some((l) => l.startsWith(`INFO agent ${member(1)} skipped: model "${M(1)}" — permanent ban for type "impl" by rule 1`)),
      logger.lines.join('\n'),
    );

    const other = makeTemp();
    writeJournal(other.root, permanentBan(1));
    const review = await runStage(other.root, agentsOf(other, FOUR), { agents: ['pool-a', 'agent-b'], skill: 'review-result' });
    assert.deepEqual(review.runs, [member(1), member(2), member(3), 'agent-b']);
  });

  test('3: все участники под запретом и других агентов нет — all_banned с причиной, никто не запускается', async () => {
    const env = makeTemp();
    const events = [...permanentBan(1), ...permanentBan(2)];
    writeJournal(env.root, events);
    const { result, error, runs } = await runStage(env.root, agentsOf(env, [M(1), M(2)]), executorStage(['pool-a']));
    assert.equal(error, null);
    assert.equal(result.status, 'blocked');
    assert.equal(result.blocked_reason, 'all_banned');
    assert.match(result.reason, new RegExp(`${member(1).replace(/\//g, '\\/')} \\(${M(1).replace(/\//g, '\\/')}: permanent ban`));
    assert.match(result.reason, new RegExp(`${member(2).replace(/\//g, '\\/')} \\(`));
    assert.deepEqual(runs, []);
  });

  test('5: участник, уже запускавшийся на тикете, уступает незапускавшимся', async () => {
    const env = makeTemp();
    writeJournal(env.root, [runEvent({ model: M(1), agent: member(1), ticket: 'IMPL-1' })]);
    const { runs } = await runStage(env.root, agentsOf(env, [M(1), M(2), M(3)]), executorStage(['pool-a', 'agent-b']));
    // m-1 — последним из участников пула: после m-2 и m-3 прошедших п. 1–5 нет (мягкий п. 5).
    assert.deepEqual(runs, [member(2), member(3), member(1), 'agent-b']);
  });

  test('5 мягкий: все прошедшие п. 1–4 уже запускались на тикете — первый из них по маске', async () => {
    const env = makeTemp();
    writeJournal(env.root, [
      runEvent({ model: M(2), agent: member(2), ticket: 'IMPL-1' }),
      runEvent({ model: M(1), agent: member(1), ticket: 'IMPL-1' }),
    ]);
    const { runs } = await runStage(env.root, agentsOf(env, [M(1), M(2)]), executorStage(['pool-a', 'agent-b']));
    assert.deepEqual(runs, [member(1), member(2), 'agent-b']);
  });

  test('5: журнал не читается — фильтр не применяется, WARN в лог, участник выбирается по маске', async () => {
    const env = makeTemp();
    fs.mkdirSync(journalPath(env.root), { recursive: true });
    const logger = captureLogger();
    const config = {
      pipeline: {
        name: 'model-pools-resolve', version: '1.0', agents: agentsOf(env, [M(1), M(2)]),
        execution: { artifact_snapshot_enabled: true, timeout_per_stage: 30 }, stages: {}, entry: 'none', context: {},
      },
    };
    await expandModelPools(config.pipeline, { projectRoot: env.root, logger });
    const executor = new StageExecutor(config, { ticket_id: 'IMPL-1' }, {}, {}, null, logger, env.root);
    const resolved = executor.resolveAgent(executorStage(['pool-a', 'agent-b']), 'execute-task');
    assert.equal(resolved.agentId, member(1), JSON.stringify(resolved));
    assert.equal(resolved.pool, 'pool-a');
    assert.deepEqual(resolved.poolCandidates, [member(1), member(2)]);
    assert.ok(
      logger.lines.some((l) => l.startsWith('WARN ') && l.includes('pool members not ordered by ticket runs')),
      logger.lines.join('\n'),
    );
  });

  test('5: без тикета в контексте фильтр не применяется', async () => {
    const env = makeTemp();
    writeJournal(env.root, [runEvent({ model: M(1), agent: member(1), ticket: 'IMPL-1' })]);
    const { runs } = await runStage(env.root, agentsOf(env, [M(1), M(2), M(3)]), executorStage(['pool-a', 'agent-b']), {
      context: {},
    });
    assert.deepEqual(runs, [member(1), member(2), member(3), 'agent-b']);
  });
});
