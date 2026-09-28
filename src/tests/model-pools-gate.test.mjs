/**
 * Шлагбаум пула моделей (PLAN-004, задачи 43–44, П14): команда `models.gate` перед
 * каждым запуском участника пула, до селектора (StageExecutor.executeWithFallback,
 * src/runner.mjs). Раздел плана «Справочные данные» → «Шлагбаум пула».
 *
 * Что охраняется:
 *   - `status: open` — участник запускается, строка `GATE agent="<пул>" status=open …`;
 *     шлагбаум вызывается перед каждым запуском участника, до селектора;
 *   - `status: closed` — участники пула и селектор не запускаются, стадия берёт агента
 *     следующего места; место закрыто до ближайших 00:00 UTC: повторный выбор шлагбаум
 *     не вызывает, после полуночи — вызывает снова; пул в списке дважды — закрыты оба места;
 *   - выход 1 и зависание дольше таймаута — `status=error`, WARN, участник запускается;
 *   - у пула без `gate` строки GATE нет;
 *   - `closed`, а запись health-реестра не удалась — место закрыто в этой попытке
 *     (страховка executeWithFallback), шлагбаум вызван один раз;
 *   - остановка пайплайна (killCurrentChild) снимает запущенный шлагбаум сразу, а
 *     остановка, пришедшая за время шлагбаума, не запускает селектора и участников.
 *
 * Фейковые команды списка и шлагбаума, агент-селектор и участники — node-скрипты во
 * временном каталоге ОС. Шлагбаум и селектор дописывают свой вызов в общий журнал
 * вызовов — по нему проверяются число и порядок вызовов. Участники и агент-b выходят с
 * кодом 1 без изменений (пустой diff). Полночь UTC подставляется часами теста: запись
 * закрытия в health-реестре временного проекта переводится в прошлое. Корень снимается
 * в afterEach. Имена моделей и агентов — нейтральные.
 *
 * Запуск: node --import ./src/tests/_rails-home.mjs --test src/tests/model-pools-gate.test.mjs
 */

import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { StageExecutor } from '../runner.mjs';
import { expandModelPools } from '../lib/model-pools.mjs';
import { readRunEvents } from '../lib/agent-runs.mjs';

const TEMPS = [];
afterEach(() => {
  for (const dir of TEMPS.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// Команда списка: печатает свои аргументы, по одному на строку.
const LIST_SCRIPT = `process.stdout.write(process.argv.slice(2).join('\\n') + '\\n');\n`;

// Шлагбаум: <режим> <журнал вызовов>. open — remaining 7, closed — remaining 0,
// exit1 — выход 1, nostatus — RESULT без status, hang — висит.
const GATE_SCRIPT = `
const fs = require('fs');
const [mode, log] = process.argv.slice(2);
fs.appendFileSync(log, 'gate\\n');
const out = (lines) => process.stdout.write(['---RESULT---', ...lines, '---RESULT---'].join('\\n') + '\\n');
if (mode === 'open') out(['status: open', 'remaining: 7']);
else if (mode === 'closed') out(['status: closed', 'remaining: 0']);
else if (mode === 'nostatus') out(['remaining: 3']);
else if (mode === 'exit1') { process.stderr.write('gate failed: boom\\n'); process.exit(1); }
else if (mode === 'hang') { setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 20000); }
else process.exit(2);
`;

// Агент-селектор: <ранжир через запятую> <журнал вызовов>.
const SELECTOR_SCRIPT = `
const fs = require('fs');
const [ranking, log] = process.argv.slice(2);
let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  fs.appendFileSync(log, 'selector\\n');
  process.stdout.write(['---RESULT---', 'ranking: ' + ranking.split(',').join(', '), 'cost_usd: 0.0001', '---RESULT---'].join('\\n') + '\\n');
});
`;

// Участник и агент-b: выход 1 без изменений и без RESULT.
const FAIL_AGENT = `process.exit(1);\n`;

function makeTemp() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'model-pools-gate-'));
  TEMPS.push(base);
  const root = path.join(base, 'project');
  const tools = path.join(base, 'tools');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(tools, { recursive: true });
  const write = (name, text) => {
    const file = path.join(tools, name);
    fs.writeFileSync(file, text);
    return file;
  };
  return {
    root,
    listScript: write('list-models.cjs', LIST_SCRIPT),
    gateScript: write('gate.cjs', GATE_SCRIPT),
    selectorScript: write('selector.cjs', SELECTOR_SCRIPT),
    failAgent: write('fail-agent.cjs', FAIL_AGENT),
    callsLog: path.join(base, 'calls.log'),
  };
}

const M = (n) => `prov/vendor/m-${n}`;
const member = (n) => `pool-a@${M(n)}`;
const THREE = [M(1), M(2), M(3)];

/** Пул pool-a со шлагбаумом в режиме `gate` (null — без шлагбаума), селектор по желанию, агент-b. */
function agentsOf(env, { gate = 'open', ranking = null, models = {} } = {}) {
  const agents = {
    'pool-a': {
      command: 'node',
      args: [env.failAgent, '--model', '{model}'],
      capabilities: ['text'],
      models: {
        list: ['node', env.listScript, ...THREE],
        match: ['^prov/vendor/'],
        ...(gate ? { gate: ['node', env.gateScript, gate, env.callsLog] } : {}),
        ...(ranking ? { selector: 'sel-agent' } : {}),
        ...models,
      },
    },
    'agent-b': { command: 'node', args: [env.failAgent, '--model', 'prov/other/b'], capabilities: ['text'] },
  };
  if (ranking) {
    agents['sel-agent'] = {
      command: 'node', args: [env.selectorScript, ranking, env.callsLog], prompt_stdin: true, capabilities: ['text'],
    };
  }
  return agents;
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

function calls(env) {
  return fs.existsSync(env.callsLog) ? fs.readFileSync(env.callsLog, 'utf8').split('\n').filter(Boolean) : [];
}

// Стадия без скила исполнителя: запрет модели за сбой (crash, 1 ч) действует только на
// стадии execute-task, и в следующей попытке агент-b был бы под запретом.
const stageOf = (agents) => ({
  agents, instructions: 'Выполни тикет', skill: 'neutral-skill', counter: 'task_attempts',
});

/** Раскрытие пулов (один раз на «процесс») и функция прогона одной попытки стадии. */
async function prepare(root, agents) {
  const logger = captureLogger();
  const config = {
    pipeline: {
      name: 'model-pools-gate', version: '1.0', agents,
      execution: { artifact_snapshot_enabled: true, timeout_per_stage: 30 },
      stages: {}, entry: 'none', context: {},
    },
  };
  await expandModelPools(config.pipeline, { projectRoot: root, logger });
  const attempt = async (stage, { counters = { task_attempts: 0 }, options = {}, onExecutor = null } = {}) => {
    const before = readRunEvents(root).length;
    const executor = new StageExecutor(config, { ticket_id: 'IMPL-1' }, counters, {}, null, logger, root, options);
    onExecutor?.(executor);
    let result = null;
    let error = null;
    try {
      result = await executor.executeWithFallback('execute-task', stage);
    } catch (err) {
      error = err;
    }
    const runs = readRunEvents(root).slice(before).filter((e) => e.type === 'run').map((e) => e.agent);
    return { result, error, runs };
  };
  return { logger, attempt };
}

const gateLines = (logger) => logger.lines.filter((l) => /\bGATE agent=/.test(l));
const selectLines = (logger) => logger.lines.filter((l) => /\bSELECT agent=/.test(l));

function healthFile(root) {
  return path.join(root, '.workflow', 'state', 'agent-health.json');
}

function healthEntry(root, agentId) {
  const file = healthFile(root);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8')).agents?.[agentId] ?? null;
}

/** Ближайшие 00:00 UTC после `ms`, но не раньше чем через 30 мин (TTL until_utc_midnight). */
function nextUtcMidnight(ms) {
  const midnight = new Date(ms);
  midnight.setUTCHours(24, 0, 0, 0);
  return Math.max(midnight.getTime(), ms + 30 * 60 * 1000);
}

// ---------------------------------------------------------------------------

describe('шлагбаум пула', () => {
  test('open — участник запускается; шлагбаум перед каждым запуском участника, до селектора', async () => {
    const env = makeTemp();
    const { logger, attempt } = await prepare(env.root, agentsOf(env, {
      ranking: `${M(2)},${M(1)}`, models: { max_per_attempt: 2 },
    }));
    const { runs } = await attempt(stageOf(['pool-a', 'agent-b']));

    assert.deepEqual(runs, [member(2), member(1), 'agent-b']);
    assert.deepEqual(calls(env), ['gate', 'selector', 'gate']);
    const lines = gateLines(logger);
    assert.equal(lines.length, 2, logger.lines.join('\n'));
    for (const line of lines) {
      assert.match(line, /^INFO GATE agent="pool-a" status=open remaining=7 until=- duration_ms=\d+$/);
    }
  });

  test('closed — ни участников, ни селектора, запускается агент-b; место закрыто до 00:00 UTC', async () => {
    const env = makeTemp();
    const { logger, attempt } = await prepare(env.root, agentsOf(env, { gate: 'closed', ranking: `${M(2)},${M(1)}` }));
    const t0 = Date.now();
    const first = await attempt(stageOf(['pool-a', 'agent-b']));
    const t1 = Date.now();

    assert.deepEqual(first.runs, ['agent-b']);
    assert.deepEqual(calls(env), ['gate'], 'селектор не вызывается');
    const lines = gateLines(logger);
    assert.equal(lines.length, 1, logger.lines.join('\n'));
    const m = /^INFO GATE agent="pool-a" status=closed remaining=0 until=(\S+) duration_ms=\d+$/.exec(lines[0]);
    assert.ok(m, lines[0]);
    const until = Date.parse(m[1]);
    assert.ok(until >= nextUtcMidnight(t0) && until <= nextUtcMidnight(t1), `until=${m[1]}`);
    const entry = healthEntry(env.root, 'pool-a');
    assert.ok(entry, 'закрытие места записано в health-реестр по id пула');
    assert.ok(Date.parse(entry.until) >= nextUtcMidnight(t0) && Date.parse(entry.until) <= nextUtcMidnight(t1), entry.until);

    // До полуночи повторный выбор шлагбаум не вызывает.
    const second = await attempt(stageOf(['pool-a', 'agent-b']), { counters: { task_attempts: 1 } });
    assert.deepEqual(second.runs, ['agent-b']);
    assert.deepEqual(calls(env), ['gate']);

    // Часы теста: полночь прошла — шлагбаум вызывается снова.
    const data = JSON.parse(fs.readFileSync(healthFile(env.root), 'utf8'));
    data.agents['pool-a'].until = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(healthFile(env.root), JSON.stringify(data, null, 2));
    const third = await attempt(stageOf(['pool-a', 'agent-b']));
    assert.deepEqual(third.runs, ['agent-b']);
    assert.deepEqual(calls(env), ['gate', 'gate']);
  });

  test('closed — пул в списке дважды: закрыты оба места', async () => {
    const env = makeTemp();
    const { attempt } = await prepare(env.root, agentsOf(env, { gate: 'closed' }));
    const { runs } = await attempt(stageOf(['pool-a', 'agent-b', 'pool-a']));
    assert.deepEqual(runs, ['agent-b']);
    assert.deepEqual(calls(env), ['gate']);
  });

  test('выход 1, зависание и ответ без status — status=error, WARN, участник запускается', async () => {
    for (const mode of ['exit1', 'hang', 'nostatus']) {
      const env = makeTemp();
      const { logger, attempt } = await prepare(env.root, agentsOf(env, { gate: mode, models: { max_per_attempt: 1 } }));
      const { runs } = await attempt(stageOf(['pool-a', 'agent-b']), { options: { gateTimeoutMs: 700 } });

      assert.deepEqual(runs, [member(1), 'agent-b'], mode);
      assert.deepEqual(calls(env), ['gate'], mode);
      const lines = gateLines(logger);
      assert.equal(lines.length, 1, logger.lines.join('\n'));
      assert.match(lines[0], /^INFO GATE agent="pool-a" status=error remaining=(unknown|3) until=- duration_ms=\d+$/, mode);
      assert.ok(logger.lines.some((l) => l.startsWith('WARN ') && l.includes('pool-a') && /gate/i.test(l)), logger.lines.join('\n'));
      if (mode === 'hang') assert.ok(logger.lines.some((l) => l.startsWith('WARN ') && l.includes('timeout 700ms')), mode);
      assert.equal(healthEntry(env.root, 'pool-a'), null, `${mode}: сбой шлагбаума место не закрывает`);
    }
  });

  test('пул без gate — строки GATE нет, участники запускаются', async () => {
    const env = makeTemp();
    const { logger, attempt } = await prepare(env.root, agentsOf(env, { gate: null, models: { max_per_attempt: 1 } }));
    const { runs } = await attempt(stageOf(['pool-a', 'agent-b']));
    assert.deepEqual(runs, [member(1), 'agent-b']);
    assert.deepEqual(gateLines(logger), []);
    assert.deepEqual(calls(env), []);
  });

  // Страховка executeWithFallback: закрытие не записалось в health-реестр — id пула в
  // excludeAgents всё равно закрывает место в этой попытке, иначе цикл выбирал бы его снова.
  test('closed, запись health-реестра не удалась — WARN, место закрыто в попытке, шлагбаум вызван один раз', async () => {
    const env = makeTemp();
    const { logger, attempt } = await prepare(env.root, agentsOf(env, { gate: 'closed', ranking: `${M(2)},${M(1)}` }));
    // Временный файл атомарной записи реестра занят каталогом — запись падает.
    fs.mkdirSync(`${healthFile(env.root)}.tmp`, { recursive: true });
    const { runs } = await attempt(stageOf(['pool-a', 'agent-b']));

    assert.deepEqual(runs, ['agent-b']);
    assert.deepEqual(calls(env), ['gate'], 'шлагбаум — один раз, селектор не вызывается');
    assert.ok(logger.lines.some((l) => l.startsWith('WARN ') && l.includes('health mark failed for pool-a')), logger.lines.join('\n'));
    assert.match(gateLines(logger)[0], /status=closed remaining=0 /);
  });
});

describe('остановка во время шлагбаума', () => {
  test('остановка во время зависшего шлагбаума — шлагбаум снят сразу, селектор и участники не запускаются', async () => {
    const env = makeTemp();
    const { logger, attempt } = await prepare(env.root, agentsOf(env, { gate: 'hang', ranking: `${M(2)},${M(1)}` }));
    let poll = null;
    const started = Date.now();
    try {
      const { result, error, runs } = await attempt(stageOf(['pool-a', 'agent-b']), {
        // Остановка — когда шлагбаум уже запущен (записал свой вызов).
        onExecutor: (executor) => {
          poll = setInterval(() => {
            if (calls(env).includes('gate')) {
              clearInterval(poll);
              executor.killCurrentChild();
            }
          }, 50);
        },
      });
      const elapsed = Date.now() - started;

      assert.ok(elapsed < 8000, `шлагбаум снят остановкой, а не своим таймаутом 15 с: ${elapsed} мс`);
      assert.equal(result, null);
      assert.equal(error?.code, 'STOPPED', String(error));
      assert.deepEqual(runs, [], 'участники не запускались');
      assert.deepEqual(calls(env), ['gate'], 'селектор не вызывается');
      assert.deepEqual(selectLines(logger), []);
      assert.match(gateLines(logger)[0] ?? '', /status=error remaining=unknown until=- /, logger.lines.join('\n'));
      assert.equal(healthEntry(env.root, 'pool-a'), null, 'снятый шлагбаум место не закрывает');
    } finally {
      clearInterval(poll);
    }
  });

  test('остановка пришла, когда шлагбаум уже ответил open, — селектор не вызывается, стадия остановлена', async () => {
    const env = makeTemp();
    const { logger, attempt } = await prepare(env.root, agentsOf(env, { gate: 'open', ranking: `${M(2)},${M(1)}` }));
    // Остановка — в момент строки GATE: шлагбаум ответил, селектор ещё не запущен.
    let executor = null;
    const info = logger.info;
    logger.info = (message) => {
      info(message);
      if (/\bGATE agent=/.test(message)) executor?.killCurrentChild();
    };
    const { error, runs } = await attempt(stageOf(['pool-a', 'agent-b']), { onExecutor: (e) => { executor = e; } });

    assert.equal(error?.code, 'STOPPED', String(error));
    assert.deepEqual(runs, []);
    assert.deepEqual(calls(env), ['gate'], 'селектор не вызывается');
    assert.deepEqual(selectLines(logger), []);
  });
});
