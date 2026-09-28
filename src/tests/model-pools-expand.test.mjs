/**
 * Раскрытие пулов моделей (PLAN-004, задачи 16–18): модуль src/lib/model-pools.mjs
 * (expandModelPools) и его вызов из PipelineRunner.run.
 *
 * Пул — запись агента с полем `models`: команда `models.list` печатает модели, по
 * одной на строку (JSON `{"id", "capabilities", "note"}` или голый id), маска
 * `models.match` отбирает участников и задаёт их порядок. Участник регистрируется в
 * общем `pipeline.agents` под id `<пул>@<полный id>` — копией записи пула с полным id
 * на месте `{model}`. Раздел плана «Справочные данные» → «Раскрытие пула»,
 * «Команда списка: интерфейс stdout», «Участник пула».
 *
 * Что охраняется:
 *  describe «раскрытие пула» (задача 17):
 *   - порядок участников — по индексу первого совпавшего выражения `match`, при
 *     равенстве — по выводу команды; строка `POOL` с id и `note`;
 *   - испорченная строка, строка без строкового id и id с недопустимым символом —
 *     WARN и пропуск; повтор id — первое вхождение;
 *   - одинаковая команда списка у двух пулов запускается один раз (П7);
 *   - сбои — `members=0 (<причина>)`: exit, timeout, spawn error, no match;
 *   - PipelineRunner.run на конфиге с пулом пишет в лог одну строку `POOL`;
 *   - остановка (signal, сигнал раннера) снимает команду списка — `members=0 (aborted)`,
 *     стадии после неё не запускаются.
 *  describe «участники пула» (задача 18):
 *   - запись участника: копия пула, `{model}` заменён полным id, без `models`,
 *     `pool: <пул>`, способности — объединение пула и строки списка;
 *   - ключ модели участника (configuredModelKey) у kilo-пула — id без провайдера;
 *   - два пула с одним массивом `args` (якорь YAML) — массив после раскрытия не
 *     изменён, у каждого участника свой массив;
 *   - агент конфига с id участника не перезаписывается: WARN, модель пропущена.
 *
 * Фейковая команда списка — node-скрипт во временном каталоге ОС; корень снимается в
 * afterEach. Имена моделей и агентов — нейтральные.
 *
 * Запуск: node --import ./src/tests/_rails-home.mjs --test src/tests/model-pools-expand.test.mjs
 */

import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import yaml from '../lib/js-yaml.mjs';
import { expandModelPools, runPoolCommand, formatTimeout } from '../lib/model-pools.mjs';
import { configuredModelKey } from '../lib/agent-runs.mjs';
import { PipelineRunner } from '../runner.mjs';

const TEMPS = [];
afterEach(() => {
  for (const dir of TEMPS.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// Фейковая команда списка. Режим — первый аргумент:
//  mixed — JSON- и plain-строки, испорченные строки, повтор, id с пробелом;
//  count <файл> — дописывает «x» в файл-счётчик и печатает два id;
//  fail — stderr и выход 1; hang — висит; hangmark <файл> — пишет файл-метку и висит;
//  empty — ничего не печатает.
const LIST_SCRIPT = `
const fs = require('fs');
const [mode, arg] = process.argv.slice(2);
const out = (lines) => process.stdout.write(lines.join('\\n') + '\\n');
if (mode === 'mixed') {
  out([
    'prov/vendor/m-3',
    JSON.stringify({ id: 'prov/vendor/m-1', capabilities: ['multimodal'], note: 'in=0 out=0' }),
    '{broken json',
    JSON.stringify({ note: 'no id' }),
    'prov/vendor/m-2',
    'prov/vendor/m-1',
    'other/vendor/x-1',
    'prov/vendor/bad id',
    '',
    JSON.stringify({ id: 'prov/special/m-9', capabilities: 'multimodal' }),
  ]);
} else if (mode === 'count') {
  fs.appendFileSync(arg, 'x');
  out(['prov/vendor/m-1', 'prov/vendor/m-2']);
} else if (mode === 'caps') {
  out([
    JSON.stringify({ id: 'prov/vendor/m-1', capabilities: ['multimodal'], note: 'in=0 out=0 tools=true' }),
    'prov/vendor/m-2',
  ]);
} else if (mode === 'fail') {
  process.stderr.write('list failed: boom\\n');
  process.exit(1);
} else if (mode === 'hang') {
  setInterval(() => {}, 1000);
  setTimeout(() => process.exit(0), 20000);
} else if (mode === 'hangmark') {
  fs.writeFileSync(arg, 'started');
  setInterval(() => {}, 1000);
  setTimeout(() => process.exit(0), 20000);
} else if (mode === 'empty') {
  // ничего
} else {
  process.exit(2);
}
`;

function makeTemp() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'model-pools-expand-'));
  TEMPS.push(base);
  const root = path.join(base, 'project');
  const tools = path.join(base, 'tools');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(tools, { recursive: true });
  const listScript = path.join(tools, 'list-models.cjs');
  fs.writeFileSync(listScript, LIST_SCRIPT);
  return { base, root, tools, listScript };
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

const poolLines = (logger) => logger.lines.filter((l) => /\bPOOL agent=/.test(l));

function pool(listScript, mode, { match = ['^prov/'], extraList = [], ...extra } = {}) {
  return {
    command: 'node',
    args: ['agent.js', '--model', '{model}'],
    workdir: '.',
    capabilities: ['text'],
    models: { list: ['node', listScript, mode, ...extraList], match },
    ...extra,
  };
}

function pipelineOf(agents) {
  return { name: 'model-pools-expand', version: '1.0', agents, stages: {}, entry: 'end' };
}

// ---------------------------------------------------------------------------

describe('раскрытие пула', () => {
  test('порядок — по первому совпавшему выражению match, затем по выводу; строка POOL с note', async () => {
    const { root, listScript } = makeTemp();
    const pipeline = pipelineOf({
      'pool-a': pool(listScript, 'mixed', { match: ['^prov/special/', '^prov/vendor/'] }),
      'agent-b': { command: 'node', args: ['b.js'], capabilities: ['text'] },
    });
    const logger = captureLogger();

    const result = await expandModelPools(pipeline, { projectRoot: root, logger });

    const expected = ['prov/special/m-9', 'prov/vendor/m-3', 'prov/vendor/m-1', 'prov/vendor/m-2'];
    assert.deepEqual(result.get('pool-a'), expected.map((id) => `pool-a@${id}`));
    const members = Object.keys(pipeline.agents).filter((id) => id.startsWith('pool-a@'));
    assert.deepEqual(members, expected.map((id) => `pool-a@${id}`), 'участники в pipeline.agents — в порядке маски');
    assert.deepEqual(poolLines(logger), [
      'INFO POOL agent="pool-a" members=4 [prov/special/m-9, prov/vendor/m-3, prov/vendor/m-1 in=0 out=0, prov/vendor/m-2]',
    ]);
  });

  test('испорченная строка, строка без id и id с пробелом — WARN и пропуск; повтор — первое вхождение', async () => {
    const { root, listScript } = makeTemp();
    const pipeline = pipelineOf({ 'pool-a': pool(listScript, 'mixed', { match: ['^prov/vendor/'] }) });
    const logger = captureLogger();

    await expandModelPools(pipeline, { projectRoot: root, logger });

    const warns = logger.lines.filter((l) => l.startsWith('WARN '));
    assert.ok(warns.some((l) => l.includes('{broken json')), `WARN об испорченной строке: ${warns.join('\n')}`);
    assert.ok(warns.some((l) => l.includes('{"note":"no id"}')), `WARN о строке без id: ${warns.join('\n')}`);
    assert.ok(warns.some((l) => l.includes('pool-a') && l.includes('prov/vendor/bad id')), `WARN об id с пробелом: ${warns.join('\n')}`);
    assert.equal(pipeline.agents['pool-a@prov/vendor/bad id'], undefined);
    // Повтор plain-строкой не перетирает JSON-строку: note и способности — первого вхождения.
    assert.deepEqual(pipeline.agents['pool-a@prov/vendor/m-1'].capabilities, ['text', 'multimodal']);
    assert.match(poolLines(logger)[0], /prov\/vendor\/m-1 in=0 out=0/);
    // Не входит в маску — не участник и без WARN.
    assert.equal(pipeline.agents['pool-a@other/vendor/x-1'], undefined);
    assert.ok(!warns.some((l) => l.includes('other/vendor/x-1')));
  });

  test('одинаковая команда списка у двух пулов — один запуск (П7)', async () => {
    const { root, tools, listScript } = makeTemp();
    const counter = path.join(tools, 'count.txt');
    const pipeline = pipelineOf({
      'pool-a': pool(listScript, 'count', { extraList: [counter], match: ['m-1$'] }),
      'pool-b': pool(listScript, 'count', { extraList: [counter], match: ['m-2$'] }),
    });
    assert.notEqual(pipeline.agents['pool-a'].models.list, pipeline.agents['pool-b'].models.list, 'равные, но разные массивы');
    const logger = captureLogger();

    await expandModelPools(pipeline, { projectRoot: root, logger });

    assert.equal(fs.readFileSync(counter, 'utf8'), 'x', 'команда запущена один раз');
    assert.deepEqual(poolLines(logger), [
      'INFO POOL agent="pool-a" members=1 [prov/vendor/m-1]',
      'INFO POOL agent="pool-b" members=1 [prov/vendor/m-2]',
    ]);
  });

  test('сбои команды — members=0 с причиной: exit, timeout, no match; пул без участников', async () => {
    const { root, listScript } = makeTemp();
    const pipeline = pipelineOf({
      'pool-fail': pool(listScript, 'fail'),
      'pool-hang': pool(listScript, 'hang'),
      'pool-empty': pool(listScript, 'empty'),
      'pool-nomatch': pool(listScript, 'mixed', { match: ['^absent/'] }),
    });
    const logger = captureLogger();

    const started = Date.now();
    const result = await expandModelPools(pipeline, { projectRoot: root, logger, timeoutMs: 700 });
    assert.ok(Date.now() - started < 15000, 'зависшая команда снята по таймауту');

    assert.deepEqual(poolLines(logger), [
      'INFO POOL agent="pool-fail" members=0 (exit 1)',
      'INFO POOL agent="pool-hang" members=0 (timeout 700ms)',
      'INFO POOL agent="pool-empty" members=0 (no match)',
      'INFO POOL agent="pool-nomatch" members=0 (no match)',
    ]);
    for (const id of ['pool-fail', 'pool-hang', 'pool-empty', 'pool-nomatch']) {
      assert.deepEqual(result.get(id), []);
    }
    assert.deepEqual(Object.keys(pipeline.agents).filter((id) => id.includes('@')), [], 'участников нет');
    // stderr упавшей команды — в лог: причина сбоя не теряется.
    assert.ok(logger.lines.some((l) => l.startsWith('WARN ') && l.includes('list failed: boom')), logger.lines.join('\n'));
  });

  test('таймаут по умолчанию — 60 с; команда не запускается — spawn error', async () => {
    const { root, listScript } = makeTemp();
    const missing = path.join(root, 'no-such-dir');
    const res = await runPoolCommand(['node', listScript, 'empty'], { cwd: missing });
    assert.equal(res.ok, false);
    assert.match(res.reason, /^spawn error .*ENOENT/);

    const pipeline = pipelineOf({ 'pool-a': pool(listScript, 'empty') });
    const logger = captureLogger();
    await expandModelPools(pipeline, { projectRoot: missing, logger });
    assert.match(poolLines(logger)[0], /^INFO POOL agent="pool-a" members=0 \(spawn error .*ENOENT/);

    const hang = await runPoolCommand(['node', listScript, 'hang'], { cwd: root, timeoutMs: 300 });
    assert.deepEqual([hang.ok, hang.reason], [false, 'timeout 300ms']);
    assert.equal(formatTimeout(60000), '60s', 'строка таймаута по умолчанию — «timeout 60s»');
  });

  test('конфиг без пулов — команд нет, строк POOL нет', async () => {
    const { root } = makeTemp();
    const pipeline = pipelineOf({ 'agent-b': { command: 'node', args: ['b.js'], capabilities: ['text'] } });
    const logger = captureLogger();
    const result = await expandModelPools(pipeline, { projectRoot: root, logger });
    assert.equal(result.size, 0);
    assert.deepEqual(logger.lines, []);
    assert.deepEqual(Object.keys(pipeline.agents), ['agent-b']);
  });

  test('PipelineRunner.run на конфиге с пулом — одна строка POOL в логе до первой стадии', async () => {
    const { root, tools, listScript } = makeTemp();
    const stageScript = path.join(tools, 'stage.cjs');
    fs.writeFileSync(stageScript, `process.stdout.write('---RESULT---\\nstatus: passed\\n---RESULT---\\n');\n`);
    const config = {
      pipeline: {
        name: 'model-pools-runner', version: '1.0', entry: 'work', context: {},
        execution: { max_steps: 5, delay_between_stages: 0.01, timeout_per_stage: 30, artifact_snapshot_enabled: false },
        agents: {
          'pool-a': pool(listScript, 'caps', { match: ['^prov/vendor/'] }),
          'script-a': { command: 'node', args: [stageScript], workdir: '.' },
        },
        stages: { work: { agent: 'script-a', goto: { passed: 'end', default: 'end' } } },
      },
    };
    const runner = new PipelineRunner(config, { project: root });
    try {
      await runner.run();
    } finally {
      runner.disposeSignalHandlers();
    }
    const log = fs.readFileSync(runner.logFilePath, 'utf8');
    const lines = log.split(/\r?\n/).filter((l) => /\bPOOL agent=/.test(l));
    assert.equal(lines.length, 1, log);
    assert.match(lines[0], /POOL agent="pool-a" members=2 \[prov\/vendor\/m-1 in=0 out=0 tools=true, prov\/vendor\/m-2\]$/);
    assert.ok(log.indexOf('POOL agent=') < log.indexOf('Current stage: work'), 'раскрытие — до первой стадии');
    assert.ok(runner.config.pipeline.agents['pool-a@prov/vendor/m-2'], 'участник зарегистрирован в общем конфиге');
  });

  test('signal прерван во время команды списка — команда снята, members=0 (aborted); уже прерванный — не запускается', async () => {
    const { root, listScript } = makeTemp();
    const mark = path.join(root, 'list-started');
    const pipeline = pipelineOf({ 'pool-hang': pool(listScript, 'hangmark', { extraList: [mark] }) });
    const logger = captureLogger();
    const controller = new AbortController();
    const poll = setInterval(() => { if (fs.existsSync(mark)) controller.abort(); }, 50);
    const started = Date.now();
    try {
      const result = await expandModelPools(pipeline, { projectRoot: root, logger, signal: controller.signal });
      assert.ok(Date.now() - started < 8000, `команда снята по signal, а не сама через 20 с: ${Date.now() - started} мс`);
      assert.deepEqual(poolLines(logger), ['INFO POOL agent="pool-hang" members=0 (aborted)']);
      assert.deepEqual(result.get('pool-hang'), []);
    } finally {
      clearInterval(poll);
    }

    const counter = path.join(root, 'count.txt');
    const res = await runPoolCommand(['node', listScript, 'count', counter], { cwd: root, signal: controller.signal });
    assert.deepEqual([res.ok, res.reason], [false, 'aborted']);
    assert.equal(fs.existsSync(counter), false, 'при уже прерванном signal команда не запускается');
  });

  test('PipelineRunner: остановка во время раскрытия — команда списка снята, стадия не запускается', async () => {
    const { root, tools, listScript } = makeTemp();
    const mark = path.join(root, 'list-started');
    const stageMark = path.join(root, 'stage-ran');
    const stageScript = path.join(tools, 'stage.cjs');
    fs.writeFileSync(stageScript, `require('fs').writeFileSync(${JSON.stringify(stageMark)}, 'x');\n`
      + `process.stdout.write('---RESULT---\\nstatus: passed\\n---RESULT---\\n');\n`);
    const config = {
      pipeline: {
        name: 'model-pools-runner-stop', version: '1.0', entry: 'work', context: {},
        execution: { max_steps: 5, delay_between_stages: 0.01, timeout_per_stage: 30, artifact_snapshot_enabled: false },
        agents: {
          'pool-a': pool(listScript, 'hangmark', { extraList: [mark] }),
          'script-a': { command: 'node', args: [stageScript], workdir: '.' },
        },
        stages: { work: { agent: 'script-a', goto: { passed: 'end', default: 'end' } } },
      },
    };
    const runner = new PipelineRunner(config, { project: root });
    // Первый сигнал остановки — обработчик раннера (setupGracefulShutdown), без process.emit.
    const poll = setInterval(() => {
      if (fs.existsSync(mark)) {
        clearInterval(poll);
        runner.signalHandlers.SIGINT();
      }
    }, 50);
    const started = Date.now();
    try {
      await runner.run();
    } finally {
      clearInterval(poll);
      runner.disposeSignalHandlers();
    }
    assert.ok(Date.now() - started < 10000, `раскрытие прервано остановкой: ${Date.now() - started} мс`);
    const log = fs.readFileSync(runner.logFilePath, 'utf8');
    assert.match(log, /POOL agent="pool-a" members=0 \(aborted\)/, log);
    assert.equal(fs.existsSync(stageMark), false, 'стадия после остановки не запускается');
  });
});

// ---------------------------------------------------------------------------

describe('участники пула', () => {
  test('запись участника — копия пула с полным id на месте {model}, без models, с pool и объединёнными способностями', async () => {
    const { root, listScript } = makeTemp();
    const pipeline = pipelineOf({
      'pool-k': {
        command: 'kilo',
        args: ['-m', '{model}', '--agent', 'code', 'run', '--auto'],
        workdir: '.',
        capabilities: ['text', 'multimodal'],
        description: 'Пул по маске',
        models: { list: ['node', listScript, 'caps'], match: ['^prov/vendor/'], max_per_attempt: 2 },
      },
    });

    await expandModelPools(pipeline, { projectRoot: root, logger: captureLogger() });

    const id = 'pool-k@prov/vendor/m-1';
    assert.deepEqual(pipeline.agents[id], {
      command: 'kilo',
      args: ['-m', 'prov/vendor/m-1', '--agent', 'code', 'run', '--auto'],
      workdir: '.',
      capabilities: ['text', 'multimodal'],
      description: 'Пул по маске',
      pool: 'pool-k',
    });
    assert.equal(configuredModelKey(pipeline.agents[id], id), 'vendor/m-1', 'ключ модели — id без провайдера');
    assert.equal(configuredModelKey(pipeline.agents['pool-k@prov/vendor/m-2'], 'pool-k@prov/vendor/m-2'), 'vendor/m-2');
    // Запись пула остаётся: это место в списке стадии.
    assert.ok(pipeline.agents['pool-k'].models, 'запись пула на месте');
    assert.deepEqual(pipeline.agents['pool-k'].args, ['-m', '{model}', '--agent', 'code', 'run', '--auto']);
  });

  test('способности — объединение пула и строки списка; {model} внутри аргумента тоже заменяется', async () => {
    const { root, listScript } = makeTemp();
    const pipeline = pipelineOf({
      'pool-a': pool(listScript, 'caps', { match: ['^prov/vendor/'], args: ['agent.js', '--model={model}'] }),
    });
    await expandModelPools(pipeline, { projectRoot: root, logger: captureLogger() });
    assert.deepEqual(pipeline.agents['pool-a@prov/vendor/m-1'].capabilities, ['text', 'multimodal']);
    assert.deepEqual(pipeline.agents['pool-a@prov/vendor/m-2'].capabilities, ['text']);
    assert.deepEqual(pipeline.agents['pool-a@prov/vendor/m-1'].args, ['agent.js', '--model=prov/vendor/m-1']);
    assert.equal(pipeline.agents['pool-a@prov/vendor/m-1'].models, undefined);
  });

  test('два пула с одним массивом args (якорь YAML) — массив пула не изменён, у участников свои массивы', async () => {
    const { root, listScript } = makeTemp();
    const text = `
agents:
  pool-a:
    command: "node"
    args: &pool_args ["agent.js", "--model", "{model}", "run"]
    capabilities: [text]
    models:
      list: ["node", ${JSON.stringify(listScript)}, "caps"]
      match: ['m-1$']
  pool-b:
    command: "node"
    args: *pool_args
    capabilities: [text]
    models:
      list: ["node", ${JSON.stringify(listScript)}, "caps"]
      match: ['m-2$']
`;
    const { agents } = yaml.load(text);
    assert.equal(agents['pool-a'].args, agents['pool-b'].args, 'js-yaml отдаёт псевдониму тот же массив');
    const shared = agents['pool-a'].args;
    const pipeline = pipelineOf(agents);

    await expandModelPools(pipeline, { projectRoot: root, logger: captureLogger() });

    assert.equal(pipeline.agents['pool-a'].args, shared);
    assert.equal(pipeline.agents['pool-b'].args, shared);
    assert.deepEqual(shared, ['agent.js', '--model', '{model}', 'run'], 'массив пула не изменён');
    const a = pipeline.agents['pool-a@prov/vendor/m-1'];
    const b = pipeline.agents['pool-b@prov/vendor/m-2'];
    assert.deepEqual(a.args, ['agent.js', '--model', 'prov/vendor/m-1', 'run']);
    assert.deepEqual(b.args, ['agent.js', '--model', 'prov/vendor/m-2', 'run']);
    assert.notEqual(a.args, shared);
    assert.notEqual(a.capabilities, pipeline.agents['pool-a'].capabilities, 'способности — новый массив');
  });

  test('агент конфига с id участника — участник не записывается поверх него, WARN; остальные участники есть', async () => {
    const { root, listScript } = makeTemp();
    const configured = { command: 'node', args: ['own.js'], capabilities: ['text'] };
    const pipeline = pipelineOf({
      'pool-a': pool(listScript, 'caps', { match: ['^prov/vendor/'] }),
      'pool-a@prov/vendor/m-1': configured,
    });
    const logger = captureLogger();

    const result = await expandModelPools(pipeline, { projectRoot: root, logger });

    assert.deepEqual(pipeline.agents['pool-a@prov/vendor/m-1'], { command: 'node', args: ['own.js'], capabilities: ['text'] });
    assert.deepEqual(result.get('pool-a'), ['pool-a@prov/vendor/m-2']);
    assert.deepEqual(poolLines(logger), ['INFO POOL agent="pool-a" members=1 [prov/vendor/m-2]']);
    assert.ok(
      logger.lines.some((l) => l.startsWith('WARN ') && l.includes('"pool-a@prov/vendor/m-1"') && /already/.test(l)),
      logger.lines.join('\n'),
    );
  });
});
