/**
 * Проверка конфига выбора модели стадии при старте (validateConfig →
 * validateStageSelection, src/runner.mjs) и поставляемый configs/pipeline.yaml.
 *
 * Что охраняется:
 *  - `selection` — объект только с ключами selector, scores, escalate_on, levels;
 *  - только стадия со скилом execute-task, без model_io и одиночного agent;
 *  - selector обязателен: агент конфига с командой, не пул (сообщения селектора пула
 *    прежние);
 *  - scores обязателен — непустой массив непустых строк; levels — 2..10 непустых строк;
 *  - escalate_on — подмножество [blocked] без повторов;
 *  - agents_by_type.<тип>.selection — только false и только у стадии с selection;
 *  - селектор или оценки пула, все списки которого под выбором, — мёртвый конфиг;
 *    пул, стоящий и в списке без выбора (или у типа с selection: false), — нет;
 *  - поставляемый configs/pipeline.yaml проходит проверку; у execute-task есть
 *    selection, её селектор — агент с командой и prompt_stdin, чисел уровней у агентов нет.
 *
 * Имена агентов нейтральные; файлы конфига тест только читает.
 *
 * Запуск: node --import ./src/tests/_rails-home.mjs --test src/tests/stage-selection-config.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from '../lib/js-yaml.mjs';
import { validateConfig } from '../runner.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const SELECTION = { selector: 'sel-a', scores: ['node', 'facts.js'], levels: ['easy', 'hard'], escalate_on: ['blocked'] };

function config({ stage = {}, agents = {}, stages = {} } = {}) {
  return {
    pipeline: {
      name: 't', version: '1',
      agents: {
        'agent-a': { command: 'claude', args: ['--model', 'model-a'] },
        'agent-b': { command: 'kilo', args: ['-m', 'vendor-a/model-b', 'run'] },
        'sel-a': { command: 'node', args: ['select.js'], prompt_stdin: true },
        'http-a': { kind: 'http', protocol: 'decisions', url: 'https://example.test/d', model: 'm', auth: { env: 'K' } },
        'pool-x': { command: 'kilo', args: ['-m', '{model}', 'run'], models: { list: ['node', 'list.js'], match: ['^p/'] } },
        ...agents,
      },
      stages: {
        'execute-task': { skill: 'execute-task', agents: ['pool-x', 'agent-a', 'agent-b'], selection: SELECTION, ...stage },
        ...stages,
      },
    },
  };
}

const errorsOf = (cfg) => validateConfig(cfg).filter((e) => /selection|never called/.test(e));

describe('validateConfig: selection стадии', () => {
  it('правильная запись — без ошибок', () => {
    assert.deepEqual(validateConfig(config()), []);
    assert.deepEqual(validateConfig(config({ stage: { selection: { ...SELECTION, escalate_on: undefined } } })), []);
  });

  it('правило 1: не объект или лишний ключ', () => {
    assert.match(errorsOf(config({ stage: { selection: ['x'] } }))[0], /invalid selection: expected object/);
    assert.match(errorsOf(config({ stage: { selection: { ...SELECTION, tiers: [1] } } }))[0], /unknown selection key: tiers/);
  });

  it('правило 2: только execute-task, без model_io и одиночного agent', () => {
    assert.match(errorsOf(config({ stage: { skill: 'review-result' } }))[0], /selection is only for the executor stage/);
    assert.ok(errorsOf(config({ stage: { model_io: { prepare: 'a.js', apply: 'b.js' } } })).some((e) => /selection and model_io/.test(e)));
    assert.ok(errorsOf(config({ stage: { agent: 'agent-a' } })).some((e) => /selection and a single agent/.test(e)));
  });

  it('правило 3: selector обязателен, агент с командой, не пул', () => {
    const cases = [
      [{ selector: undefined }, /selection missing required field: selector/],
      [{ selector: 'missing' }, /invalid selection.selector: "missing" is not an agent in pipeline.agents/],
      [{ selector: 'http-a' }, /invalid selection.selector "http-a": selector must be an agent with a command, not kind: http/],
      [{ selector: 'pool-x' }, /invalid selection.selector "pool-x": selector must not be a model pool/],
    ];
    for (const [patch, pattern] of cases) {
      const errors = errorsOf(config({ stage: { selection: { ...SELECTION, ...patch } } }));
      assert.ok(errors.some((e) => pattern.test(e)), `${pattern}: ${errors.join('; ')}`);
    }
  });

  it('сообщения models.selector пула прежние', () => {
    const errors = validateConfig(config({ agents: { 'pool-y': { command: 'kilo', args: ['-m', '{model}'], models: { list: ['x'], match: ['.'], selector: 'http-a' } } } }));
    assert.ok(errors.includes('Agent "pool-y" has invalid models.selector "http-a": selector must be an agent with a command, not kind: http'), errors.join('\n'));
  });

  it('правила 4–6: scores, levels, escalate_on', () => {
    const cases = [
      [{ scores: undefined }, /selection missing required field: scores/],
      [{ scores: [] }, /invalid selection.scores/],
      [{ scores: ['node', ''] }, /invalid selection.scores/],
      [{ levels: ['one'] }, /invalid selection.levels/],
      [{ levels: Array.from({ length: 11 }, (_, i) => `l${i}`) }, /invalid selection.levels/],
      [{ levels: ['a', ' '] }, /invalid selection.levels/],
      [{ levels: [1, 2] }, /invalid selection.levels/],
      [{ escalate_on: ['crash'] }, /invalid selection.escalate_on/],
      [{ escalate_on: ['blocked', 'blocked'] }, /invalid selection.escalate_on/],
      [{ escalate_on: 'blocked' }, /invalid selection.escalate_on/],
    ];
    for (const [patch, pattern] of cases) {
      const errors = errorsOf(config({ stage: { selection: { ...SELECTION, ...patch } } }));
      assert.ok(errors.some((e) => pattern.test(e)), `${JSON.stringify(patch)}: ${errors.join('; ')}`);
    }
  });

  it('правило 7: agents_by_type.<тип>.selection — только false и только у стадии с selection', () => {
    assert.deepEqual(validateConfig(config({ stage: { agents_by_type: { qa: { agents: ['agent-a'], selection: false } } } })), []);
    assert.match(errorsOf(config({ stage: { agents_by_type: { qa: { agents: ['agent-a'], selection: true } } } }))[0], /agents_by_type.qa.selection: only false/);
    const noSelection = config({ stage: { selection: undefined, agents_by_type: { qa: { selection: false } } } });
    assert.match(errorsOf(noSelection)[0], /agents_by_type.qa.selection: false, but the stage has no selection/);
  });

  it('правило 8: селектор/оценки пула, все списки которого под выбором, — мёртвый конфиг', () => {
    const deadPool = { 'pool-x': { command: 'kilo', args: ['-m', '{model}', 'run'], models: { list: ['x'], match: ['.'], selector: 'sel-a', scores: ['node', 's.js'] } } };
    const errors = errorsOf(config({ agents: deadPool }));
    assert.deepEqual(errors, ['Agent "pool-x" has models.selector/models.scores that is never called: every stage listing pool pool-x uses selection (drop them from the pool)']);
    // Пул и в списке стадии без выбора — селектор пула там вызывается.
    const other = { other: { skill: 'execute-task', agents: ['pool-x'] } };
    assert.deepEqual(validateConfig(config({ agents: deadPool, stages: other })), []);
    // Тип с selection: false на своём списке с пулом.
    assert.deepEqual(validateConfig(config({ agents: deadPool, stage: { agents_by_type: { qa: { agents: ['pool-x'], selection: false } } } })), []);
    // Тип с selection: false без своего списка идёт курсором по списку стадии.
    assert.deepEqual(validateConfig(config({ agents: deadPool, stage: { agents_by_type: { qa: { selection: false } } } })), []);
  });

  it('правило 8: встроенные стадии (manual-gate, update-counter) — не использование default_agents', () => {
    const deadPool = { 'pool-x': { command: 'kilo', args: ['-m', '{model}', 'run'], models: { list: ['x'], match: ['.'], selector: 'sel-a', scores: ['node', 's.js'] } } };
    const onDefault = (stages) => {
      const cfg = config({ agents: deadPool, stage: { agents: undefined }, stages });
      cfg.pipeline.default_agents = ['pool-x', 'agent-a'];
      return cfg;
    };
    const dead = ['Agent "pool-x" has models.selector/models.scores that is never called: every stage listing pool pool-x uses selection (drop them from the pool)'];
    assert.deepEqual(errorsOf(onDefault({})), dead);
    const gate = { gate: { type: 'manual-gate', goto: { approved: 'execute-task', rejected: 'execute-task' } } };
    assert.deepEqual(errorsOf(onDefault(gate)), dead);
    const counter = { cnt: { type: 'update-counter', counter: 'task_attempts', goto: { default: 'execute-task' } } };
    assert.deepEqual(errorsOf(onDefault(counter)), dead);
    // Стадия-скил без своего списка идёт по default_agents курсором — селектор пула там вызывается.
    assert.deepEqual(errorsOf(onDefault({ other: { skill: 'review-result' } })), []);
  });
});

describe('поставляемый configs/pipeline.yaml', () => {
  const shipped = () => yaml.load(readFileSync(join(REPO_ROOT, 'configs', 'pipeline.yaml'), 'utf8'));

  it('проходит проверку раннера', () => {
    assert.deepEqual(validateConfig(shipped(), REPO_ROOT), []);
  });

  it('у execute-task — selection, селектор — агент с командой и prompt_stdin; у агентов нет полей уровня', () => {
    const { pipeline } = shipped();
    const { selection } = pipeline.stages['execute-task'];
    assert.ok(selection, 'selection у execute-task');
    const selector = pipeline.agents[selection.selector];
    assert.equal(typeof selector.command, 'string');
    assert.equal(selector.prompt_stdin, true);
    for (const [id, agent] of Object.entries(pipeline.agents)) {
      for (const key of ['tier', 'level', 'score', 'free', 'scores_id']) {
        assert.ok(!Object.hasOwn(agent, key), `агент ${id}: поле ${key} (правило 3 — без данных моделей в конфиге)`);
      }
    }
  });
});
