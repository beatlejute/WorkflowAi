/**
 * Оценки участников пула и агент-селектор (PLAN-004, задачи 37–39): команда
 * `models.scores` при раскрытии пула (src/lib/model-pools.mjs, expandModelPools) и
 * выбор участника агентом `models.selector` (StageExecutor.executeWithFallback,
 * src/runner.mjs).
 *
 * Что охраняется:
 *  describe «оценки пула» (задача 38):
 *   - у пула с `selector` и `scores` команда оценок получает на stdin полные id
 *     участников, в лог — строка `SCORES agent="<пул>" scored=<k>/<N> as_of="…" citation="…"`,
 *     оценки доступны выбору участника (poolSelectorData);
 *   - сбой команды (выход ≠ 0, не JSON) — `scored=0/<N> (<причина>)`, раскрытие не падает,
 *     кандидаты без оценок;
 *   - одинаковая команда оценок у двух пулов — один запуск, на stdin id обоих пулов;
 *   - пул без участников — команда оценок не запускается.
 *  describe «селектор пула» (задача 39):
 *   - промпт — JSON-блок: пул, тикет (тип, заголовок из frontmatter, DoD не длиннее
 *     4000 символов с пометкой обрезки), кандидаты со способностями, note и оценками
 *     (`null` без оценки), атрибуция оценок;
 *   - ответ `ranking: <3-й>, <1-й>` — запускается третий, при его неудаче с пустым diff —
 *     первый, без второго вызова; вызов — один на место пула в попытке, в следующей
 *     попытке — новый;
 *   - исходы строки `SELECT`: none, unknown_id, error, timeout; кроме none — порядок маски;
 *   - здоровье селектора: `error_class: auth` — 1 ч, таймаут — 5 мин, снятие по своему
 *     правилу health — класс и TTL правила; `error_class` с именем свойства прототипа
 *     (`constructor`) не помечает; нездоровый селектор не вызывается;
 *   - один кандидат или нет тикета в контексте — вызова нет; кандидатов не больше 10;
 *     пул в списке дважды — один вызов на попытку.
 *
 * Фейковые команды списка и оценок, агент-селектор и участники — node-скрипты во
 * временном каталоге ОС. Команда оценок и селектор дописывают вызов (stdin / промпт) в
 * файл журнала вызовов, по нему считается число вызовов. Участники и агент-b выходят с
 * кодом 1 без изменений (пустой diff): стадия переходит к следующему кандидату попытки.
 * Порядок запусков — `agent` событий run журнала `.workflow/metrics/agent-runs.jsonl`
 * временного проекта. Корень снимается в afterEach. Имена моделей и агентов — нейтральные.
 *
 * Запуск: node --import ./src/tests/_rails-home.mjs --test src/tests/model-pools-selector.test.mjs
 */

import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { StageExecutor } from '../runner.mjs';
import { expandModelPools, poolSelectorData } from '../lib/model-pools.mjs';
import { readRunEvents } from '../lib/agent-runs.mjs';

const TEMPS = [];
afterEach(() => {
  for (const dir of TEMPS.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// Команда списка: печатает свои аргументы, по одному на строку.
const LIST_SCRIPT = `process.stdout.write(process.argv.slice(2).join('\\n') + '\\n');\n`;

// Команда оценок: <режим> <журнал вызовов>. stdin (id участников) дописывается в журнал
// одной JSON-строкой. ok — оценки m-1 и m-3 (и чужого id), fail — выход 1, bad — не JSON.
const SCORES_SCRIPT = `
const fs = require('fs');
const [mode, log] = process.argv.slice(2);
let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  fs.appendFileSync(log, JSON.stringify(input.split(/\\r?\\n/).filter(Boolean)) + '\\n');
  if (mode === 'fail') { process.stderr.write('scores failed: boom\\n'); process.exit(1); }
  if (mode === 'bad') { process.stdout.write('not json at all\\n'); return; }
  process.stdout.write(JSON.stringify({
    as_of: '2026-09-01T00:00:00Z',
    citation: 'Source: test bench',
    scores: {
      'prov/vendor/m-1': { intelligence: 10, coding: 20, agentic: 30 },
      'prov/vendor/m-3': { intelligence: null, coding: 40, agentic: null },
      'prov/unlisted/z-1': { intelligence: 1, coding: 1, agentic: 1 },
    },
  }) + '\\n');
});
`;

// Агент-селектор: <режим> <журнал вызовов>. Промпт (stdin) дописывается в журнал.
//  rank:<id>,<id> — ранжир; error-auth — status: error, error_class: auth и выход 1;
//  error-proto — status: error с error_class, совпадающим с именем свойства прототипа;
//  rule-hit — строка правила health селектора в stderr и зависание;
//  exit1 — выход 1 без RESULT; hang — висит.
const SELECTOR_SCRIPT = `
const fs = require('fs');
const [mode, log] = process.argv.slice(2);
let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  fs.appendFileSync(log, JSON.stringify({ prompt: input }) + '\\n');
  const out = (lines) => process.stdout.write(['---RESULT---', ...lines, '---RESULT---'].join('\\n') + '\\n');
  if (mode.startsWith('rank:')) {
    out(['ranking: ' + mode.slice(5).split(',').join(', '), 'confidence: 0.8', 'cost_usd: 0.0001', 'reason: test']);
  } else if (mode === 'error-auth') {
    out(['status: error', 'error_class: auth', 'error: key rejected']);
    process.exit(1);
  } else if (mode === 'error-proto') {
    out(['status: error', 'error_class: constructor', 'error: odd class']);
    process.exit(1);
  } else if (mode === 'rule-hit') {
    process.stderr.write('selector fatal marker line\\n');
    setInterval(() => {}, 1000);
    setTimeout(() => process.exit(0), 20000);
  } else if (mode === 'exit1') {
    process.stderr.write('selector crashed\\n');
    process.exit(1);
  } else if (mode === 'hang') {
    setInterval(() => {}, 1000);
    setTimeout(() => process.exit(0), 20000);
  } else {
    process.exit(2);
  }
});
`;

// Участник и агент-b: выход 1 без изменений и без RESULT.
const FAIL_AGENT = `process.exit(1);\n`;

const DOD_ITEM = '- [ ] Нейтральный пункт критериев готовности для проверки обрезки текста DoD в промпте селектора\n';
const DOD_TEXT = DOD_ITEM.repeat(60);

function ticketText() {
  return [
    '---',
    'id: IMPL-1',
    'title: "Нейтральный заголовок тикета"',
    'type: impl',
    '---',
    '',
    '## Описание',
    '',
    'Текст описания.',
    '',
    '## Критерии готовности (Definition of Done)',
    '',
    DOD_TEXT,
    '## Заметки',
    '',
    'ХВОСТ-ЗАМЕТОК',
    '',
  ].join('\n');
}

function makeTemp() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'model-pools-selector-'));
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
  const ticketDir = path.join(root, '.workflow', 'tickets', 'in-progress');
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(path.join(ticketDir, 'IMPL-1.md'), ticketText());
  return {
    root,
    listScript: write('list-models.cjs', LIST_SCRIPT),
    scoresScript: write('scores.cjs', SCORES_SCRIPT),
    selectorScript: write('selector.cjs', SELECTOR_SCRIPT),
    failAgent: write('fail-agent.cjs', FAIL_AGENT),
    scoresLog: path.join(base, 'scores-calls.log'),
    selectorLog: path.join(base, 'selector-calls.log'),
  };
}

const M = (n) => `prov/vendor/m-${n}`;
const member = (n) => `pool-a@${M(n)}`;
const withNote = (n, note, caps) => JSON.stringify({ id: M(n), note, ...(caps ? { capabilities: caps } : {}) });

/**
 * Пул pool-a (маска `^prov/vendor/`) по строкам списка `lines`, агент-селектор
 * sel-agent в режиме `selector` и агент-b. `scores` — режим команды оценок или null.
 */
function agentsOf(env, lines, { selector = null, scores = 'ok', models = {} } = {}) {
  const agents = {
    'pool-a': {
      command: 'node',
      args: [env.failAgent, '--model', '{model}'],
      capabilities: ['text'],
      models: {
        list: ['node', env.listScript, ...lines],
        match: ['^prov/vendor/'],
        ...(selector ? { selector: 'sel-agent' } : {}),
        ...(selector && scores ? { scores: ['node', env.scoresScript, scores, env.scoresLog] } : {}),
        ...models,
      },
    },
    'agent-b': { command: 'node', args: [env.failAgent, '--model', 'prov/other/b'], capabilities: ['text'] },
  };
  if (selector) {
    agents['sel-agent'] = {
      command: 'node', args: [env.selectorScript, selector, env.selectorLog], prompt_stdin: true, capabilities: ['text'],
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

function readCalls(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function pipelineOf(agents) {
  return {
    name: 'model-pools-selector', version: '1.0', agents,
    execution: { artifact_snapshot_enabled: true, timeout_per_stage: 30 },
    stages: {}, entry: 'none', context: {},
  };
}

// Стадия без скила исполнителя: запрет модели за сбой (crash, 1 ч) действует только на
// стадии execute-task, и во второй попытке участники и агент-b были бы под запретом.
const NEUTRAL_SKILL = 'neutral-skill';

const executorStage = (agents, extra = {}) => ({
  agents, instructions: 'Выполни тикет', skill: 'execute-task', counter: 'task_attempts', ...extra,
});

/** Раскрытие пулов (один раз на «процесс») и функция прогона одной попытки стадии. */
async function prepare(root, agents) {
  const logger = captureLogger();
  const config = { pipeline: pipelineOf(agents) };
  await expandModelPools(config.pipeline, { projectRoot: root, logger });
  const attempt = async (stage, { context = { ticket_id: 'IMPL-1' }, counters = { task_attempts: 0 }, options = {} } = {}) => {
    const before = readRunEvents(root).length;
    const executor = new StageExecutor(config, context, counters, {}, null, logger, root, options);
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
  return { logger, config, attempt };
}

const scoresLines = (logger) => logger.lines.filter((l) => /\bSCORES agent=/.test(l));
const selectLines = (logger) => logger.lines.filter((l) => /\bSELECT agent=/.test(l));

function promptData(prompt) {
  const block = /```json\r?\n([\s\S]*?)\r?\n```/.exec(prompt);
  assert.ok(block, `в промпте нет JSON-блока:\n${prompt}`);
  return JSON.parse(block[1]);
}

function healthEntry(root, agentId) {
  const file = path.join(root, '.workflow', 'state', 'agent-health.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8')).agents?.[agentId] ?? null;
}

const THREE = [withNote(1, 'n1'), withNote(2, '', ['multimodal']), M(3)];

// ---------------------------------------------------------------------------

describe('оценки пула', () => {
  test('команда оценок получает id участников, строка SCORES, оценки доступны выбору участника', async () => {
    const env = makeTemp();
    const { logger, config } = await prepare(env.root, agentsOf(env, THREE, { selector: 'rank:x' }));

    assert.deepEqual(readCalls(env.scoresLog), [[M(1), M(2), M(3)]]);
    assert.deepEqual(scoresLines(logger), [
      'INFO SCORES agent="pool-a" scored=2/3 as_of="2026-09-01T00:00:00Z" citation="Source: test bench"',
    ]);
    const data = poolSelectorData(config.pipeline, 'pool-a', [member(1), member(2), member(3)]);
    assert.equal(data.citation, 'Source: test bench');
    assert.deepEqual(data.candidates, [
      { id: M(1), capabilities: ['text'], note: 'n1', scores: { intelligence: 10, coding: 20, agentic: 30 } },
      { id: M(2), capabilities: ['text', 'multimodal'], note: '', scores: null },
      { id: M(3), capabilities: ['text'], note: '', scores: { intelligence: null, coding: 40, agentic: null } },
    ]);
  });

  test('сбой команды оценок — scored=0/N с причиной, участники раскрыты, кандидаты без оценок', async () => {
    for (const mode of ['fail', 'bad']) {
      const env = makeTemp();
      const { logger, config } = await prepare(env.root, agentsOf(env, THREE, { selector: 'rank:x', scores: mode }));
      const lines = scoresLines(logger);
      assert.equal(lines.length, 1, logger.lines.join('\n'));
      assert.match(lines[0], /^INFO SCORES agent="pool-a" scored=0\/3 \(.+\)$/);
      if (mode === 'fail') assert.match(lines[0], /\(exit 1\)$/);
      assert.ok(logger.lines.some((l) => /POOL agent="pool-a" members=3 /.test(l)), logger.lines.join('\n'));
      const data = poolSelectorData(config.pipeline, 'pool-a', [member(1), member(3)]);
      assert.equal(data.citation, null);
      assert.deepEqual(data.candidates.map((c) => c.scores), [null, null]);
    }
  });

  test('одинаковая команда оценок у двух пулов — один запуск, на stdin id обоих пулов', async () => {
    const env = makeTemp();
    const agents = agentsOf(env, [M(1), M(2), 'prov/other/o-1'], { selector: 'rank:x' });
    agents['pool-b'] = structuredClone(agents['pool-a']);
    agents['pool-b'].models.match = ['^prov/other/'];
    const { logger } = await prepare(env.root, agents);

    const calls = readCalls(env.scoresLog);
    assert.equal(calls.length, 1, JSON.stringify(calls));
    assert.deepEqual([...calls[0]].sort(), [M(1), M(2), 'prov/other/o-1'].sort());
    assert.deepEqual(scoresLines(logger), [
      'INFO SCORES agent="pool-a" scored=1/2 as_of="2026-09-01T00:00:00Z" citation="Source: test bench"',
      'INFO SCORES agent="pool-b" scored=0/1 as_of="2026-09-01T00:00:00Z" citation="Source: test bench"',
    ]);
  });

  test('пул без участников — команда оценок не запускается', async () => {
    const env = makeTemp();
    const { logger } = await prepare(env.root, agentsOf(env, ['other/vendor/x-1'], { selector: 'rank:x' }));
    assert.deepEqual(readCalls(env.scoresLog), []);
    assert.deepEqual(scoresLines(logger), []);
  });
});

describe('селектор пула', () => {
  test('промпт: JSON-блок с пулом, тикетом, обрезанным DoD и кандидатами с оценками и null', async () => {
    const env = makeTemp();
    const { attempt } = await prepare(env.root, agentsOf(env, THREE, { selector: `rank:${M(3)},${M(1)}` }));
    await attempt(executorStage(['pool-a', 'agent-b']));

    const calls = readCalls(env.selectorLog);
    assert.equal(calls.length, 1);
    const { prompt } = calls[0];
    assert.match(prompt, /ranking:/);
    const data = promptData(prompt);
    assert.equal(data.pool, 'pool-a');
    assert.equal(data.ticket.id, 'IMPL-1');
    assert.equal(data.ticket.type, 'impl');
    assert.equal(data.ticket.title, 'Нейтральный заголовок тикета');
    assert.ok(DOD_TEXT.length > 4000, 'DoD фикстуры длиннее предела');
    assert.ok(data.ticket.dod.length <= 4000, `dod: ${data.ticket.dod.length} символов`);
    assert.ok(data.ticket.dod.endsWith('…'), 'обрезка с пометкой');
    assert.ok(data.ticket.dod.startsWith(DOD_ITEM.trim()), data.ticket.dod.slice(0, 200));
    assert.ok(!data.ticket.dod.includes('ХВОСТ-ЗАМЕТОК'));
    assert.deepEqual(data.candidates, [
      { id: M(1), capabilities: ['text'], note: 'n1', scores: { intelligence: 10, coding: 20, agentic: 30 } },
      { id: M(2), capabilities: ['text', 'multimodal'], note: '', scores: null },
      { id: M(3), capabilities: ['text'], note: '', scores: { intelligence: null, coding: 40, agentic: null } },
    ]);
    assert.equal(data.scores_citation, 'Source: test bench');
  });

  test('ранжир <3-й>, <1-й>: третий, затем первый без второго вызова, затем по маске; SELECT fallback=none', async () => {
    const env = makeTemp();
    const { logger, attempt } = await prepare(env.root, agentsOf(env, THREE, { selector: `rank:${M(3)},${M(1)}` }));
    const { runs, error } = await attempt(executorStage(['pool-a', 'agent-b']));

    assert.deepEqual(runs, [member(3), member(1), member(2), 'agent-b']);
    assert.ok(error, 'все кандидаты попытки упали — ошибка стадии');
    assert.equal(readCalls(env.selectorLog).length, 1, 'один вызов на место пула в попытке');
    const lines = selectLines(logger);
    assert.equal(lines.length, 1, logger.lines.join('\n'));
    assert.match(
      lines[0],
      /^INFO SELECT agent="pool-a" selector="sel-agent" candidates=3 ranked=2 member="prov\/vendor\/m-3" fallback=none cost_usd=0\.0001 duration_ms=\d+$/,
    );
    assert.ok(logger.lines.includes(`INFO Agent selected: ${member(3)} (attempt 1, compatible=[pool-a, agent-b])`));
  });

  test('в следующей попытке — новый вызов селектора', async () => {
    const env = makeTemp();
    const { attempt } = await prepare(env.root, agentsOf(env, THREE, { selector: `rank:${M(2)}` }));
    const stage = executorStage(['pool-a', 'agent-b'], { skill: NEUTRAL_SKILL });
    await attempt(stage);
    const second = await attempt(stage, { counters: { task_attempts: 1 } });
    assert.equal(readCalls(env.selectorLog).length, 2);
    assert.equal(second.runs[0], 'agent-b');
  });

  test('ranking без id кандидатов — порядок маски, fallback=unknown_id', async () => {
    const env = makeTemp();
    const { logger, attempt } = await prepare(env.root, agentsOf(env, THREE, { selector: 'rank:prov/elsewhere/q-1' }));
    const { runs } = await attempt(executorStage(['pool-a', 'agent-b']));
    assert.deepEqual(runs, [member(1), member(2), member(3), 'agent-b']);
    const lines = selectLines(logger);
    assert.equal(lines.length, 1);
    assert.match(lines[0], / candidates=3 ranked=0 member="prov\/vendor\/m-1" fallback=unknown_id cost_usd=0\.0001 duration_ms=\d+$/);
  });

  test('выход 1 — порядок маски, fallback=error; без error_class селектор не помечается', async () => {
    const env = makeTemp();
    const { logger, attempt } = await prepare(env.root, agentsOf(env, THREE, { selector: 'exit1' }));
    const { runs } = await attempt(executorStage(['pool-a', 'agent-b']));
    assert.deepEqual(runs, [member(1), member(2), member(3), 'agent-b']);
    const lines = selectLines(logger);
    assert.equal(lines.length, 1);
    assert.match(lines[0], / candidates=3 ranked=0 member="prov\/vendor\/m-1" fallback=error cost_usd=unknown duration_ms=\d+$/);
    assert.equal(healthEntry(env.root, 'sel-agent'), null);
  });

  test('status: error с error_class auth — fallback=error, селектор нездоров 1 ч', async () => {
    const env = makeTemp();
    const { logger, attempt } = await prepare(env.root, agentsOf(env, THREE, { selector: 'error-auth' }));
    const started = Date.now();
    const { runs } = await attempt(executorStage(['pool-a', 'agent-b']));
    assert.deepEqual(runs, [member(1), member(2), member(3), 'agent-b']);
    assert.match(selectLines(logger)[0], / fallback=error /);
    const entry = healthEntry(env.root, 'sel-agent');
    assert.ok(entry, 'селектор помечен в health-реестре');
    assert.equal(entry.class, 'misconfigured');
    const until = Date.parse(entry.until);
    assert.ok(until >= started + 59 * 60 * 1000 && until <= Date.now() + 61 * 60 * 1000, entry.until);
    assert.equal(healthEntry(env.root, 'pool-a'), null);
  });

  test('зависание — fallback=timeout, селектор нездоров 5 мин и не вызывается в следующей попытке', async () => {
    const env = makeTemp();
    const { logger, attempt } = await prepare(env.root, agentsOf(env, THREE, { selector: 'hang' }));
    const options = { selectorTimeoutMs: 800 };
    const started = Date.now();
    const stage = executorStage(['pool-a', 'agent-b'], { skill: NEUTRAL_SKILL });
    const first = await attempt(stage, { options });
    assert.deepEqual(first.runs, [member(1), member(2), member(3), 'agent-b']);
    const lines = selectLines(logger);
    assert.equal(lines.length, 1);
    assert.match(lines[0], / candidates=3 ranked=0 member="prov\/vendor\/m-1" fallback=timeout cost_usd=unknown duration_ms=\d+$/);
    assert.ok(!logger.lines.some((l) => /TIMEOUT stage=/.test(l)), 'таймаут селектора — не таймаут стадии');
    const entry = healthEntry(env.root, 'sel-agent');
    assert.ok(entry, 'селектор помечен в health-реестре');
    assert.equal(entry.class, 'transient');
    const until = Date.parse(entry.until);
    assert.ok(until >= started + 4 * 60 * 1000 && until <= Date.now() + 6 * 60 * 1000, entry.until);

    const second = await attempt(stage, { counters: { task_attempts: 1 }, options });
    assert.equal(readCalls(env.selectorLog).length, 1, 'нездоровый селектор не вызывается');
    assert.equal(selectLines(logger).length, 1);
    assert.equal(second.runs.length, 4);
  });

  test('один кандидат — вызова нет', async () => {
    const env = makeTemp();
    const { logger, attempt } = await prepare(env.root, agentsOf(env, [M(1)], { selector: `rank:${M(1)}` }));
    const { runs } = await attempt(executorStage(['pool-a', 'agent-b']));
    assert.deepEqual(runs, [member(1), 'agent-b']);
    assert.deepEqual(readCalls(env.selectorLog), []);
    assert.deepEqual(selectLines(logger), []);
  });

  test('нет тикета в контексте — вызова нет, порядок маски', async () => {
    const env = makeTemp();
    const { attempt } = await prepare(env.root, agentsOf(env, THREE, { selector: `rank:${M(3)}` }));
    const { runs } = await attempt(executorStage(['pool-a', 'agent-b']), { context: {} });
    assert.deepEqual(runs, [member(1), member(2), member(3), 'agent-b']);
    assert.deepEqual(readCalls(env.selectorLog), []);
  });

  test('кандидатов больше 10 — селектору первые 10 по маске', async () => {
    const env = makeTemp();
    const twelve = Array.from({ length: 12 }, (_, i) => M(i + 1));
    const { logger, attempt } = await prepare(env.root, agentsOf(env, twelve, {
      selector: `rank:${M(2)}`, models: { max_per_attempt: 1 },
    }));
    const { runs } = await attempt(executorStage(['pool-a', 'agent-b']));
    assert.deepEqual(runs, [member(2), 'agent-b']);
    const data = promptData(readCalls(env.selectorLog)[0].prompt);
    assert.deepEqual(data.candidates.map((c) => c.id), twelve.slice(0, 10));
    assert.match(selectLines(logger)[0], / candidates=10 ranked=1 member="prov\/vendor\/m-2" fallback=none /);
  });

  test('пул в списке дважды — один вызов селектора на попытку', async () => {
    const env = makeTemp();
    const { logger, attempt } = await prepare(env.root, agentsOf(env, THREE, { selector: `rank:${M(3)},${M(1)}` }));
    const { runs } = await attempt(executorStage(['pool-a', 'agent-b', 'pool-a']));
    assert.deepEqual(runs, [member(3), member(1), member(2), 'agent-b']);
    assert.equal(readCalls(env.selectorLog).length, 1);
    assert.equal(selectLines(logger).length, 1, logger.lines.join('\n'));
  });

  // error_class — текст из ответа селектора: имя свойства прототипа объекта не должно
  // найтись в таблице классов, помечающих селектора.
  test('status: error с error_class «constructor» — fallback=error, селектор не помечается', async () => {
    const env = makeTemp();
    const { logger, attempt } = await prepare(env.root, agentsOf(env, THREE, { selector: 'error-proto' }));
    const { runs } = await attempt(executorStage(['pool-a', 'agent-b']));
    assert.deepEqual(runs, [member(1), member(2), member(3), 'agent-b']);
    assert.match(selectLines(logger)[0], / fallback=error /);
    assert.equal(healthEntry(env.root, 'sel-agent'), null);
  });

  test('селектор снят своим правилом health — fallback=error, помечен на TTL правила', async () => {
    const env = makeTemp();
    fs.mkdirSync(path.join(env.root, '.workflow', 'config'), { recursive: true });
    fs.writeFileSync(path.join(env.root, '.workflow', 'config', 'agent-health-rules.yaml'), [
      'version: "1.0"',
      'agents:',
      '  sel-agent:',
      '    rules:',
      '      - id: "selector-fatal-marker"',
      '        class: "unavailable"',
      '        ttl: "15m"',
      '        pattern: "selector fatal marker line"',
      '        exit_codes: "any"',
      '',
    ].join('\n'));
    const { logger, attempt } = await prepare(env.root, agentsOf(env, THREE, { selector: 'rule-hit' }));
    const started = Date.now();
    const { runs } = await attempt(executorStage(['pool-a', 'agent-b']));

    assert.ok(Date.now() - started < 15000, 'селектор снят онлайн-сканом, а не таймаутом 60 с');
    assert.deepEqual(runs, [member(1), member(2), member(3), 'agent-b']);
    assert.match(selectLines(logger)[0], / fallback=error /);
    const entry = healthEntry(env.root, 'sel-agent');
    assert.ok(entry, 'селектор помечен в health-реестре');
    assert.equal(entry.class, 'unavailable');
    assert.equal(entry.rule_id, 'selector-fatal-marker');
    const until = Date.parse(entry.until);
    assert.ok(until >= started + 14 * 60 * 1000 && until <= Date.now() + 16 * 60 * 1000, entry.until);
  });
});
