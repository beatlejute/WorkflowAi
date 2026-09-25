/**
 * Исполнение стадии безынструментным агентом (`kind: http`) по обмену `model_io`:
 * prepare → слой оценки → apply (src/runner.mjs, StageExecutor.callModelAgent).
 *
 * Проект — временный каталог в os.tmpdir() с `.workflow/config/pipeline.yaml`,
 * скриптами prepare/apply и CLI-агентом-фикстурой; снимается в after(). Модель —
 * локальный HTTP-сервер на 127.0.0.1 (_model-server.mjs); сеть наружу не
 * используется.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StageExecutor, runPipeline } from '../runner.mjs';
import { isHealthy } from '../lib/agent-health-registry.mjs';
import { TEST_KEY, startModelServer, sendJson, decisionsResponse, chatResponse } from './_model-server.mjs';

const ROOTS = [];
let savedKey;

before(() => {
  savedKey = process.env.TEST_MODEL_KEY;
  process.env.TEST_MODEL_KEY = TEST_KEY;
});

after(() => {
  if (savedKey === undefined) delete process.env.TEST_MODEL_KEY;
  else process.env.TEST_MODEL_KEY = savedKey;
  for (const root of ROOTS) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// prepare: пишет вход слоя оценки; `prepare_mode: nothing` в options — закрывает
// стадию сам, модель не спрашивается. Окружение и промпт сохраняются для проверки.
const PREPARE_SCRIPT = `import fs from 'node:fs';
const options = JSON.parse(process.env.WORKFLOW_MODEL_IO_OPTIONS || '{}');
fs.mkdirSync('.workflow/tmp', { recursive: true });
fs.writeFileSync('.workflow/tmp/prepare-env.json', JSON.stringify({
  agent: process.env.WORKFLOW_MODEL_AGENT,
  capabilities: process.env.WORKFLOW_MODEL_CAPABILITIES,
  options: process.env.WORKFLOW_MODEL_IO_OPTIONS,
  prompt: process.argv[process.argv.length - 1],
}));
if (options.prepare_mode === 'slow') await new Promise((resolve) => setTimeout(resolve, 15000));
if (options.prepare_mode === 'nothing') {
  console.log('---RESULT---\\nstatus: passed\\nreason: nothing to ask\\n---RESULT---');
} else if (options.prepare_mode === 'no_request_file') {
  console.log('---RESULT---\\nstatus: ready\\n---RESULT---');
} else {
  fs.writeFileSync('.workflow/tmp/request.json', JSON.stringify({
    data: 'проверяемые данные',
    questions: [{ id: 'dod-1', text: 'Критерий выполнен?', levels: ['нет', 'да'] }],
  }));
  console.log('---RESULT---\\nstatus: ready\\nrequest_file: .workflow/tmp/request.json\\n---RESULT---');
}
`;

// apply: статус по уровню ответа модели.
const APPLY_SCRIPT = `import fs from 'node:fs';
const response = JSON.parse(fs.readFileSync(process.env.WORKFLOW_MODEL_RESPONSE, 'utf8'));
const request = JSON.parse(fs.readFileSync(process.env.WORKFLOW_MODEL_REQUEST, 'utf8'));
fs.writeFileSync('.workflow/tmp/apply-env.json', JSON.stringify({
  agent: process.env.WORKFLOW_MODEL_AGENT,
  questions: request.questions.length,
}));
const level = response.answers['dod-1'].level;
console.log('---RESULT---\\nstatus: ' + (level === 2 ? 'passed' : 'failed') + '\\nlevel: ' + level + '\\nmodel: ' + response.model + '\\n---RESULT---');
`;

// CLI-агент оставляет метку вызова — по ней видно, брала ли стадия следующего агента.
const CLI_AGENT_SCRIPT = `import fs from 'node:fs';
fs.mkdirSync('.workflow/tmp', { recursive: true });
fs.writeFileSync('.workflow/tmp/cli-agent-called', 'yes');
console.log('---RESULT---\\nstatus: passed\\nby: cli-agent\\n---RESULT---');
`;

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'wf-model-io-'));
  ROOTS.push(root);
  mkdirSync(join(root, '.workflow', 'config'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'prepare.mjs'), PREPARE_SCRIPT);
  writeFileSync(join(root, 'scripts', 'apply.mjs'), APPLY_SCRIPT);
  writeFileSync(join(root, 'scripts', 'cli-agent.mjs'), CLI_AGENT_SCRIPT);
  return root;
}

function httpAgent(protocol, url, capabilities = ['text']) {
  return { kind: 'http', protocol, url, model: `test/${protocol}`, auth: { env: 'TEST_MODEL_KEY' }, capabilities };
}

function makeConfig(agents, stageAgents, { options, entry = 'review' } = {}) {
  return {
    pipeline: {
      name: 'model-io-test',
      version: '1.0',
      entry,
      execution: { timeout_per_stage: 60, delay_between_stages: 0, artifact_snapshot_enabled: false },
      agents: {
        'cli-agent': { command: 'node', args: ['scripts/cli-agent.mjs'], capabilities: ['text'] },
        ...agents,
      },
      stages: {
        review: {
          agents: stageAgents,
          model_io: { prepare: 'scripts/prepare.mjs', apply: 'scripts/apply.mjs', ...(options ? { options } : {}) },
          goto: { passed: { stage: 'end' }, failed: { stage: 'end' }, error: { stage: 'end' } },
        },
      },
    },
  };
}

function captureLogger() {
  const lines = [];
  const push = (level) => (message) => lines.push(`${level} ${message}`);
  return {
    lines,
    info: push('INFO'),
    warn: push('WARN'),
    error: push('ERROR'),
    debug: push('DEBUG'),
    stageStart() {},
    stageComplete() {},
    timeout() {},
    cliCall() {},
  };
}

function runStage(root, config, context = {}, { runId, onExecutor } = {}) {
  const logger = captureLogger();
  const executor = new StageExecutor(config, context, {}, {}, null, logger, root, runId ? { runId } : {});
  onExecutor?.(executor);
  return executor.execute('review').then((result) => ({ result, logger }));
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function modelIoFiles(root) {
  const dir = join(root, '.workflow', 'state', 'model-io');
  return existsSync(dir) ? readdirSync(dir) : [];
}

const PASS_DECISION = (req, res) => sendJson(res, 200, decisionsResponse({
  'dod-1': { type: 'score', score: 0.95, legend: {}, probabilities: { 0: 0.05, 1: 0.95 }, confidence: 0.95 },
}));

describe('runner: стадия с model_io и агентом kind: http', () => {
  it('полный проход: статус из apply, ответ модели в .workflow/state/model-io/', async () => {
    const server = await startModelServer(PASS_DECISION);
    try {
      const root = makeProject();
      const config = makeConfig({ jev: httpAgent('decisions', server.url('/api/alpha/decisions')) }, ['jev'],
        { options: { threshold: 0.8 } });

      const { result, logger } = await runStage(root, config);

      assert.equal(result.status, 'passed');
      assert.equal(result.result.level, '2');
      assert.equal(server.requests.length, 1);
      assert.deepEqual(server.requests[0].json.state, 'проверяемые данные');

      const files = modelIoFiles(root);
      assert.equal(files.length, 1);
      assert.match(files[0], /^review-[0-9a-f-]{36}\.json$/, 'без run_id пайплайна — id вызова целиком');
      const saved = readJson(join(root, '.workflow', 'state', 'model-io', files[0]));
      assert.equal(saved.answers['dod-1'].level, 2);
      assert.equal(saved.answers['dod-1'].confidence, 0.95);
      assert.equal(result.modelIo.response_file, `.workflow/state/model-io/${files[0]}`);

      const prepareEnv = readJson(join(root, '.workflow', 'tmp', 'prepare-env.json'));
      assert.equal(prepareEnv.agent, 'jev');
      assert.deepEqual(JSON.parse(prepareEnv.capabilities), ['text']);
      assert.deepEqual(JSON.parse(prepareEnv.options), { threshold: 0.8 });
      assert.match(prepareEnv.prompt, /review|Instructions|Context/);
      assert.deepEqual(readJson(join(root, '.workflow', 'tmp', 'apply-env.json')), { agent: 'jev', questions: 1 });

      const line = logger.lines.find((l) => l.includes('MODEL_IO agent="jev"'));
      assert.ok(line, logger.lines.join('\n'));
      assert.match(line, /model="typesafe\/jev-1\.13-20260917"/);
      assert.match(line, /prepare_ms=\d+ model_ms=\d+ apply_ms=\d+/);
      assert.match(line, /cost_usd=0\.000126672/);
    } finally {
      await server.close();
    }
  });

  it('prepare со status: passed закрывает стадию без вызова модели', async () => {
    const server = await startModelServer(PASS_DECISION);
    try {
      const root = makeProject();
      const config = makeConfig({ jev: httpAgent('decisions', server.url('/d')) }, ['jev'],
        { options: { prepare_mode: 'nothing' } });

      const { result } = await runStage(root, config);

      assert.equal(result.status, 'passed');
      assert.equal(result.result.reason, 'nothing to ask');
      assert.equal(server.requests.length, 0);
      assert.deepEqual(modelIoFiles(root), []);
      assert.ok(!existsSync(join(root, '.workflow', 'tmp', 'apply-env.json')), 'apply не запускается');
    } finally {
      await server.close();
    }
  });

  it('ошибка сервера: status error с error_class, apply не запускается, агент в health-реестре', async () => {
    // 504 не повторяется — стадия не ждёт пауз повторов.
    const server = await startModelServer((req, res) => sendJson(res, 504, { error: 'gateway timeout' }));
    try {
      const root = makeProject();
      const config = makeConfig({ jev: httpAgent('decisions', server.url('/d')) }, ['jev']);

      const { result } = await runStage(root, config);

      assert.equal(result.status, 'error');
      assert.equal(result.result.error_class, 'server');
      assert.ok(!existsSync(join(root, '.workflow', 'tmp', 'apply-env.json')), 'apply не запускается');
      assert.deepEqual(modelIoFiles(root), []);
      assert.equal(isHealthy(root, 'jev'), false, 'ошибка server помечает агента');
    } finally {
      await server.close();
    }
  });

  it('модель не держит формат ответа: status error, bad_response, агент не помечается', async () => {
    const server = await startModelServer((req, res) => sendJson(res, 200, chatResponse('без JSON')));
    try {
      const root = makeProject();
      const config = makeConfig({ vision: httpAgent('chat', server.url('/c')) }, ['vision']);

      const { result } = await runStage(root, config);

      assert.equal(result.status, 'error');
      assert.equal(result.result.error_class, 'bad_response');
      assert.equal(isHealthy(root, 'vision'), true);
    } finally {
      await server.close();
    }
  });

  it('ошибка server у первого агента — смена агента в пределах попытки', async () => {
    const server = await startModelServer((req, res) => sendJson(res, 504, { error: 'gateway timeout' }));
    try {
      const root = makeProject();
      const config = makeConfig({ jev: httpAgent('decisions', server.url('/d')) }, ['jev', 'cli-agent']);

      const { result } = await runStage(root, config);

      assert.equal(result.status, 'passed');
      assert.equal(result.result.by, 'cli-agent');
      assert.equal(server.requests.length, 1);
    } finally {
      await server.close();
    }
  });

  it('выбор по способностям: required_capabilities [multimodal] — мультимодальный агент', async () => {
    const server = await startModelServer((req, res) => (req.url === '/chat'
      ? sendJson(res, 200, chatResponse('{"answers":[{"id":"dod-1","level":2,"reason":"видно на скриншоте"}]}'))
      : PASS_DECISION(req, res)));
    try {
      const agents = {
        jev: httpAgent('decisions', server.url('/decisions'), ['text']),
        vision: httpAgent('chat', server.url('/chat'), ['text', 'multimodal']),
      };

      const multimodal = await runStage(makeProject(), makeConfig(agents, ['jev', 'vision']),
        { required_capabilities: '["multimodal"]' });
      assert.equal(multimodal.result.status, 'passed');
      assert.equal(multimodal.result.modelIo.agent, 'vision');
      assert.deepEqual(server.requests.map((r) => r.url), ['/chat']);

      const plain = await runStage(makeProject(), makeConfig(agents, ['jev', 'vision']));
      assert.equal(plain.result.modelIo.agent, 'jev', 'без требований — первый по приоритету');
      assert.deepEqual(server.requests.map((r) => r.url), ['/chat', '/decisions']);
    } finally {
      await server.close();
    }
  });

  it('CLI-агент в той же стадии идёт прежним путём, без prepare и apply', async () => {
    const root = makeProject();
    const config = makeConfig({ jev: httpAgent('decisions', 'http://127.0.0.1:9/d') }, ['cli-agent', 'jev']);

    const { result } = await runStage(root, config);

    assert.equal(result.status, 'passed');
    assert.equal(result.result.by, 'cli-agent');
    assert.equal(result.modelIo, undefined);
    assert.ok(!existsSync(join(root, '.workflow', 'tmp', 'prepare-env.json')), 'prepare не запускается');
  });

  it('runPipeline: конфиг проходит проверку, стадия исполняется и пайплайн завершается', async () => {
    const server = await startModelServer(PASS_DECISION);
    try {
      const root = makeProject();
      const config = makeConfig({ jev: httpAgent('decisions', server.url('/d')) }, ['jev']);
      config.pipeline.stages.review.goto.passed = { stage: 'end', params: { review_level: '$result.level' } };
      writeFileSync(join(root, '.workflow', 'config', 'pipeline.yaml'), JSON.stringify(config, null, 2));

      const outcome = await runPipeline(['--project', root]);

      assert.equal(outcome.exitCode, 0, JSON.stringify(outcome.details || outcome.error || ''));
      assert.equal(outcome.result.context.review_level, '2');
      assert.equal(server.requests.length, 1);
      assert.match(modelIoFiles(root)[0], /^review-pipeline_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-[0-9a-f]{8}\.json$/,
        'файл ответа несёт run_id запуска');
    } finally {
      await server.close();
    }
  });
});

describe('runner: model_io — одиночный агент, остановка, аудит, контракт prepare', () => {
  it('одиночный stage.agent kind: http исполняет стадию через model_io', async () => {
    const server = await startModelServer(PASS_DECISION);
    try {
      const root = makeProject();
      const config = makeConfig({ jev: httpAgent('decisions', server.url('/d')) }, ['jev']);
      delete config.pipeline.stages.review.agents;
      config.pipeline.stages.review.agent = 'jev';

      const { result } = await runStage(root, config);

      assert.equal(result.status, 'passed');
      assert.equal(result.modelIo.agent, 'jev');
      assert.equal(server.requests.length, 1);
    } finally {
      await server.close();
    }
  });

  it('файл ответа модели несёт run_id пайплайна и id вызова', async () => {
    const server = await startModelServer(PASS_DECISION);
    try {
      const root = makeProject();
      const config = makeConfig({ jev: httpAgent('decisions', server.url('/d')) }, ['jev']);

      await runStage(root, config, {}, { runId: 'pipeline_2026-09-25_10-00-00' });

      const files = modelIoFiles(root);
      assert.equal(files.length, 1);
      assert.match(files[0], /^review-pipeline_2026-09-25_10-00-00-[0-9a-f]{8}\.json$/);
    } finally {
      await server.close();
    }
  });

  it('prepare: ready без request_file — status error, класс bad_prepare, модель не вызывается', async () => {
    const server = await startModelServer(PASS_DECISION);
    try {
      const root = makeProject();
      const config = makeConfig({ jev: httpAgent('decisions', server.url('/d')) }, ['jev'],
        { options: { prepare_mode: 'no_request_file' } });

      const { result } = await runStage(root, config);

      assert.equal(result.status, 'error');
      assert.equal(result.result.error_class, 'bad_prepare');
      assert.equal(server.requests.length, 0);
      assert.equal(isHealthy(root, 'jev'), true, 'ошибка скрипта не помечает агента');
    } finally {
      await server.close();
    }
  });

  it('остановка во время вызова модели: aborted сразу, apply не запускается, агент не помечен', async () => {
    let executor = null;
    // Сервер не отвечает: без прерывания стадия ждала бы timeout_s = 30 с.
    const server = await startModelServer(() => setImmediate(() => executor.killCurrentChild()));
    try {
      const root = makeProject();
      const agent = { ...httpAgent('decisions', server.url('/d')), timeout_s: 30 };
      const config = makeConfig({ jev: agent }, ['jev', 'cli-agent']);

      const started = Date.now();
      const { result } = await runStage(root, config, {}, { onExecutor: (e) => { executor = e; } });

      assert.ok(Date.now() - started < 10000, 'вызов модели снят остановкой, а не таймаутом');
      assert.equal(result.status, 'error');
      assert.equal(result.result.error_class, 'aborted');
      assert.equal(result.result.by, undefined, 'следующий агент стадии не запускается');
      assert.ok(!existsSync(join(root, '.workflow', 'tmp', 'apply-env.json')), 'apply не запускается');
      assert.equal(isHealthy(root, 'jev'), true);
    } finally {
      await server.close();
    }
  });

  it('ошибка без смены агента (нет ключа) — в истории тикета error, не empty_response', async () => {
    const root = makeProject();
    const ticketDir = join(root, '.workflow', 'tickets', 'in-progress');
    mkdirSync(ticketDir, { recursive: true });
    writeFileSync(join(ticketDir, 'IMPL-1.md'), '---\nid: IMPL-1\ntitle: probe\n---\n\n# IMPL-1\n');
    const agent = { ...httpAgent('decisions', 'http://127.0.0.1:9/d'), auth: { env: 'WF_MODEL_IO_TEST_MISSING_KEY' } };
    delete process.env.WF_MODEL_IO_TEST_MISSING_KEY;
    const config = makeConfig({ jev: agent }, ['jev']);

    const { result } = await runStage(root, config, { ticket_id: 'IMPL-1' });

    assert.equal(result.result.error_class, 'no_key');
    const ticket = readFileSync(join(ticketDir, 'IMPL-1.md'), 'utf8');
    assert.match(ticket, /## История работы[\s\S]*\| jev \| error \|/);
    assert.doesNotMatch(ticket, /empty_response/);
  });
});

describe('runner: остановка во время prepare', () => {
  it('убитый остановкой prepare не передаёт стадию следующему агенту и не помечает агента', async () => {
    const server = await startModelServer(PASS_DECISION);
    try {
      const root = makeProject();
      const config = makeConfig({ jev: httpAgent('decisions', server.url('/d')) }, ['jev', 'cli-agent'],
        { options: { prepare_mode: 'slow' } });
      // Снимки артефактов включены, как по умолчанию: при пустом diff раньше
      // срабатывал переход к следующему агенту.
      config.pipeline.execution.artifact_snapshot_enabled = true;
      config.pipeline.execution.snapshot_paths = ['scripts'];

      let executor = null;
      const started = Date.now();
      const stage = runStage(root, config, {}, { onExecutor: (e) => { executor = e; } });
      const prepareEnv = join(root, '.workflow', 'tmp', 'prepare-env.json');
      for (let i = 0; i < 200 && !existsSync(prepareEnv); i++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(existsSync(prepareEnv), 'prepare запущен');
      executor.killCurrentChild();

      await assert.rejects(stage, 'стадия завершается ошибкой убитого prepare');
      assert.ok(Date.now() - started < 12000, 'стадия не ждала prepare до конца');
      assert.ok(!existsSync(join(root, '.workflow', 'tmp', 'cli-agent-called')), 'следующий агент не запускался');
      assert.equal(server.requests.length, 0, 'модель не вызывалась');
      assert.equal(isHealthy(root, 'jev'), true, 'остановка — не сбой агента');
    } finally {
      await server.close();
    }
  });
});

describe('runner: остановка между агентами', () => {
  it('остановка после сбоя агента, до запуска следующего — следующий не запускается', async () => {
    const root = makeProject();
    writeFileSync(join(root, 'scripts', 'cli-fail.mjs'), 'process.exit(1);\n');
    const config = makeConfig({}, ['cli-fail', 'cli-agent']);
    config.pipeline.agents['cli-fail'] = { command: 'node', args: ['scripts/cli-fail.mjs'], capabilities: ['text'] };
    delete config.pipeline.stages.review.model_io;
    config.pipeline.execution.artifact_snapshot_enabled = true;
    config.pipeline.execution.snapshot_paths = ['scripts'];

    // Окно между агентами: запрос на остановку приходит, когда первый агент уже
    // упал, а второй ещё не выбран, — дочернего процесса в этот момент нет.
    const stage = runStage(root, config, {}, {
      onExecutor: (executor) => {
        const resolve = executor.resolveAgent.bind(executor);
        let calls = 0;
        executor.resolveAgent = (...args) => {
          calls += 1;
          if (calls === 2) executor.killCurrentChild();
          return resolve(...args);
        };
      },
    });

    await assert.rejects(stage, (err) => err.code === 'NON_ZERO_EXIT', 'ошибка первого агента');
    assert.ok(!existsSync(join(root, '.workflow', 'tmp', 'cli-agent-called')), 'второй агент не запускался');
  });
});
