/**
 * Пул моделей (агент с `models`) в target_agents тестов скилов отклоняется до
 * запуска агентов: src/scripts/run-skill-tests.js, validateAgents (index.yaml, --agent)
 * и rejectCaseModelPools (свой target_agents файла кейса). Запись агента
 * тесты скилов берут напрямую (runL2Evaluation) — `{model}` ушёл бы в команду, а
 * `:` из id участника — в путь `current/<агент>/`.
 *
 * Раннер запускается подпроцессом, как в run-skill-tests.test.mjs. Корень
 * изоляции — временный каталог ОС на каждый тест (удаление в afterEach): в нём
 * `.workflow/` (по нему раннер находит корень проекта от cwd), каталог скилов
 * (WORKFLOW_SKILLS_DIR), pipeline.yaml (--pipeline) и агент-зонд. Зонд пишет
 * файл-метку при вызове — по ней видно, запускался ли кто-то до отказа.
 * Имена нейтральные: pool-a, cli-a, judge-a.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RUNNER_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'run-skill-tests.js');
const SKILL = 'pool-target-probe';
const CASE_ID = 'TC-POOL-TARGET-001';
const REFUSAL = /error: .*pool-a.*пул моделей нельзя указывать в target_agents, назовите конкретного агента/;

const yamlPath = (p) => p.replace(/\\/g, '/');

let root;
let skillsDir;
let pipelinePath;
let marks;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wf-pool-target-'));
  skillsDir = join(root, 'skills');
  pipelinePath = join(root, 'pipeline.yaml');
  marks = {
    cli: join(root, 'cli-a.called'),
    pool: join(root, 'pool-a.called'),
    judge: join(root, 'judge-a.called'),
  };
  mkdirSync(join(root, '.workflow'), { recursive: true });

  const probe = join(root, 'probe-agent.mjs');
  // Промпт — последний аргумент, метка — первый после скрипта. Ответ годится и
  // исполнителю, и судье (score).
  writeFileSync(probe, [
    "import fs from 'node:fs';",
    "fs.writeFileSync(process.argv[2], 'called');",
    "console.log('---RESULT---');",
    "console.log('status: passed');",
    "console.log('score: 5');",
    "console.log('reason: probe');",
    "console.log('---RESULT---');",
    '',
  ].join('\n'));

  writeFileSync(pipelinePath, [
    'pipeline:',
    '  name: "pool-target-test"',
    '  version: "1.0"',
    '  agents:',
    '    cli-a:',
    '      command: "node"',
    `      args: ["${yamlPath(probe)}", "${yamlPath(marks.cli)}"]`,
    '      capabilities: [text]',
    '    pool-a:',
    '      command: "node"',
    `      args: ["${yamlPath(probe)}", "${yamlPath(marks.pool)}", "{model}"]`,
    '      capabilities: [text]',
    '      models:',
    '        list: ["node", "list-models.js"]',
    "        match: ['^prov/vendor/model-1:free$']",
    '    judge-a:',
    '      command: "node"',
    `      args: ["${yamlPath(probe)}", "${yamlPath(marks.judge)}"]`,
    '      capabilities: [text]',
    '',
  ].join('\n'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * Скил с одним кейсом L2 (рубрика есть — раннер вызывает исполнителей). `caseTargetAgents` —
 * свой `execution.target_agents` файла кейса (переопределяет список index.yaml).
 */
function writeSkill(targetAgents, { caseTargetAgents = null } = {}) {
  const testsDir = join(skillsDir, SKILL, 'tests');
  mkdirSync(join(testsDir, 'rubrics'), { recursive: true });
  writeFileSync(join(skillsDir, SKILL, 'SKILL.md'), '# Pool target probe\n');
  writeFileSync(join(testsDir, 'rubrics', 'probe.md'), '# Rubric\n\nScore ≥ 4: pass\n');
  writeFileSync(join(testsDir, `${CASE_ID}.yaml`), [
    'description: "probe"',
    'prompt: "probe prompt"',
    'severity: normal',
    'assertions:',
    '  rubric:',
    '    - rubric_file: rubrics/probe.md',
    '  static: []',
    '  deterministic: []',
    ...(caseTargetAgents ? ['execution:', `  target_agents: [${caseTargetAgents.join(', ')}]`] : []),
    '',
  ].join('\n'));
  writeFileSync(join(testsDir, 'index.yaml'), [
    'cases:',
    `  - id: ${CASE_ID}`,
    `    file: ${CASE_ID}.yaml`,
    'execution:',
    `  target_agents: [${targetAgents.join(', ')}]`,
    '  judge_agent: judge-a',
    '',
  ].join('\n'));
}

function runL2(extraArgs = []) {
  const args = [RUNNER_PATH, '--skill', SKILL, '--layer', 'l2', '--skip-secret-scan', '--fast', '--yes',
    '--skip-meta-write', '--pipeline', pipelinePath, ...extraArgs];
  return new Promise((done) => {
    const proc = spawn(process.execPath, args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WORKFLOW_SKILLS_DIR: skillsDir },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', (exitCode) => done({ stdout, stderr, exitCode }));
  });
}

const currentDir = (agentId) => join(skillsDir, SKILL, 'tests', 'cases', CASE_ID, 'current', agentId);

describe('пул моделей в target_agents тестов скилов', () => {
  // Без контроля отсутствие метки ничего бы не доказывало: зонд обязан
  // срабатывать на L2 в этой же обвязке.
  it('контроль: агент без models в target_agents запускается на L2', async () => {
    writeSkill(['cli-a']);
    const { stdout, stderr } = await runL2();

    assert.ok(existsSync(marks.cli), `зонд должен быть вызван на L2: ${stdout}\n${stderr}`);
  });

  it('пул в target_agents скила — ненулевой код, в выводе id пула и причина, агенты не запускались', async () => {
    writeSkill(['cli-a', 'pool-a']);
    const { stdout, stderr, exitCode } = await runL2();

    assert.notEqual(exitCode, 0, `прогон должен упасть: ${stdout}\n${stderr}`);
    assert.match(stdout, /status: error/);
    assert.match(stdout, REFUSAL);
    assert.ok(!existsSync(marks.pool), 'пул не запускался');
    assert.ok(!existsSync(marks.cli), 'соседний агент не запускался');
    assert.ok(!existsSync(marks.judge), 'судья не запускался');
    assert.ok(!existsSync(currentDir('pool-a')), 'каталога current/pool-a нет');
  });

  // Свой список кейса проверяется до калибровки и прогонов, а не при старте кейса:
  // иначе отказ глотал обработчик кейса — выход 0 и ни слова о пуле в выводе.
  it('пул в target_agents файла кейса — ненулевой код, в выводе id пула и причина, агенты не запускались', async () => {
    writeSkill(['cli-a'], { caseTargetAgents: ['pool-a'] });
    const { stdout, stderr, exitCode } = await runL2();

    assert.notEqual(exitCode, 0, `прогон должен упасть: ${stdout}\n${stderr}`);
    assert.match(stdout, /status: error/);
    assert.match(stdout, REFUSAL);
    assert.match(stdout, new RegExp(CASE_ID), 'в отказе назван кейс');
    assert.ok(!existsSync(marks.pool), 'пул не запускался');
    assert.ok(!existsSync(marks.cli), 'агент index.yaml не запускался');
    assert.ok(!existsSync(marks.judge), 'судья не запускался');
    assert.ok(!existsSync(currentDir('pool-a')), 'каталога current/pool-a нет');
  });

  it('пул в --agent — ненулевой код, в выводе id пула и причина, агенты не запускались', async () => {
    writeSkill(['cli-a']);
    const { stdout, stderr, exitCode } = await runL2(['--agent', 'pool-a']);

    assert.notEqual(exitCode, 0, `прогон должен упасть: ${stdout}\n${stderr}`);
    assert.match(stdout, REFUSAL);
    assert.ok(!existsSync(marks.pool), 'пул не запускался');
    assert.ok(!existsSync(currentDir('pool-a')), 'каталога current/pool-a нет');
  });
});
