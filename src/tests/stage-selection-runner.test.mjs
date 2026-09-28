/**
 * Выбор модели стадии в раннере (StageExecutor.executeWithFallback с `selection`,
 * src/runner.mjs; логика — src/lib/stage-selection.mjs).
 *
 * Что охраняется:
 *  - правило 2: кандидат, отсеянный любым фильтром (способности, нездоровый агент,
 *    нездоровый id пула, шлагбаум закрыт при проходе, постоянный запрет, запрет за сбой,
 *    max_per_attempt пула, нижняя граница тикета), не попадает в JSON промпта селектора
 *    и не запускается; типизированные blocked прежние;
 *  - приоритет бесплатных: бесплатный уровня 4 раньше платного уровня 2 при R = 2; хвост
 *    ниже R — от сильных;
 *  - один вызов селектора на попытку: сбой с пустым diff — следующий кандидат без нового
 *    вызова; кандидат, ставший нездоровым между выборами, пропускается;
 *  - участник пула: первый запуск после `open` прохода шлагбаум не опрашивает, второй —
 *    опрашивает; шлагбаум, закрытый при втором опросе, закрывает остальных участников
 *    пула (правило 2 при запуске); первый участник, запускаемый после запуска другого
 *    агента попытки, шлагбаум опрашивает (квоту могли израсходовать за этот запуск);
 *    селектор пула на стадии с выбором не вызывается;
 *  - исходы селектора (выход 1, `error_class: auth` — пометка на 1 ч, таймаут,
 *    unknown_level, нездоровый селектор, все причины пропуска) — лестница от слабых;
 *    сбой селектора стадии не помечает селектор пула;
 *  - эскалация: отказ уровня 1 — уровень 4 в той же попытке, равный уровень не
 *    пробуется (и на верхнем уровне, где граница журнала ниже отказавшего и равного
 *    отсекает только проверка «строго сильнее»); отказ верхнего уровня — blocked стадии; эскалированный упал и никого
 *    не осталось — ошибка стадии (goto.error); без escalate_on — прежнее поведение;
 *  - между попытками и перезапусками: граница из журнала поднимает старт; провал на
 *    верхнем уровне — снова верхний уровень;
 *  - ни у одного кандидата нет оценки (сбой команды фактов): все на уровне 1, платные,
 *    кроме id с `:free`; попытка идёт прежним курсором по местам — попытки 1–3 запускают
 *    то же, что стадия без selection, попытка 3 начинает с третьего места, а не с
 *    участника пула; селектор пропущен (`skipped:no_scores`), причина в FACTS;
 *  - журнал: поля выбора у запусков стадии с выбором, у стадии без него их нет;
 *  - строки FACTS, SELECT_MODEL и ESCALATE.
 *
 * Агенты, пул, команда фактов, селектор и шлагбаум — node-скрипты во временном каталоге
 * ОС; поведение агента по id модели — файл behaviors.json (fail — выход 1 без
 * изменений, ok / blocked — RESULT с этим статусом, poison:<id> — пометить агента <id>
 * нездоровым и выйти 1, spend:<файл> — создать файл и выйти 1). Порядок запусков — события run журнала временного проекта.
 * Имена агентов и моделей нейтральные.
 *
 * Запуск: node --import ./src/tests/_rails-home.mjs --test src/tests/stage-selection-runner.test.mjs
 */

import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { StageExecutor } from '../runner.mjs';
import { expandModelPools } from '../lib/model-pools.mjs';
import { readRunEvents, appendRunEvent } from '../lib/agent-runs.mjs';
import { markUnhealthy } from '../lib/agent-health-registry.mjs';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_URL = pathToFileURL(path.join(TESTS_DIR, '..', 'lib', 'agent-health-registry.mjs')).href;

const TEMPS = [];
afterEach(() => {
  for (const dir of TEMPS.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const LIST_SCRIPT = `process.stdout.write(process.argv.slice(2).join('\\n') + '\\n');\n`;

// Агент: <behaviors.json> --model <id> … Поведение — по id модели (по умолчанию fail).
const AGENT_SCRIPT = `
import fs from 'node:fs';
const args = process.argv.slice(2);
const behaviors = JSON.parse(fs.readFileSync(args[0], 'utf8'));
const model = args[args.indexOf('--model') + 1];
const how = behaviors[model] || 'fail';
const out = (status) => process.stdout.write('---RESULT---\\nstatus: ' + status + '\\n---RESULT---\\n');
if (how === 'ok' || how === 'blocked') {
  out(how);
} else if (how.startsWith('spend:')) {
  // Израсходовать квоту пула (флаг шлагбаума в режиме quota) и упасть без изменений.
  fs.writeFileSync(how.slice(6), 'spent');
  process.exitCode = 1;
} else if (how.startsWith('poison:')) {
  const { markUnhealthy } = await import(behaviors.__registry);
  markUnhealthy(behaviors.__root, how.slice(7), { class: 'transient', ttl: '5m', rule_id: 'test-poison', reason: 'test' });
  process.exitCode = 1;
} else {
  process.exitCode = 1;
}
`;

// Команда фактов: <режим> <журнал> <facts.json>. Строки stdin — в журнал; ok — факты по id.
const FACTS_SCRIPT = `
const fs = require('fs');
const [mode, log, factsFile] = process.argv.slice(2);
let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  const lines = input.split(/\\r?\\n/).filter(Boolean).map((l) => JSON.parse(l));
  fs.appendFileSync(log, JSON.stringify(lines) + '\\n');
  if (mode === 'fail') { process.stderr.write('facts failed: boom\\n'); process.exit(1); }
  const facts = JSON.parse(fs.readFileSync(factsFile, 'utf8'));
  const models = lines.map((l) => {
    const f = facts[l.id] || {};
    return { id: l.id, host: l.host, resolved: f.intelligence == null ? null : l.id + '-20260101',
      intelligence: f.intelligence ?? null, coding: null, agentic: null, free: f.free === true,
      free_source: f.free === true ? 'kilo' : 'unknown' };
  });
  process.stdout.write(JSON.stringify({ as_of: '2026-09-01T00:00:00Z', citation: 'Source: test bench', models }) + '\\n');
});
`;

// Селектор: <mode.json> <журнал>. Промпт — в журнал; ответ — по mode.json.
const SELECTOR_SCRIPT = `
const fs = require('fs');
const [modeFile, log] = process.argv.slice(2);
let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  fs.appendFileSync(log, JSON.stringify({ prompt: input }) + '\\n');
  const mode = JSON.parse(fs.readFileSync(modeFile, 'utf8'));
  const out = (lines) => process.stdout.write(['---RESULT---', ...lines, '---RESULT---'].join('\\n') + '\\n');
  if (mode.kind === 'answer') {
    const lines = ['cost_usd: 0.0002'];
    if (mode.level !== undefined) lines.push('required_level: ' + mode.level);
    if (mode.ranking) lines.push('ranking: ' + mode.ranking.join(', '));
    out(lines);
  } else if (mode.kind === 'error-auth') {
    out(['status: error', 'error_class: auth', 'error: key rejected']);
    process.exit(1);
  } else if (mode.kind === 'exit1') {
    process.exit(1);
  } else if (mode.kind === 'hang') {
    setInterval(() => {}, 1000);
    setTimeout(() => process.exit(0), 20000);
  }
});
`;

const GATE_SCRIPT = `
const fs = require('fs');
const [mode, log] = process.argv.slice(2);
fs.appendFileSync(log, 'gate\\n');
const calls = fs.readFileSync(log, 'utf8').split(/\\r?\\n/).filter(Boolean).length;
const out = (lines) => process.stdout.write(['---RESULT---', ...lines, '---RESULT---'].join('\\n') + '\\n');
// flip — открыт при первом опросе, закрыт при следующих (квота кончилась посреди попытки);
// quota — закрыт, когда есть файл <журнал>.flag (квоту израсходовал запуск другого агента).
const spent = mode === 'quota' && fs.existsSync(log + '.flag');
if (mode === 'open' || (mode === 'flip' && calls === 1) || (mode === 'quota' && !spent)) out(['status: open', 'remaining: 7']);
else out(['status: closed', 'remaining: 0']);
`;

const POOL_SELECTOR_SCRIPT = `
const fs = require('fs');
fs.appendFileSync(process.argv[2], 'pool-selector\\n');
process.stdout.write('---RESULT---\\nranking: x\\n---RESULT---\\n');
`;

function makeEnv() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-selection-runner-'));
  TEMPS.push(base);
  const root = path.join(base, 'project');
  const tools = path.join(base, 'tools');
  fs.mkdirSync(path.join(root, '.workflow', 'tickets', 'in-progress'), { recursive: true });
  fs.mkdirSync(tools, { recursive: true });
  fs.writeFileSync(path.join(root, '.workflow', 'tickets', 'in-progress', 'IMPL-1.md'),
    '---\nid: IMPL-1\ntitle: "Нейтральный тикет"\ntype: impl\n---\n## Описание\n\nТекст.\n\n## Критерии готовности (Definition of Done)\n\n- [ ] пункт\n');
  const write = (name, text) => {
    const file = path.join(tools, name);
    fs.writeFileSync(file, text);
    return file;
  };
  const env = {
    root,
    listScript: write('list.cjs', LIST_SCRIPT),
    agentScript: write('agent.mjs', AGENT_SCRIPT),
    factsScript: write('facts.cjs', FACTS_SCRIPT),
    selectorScript: write('selector.cjs', SELECTOR_SCRIPT),
    gateScript: write('gate.cjs', GATE_SCRIPT),
    poolSelectorScript: write('pool-selector.cjs', POOL_SELECTOR_SCRIPT),
    behaviorsFile: path.join(tools, 'behaviors.json'),
    factsFile: path.join(tools, 'facts.json'),
    modeFile: path.join(tools, 'mode.json'),
    factsLog: path.join(base, 'facts.log'),
    selectorLog: path.join(base, 'selector.log'),
    gateLog: path.join(base, 'gate.log'),
    poolSelectorLog: path.join(base, 'pool-selector.log'),
  };
  setBehaviors(env, {});
  setFacts(env, DEFAULT_FACTS);
  setMode(env, { kind: 'answer', level: 1 });
  return env;
}

const setBehaviors = (env, map) => fs.writeFileSync(env.behaviorsFile, JSON.stringify({ __registry: REGISTRY_URL, __root: env.root, ...map }));
const setFacts = (env, map) => fs.writeFileSync(env.factsFile, JSON.stringify(map));
const setMode = (env, mode) => fs.writeFileSync(env.modeFile, JSON.stringify(mode));

// Уровни при N = 5 (полосы по 8): a 1, m-1 2, b 3, m-2 4, c 5; m-1 и m-2 бесплатные.
const A = 'vendor-a/model-a';
const B = 'vendor-a/model-b';
const C = 'vendor-a/model-c';
const M1 = 'prov/vendor-p/m-1:free';
const M2 = 'prov/vendor-p/m-2:free';
const DEFAULT_FACTS = {
  [A]: { intelligence: 10 }, [B]: { intelligence: 30 }, [C]: { intelligence: 50 },
  [M1]: { intelligence: 20, free: true }, [M2]: { intelligence: 40, free: true },
};
const mem = (id) => `pool-x@${id}`;
const LEVELS = ['l1 mechanical', 'l2 routine', 'l3 checks', 'l4 unknown cause', 'l5 architecture'];

function agentsOf(env, { caps = {}, pool = {}, extra = {} } = {}) {
  const agent = (id, model) => ({
    command: 'node', args: [env.agentScript, env.behaviorsFile, '--model', model], capabilities: caps[id] ?? ['text'],
  });
  return {
    'pool-x': {
      command: 'node',
      args: [env.agentScript, env.behaviorsFile, '--model', '{model}'],
      capabilities: caps['pool-x'] ?? ['text'],
      models: {
        list: ['node', env.listScript, M1, M2],
        match: ['^prov/'],
        ...(pool.gate ? { gate: ['node', env.gateScript, pool.gate, env.gateLog] } : {}),
        ...(pool.maxPerAttempt ? { max_per_attempt: pool.maxPerAttempt } : {}),
        ...(pool.selector ? { selector: 'sel-pool' } : {}),
      },
    },
    'agent-a': agent('agent-a', A),
    'agent-b': agent('agent-b', B),
    'agent-c': agent('agent-c', C),
    'sel-stage': { command: 'node', args: [env.selectorScript, env.modeFile, env.selectorLog], prompt_stdin: true, capabilities: ['text'] },
    'sel-pool': { command: 'node', args: [env.poolSelectorScript, env.poolSelectorLog], prompt_stdin: true, capabilities: ['text'] },
    ...extra,
  };
}

function stageOf(env, { agents = ['pool-x', 'agent-a', 'agent-b', 'agent-c'], facts = 'ok', selection = {}, extra = {} } = {}) {
  return {
    agents, instructions: 'Выполни тикет', skill: 'execute-task', counter: 'task_attempts', ...extra,
    selection: {
      selector: 'sel-stage',
      scores: ['node', env.factsScript, facts, env.factsLog, env.factsFile],
      levels: LEVELS,
      escalate_on: ['blocked'],
      ...selection,
    },
  };
}

function captureLogger() {
  const lines = [];
  const push = (level) => (message) => lines.push(`${level} ${message}`);
  return { lines, info: push('INFO'), warn: push('WARN'), error: push('ERROR'), debug: push('DEBUG'), stageStart() {}, stageComplete() {}, timeout() {}, cliCall() {} };
}

async function prepare(env, agents) {
  const logger = captureLogger();
  const config = {
    pipeline: {
      name: 'stage-selection-runner', version: '1.0', agents,
      execution: { artifact_snapshot_enabled: true, timeout_per_stage: 30 },
      stages: {}, entry: 'none', context: {},
    },
  };
  await expandModelPools(config.pipeline, { projectRoot: env.root, logger });
  const attempt = async (stage, { context = { ticket_id: 'IMPL-1' }, counters = { task_attempts: 0 }, options = {}, before = null } = {}) => {
    const start = readRunEvents(env.root).length;
    const executor = new StageExecutor(config, context, counters, {}, null, logger, env.root, options);
    if (before) before(executor);
    let result = null;
    let error = null;
    try {
      result = await executor.executeWithFallback('execute-task', stage);
    } catch (err) {
      error = err;
    }
    const events = readRunEvents(env.root).slice(start).filter((e) => e.type === 'run');
    return { result, error, events, runs: events.map((e) => e.agent) };
  };
  return { logger, config, attempt };
}

function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
const gateCalls = (env) => (fs.existsSync(env.gateLog) ? fs.readFileSync(env.gateLog, 'utf8').split('\n').filter(Boolean).length : 0);

function promptCandidates(env, n = 0) {
  const calls = readJsonLines(env.selectorLog);
  if (!calls[n]) return null;
  const block = /```json\r?\n([\s\S]*?)\r?\n```/.exec(calls[n].prompt);
  return JSON.parse(block[1]).candidates.map((c) => c.id);
}
const lines = (logger, tag) => logger.lines.filter((l) => l.includes(` ${tag} `) || l.startsWith(`INFO ${tag} `));

function healthEntry(root, id) {
  const file = path.join(root, '.workflow', 'state', 'agent-health.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).agents?.[id] ?? null : null;
}

// Журнал проекта: запуски исполнителя для запретов и границы.
function journal(root, runs) {
  for (const r of runs) {
    appendRunEvent(root, { type: 'run', skill: 'execute-task', stage: 'execute-task', status: 'ok', changed_files: 0, ticket_type: 'impl', ...r });
  }
}

const ALL = [mem(M1), mem(M2), 'agent-a', 'agent-b', 'agent-c'];

// ---------------------------------------------------------------------------

describe('правило 2: отсеянный кандидат не виден селектору и не запускается', () => {
  const cases = [
    ['способности', { caps: { 'agent-c': ['text'], 'agent-a': ['text', 'mcp'], 'agent-b': ['text', 'mcp'], 'pool-x': ['text', 'mcp'] } }, ['agent-c'], { required_capabilities: '["mcp"]' }],
    ['нездоровый агент', {}, ['agent-b'], null, (env) => markUnhealthy(env.root, 'agent-b', { class: 'transient', ttl: '5m', rule_id: 't', reason: 't' })],
    ['нездоровый id пула', {}, [mem(M1), mem(M2)], null, (env) => markUnhealthy(env.root, 'pool-x', { class: 'transient', ttl: '5m', rule_id: 't', reason: 't' })],
    ['шлагбаум закрыт при проходе', { pool: { gate: 'closed' } }, [mem(M1), mem(M2)]],
    ['постоянный запрет', {}, ['agent-a'], null, (env) => journal(env.root, [1, 2, 3].map((i) => ({ ticket: `IMPL-${10 + i}`, agent: 'agent-a', model: A })))],
    ['запрет за сбой', {}, ['agent-b'], null, (env) => journal(env.root, [{ ticket: 'IMPL-20', agent: 'agent-b', model: B, status: 'error', crash_ttl_ms: 3600000 }])],
    ['нижняя граница тикета', {}, ['agent-a'], null, (env) => journal(env.root, [{ ticket: 'IMPL-1', agent: 'agent-a', model: A }])],
  ];
  for (const [what, options, removed, context, arrange] of cases) {
    test(what, async () => {
      const env = makeEnv();
      arrange?.(env);
      const { attempt } = await prepare(env, agentsOf(env, options));
      const { runs } = await attempt(stageOf(env), { context: { ticket_id: 'IMPL-1', ...(context || {}) } });
      const offered = promptCandidates(env);
      assert.ok(offered, 'селектор вызван');
      for (const id of removed) {
        assert.ok(!offered.includes(id), `${id} в промпте: ${offered.join(', ')}`);
        assert.ok(!runs.includes(id), `${id} запущен: ${runs.join(', ')}`);
      }
      assert.deepEqual([...offered].sort(), ALL.filter((id) => !removed.includes(id)).sort());
      assert.deepEqual([...runs].sort(), ALL.filter((id) => !removed.includes(id)).sort());
    });
  }

  test('max_per_attempt пула: второй участник в попытке не запускается', async () => {
    const env = makeEnv();
    const { attempt } = await prepare(env, agentsOf(env, { pool: { maxPerAttempt: 1 } }));
    const { runs } = await attempt(stageOf(env));
    assert.deepEqual(runs, [mem(M1), 'agent-a', 'agent-b', 'agent-c']);
  });

  test('все отсеяны способностями — прежний no_capable_agent, селектора нет', async () => {
    const env = makeEnv();
    const { attempt } = await prepare(env, agentsOf(env));
    const { result } = await attempt(stageOf(env), { context: { ticket_id: 'IMPL-1', required_capabilities: '["mcp"]' } });
    assert.equal(result.status, 'blocked');
    assert.equal(result.blocked_reason, 'no_capable_agent');
    assert.deepEqual(readJsonLines(env.selectorLog), []);
  });
});

describe('порядок обхода', () => {
  test('бесплатный уровня 4 — раньше платного уровня 2 при R = 2; хвост — от сильных', async () => {
    const env = makeEnv();
    // a 10 (1), b 20 (2, платный), m-1 30 (3, бесплатный), m-2 40 (4, бесплатный), c 50 (5).
    setFacts(env, { [A]: { intelligence: 10 }, [B]: { intelligence: 20 }, [M1]: { intelligence: 30, free: true }, [M2]: { intelligence: 40, free: true }, [C]: { intelligence: 50 } });
    setMode(env, { kind: 'answer', level: 2 });
    const { attempt } = await prepare(env, agentsOf(env));
    const { runs } = await attempt(stageOf(env));
    assert.deepEqual(runs, [mem(M1), mem(M2), 'agent-b', 'agent-c', 'agent-a']);

    const env2 = makeEnv();
    setMode(env2, { kind: 'answer', level: 5 });
    const second = await prepare(env2, agentsOf(env2));
    const tail = await second.attempt(stageOf(env2));
    assert.deepEqual(tail.runs, ['agent-c', mem(M2), 'agent-b', mem(M1), 'agent-a']);
  });

  test('ранжир селектора — порядок внутри уровня', async () => {
    const env = makeEnv();
    setFacts(env, { ...DEFAULT_FACTS, [B]: { intelligence: 10 } });
    setMode(env, { kind: 'answer', level: 1, ranking: ['agent-b', 'agent-a'] });
    const { attempt } = await prepare(env, agentsOf(env));
    const { runs } = await attempt(stageOf(env));
    assert.deepEqual(runs.slice(2, 4), ['agent-b', 'agent-a']);
  });
});

describe('один выбор на попытку', () => {
  test('ровно один вызов селектора; сбой с пустым diff — следующий без нового вызова', async () => {
    const env = makeEnv();
    const { attempt } = await prepare(env, agentsOf(env));
    const { runs, error } = await attempt(stageOf(env));
    assert.deepEqual(runs, [mem(M1), mem(M2), 'agent-a', 'agent-b', 'agent-c']);
    assert.ok(error, 'все упали — ошибка стадии');
    assert.equal(readJsonLines(env.selectorLog).length, 1);
  });

  test('кандидат, ставший нездоровым между выборами, пропускается', async () => {
    const env = makeEnv();
    setBehaviors(env, { [M1]: 'poison:agent-b' });
    const { attempt } = await prepare(env, agentsOf(env));
    const { runs } = await attempt(stageOf(env));
    assert.deepEqual(runs, [mem(M1), mem(M2), 'agent-a', 'agent-c']);
  });

  test('успех — стадия завершается на нём, Agent selected с порядком обхода', async () => {
    const env = makeEnv();
    setBehaviors(env, { [M2]: 'ok' });
    const { logger, attempt } = await prepare(env, agentsOf(env));
    const { runs, result } = await attempt(stageOf(env));
    assert.deepEqual(runs, [mem(M1), mem(M2)]);
    assert.equal(result.status, 'passed');
    assert.ok(logger.lines.includes(`INFO Agent selected: ${mem(M1)} (attempt 1, compatible=[${ALL.join(', ')}])`), logger.lines.join('\n'));
  });
});

describe('участник пула на стадии с выбором', () => {
  test('первый запуск после open прохода шлагбаум не опрашивает, второй — опрашивает', async () => {
    const env = makeEnv();
    const { attempt } = await prepare(env, agentsOf(env, { pool: { gate: 'open' } }));
    const { runs } = await attempt(stageOf(env));
    assert.deepEqual(runs.slice(0, 2), [mem(M1), mem(M2)]);
    assert.equal(gateCalls(env), 2, 'проход + второй запуск');
  });

  test('шлагбаум закрылся при втором опросе — остальные участники пула не запускаются', async () => {
    const env = makeEnv();
    const { attempt } = await prepare(env, agentsOf(env, { pool: { gate: 'flip' } }));
    const { runs } = await attempt(stageOf(env));
    assert.equal(gateCalls(env), 2, 'проход (open) + опрос перед вторым участником (closed)');
    assert.deepEqual(runs, [mem(M1), 'agent-a', 'agent-b', 'agent-c']);
  });

  test('шлагбаум закрылся за время запуска другого агента — участник опрашивает его и не запускается', async () => {
    const env = makeEnv();
    const Q = 'vendor-q/model-q';
    // q 10 (1, бесплатный), a 12 (1), m-1 20 (2), b 30 (3), m-2 40 (4), c 50 (5): первым идёт q.
    setFacts(env, { [Q]: { intelligence: 10, free: true }, [A]: { intelligence: 12 }, [B]: { intelligence: 30 }, [C]: { intelligence: 50 }, [M1]: { intelligence: 20, free: true }, [M2]: { intelligence: 40, free: true } });
    setBehaviors(env, { [Q]: `spend:${env.gateLog}.flag`, [M1]: 'ok', [M2]: 'ok' });
    const agents = agentsOf(env, {
      pool: { gate: 'quota' },
      extra: { 'agent-q': { command: 'node', args: [env.agentScript, env.behaviorsFile, '--model', Q], capabilities: ['text'] } },
    });
    const { logger, attempt } = await prepare(env, agents);
    const { runs, error } = await attempt(stageOf(env, { agents: ['agent-q', 'pool-x', 'agent-a', 'agent-b', 'agent-c'] }));
    assert.deepEqual(lines(logger, 'GATE').map((l) => /status=(\w+)/.exec(l)[1]), ['open', 'closed'], 'проход (open) + опрос перед участником после запуска q (closed)');
    assert.deepEqual(runs, ['agent-q', 'agent-a', 'agent-b', 'agent-c']);
    assert.ok(error, 'все запущенные упали — ошибка стадии');
  });

  test('селектор пула не вызывается; строки SELECT agent= нет', async () => {
    const env = makeEnv();
    const { logger, attempt } = await prepare(env, agentsOf(env, { pool: { selector: true } }));
    await attempt(stageOf(env));
    assert.ok(!fs.existsSync(env.poolSelectorLog), 'селектор пула не вызван');
    assert.deepEqual(logger.lines.filter((l) => /SELECT agent=/.test(l)), []);
  });
});

describe('исходы селектора — лестница от слабых', () => {
  // Лестница (R = 1): бесплатные по возрастанию, затем платные по возрастанию.
  const LADDER = [mem(M1), mem(M2), 'agent-a', 'agent-b', 'agent-c'];
  const run = async (mode, { arrange, context, options, before, agents, stage } = {}) => {
    const env = makeEnv();
    setMode(env, mode);
    arrange?.(env);
    const prepared = await prepare(env, agents ? agents(env) : agentsOf(env, { pool: { selector: true } }));
    const out = await prepared.attempt(stage ? stage(env) : stageOf(env), { context, options, before });
    return { env, ...prepared, ...out, select: lines(prepared.logger, 'SELECT_MODEL') };
  };

  test('выход 1 — fallback=error, без error_class селектор не помечается', async () => {
    const { env, runs, select } = await run({ kind: 'exit1' });
    assert.deepEqual(runs, LADDER);
    assert.match(select[0], / required_level=- .* fallback=error /);
    assert.equal(healthEntry(env.root, 'sel-stage'), null);
  });

  test('error_class auth — нездоров 1 ч; селектор пула не помечен', async () => {
    const started = Date.now();
    const { env, runs, select } = await run({ kind: 'error-auth' });
    assert.deepEqual(runs, LADDER);
    assert.match(select[0], / fallback=error /);
    const entry = healthEntry(env.root, 'sel-stage');
    assert.equal(entry?.class, 'misconfigured');
    assert.ok(Date.parse(entry.until) >= started + 59 * 60 * 1000);
    assert.equal(healthEntry(env.root, 'sel-pool'), null);
  });

  test('таймаут — fallback=timeout, нездоров', async () => {
    const { env, runs, select } = await run({ kind: 'hang' }, { options: { selectorTimeoutMs: 800 } });
    assert.deepEqual(runs, LADDER);
    assert.match(select[0], / fallback=timeout /);
    assert.equal(healthEntry(env.root, 'sel-stage')?.class, 'transient');
  });

  test('unknown_level — лестница, ранжир ответа — порядок внутри уровня', async () => {
    const { runs, select } = await run({ kind: 'answer', level: 9, ranking: ['agent-c', mem(M2)] });
    assert.deepEqual(runs, LADDER);
    assert.match(select[0], / ranked=2 .* fallback=unknown_level /);
  });

  test('причины пропуска: нездоров, нет тикета, остановка, один кандидат, один уровень', async () => {
    const unhealthy = await run({ kind: 'answer', level: 3 }, {
      arrange: (env) => markUnhealthy(env.root, 'sel-stage', { class: 'transient', ttl: '5m', rule_id: 't', reason: 't' }),
    });
    assert.deepEqual(unhealthy.runs, LADDER);
    assert.match(unhealthy.select[0], / fallback=skipped:unhealthy /);
    assert.deepEqual(readJsonLines(unhealthy.env.selectorLog), []);

    const noTicket = await run({ kind: 'answer', level: 3 }, { context: {} });
    assert.match(noTicket.select[0], / fallback=skipped:no_ticket /);

    const stopped = await run({ kind: 'answer', level: 3 }, { before: (executor) => { executor.stopRequested = true; } });
    assert.match(stopped.select[0], / fallback=skipped:stopped /);
    assert.equal(stopped.error?.code, 'STOPPED');

    const single = await run({ kind: 'answer', level: 3 }, { stage: (env) => stageOf(env, { agents: ['agent-b'] }) });
    assert.match(single.select[0], / candidates=1 .* fallback=skipped:single_candidate /);

    const equal = Object.fromEntries([A, B, C, M1, M2].map((id) => [id, { intelligence: 30 }]));
    const flat = await run({ kind: 'answer', level: 3 }, { arrange: (env) => setFacts(env, equal) });
    assert.match(flat.select[0], / range=30\.\.30 .* fallback=skipped:single_level /);

    const unscored = await run({ kind: 'answer', level: 3 }, { arrange: (env) => setFacts(env, {}) });
    assert.match(unscored.select[0], / range=n\/a\.\.n\/a .* fallback=skipped:no_scores /);
    for (const r of [noTicket, single, flat, unscored]) assert.deepEqual(readJsonLines(r.env.selectorLog), []);
  });
});

describe('эскалация по отказу агента', () => {
  // a 10 (1), a2 10 (1), d 40 (4), c 50 (5).
  const D = 'vendor-a/model-d';
  const A2 = 'vendor-a/model-a2';
  const escalationAgents = (env) => {
    const agents = agentsOf(env);
    delete agents['pool-x'];
    delete agents['agent-b'];
    const agent = (model) => ({ command: 'node', args: [env.agentScript, env.behaviorsFile, '--model', model], capabilities: ['text'] });
    return { ...agents, 'agent-a2': agent(A2), 'agent-d': agent(D) };
  };
  const setup = async (behaviors, { level = 1, list = ['agent-a', 'agent-a2', 'agent-d', 'agent-c'], selection = {} } = {}) => {
    const env = makeEnv();
    setFacts(env, { [A]: { intelligence: 10 }, [A2]: { intelligence: 10 }, [D]: { intelligence: 40 }, [C]: { intelligence: 50 } });
    setBehaviors(env, behaviors);
    setMode(env, { kind: 'answer', level });
    const prepared = await prepare(env, escalationAgents(env));
    const out = await prepared.attempt(stageOf(env, { agents: list, selection }));
    return { env, ...prepared, ...out, escalate: lines(prepared.logger, 'ESCALATE') };
  };

  test('отказ уровня 1 — уровень 4 в той же попытке, равный уровень не пробуется', async () => {
    const { runs, result, escalate, events } = await setup({ [A]: 'blocked', [D]: 'ok' });
    assert.deepEqual(runs, ['agent-a', 'agent-d']);
    assert.equal(result.status, 'passed');
    assert.equal(events[0].result_status, 'blocked');
    assert.deepEqual(escalate, ['INFO ESCALATE stage="execute-task" from="agent-a" level=1 to="agent-d" level=4']);
  });

  test('отказ верхнего уровня при равном по уровню соседе — равный не пробуется', async () => {
    const env = makeEnv();
    const C2 = 'vendor-a/model-c2';
    setFacts(env, { [A]: { intelligence: 10 }, [A2]: { intelligence: 10 }, [D]: { intelligence: 40 }, [C]: { intelligence: 50 }, [C2]: { intelligence: 50 } });
    setBehaviors(env, { [C]: 'blocked', [C2]: 'ok' });
    setMode(env, { kind: 'answer', level: 5 });
    const agents = escalationAgents(env);
    agents['agent-c2'] = { command: 'node', args: [env.agentScript, env.behaviorsFile, '--model', C2], capabilities: ['text'] };
    const prepared = await prepare(env, agents);
    const out = await prepared.attempt(stageOf(env, { agents: ['agent-a', 'agent-c', 'agent-c2'] }));
    assert.deepEqual(out.runs, ['agent-c']);
    assert.equal(out.result.status, 'blocked');
    assert.deepEqual(lines(prepared.logger, 'ESCALATE'), ['INFO ESCALATE stage="execute-task" from="agent-c" level=5 to="none" level=-']);
  });

  test('отказ верхнего уровня — blocked стадии (goto.blocked), to="none"', async () => {
    const { runs, result, escalate } = await setup({ [C]: 'blocked' }, { level: 5 });
    assert.deepEqual(runs, ['agent-c']);
    assert.equal(result.status, 'blocked');
    assert.equal(result.blocked_reason, undefined);
    assert.deepEqual(escalate, ['INFO ESCALATE stage="execute-task" from="agent-c" level=5 to="none" level=-']);
  });

  test('эскалированный упал, никого сильнее не осталось — ошибка стадии (goto.error)', async () => {
    const { runs, error, result } = await setup({ [A]: 'blocked' }, { list: ['agent-a', 'agent-a2', 'agent-d'] });
    assert.deepEqual(runs, ['agent-a', 'agent-d']);
    assert.equal(result, null);
    assert.ok(error, 'ошибка последнего сбоя');
  });

  test('без escalate_on — отказ возвращается стадии сразу', async () => {
    const { runs, result, escalate } = await setup({ [A]: 'blocked' }, { selection: { escalate_on: undefined } });
    assert.deepEqual(runs, ['agent-a']);
    assert.equal(result.status, 'blocked');
    assert.deepEqual(escalate, []);
  });
});

describe('между попытками и перезапусками', () => {
  test('граница из журнала: новый процесс начинает выше проваленного уровня', async () => {
    const env = makeEnv();
    journal(env.root, [{ ticket: 'IMPL-1', agent: 'agent-b', model: B, status: 'ok', result_status: 'blocked', changed_files: 3 }]);
    const { attempt, logger } = await prepare(env, agentsOf(env));
    const { runs } = await attempt(stageOf(env), { counters: { task_attempts: 3 } });
    assert.deepEqual(runs, [mem(M2), 'agent-c']);
    assert.match(lines(logger, 'SELECT_MODEL')[0], / floor=3 /);
  });

  test('провал на верхнем уровне — снова верхний уровень', async () => {
    const env = makeEnv();
    journal(env.root, [{ ticket: 'IMPL-1', agent: 'agent-c', model: C }]);
    const { attempt } = await prepare(env, agentsOf(env));
    const { runs } = await attempt(stageOf(env));
    assert.deepEqual(runs, ['agent-c']);
  });

  test('агент прошлого процесса без факта — оценка из события; без неё — WARN и пропуск', async () => {
    const env = makeEnv();
    journal(env.root, [
      { ticket: 'IMPL-1', agent: 'gone-agent', model: 'x', score: 30 },
      { ticket: 'IMPL-1', agent: 'lost-agent', model: 'y' },
    ]);
    const { attempt, logger } = await prepare(env, agentsOf(env));
    const { runs } = await attempt(stageOf(env));
    assert.deepEqual(runs, [mem(M2), 'agent-c']);
    assert.ok(logger.lines.some((l) => /WARN selection: failed run of "lost-agent"/.test(l)), logger.lines.join('\n'));
  });
});

describe('факты', () => {
  test('сбой команды фактов — все на уровне 1, бесплатны только id с :free, курсор, причина в FACTS', async () => {
    const env = makeEnv();
    const { logger, attempt } = await prepare(env, agentsOf(env));
    const { runs, events } = await attempt(stageOf(env, { facts: 'fail' }));
    assert.deepEqual(runs, ALL);
    assert.deepEqual(lines(logger, 'FACTS'), ['INFO FACTS stage="execute-task" scored=0/5 free=0 (exit 1)']);
    assert.ok(logger.lines.some((l) => /^WARN stage "execute-task": selection.scores failed \(exit 1\)/.test(l)));
    for (const e of events) {
      assert.deepEqual(
        { selection: e.selection, level: e.level, required_level: e.required_level, floor_level: e.floor_level, score: e.score, free: e.free },
        { selection: 'cursor', level: 1, required_level: null, floor_level: 0, score: null, free: e.agent.startsWith('pool-x@') },
        e.agent,
      );
    }
    assert.match(lines(logger, 'SELECT_MODEL')[0],
      new RegExp(`^INFO SELECT_MODEL stage="execute-task" selector="sel-stage" candidates=5 levels=5 range=n/a\\.\\.n/a floor=0 required_level=- ranked=0 pick="${mem(M1).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}" level=1 free=true fallback=skipped:no_scores cost_usd=unknown duration_ms=0$`));
    assert.deepEqual(readJsonLines(env.selectorLog), [], 'селектор не вызван');
    assert.ok(logger.lines.includes('INFO Agent selected: agent-a (attempt 1, compatible=[agent-a, agent-b, agent-c])'), logger.lines.join('\n'));
  });

  test('без оценок попытки 1–3 идут прежним курсором: попытка 3 — третье место, не участник пула', async () => {
    // Один проект, попытки подряд: исполнитель каждой попытки отвечает ok (дальше тикет
    // вернуло бы ревью), граница из журнала без оценок не действует.
    const env = makeEnv();
    setBehaviors(env, Object.fromEntries([A, B, C, M1, M2].map((id) => [id, 'ok'])));
    const { logger, attempt } = await prepare(env, agentsOf(env));
    const firsts = [];
    for (const done of [0, 1, 2]) {
      const { runs, result } = await attempt(stageOf(env, { facts: 'fail' }), { counters: { task_attempts: done } });
      assert.equal(result?.status, 'passed', `попытка ${done + 1}`);
      firsts.push(...runs);
    }
    assert.deepEqual(firsts, [mem(M1), 'agent-a', 'agent-b']);
    assert.match(lines(logger, 'SELECT_MODEL')[2], / pick="agent-b" level=1 free=false fallback=skipped:no_scores /);
    assert.deepEqual(readJsonLines(env.selectorLog), []);

    // Полный порядок попыток 1–3 (все падают без изменений) — как у стадии без selection.
    const expected = [
      [mem(M1), mem(M2), 'agent-a', 'agent-b', 'agent-c'],
      ['agent-a', 'agent-b', 'agent-c', mem(M1), mem(M2)],
      ['agent-b', 'agent-c', mem(M1), mem(M2), 'agent-a'],
    ];
    for (const done of [0, 1, 2]) {
      const governed = makeEnv();
      const plain = makeEnv();
      const plainStage = stageOf(plain);
      delete plainStage.selection;
      const got = await (await prepare(governed, agentsOf(governed))).attempt(stageOf(governed, { facts: 'fail' }), { counters: { task_attempts: done } });
      const want = await (await prepare(plain, agentsOf(plain))).attempt(plainStage, { counters: { task_attempts: done } });
      assert.deepEqual(want.runs, expected[done], `курсор, попытка ${done + 1}`);
      assert.deepEqual(got.runs, expected[done], `без оценок, попытка ${done + 1}`);
    }
  });

  test('команда фактов получает {id, host} моделей кандидатов, пулы — участниками; строка FACTS', async () => {
    const env = makeEnv();
    const { logger, attempt } = await prepare(env, agentsOf(env));
    await attempt(stageOf(env));
    const calls = readJsonLines(env.factsLog);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], [M1, M2, A, B, C].map((id) => ({ id, host: null })));
    assert.deepEqual(lines(logger, 'FACTS'), [
      'INFO FACTS stage="execute-task" candidates=5 scored=5 free=2 as_of="2026-09-01T00:00:00Z" citation="Source: test bench" '
        + `[${mem(M1)}=20/free(kilo)~${M1}-20260101, ${mem(M2)}=40/free(kilo)~${M2}-20260101, agent-a=10/paid(unknown)~${A}-20260101, `
        + `agent-b=30/paid(unknown)~${B}-20260101, agent-c=50/paid(unknown)~${C}-20260101]`,
    ]);
  });
});

describe('журнал и строки лога', () => {
  test('запуски стадии с выбором несут поля выбора; SELECT_MODEL', async () => {
    const env = makeEnv();
    setMode(env, { kind: 'answer', level: 2, ranking: [mem(M1)] });
    const { logger, attempt } = await prepare(env, agentsOf(env));
    const { events } = await attempt(stageOf(env));
    const pick = ({ selection, level, levels, required_level, floor_level, score, free }) => ({ selection, level, levels, required_level, floor_level, score, free });
    assert.deepEqual(pick(events[0]), { selection: 'selector', level: 2, levels: 5, required_level: 2, floor_level: 0, score: 20, free: true });
    assert.deepEqual(pick(events[2]), { selection: 'selector', level: 3, levels: 5, required_level: 2, floor_level: 0, score: 30, free: false });
    const select = lines(logger, 'SELECT_MODEL');
    assert.equal(select.length, 1);
    assert.match(select[0], new RegExp(
      '^INFO SELECT_MODEL stage="execute-task" selector="sel-stage" candidates=5 levels=5 range=10\\.\\.50 floor=0 '
        + `required_level=2 ranked=1 pick="pool-x@prov/vendor-p/m-1:free" level=2 free=true fallback=none cost_usd=0\\.0002 duration_ms=\\d+$`,
    ));
  });

  test('лестница пишет selection: ladder и required_level: null', async () => {
    const env = makeEnv();
    setMode(env, { kind: 'exit1' });
    const { attempt } = await prepare(env, agentsOf(env));
    const { events } = await attempt(stageOf(env));
    assert.equal(events[0].selection, 'ladder');
    assert.equal(events[0].required_level, null);
  });

  test('стадия без selection и тип с selection: false — события без полей выбора, прежний курсор', async () => {
    const plain = (env) => {
      const stage = stageOf(env);
      delete stage.selection;
      return stage;
    };
    const optOut = (env) => stageOf(env, { extra: { agents_by_type: { impl: { selection: false } } } });
    for (const make of [plain, optOut]) {
      // Свой проект на каждую стадию: сбои первой дали бы запреты моделей второй.
      const env = makeEnv();
      const { logger, attempt } = await prepare(env, agentsOf(env));
      const { events, runs } = await attempt(make(env), { counters: { task_attempts: 1 } });
      // Курсор попытки 2 — место agent-a; пул не на первом месте.
      assert.equal(runs[0], 'agent-a', runs.join(', '));
      assert.ok(logger.lines.includes('INFO Agent selected: agent-a (attempt 2, compatible=[pool-x, agent-a, agent-b, agent-c])'));
      for (const e of events) {
        for (const key of ['selection', 'level', 'levels', 'required_level', 'floor_level', 'score', 'free']) {
          assert.ok(!Object.hasOwn(e, key), `поле ${key} у события ${e.agent}`);
        }
      }
      assert.deepEqual(lines(logger, 'SELECT_MODEL'), []);
      assert.deepEqual(lines(logger, 'FACTS'), []);
      assert.deepEqual(readJsonLines(env.selectorLog), []);
    }
  });
});
