/**
 * Проверка конфига пайплайна для безынструментных агентов (`kind: http`) и обмена
 * стадии с моделью (`model_io`): src/runner.mjs, validateConfig.
 *
 * Ошибочные конфиги прогоняются через экспортированную runPipeline — так же, как
 * их увидит запуск пайплайна: код 1 и список ошибок в `details` до записи lock'а.
 * Валидные — через validateConfig напрямую: runPipeline с валидным конфигом
 * запустил бы сам пайплайн.
 *
 * Каждый проект — временный каталог в os.tmpdir(), снимается в after(). В каталоги
 * репозитория тест не пишет; configs/pipeline.yaml только читает.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from '../lib/js-yaml.mjs';
import { runPipeline, validateConfig } from '../runner.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOTS = [];

after(() => {
  for (const root of ROOTS) rmSync(root, { recursive: true, force: true });
});

const CHAT_AGENT = Object.freeze({
  kind: 'http',
  protocol: 'chat',
  url: 'https://openrouter.ai/api/v1/chat/completions',
  model: 'vendor/vision-model',
  auth: { env: 'TEST_MODEL_KEY' },
  capabilities: ['text', 'multimodal'],
});

const DECISIONS_AGENT = Object.freeze({
  kind: 'http',
  protocol: 'decisions',
  url: 'https://openrouter.ai/api/alpha/decisions',
  model: 'vendor/decisions-model',
  auth: { kilo_oauth: true },
  timeout_s: 60,
  capabilities: ['text'],
});

function baseConfig(agents = {}, stages = null) {
  return {
    pipeline: {
      name: 'http-agents-test',
      version: '1.0',
      entry: 'review',
      agents: {
        'cli-a': { command: 'node', args: ['agent.js'], capabilities: ['text'] },
        ...agents,
      },
      stages: stages || {
        review: { agents: ['cli-a'], goto: { passed: { stage: 'end' } } },
      },
    },
  };
}

function makeProject({ scripts = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wf-http-agents-'));
  ROOTS.push(root);
  mkdirSync(join(root, '.workflow', 'config'), { recursive: true });
  for (const script of scripts) {
    const file = join(root, script);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'console.log("---RESULT---\\nstatus: passed\\n---RESULT---");\n');
  }
  return root;
}

/** Конфиг через runPipeline: код и ошибки проверки. JSON — подмножество YAML. */
async function runWithConfig(config, projectOptions) {
  const root = makeProject(projectOptions);
  writeFileSync(join(root, '.workflow', 'config', 'pipeline.yaml'), JSON.stringify(config, null, 2));
  return runPipeline(['--project', root]);
}

function assertRejected(result, ...fragments) {
  assert.equal(result.exitCode, 1, `ожидался код 1, получено ${JSON.stringify(result)}`);
  assert.ok(Array.isArray(result.details), 'details — список ошибок проверки');
  const hit = result.details.find((line) => fragments.every((f) => line.includes(f)));
  assert.ok(hit, `нет ошибки с ${JSON.stringify(fragments)} в ${JSON.stringify(result.details)}`);
}

// ---------------------------------------------------------------------------
// Задача 1: запись агента
// ---------------------------------------------------------------------------

describe('validateConfig: запись агента kind: http', () => {
  it('kind: http без url — код 1, в details агент и поле', async () => {
    const { url, ...noUrl } = CHAT_AGENT;
    const result = await runWithConfig(baseConfig({ 'vision-chat': noUrl }));
    assertRejected(result, '"vision-chat"', 'url');
  });

  for (const field of ['protocol', 'model', 'auth']) {
    it(`kind: http без ${field} — ошибка с агентом и полем`, async () => {
      const agent = { ...CHAT_AGENT };
      delete agent[field];
      const result = await runWithConfig(baseConfig({ 'vision-chat': agent }));
      assertRejected(result, '"vision-chat"', field);
    });
  }

  it('неизвестное значение kind — ошибка', async () => {
    const result = await runWithConfig(baseConfig({ odd: { kind: 'grpc', command: 'node' } }));
    assertRejected(result, '"odd"', 'unknown kind', 'grpc');
  });

  it('protocol вне chat и decisions — ошибка', async () => {
    const result = await runWithConfig(baseConfig({ 'vision-chat': { ...CHAT_AGENT, protocol: 'completions' } }));
    assertRejected(result, '"vision-chat"', 'protocol', 'completions');
  });

  const badAuths = [
    ['строка вместо объекта', 'TEST_MODEL_KEY'],
    ['пустое имя переменной', { env: '' }],
    ['kilo_oauth: false', { kilo_oauth: false }],
    ['обе формы сразу', { env: 'TEST_MODEL_KEY', kilo_oauth: true }],
    ['ключ прямо в конфиге', { key: 'sk-test' }],
    ['пустой путь файла', { file: '  ' }],
  ];
  it('auth: { file: <путь> } проходит проверку', () => {
    assert.deepEqual(validateConfig(baseConfig({ 'vision-chat': { ...CHAT_AGENT, auth: { file: '~/.workflow/secrets/model.key' } } }), makeProject()), []);
  });

  it('prompt_stdin не true/false у агента с командой — ошибка', async () => {
    const result = await runWithConfig(baseConfig({ judge: { command: 'node', args: ['x.js'], prompt_stdin: 'yes' } }));
    assertRejected(result, '"judge"', 'prompt_stdin');
  });

  for (const [label, auth] of badAuths) {
    it(`auth не в одной из форм (${label}) — ошибка`, async () => {
      const result = await runWithConfig(baseConfig({ 'vision-chat': { ...CHAT_AGENT, auth } }));
      assertRejected(result, '"vision-chat"', 'auth');
    });
  }

  // Ключ уходит в заголовке Authorization: http допустим только до своей машины.
  for (const url of ['http://openrouter.ai/api/v1/chat/completions', 'http://10.0.0.5:8080/v1', 'ftp://127.0.0.1/x', 'not a url']) {
    it(`url ${url} — ошибка`, async () => {
      const result = await runWithConfig(baseConfig({ 'vision-chat': { ...CHAT_AGENT, url } }));
      assertRejected(result, '"vision-chat"', 'url');
    });
  }

  for (const url of ['http://127.0.0.1:8080/v1', 'http://localhost/v1', 'http://[::1]:9/v1']) {
    it(`url ${url} (своя машина) проходит проверку`, () => {
      assert.deepEqual(validateConfig(baseConfig({ 'vision-chat': { ...CHAT_AGENT, url } }), makeProject()), []);
    });
  }

  it('kind: http с полем command — ошибка', async () => {
    const result = await runWithConfig(baseConfig({ 'vision-chat': { ...CHAT_AGENT, command: 'kilo' } }));
    assertRejected(result, '"vision-chat"', 'command');
  });

  it('kind: cli без command — ошибка', async () => {
    const result = await runWithConfig(baseConfig({ broken: { kind: 'cli', args: [] } }));
    assertRejected(result, '"broken"', 'command');
  });

  it('запись без kind и без command — ошибка', async () => {
    const result = await runWithConfig(baseConfig({ broken: { args: ['x'] } }));
    assertRejected(result, '"broken"', 'command');
  });

  for (const timeout of [0, -5, '120']) {
    it(`timeout_s = ${JSON.stringify(timeout)} — ошибка`, async () => {
      const result = await runWithConfig(baseConfig({ 'decisions-http': { ...DECISIONS_AGENT, timeout_s: timeout } }));
      assertRejected(result, '"decisions-http"', 'timeout_s');
    });
  }

  it('валидная запись chat проходит проверку', () => {
    assert.deepEqual(validateConfig(baseConfig({ 'vision-chat': { ...CHAT_AGENT } }), makeProject()), []);
  });

  it('валидная запись decisions проходит проверку', () => {
    assert.deepEqual(validateConfig(baseConfig({ 'decisions-http': { ...DECISIONS_AGENT } }), makeProject()), []);
  });

  it('rails_host вне kilo и claude — ошибка: опечатка молча выключила бы проверку ответа без инструментов', async () => {
    const result = await runWithConfig(baseConfig({ wrapped: { command: 'my-kilo.cmd', args: ['run'], rails_host: 'Kilo' } }));
    assertRejected(result, '"wrapped"', 'rails_host');
    const ok = baseConfig({ wrapped: { command: 'my-kilo.cmd', args: ['run'], rails_host: 'kilo', capabilities: ['text'] } });
    assert.deepEqual(validateConfig(ok, makeProject()), []);
  });

  it('запись без kind с command проходит проверку', () => {
    const config = baseConfig({ plain: { command: 'kilo', args: ['run'], capabilities: ['text'] } });
    assert.deepEqual(validateConfig(config, makeProject()), []);
  });

  it('действующий configs/pipeline.yaml проходит проверку', () => {
    const config = yaml.load(readFileSync(join(REPO_ROOT, 'configs', 'pipeline.yaml'), 'utf8'));
    assert.deepEqual(validateConfig(config, REPO_ROOT), []);
  });
});

// ---------------------------------------------------------------------------
// Задача 3: обмен стадии с моделью
// ---------------------------------------------------------------------------

const PREPARE = 'scripts/prepare.mjs';
const APPLY = 'scripts/apply.mjs';

function modelIoConfig(modelIo, agents = ['cli-a']) {
  return baseConfig({}, {
    review: { agents, model_io: modelIo, goto: { passed: { stage: 'end' } } },
  });
}

describe('validateConfig: model_io стадии', () => {
  it('model_io.apply на несуществующий файл — код 1, в сообщении стадия и путь', async () => {
    const result = await runWithConfig(
      modelIoConfig({ prepare: PREPARE, apply: 'scripts/missing-apply.mjs' }),
      { scripts: [PREPARE] }
    );
    assertRejected(result, '"review"', 'scripts/missing-apply.mjs');
  });

  it('model_io.prepare на несуществующий файл — ошибка', async () => {
    const result = await runWithConfig(
      modelIoConfig({ prepare: 'scripts/missing-prepare.mjs', apply: APPLY }),
      { scripts: [APPLY] }
    );
    assertRejected(result, '"review"', 'scripts/missing-prepare.mjs');
  });

  for (const step of ['prepare', 'apply']) {
    it(`нет ${step} — ошибка`, async () => {
      const modelIo = { prepare: PREPARE, apply: APPLY };
      delete modelIo[step];
      const result = await runWithConfig(modelIoConfig(modelIo), { scripts: [PREPARE, APPLY] });
      assertRejected(result, '"review"', step);
    });
  }

  for (const options of [['a'], 'strict', 7]) {
    it(`options = ${JSON.stringify(options)} — ошибка`, async () => {
      const result = await runWithConfig(
        modelIoConfig({ prepare: PREPARE, apply: APPLY, options }),
        { scripts: [PREPARE, APPLY] }
      );
      assertRejected(result, '"review"', 'options');
    });
  }

  it('model_io не объект — ошибка', async () => {
    const result = await runWithConfig(modelIoConfig('scripts/prepare.mjs'));
    assertRejected(result, '"review"', 'model_io');
  });

  it('валидная стадия с model_io проходит проверку', () => {
    const root = makeProject({ scripts: [PREPARE, APPLY] });
    const config = modelIoConfig({ prepare: PREPARE, apply: APPLY, options: { images: true } });
    assert.deepEqual(validateConfig(config, root), []);
  });

  // Репозиторий канона: `.workflow/src/skills` — ссылка на установленную копию,
  // в CI каталога `.workflow/` нет; скрипт скила лежит в `src/skills/…`.
  const CANON_PREPARE = '.workflow/src/skills/x/scripts/p.js';
  const CANON_APPLY = '.workflow/src/skills/x/scripts/a.js';

  it('путь .workflow/src/… без файла, но с файлом в src/… от корня — проходит проверку', () => {
    const root = makeProject({ scripts: ['src/skills/x/scripts/p.js', 'src/skills/x/scripts/a.js'] });
    const config = modelIoConfig({ prepare: CANON_PREPARE, apply: CANON_APPLY });
    assert.deepEqual(validateConfig(config, root), []);
  });

  it('путь .workflow/src/… без файла ни там, ни в src/… — ошибка script not found', async () => {
    const result = await runWithConfig(modelIoConfig({ prepare: CANON_PREPARE, apply: CANON_APPLY }));
    assertRejected(result, '"review"', 'model_io.prepare script not found', CANON_PREPARE);
    assertRejected(result, '"review"', 'model_io.apply script not found', CANON_APPLY);
  });
});

// ---------------------------------------------------------------------------
// Задача 5: безынструментный агент — только в стадиях с model_io
// ---------------------------------------------------------------------------

function placementConfig({ where, withModelIo }) {
  const stage = { goto: { passed: { stage: 'end' } } };
  if (where === 'agent') stage.agent = 'vision-chat';
  if (where === 'agents') stage.agents = ['cli-a', 'vision-chat'];
  if (where === 'agents_by_type') {
    stage.agents = ['cli-a'];
    stage.agents_by_type = { review: { agents: ['vision-chat', 'cli-a'] } };
  }
  if (withModelIo) stage.model_io = { prepare: PREPARE, apply: APPLY };
  return baseConfig({ 'vision-chat': { ...CHAT_AGENT } }, { review: stage });
}

describe('validateConfig: где допустим агент kind: http', () => {
  for (const where of ['agent', 'agents', 'agents_by_type']) {
    it(`${where} стадии без model_io — код 1, в сообщении стадия и агент`, async () => {
      const result = await runWithConfig(placementConfig({ where, withModelIo: false }));
      assertRejected(result, '"review"', '"vision-chat"', 'model_io');
    });

    it(`${where} стадии с model_io — проходит`, () => {
      const root = makeProject({ scripts: [PREPARE, APPLY] });
      assert.deepEqual(validateConfig(placementConfig({ where, withModelIo: true }), root), []);
    });
  }

  it('pipeline.default_agents — ошибка всегда', async () => {
    const config = baseConfig({ 'vision-chat': { ...CHAT_AGENT } });
    config.pipeline.default_agents = ['cli-a', 'vision-chat'];
    const result = await runWithConfig(config);
    assertRejected(result, 'default_agents', '"vision-chat"');
  });

  it('pipeline.default_agent — ошибка всегда', async () => {
    const config = baseConfig({ 'vision-chat': { ...CHAT_AGENT } });
    config.pipeline.default_agent = 'vision-chat';
    const result = await runWithConfig(config);
    assertRejected(result, 'default_agent', '"vision-chat"');
  });

  it('CLI-агент в стадии с model_io допустим', () => {
    const root = makeProject({ scripts: [PREPARE, APPLY] });
    const config = modelIoConfig({ prepare: PREPARE, apply: APPLY }, ['cli-a']);
    assert.deepEqual(validateConfig(config, root), []);
  });
});
