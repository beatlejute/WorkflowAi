/**
 * Каталог скила в промпте стадии (PromptBuilder.build, src/runner.mjs).
 *
 * 2026-09-30: стратегию исполнения execute-task прочитали 2 сессии из 16. Промпт называл
 * только имя скила, агент искал файлы по имени, а каталог скила в проекте —
 * `.workflow/src/skills/<скил>/`, ссылка на канон, и поиск через неё файл не находит.
 *
 * Что охраняется:
 *  - стадия со skill, у которой в проекте есть `.workflow/src/skills/<скил>/SKILL.md`, —
 *    вторая строка промпта называет каталог скила и SKILL.md; первая строка — имя скила,
 *    как прежде (по ней агент узнаёт скил, скрипты разбирают блок Context после неё);
 *  - агент получает эту строку в промпте (сквозной запуск);
 *  - SKILL.md нет в проекте, стадия без skill, стадия с model_io, имя скила с путём —
 *    строки нет.
 *
 * Корень — временный каталог ОС. Имена агентов нейтральные.
 *
 * Запуск: node --import ./src/tests/_rails-home.mjs --test src/tests/runner-prompt-skill-files.test.mjs
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { StageExecutor } from '../runner.mjs';

const TEMPS = [];
afterEach(() => {
  for (const dir of TEMPS.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const LINE = 'Файлы скила: .workflow/src/skills/demo-skill/ — начни с .workflow/src/skills/demo-skill/SKILL.md; '
  + 'пути к файлам скила (algorithms/, knowledge/, templates/) — от корня проекта.';

function makeRoot({ skillFile = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-prompt-skill-'));
  TEMPS.push(root);
  const dir = path.join(root, '.workflow', 'src', 'skills', 'demo-skill');
  fs.mkdirSync(dir, { recursive: true });
  if (skillFile) fs.writeFileSync(path.join(dir, 'SKILL.md'), '# demo-skill\n');
  return root;
}

function executorFor(root, agents = {}) {
  const config = {
    pipeline: {
      name: 'prompt-skill-files', version: '1.0', entry: 'none', context: {}, stages: {},
      execution: { artifact_snapshot_enabled: false, timeout_per_stage: 30 },
      agents,
    },
  };
  return new StageExecutor(config, { plan_id: 'PLAN-1' }, {}, {}, null, null, root);
}

test('стадия со skill: вторая строка промпта — каталог скила и SKILL.md, первая — имя скила', () => {
  const executor = executorFor(makeRoot());
  const lines = executor.promptBuilder.build({ skill: 'demo-skill', instructions: 'x' }, 'work').split('\n');
  assert.equal(lines[0], 'demo-skill');
  assert.equal(lines[1], LINE);
  assert.ok(lines.includes('Context:') && lines.includes('  plan_id: PLAN-1'), lines.join('\n'));
});

test('сквозной запуск: агент получает строку каталога скила в промпте', async () => {
  const root = makeRoot();
  const captured = path.join(root, 'prompt.txt');
  const agent = path.join(root, 'agent.mjs');
  fs.writeFileSync(agent, `import fs from 'node:fs';
let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(captured)}, input);
  console.log('---RESULT---\\nstatus: default\\n---RESULT---');
});
`);
  const executor = executorFor(root, { 'agent-a': { command: 'node', args: [agent], prompt_stdin: true, capabilities: ['text'] } });
  await executor.executeWithFallback('work', { agents: ['agent-a'], skill: 'demo-skill' });
  assert.equal(fs.readFileSync(captured, 'utf8').split('\n')[1], LINE);
});

test('строки нет: SKILL.md нет в проекте, стадия без skill, стадия с model_io, имя скила с путём', () => {
  const noSkillFile = executorFor(makeRoot({ skillFile: false }));
  assert.doesNotMatch(noSkillFile.promptBuilder.build({ skill: 'demo-skill' }, 'work'), /Файлы скила/);

  const executor = executorFor(makeRoot());
  assert.doesNotMatch(executor.promptBuilder.build({ agent: 'script-x' }, 'script-stage'), /Файлы скила/);
  assert.doesNotMatch(
    executor.promptBuilder.build({ skill: 'demo-skill', model_io: { prepare: 'p.js', apply: 'a.js' } }, 'review'),
    /Файлы скила/,
  );
  assert.doesNotMatch(executor.promptBuilder.build({ skill: '../demo-skill' }, 'work'), /Файлы скила/);
});
