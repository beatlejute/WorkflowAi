/**
 * Судья Jev в действующем configs/pipeline.yaml (PLAN-001, задача 19).
 *
 * Запись `jev` — безынструментный судья тестов скилов: у неё есть CLI-агент для
 * эскалации, порог уверенности в 0..1, и она не стоит ни в одном месте, где
 * назначаются исполнители, и ни в одном `judge_agent` скилов — смена судьи по
 * умолчанию решается по перемеру согласия (compare-judges.js), а не правкой
 * конфига. Файл конфига тест только читает; копия для проверки отказа — во
 * временном каталоге ОС, снимается в after().
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from '../lib/js-yaml.mjs';
import { judgeAgentErrors } from '../lib/skill-judge.mjs';
import { validateConfig } from '../runner.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG_PATH = join(REPO_ROOT, 'configs', 'pipeline.yaml');
const JUDGE = 'jev';

function loadConfig(file) {
  return yaml.load(readFileSync(file, 'utf8'));
}

/** Места, где раннер назначает исполнителей стадий. */
function executorPlaces(pipeline) {
  const places = [];
  if (pipeline.default_agent) places.push(['pipeline.default_agent', pipeline.default_agent]);
  for (const id of pipeline.default_agents || []) places.push(['pipeline.default_agents', id]);
  for (const [stageId, stage] of Object.entries(pipeline.stages || {})) {
    if (!stage || typeof stage !== 'object') continue;
    if (stage.agent) places.push([`${stageId}.agent`, stage.agent]);
    for (const id of stage.agents || []) places.push([`${stageId}.agents`, id]);
    for (const [type, byType] of Object.entries(stage.agents_by_type || {})) {
      for (const id of byType?.agents || []) places.push([`${stageId}.agents_by_type.${type}`, id]);
    }
  }
  return places;
}

/** Нарушения записи судьи в конфиге: проверка записи плюс места исполнителей. */
function judgeConfigProblems(config) {
  const pipeline = config.pipeline;
  const agent = pipeline.agents[JUDGE];
  if (!agent) return [`agent ${JUDGE} is missing`];
  const problems = [...judgeAgentErrors(JUDGE, pipeline.agents)];
  if (typeof agent.escalate_below !== 'number' || agent.escalate_below < 0 || agent.escalate_below > 1) {
    problems.push(`escalate_below must be set in 0..1, got ${agent.escalate_below}`);
  }
  for (const [where, id] of executorPlaces(pipeline)) {
    if (id === JUDGE) problems.push(`${JUDGE} is assigned as executor in ${where}`);
  }
  return problems;
}

describe('judge-config: судья jev в configs/pipeline.yaml', () => {
  const tmpRoots = [];
  after(() => {
    for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
  });

  it('jev — decisions, escalate_to на CLI-агента, порог в 0..1, не исполнитель', () => {
    const config = loadConfig(CONFIG_PATH);
    const agent = config.pipeline.agents[JUDGE];

    assert.equal(agent.kind, 'http');
    assert.equal(agent.protocol, 'decisions');
    assert.deepEqual(agent.auth, { env: 'OPENROUTER_API_KEY' });
    assert.deepEqual(judgeConfigProblems(config), []);
  });

  it('действующий конфиг с jev проходит проверку раннера при старте', () => {
    const errors = validateConfig(loadConfig(CONFIG_PATH), REPO_ROOT);
    assert.deepEqual(errors, []);
  });

  it('jev не стоит в judge_agent ни одного скила', () => {
    const skillsDir = join(REPO_ROOT, 'src', 'skills');
    const judges = [];
    for (const skill of readdirSync(skillsDir)) {
      const index = join(skillsDir, skill, 'tests', 'index.yaml');
      if (!existsSync(index)) continue;
      const judge = loadConfig(index)?.execution?.judge_agent;
      if (judge) judges.push([skill, judge]);
    }
    assert.ok(judges.length > 0, 'в каноне есть скилы с judge_agent');
    assert.deepEqual(judges.filter(([, judge]) => judge === JUDGE), []);
  });

  it('копия конфига с escalate_to: нет-такого — проверка находит нарушение', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-judge-config-'));
    tmpRoots.push(dir);
    const config = loadConfig(CONFIG_PATH);
    config.pipeline.agents[JUDGE].escalate_to = 'нет-такого';
    const copy = join(dir, 'pipeline.yaml');
    writeFileSync(copy, yaml.dump(config));

    const problems = judgeConfigProblems(loadConfig(copy));
    assert.ok(problems.some((line) => line.includes("escalate_to 'нет-такого' not found")), problems.join('\n'));
  });

  it('копия конфига с jev в default_agents — проверка находит нарушение', () => {
    const config = loadConfig(CONFIG_PATH);
    config.pipeline.default_agents = [...(config.pipeline.default_agents || []), JUDGE];

    assert.ok(judgeConfigProblems(config).some((line) => line.includes('pipeline.default_agents')));
  });
});
