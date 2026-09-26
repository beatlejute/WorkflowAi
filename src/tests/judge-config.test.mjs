/**
 * Судьи тестов скилов в действующем configs/pipeline.yaml (PLAN-001).
 *
 * Судья — любой агент реестра, названный в `execution.judge_agent` скила; имени
 * конкретного судьи тест не знает. Каждый такой агент и каждый агент с полями
 * переоценки (`escalate_to` и соседние) проходит проверку записи судьи
 * (skill-judge.mjs, judgeAgentErrors) — иначе прогон тестов скила упал бы до
 * первого кейса. Файл конфига тест только читает; копия для проверки отказа — во
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
const SKILLS_DIR = join(REPO_ROOT, 'src', 'skills');

function loadYaml(file) {
  return yaml.load(readFileSync(file, 'utf8'));
}

/** [skill, judge_agent] по всем скилам канона. */
function skillJudges() {
  const judges = [];
  for (const skill of readdirSync(SKILLS_DIR)) {
    const index = join(SKILLS_DIR, skill, 'tests', 'index.yaml');
    if (!existsSync(index)) continue;
    const judge = loadYaml(index)?.execution?.judge_agent;
    if (judge) judges.push([skill, judge]);
  }
  return judges;
}

/** Нарушения записей судей: судьи скилов и агенты с полями переоценки. */
function judgeProblems(config) {
  const agents = config.pipeline.agents;
  const ids = new Set(skillJudges().map(([, judge]) => judge));
  for (const [id, agent] of Object.entries(agents)) {
    if (agent && (agent.escalate_to !== undefined || agent.escalate_below !== undefined || agent.escalation_share !== undefined)) ids.add(id);
  }
  return [...ids].flatMap((id) => judgeAgentErrors(id, agents));
}

describe('judge-config: судьи тестов скилов в configs/pipeline.yaml', () => {
  const tmpRoots = [];
  after(() => {
    for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
  });

  it('судья каждого скила и каждый агент с переоценкой проходят проверку записи судьи', () => {
    assert.ok(skillJudges().length > 0, 'в каноне есть скилы с judge_agent');
    assert.deepEqual(judgeProblems(loadYaml(CONFIG_PATH)), []);
  });

  it('действующий конфиг проходит проверку раннера при старте', () => {
    assert.deepEqual(validateConfig(loadYaml(CONFIG_PATH), REPO_ROOT), []);
  });

  it('копия конфига, где судья скила переоценивается несуществующим агентом, — нарушение', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-judge-config-'));
    tmpRoots.push(dir);
    const config = loadYaml(CONFIG_PATH);
    const [, judge] = skillJudges()[0];
    config.pipeline.agents[judge].escalate_to = 'нет-такого';
    const copy = join(dir, 'pipeline.yaml');
    writeFileSync(copy, yaml.dump(config));

    const problems = judgeProblems(loadYaml(copy));
    assert.ok(problems.some((line) => line.includes("escalate_to 'нет-такого' not found")), problems.join('\n'));
  });

  it('копия конфига, где судья скила — безынструментный агент, — нарушение', () => {
    const config = loadYaml(CONFIG_PATH);
    const [, judge] = skillJudges()[0];
    config.pipeline.agents[judge] = {
      kind: 'http', protocol: 'decisions', url: 'https://example.com/d', model: 'm', auth: { env: 'K' },
    };

    assert.ok(judgeProblems(config).some((line) => line.includes('must be an agent with a command')));
  });
});
