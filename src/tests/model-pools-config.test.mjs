/**
 * Проверка конфига пула моделей: src/runner.mjs, validateConfig
 * (validateAgentEntry — поля пула, проверки 1–9; validateConfig — места пула,
 * проверки 10–11). Раздел плана «Запись пула в pipeline.yaml».
 *
 * Чистые вызовы validateConfig на объектах конфига в памяти, без projectRoot:
 * скрипты model_io на диске не ищутся, файлов тест не пишет и каталогов не
 * создаёт. Имена нейтральные: пул pool-a, селектор selector-a, модели
 * prov/vendor/model-N:free.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import yaml from '../lib/js-yaml.mjs';
import { validateConfig } from '../runner.mjs';

const POOL_ARGS = Object.freeze(['-m', '{model}', 'run', '--auto']);

/** Запись пула: копия переданных полей поверх минимальной валидной записи. */
function pool(models = {}, extra = {}) {
  return {
    command: 'node',
    args: [...POOL_ARGS],
    capabilities: ['text'],
    models: {
      list: ['node', 'list-models.js'],
      match: ['^prov/vendor/model-1:free$', '^prov/[^/]+/[^/]+:free$'],
      ...models,
    },
    ...extra,
  };
}

const SELECTOR = Object.freeze({
  command: 'node',
  args: ['select.js'],
  prompt_stdin: true,
  capabilities: ['text'],
});

const HTTP_AGENT = Object.freeze({
  kind: 'http',
  protocol: 'decisions',
  url: 'https://models.example.com/api/decisions',
  model: 'vendor/decisions-model',
  auth: { env: 'TEST_MODEL_KEY' },
  capabilities: ['text'],
});

function config(agents, stages = null, extra = {}) {
  return {
    pipeline: {
      name: 'model-pools-test',
      version: '1.0',
      entry: 'work',
      agents: {
        'cli-a': { command: 'node', args: ['agent.js'], capabilities: ['text'] },
        ...agents,
      },
      stages: stages || {
        work: { agents: ['cli-a'], goto: { passed: { stage: 'end' } } },
      },
      ...extra,
    },
  };
}

/** Ошибка есть и называет агента и нарушенное поле. */
function assertError(errors, pattern, label = '') {
  assert.ok(
    errors.some(e => pattern.test(e)),
    `${label ? `${label}: ` : ''}ожидалась ошибка ${pattern}, получено: ${JSON.stringify(errors)}`
  );
}

// Двойник записей пулов «Поставляемого конфига после Р2» с нейтральными именами:
// якоря YAML дают обоим пулам ОДИН массив args и один массив scores (js-yaml),
// отрицательный просмотр вперёд исключает модель маской.
const SHIPPED_LIKE_YAML = `
pipeline:
  name: "model-pools-shipped-like"
  version: "1.0"
  entry: work
  agents:
    selector-a:
      command: "node"
      args: ["select.js", "--timeout", "15"]
      workdir: "."
      prompt_stdin: true
      tool_less: true
      capabilities: [text]
    pool-a:
      command: "agent-cli"
      args: &pool_args ["-m", "{model}", "--agent", "code", "run", "--auto"]
      workdir: "."
      capabilities: [text]
      models:
        list: ["node", "list-models.js"]
        match:
          - '^prov-a/vendor/model-alpha$'
          - '^prov-a/vendor/model-1:free$'
          - '^prov-a/[^/]+/[^/]+:free$'
        max_per_attempt: 3
        selector: selector-a
        scores: &pool_scores ["node", "scores.js", "--key-file", "~/secret.key"]
    pool-b:
      command: "agent-cli"
      args: *pool_args
      workdir: "."
      capabilities: [text]
      models:
        list: ["node", "list-models.js"]
        match:
          - '^prov-b/vendor/model-1:free$'
          - '^prov-b/(?!vendor/model-2:free$)[^/]+/[^/]+:free$'
        max_per_attempt: 3
        selector: selector-a
        scores: *pool_scores
        gate: ["node", "gate.js", "--timeout", "10"]
    cli-a:
      command: "node"
      args: ["agent.js"]
      capabilities: [text]
  stages:
    work:
      agents: [pool-a, pool-b, cli-a]
      goto:
        passed: { stage: end }
`;

describe('поля пула', () => {
  it('записи пулов с селектором, оценками, шлагбаумом и общими якорями YAML проходят проверку', () => {
    const parsed = yaml.load(SHIPPED_LIKE_YAML);
    // Предпосылка двойника: псевдонимы получили тот же массив, что и якорь.
    assert.equal(parsed.pipeline.agents['pool-a'].args, parsed.pipeline.agents['pool-b'].args);
    assert.deepEqual(validateConfig(parsed), []);
  });

  it('пул без необязательных полей и агент без models и без {model} проходят проверку', () => {
    assert.deepEqual(validateConfig(config({ 'pool-a': pool() })), []);
  });

  it('проверка 1: models у агента kind: http — ошибка', () => {
    const errors = validateConfig(config({ 'http-a': { ...HTTP_AGENT, models: pool().models } }));
    assertError(errors, /Agent "http-a".*models/);
  });

  it('models не объект — ошибка', () => {
    for (const models of ['^prov/', ['^prov/'], null]) {
      const errors = validateConfig(config({ 'pool-a': { ...pool(), models } }));
      assertError(errors, /Agent "pool-a".*models/);
    }
  });

  it('проверка 2: models.list — непустой массив непустых строк', () => {
    for (const list of [undefined, [], [''], ['node', ''], 'node list-models.js', [1]]) {
      const errors = validateConfig(config({ 'pool-a': pool({ list }) }));
      assertError(errors, /Agent "pool-a".*models\.list/);
    }
  });

  it('проверка 3: models.match — непустой массив строк, каждая компилируется без флагов', () => {
    for (const match of [undefined, [], '^prov/', [1], ['^prov/', null]]) {
      const errors = validateConfig(config({ 'pool-a': pool({ match }) }));
      assertError(errors, /Agent "pool-a".*models\.match/);
    }
  });

  it('проверка 3: (?i) и незакрытая скобка в models.match — ошибка компиляции с текстом выражения', () => {
    for (const bad of ['(?i)^prov/vendor/', '^prov/[vendor']) {
      const errors = validateConfig(config({ 'pool-a': pool({ match: ['^prov/ok$', bad] }) }));
      assertError(errors, /Agent "pool-a".*models\.match/);
      assert.ok(errors.some(e => e.includes(bad)), `в ошибке нет выражения ${bad}: ${JSON.stringify(errors)}`);
    }
  });

  // Встроенный модификатор с двоеточием компилируется на новых Node и не компилируется на
  // старых (engines: >=18): один и тот же конфиг был бы годен на одной машине и нет на
  // другой. Запрет — по записи, а не по компиляции на Node этого прогона.
  it('проверка 3: встроенный модификатор (?i:…), (?-i:…) в models.match — ошибка на любой версии Node', () => {
    for (const bad of ['(?i:^PROV/)vendor/', '^prov/(?-i:VENDOR)/', '(?s:.)x']) {
      const errors = validateConfig(config({ 'pool-a': pool({ match: ['^prov/ok$', bad] }) }));
      assertError(errors, /Agent "pool-a".*models\.match.*inline modifier/, bad);
      assert.ok(errors.some(e => e.includes(bad)), `в ошибке нет выражения ${bad}: ${JSON.stringify(errors)}`);
    }
    // Незахватывающая группа и просмотр вперёд — не модификаторы.
    const ok = ['^prov/(?:vendor|other)/', '^prov/(?!vendor/model-2:free$)[^/]+/[^/]+:free$', '^prov/(?<name>v)/'];
    assert.deepEqual(validateConfig(config({ 'pool-a': pool({ match: ok }) })), []);
  });

  it('проверка 4: max_per_attempt — целое не меньше 1', () => {
    for (const max of [0, -1, 1.5, '3', null]) {
      const errors = validateConfig(config({ 'pool-a': pool({ max_per_attempt: max }) }));
      assertError(errors, /Agent "pool-a".*max_per_attempt/);
    }
    for (const max of [1, 3]) {
      assert.deepEqual(validateConfig(config({ 'pool-a': pool({ max_per_attempt: max }) })), []);
    }
  });

  it('проверка 5: {model} в args пула дважды — ошибка', () => {
    const errors = validateConfig(config({ 'pool-a': pool({}, { args: ['-m', '{model}', '--note={model}'] }) }));
    assertError(errors, /Agent "pool-a".*\{model\}/);
  });

  it('проверка 5: {model} нет в args пула — ошибка', () => {
    for (const args of [['run', '--auto'], undefined]) {
      const errors = validateConfig(config({ 'pool-a': pool({}, { args }) }));
      assertError(errors, /Agent "pool-a".*\{model\}/);
    }
  });

  it('проверка 5: {model} у агента без models — ошибка', () => {
    const errors = validateConfig(config({ 'cli-b': { command: 'node', args: ['agent.js', '-m', '{model}'] } }));
    assertError(errors, /Agent "cli-b".*\{model\}/);
  });

  it('проверка 6: @ в id пула — ошибка', () => {
    const errors = validateConfig(config({ 'pool@a': pool() }));
    assertError(errors, /Agent "pool@a".*@/);
  });

  // `<пул>@<полный id>` — id участников: раскрытие записало бы участника поверх агента.
  it('проверка 6: id агента, начинающийся с «<id пула>@», — ошибка; другой id с @ проходит', () => {
    const plain = { command: 'node', args: ['agent.js'], capabilities: ['text'] };
    const errors = validateConfig(config({ 'pool-a': pool(), 'pool-a@prov/vendor/model-1:free': plain }));
    assertError(errors, /Agent "pool-a@prov\/vendor\/model-1:free".*"pool-a"/);
    assert.deepEqual(validateConfig(config({ 'pool-a': pool(), 'cli@work': plain })), []);
  });

  it('проверка 7: selector — существующий агент с командой без models', () => {
    const cases = [
      ['нет такого агента', {}, 'selector-missing'],
      ['пул', { 'pool-b': pool() }, 'pool-b'],
      ['сам пул', {}, 'pool-a'],
      ['kind: http', { 'http-a': HTTP_AGENT }, 'http-a'],
      ['не строка', {}, ['selector-a']],
    ];
    for (const [what, agents, selector] of cases) {
      const errors = validateConfig(config({ 'selector-a': SELECTOR, ...agents, 'pool-a': pool({ selector }) }));
      assertError(errors, /Agent "pool-a".*models\.selector/, what);
    }
    assert.deepEqual(validateConfig(config({ 'selector-a': SELECTOR, 'pool-a': pool({ selector: 'selector-a' }) })), []);
  });

  it('проверка 8: scores без selector — ошибка', () => {
    const errors = validateConfig(config({ 'pool-a': pool({ scores: ['node', 'scores.js'] }) }));
    assertError(errors, /Agent "pool-a".*models\.scores.*selector/);
  });

  it('проверка 8: scores — непустой массив непустых строк', () => {
    for (const scores of [[], [''], 'node scores.js', ['node', 2]]) {
      const errors = validateConfig(config({ 'selector-a': SELECTOR, 'pool-a': pool({ selector: 'selector-a', scores }) }));
      assertError(errors, /Agent "pool-a".*models\.scores/);
    }
  });

  it('проверка 9: gate — непустой массив непустых строк', () => {
    for (const gate of [[], [''], 'node gate.js', { command: 'node' }]) {
      const errors = validateConfig(config({ 'pool-a': pool({ gate }) }));
      assertError(errors, /Agent "pool-a".*models\.gate/);
    }
  });
});

describe('места пула', () => {
  const MODEL_IO = Object.freeze({ prepare: 'prepare.js', apply: 'apply.js' });

  it('два пула в списке обычной стадии проходят проверку', () => {
    const stages = { work: { agents: ['pool-a', 'pool-b', 'cli-a'], goto: { passed: { stage: 'end' } } } };
    assert.deepEqual(validateConfig(config({ 'pool-a': pool(), 'pool-b': pool() }, stages)), []);
  });

  it('пул в agents_by_type и default_agents обычной стадии проходит проверку', () => {
    const stages = { work: { agents_by_type: { impl: { agents: ['pool-a', 'cli-a'] } }, goto: { passed: { stage: 'end' } } } };
    const cfg = config({ 'pool-a': pool() }, stages, { default_agents: ['pool-a', 'cli-a'] });
    assert.deepEqual(validateConfig(cfg), []);
  });

  it('проверка 10: пул в одиночном stage.agent — ошибка', () => {
    const stages = { work: { agent: 'pool-a', goto: { passed: { stage: 'end' } } } };
    const errors = validateConfig(config({ 'pool-a': pool() }, stages));
    assertError(errors, /Stage "work".*"pool-a".*agent/);
  });

  // Со списком agents стадия идёт выбором из списка, одиночный stage.agent не
  // запускается (ветка `stage.agent && !stage.agents` раннера) — {model} в команду не уйдёт.
  it('проверка 10: пул в stage.agent рядом со списком agents — проверка проходит', () => {
    const stages = { work: { agent: 'pool-a', agents: ['pool-a', 'cli-a'], goto: { passed: { stage: 'end' } } } };
    assert.deepEqual(validateConfig(config({ 'pool-a': pool() }, stages)), []);
  });

  it('проверка 11: пул в agents стадии с model_io — ошибка', () => {
    const stages = { ask: { agents: ['cli-a', 'pool-a'], model_io: MODEL_IO, goto: { passed: { stage: 'end' } } } };
    const errors = validateConfig(config({ 'pool-a': pool() }, stages));
    assertError(errors, /Stage "ask".*"pool-a".*model_io/);
  });

  it('проверка 11: пул в agents_by_type стадии с model_io — ошибка', () => {
    const stages = {
      ask: { agents_by_type: { impl: { agents: ['pool-a'] } }, agents: ['cli-a'], model_io: MODEL_IO, goto: { passed: { stage: 'end' } } },
    };
    const errors = validateConfig(config({ 'pool-a': pool() }, stages));
    assertError(errors, /Stage "ask".*"pool-a".*agents_by_type\.impl\.agents/);
  });

  it('проверка 11: пул в default_agents, а у стадии с model_io своего списка нет — ошибка', () => {
    const stages = { ask: { model_io: MODEL_IO, goto: { passed: { stage: 'end' } } } };
    const errors = validateConfig(config({ 'pool-a': pool() }, stages, { default_agents: ['cli-a', 'pool-a'] }));
    assertError(errors, /Stage "ask".*"pool-a".*default_agents/);
  });

  it('пул в default_agents при своём списке у стадии с model_io проходит проверку', () => {
    const stages = { ask: { agents: ['cli-a'], model_io: MODEL_IO, goto: { passed: { stage: 'end' } } } };
    const cfg = config({ 'pool-a': pool() }, stages, { default_agents: ['pool-a', 'cli-a'] });
    assert.deepEqual(validateConfig(cfg), []);
  });
});
