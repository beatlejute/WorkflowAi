import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { run } from '../rails/cli.mjs';
import { decide } from '../rails/core.mjs';
import { startState, loadState } from '../rails/state.mjs';
import { readJournal } from '../rails/journal.mjs';
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

// --- start при заданном скиле запуска (WORKFLOW_RAILS_SKILL) ---------------------------
//
// Прогон PulseProxy 2026-09-27: на стадии execute-task claude-haiku принял «Твоя роль:
// manual-testing» за скил, получил «используй --force», стартовал manual-testing с --force,
// и раннер отклонил ответ — узел не терминал скила стадии.

function addOtherSkill(root) {
  const dir = join(root, '.workflow', 'src', 'skills', 'othertest');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), SKILL_MD.replace(/clitest/g, 'othertest'), 'utf8');
  writeFileSync(join(dir, 'rails.yaml'), RAILS_YAML.replace('skill: clitest', 'skill: othertest'), 'utf8');
}

const RUN_ENV = { WORKFLOW_RAILS_SKILL: 'clitest', WORKFLOW_RAILS_ROLE: 'coordinator', WORKFLOW_RAILS_RUN: 'run-1' };

test('run start: задан WORKFLOW_RAILS_SKILL, сессия уже идёт по нему -> старт другого скила отклонён и с --force; узел и переходы в отказе, состояние не тронуто, отказ в журнале', () => {
  withProject(({ root }) => {
    addOtherSkill(root);
    const sessionId = randomUUID();
    // Так состояние создаёт хук при первом действии стадии.
    startState({ root, sessionId, skill: 'clitest', entry: 'P4E1', run: 'run-1' });

    for (const force of [[], ['--force']]) {
      const r = run(['start', 'othertest', '--session', sessionId, ...force], { cwd: root, env: RUN_ENV });
      assert.equal(r.code, 2);
      assert.match(r.stdout, /скил этого запуска — "clitest"/);
      assert.match(r.stdout, /Скил "othertest" в этом запуске не стартует, --force этого не меняет/);
      assert.match(r.stdout, /Роль и тип задачи в промпте описывают содержание работы/);
      assert.match(r.stdout, /числится P4E1 «П4 ВХОД/);
      assert.match(r.stdout, /cli\.mjs goto P4S1 --quote/);
      assert.doesNotMatch(r.stdout, /Используй --force/);
      // Имя переменной окружения агенту не называется: незачем знать, что подменять в команде.
      assert.doesNotMatch(r.stdout, /WORKFLOW_RAILS/);
    }

    const state = loadState(root, sessionId);
    assert.equal(state.skill, 'clitest');
    assert.equal(state.node, 'P4E1');

    const denials = readJournal(root, {}).filter((e) => e.type === 'denial' && e.session === sessionId);
    assert.equal(denials.length, 2);
    assert.equal(denials[0].skill, 'clitest');
    assert.equal(denials[0].node, 'P4E1');
    assert.equal(denials[0].run, 'run-1');
    assert.equal(denials[0].command, 'start othertest');
  });
});

test('run start: задан WORKFLOW_RAILS_SKILL, состояния нет или оно чужое -> отказ даёт команду старта скила запуска', () => {
  withProject(({ root }) => {
    addOtherSkill(root);
    const sessionId = randomUUID();
    const r1 = run(['start', 'othertest', '--session', sessionId], { cwd: root, env: RUN_ENV });
    assert.equal(r1.code, 2);
    assert.match(r1.stdout, new RegExp(`Старт скила запуска: node \\.workflow/src/rails/cli\\.mjs start clitest --session ${sessionId}\\n`));
    assert.equal(loadState(root, sessionId), null);

    // Сессия уже привязана к третьему скилу (например, с --force до этой проверки).
    startState({ root, sessionId, skill: 'othertest', entry: 'P4E1' });
    const r2 = run(['start', 'othertest', '--session', sessionId, '--force'], { cwd: root, env: RUN_ENV });
    assert.equal(r2.code, 2);
    assert.match(r2.stdout, /start clitest --session \S+ --force\n/);
    assert.equal(loadState(root, sessionId).skill, 'othertest');
  });
});

// Префикс `WORKFLOW_RAILS_SKILL=othertest node …cli.mjs start othertest` (POSIX, хук пропускает
// его как cli-вызов и вставляет --session своей сессии) подменяет переменную в окружении CLI.
// Состояние той сессии хук уже создал при первом действии — с `run` запуска и скилом запуска;
// отказ сверяется с ним, а не только с переменной.
test('run start: состояние сессии привязано к запуску (run), переменная скила подменена или снята -> другой скил отклонён и с --force', () => {
  withProject(({ root }) => {
    addOtherSkill(root);
    const sessionId = randomUUID();
    startState({ root, sessionId, skill: 'clitest', entry: 'P4E1', run: 'run-1' });

    for (const env of [{ ...RUN_ENV, WORKFLOW_RAILS_SKILL: 'othertest' }, { WORKFLOW_RAILS_RUN: 'run-1' }, {}]) {
      for (const force of [[], ['--force']]) {
        const r = run(['start', 'othertest', '--session', sessionId, ...force], { cwd: root, env });
        assert.equal(r.code, 2, JSON.stringify({ env, force }));
        assert.match(r.stdout, /скил этого запуска — "clitest"/);
        assert.match(r.stdout, /числится P4E1 «П4 ВХОД/);
        assert.match(r.stdout, /cli\.mjs goto P4S1 --quote/);
        assert.doesNotMatch(r.stdout, /Используй --force/);
      }
    }
    const state = loadState(root, sessionId);
    assert.equal(state.skill, 'clitest');
    assert.equal(state.run, 'run-1');
  });
});

test('run start: задан WORKFLOW_RAILS_SKILL -> сам скил запуска стартует как раньше', () => {
  withProject(({ root }) => {
    const sessionId = randomUUID();
    const r = run(['start', 'clitest', '--session', sessionId], { cwd: root, env: RUN_ENV });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Старт: скил "clitest"/);
    assert.equal(loadState(root, sessionId).run, 'run-1');
  });
});

test('run start: WORKFLOW_RAILS_SKILL без rails.yaml -> отказа нет, другой скил стартует как раньше', () => {
  withProject(({ root }) => {
    mkdirSync(join(root, '.workflow', 'src', 'skills', 'norails'), { recursive: true });
    const sessionId = randomUUID();
    const r = run(['start', 'clitest', '--session', sessionId], { cwd: root, env: { WORKFLOW_RAILS_SKILL: 'norails' } });
    assert.equal(r.code, 0);
    assert.equal(loadState(root, sessionId).skill, 'clitest');
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

// Страж ребра (edge_guards) проверяется только при переданном `root`, а в проде его
// передаёт один вызов — cmdGoto. Без этого теста потеря аргумента выключила бы страж
// молча (инцидент 2026-09-27: «тикет не найден» при тикете в in-progress/).
// cwd — подкаталог проекта: пути стража считаются от найденного корня, а не от cwd.
test('run goto: страж ребра — файл есть -> code 2 с причиной и путём, файла нет -> переход', () => {
  withProject(({ root, skillDir }) => {
    writeFileSync(join(skillDir, 'rails.yaml'), `${RAILS_YAML}${[
      'edge_guards:',
      '  - from: P4E1',
      '    to: P4S1',
      '    deny_if_exists: ".workflow/tickets/in-progress/*.md"',
      '    reason: "В in-progress/ есть тикет — ветка закрыта стражем"',
      '',
    ].join('\n')}`, 'utf8');
    const inProgress = join(root, '.workflow', 'tickets', 'in-progress');
    mkdirSync(inProgress, { recursive: true });
    writeFileSync(join(inProgress, 'TASK-001.md'), '# TASK-001\n', 'utf8');
    const sub = join(root, 'src', 'deep');
    mkdirSync(sub, { recursive: true });

    const sessionId = randomUUID();
    assert.equal(run(['start', 'clitest', '--session', sessionId], { cwd: root, env: {} }).code, 0);
    const argv = ['goto', 'P4S1', '--quote', 'Выполнить шаг мини-скила теста CLI и продолжить дальше', '--session', sessionId];

    for (const cwd of [root, sub]) {
      const denied = run(argv, { cwd, env: {} });
      assert.equal(denied.code, 2, cwd);
      assert.match(denied.stdout, /Почему: В in-progress\/ есть тикет — ветка закрыта стражем \(есть \.workflow\/tickets\/in-progress\/TASK-001\.md\)/, cwd);
      assert.equal(loadState(root, sessionId).node, 'P4E1', cwd);
    }
    const journal = readJournal(root);
    assert.equal(journal.filter((e) => /ветка закрыта стражем/.test(e.reason || '')).length, 2);

    rmSync(join(inProgress, 'TASK-001.md'));
    const passed = run(argv, { cwd: sub, env: {} });
    assert.equal(passed.code, 0, passed.stdout);
    assert.match(passed.stdout, /RAILS: числится P4S1/);
  });
});

// `{ticket}` — тикет запуска; без хука состояние создаёт `start` и берёт тикет из
// WORKFLOW_RAILS_TICKET окружения CLI (ставит раннер). Ревью стража 2026-09-27: страж
// закрывал ребро из-за любого тикета в in-progress/, а закрытое ребро перечни переходов
// рекламировали готовой командой — слабые модели её копируют.
// Второе ребро P4E1 → P5E1 — чтобы видеть, что открытое ребро команду сохраняет.
test('run start/goto: страж с {ticket} — свой тикет: code 2, в «Доступно» ребро «закрыто» без команды; только чужой тикет — переход', () => {
  withProject(({ root, skillDir }) => {
    writeFileSync(join(skillDir, 'SKILL.md'), SKILL_MD.replace('    P4E1 --> P4S1\n', '    P4E1 --> P4S1\n    P4E1 --> P5E1\n'), 'utf8');
    writeFileSync(join(skillDir, 'rails.yaml'), `${RAILS_YAML}${[
      'edge_guards:',
      '  - from: P4E1',
      '    to: P4S1',
      '    deny_if_exists: ".workflow/tickets/in-progress/{ticket}.md"',
      '    reason: "Тикет запуска в in-progress/ есть — ветка закрыта стражем"',
      '',
    ].join('\n')}`, 'utf8');
    const checked = run(['check', '--skill', 'clitest'], { cwd: root, env: {} });
    assert.equal(checked.code, 0, `rails.yaml со стражем {ticket} проходит check:\n${checked.stdout}`);
    const inProgress = join(root, '.workflow', 'tickets', 'in-progress');
    mkdirSync(inProgress, { recursive: true });
    writeFileSync(join(inProgress, 'TASK-001.md'), '# TASK-001\n', 'utf8');
    const closed = /P4S1: .* — закрыто: Тикет запуска в in-progress\/ есть — ветка закрыта стражем \(есть \.workflow\/tickets\/in-progress\/TASK-001\.md\)/;
    const own = { WORKFLOW_RAILS_TICKET: 'TASK-001' };

    const sessionId = randomUUID();
    const started = run(['start', 'clitest', '--session', sessionId], { cwd: root, env: own });
    assert.equal(started.code, 0, started.stdout);
    assert.match(started.stdout, closed);
    assert.doesNotMatch(started.stdout, /goto P4S1/);
    assert.match(started.stdout, /P5E1: .* → node \.workflow\/src\/rails\/cli\.mjs goto P5E1 --quote '/);

    const argv = ['goto', 'P4S1', '--quote', 'Выполнить шаг мини-скила теста CLI и продолжить дальше', '--session', sessionId];
    const denied = run(argv, { cwd: root, env: own });
    assert.equal(denied.code, 2, denied.stdout);
    assert.match(denied.stdout, /Почему: Тикет запуска в in-progress\/ есть — ветка закрыта стражем \(есть \.workflow\/tickets\/in-progress\/TASK-001\.md\)/);
    const available = denied.stdout.split('\n').find((l) => l.startsWith('Доступно: ')) ?? '';
    assert.match(available, closed);
    assert.doesNotMatch(available, /goto P4S1/);
    assert.match(available, /goto P5E1 --quote '/);
    assert.equal(loadState(root, sessionId).node, 'P4E1');

    // В in-progress/ только чужой тикет, а тикет запуска другой — ветка открыта.
    const foreignSession = randomUUID();
    assert.equal(run(['start', 'clitest', '--session', foreignSession], { cwd: root, env: { WORKFLOW_RAILS_TICKET: 'TASK-002' } }).code, 0);
    const passed = run(['goto', 'P4S1', '--quote', 'Выполнить шаг мини-скила теста CLI и продолжить дальше', '--session', foreignSession], { cwd: root, env: {} });
    assert.equal(passed.code, 0, passed.stdout);
    assert.match(passed.stdout, /RAILS: числится P4S1/);
  });
});

// Тикет запуска — из состояния сессии (§5): хук пишет его из окружения хоста при первом
// действии агента, раньше, чем выполнится `start`. Ревью стража 2026-09-27: `goto` брал
// тикет из окружения CLI, и агент открывал страж подменой — `WORKFLOW_RAILS_TICKET=… node
// …cli.mjs goto`, пустым значением или `unset`: такие команды общие правила хука пропускают.
// Там же два перечня переходов, которые не проверял ни один тест: после успешного `goto`
// (рёбра нового узла агент видит именно там) и в отказе `start` чужого скила.
test('run start/goto: тикет {ticket} — из состояния, созданного хуком: подмена окружения CLI страж не открывает; «закрыто» и после goto, и в отказе start чужого скила', () => {
  withProject(({ root, skillDir }) => {
    writeFileSync(join(skillDir, 'rails.yaml'), `${RAILS_YAML}${[
      'edge_guards:',
      '  - from: P4S1',
      '    to: P5E1',
      '    deny_if_exists: ".workflow/tickets/in-progress/{ticket}.md"',
      '    reason: "Тикет запуска в in-progress/ есть — ветка закрыта стражем"',
      '',
    ].join('\n')}`, 'utf8');
    const inProgress = join(root, '.workflow', 'tickets', 'in-progress');
    mkdirSync(inProgress, { recursive: true });
    writeFileSync(join(inProgress, 'TASK-001.md'), '# TASK-001\n', 'utf8');
    const closed = /P5E1: .* — закрыто: Тикет запуска в in-progress\/ есть — ветка закрыта стражем \(есть \.workflow\/tickets\/in-progress\/TASK-001\.md\)/;

    // Хук под окружением хоста раннера (скил и тикет запуска): состояния нет — создаёт его.
    const sessionId = randomUUID();
    const prevSkill = process.env.WORKFLOW_RAILS_SKILL;
    const prevTicket = process.env.WORKFLOW_RAILS_TICKET;
    process.env.WORKFLOW_RAILS_SKILL = 'clitest';
    process.env.WORKFLOW_RAILS_TICKET = 'TASK-001';
    try {
      assert.equal(decide({ action: { tool: 'Read', kind: 'read' }, ctx: { cwd: root, sessionId } }).decision, 'allow');
    } finally {
      if (prevSkill === undefined) delete process.env.WORKFLOW_RAILS_SKILL;
      else process.env.WORKFLOW_RAILS_SKILL = prevSkill;
      if (prevTicket === undefined) delete process.env.WORKFLOW_RAILS_TICKET;
      else process.env.WORKFLOW_RAILS_TICKET = prevTicket;
    }
    assert.equal(loadState(root, sessionId).ticket, 'TASK-001', 'хук пишет тикет хоста в состояние');

    // Агент: окружение CLI с чужим тикетом, пустым и без переменной.
    const spoofed = [{ WORKFLOW_RAILS_TICKET: 'zzz' }, { WORKFLOW_RAILS_TICKET: '' }, {}];
    const started = run(['start', 'clitest', '--session', sessionId], { cwd: root, env: spoofed[0] });
    assert.equal(started.code, 0, started.stdout);
    assert.equal(loadState(root, sessionId).ticket, 'TASK-001', 'start сохраняет тикет состояния, созданного хуком');

    const moved = run(['goto', 'P4S1', '--quote', 'Выполнить шаг мини-скила теста CLI и продолжить дальше', '--session', sessionId], { cwd: root, env: spoofed[0] });
    assert.equal(moved.code, 0, moved.stdout);
    assert.match(moved.stdout, /RAILS: числится P4S1/);
    assert.match(moved.stdout, closed);
    assert.doesNotMatch(moved.stdout, /goto P5E1/);

    const argv = ['goto', 'P5E1', '--quote', 'Переход к финальному этапу мини-скила теста CLI процедуры', '--session', sessionId];
    for (const env of spoofed) {
      const denied = run(argv, { cwd: root, env });
      assert.equal(denied.code, 2, `${JSON.stringify(env)}: ${denied.stdout}`);
      assert.match(denied.stdout, /Почему: Тикет запуска в in-progress\/ есть — ветка закрыта стражем/);
    }
    assert.equal(loadState(root, sessionId).node, 'P4S1');

    // Отказ `start` чужого скила при скиле запуска: переходы из узла сессии — тоже «закрыто».
    const refused = run(['start', 'other', '--session', sessionId], { cwd: root, env: { WORKFLOW_RAILS_SKILL: 'clitest' } });
    assert.equal(refused.code, 2, refused.stdout);
    assert.match(refused.stdout, /числится P4S1/);
    assert.match(refused.stdout, closed);
    assert.doesNotMatch(refused.stdout, /goto P5E1/);
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

// Инцидент 2026-09-23: в проекте работали две сессии коуча; `goto` без `--session` ушёл в
// самую свежую (чужую) сессию, и в её журнал попал отказ по чужому узлу. Теперь при двух и
// более сессиях CLI отказывает; явная сессия работает по-прежнему.
test('run: две сессии проекта и нет --session -> code 1, перечень сессий, чужое состояние не тронуто', () => {
  withProject(({ root }) => {
    const mine = randomUUID();
    const other = randomUUID();
    run(['start', 'clitest', '--session', mine], { cwd: root, env: {} });
    run(['start', 'clitest', '--session', other], { cwd: root, env: {} });

    for (const argv of [['status'], ['goto', 'P4S1', '--quote', 'Выполнить шаг мини-скила теста CLI'], ['reset']]) {
      const r = run(argv, { cwd: root, env: {} });
      assert.equal(r.code, 1, argv.join(' '));
      assert.match(r.stdout, /--session не задан/, argv.join(' '));
      assert.match(r.stdout, new RegExp(mine), argv.join(' '));
      assert.match(r.stdout, new RegExp(other), argv.join(' '));
    }

    // Ни одна из сессий не сдвинулась и не удалена: отказ произошёл до загрузки состояния.
    for (const sessionId of [mine, other]) {
      const st = run(['status', '--session', sessionId], { cwd: root, env: {} });
      assert.equal(st.code, 0);
      assert.match(st.stdout, /Узел: P4E1/);
    }
    // Журнал отказов пуст: чужой отказ в него не попал.
    const journal = join(root, '.workflow', 'logs', 'rails-denials.jsonl');
    const denials = existsSync(journal) ? readFileSync(journal, 'utf8').trim() : '';
    assert.equal(denials.includes('P4E1'), false, 'отказ по узлу чужой сессии в журнал не пишется');
  });
});

test('run: две сессии проекта, сессия задана явно или через WORKFLOW_RAILS_SESSION -> работает', () => {
  withProject(({ root }) => {
    const mine = randomUUID();
    const other = randomUUID();
    run(['start', 'clitest', '--session', mine], { cwd: root, env: {} });
    run(['start', 'clitest', '--session', other], { cwd: root, env: {} });

    const explicit = run(['status', '--session', mine], { cwd: root, env: {} });
    assert.equal(explicit.code, 0);
    assert.match(explicit.stdout, new RegExp(`Сессия: ${mine}`));

    const viaEnv = run(['status'], { cwd: root, env: { WORKFLOW_RAILS_SESSION: mine } });
    assert.equal(viaEnv.code, 0);
    assert.match(viaEnv.stdout, new RegExp(`Сессия: ${mine}`));
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

// Окружение дочернего cli.mjs — без WORKFLOW_RAILS_* прогона, внутри которого идут тесты
// (их запускает и агент стадии пайплайна): его SESSION и RUN ушли бы в start/goto временного
// проекта, а SKILL дал бы отказ `start`, только если в фикстуре есть скил с тем же именем.
// `extraEnv` задаёт переменные явно.
function runCliProcess(args, cwd, binPath = CLI_PATH, extraEnv = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^WORKFLOW_RAILS_/i.test(k)));
  try {
    const stdout = execFileSync('node', [binPath, ...args], { cwd, encoding: 'utf8', env: { ...env, ...extraEnv } });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status ?? 1, stdout: (err.stdout || '') + (err.stderr || '') };
  }
}

test('child_process: WORKFLOW_RAILS_SKILL в окружении процесса -> start другого скила — код выхода 2 и команда старта скила запуска', () => {
  withProject(({ root }) => {
    addOtherSkill(root);
    const sessionId = randomUUID();
    const r = runCliProcess(['start', 'othertest', '--session', sessionId, '--force'], root, CLI_PATH, { WORKFLOW_RAILS_SKILL: 'clitest' });
    assert.equal(r.code, 2);
    assert.match(r.stdout, /скил этого запуска — "clitest"/);
    assert.match(r.stdout, /start clitest --session/);
  });
});

test('child_process: префикс подменил WORKFLOW_RAILS_SKILL на запрошенный скил, состояние сессии привязано к запуску -> код выхода 2', () => {
  withProject(({ root }) => {
    addOtherSkill(root);
    const sessionId = randomUUID();
    startState({ root, sessionId, skill: 'clitest', entry: 'P4E1', run: 'run-1' });
    const r = runCliProcess(['start', 'othertest', '--session', sessionId, '--force'], root, CLI_PATH, {
      WORKFLOW_RAILS_SKILL: 'othertest',
      WORKFLOW_RAILS_RUN: 'run-1',
    });
    assert.equal(r.code, 2);
    assert.match(r.stdout, /скил этого запуска — "clitest"/);
    assert.equal(loadState(root, sessionId).skill, 'clitest');
  });
});

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
