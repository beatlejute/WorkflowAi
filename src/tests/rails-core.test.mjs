import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  utimesSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';

import { decide, buildDenyReason, loadSkillRuntime } from '../rails/core.mjs';
import { startState, saveState, loadState } from '../rails/state.mjs';
import { readJournal } from '../rails/journal.mjs';
import { createJunction } from '../junction-manager.mjs';
import { fromClaude } from '../rails/actions.mjs';

// Память «сессия → корень» (session-memo.mjs) живёт в <WORKFLOW_HOME>/state —
// тесты изолируют её, иначе временные корни вытесняют реальные сессии
// из ~/.workflow/state/rails-sessions.json.
process.env.WORKFLOW_HOME = mkdtempSync(join(tmpdir(), 'rails-test-home-'));
process.on('exit', () => rmSync(process.env.WORKFLOW_HOME, { recursive: true, force: true }));

const uuid = () => randomUUID();

// --- фикстура проекта: root с .workflow, скил "coretest" ---------------------
//
// Граф (SKILL.md):
//   этап 4: P4E1(вход) -> P4R1(правило) -> P4S1(шаг) -> P5E1
//   этап 5: P5E1(вход) -> P5S1(шаг, terminal)
// rails.yaml:
//   write_scope: .workflow/work/**  (+ allow_temp)
//   write_deny:  .workflow/work/denied.txt
//   deny_shell:  git commit|push
//   deny_mcp:    git_commit
//   canary:      "echo RAILS_CANARY"
//   stage_actions.do_edit: kind edit, match .workflow/work/**, stages [4], max_per_session 2

const SKILL_MD = `# Фикстура ядра rails (skill=coretest)

\`\`\`mermaid
graph TD
    P4E1["П4 ВХОД: Начало этапа правки рабочих файлов теста ядра рельсов"]
    P4R1["П4 ПРАВИЛО: Править можно только внутри рабочей области теста ядра"]
    P4S1["П4 ШАГ: Внести правку рабочего файла и продолжить дальше по графу"]
    P4E1 --> P4R1
    P4R1 --> P4S1
    P4S1 --> P5E1

    P5E1["П5 ВХОД: Переход к финальному этапу теста ядра рельсов процедуры"]
    P5S1["П5 ШАГ: Завершить работу и подготовить финальный ответ агента здесь"]
    P5E1 --> P5S1
\`\`\`
`;

function railsYaml({ allowTemp = true } = {}) {
  return [
    'version: 1',
    'skill: coretest',
    'entry: P4E1',
    'terminal: [P5S1]',
    'pause_nodes: []',
    'quote_min: 25',
    'canary: "echo RAILS_CANARY"',
    '',
    'write_scope:',
    '  - ".workflow/work/**"',
    `allow_temp: ${allowTemp}`,
    'write_deny:',
    '  - ".workflow/work/denied.txt"',
    '',
    'deny_shell:',
    '  - pattern: "\\\\bgit\\\\s+(commit|push)\\\\b"',
    '    reason: "коуч не делает git-операции"',
    '    incident: "SKILL.md запрет git"',
    'deny_mcp:',
    '  - git_commit',
    '',
    'stage_actions:',
    '  do_edit:',
    '    kind: [edit]',
    '    match: ".workflow/work/**"',
    '    stages: [4]',
    '    max_per_session: 2',
    '',
    'output:',
    '  final_requires: []',
    '  max_stop_blocks: 2',
    '',
  ].join('\n');
}

// root/.workflow/src/skills/coretest — обычный каталог (без junction), плюс
// root/.workflow/work — рабочая область write_scope.
function withProject(fn, { allowTemp = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'rails-core-'));
  try {
    const root = join(base, 'root');
    const skillDir = join(root, '.workflow', 'src', 'skills', 'coretest');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), SKILL_MD, 'utf8');
    writeFileSync(join(skillDir, 'rails.yaml'), railsYaml({ allowTemp }), 'utf8');
    mkdirSync(join(root, '.workflow', 'work'), { recursive: true });
    fn({ root, skillDir });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function makeState(root, node, extra = {}) {
  const sessionId = uuid();
  const state = startState({ root, sessionId, skill: 'coretest', entry: 'P4E1' });
  state.node = node;
  Object.assign(state, extra);
  saveState(root, state);
  return { sessionId, state };
}

// --- §7.1: нет корня проекта -------------------------------------------------

test('decide: нет корня проекта -> allow без текста (silent)', () => {
  const base = mkdtempSync(join(tmpdir(), 'rails-core-noroot-'));
  try {
    const r = decide({
      action: { tool: 'Bash', kind: 'shell', command: 'echo hi' },
      ctx: { cwd: base, sessionId: uuid() },
    });
    assert.deepEqual(r, { decision: 'allow' });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// --- зонтик: cwd вне проекта, но цель edit/write внутри проекта (2026-09-22) ---

test('decide: cwd без корня проекта, но путь Edit внутри skills/** проекта -> корень от пути, G0 отклоняет', () => {
  const base = mkdtempSync(join(tmpdir(), 'rails-core-umbrella-'));
  try {
    const root = join(base, 'proj');
    const skillDir = join(root, '.workflow', 'src', 'skills', 'coretest');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), SKILL_MD, 'utf8');
    writeFileSync(join(skillDir, 'rails.yaml'), railsYaml(), 'utf8');
    const r = decide({
      action: { tool: 'Edit', kind: 'edit', path: join(skillDir, 'SKILL.md') },
      ctx: { cwd: base, sessionId: uuid() }, // base — зонтик без .workflow
    });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /коуча на рельсах/);
    const shell = decide({
      action: { tool: 'Bash', kind: 'shell', command: 'echo RAILS_CANARY' },
      ctx: { cwd: base, sessionId: uuid() },
    });
    assert.deepEqual(shell, { decision: 'allow' }, 'shell без пути — корень не выводится, молчание');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// --- дедупликация по toolUseId: хук у пользователя и в проекте (2026-09-22) ---

test('decide: тот же toolUseId дважды -> второй ответ из кэша, счётчики и журнал не растут', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const canary = { tool: 'Bash', kind: 'shell', command: 'echo RAILS_CANARY' };
    const first = decide({ action: canary, ctx: { cwd: root, sessionId, toolUseId: 'toolu_1', event: 'PreToolUse' } });
    const second = decide({ action: canary, ctx: { cwd: root, sessionId, toolUseId: 'toolu_1', event: 'PreToolUse' } });
    assert.equal(first.decision, 'deny');
    assert.equal(second.decision, 'deny');
    assert.equal(second.deduped, true);
    assert.equal(second.reason, first.reason);
    assert.equal(loadState(root, sessionId).denials.P4S1, 1, 'отказ засчитан один раз');
    assert.equal(readJournal(root, {}).filter((e) => e.type !== 'error' && e.node === 'P4S1').length, 1, 'одна запись в журнале');

    const third = decide({ action: canary, ctx: { cwd: root, sessionId, toolUseId: 'toolu_2', event: 'PreToolUse' } });
    assert.equal(third.deduped, undefined);
    assert.equal(loadState(root, sessionId).denials.P4S1, 2, 'новый вызов — новый отказ');
  });
});

// --- §7.2: role === "executor" -----------------------------------------------

test('decide: role="executor" -> allow без текста, даже для явно запрещённого действия', () => {
  withProject(({ root }) => {
    const r = decide({
      action: { tool: 'Bash', kind: 'shell', command: 'echo RAILS_CANARY' },
      ctx: { cwd: root, sessionId: uuid(), role: 'executor' },
    });
    assert.deepEqual(r, { decision: 'allow' });
  });
});

test('decide: role="executor" через WORKFLOW_RAILS_ROLE (env, без ctx.role) -> allow без текста', () => {
  withProject(({ root }) => {
    const prev = process.env.WORKFLOW_RAILS_ROLE;
    process.env.WORKFLOW_RAILS_ROLE = 'executor';
    try {
      const r = decide({
        action: { tool: 'Bash', kind: 'shell', command: 'echo RAILS_CANARY' },
        ctx: { cwd: root, sessionId: uuid() },
      });
      assert.deepEqual(r, { decision: 'allow' });
    } finally {
      if (prev === undefined) delete process.env.WORKFLOW_RAILS_ROLE;
      else process.env.WORKFLOW_RAILS_ROLE = prev;
    }
  });
});

// --- §7.3: G0 — режим без скила ------------------------------------------------

test('decide: без состояния и без WORKFLOW_RAILS_SKILL — edit внутри skills/** отклоняется (G0)', () => {
  withProject(({ root, skillDir }) => {
    const r = decide({
      action: { tool: 'Edit', kind: 'edit', path: join(skillDir, 'SKILL.md') },
      ctx: { cwd: root, sessionId: uuid() },
    });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /коуча на рельсах/);
    assert.match(r.reason, /cli\.mjs start coach/);
  });
});

test('decide: G0 — edit вне skills/** разрешён (единственный гард — сама область skills)', () => {
  withProject(({ root }) => {
    const outside = join(root, '.workflow', 'coach-backlog.yaml');
    writeFileSync(outside, 'x', 'utf8');
    const r = decide({
      action: { tool: 'Edit', kind: 'edit', path: outside },
      ctx: { cwd: root, sessionId: uuid() },
    });
    assert.deepEqual(r, { decision: 'allow' });
  });
});

test('decide: G0 — произвольная shell-команда без состояния и без WORKFLOW_RAILS_SKILL — allow (G0 гард только на edit|write)', () => {
  withProject(({ root }) => {
    const r = decide({
      action: { tool: 'Bash', kind: 'shell', command: 'rm -rf .workflow/src/skills/coretest' },
      ctx: { cwd: root, sessionId: uuid() },
    });
    assert.deepEqual(r, { decision: 'allow' });
  });
});

test('decide: G0 — Write внутри skills/** тоже отклоняется (гард не только на Edit)', () => {
  withProject(({ root, skillDir }) => {
    const r = decide({
      action: { tool: 'Write', kind: 'write', path: join(skillDir, 'new-file.md') },
      ctx: { cwd: root, sessionId: uuid() },
    });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /коуча на рельсах/);
  });
});

// --- найдено ревью (minor): WORKFLOW_RAILS_SKILL задан, но sessionId нет ----

test('decide: WORKFLOW_RAILS_SKILL задан, но ctx.sessionId отсутствует -> режим G0 с явным предупреждением, не ошибка хука', () => {
  withProject(({ root, skillDir }) => {
    const prev = process.env.WORKFLOW_RAILS_SKILL;
    process.env.WORKFLOW_RAILS_SKILL = 'coretest';
    const origWrite = process.stderr.write;
    let stderrText = '';
    process.stderr.write = (chunk, ...rest) => {
      stderrText += String(chunk);
      return true;
      void rest;
    };
    try {
      const r = decide({
        action: { tool: 'Edit', kind: 'edit', path: join(skillDir, 'SKILL.md') },
        ctx: { cwd: root }, // sessionId отсутствует
      });
      assert.equal(r.decision, 'deny');
      assert.match(r.reason, /коуча на рельсах/);
      assert.match(stderrText, /sessionId отсутствует/);

      const entries = readJournal(root, {});
      const errors = entries.filter((e) => e.type === 'error');
      assert.equal(errors.length, 0, 'не должно маскироваться под ошибку хука (type=error)');
    } finally {
      process.stderr.write = origWrite;
      if (prev === undefined) delete process.env.WORKFLOW_RAILS_SKILL;
      else process.env.WORKFLOW_RAILS_SKILL = prev;
    }
  });
});

test('decide: G0 — правка скила через КАНОНИЧЕСКИЙ путь (junction) тоже отклоняется (realpath, §2)', () => {
  const base = mkdtempSync(join(tmpdir(), 'rails-core-junction-'));
  try {
    const root = join(base, 'root');
    const canon = join(base, 'canon', 'coretest');
    const skillsDir = join(root, '.workflow', 'src', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    mkdirSync(canon, { recursive: true });
    writeFileSync(join(canon, 'SKILL.md'), SKILL_MD, 'utf8');
    writeFileSync(join(canon, 'rails.yaml'), railsYaml(), 'utf8');
    createJunction(canon, join(skillsDir, 'coretest'));

    const r = decide({
      action: { tool: 'Edit', kind: 'edit', path: join(canon, 'SKILL.md') },
      ctx: { cwd: root, sessionId: uuid() },
    });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /коуча на рельсах/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// --- §5: авто-старт состояния при WORKFLOW_RAILS_SKILL -----------------------

test('decide: нет состояния, задан WORKFLOW_RAILS_SKILL -> состояние создаётся в entry при первом действии', () => {
  withProject(({ root }) => {
    const sessionId = uuid();
    const prev = process.env.WORKFLOW_RAILS_SKILL;
    process.env.WORKFLOW_RAILS_SKILL = 'coretest';
    try {
      assert.equal(loadState(root, sessionId), null);
      const r = decide({
        action: { tool: 'Read', kind: 'read' },
        ctx: { cwd: root, sessionId },
      });
      assert.equal(r.decision, 'allow');
      const state = loadState(root, sessionId);
      assert.ok(state, 'состояние должно быть создано');
      assert.equal(state.node, 'P4E1');
      assert.equal(state.skill, 'coretest');
    } finally {
      if (prev === undefined) delete process.env.WORKFLOW_RAILS_SKILL;
      else process.env.WORKFLOW_RAILS_SKILL = prev;
    }
  });
});

// --- §7.4.1: cli.mjs — служебная команда --------------------------------------

test('decide: команда cli.mjs без --session -> allow, updatedCommand с добавленным --session', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const r = decide({
      action: { tool: 'Bash', kind: 'shell', command: 'node .workflow/src/rails/cli.mjs status' },
      ctx: { cwd: root, sessionId },
    });
    assert.equal(r.decision, 'allow');
    assert.equal(r.updatedCommand, `node .workflow/src/rails/cli.mjs status --session ${sessionId}`);
  });
});

test('decide: команда cli.mjs уже с --session -> allow, без updatedCommand', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const r = decide({
      action: {
        tool: 'Bash',
        kind: 'shell',
        command: `node .workflow/src/rails/cli.mjs goto P5E1 --quote "x" --session ${sessionId}`,
      },
      ctx: { cwd: root, sessionId },
    });
    assert.equal(r.decision, 'allow');
    assert.equal(r.updatedCommand, undefined);
  });
});

// --- прогоны 2026-09-22: cd-префикс, цепочка cli-сегментов, цитата с «git commit» ----

test('decide: `cd "<dir>" && node …cli.mjs goto …` с цитатой «git commit» — это вызов cli, allow с инъекцией --session', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const command = `cd "${root}" && node .workflow/src/rails/cli.mjs goto P5E1 --quote "Коуч не выполняет git-операции — git commit, git add"`;
    const r = decide({ action: { tool: 'Bash', kind: 'shell', command }, ctx: { cwd: root, sessionId } });
    assert.equal(r.decision, 'allow');
    assert.equal(r.updatedCommand, `cd "${root}" && node .workflow/src/rails/cli.mjs goto P5E1 --quote "Коуч не выполняет git-операции — git commit, git add" --session ${sessionId}`);
  });
});

test('decide: цепочка cli-сегментов с `| head` — каждый получает --session перед пайпом', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const command = 'node .workflow/src/rails/cli.mjs goto P4R1 --quote "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" | head -c 20 && node .workflow/src/rails/cli.mjs status | head -3';
    const r = decide({ action: { tool: 'Bash', kind: 'shell', command }, ctx: { cwd: root, sessionId } });
    assert.equal(r.decision, 'allow');
    assert.equal(
      r.updatedCommand,
      `node .workflow/src/rails/cli.mjs goto P4R1 --quote "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" --session ${sessionId} | head -c 20 && node .workflow/src/rails/cli.mjs status --session ${sessionId} | head -3`
    );
  });
});

test('decide: цепочка cli-сегментов с `2>&1` (редирект, не разделитель) — allow, --session перед редиректом не требуется', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const command = `cd "${root}" && node .workflow/src/rails/cli.mjs goto P4R1 --quote "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" --session ${sessionId} 2>&1 && node .workflow/src/rails/cli.mjs status --session ${sessionId} 2>&1`;
    const r = decide({ action: { tool: 'Bash', kind: 'shell', command }, ctx: { cwd: root, sessionId } });
    assert.equal(r.decision, 'allow', r.reason);
    assert.equal(r.updatedCommand, undefined, 'все сегменты уже с --session');
  });
});

test('decide: `cli.mjs status && git commit` — не вызов cli (второй сегмент чужой), deny_shell срабатывает', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const r = decide({ action: { tool: 'Bash', kind: 'shell', command: 'node .workflow/src/rails/cli.mjs status && git commit -m x' }, ctx: { cwd: root, sessionId } });
    assert.equal(r.decision, 'deny');
  });
});

// --- найдено ревью (major): инъекция --session не должна уезжать в хвост пайпа --

test('decide: cli.mjs в составном пайпе (`| tail -5`) — не короткое замыкание, команда не корёжится', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const r = decide({
      action: {
        tool: 'Bash',
        kind: 'shell',
        command: 'node .workflow/src/rails/cli.mjs status 2>&1 | tail -5',
      },
      ctx: { cwd: root, sessionId },
    });
    // Пайп внутри cli-сегмента допустим (2026-09-22): это вызов cli.mjs, allow,
    // а --session вставляется ПЕРЕД `|`, чтобы флаг достался cli.mjs, а не `tail`.
    assert.equal(r.decision, 'allow');
    assert.equal(r.updatedCommand, `node .workflow/src/rails/cli.mjs status 2>&1 --session ${sessionId} | tail -5`);
  });
});

test('decide: cli.mjs status && git commit — запрещённая команда в составной команде ловится deny_shell, не проходит коротким замыканием', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const r = decide({
      action: {
        tool: 'Bash',
        kind: 'shell',
        command: 'node .workflow/src/rails/cli.mjs status && git commit -m x',
      },
      ctx: { cwd: root, sessionId },
    });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /коуч не делает git-операции/);
  });
});

// --- найдено ревью (minor): регулярка должна ловить только rails/cli.mjs -----

test('decide: чужой src/cli.mjs (не rails/cli.mjs) не получает инъекцию --session', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const r = decide({
      action: { tool: 'Bash', kind: 'shell', command: 'node src/cli.mjs check' },
      ctx: { cwd: root, sessionId },
    });
    assert.equal(r.updatedCommand, undefined);
  });
});

// --- §7.4.2: канарейка ----------------------------------------------------------

test('decide: команда совпадает с canary -> deny "RAILS_CANARY"', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const r = decide({
      action: { tool: 'Bash', kind: 'shell', command: 'echo RAILS_CANARY' },
      ctx: { cwd: root, sessionId },
    });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /RAILS_CANARY/);
    assert.match(r.reason, /P4S1/);
  });
});

// --- §7.4.3: deny_shell -----------------------------------------------------------

test('decide: deny_shell по паттерну команды -> deny с reason и incident', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const r = decide({
      action: { tool: 'Bash', kind: 'shell', command: 'git commit -m "test"' },
      ctx: { cwd: root, sessionId },
    });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /коуч не делает git-операции/);
    assert.match(r.reason, /SKILL\.md запрет git/);
  });
});

test('decide: deny_shell не ловит похожую, но безобидную команду (git status) -> allow', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const r = decide({
      action: { tool: 'Bash', kind: 'shell', command: 'git status' },
      ctx: { cwd: root, sessionId },
    });
    assert.equal(r.decision, 'allow');
  });
});

// --- §7.4.4: deny_mcp --------------------------------------------------------------

test('decide: deny_mcp по имени инструмента -> deny', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const r = decide({
      action: { tool: 'mcp__workflow__git_commit', kind: 'mcp', server: 'workflow', mcpTool: 'git_commit' },
      ctx: { cwd: root, sessionId },
    });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /git_commit/);
    assert.match(r.reason, /deny_mcp/);
  });
});

test('decide: композиция с actions.fromClaude — mcp-вызов из входа хука Claude тоже ловится deny_mcp', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const action = fromClaude({ tool_name: 'mcp__workflow__git_commit', tool_input: { message: 'x' } });
    const r = decide({ action, ctx: { cwd: root, sessionId } });
    assert.equal(r.decision, 'deny');
  });
});

// --- §7.4.5: write_deny ------------------------------------------------------------

test('decide: edit по пути из write_deny -> deny', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const target = join(root, '.workflow', 'work', 'denied.txt');
    const r = decide({
      action: { tool: 'Edit', kind: 'edit', path: target },
      ctx: { cwd: root, sessionId },
    });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /write_deny/);
  });
});

test('decide: shell writesTo путь из write_deny -> deny', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const r = decide({
      action: { tool: 'Bash', kind: 'shell', command: 'rm .workflow/work/denied.txt' },
      ctx: { cwd: root, sessionId },
    });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /write_deny/);
  });
});

// --- §7.4.6: write_scope (+ allow_temp) --------------------------------------------

test('decide: edit вне write_scope -> deny', () => {
  // allow_temp: false — фикстура root сама лежит под os.tmpdir() (см. withProject),
  // поэтому при allow_temp: true "outside" тоже прошёл бы как временный файл и
  // маскировал бы именно ту проверку (H1, write_scope), которую тестирует этот случай.
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const outside = join(root, '.workflow', 'outside.txt');
    const r = decide({
      action: { tool: 'Edit', kind: 'edit', path: outside },
      ctx: { cwd: root, sessionId },
    });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /вне write_scope/);
  }, { allowTemp: false });
});

test('decide: write внутри os.tmpdir() -> allow (allow_temp: true)', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P5S1'); // terminal-узел, без stage_actions на этом этапе
    const tmpTarget = join(tmpdir(), `rails-core-temp-${process.pid}-${Date.now()}.txt`);
    const r = decide({
      action: { tool: 'Write', kind: 'write', path: tmpTarget },
      ctx: { cwd: root, sessionId },
    });
    assert.equal(r.decision, 'allow');
  });
});

test('decide: shell writesTo вне write_scope -> deny (не только Edit/Write ловится write_scope)', () => {
  // allow_temp: false — как в тесте выше, чтобы не маскировать write_scope.
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const r = decide({
      action: { tool: 'Bash', kind: 'shell', command: 'touch ../outside.txt' },
      ctx: { cwd: join(root, '.workflow', 'work'), sessionId },
    });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /вне write_scope/);
  }, { allowTemp: false });
});

test('decide: shell-запись с нераспознанным путём ("?") -> deny с подсказкой Edit/Write', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const r = decide({
      // sed -i без отдельного файлового аргумента — actions.mjs даёт writesTo=["?"]
      action: { tool: 'Bash', kind: 'shell', command: "sed -i 's/a/b/'" },
      ctx: { cwd: root, sessionId },
    });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /используй Edit\/Write или укажи путь явно/);
  });
});

// --- §7.4.7: stage_actions ---------------------------------------------------------

test('decide: stage_actions — действие вне заявленного этапа -> deny', () => {
  withProject(({ root }) => {
    // do_edit разрешён только на этапе 4, состояние — на этапе 5 (P5S1).
    const { sessionId } = makeState(root, 'P5S1');
    const target = join(root, '.workflow', 'work', 'file.txt');
    const r = decide({
      action: { tool: 'Edit', kind: 'edit', path: target },
      ctx: { cwd: root, sessionId },
    });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /разрешено только на этапах/);
    assert.match(r.reason, /этап 5/);
  });
});

test('decide: stage_actions — E-прозрачность: действие с входа этапа отклоняется', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4E1'); // вход этапа 4, do_edit заявлен на этапе 4
    const target = join(root, '.workflow', 'work', 'file.txt');
    const r = decide({
      action: { tool: 'Edit', kind: 'edit', path: target },
      ctx: { cwd: root, sessionId },
    });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /вход этапа/);
  });
});

test('decide: stage_actions — max_per_session: 2 прохода разрешены, 3-й отклоняется', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1'); // R/S-узел этапа 4, не E
    const action = { tool: 'Edit', kind: 'edit', path: join(root, '.workflow', 'work', 'file.txt') };
    const ctx = { cwd: root, sessionId };

    const r1 = decide({ action, ctx });
    assert.equal(r1.decision, 'allow');
    const r2 = decide({ action, ctx });
    assert.equal(r2.decision, 'allow');
    const r3 = decide({ action, ctx });
    assert.equal(r3.decision, 'deny');
    assert.match(r3.reason, /потолок действия/);
    assert.match(r3.reason, /выход к человеку/);
  });
});

test('decide: stage_actions — deny одним правилом не расходует потолок другого совпавшего правила (нет побочных эффектов до полного allow)', () => {
  const base = mkdtempSync(join(tmpdir(), 'rails-core-multirule-'));
  try {
    const root = join(base, 'root');
    const skillDir = join(root, '.workflow', 'src', 'skills', 'coretest');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), SKILL_MD, 'utf8');
    const yaml = [
      'version: 1',
      'skill: coretest',
      'entry: P4E1',
      'terminal: [P5S1]',
      'pause_nodes: []',
      'quote_min: 25',
      '',
      'write_scope:',
      '  - ".workflow/work/**"',
      'allow_temp: true',
      '',
      'stage_actions:',
      '  a:',
      '    kind: [edit]',
      '    match: ".workflow/work/**"',
      '    stages: [4]',
      '    max_per_session: 1',
      '  b:',
      '    kind: [edit]',
      '    match: ".workflow/work/**"',
      '    stages: [5]',
      '',
      'output:',
      '  final_requires: []',
      '  max_stop_blocks: 2',
      '',
    ].join('\n');
    writeFileSync(join(skillDir, 'rails.yaml'), yaml, 'utf8');
    mkdirSync(join(root, '.workflow', 'work'), { recursive: true });

    const sessionId = uuid();
    const state = startState({ root, sessionId, skill: 'coretest', entry: 'P4E1' });
    state.node = 'P4S1'; // этап 4: правило "a" подходит по этапу, правило "b" — нет (только 5)
    saveState(root, state);

    const target = join(root, '.workflow', 'work', 'file.txt');
    const r = decide({
      action: { tool: 'Edit', kind: 'edit', path: target },
      ctx: { cwd: root, sessionId },
    });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /разрешено только на этапах/);

    const reloaded = loadState(root, sessionId);
    assert.equal(
      (reloaded.counters || {})['action:a'] || 0,
      0,
      'потолок правила "a" не должен расходоваться действием, отклонённым правилом "b"'
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('decide: stage_actions — разрешённое действие на своём этапе -> allow с context', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const target = join(root, '.workflow', 'work', 'file.txt');
    const r = decide({
      action: { tool: 'Edit', kind: 'edit', path: target },
      ctx: { cwd: root, sessionId },
    });
    assert.equal(r.decision, 'allow');
    assert.match(r.context, /^RAILS: числится P4S1 «/);
  });
});

// --- §7.8: allow с context (терминальный узел, никаких stage_actions) -------------

test('decide: allow на этапе без совпавших stage_actions -> context "RAILS: числится ..."', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P5S1');
    const r = decide({
      action: { tool: 'Read', kind: 'read' },
      ctx: { cwd: root, sessionId },
    });
    assert.equal(r.decision, 'allow');
    assert.match(r.context, /^RAILS: числится P5S1 «/);
  });
});

// --- §7.5: текст отказа из трёх частей + журнал + денайлы --------------------------

test('decide: текст отказа содержит три части (что / почему / что доступно)', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const r = decide({
      action: { tool: 'Bash', kind: 'shell', command: 'echo RAILS_CANARY' },
      ctx: { cwd: root, sessionId },
    });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /Отклонено: /);
    assert.match(r.reason, /Почему: /);
    assert.match(r.reason, /Доступно: /);
    assert.match(r.reason, /P5E1/); // допустимый переход из P4S1 — в описании "что доступно"
  });
});

test('decide: каждый отказ пишется в журнал и увеличивает denials[node] на диске', () => {
  withProject(({ root }) => {
    const { sessionId, state } = makeState(root, 'P4S1');
    const action = { tool: 'Bash', kind: 'shell', command: 'echo RAILS_CANARY' };
    const ctx = { cwd: root, sessionId, run: 'run-42' };

    decide({ action, ctx });
    decide({ action, ctx });
    const r = decide({ action, ctx });

    assert.match(r.reason, /3-й отказ за сессию/);

    const reloaded = loadState(root, sessionId);
    assert.equal(reloaded.denials[state.node], 3);

    const entries = readJournal(root, {});
    const denials = entries.filter((e) => e.type === 'denial' && e.session === sessionId);
    assert.equal(denials.length, 3);
    assert.equal(denials[0].node, 'P4S1');
    assert.equal(denials[0].skill, 'coretest');
    assert.equal(denials[0].run, 'run-42');
  });
});

// --- buildDenyReason: юнит-тест ----------------------------------------------------

test('buildDenyReason: собирает три части в один текст', () => {
  const text = buildDenyReason({ what: 'Bash: rm -rf /', why: 'запрещено политикой', allowed: 'P1E1: сделай так' });
  assert.match(text, /Отклонено: Bash: rm -rf \//);
  assert.match(text, /Почему: запрещено политикой/);
  assert.match(text, /Доступно: P1E1: сделай так/);
});

test('buildDenyReason: allowed-массив соединяется через "; "', () => {
  const text = buildDenyReason({ what: 'x', why: 'y', allowed: ['a', 'b'] });
  assert.match(text, /Доступно: a; b/);
});

// --- §7, последний абзац: хук никогда не падает -------------------------------------

test('decide: битый rails.yaml -> allow, ошибка в журнал (type=error), не бросает исключение', () => {
  withProject(({ root }) => {
    const brokenSkillDir = join(root, '.workflow', 'src', 'skills', 'broken');
    mkdirSync(brokenSkillDir, { recursive: true });
    writeFileSync(brokenSkillDir + '/SKILL.md', '# broken', 'utf8');
    // Невалидный YAML: незакрытая последовательность.
    writeFileSync(brokenSkillDir + '/rails.yaml', 'version: 1\nentry: [P0E1\n', 'utf8');

    const sessionId = uuid();
    const state = startState({ root, sessionId, skill: 'broken', entry: 'P0E1' });
    void state;

    const origWrite = process.stderr.write;
    let stderrText = '';
    process.stderr.write = (chunk, ...rest) => {
      stderrText += String(chunk);
      return true;
      void rest;
    };
    let r;
    try {
      r = decide({
        action: { tool: 'Bash', kind: 'shell', command: 'echo hi' },
        ctx: { cwd: root, sessionId },
      });
    } finally {
      process.stderr.write = origWrite;
    }

    assert.deepEqual(r, { decision: 'allow' });
    assert.match(stderrText, /rails:/);

    const entries = readJournal(root, {});
    const errors = entries.filter((e) => e.type === 'error');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].session, sessionId);
  });
});

test('decide: полностью отсутствующее действие/ctx не бросает исключение', () => {
  // Без ctx.cwd findProjectRoot() падает на process.cwd() — изолируем тест
  // временным chdir в каталог без .workflow, иначе он либо находит реальный
  // .workflow/ этого репозитория (гоняясь за случайным cwd), либо (при
  // WORKFLOW_RAILS_SKILL в окружении) пишет в его rails-denials.jsonl.
  const base = mkdtempSync(join(tmpdir(), 'rails-core-empty-'));
  const prevCwd = process.cwd();
  const prevSkillEnv = process.env.WORKFLOW_RAILS_SKILL;
  try {
    process.chdir(base);
    delete process.env.WORKFLOW_RAILS_SKILL;
    assert.doesNotThrow(() => {
      const r = decide({});
      assert.equal(r.decision, 'allow');
    });
  } finally {
    process.chdir(prevCwd);
    if (prevSkillEnv === undefined) delete process.env.WORKFLOW_RAILS_SKILL;
    else process.env.WORKFLOW_RAILS_SKILL = prevSkillEnv;
    rmSync(base, { recursive: true, force: true });
  }
});

// --- loadSkillRuntime: кэш по mtime -------------------------------------------------

test('loadSkillRuntime: повторный вызов без изменений файлов возвращает те же ссылки (кэш)', () => {
  withProject(({ root }) => {
    const a = loadSkillRuntime(root, 'coretest');
    const b = loadSkillRuntime(root, 'coretest');
    assert.equal(a.config, b.config);
    assert.equal(a.graph, b.graph);
  });
});

test('loadSkillRuntime: touch rails.yaml -> кэш инвалидируется, возвращается новый граф/конфиг', () => {
  withProject(({ root, skillDir }) => {
    const a = loadSkillRuntime(root, 'coretest');
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(skillDir, 'rails.yaml'), future, future);
    const b = loadSkillRuntime(root, 'coretest');
    assert.notEqual(a.config, b.config);
    assert.notEqual(a.graph, b.graph);
    assert.deepEqual(a.config.entry, b.config.entry);
  });
});
