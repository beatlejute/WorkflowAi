// Реестр тестов каждого скила (tests/index.yaml) обязан ссылаться на агентов, которые есть
// в configs/pipeline.yaml. Инцидент 2026-09-22: прогоны analyze-report шли на kilo-glm,
// kilo-minimax и kilo-deepseek; агентов убрали из конфига, прогоны стали падать с «Agent
// exited with code 1», и кейсы TC-ANALYZE-REPORT-001 и 002 месяц числились красными, хотя
// живая модель давала 5 из 5. Несуществующий агент в реестре — это не красный скил,
// а сломанный прогон, поэтому расхождение ловится тестом, а не глазами.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

const SKILLS_DIR = join(process.cwd(), 'src', 'skills');
const PIPELINE_CONFIG = join(process.cwd(), 'configs', 'pipeline.yaml');

function knownAgents() {
  const cfg = yaml.load(readFileSync(PIPELINE_CONFIG, 'utf8'));
  const agents = cfg?.pipeline?.agents ?? {};
  return new Set(Object.keys(agents));
}

function skillIndexes() {
  const out = [];
  for (const name of readdirSync(SKILLS_DIR)) {
    const dir = join(SKILLS_DIR, name);
    if (!statSync(dir).isDirectory()) continue;
    const indexPath = join(dir, 'tests', 'index.yaml');
    if (!existsSync(indexPath)) continue;
    out.push({ skill: name, indexPath, doc: yaml.load(readFileSync(indexPath, 'utf8')) });
  }
  return out;
}

test('tests/index.yaml каждого скила: target_agents есть в configs/pipeline.yaml', () => {
  const known = knownAgents();
  assert.ok(known.size > 0, 'в configs/pipeline.yaml не найдено ни одного агента');

  const unknown = [];
  for (const { skill, doc } of skillIndexes()) {
    const list = doc?.execution?.target_agents ?? [];
    assert.ok(Array.isArray(list) && list.length > 0, `${skill}: target_agents пуст`);
    for (const agent of list) {
      if (!known.has(agent)) unknown.push(`${skill}: ${agent}`);
    }
  }
  assert.deepEqual(unknown, [], `агентов нет в configs/pipeline.yaml: ${unknown.join(', ')}`);
});

test('tests/index.yaml каждого скила: judge_agent и per-case override — известные агенты', () => {
  const known = knownAgents();
  const unknown = [];
  for (const { skill, doc } of skillIndexes()) {
    const judge = doc?.execution?.judge_agent;
    if (judge && !known.has(judge)) unknown.push(`${skill}: judge_agent ${judge}`);
    for (const c of doc?.cases ?? []) {
      for (const agent of c?.target_agents ?? []) {
        if (!known.has(agent)) unknown.push(`${skill}/${c.id}: ${agent}`);
      }
    }
  }
  assert.deepEqual(unknown, [], `агентов нет в configs/pipeline.yaml: ${unknown.join(', ')}`);
});
