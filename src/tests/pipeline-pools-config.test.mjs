/**
 * Пулы моделей в действующем configs/pipeline.yaml (PLAN-004, задача 47).
 *
 * Пул — запись агента с полем `models`: место в списке стадии, на которое раннер
 * ставит участника `<пул>@<полный id>` (src/lib/model-pools.mjs). Имён пулов,
 * агентов и моделей тест не знает — пулы находит по полю `models`.
 *
 * Что охраняется:
 *  - «записи пулов»: в конфиге есть хотя бы один пул; конфиг проходит проверку
 *    раннера при старте (validateConfig); селектор пула — агент с командой,
 *    промпт которому идёт через stdin; шлагбаум пула, если задан, — команда `node`
 *    (скрипт пакета); ни один агент `target_agents` тестов скилов не пул —
 *    run-skill-tests.js такой прогон отклонил бы;
 *  - «места пулов»: каждый пул стоит хотя бы в одном списке стадии без
 *    `model_io` — иначе участники раскрываются, но не запускаются;
 *  - «правила пулов»: правила health участника ищутся по id пула (healthRulesId),
 *    и они снимают онлайн строку 429 формата kilo 7.7.9 — без ожидания повторов.
 *
 * Файлы конфига тест только читает, своих файлов не пишет.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from '../lib/js-yaml.mjs';
import { validateConfig } from '../runner.mjs';
import { isModelPool, healthRulesId, buildMemberAgent } from '../lib/model-pools.mjs';
import { loadRules, scanStderrForFatalRule } from '../lib/error-classifier.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG_PATH = join(REPO_ROOT, 'configs', 'pipeline.yaml');
const RULES_PATH = join(REPO_ROOT, 'configs', 'agent-health-rules.yaml');
const SKILLS_DIR = join(REPO_ROOT, 'src', 'skills');

// Нейтральная строка stderr kilo 7.7.9: 429 провайдера (`message="stream error"`),
// после которой kilo сам повторяет запрос. Провайдер и модель — заглушки.
const NEUTRAL_429 = 'timestamp=2026-09-27T11:40:25.237Z level=ERROR run=0a1b2c3d message="stream error" providerID=router modelID=router/model-a session.id=ses_0 small=false agent=code mode=primary error.error="AI_APICallError: [Provider] Rate limit exceeded"';
const WORK_LINE = 'timestamp=2026-09-27T11:40:10.000Z level=INFO run=0a1b2c3d message="step finished"';

function loadConfig() {
  return yaml.load(readFileSync(CONFIG_PATH, 'utf8'));
}

/** [id, запись] пулов конфига. */
function pools(pipeline) {
  return Object.entries(pipeline.agents).filter(([, agent]) => isModelPool(agent));
}

/** Пулы конфига; пустой список — нарушение, иначе проверки ниже прошли бы впустую. */
function requirePools(pipeline) {
  const found = pools(pipeline);
  assert.ok(found.length > 0, 'в configs/pipeline.yaml нет ни одного пула (агента с полем models)');
  return found;
}

/** [скил, агент] из `execution.target_agents` индексов тестов скилов. */
function skillTargetAgents() {
  const pairs = [];
  for (const skill of readdirSync(SKILLS_DIR)) {
    const index = join(SKILLS_DIR, skill, 'tests', 'index.yaml');
    if (!existsSync(index)) continue;
    const targets = yaml.load(readFileSync(index, 'utf8'))?.execution?.target_agents;
    for (const agent of Array.isArray(targets) ? targets : []) pairs.push([skill, agent]);
  }
  return pairs;
}

/** Списки агентов стадии: `agents` и `agents_by_type.<тип>.agents`. */
function stageLists(stage) {
  const lists = [];
  if (Array.isArray(stage?.agents)) lists.push(stage.agents);
  for (const byType of Object.values(stage?.agents_by_type ?? {})) {
    if (Array.isArray(byType?.agents)) lists.push(byType.agents);
  }
  return lists;
}

describe('записи пулов', () => {
  it('в конфиге есть хотя бы один пул', () => {
    requirePools(loadConfig().pipeline);
  });

  it('конфиг с пулами проходит проверку раннера при старте', () => {
    const config = loadConfig();
    requirePools(config.pipeline);
    assert.deepEqual(validateConfig(config, REPO_ROOT), []);
  });

  it('селектор пула — агент с командой, промпт через stdin', () => {
    const { pipeline } = loadConfig();
    const problems = [];
    for (const [id, pool] of requirePools(pipeline)) {
      const selectorId = pool.models.selector;
      if (selectorId === undefined) continue;
      const selector = pipeline.agents[selectorId];
      if (!selector) {
        problems.push(`${id}: селектор ${selectorId} не найден`);
        continue;
      }
      if (selector.kind === 'http' || typeof selector.command !== 'string' || selector.command.trim() === '') {
        problems.push(`${id}: селектор ${selectorId} — не агент с командой`);
      }
      if (selector.prompt_stdin !== true) {
        problems.push(`${id}: у селектора ${selectorId} нет prompt_stdin: true`);
      }
      if (isModelPool(selector)) problems.push(`${id}: селектор ${selectorId} — сам пул`);
    }
    assert.deepEqual(problems, []);
  });

  it('шлагбаум пула, если задан, — команда node', () => {
    const { pipeline } = loadConfig();
    const problems = requirePools(pipeline)
      .filter(([, pool]) => pool.models.gate !== undefined)
      .filter(([, pool]) => !Array.isArray(pool.models.gate) || pool.models.gate[0] !== 'node')
      .map(([id, pool]) => `${id}: gate ${JSON.stringify(pool.models.gate)}`);
    assert.deepEqual(problems, []);
  });

  it('ни один агент target_agents тестов скилов не пул', () => {
    const { pipeline } = loadConfig();
    requirePools(pipeline);
    const targets = skillTargetAgents();
    assert.ok(targets.length > 0, 'в каноне есть скилы с target_agents');
    const offenders = targets
      .filter(([, agent]) => isModelPool(pipeline.agents[agent]))
      .map(([skill, agent]) => `${skill}: ${agent}`);
    assert.deepEqual(offenders, []);
  });
});

describe('места пулов', () => {
  it('каждый пул стоит хотя бы в одном списке стадии без model_io', () => {
    const { pipeline } = loadConfig();
    const placed = new Set();
    for (const stage of Object.values(pipeline.stages)) {
      if (!stage || typeof stage !== 'object' || stage.model_io !== undefined) continue;
      for (const list of stageLists(stage)) for (const id of list) placed.add(id);
    }
    const unplaced = requirePools(pipeline).map(([id]) => id).filter((id) => !placed.has(id));
    assert.deepEqual(unplaced, [], `пулы без места в списке стадии: ${unplaced.join(', ')}`);
  });
});

describe('правила пулов', () => {
  it('правила health участника (по id пула) снимают онлайн строку 429 kilo 7.7.9', () => {
    const { pipeline } = loadConfig();
    const rules = loadRules(REPO_ROOT, RULES_PATH);
    const stderr = [WORK_LINE, NEUTRAL_429].join('\n') + '\n';
    const problems = [];
    for (const [id, pool] of requirePools(pipeline)) {
      const member = buildMemberAgent(id, pool, { id: 'router/vendor/model-a:free', capabilities: [] });
      const rulesId = healthRulesId(member, `${id}@router/vendor/model-a:free`);
      const hit = scanStderrForFatalRule(rules, rulesId, stderr);
      if (!hit) {
        problems.push(`${id}: правила «${rulesId}» не снимают строку 429`);
      } else if (hit.class !== 'unavailable') {
        problems.push(`${id}: правило ${hit.rule_id} класса ${hit.class}, ожидался unavailable`);
      }
    }
    assert.deepEqual(problems, []);
  });
});
