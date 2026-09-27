/**
 * Инструкции типов задач (`agents_by_type.<type>.instructions`) в действующем
 * configs/pipeline.yaml.
 *
 * Раннер кладёт их в промпт блоком «Instructions:», а скил стадии передаёт агенту в
 * WORKFLOW_RAILS_SKILL: по нему хук ведёт состояние рельс, по его терминалу раннер
 * проверяет финальный ответ, `start` другого скила рельсы отклоняют (src/rails/README.md §5).
 * Прогон PulseProxy 2026-09-27: «Твоя роль: manual-testing» на стадии execute-task
 * claude-haiku принимал за скил — стартовал manual-testing или целился в его терминал,
 * и output-check раннера отклонял ответ.
 *
 * Что охраняется (имён агентов и типов тест не знает):
 *  - инструкция типа называет скил своей стадии и терминальный узел его графа;
 *  - не называет ни одного другого скила из src/skills;
 *  - список агентов типа не пуст.
 *
 * Файл конфига тест только читает.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from '../lib/js-yaml.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const config = yaml.load(readFileSync(join(REPO_ROOT, 'configs', 'pipeline.yaml'), 'utf8'));
const stages = config.pipeline.stages;

const SKILLS_DIR = join(REPO_ROOT, 'src', 'skills');
const skills = readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(SKILLS_DIR, e.name, 'SKILL.md')))
  .map((e) => e.name);

// Имя скила — целым словом: `coach` не должен находиться внутри `coach-backlog`, и наоборот.
function namesSkill(text, skill) {
  const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}_-])${escaped}(?![\\p{L}\\p{N}_-])`, 'u').test(text);
}

const cases = [];
for (const [stageId, stage] of Object.entries(stages)) {
  if (!stage || typeof stage.skill !== 'string' || !stage.agents_by_type) continue;
  for (const [type, byType] of Object.entries(stage.agents_by_type)) {
    if (byType && typeof byType.instructions === 'string') cases.push({ stageId, stage, type, byType });
  }
}

test('в конфиге есть инструкции типов — проверять есть что', () => {
  assert.ok(cases.length > 0, 'ни у одной стадии со скилом нет agents_by_type.<type>.instructions');
  assert.ok(skills.length > 1, `в ${SKILLS_DIR} меньше двух скилов — проверка «чужого скила» пустая`);
});

for (const { stageId, stage, type, byType } of cases) {
  test(`${stageId}.agents_by_type.${type}: инструкция называет скил стадии и его терминальный узел`, () => {
    assert.ok(namesSkill(byType.instructions, stage.skill), `нет имени скила стадии «${stage.skill}»: ${byType.instructions}`);
    assert.match(byType.instructions, /терминальн/i);
  });

  test(`${stageId}.agents_by_type.${type}: инструкция не называет другой скил`, () => {
    const foreign = skills.filter((s) => s !== stage.skill && namesSkill(byType.instructions, s));
    assert.deepEqual(foreign, [], `чужие скилы в инструкции: ${foreign.join(', ')}`);
    assert.doesNotMatch(byType.instructions, /Твоя роль:/);
  });

  test(`${stageId}.agents_by_type.${type}: список агентов не пуст`, () => {
    assert.ok(Array.isArray(byType.agents) && byType.agents.length > 0);
  });
}
