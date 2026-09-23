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
    // Фикстуры раннера (`__test-*`) теперь создаются в каталоге из
    // WORKFLOW_SKILLS_DIR (os.tmpdir), а не в каноническом src/skills, так что ловить
    // их на лету, как 2026-09-23, уже нечем. Фильтр остаётся сеткой на случай
    // протёкшего каталога из старого прогона: реестром тестов он всё равно не является.
    if (name.startsWith('__') || name.startsWith('.')) continue;
    const dir = join(SKILLS_DIR, name);
    if (!statSync(dir).isDirectory()) continue;
    const indexPath = join(dir, 'tests', 'index.yaml');
    if (!existsSync(indexPath)) continue;
    out.push({ skill: name, dir, indexPath, doc: yaml.load(readFileSync(indexPath, 'utf8')) });
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

// Скил на рельсах объявляет каждый узел отдельным вызовом cli.mjs, поэтому прогон идёт
// заметно дольше прозаического. Инцидент 2026-09-23: при бюджете 1200 с на пробу
// gemini-flash-lite и gpt-luna упирались в таймаут на TC-ANALYZE-REPORT-001 и 002 — кейсы
// числились красными, хотя судья ставил высшую оценку там, где проба доходила до конца.
// Решение стейкхолдера: для скилов на рельсах бюджет не меньше 2400 с.
const RAILS_MIN_TIMEOUT_S = 2400;

test('tests/index.yaml скила на рельсах: default_timeout_s не меньше 2400 с', () => {
  const small = [];
  for (const { skill, dir, doc } of skillIndexes()) {
    if (!existsSync(join(dir, 'rails.yaml'))) continue;
    const t = doc?.execution?.default_timeout_s;
    assert.equal(typeof t, 'number', `${skill}: default_timeout_s не задан`);
    if (t < RAILS_MIN_TIMEOUT_S) small.push(`${skill}: ${t}`);
  }
  assert.deepEqual(small, [], `бюджет пробы меньше ${RAILS_MIN_TIMEOUT_S} с: ${small.join(', ')}`);
});
