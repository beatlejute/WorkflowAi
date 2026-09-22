#!/usr/bin/env node

/**
 * rails-integration.test.mjs — wp5: интеграция rails в workflow-ai
 * (src/rails/README.md §11). Покрывает не ядро rails (граф/состояние/хуки —
 * отдельные пакеты работ, свои тесты в rails-*.test.mjs), а только интеграцию:
 *
 *   - init.mjs: junction .workflow/src/rails, writeClaudeHooks/writeKiloPluginLoader
 *     (идемпотентность, чужие ключи/хуки не трогаются);
 *   - junction-manager.mjs: createRailsJunction (no-op без источника, не
 *     трогает эжектнутый каталог);
 *   - agent-spawner.mjs: options.env/railsRole/railsSkill/railsRun доходят до
 *     окружения дочернего процесса;
 *   - run-skill-tests.js: createTestWorkdir содержит те же junction/settings/
 *     plugin, что и `workflow init`, целевой агент получает rails-окружение
 *     (e2e через реальный spawn — internals createTestWorkdir не экспортированы);
 *   - runner.mjs: StageExecutor.callAgent — output-check по состоянию с `run`
 *     и один повтор с вердиктом при нарушении, только когда у скила есть
 *     rails.yaml (иначе поведение как раньше).
 *   - global-dir.mjs: isGlobalDirStale/ensureGlobalDir копируют src/rails →
 *     <globalDir>/rails, в том числе когда версия совпадает, но rails/ ещё
 *     не было (глобальная установка старше появления rails).
 *
 * Все тесты — во временных каталогах (os.tmpdir()), без сети и без запуска
 * настоящих агентов (claude/kilo) — только node-скрипты-заглушки.
 */

import { test, describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { initProject, writeClaudeHooks, writeKiloPluginLoader } from '../init.mjs';
import { createRailsJunction, isJunction } from '../junction-manager.mjs';
import { isGlobalDirStale, ensureGlobalDir } from '../global-dir.mjs';
import { spawnAgent } from '../lib/agent-spawner.mjs';
import { StageExecutor } from '../runner.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const RUNNER_PATH = path.join(PROJECT_ROOT, 'src', 'scripts', 'run-skill-tests.js');
const REAL_RAILS_DIR = path.join(PROJECT_ROOT, 'src', 'rails');
const REAL_RAILS_README = path.join(REAL_RAILS_DIR, 'README.md');

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupDir(dir) {
  if (dir && fs.existsSync(dir)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

// Раннер — инструмент разработки этого репозитория: находит корень по
// каталогу `.workflow/`. Тот же приём, что в run-skill-tests.test.mjs.
const WORKFLOW_MARKER = path.join(PROJECT_ROOT, '.workflow');
const workflowMarkerCreated = !fs.existsSync(WORKFLOW_MARKER);
if (workflowMarkerCreated) {
  fs.mkdirSync(WORKFLOW_MARKER);
}
process.on('exit', () => {
  if (!workflowMarkerCreated) return;
  try { fs.rmdirSync(WORKFLOW_MARKER); } catch {}
});

function runRunner(args, cwd = PROJECT_ROOT) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [RUNNER_PATH, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (exitCode) => resolve({ stdout, stderr, exitCode }));
  });
}

// ============================================================================
// init.mjs — junction ядра rails + регистрация хуков (rails/README.md §11)
// ============================================================================

describe('init.mjs — rails junction и хуки', () => {
  it('initProject создаёт junction .workflow/src/rails, хуки Claude и kilo-загрузчик', () => {
    const globalDir = makeTmpDir('wf-rails-global-');
    const projectRoot = makeTmpDir('wf-rails-project-');
    const prevHome = process.env.WORKFLOW_HOME;
    process.env.WORKFLOW_HOME = globalDir;
    try {
      const result = initProject(projectRoot, { force: true });
      assert.equal(result.errors.length, 0, result.errors.join(', '));

      const railsDir = path.join(projectRoot, '.workflow', 'src', 'rails');
      assert.ok(fs.existsSync(railsDir), '.workflow/src/rails должен существовать');
      assert.ok(isJunction(railsDir), '.workflow/src/rails должен быть junction/symlink');
      assert.ok(
        fs.existsSync(path.join(railsDir, 'claude-hook.mjs')) || fs.existsSync(path.join(railsDir, 'README.md')),
        'через junction должно быть видно содержимое ядра rails'
      );

      const settingsPath = path.join(projectRoot, '.claude', 'settings.local.json');
      assert.ok(fs.existsSync(settingsPath), 'settings.local.json должен быть создан');
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const expectedCommandPath = path.join(projectRoot, '.workflow', 'src', 'rails', 'claude-hook.mjs');

      for (const event of ['PreToolUse', 'PostToolUse', 'Stop', 'UserPromptSubmit', 'SessionStart']) {
        assert.ok(Array.isArray(settings.hooks?.[event]) && settings.hooks[event].length > 0, `hooks.${event} должен быть заполнен`);
        const ourGroup = settings.hooks[event].find((g) => (g.hooks || []).some((h) => h._workflow_rails === true));
        assert.ok(ourGroup, `hooks.${event} должен содержать запись rails`);
        const hookEntry = ourGroup.hooks.find((h) => h._workflow_rails === true);
        assert.equal(hookEntry.type, 'command');
        assert.ok(hookEntry.command.includes(expectedCommandPath), `команда должна содержать абсолютный путь ${expectedCommandPath}`);
      }

      const pluginPath = path.join(projectRoot, '.kilo', 'plugin', 'workflow-rails.js');
      assert.ok(fs.existsSync(pluginPath), 'kilo-загрузчик должен быть создан');
      const pluginContent = fs.readFileSync(pluginPath, 'utf8');
      assert.match(pluginContent, /WorkflowRails/);
      assert.match(pluginContent, /\.workflow\/src\/rails\/kilo-plugin\.mjs/);

      const gitignore = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8');
      assert.match(gitignore, /\.workflow\/state\//, '.gitignore должен содержать .workflow/state/');
    } finally {
      if (prevHome === undefined) delete process.env.WORKFLOW_HOME; else process.env.WORKFLOW_HOME = prevHome;
      cleanupDir(globalDir);
      cleanupDir(projectRoot);
    }
  });

  it('writeClaudeHooks идемпотентен и не трогает чужие ключи/хуки', () => {
    const tmp = makeTmpDir('wf-rails-hooks-');
    try {
      fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
      const settingsPath = path.join(tmp, '.claude', 'settings.local.json');
      fs.writeFileSync(settingsPath, JSON.stringify({
        permissions: { allow: ['Bash(ls:*)'] },
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo custom' }] }] }
      }, null, 2));

      writeClaudeHooks(tmp);
      writeClaudeHooks(tmp); // второй вызов — проверка идемпотентности

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      assert.deepEqual(settings.permissions, { allow: ['Bash(ls:*)'] }, 'чужой ключ settings.permissions должен сохраниться');
      assert.equal(settings.hooks.PreToolUse.length, 2, 'чужая группа + ровно одна наша, без дублей на повторном вызове');

      const foreignGroup = settings.hooks.PreToolUse.find((g) => g.matcher === 'Bash');
      assert.ok(foreignGroup, 'чужая matcher-группа должна сохраниться');
      assert.equal(foreignGroup.hooks[0].command, 'echo custom');
      assert.ok(!('_workflow_rails' in foreignGroup.hooks[0]), 'чужая запись не должна получить нашу метку');

      const oursGroups = settings.hooks.PreToolUse.filter((g) => (g.hooks || []).some((h) => h._workflow_rails));
      assert.equal(oursGroups.length, 1, 'после двух вызовов должна остаться ровно одна наша группа');
    } finally {
      cleanupDir(tmp);
    }
  });

  it('writeClaudeHooks не трогает файл с невалидным JSON и возвращает null', () => {
    const tmp = makeTmpDir('wf-rails-badjson-');
    try {
      fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
      const settingsPath = path.join(tmp, '.claude', 'settings.local.json');
      const badJson = '{"permissions": {"allow": ["Bash(ls:*)"],}, "hooks": {}}'; // trailing comma — невалидный JSON
      fs.writeFileSync(settingsPath, badJson);

      const returned = writeClaudeHooks(tmp);

      assert.equal(returned, null, 'при невалидном JSON функция не должна возвращать путь к файлу');
      assert.equal(fs.readFileSync(settingsPath, 'utf8'), badJson, 'файл не должен быть изменён ни байтом');
    } finally {
      cleanupDir(tmp);
    }
  });

  it('initProject: битый settings.local.json → хуки не регистрируются, ошибка в result.errors, файл не тронут', () => {
    const globalDir = makeTmpDir('wf-rails-global-badjson-');
    const projectRoot = makeTmpDir('wf-rails-badjson-project-');
    const prevHome = process.env.WORKFLOW_HOME;
    process.env.WORKFLOW_HOME = globalDir;
    try {
      fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
      const settingsPath = path.join(projectRoot, '.claude', 'settings.local.json');
      const badJson = '{"permissions": {"allow": ["Bash(ls:*)"],}}'; // trailing comma
      fs.writeFileSync(settingsPath, badJson);

      const result = initProject(projectRoot, { force: true });

      assert.ok(
        result.errors.some((e) => /settings\.local\.json/.test(e)),
        `result.errors должен содержать запись про settings.local.json: ${JSON.stringify(result.errors)}`
      );
      assert.equal(fs.readFileSync(settingsPath, 'utf8'), badJson, 'битый файл не должен быть перезаписан init-ом');
    } finally {
      if (prevHome === undefined) delete process.env.WORKFLOW_HOME; else process.env.WORKFLOW_HOME = prevHome;
      cleanupDir(globalDir);
      cleanupDir(projectRoot);
    }
  });

  it('чужой не-массив hooks[event] не трогается и не заменяется нашим массивом', () => {
    const tmp = makeTmpDir('wf-rails-nonarray-');
    try {
      fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
      const settingsPath = path.join(tmp, '.claude', 'settings.local.json');
      fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { Stop: { foo: 1 } } }));

      writeClaudeHooks(tmp);

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      assert.deepEqual(settings.hooks.Stop, { foo: 1 }, 'чужой не-массив в hooks.Stop должен остаться нетронутым');
    } finally {
      cleanupDir(tmp);
    }
  });

  it('writeClaudeHooks: settings.hooks не объект (массив) → не трогается, возвращает null', () => {
    const tmp = makeTmpDir('wf-rails-hooks-nonobject-');
    try {
      fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
      const settingsPath = path.join(tmp, '.claude', 'settings.local.json');
      const original = JSON.stringify({ hooks: ['not', 'an', 'object'] });
      fs.writeFileSync(settingsPath, original);

      const returned = writeClaudeHooks(tmp);

      assert.equal(returned, null, 'при hooks-не-объекте функция не должна возвращать путь к файлу');
      assert.equal(fs.readFileSync(settingsPath, 'utf8'), original, 'файл не должен быть изменён ни байтом');
    } finally {
      cleanupDir(tmp);
    }
  });

  it('matcher не проставляется для Stop/UserPromptSubmit/SessionStart, но есть для PreToolUse/PostToolUse', () => {
    const tmp = makeTmpDir('wf-rails-matcher-');
    try {
      writeClaudeHooks(tmp);
      const settingsPath = path.join(tmp, '.claude', 'settings.local.json');
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

      for (const event of ['Stop', 'UserPromptSubmit', 'SessionStart']) {
        const ourGroup = settings.hooks[event].find((g) => (g.hooks || []).some((h) => h._workflow_rails));
        assert.ok(ourGroup, `hooks.${event} должен содержать нашу группу`);
        assert.ok(!('matcher' in ourGroup), `hooks.${event} не должен иметь поле matcher`);
      }
      for (const event of ['PreToolUse', 'PostToolUse']) {
        const ourGroup = settings.hooks[event].find((g) => (g.hooks || []).some((h) => h._workflow_rails));
        assert.equal(ourGroup.matcher, '*', `hooks.${event} должен иметь matcher: '*'`);
      }
    } finally {
      cleanupDir(tmp);
    }
  });

  it('ядро rails недоступно по пути junction → хуки/kilo-загрузчик не пишутся, шаг помечен как пропущенный', () => {
    // Симулирует «версия глобальной установки совпадает, но содержимое rails/
    // не скопировано» (major-находка ревью): globalDir/rails существует как
    // каталог (junction создастся), но пуст — claude-hook.mjs недоступен.
    const globalDir = makeTmpDir('wf-rails-empty-core-global-');
    const projectRoot = makeTmpDir('wf-rails-empty-core-project-');
    const prevHome = process.env.WORKFLOW_HOME;
    process.env.WORKFLOW_HOME = globalDir;
    try {
      fs.mkdirSync(path.join(globalDir, 'rails'), { recursive: true }); // без claude-hook.mjs внутри
      fs.writeFileSync(path.join(globalDir, '.version'), JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')).version);

      const result = initProject(projectRoot, { force: true });

      assert.equal(result.errors.length, 0, result.errors.join(', '));
      assert.ok(
        result.steps.some((s) => /Skipped rails hooks/.test(s)),
        `шаг должен сообщать о пропуске регистрации хуков: ${JSON.stringify(result.steps)}`
      );
      assert.ok(
        !result.steps.some((s) => /Registered rails hooks/.test(s)),
        'хуки не должны считаться зарегистрированными'
      );
      const settingsPath = path.join(projectRoot, '.claude', 'settings.local.json');
      assert.ok(!fs.existsSync(settingsPath), 'settings.local.json не должен быть создан');
      const pluginPath = path.join(projectRoot, '.kilo', 'plugin', 'workflow-rails.js');
      assert.ok(!fs.existsSync(pluginPath), 'kilo-загрузчик не должен быть создан');
    } finally {
      if (prevHome === undefined) delete process.env.WORKFLOW_HOME; else process.env.WORKFLOW_HOME = prevHome;
      cleanupDir(globalDir);
      cleanupDir(projectRoot);
    }
  });

  it('writeKiloPluginLoader идемпотентен', () => {
    const tmp = makeTmpDir('wf-rails-kilo-');
    try {
      const p1 = writeKiloPluginLoader(tmp);
      const c1 = fs.readFileSync(p1, 'utf8');
      const p2 = writeKiloPluginLoader(tmp);
      const c2 = fs.readFileSync(p2, 'utf8');
      assert.equal(p1, p2);
      assert.equal(c1, c2);
    } finally {
      cleanupDir(tmp);
    }
  });
});

// ============================================================================
// global-dir.mjs — isGlobalDirStale/ensureGlobalDir учитывают rails/
// ============================================================================

describe('global-dir.mjs — копирование src/rails → <globalDir>/rails', () => {
  it('isGlobalDirStale === true, когда версия совпадает, но rails/ в globalDir нет', () => {
    const globalDir = makeTmpDir('wf-rails-stale-global-');
    const prevHome = process.env.WORKFLOW_HOME;
    process.env.WORKFLOW_HOME = globalDir;
    try {
      const packageVersion = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')).version;
      // globalDir «уже существует» (как после установки версией до rails):
      // .version совпадает с package.json, skills/scripts/configs есть, rails/ — нет.
      fs.mkdirSync(path.join(globalDir, 'skills'), { recursive: true });
      fs.writeFileSync(path.join(globalDir, '.version'), packageVersion);
      assert.ok(!fs.existsSync(path.join(globalDir, 'rails')));

      assert.equal(isGlobalDirStale(PROJECT_ROOT), true, 'без rails/ при наличии src/rails в пакете globalDir должен считаться устаревшим');

      ensureGlobalDir(PROJECT_ROOT);

      assert.ok(fs.existsSync(path.join(globalDir, 'rails', 'core.mjs')), 'ensureGlobalDir должен скопировать src/rails → <globalDir>/rails');
    } finally {
      if (prevHome === undefined) delete process.env.WORKFLOW_HOME; else process.env.WORKFLOW_HOME = prevHome;
      cleanupDir(globalDir);
    }
  });

  it('isGlobalDirStale === false, когда версия совпадает и rails/ уже скопирован', () => {
    const globalDir = makeTmpDir('wf-rails-fresh-global-');
    const prevHome = process.env.WORKFLOW_HOME;
    process.env.WORKFLOW_HOME = globalDir;
    try {
      const packageVersion = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')).version;
      fs.mkdirSync(path.join(globalDir, 'rails'), { recursive: true });
      fs.writeFileSync(path.join(globalDir, '.version'), packageVersion);

      assert.equal(isGlobalDirStale(PROJECT_ROOT), false);
    } finally {
      if (prevHome === undefined) delete process.env.WORKFLOW_HOME; else process.env.WORKFLOW_HOME = prevHome;
      cleanupDir(globalDir);
    }
  });

  it('ensureGlobalDir на пустом globalDir копирует rails/ вместе со skills/scripts/configs', () => {
    const globalDir = makeTmpDir('wf-rails-new-global-');
    const prevHome = process.env.WORKFLOW_HOME;
    process.env.WORKFLOW_HOME = globalDir;
    try {
      cleanupDir(globalDir); // ensureGlobalDir сам создаёт каталог — должен отсутствовать до вызова

      ensureGlobalDir(PROJECT_ROOT);

      assert.ok(fs.existsSync(path.join(globalDir, 'rails', 'core.mjs')), 'rails/ должен быть скопирован в новый globalDir');
      assert.ok(fs.existsSync(path.join(globalDir, 'rails', 'README.md')));
      const copied = fs.readFileSync(path.join(globalDir, 'rails', 'README.md'), 'utf8');
      const canon = fs.readFileSync(REAL_RAILS_README, 'utf8');
      assert.equal(copied, canon, 'скопированный README должен совпадать с каноном');
    } finally {
      if (prevHome === undefined) delete process.env.WORKFLOW_HOME; else process.env.WORKFLOW_HOME = prevHome;
      cleanupDir(globalDir);
    }
  });
});

// ============================================================================
// junction-manager.mjs — createRailsJunction
// ============================================================================

describe('junction-manager.mjs — createRailsJunction', () => {
  it('без rails в globalDir — no-op, ничего не создаёт', () => {
    const emptyGlobal = makeTmpDir('wf-rails-empty-global-');
    const project = makeTmpDir('wf-rails-noop-');
    try {
      const target = path.join(project, 'rails');
      createRailsJunction(emptyGlobal, target);
      assert.ok(!fs.existsSync(target));
    } finally {
      cleanupDir(emptyGlobal);
      cleanupDir(project);
    }
  });

  it('эжектнутый (не-junction) каталог в проекте не перезаписывается', () => {
    const globalDir = makeTmpDir('wf-rails-real-global-');
    const project = makeTmpDir('wf-rails-eject-');
    try {
      fs.mkdirSync(path.join(globalDir, 'rails'), { recursive: true });
      fs.writeFileSync(path.join(globalDir, 'rails', 'marker.txt'), 'canon');

      const target = path.join(project, 'rails');
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'own.txt'), 'ejected');

      createRailsJunction(globalDir, target);

      assert.ok(!isJunction(target), 'эжектнутый каталог не должен стать junction');
      assert.ok(fs.existsSync(path.join(target, 'own.txt')), 'содержимое эжектнутого каталога должно сохраниться');
    } finally {
      cleanupDir(globalDir);
      cleanupDir(project);
    }
  });

  it('создаёт junction на globalDir/rails', () => {
    const globalDir = makeTmpDir('wf-rails-real-global2-');
    const project = makeTmpDir('wf-rails-link-');
    try {
      fs.mkdirSync(path.join(globalDir, 'rails'), { recursive: true });
      fs.writeFileSync(path.join(globalDir, 'rails', 'marker.txt'), 'canon');

      const target = path.join(project, 'rails');
      createRailsJunction(globalDir, target);

      assert.ok(isJunction(target));
      assert.equal(fs.readFileSync(path.join(target, 'marker.txt'), 'utf8'), 'canon');
    } finally {
      cleanupDir(globalDir);
      cleanupDir(project);
    }
  });
});

// ============================================================================
// agent-spawner.mjs — окружение rails дочернего процесса
// ============================================================================

describe('agent-spawner.mjs — WORKFLOW_RAILS_* и options.env', () => {
  function writeEchoEnvScript(dir) {
    const scriptPath = path.join(dir, 'echo-env.mjs');
    fs.writeFileSync(scriptPath, [
      "process.stdout.write('---RESULT---\\nstatus: passed\\n---RESULT---\\n');",
      'process.stdout.write(JSON.stringify({',
      "  role: process.env.WORKFLOW_RAILS_ROLE || null,",
      "  skill: process.env.WORKFLOW_RAILS_SKILL || null,",
      "  run: process.env.WORKFLOW_RAILS_RUN || null,",
      "  custom: process.env.WF_RAILS_TEST_CUSTOM || null",
      '}) + \'\\n\');'
    ].join('\n'));
    return scriptPath;
  }

  function extractReport(output) {
    const line = output.split('\n').find((l) => l.trim().startsWith('{'));
    assert.ok(line, `нет JSON-строки в выводе: ${output}`);
    return JSON.parse(line);
  }

  it('передаёт railsRole/railsSkill/railsRun и options.env дочернему процессу', async () => {
    const tmp = makeTmpDir('wf-rails-spawner-');
    try {
      const scriptPath = writeEchoEnvScript(tmp);
      const result = await spawnAgent({ command: 'node', args: [scriptPath], workdir: '.' }, 'prompt', {
        timeout: 10,
        projectRoot: tmp,
        railsRole: 'coordinator',
        railsSkill: 'demo-skill',
        railsRun: 'run-123',
        env: { WF_RAILS_TEST_CUSTOM: 'yes' }
      });

      const report = extractReport(result.output);
      assert.equal(report.role, 'coordinator');
      assert.equal(report.skill, 'demo-skill');
      assert.equal(report.run, 'run-123');
      assert.equal(report.custom, 'yes');
    } finally {
      cleanupDir(tmp);
    }
  });

  it('без rails-опций WORKFLOW_RAILS_* не выставляются', async () => {
    const tmp = makeTmpDir('wf-rails-spawner-plain-');
    try {
      const scriptPath = writeEchoEnvScript(tmp);
      const result = await spawnAgent({ command: 'node', args: [scriptPath], workdir: '.' }, 'prompt', {
        timeout: 10,
        projectRoot: tmp
      });

      const report = extractReport(result.output);
      assert.equal(report.role, null);
      assert.equal(report.skill, null);
      assert.equal(report.run, null);
    } finally {
      cleanupDir(tmp);
    }
  });
});

// ============================================================================
// runner.mjs — StageExecutor.callAgent: output-check + один повтор
// ============================================================================

describe('runner.mjs — StageExecutor.callAgent и rails output-check', () => {
  function makeConfig(projectRoot) {
    return {
      pipeline: {
        name: 'test-rails-pipeline',
        version: '1.0',
        agents: {},
        stages: {},
        execution: { timeout_per_stage: 10 }
      }
    };
  }

  function writeRailsYaml(projectRoot, skill) {
    const skillDir = path.join(projectRoot, '.workflow', 'src', 'skills', skill);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'rails.yaml'), [
      'version: 1',
      `skill: ${skill}`,
      'entry: P1E1',
      'terminal: [P1S1]',
      'output:',
      '  final_requires:',
      '    - "RAILS:\\\\s*P1S1"',
      '  max_stop_blocks: 2'
    ].join('\n'));
  }

  /**
   * Заглушка целевого агента: первый вызов на каждый `run` — состояние в
   * не-terminal узле и без RAILS-маркера в тексте (output-check обязан
   * отклонить), второй — terminal + маркер (output-check обязан принять).
   * Считает вызовы в `call-count.txt` рядом (cwd = projectRoot).
   */
  function writeRetryStub(projectRoot) {
    const scriptPath = path.join(projectRoot, 'stub-retry.mjs');
    fs.writeFileSync(scriptPath, [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "const cwd = process.cwd();",
      "const run = process.env.WORKFLOW_RAILS_RUN || '';",
      "const skill = process.env.WORKFLOW_RAILS_SKILL || '';",
      "const stateDir = path.join(cwd, '.workflow', 'state', 'rails');",
      "fs.mkdirSync(stateDir, { recursive: true });",
      "const counterPath = path.join(cwd, 'call-count.txt');",
      "const prev = fs.existsSync(counterPath) ? parseInt(fs.readFileSync(counterPath, 'utf8'), 10) : 0;",
      "const calls = prev + 1;",
      "fs.writeFileSync(counterPath, String(calls));",
      "if (calls === 1) {",
      "  fs.writeFileSync(path.join(stateDir, `${run}.json`), JSON.stringify({ run, node: 'P1E1', skill }));",
      "  process.stdout.write('---RESULT---\\nstatus: passed\\n---RESULT---\\n');",
      "} else {",
      "  fs.writeFileSync(path.join(stateDir, `${run}.json`), JSON.stringify({ run, node: 'P1S1', skill }));",
      "  process.stdout.write('RAILS: P1S1\\n---RESULT---\\nstatus: passed\\n---RESULT---\\n');",
      "}"
    ].join('\n'));
    return scriptPath;
  }

  function writeOnceStub(projectRoot) {
    const scriptPath = path.join(projectRoot, 'stub-once.mjs');
    fs.writeFileSync(scriptPath, [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "const counterPath = path.join(process.cwd(), 'call-count.txt');",
      "const prev = fs.existsSync(counterPath) ? parseInt(fs.readFileSync(counterPath, 'utf8'), 10) : 0;",
      "fs.writeFileSync(counterPath, String(prev + 1));",
      "process.stdout.write('---RESULT---\\nstatus: passed\\n---RESULT---\\n');"
    ].join('\n'));
    return scriptPath;
  }

  it('rails.yaml есть, output-check нарушен на первом ответе → один повтор с вердиктом, второй проходит', async () => {
    const projectRoot = makeTmpDir('wf-rails-callagent-retry-');
    try {
      const skill = 'demo-skill';
      writeRailsYaml(projectRoot, skill);
      const stubPath = writeRetryStub(projectRoot);

      const executor = new StageExecutor(makeConfig(projectRoot), {}, {}, {}, null, null, projectRoot);
      const agent = { command: 'node', args: [stubPath], workdir: '.' };

      const result = await executor.callAgent(agent, 'do the task', 'stage-1', skill, 'agent-1');

      assert.equal(result.railsRetried, true, 'должен быть отмечен как повтор');
      assert.ok(result.railsVerdict && result.railsVerdict.ok === false, 'вердикт первого ответа должен быть нарушением');
      assert.match(result.output, /RAILS: P1S1/, 'финальный вывод — от второй (успешной) попытки');

      const calls = fs.readFileSync(path.join(projectRoot, 'call-count.txt'), 'utf8');
      assert.equal(calls, '2', 'агент должен быть вызван ровно дважды: первый ответ + один повтор');
    } finally {
      cleanupDir(projectRoot);
    }
  });

  it('rails.yaml есть, первый ответ уже корректный → без повтора, вызов один', async () => {
    const projectRoot = makeTmpDir('wf-rails-callagent-noretry-');
    try {
      const skill = 'demo-skill';
      writeRailsYaml(projectRoot, skill);
      const scriptPath = path.join(projectRoot, 'stub-firsttry.mjs');
      fs.writeFileSync(scriptPath, [
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        "const cwd = process.cwd();",
        "const run = process.env.WORKFLOW_RAILS_RUN || '';",
        "const skill = process.env.WORKFLOW_RAILS_SKILL || '';",
        "const stateDir = path.join(cwd, '.workflow', 'state', 'rails');",
        "fs.mkdirSync(stateDir, { recursive: true });",
        "const counterPath = path.join(cwd, 'call-count.txt');",
        "const prev = fs.existsSync(counterPath) ? parseInt(fs.readFileSync(counterPath, 'utf8'), 10) : 0;",
        "fs.writeFileSync(counterPath, String(prev + 1));",
        "fs.writeFileSync(path.join(stateDir, `${run}.json`), JSON.stringify({ run, node: 'P1S1', skill }));",
        "process.stdout.write('RAILS: P1S1\\n---RESULT---\\nstatus: passed\\n---RESULT---\\n');"
      ].join('\n'));

      const executor = new StageExecutor(makeConfig(projectRoot), {}, {}, {}, null, null, projectRoot);
      const agent = { command: 'node', args: [scriptPath], workdir: '.' };

      const result = await executor.callAgent(agent, 'do the task', 'stage-1', skill, 'agent-1');

      assert.equal(result.railsRetried, undefined, 'при корректном первом ответе повтора быть не должно');
      assert.match(result.output, /RAILS: P1S1/);
      const calls = fs.readFileSync(path.join(projectRoot, 'call-count.txt'), 'utf8');
      assert.equal(calls, '1', 'агент должен быть вызван ровно один раз');
    } finally {
      cleanupDir(projectRoot);
    }
  });

  it('без rails.yaml у скила — поведение прежнее, output-check не запускается, вызов один', async () => {
    const projectRoot = makeTmpDir('wf-rails-callagent-plain-');
    try {
      const stubPath = writeOnceStub(projectRoot);
      const executor = new StageExecutor(makeConfig(projectRoot), {}, {}, {}, null, null, projectRoot);
      const agent = { command: 'node', args: [stubPath], workdir: '.' };

      const result = await executor.callAgent(agent, 'do the task', 'stage-1', 'skill-without-rails', 'agent-1');

      assert.equal(result.railsRetried, undefined, 'без rails.yaml повтора быть не должно');
      const calls = fs.readFileSync(path.join(projectRoot, 'call-count.txt'), 'utf8');
      assert.equal(calls, '1', 'агент должен быть вызван ровно один раз');
    } finally {
      cleanupDir(projectRoot);
    }
  });
});

// ============================================================================
// run-skill-tests.js — createTestWorkdir (junction/settings/plugin) и
// spawnTargetAgentWithRailsCheck, через реальный e2e-прогон (internals не
// экспортированы; тот же приём, что в run-skill-tests.test.mjs).
//
// Изоляция (review wp5, major): раньше мок-скилы создавались и удалялись
// прямо в РЕАЛЬНОМ src/skills репозитория. `node --test` запускает файлы
// разными процессами — параллельно с этим блоком L2-раннер из
// run-skill-tests.test.mjs делает `fs.cpSync(src/skills → workdir,
// {recursive, dereference})`; удаление каталога посреди копирования роняло
// node (0xC0000409). Поэтому здесь — отдельный временный корень проекта
// (свой `.workflow/`, свои `src/skills/<mock>`), и раннер запускается с
// `cwd` на этот корень (findProjectRoot находит `.workflow/` в нём); реальный
// src/skills этот блок больше не трогает вовсе.
// ============================================================================

describe('run-skill-tests.js — rails в изолированном test workdir (e2e)', () => {
  const TS = Date.now();
  const SKILL_NAME = `__test-rails-e2e-${TS}`;
  // Отдельный скил для TC-RAILS-002 (не второй кейс в SKILL_NAME): первый
  // тест запускает `--skill SKILL_NAME` без `--case`, то есть прогоняет ВСЕ
  // кейсы index.yaml этого скила — общий index.yaml с retry-кейсом сделал бы
  // первый тест тоже дёргать retry-агента и портил бы счётчик его вызовов.
  const SKILL_NAME_RETRY = `__test-rails-e2e-retry-${TS}`;
  let tempProjectRoot;
  let SKILL_DIR;
  let TESTS_DIR;
  let SKILL_DIR_RETRY;
  let TESTS_DIR_RETRY;
  let railsCopyReadme;
  let pipelineDir;
  let pipelinePath;

  before(() => {
    // Изолированный корень: своя копия ядра rails (не junction на канон —
    // ничего не удаляется рекурсивно сквозь ссылку на реальный src/rails,
    // CLAUDE.md §«Симлинки и рекурсивное удаление»), свои мок-скилы.
    tempProjectRoot = makeTmpDir('wf-rails-e2e-root-');
    fs.mkdirSync(path.join(tempProjectRoot, '.workflow'), { recursive: true });
    fs.cpSync(REAL_RAILS_DIR, path.join(tempProjectRoot, 'src', 'rails'), { recursive: true });
    railsCopyReadme = path.join(tempProjectRoot, 'src', 'rails', 'README.md');

    SKILL_DIR = path.join(tempProjectRoot, 'src', 'skills', SKILL_NAME);
    TESTS_DIR = path.join(SKILL_DIR, 'tests');
    SKILL_DIR_RETRY = path.join(tempProjectRoot, 'src', 'skills', SKILL_NAME_RETRY);
    TESTS_DIR_RETRY = path.join(SKILL_DIR_RETRY, 'tests');

    pipelineDir = makeTmpDir('wf-rails-e2e-pipeline-');
    const targetScript = path.join(pipelineDir, 'rails-mock-target.mjs');
    const judgeScript = path.join(pipelineDir, 'rails-mock-judge.mjs');
    const retryTargetScript = path.join(pipelineDir, 'rails-mock-retry-target.mjs');
    const retryCounterPath = path.join(pipelineDir, 'retry-call-count.txt');
    const targetCounterPath = path.join(pipelineDir, 'target-call-count.txt');

    // Целевой агент: пишет rails-состояние в terminal-узле с RAILS-маркером
    // сразу (без нарушения) — эта проверка про createTestWorkdir/окружение
    // и про то, что «молчание» output-check не порождает повтор (finding
    // review wp5, minor: счётчик вызовов должен остаться 1).
    fs.writeFileSync(targetScript, [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "const cwd = process.cwd();",
      "const run = process.env.WORKFLOW_RAILS_RUN || '';",
      "const skill = process.env.WORKFLOW_RAILS_SKILL || '';",
      "const role = process.env.WORKFLOW_RAILS_ROLE || '';",
      `const counterPath = ${JSON.stringify(targetCounterPath)};`,
      "const prevCalls = fs.existsSync(counterPath) ? parseInt(fs.readFileSync(counterPath, 'utf8'), 10) : 0;",
      "fs.writeFileSync(counterPath, String(prevCalls + 1));",
      "const stateDir = path.join(cwd, '.workflow', 'state', 'rails');",
      "fs.mkdirSync(stateDir, { recursive: true });",
      "fs.writeFileSync(path.join(stateDir, `${run || 'norun'}.json`), JSON.stringify({ run, node: 'P1S1', skill }));",
      "const report = {",
      "  role, skill, run,",
      "  railsReadme: fs.existsSync(path.join(cwd, '.workflow', 'src', 'rails', 'README.md')),",
      "  settings: fs.existsSync(path.join(cwd, '.claude', 'settings.local.json')),",
      "  kiloPlugin: fs.existsSync(path.join(cwd, '.kilo', 'plugin', 'workflow-rails.js'))",
      "};",
      "process.stdout.write('---RESULT---\\nstatus: passed\\n---RESULT---\\n');",
      "process.stdout.write(`RAILS: P1S1 REPORT ${JSON.stringify(report)}\\n`);"
    ].join('\n'));

    // Судья не должен участвовать в рельсах скила — печатает свою роль,
    // чтобы тест мог проверить WORKFLOW_RAILS_ROLE=executor (rails/README.md
    // §7 п.2, run-skill-tests.js: spawnAgent(..., { railsRole: 'executor' })).
    fs.writeFileSync(judgeScript, [
      "process.stdout.write(`JUDGE_ENV ${JSON.stringify({ role: process.env.WORKFLOW_RAILS_ROLE || null })}\\n`);",
      "process.stdout.write('---RESULT---\\nscore: 5\\nreason: mock\\n---RESULT---\\n');"
    ].join('\n'));

    // Целевой агент для проверки повтора (spawnTargetAgentWithRailsCheck,
    // run-skill-tests.js): первый вызов оставляет состояние в не-terminal
    // узле без RAILS-маркера в тексте (output-check обязан отклонить),
    // второй — terminal-узел с маркером (output-check обязан принять).
    // Счётчик вызовов пишется по абсолютному пути вне workdir, потому что
    // taskWorkdir cleanupTestWorkdir снимает сразу после попытки.
    fs.writeFileSync(retryTargetScript, [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "const cwd = process.cwd();",
      "const run = process.env.WORKFLOW_RAILS_RUN || '';",
      "const skill = process.env.WORKFLOW_RAILS_SKILL || '';",
      `const counterPath = ${JSON.stringify(retryCounterPath)};`,
      "const stateDir = path.join(cwd, '.workflow', 'state', 'rails');",
      "fs.mkdirSync(stateDir, { recursive: true });",
      "const prev = fs.existsSync(counterPath) ? parseInt(fs.readFileSync(counterPath, 'utf8'), 10) : 0;",
      "const calls = prev + 1;",
      "fs.writeFileSync(counterPath, String(calls));",
      "if (calls === 1) {",
      "  fs.writeFileSync(path.join(stateDir, `${run}.json`), JSON.stringify({ run, node: 'P1E1', skill }));",
      "  process.stdout.write('---RESULT---\\nstatus: passed\\n---RESULT---\\nfirst attempt, no marker\\n');",
      "} else {",
      "  fs.writeFileSync(path.join(stateDir, `${run}.json`), JSON.stringify({ run, node: 'P1S1', skill }));",
      "  process.stdout.write('RAILS: P1S1\\n---RESULT---\\nstatus: passed\\n---RESULT---\\n');",
      "}"
    ].join('\n'));

    pipelinePath = path.join(pipelineDir, 'pipeline.yaml');
    fs.writeFileSync(pipelinePath, [
      'pipeline:',
      '  name: "test-pipeline-rails-e2e"',
      '  version: "1.0"',
      '  agents:',
      '    rails-mock-target:',
      '      command: "node"',
      `      args: ["${targetScript.replace(/\\/g, '\\\\')}"]`,
      '      workdir: "."',
      '      capabilities: [text]',
      '    rails-mock-judge:',
      '      command: "node"',
      `      args: ["${judgeScript.replace(/\\/g, '\\\\')}"]`,
      '      workdir: "."',
      '      capabilities: [text]',
      '    rails-mock-retry-target:',
      '      command: "node"',
      `      args: ["${retryTargetScript.replace(/\\/g, '\\\\')}"]`,
      '      workdir: "."',
      '      capabilities: [text]',
      '  default_agents: [rails-mock-target]'
    ].join('\n'));

    fs.mkdirSync(path.join(TESTS_DIR, 'rubrics'), { recursive: true });
    fs.writeFileSync(path.join(SKILL_DIR, 'SKILL.md'), '# Rails E2E Test Skill\nversion: 1.0\n');
    fs.writeFileSync(path.join(SKILL_DIR, 'rails.yaml'), [
      'version: 1',
      `skill: ${SKILL_NAME}`,
      'entry: P1E1',
      'terminal: [P1S1]',
      'output:',
      '  final_requires:',
      '    - "RAILS:\\\\s*P1S1"',
      '  max_stop_blocks: 2'
    ].join('\n'));
    fs.writeFileSync(path.join(TESTS_DIR, 'rubrics', 'rubric.md'), '# Rubric\nScore >= 4: pass\nscore ≥ 4\n');
    fs.writeFileSync(path.join(TESTS_DIR, 'tc-rails-001.yaml'), [
      'description: "rails e2e smoke"',
      'prompt: "Do the thing"',
      'severity: normal',
      'assertions:',
      '  rubric:',
      '    - rubric_file: rubrics/rubric.md',
      '  static: []',
      '  deterministic: []'
    ].join('\n'));
    fs.writeFileSync(path.join(TESTS_DIR, 'index.yaml'), [
      'cases:',
      '  - id: TC-RAILS-001',
      '    file: tc-rails-001.yaml',
      '    tags: [rails]',
      'execution:',
      '  target_agents: [rails-mock-target]',
      '  judge_agent: rails-mock-judge'
    ].join('\n'));

    // Скил-двойник для retry-кейса (см. комментарий у SKILL_NAME_RETRY выше).
    fs.mkdirSync(path.join(TESTS_DIR_RETRY, 'rubrics'), { recursive: true });
    fs.writeFileSync(path.join(SKILL_DIR_RETRY, 'SKILL.md'), '# Rails E2E Retry Test Skill\nversion: 1.0\n');
    fs.writeFileSync(path.join(SKILL_DIR_RETRY, 'rails.yaml'), [
      'version: 1',
      `skill: ${SKILL_NAME_RETRY}`,
      'entry: P1E1',
      'terminal: [P1S1]',
      'output:',
      '  final_requires:',
      '    - "RAILS:\\\\s*P1S1"',
      '  max_stop_blocks: 2'
    ].join('\n'));
    fs.writeFileSync(path.join(TESTS_DIR_RETRY, 'rubrics', 'rubric.md'), '# Rubric\nScore >= 4: pass\nscore ≥ 4\n');
    fs.writeFileSync(path.join(TESTS_DIR_RETRY, 'tc-rails-002.yaml'), [
      'description: "rails e2e retry"',
      'prompt: "Do the thing"',
      'severity: normal',
      'assertions:',
      '  rubric:',
      '    - rubric_file: rubrics/rubric.md',
      '  static: []',
      '  deterministic: []'
    ].join('\n'));
    fs.writeFileSync(path.join(TESTS_DIR_RETRY, 'index.yaml'), [
      'cases:',
      '  - id: TC-RAILS-002',
      '    file: tc-rails-002.yaml',
      '    tags: [rails]',
      'execution:',
      '  target_agents: [rails-mock-retry-target]',
      '  judge_agent: rails-mock-judge'
    ].join('\n'));
  });

  after(() => {
    cleanupDir(tempProjectRoot);
    cleanupDir(pipelineDir);
  });

  it('целевой агент видит junction/settings/plugin/окружение rails в изолированном workdir, копия ядра rails не тронута, повтора не было', async () => {
    const readmeBefore = fs.readFileSync(railsCopyReadme, 'utf8');

    const { stdout, exitCode } = await runRunner([
      '--skill', SKILL_NAME, '--layer', 'l2',
      '--skip-secret-scan', '--fast', '--yes',
      '--pipeline', pipelinePath
    ], tempProjectRoot);

    assert.match(stdout, /status: passed/, `прогон должен пройти:\n${stdout}`);

    // Регрессия на «rm -rf по junction сносит цель» (CLAUDE.md, §«Симлинки и
    // рекурсивное удаление»): cleanupTestWorkdir обязан снять junction
    // src/rails ПЕРВЫМ — если бы это было не так, README нашей копии исчез бы.
    assert.ok(fs.existsSync(railsCopyReadme), 'src/rails/README.md копии должен остаться на месте');
    assert.equal(fs.readFileSync(railsCopyReadme, 'utf8'), readmeBefore, 'содержимое src/rails/README.md не должно измениться');

    const trialPath = path.join(SKILL_DIR, 'tests', 'cases', 'TC-RAILS-001', 'current', 'rails-mock-target', 'trial-1.md');
    assert.ok(fs.existsSync(trialPath), `файл вывода попытки должен быть записан: ${trialPath}`);
    const trialContent = fs.readFileSync(trialPath, 'utf8');
    const reportMatch = trialContent.match(/REPORT (\{.*\})/);
    assert.ok(reportMatch, `в выводе агента должен быть REPORT: ${trialContent}`);
    const report = JSON.parse(reportMatch[1]);

    assert.equal(report.role, 'coordinator');
    assert.equal(report.skill, SKILL_NAME);
    assert.ok(report.run && report.run.length > 0, 'WORKFLOW_RAILS_RUN должен быть задан');
    assert.equal(report.railsReadme, true, 'в test workdir должно быть видно содержимое ядра rails через junction src/rails');
    assert.equal(report.settings, true, '.claude/settings.local.json должен существовать в test workdir');
    assert.equal(report.kiloPlugin, true, '.kilo/plugin/workflow-rails.js должен существовать в test workdir');

    const judgeEnvMatch = stdout.match(/JUDGE_ENV (\{[^\n]*\})/);
    assert.ok(judgeEnvMatch, `в выводе должен быть JUDGE_ENV судьи:\n${stdout}`);
    const judgeEnv = JSON.parse(judgeEnvMatch[1]);
    assert.equal(judgeEnv.role, 'executor', 'судья должен получать WORKFLOW_RAILS_ROLE=executor');

    // Молчание output-check: первый ответ уже terminal+маркер → повтора
    // spawnTargetAgentWithRailsCheck быть не должно, вызов один (review wp5, minor).
    const targetCalls = fs.readFileSync(path.join(pipelineDir, 'target-call-count.txt'), 'utf8');
    assert.equal(targetCalls, '1', 'целевой агент должен быть вызван один раз — без повтора');
  });

  it('rails.yaml есть, первый ответ целевого агента нарушает output-check → один повтор, в trial-1.md — вывод второй попытки', async () => {
    const { stdout } = await runRunner([
      '--skill', SKILL_NAME_RETRY, '--case', 'TC-RAILS-002', '--layer', 'l2',
      '--skip-secret-scan', '--fast', '--yes',
      '--pipeline', pipelinePath
    ], tempProjectRoot);

    assert.match(stdout, /status: passed/, `прогон должен пройти:\n${stdout}`);

    const trialPath = path.join(SKILL_DIR_RETRY, 'tests', 'cases', 'TC-RAILS-002', 'current', 'rails-mock-retry-target', 'trial-1.md');
    assert.ok(fs.existsSync(trialPath), `файл вывода попытки должен быть записан: ${trialPath}`);
    const trialContent = fs.readFileSync(trialPath, 'utf8');
    assert.match(trialContent, /RAILS: P1S1/, 'в trial-1.md должен быть вывод второй (успешной) попытки, а не первой');
    assert.doesNotMatch(trialContent, /first attempt, no marker/, 'вывод первой (отклонённой) попытки не должен попасть в trial-1.md');

    const calls = fs.readFileSync(path.join(pipelineDir, 'retry-call-count.txt'), 'utf8');
    assert.equal(calls, '2', 'целевой агент должен быть вызван ровно дважды: первый ответ + один повтор с вердиктом');
  });
});
