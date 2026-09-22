import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { run } from '../rails/cli.mjs';
import { createJunction } from '../junction-manager.mjs';

// `start --session` пишет память «сессия → корень» в <WORKFLOW_HOME>/state —
// изолируем, чтобы временные корни не вытесняли реальные сессии из ~/.workflow.
process.env.WORKFLOW_HOME = mkdtempSync(join(tmpdir(), 'rails-test-home-'));
process.on('exit', () => rmSync(process.env.WORKFLOW_HOME, { recursive: true, force: true }));

const RAILS_DIR = join(process.cwd(), 'src', 'rails');
const SCRIPTS_DIR = join(process.cwd(), 'src', 'scripts');
const CLI_PATH = join(RAILS_DIR, 'cli.mjs');
const CHECK_GRAPH_SCRIPT = join(SCRIPTS_DIR, 'check-rails-graph.js');
const CHECK_COVERAGE_SCRIPT = join(SCRIPTS_DIR, 'check-rails-coverage.js');

// --- фикстура: мини-скил "clitest" из двух этапов -----------------------------
//
// Этап 4: P4E1(вход) -> P4S1(шаг, terminal ложный — не terminal) -> P5E1
// Этап 5: P5E1(вход) -> P5S1(шаг, terminal)

const SKILL_MD = `# Мини-скил CLI (skill=clitest)

\`\`\`mermaid
graph TD
    P4E1["П4 ВХОД: Начало этапа мини-скила теста CLI для рельсов процедуры"]
    P4S1["П4 ШАГ: Выполнить шаг мини-скила теста CLI и продолжить дальше"]
    P4E1 --> P4S1
    P4S1 --> P5E1

    P5E1["П5 ВХОД: Переход к финальному этапу мини-скила теста CLI процедуры"]
    P5S1["П5 ШАГ: Завершить работу и подготовить финальный ответ агента здесь"]
    P5E1 --> P5S1
\`\`\`
`;

const RAILS_YAML = [
  'version: 1',
  'skill: clitest',
  'entry: P4E1',
  'terminal: [P5S1]',
  'pause_nodes: []',
  'quote_min: 25',
  '',
  'output:',
  '  final_requires: []',
  '  max_stop_blocks: 2',
  '',
].join('\n');

const BROKEN_YAML = 'version: 1\nentry: [P0E1\n'; // незакрытая последовательность

function withProject(fn) {
  const base = mkdtempSync(join(tmpdir(), 'rails-cli-'));
  try {
    const root = join(base, 'root');
    const skillDir = join(root, '.workflow', 'src', 'skills', 'clitest');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), SKILL_MD, 'utf8');
    writeFileSync(join(skillDir, 'rails.yaml'), RAILS_YAML, 'utf8');
    fn({ root, skillDir });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// --- run(): прямой вызов (юнит-уровень) ----------------------------------------------

test('run: неизвестная команда -> code 1, список команд в stdout', () => {
  withProject(({ root }) => {
    const r = run(['bogus'], { cwd: root, env: {} });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /Неизвестная команда/);
  });
});

test('run: нет корня проекта -> code 1', () => {
  const base = mkdtempSync(join(tmpdir(), 'rails-cli-noroot-'));
  try {
    const r = run(['status'], { cwd: base, env: {} });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /не найден корень проекта/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('run start: создаёт состояние в entry, code 0', () => {
  withProject(({ root }) => {
    const sessionId = randomUUID();
    const r = run(['start', 'clitest', '--session', sessionId], { cwd: root, env: {} });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Старт: скил "clitest"/);
    assert.match(r.stdout, /P4E1/);
  });
});

test('run start: сессия занята другим скилом без --force -> code 2', () => {
  withProject(({ root, skillDir }) => {
    mkdirSync(join(root, '.workflow', 'src', 'skills', 'othertest'), { recursive: true });
    writeFileSync(
      join(root, '.workflow', 'src', 'skills', 'othertest', 'SKILL.md'),
      SKILL_MD.replace(/clitest/g, 'othertest'),
      'utf8'
    );
    writeFileSync(
      join(root, '.workflow', 'src', 'skills', 'othertest', 'rails.yaml'),
      RAILS_YAML.replace('skill: clitest', 'skill: othertest'),
      'utf8'
    );
    void skillDir;

    const sessionId = randomUUID();
    const r1 = run(['start', 'clitest', '--session', sessionId], { cwd: root, env: {} });
    assert.equal(r1.code, 0);

    const r2 = run(['start', 'othertest', '--session', sessionId], { cwd: root, env: {} });
    assert.equal(r2.code, 2);
    assert.match(r2.stdout, /--force/);

    const r3 = run(['start', 'othertest', '--session', sessionId, '--force'], { cwd: root, env: {} });
    assert.equal(r3.code, 0);
  });
});

test('run goto: успешный переход с валидной цитатой -> code 0, узел меняется', () => {
  withProject(({ root }) => {
    const sessionId = randomUUID();
    run(['start', 'clitest', '--session', sessionId], { cwd: root, env: {} });

    const r = run(
      ['goto', 'P4S1', '--quote', 'Выполнить шаг мини-скила теста CLI и продолжить дальше', '--session', sessionId],
      { cwd: root, env: {} }
    );
    assert.equal(r.code, 0);
    assert.match(r.stdout, /RAILS: числится P4S1/);

    const statusR = run(['status', '--session', sessionId], { cwd: root, env: {} });
    assert.match(statusR.stdout, /Узел: P4S1/);
  });
});

test('run goto: цитата не из лейбла узла -> code 2, три части отказа', () => {
  withProject(({ root }) => {
    const sessionId = randomUUID();
    run(['start', 'clitest', '--session', sessionId], { cwd: root, env: {} });

    const r = run(['goto', 'P4S1', '--quote', 'совершенно случайная выдуманная цитата отсюда', '--session', sessionId], {
      cwd: root,
      env: {},
    });
    assert.equal(r.code, 2);
    assert.match(r.stdout, /Отклонено: /);
    assert.match(r.stdout, /Почему: /);
    assert.match(r.stdout, /Доступно: /);
  });
});

test('run goto: без активной сессии -> code 1', () => {
  withProject(({ root }) => {
    const r = run(['goto', 'P4S1', '--quote', 'x'], { cwd: root, env: {} });
    assert.equal(r.code, 1);
  });
});

test('run status: без --session, но есть единственная сессия -> резолвится через newestSessionId', () => {
  withProject(({ root }) => {
    const sessionId = randomUUID();
    run(['start', 'clitest', '--session', sessionId], { cwd: root, env: {} });
    const r = run(['status'], { cwd: root, env: {} });
    assert.equal(r.code, 0);
    assert.match(r.stdout, new RegExp(`Сессия: ${sessionId}`));
  });
});

test('run reset: удаляет состояние и пишет событие "reset" в журнал', () => {
  withProject(({ root }) => {
    const sessionId = randomUUID();
    run(['start', 'clitest', '--session', sessionId], { cwd: root, env: {} });
    const r = run(['reset', '--session', sessionId], { cwd: root, env: {} });
    assert.equal(r.code, 0);

    const statusR = run(['status', '--session', sessionId], { cwd: root, env: {} });
    assert.equal(statusR.code, 1);
  });
});

test('run report: сводка по journal (пусто без записей)', () => {
  withProject(({ root }) => {
    const r = run(['report', '--days', '7'], { cwd: root, env: {} });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Всего записей: 0/);
  });
});

test('run report: после нескольких отказов goto -> ненулевая сводка', () => {
  withProject(({ root }) => {
    const sessionId = randomUUID();
    run(['start', 'clitest', '--session', sessionId], { cwd: root, env: {} });
    run(['goto', 'P4S1', '--quote', 'мимо', '--session', sessionId], { cwd: root, env: {} });
    run(['goto', 'P4S1', '--quote', 'мимо', '--session', sessionId], { cwd: root, env: {} });

    const r = run(['report'], { cwd: root, env: {} });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Всего записей: 2/);
  });
});

test('run report --skill: фильтрует записи журнала по скилу (§10)', () => {
  withProject(({ root }) => {
    const sessionA = randomUUID();
    const sessionB = randomUUID();
    run(['start', 'clitest', '--session', sessionA], { cwd: root, env: {} });
    run(['goto', 'P4S1', '--quote', 'мимо', '--session', sessionA], { cwd: root, env: {} });

    mkdirSync(join(root, '.workflow', 'src', 'skills', 'othertest'), { recursive: true });
    writeFileSync(
      join(root, '.workflow', 'src', 'skills', 'othertest', 'SKILL.md'),
      SKILL_MD.replace(/clitest/g, 'othertest'),
      'utf8'
    );
    writeFileSync(
      join(root, '.workflow', 'src', 'skills', 'othertest', 'rails.yaml'),
      RAILS_YAML.replace('skill: clitest', 'skill: othertest'),
      'utf8'
    );
    run(['start', 'othertest', '--session', sessionB], { cwd: root, env: {} });
    run(['goto', 'P4S1', '--quote', 'мимо', '--session', sessionB], { cwd: root, env: {} });
    run(['goto', 'P4S1', '--quote', 'мимо', '--session', sessionB], { cwd: root, env: {} });

    const rAll = run(['report'], { cwd: root, env: {} });
    assert.match(rAll.stdout, /Всего записей: 3/);

    const rClitest = run(['report', '--skill', 'clitest'], { cwd: root, env: {} });
    assert.match(rClitest.stdout, /Всего записей: 1/);

    const rOthertest = run(['report', '--skill', 'othertest'], { cwd: root, env: {} });
    assert.match(rOthertest.stdout, /Всего записей: 2/);
  });
});

test('run check --skill: валидный скил -> code 0, OK', () => {
  withProject(({ root }) => {
    const r = run(['check', '--skill', 'clitest'], { cwd: root, env: {} });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /OK/);
  });
});

test('run check --skill: битый rails.yaml -> code 1', () => {
  withProject(({ root }) => {
    const brokenDir = join(root, '.workflow', 'src', 'skills', 'broken');
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(join(brokenDir, 'SKILL.md'), '# broken', 'utf8');
    writeFileSync(join(brokenDir, 'rails.yaml'), BROKEN_YAML, 'utf8');

    const r = run(['check', '--skill', 'broken'], { cwd: root, env: {} });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /ОШИБКА ЗАГРУЗКИ/);
  });
});

test('run check --all: несколько скилов, агрегированный код 1 при ошибке в одном из них', () => {
  withProject(({ root }) => {
    const brokenDir = join(root, '.workflow', 'src', 'skills', 'broken');
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(join(brokenDir, 'SKILL.md'), '# broken', 'utf8');
    writeFileSync(join(brokenDir, 'rails.yaml'), BROKEN_YAML, 'utf8');

    const r = run(['check', '--all'], { cwd: root, env: {} });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /clitest/);
    assert.match(r.stdout, /broken/);
  });
});

test('run check --all: скил без rails.yaml пропускается, не валит код выхода (major-фикс)', () => {
  withProject(({ root }) => {
    mkdirSync(join(root, '.workflow', 'src', 'skills', 'norails'), { recursive: true });
    writeFileSync(join(root, '.workflow', 'src', 'skills', 'norails', 'SKILL.md'), '# без rails.yaml вовсе', 'utf8');

    const r = run(['check', '--all'], { cwd: root, env: {} });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /clitest/);
    assert.match(r.stdout, /norails/);
    assert.match(r.stdout, /пропущен: нет rails\.yaml/);
  });
});

test('run check: вывод упоминает границу собственного парсера mermaid (§3/§14)', () => {
  withProject(({ root }) => {
    const r = run(['check', '--skill', 'clitest'], { cwd: root, env: {} });
    assert.match(r.stdout, /собственным парсером подмножества mermaid/);
  });
});

test('run selfcheck: без .claude/settings.local.json и без .kilo/plugin -> code 1 с перечнем проблем', () => {
  withProject(({ root }) => {
    const r = run(['selfcheck'], { cwd: root, env: {} });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /settings\.local\.json/);
    assert.match(r.stdout, /workflow-rails\.js/);
  });
});

test('run selfcheck: полностью зарегистрированный проект (+ скил без rails.yaml рядом) -> code 0', () => {
  withProject(({ root, skillDir }) => {
    void skillDir;
    const hookPath = join(root, '.workflow', 'src', 'rails', 'claude-hook.mjs');
    mkdirSync(join(root, '.workflow', 'src', 'rails'), { recursive: true });
    writeFileSync(hookPath, '// заглушка хука для selfcheck\n', 'utf8');

    const claudeDir = join(root, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    const settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: '*',
            hooks: [
              {
                type: 'command',
                command: `node "${hookPath}"`,
                _workflow_rails: true,
              },
            ],
          },
        ],
      },
    };
    writeFileSync(join(claudeDir, 'settings.local.json'), JSON.stringify(settings, null, 2), 'utf8');

    const kiloPluginDir = join(root, '.kilo', 'plugin');
    mkdirSync(kiloPluginDir, { recursive: true });
    writeFileSync(
      join(kiloPluginDir, 'workflow-rails.js'),
      "export { WorkflowRails } from '../../.workflow/src/rails/kilo-plugin.mjs';\n",
      'utf8'
    );

    // Скил без rails.yaml рядом с валидным clitest — не должен ломать selfcheck (major-фикс).
    mkdirSync(join(root, '.workflow', 'src', 'skills', 'norails'), { recursive: true });
    writeFileSync(join(root, '.workflow', 'src', 'skills', 'norails', 'SKILL.md'), '# без rails.yaml', 'utf8');

    const r = run(['selfcheck'], { cwd: root, env: {} });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /OK/);
  });
});

// --- через child_process: проверка настоящего процесса cli.mjs -----------------------

function runCliProcess(args, cwd, binPath = CLI_PATH) {
  try {
    const stdout = execFileSync('node', [binPath, ...args], { cwd, encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status ?? 1, stdout: (err.stdout || '') + (err.stderr || '') };
  }
}

test('child_process: cli.mjs start + status через настоящий node-процесс', () => {
  withProject(({ root }) => {
    const sessionId = randomUUID();
    const r1 = runCliProcess(['start', 'clitest', '--session', sessionId], root);
    assert.equal(r1.code, 0);
    assert.match(r1.stdout, /Старт: скил "clitest"/);

    const r2 = runCliProcess(['status', '--session', sessionId], root);
    assert.equal(r2.code, 0);
    assert.match(r2.stdout, new RegExp(`Сессия: ${sessionId}`));
  });
});

test('child_process: cli.mjs check --skill на валидном скиле -> код выхода 0', () => {
  withProject(({ root }) => {
    const r = runCliProcess(['check', '--skill', 'clitest'], root);
    assert.equal(r.code, 0);
  });
});

test('child_process: cli.mjs check --skill на битом скиле -> код выхода 1', () => {
  withProject(({ root }) => {
    const brokenDir = join(root, '.workflow', 'src', 'skills', 'broken');
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(join(brokenDir, 'SKILL.md'), '# broken', 'utf8');
    writeFileSync(join(brokenDir, 'rails.yaml'), BROKEN_YAML, 'utf8');

    const r = runCliProcess(['check', '--skill', 'broken'], root);
    assert.equal(r.code, 1);
  });
});

test('child_process: cli.mjs goto с плохой цитатой -> код выхода 2', () => {
  withProject(({ root }) => {
    const sessionId = randomUUID();
    runCliProcess(['start', 'clitest', '--session', sessionId], root);
    const r = runCliProcess(['goto', 'P4S1', '--quote', 'левая цитата совсем', '--session', sessionId], root);
    assert.equal(r.code, 2);
  });
});

test('sanity: CLI_PATH существует (иначе child_process-тесты молчаливо ничего не проверяют)', () => {
  assert.ok(existsSync(CLI_PATH));
});

// --- через child_process: обёртки check-rails-graph.js / check-rails-coverage.js ----

function runScriptProcess(scriptPath, args, cwd) {
  try {
    const stdout = execFileSync('node', [scriptPath, ...args], { cwd, encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status ?? 1, stdout: (err.stdout || '') + (err.stderr || '') };
  }
}

test('child_process: check-rails-graph.js на валидном скиле -> код выхода 0, ---RESULT--- status: ok', () => {
  withProject(({ root }) => {
    const r = runScriptProcess(CHECK_GRAPH_SCRIPT, ['--skill', 'clitest'], root);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /---RESULT---/);
    assert.match(r.stdout, /status: ok/);
  });
});

test('child_process: check-rails-graph.js на битом скиле -> код выхода 0, ---RESULT--- status: fail', () => {
  withProject(({ root }) => {
    const brokenDir = join(root, '.workflow', 'src', 'skills', 'broken');
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(join(brokenDir, 'SKILL.md'), '# broken', 'utf8');
    writeFileSync(join(brokenDir, 'rails.yaml'), BROKEN_YAML, 'utf8');

    const r = runScriptProcess(CHECK_GRAPH_SCRIPT, ['--skill', 'broken'], root);
    assert.equal(r.code, 0, 'конвенция check-mcp.js: exit code всегда 0, результат — в status');
    assert.match(r.stdout, /status: fail/);
  });
});

test('child_process: check-rails-coverage.js оборачивает cli coverage, статус в ---RESULT---', () => {
  withProject(({ root }) => {
    const r = runScriptProcess(
      CHECK_COVERAGE_SCRIPT,
      ['--skill', 'clitest', '--baseline', 'does-not-exist'],
      root
    );
    assert.equal(r.code, 0, 'конвенция check-mcp.js: exit code всегда 0, результат — в status');
    assert.match(r.stdout, /---RESULT---/);
    assert.match(r.stdout, /status: fail/);
  });
});

test('sanity: скрипты-обёртки существуют', () => {
  assert.ok(existsSync(CHECK_GRAPH_SCRIPT));
  assert.ok(existsSync(CHECK_COVERAGE_SCRIPT));
});

// --- blocker-фикс: запуск через junction (продакшн-раскладка §2/§11) --------------
//
// Агент знает только продакшн-путь (`.workflow/src/rails/cli.mjs` — junction на
// канон, src/skills/coach/SKILL.md), а не канонический путь этого репозитория.
// Раньше isDirectRun() (дословное сравнение `import.meta.url` и
// `pathToFileURL(argv[1]).href`) не срабатывал через junction: main() не
// вызывался, `start`/`check` печатали пустоту с кодом 0. Тест запускает
// cli.mjs ИМЕННО по пути через junction, как это делает продакшн.

test('child_process: cli.mjs start через junction на src/rails -> печатает «Старт:», код 0', () => {
  withProject(({ root }) => {
    const junctionRoot = mkdtempSync(join(tmpdir(), 'rails-cli-junction-'));
    const junctionDir = join(junctionRoot, 'rails');
    try {
      createJunction(RAILS_DIR, junctionDir);
      const cliPathViaJunction = join(junctionDir, 'cli.mjs');

      const sessionId = randomUUID();
      const r = runCliProcess(['start', 'clitest', '--session', sessionId], root, cliPathViaJunction);
      assert.equal(r.code, 0);
      assert.match(r.stdout, /Старт: скил "clitest"/);
    } finally {
      rmSync(junctionRoot, { recursive: true, force: true });
    }
  });
});

test('child_process: cli.mjs check через junction на src/rails, битый скил -> код выхода 1', () => {
  withProject(({ root }) => {
    const brokenDir = join(root, '.workflow', 'src', 'skills', 'broken');
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(join(brokenDir, 'SKILL.md'), '# broken', 'utf8');
    writeFileSync(join(brokenDir, 'rails.yaml'), BROKEN_YAML, 'utf8');

    const junctionRoot = mkdtempSync(join(tmpdir(), 'rails-cli-junction-'));
    const junctionDir = join(junctionRoot, 'rails');
    try {
      createJunction(RAILS_DIR, junctionDir);
      const cliPathViaJunction = join(junctionDir, 'cli.mjs');

      const r = runCliProcess(['check', '--skill', 'broken'], root, cliPathViaJunction);
      assert.equal(r.code, 1);
    } finally {
      rmSync(junctionRoot, { recursive: true, force: true });
    }
  });
});

test('child_process: check-rails-graph.js через junction на src/scripts -> ---RESULT---, status: ok', () => {
  withProject(({ root }) => {
    const junctionRoot = mkdtempSync(join(tmpdir(), 'rails-scripts-junction-'));
    const junctionDir = join(junctionRoot, 'scripts');
    try {
      createJunction(SCRIPTS_DIR, junctionDir);
      const scriptPathViaJunction = join(junctionDir, 'check-rails-graph.js');

      const r = runScriptProcess(scriptPathViaJunction, ['--skill', 'clitest'], root);
      assert.equal(r.code, 0);
      assert.match(r.stdout, /---RESULT---/);
      assert.match(r.stdout, /status: ok/);
    } finally {
      rmSync(junctionRoot, { recursive: true, force: true });
    }
  });
});
