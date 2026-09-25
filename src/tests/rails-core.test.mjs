import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  utimesSync,
  lstatSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execSync, execFileSync } from 'node:child_process';

import { decide, buildDenyReason, loadSkillRuntime, analyzeCliCommand } from '../rails/core.mjs';
import { startState, saveState, loadState } from '../rails/state.mjs';
import { readJournal } from '../rails/journal.mjs';
import { createJunction } from '../junction-manager.mjs';
import { fromClaude, fromKilo } from '../rails/actions.mjs';

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

// ЗАДАЧА B, 2026-09-22: заглушка `cli.mjs`, печатающая свой argv — позволяет тестам
// прогнать РЕАЛЬНЫЙ updatedCommand через настоящий bash/PowerShell и убедиться, что
// до cli.mjs долетает буквально задуманная цитата, а не то, что от неё осталось после
// того как shell сам раскрыл бэктики/`$X` (см. isCliCommand — путь должен содержать
// `rails/cli.mjs`, поэтому подменяем именно файл по этому пути, а не сам cli.mjs).
function writeCliStub(root) {
  const railsDir = join(root, '.workflow', 'src', 'rails');
  mkdirSync(railsDir, { recursive: true });
  writeFileSync(join(railsDir, 'cli.mjs'), 'console.log(JSON.stringify(process.argv));\n', 'utf8');
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

// --- ЗАДАЧА B (2026-09-22): порча цитаты shell'ом в `goto --quote` -----------------
//
// Лейблы содержат бэктики (`` `.workflow/reports/` ``) и «$X». Агент печатает
// `--quote "…из `.workflow/reports/`, оценку…"` — bash выполняет `…` как подкоманду,
// $X раскрывает в пустоту, до cli.mjs долетает испорченная цитата. Хук видит команду
// ДО shell — переписывает такие `--quote "…"` в одинарные кавычки с тем же буквальным
// текстом, который напечатал агент, сочетая это с инъекцией `--session`.

test('decide: --quote с бэктиками в ДВОЙНЫХ кавычках (posix) -> updatedCommand переписывает в одинарные, литерал сохранён', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const rawQuote = 'из `.workflow/reports/`, оценку записать в план текущего этапа';
    const command = `node .workflow/src/rails/cli.mjs goto P5E1 --quote "${rawQuote}"`;
    const r = decide({ action: { tool: 'Bash', kind: 'shell', command, shell: 'posix' }, ctx: { cwd: root, sessionId } });
    assert.equal(r.decision, 'allow');
    assert.equal(r.updatedCommand, `node .workflow/src/rails/cli.mjs goto P5E1 --quote '${rawQuote}' --session ${sessionId}`);
  });
});

test('decide: --quote с $ в ДВОЙНЫХ кавычках (posix) -> updatedCommand переписывает в одинарные', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const rawQuote = 'прогон runner платный (~$X, ~Y минут) — нужно подтверждение агента';
    const command = `node .workflow/src/rails/cli.mjs goto P5E1 --quote "${rawQuote}"`;
    const r = decide({ action: { tool: 'Bash', kind: 'shell', command, shell: 'posix' }, ctx: { cwd: root, sessionId } });
    assert.equal(r.decision, 'allow');
    assert.equal(r.updatedCommand, `node .workflow/src/rails/cli.mjs goto P5E1 --quote '${rawQuote}' --session ${sessionId}`);
  });
});

test('decide: --quote уже в ОДИНАРНЫХ кавычках -> кавычки не трогает, только --session', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const command = "node .workflow/src/rails/cli.mjs goto P5E1 --quote 'из `.workflow/reports/`, $X, оценку записать'";
    const r = decide({ action: { tool: 'Bash', kind: 'shell', command, shell: 'posix' }, ctx: { cwd: root, sessionId } });
    assert.equal(r.decision, 'allow');
    assert.equal(r.updatedCommand, `${command} --session ${sessionId}`);
  });
});

test('decide: --quote в двойных кавычках без ` и $ -> кавычки не трогает (нечего переписывать), только --session', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const command = 'node .workflow/src/rails/cli.mjs goto P5E1 --quote "обычная цитата без единого спецсимвола совсем"';
    const r = decide({ action: { tool: 'Bash', kind: 'shell', command, shell: 'posix' }, ctx: { cwd: root, sessionId } });
    assert.equal(r.decision, 'allow');
    assert.equal(r.updatedCommand, `${command} --session ${sessionId}`);
  });
});

test('decide: форма --quote="…" с бэктиком -> тоже переписывается в одинарные', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const rawQuote = 'путь `.workflow/work/` внутри области видимости скила';
    const command = `node .workflow/src/rails/cli.mjs goto P5E1 --quote="${rawQuote}"`;
    const r = decide({ action: { tool: 'Bash', kind: 'shell', command, shell: 'posix' }, ctx: { cwd: root, sessionId } });
    assert.equal(r.decision, 'allow');
    assert.equal(r.updatedCommand, `node .workflow/src/rails/cli.mjs goto P5E1 --quote='${rawQuote}' --session ${sessionId}`);
  });
});

test('decide: смешанная команда — два cli-сегмента через &&, переписывается только сегмент с неэкранированными ` / $', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const dirty = 'прогон ~$X минут — оценка перед стартом следующего этапа';
    const clean = 'просто обычная цитата без единого спецсимвола совсем';
    const command = `node .workflow/src/rails/cli.mjs goto P5E1 --quote "${dirty}" && node .workflow/src/rails/cli.mjs goto P4R1 --quote "${clean}"`;
    const r = decide({ action: { tool: 'Bash', kind: 'shell', command, shell: 'posix' }, ctx: { cwd: root, sessionId } });
    assert.equal(r.decision, 'allow');
    assert.equal(
      r.updatedCommand,
      `node .workflow/src/rails/cli.mjs goto P5E1 --quote '${dirty}' --session ${sessionId} && node .workflow/src/rails/cli.mjs goto P4R1 --quote "${clean}" --session ${sessionId}`
    );
  });
});

test('decide: action.shell отсутствует -> дефолт posix (переписывает как posix, не как PowerShell)', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const rawQuote = 'из `.workflow/reports/`, оценку записать в план текущего этапа';
    const command = `node .workflow/src/rails/cli.mjs goto P5E1 --quote "${rawQuote}"`;
    const r = decide({ action: { tool: 'Bash', kind: 'shell', command }, ctx: { cwd: root, sessionId } }); // без action.shell
    assert.equal(r.decision, 'allow');
    assert.equal(r.updatedCommand, `node .workflow/src/rails/cli.mjs goto P5E1 --quote '${rawQuote}' --session ${sessionId}`);
  });
});

test('decide: PowerShell (action.shell="powershell") — $ в двойных кавычках -> переписывается по правилам PS (одинарные, буквально)', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const rawQuote = 'прогон runner платный (~$X, ~Y минут) — нужно подтверждение агента';
    const command = `node .workflow/src/rails/cli.mjs goto P5E1 --quote "${rawQuote}"`;
    const r = decide({ action: { tool: 'Bash', kind: 'shell', command, shell: 'powershell' }, ctx: { cwd: root, sessionId } });
    assert.equal(r.decision, 'allow');
    assert.equal(r.updatedCommand, `node .workflow/src/rails/cli.mjs goto P5E1 --quote '${rawQuote}' --session ${sessionId}`);
  });
});

test('decide: PowerShell — уже экранированный `$X` (бэктик-эскейп) внутри двойных кавычек не трогается', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const command = 'node .workflow/src/rails/cli.mjs goto P5E1 --quote "прогон стоит `$X, минут `$Y — подтверждение нужно"';
    const r = decide({ action: { tool: 'Bash', kind: 'shell', command, shell: 'powershell' }, ctx: { cwd: root, sessionId } });
    assert.equal(r.decision, 'allow');
    assert.equal(r.updatedCommand, `${command} --session ${sessionId}`);
  });
});

// --- ЗАДАЧА B: проверка ЗАПУСКОМ реального shell — переписанная команда передаёт в
// argv ровно задуманную строку (не то, что от неё осталось после раскрытия shell'ом) --

test('decide + bash: инцидент с бэктиками — переписанная команда доносит цитату до argv буквально, подкоманда НЕ выполняется', () => {
  withProject(({ root }) => {
    writeCliStub(root);
    const { sessionId } = makeState(root, 'P4S1');
    const rawQuote = 'из `.workflow/reports/`, оценку записать в план текущего этапа';
    const command = `node .workflow/src/rails/cli.mjs goto P5E1 --quote "${rawQuote}"`;
    const r = decide({ action: { tool: 'Bash', kind: 'shell', command, shell: 'posix' }, ctx: { cwd: root, sessionId } });
    assert.equal(r.decision, 'allow');
    assert.ok(r.updatedCommand);

    const out = execSync(r.updatedCommand, { cwd: root, shell: 'bash', encoding: 'utf8' });
    const argv = JSON.parse(out);
    const qi = argv.indexOf('--quote');
    assert.notEqual(qi, -1);
    assert.equal(argv[qi + 1], rawQuote, 'цитата должна дойти буквально, без выполнения бэктик-подстановки');
  });
});

test('decide + bash: инцидент с $X — переписанная команда доносит цитату до argv буквально, переменная НЕ раскрывается', () => {
  withProject(({ root }) => {
    writeCliStub(root);
    const { sessionId } = makeState(root, 'P4S1');
    const rawQuote = 'прогон runner платный (~$X, ~Y минут) — нужно подтверждение агента';
    const command = `node .workflow/src/rails/cli.mjs goto P5E1 --quote "${rawQuote}"`;
    const r = decide({ action: { tool: 'Bash', kind: 'shell', command, shell: 'posix' }, ctx: { cwd: root, sessionId } });
    assert.equal(r.decision, 'allow');

    const out = execSync(r.updatedCommand, { cwd: root, shell: 'bash', encoding: 'utf8' });
    const argv = JSON.parse(out);
    const qi = argv.indexOf('--quote');
    assert.notEqual(qi, -1);
    assert.equal(argv[qi + 1], rawQuote, 'цитата должна дойти буквально, $X не должен раскрыться в пустоту');
  });
});

test('decide + PowerShell: инцидент с $X (PS) — переписанная команда доносит цитату до argv буквально', { skip: process.platform !== 'win32' ? 'PowerShell-специфичный тест' : false }, () => {
  withProject(({ root }) => {
    writeCliStub(root);
    const { sessionId } = makeState(root, 'P4S1');
    const rawQuote = 'прогон runner платный (~$X, ~Y минут) — нужно подтверждение агента';
    const command = `node .workflow/src/rails/cli.mjs goto P5E1 --quote "${rawQuote}"`;
    const r = decide({ action: { tool: 'Bash', kind: 'shell', command, shell: 'powershell' }, ctx: { cwd: root, sessionId } });
    assert.equal(r.decision, 'allow');

    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', r.updatedCommand], { cwd: root, encoding: 'utf8' });
    const argv = JSON.parse(out);
    const qi = argv.indexOf('--quote');
    assert.notEqual(qi, -1);
    assert.equal(argv[qi + 1], rawQuote, 'цитата должна дойти буквально, $X не должен раскрыться в пустоту');
  });
});

// --- ЗАДАЧА B2 (2026-09-22): ревью первой версии переписывания --quote ---------------------
//
// HIGH: `--quote` искался регуляркой без контекста кавычек — совпадение ВНУТРИ уже
// одинарно-кавыченного значения переписывалось, внешняя кавычка закрывалась, и shell
// выполнял `$(…)`, `;`, `|`, `&` из текста цитаты: хук сам создавал инъекцию, минуя
// deny_shell/write_scope. Теперь разбор — shell-scan.mjs: переписывается только токен
// верхнего уровня cli-сегмента, а результат обязан разбираться так же, как исходная
// команда. Каждый кейс прогоняется через настоящий bash: argv стаб-cli.mjs равен
// задуманной строке, маркер-файл (вне write_scope) не создаётся.

// Маркер: команда, которую shell выполнил бы из текста цитаты, создаёт этот файл.
// Прямые слэши — путь одинаково читается bash и PowerShell.
function markerPath(root) {
  return join(root, 'PWNED.txt').replace(/\\/g, '/');
}

function runBash(command, root) {
  return execSync(command, { cwd: root, shell: 'bash', encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function runPowerShell(command, root) {
  return execFileSync('powershell.exe', ['-NoProfile', '-Command', command], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

for (const [label, inner] of [
  ['$(…) без разделителей', 'x --quote "$(touch PWNED) y"'],
  ['`;` между командами', 'x --quote "$X; touch PWNED; echo "'],
  ['`|` пайп', 'x --quote "$X | touch PWNED"'],
  ['`&` фон', 'x --quote "$X & touch PWNED"'],
  ['форма --quote="…"', 'x --quote="$(touch PWNED)" y'],
]) {
  test(`decide (B2, HIGH): --quote '…' с вложенным --quote "…" (${label}) — литерал не трогается, bash получает одну строку, подкоманда НЕ выполняется`, () => {
    withProject(({ root }) => {
      writeCliStub(root);
      const { sessionId } = makeState(root, 'P4S1');
      const literal = inner.replace(/PWNED/g, markerPath(root));
      const command = `node .workflow/src/rails/cli.mjs goto P5E1 --quote '${literal}'`;
      const r = decide({ action: { tool: 'Bash', kind: 'shell', command, shell: 'posix' }, ctx: { cwd: root, sessionId } });
      assert.equal(r.decision, 'allow');
      assert.equal(r.updatedCommand, `${command} --session ${sessionId}`, 'одинарные кавычки не переписываются');
      const argv = JSON.parse(runBash(r.updatedCommand, root)).slice(2);
      assert.deepEqual(argv, ['goto', 'P5E1', '--quote', literal, '--session', sessionId]);
      assert.equal(existsSync(join(root, 'PWNED.txt')), false, 'маркер не должен появиться: shell ничего не выполнил из текста цитаты');
    });
  });
}

test("decide (B2, HIGH): --quote $'…' (ANSI-C) с вложенным --quote \"$X; touch …\" — не переписывается, подкоманда НЕ выполняется", () => {
  withProject(({ root }) => {
    writeCliStub(root);
    const { sessionId } = makeState(root, 'P4S1');
    const literal = `x --quote "$X; touch ${markerPath(root)}; echo "`;
    const command = `node .workflow/src/rails/cli.mjs goto P5E1 --quote $'${literal}'`;
    const r = decide({ action: { tool: 'Bash', kind: 'shell', command, shell: 'posix' }, ctx: { cwd: root, sessionId } });
    assert.equal(r.decision, 'allow');
    assert.equal(r.updatedCommand, `${command} --session ${sessionId}`);
    const argv = JSON.parse(runBash(r.updatedCommand, root)).slice(2);
    assert.deepEqual(argv, ['goto', 'P5E1', '--quote', literal, '--session', sessionId]);
    assert.equal(existsSync(join(root, 'PWNED.txt')), false);
  });
});

test('decide (B2, HIGH) + PowerShell: --quote \'…\' с вложенным --quote "$(ni PWNED) y" — литерал не трогается, ni НЕ выполняется', { skip: process.platform !== 'win32' ? 'PowerShell-специфичный тест' : false }, () => {
  withProject(({ root }) => {
    writeCliStub(root);
    const { sessionId } = makeState(root, 'P4S1');
    const command = `node .workflow/src/rails/cli.mjs goto P5E1 --quote 'x --quote "$(ni ${markerPath(root)}) y"'`;
    const r = decide({ action: { tool: 'PowerShell', kind: 'shell', command, shell: 'powershell' }, ctx: { cwd: root, sessionId } });
    assert.equal(r.decision, 'allow');
    assert.equal(r.updatedCommand, `${command} --session ${sessionId}`);
    // Windows PowerShell 5.1 сам режет аргумент с " при передаче в native exe (та же
    // картина у исходной команды) — проверяем только, что $(…) дошёл текстом и не выполнился.
    const argv = JSON.parse(runPowerShell(r.updatedCommand, root)).slice(2);
    assert.ok(argv.some((a) => a.includes('$(ni')), `подстановка должна остаться текстом: ${JSON.stringify(argv)}`);
    assert.equal(existsSync(join(root, 'PWNED.txt')), false, 'ni не должен выполниться');
  });
});

test('decide (B2, HIGH): --quote "…" с $(touch …) на верхнем уровне — переписывается в литерал, подстановка нейтрализована', () => {
  withProject(({ root }) => {
    writeCliStub(root);
    const { sessionId } = makeState(root, 'P4S1');
    const rawQuote = `prefix $(touch ${markerPath(root)}) suffix`;
    const command = `node .workflow/src/rails/cli.mjs goto P5E1 --quote "${rawQuote}"`;
    const r = decide({ action: { tool: 'Bash', kind: 'shell', command, shell: 'posix' }, ctx: { cwd: root, sessionId } });
    assert.equal(r.decision, 'allow');
    assert.equal(r.updatedCommand, `node .workflow/src/rails/cli.mjs goto P5E1 --quote '${rawQuote}' --session ${sessionId}`);
    const argv = JSON.parse(runBash(r.updatedCommand, root)).slice(2);
    assert.deepEqual(argv, ['goto', 'P5E1', '--quote', rawQuote, '--session', sessionId]);
    assert.equal(existsSync(join(root, 'PWNED.txt')), false);
  });
});

// MEDIUM: форма '\'' для апострофа ломала наивные трекеры кавычек — --session уезжал в
// хвост пайпа (`head: unknown option -- session`) или не вставлялся в первый сегмент.
test("decide (B2, MEDIUM): апостроф + бэктик/$ в --quote \"…\" и `| head -3` — --session встаёт ПЕРЕД пайпом, bash получает литерал", () => {
  withProject(({ root }) => {
    writeCliStub(root);
    const { sessionId } = makeState(root, 'P4S1');
    const rawQuote = "порча цитаты shell'ом через `$X` в лейбле";
    const command = `node .workflow/src/rails/cli.mjs goto P5E1 --quote "${rawQuote}" | head -3`;
    const r = decide({ action: { tool: 'Bash', kind: 'shell', command, shell: 'posix' }, ctx: { cwd: root, sessionId } });
    assert.equal(r.decision, 'allow');
    assert.equal(r.updatedCommand, `node .workflow/src/rails/cli.mjs goto P5E1 --quote 'порча цитаты shell'\\''ом через \`$X\` в лейбле' --session ${sessionId} | head -3`);
    const argv = JSON.parse(runBash(r.updatedCommand, root)).slice(2);
    assert.deepEqual(argv, ['goto', 'P5E1', '--quote', rawQuote, '--session', sessionId]);
  });
});

test("decide (B2, MEDIUM): апостроф + $ в первом cli-сегменте, второй через && — --session в ОБОИХ сегментах", () => {
  withProject(({ root }) => {
    writeCliStub(root);
    const { sessionId } = makeState(root, 'P4S1');
    const first = "it's $X first segment quote text";
    const second = 'second segment plain quote text';
    const command = `node .workflow/src/rails/cli.mjs goto P5E1 --quote "${first}" && node .workflow/src/rails/cli.mjs goto P4R1 --quote "${second}"`;
    const r = decide({ action: { tool: 'Bash', kind: 'shell', command, shell: 'posix' }, ctx: { cwd: root, sessionId } });
    assert.equal(r.decision, 'allow');
    assert.equal(r.updatedCommand, `node .workflow/src/rails/cli.mjs goto P5E1 --quote 'it'\\''s $X first segment quote text' --session ${sessionId} && node .workflow/src/rails/cli.mjs goto P4R1 --quote "${second}" --session ${sessionId}`);
    const lines = runBash(r.updatedCommand, root).trim().split('\n').map((l) => JSON.parse(l).slice(2));
    assert.deepEqual(lines, [
      ['goto', 'P5E1', '--quote', first, '--session', sessionId],
      ['goto', 'P4R1', '--quote', second, '--session', sessionId],
    ]);
  });
});

// Pre-existing (найдено тем же ревью): трекеры не знали `\"` внутри "…" — команда
// `… --quote "a \" b" ; touch PWNED ; echo "x"` считалась одним cli-сегментом без
// разделителей: allow с --session в хвосте, bash выполнял touch.
// Открытый вопрос (вне файлов B2): detectShellWrites в actions.mjs держит свой трекер
// кавычек с тем же слепым пятном (`"a \" b"` → путей записи не находит), поэтому по общим
// правилам эта команда пока allow с context — deny даёт только deny_shell/write_scope,
// когда их разбор сработает. Здесь проверяется ровно зона B2: нет короткого замыкания.
test('decide (B2): `--quote "a \\" b" ; touch PWNED ; echo "x"` — `\\"` не закрывает кавычку, `;` виден: не cli-вызов, короткого замыкания и --session нет', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const command = `node .workflow/src/rails/cli.mjs goto P5E1 --quote "a \\" b" ; touch ${markerPath(root)} ; echo "x"`;
    const r = decide({ action: { tool: 'Bash', kind: 'shell', command, shell: 'posix' }, ctx: { cwd: root, sessionId } });
    assert.equal(r.updatedCommand, undefined, 'короткого замыкания cli быть не должно');
    assert.ok(r.decision === 'deny' || /RAILS: числится/.test(r.context ?? ''), `общие правила, не cli: ${JSON.stringify(r)}`);
  });
});

// Всё, что shell выполнил бы помимо cli.mjs, лишает команду короткого замыкания:
// она идёт по общим правилам (нет updatedCommand; allow — только с context «числится»).
for (const [label, command] of [
  ['подстановка $(…) в аргументе', 'node .workflow/src/rails/cli.mjs status $(touch PWNED)'],
  ['подстановка `…` в аргументе', 'node .workflow/src/rails/cli.mjs status `touch PWNED`'],
  ['подстановка процесса <(…)', 'node .workflow/src/rails/cli.mjs status <(touch PWNED)'],
  ['фильтр не из белого списка', 'node .workflow/src/rails/cli.mjs status | xargs touch PWNED'],
  ['два пайпа', 'node .workflow/src/rails/cli.mjs status | head -3 | tail -1'],
  ['редирект в файл', 'node .workflow/src/rails/cli.mjs status > PWNED'],
  ['фоновый & между сегментами', 'node .workflow/src/rails/cli.mjs status & node .workflow/src/rails/cli.mjs status'],
  ['подоболочка (…)', '(node .workflow/src/rails/cli.mjs status)'],
  ['cd с подстановкой', 'cd $(pwd) && node .workflow/src/rails/cli.mjs status'],
  ['не node перед путём', 'rm .workflow/src/rails/cli.mjs status'],
  ['heredoc', 'node .workflow/src/rails/cli.mjs status <<EOF\n$(touch PWNED)\nEOF'],
  ['незакрытая кавычка', 'node .workflow/src/rails/cli.mjs status "open'],
]) {
  test(`decide (B2): ${label} — не cli-вызов, короткого замыкания нет`, () => {
    withProject(({ root }) => {
      const { sessionId } = makeState(root, 'P4S1');
      const r = decide({ action: { tool: 'Bash', kind: 'shell', command, shell: 'posix' }, ctx: { cwd: root, sessionId } });
      assert.equal(r.updatedCommand, undefined, label);
      assert.ok(r.decision === 'deny' || /RAILS: числится/.test(r.context ?? ''), `${label}: ${JSON.stringify(r)}`);
    });
  });
}

test('decide (B2): безвредные редиректы (2>&1, >/dev/null, 2> /dev/null) в cli-сегменте допустимы', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const command = 'node .workflow/src/rails/cli.mjs status 2>&1 >/dev/null 2> /dev/null | head -3';
    const r = decide({ action: { tool: 'Bash', kind: 'shell', command, shell: 'posix' }, ctx: { cwd: root, sessionId } });
    assert.equal(r.decision, 'allow');
    assert.equal(r.updatedCommand, `node .workflow/src/rails/cli.mjs status 2>&1 >/dev/null 2> /dev/null --session ${sessionId} | head -3`);
  });
});

test('decide (B2): --session внутри текста цитаты — не флаг, инъекция всё равно нужна', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const command = "node .workflow/src/rails/cli.mjs goto P5E1 --quote 'текст про --session внутри цитаты'";
    const r = decide({ action: { tool: 'Bash', kind: 'shell', command, shell: 'posix' }, ctx: { cwd: root, sessionId } });
    assert.equal(r.updatedCommand, `${command} --session ${sessionId}`);
  });
});

test('analyzeCliCommand: sessionId с символами shell (пробел, кавычка, ;) не вставляется в команду', () => {
  for (const bad of ['x y', "a'b", 'a;touch P', '$(id)', '']) {
    const r = analyzeCliCommand('node .workflow/src/rails/cli.mjs status', 'posix', bad);
    assert.equal(r.isCli, true);
    assert.equal(r.command, 'node .workflow/src/rails/cli.mjs status', JSON.stringify(bad));
  }
  assert.equal(analyzeCliCommand('node .workflow/src/rails/cli.mjs status', 'posix', 'ses_abc-1.2:3').command, 'node .workflow/src/rails/cli.mjs status --session ses_abc-1.2:3');
});

// PowerShell: снимаются только `" `$ `` и "" → "; бэктики, которые PowerShell съел бы
// (`. в лейбле), сохраняются буквально; известные escape'ы (`n) — не переписываем.
test('decide (B2) + PowerShell: --quote "из `.workflow/reports/`, $X" -> одинарные кавычки, бэктики и $ доходят буквально', { skip: process.platform !== 'win32' ? 'PowerShell-специфичный тест' : false }, () => {
  withProject(({ root }) => {
    writeCliStub(root);
    const { sessionId } = makeState(root, 'P4S1');
    const rawQuote = 'из `.workflow/reports/`, оценку ~$X записать в план';
    const command = `node .workflow/src/rails/cli.mjs goto P5E1 --quote "${rawQuote}"`;
    const r = decide({ action: { tool: 'PowerShell', kind: 'shell', command, shell: 'powershell' }, ctx: { cwd: root, sessionId } });
    assert.equal(r.updatedCommand, `node .workflow/src/rails/cli.mjs goto P5E1 --quote '${rawQuote}' --session ${sessionId}`);
    const argv = JSON.parse(runPowerShell(r.updatedCommand, root)).slice(2);
    assert.deepEqual(argv, ['goto', 'P5E1', '--quote', rawQuote, '--session', sessionId]);
  });
});

test('decide (B2) PowerShell: "" внутри "…" -> ", апостроф -> \'\'; `n + $X — буквальные символы, переписывается; ${…} — неоднозначно, нет', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const r1 = decide({ action: { tool: 'PowerShell', kind: 'shell', command: `node .workflow/src/rails/cli.mjs goto P5E1 --quote "say ""hi"" it's ~$X"`, shell: 'powershell' }, ctx: { cwd: root, sessionId } });
    assert.equal(r1.updatedCommand, `node .workflow/src/rails/cli.mjs goto P5E1 --quote 'say "hi" it''s ~$X' --session ${sessionId}`);
    // Ревью B2, раунд 3 (2026-09-22): `n/`t/`r — не неоднозначность, агент написал именно
    // эти символы (лейблы `` `rails.yaml` ``); литерал — как написано.
    const letters = 'node .workflow/src/rails/cli.mjs goto P5E1 --quote "line one`nline two $X rest of quote"';
    const r2 = decide({ action: { tool: 'PowerShell', kind: 'shell', command: letters, shell: 'powershell' }, ctx: { cwd: root, sessionId } });
    assert.equal(r2.updatedCommand, `node .workflow/src/rails/cli.mjs goto P5E1 --quote 'line one\`nline two $X rest of quote' --session ${sessionId}`);
    // ${…} — подстановка (внутри свои правила, вложенные $(…)): команда вовсе не cli-вызов.
    const ambiguous = 'node .workflow/src/rails/cli.mjs goto P5E1 --quote "line ${env:X} rest of quote"';
    const r3 = decide({ action: { tool: 'PowerShell', kind: 'shell', command: ambiguous, shell: 'powershell' }, ctx: { cwd: root, sessionId } });
    assert.equal(r3.updatedCommand, undefined);
    assert.ok(r3.decision === 'deny' || /RAILS: числится/.test(r3.context ?? ''), JSON.stringify(r3));
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

// Инцидент 2026-09-23 (коуч, узел P0S1): канарейка сравнивалась со всей строкой команды, и
// `echo RAILS_CANARY 2>&1 | tail -2; node …` выполнился — проба живости молча прошла, хотя
// рельсы работали. Узел графа велит по такому признаку остановиться и сообщить человеку, что
// рельсы выключены, то есть дыра ведёт к ложному выводу о выключенных рельсах.
test('decide (2026-09-23): канарейка отдельной простой командой внутри составной -> deny', () => {
  withProject(({ root }) => {
    writeCliStub(root);
    const { sessionId } = makeState(root, 'P4S1');
    for (const command of [
      'echo RAILS_CANARY 2>&1 | tail -2',
      'echo RAILS_CANARY; node .workflow/src/rails/cli.mjs status',
      'cd .workflow && echo RAILS_CANARY',
      'echo RAILS_CANARY > out.txt',
      '(echo RAILS_CANARY)',
      'bash -c "echo RAILS_CANARY"',
    ]) {
      const r = decide({ action: { tool: 'Bash', kind: 'shell', command, shell: 'posix' }, ctx: { cwd: root, sessionId } });
      assert.equal(r.decision, 'deny', command);
      assert.match(r.reason, /RAILS_CANARY/, command);
    }
    // Контроль: текст канарейки внутри цитаты cli-вызова отказа не вызывает — там это слово,
    // а не команда; иначе агент не смог бы цитировать лейбл узла P0S1.
    const quoted = decide({
      action: { tool: 'Bash', kind: 'shell', command: 'node .workflow/src/rails/cli.mjs goto P4S1 --quote "выполни команду echo RAILS_CANARY здесь"', shell: 'posix' },
      ctx: { cwd: root, sessionId },
    });
    assert.notEqual(quoted.reason ?? '', 'RAILS_CANARY');
    assert.equal(/RAILS_CANARY: рельсы активны/.test(quoted.reason ?? ''), false);
    // Контроль: похожая, но другая команда канарейкой не считается.
    for (const command of ['echo RAILS_CANARY_EXTRA', 'echo RAILS', 'echoRAILS_CANARY']) {
      const r = decide({ action: { tool: 'Bash', kind: 'shell', command, shell: 'posix' }, ctx: { cwd: root, sessionId } });
      assert.equal(/RAILS_CANARY: рельсы активны/.test(r.reason ?? ''), false, command);
    }
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

// --- ЗАДАЧА C (2026-09-22): shell-запись — cd-префикс/переменные/PowerShell --------
//
// Три инцидента прохода коуча на рельсах: (1) `cd <skillDir> && sed -i … SKILL.md` —
// хук проверял путь SKILL.md относительно cwd СЕССИИ, а не каталога после cd (ложный
// отказ; хуже — обратный случай даёт ложное разрешение: относительный путь попадает в
// разрешённую область по СЕССИОННОМУ cwd, а реальная запись после cd — в другом
// месте). (2) `S="…"; sed -i … "$S/файл"` — «$S/файл» брался буквально (ложный отказ).
// (3) инструмент PowerShell маппился в kind 'other' — канарейка/deny_shell/
// stage_actions/write_scope его не видели (обход рельс).

test('decide: cd <skillDir> && sed -i SKILL.md при write_scope на этот каталог -> allow (путь разрешён от каталога ПОСЛЕ cd, не от cwd сессии)', () => {
  const base = mkdtempSync(join(tmpdir(), 'rails-core-cdwrite-'));
  try {
    const root = join(base, 'root');
    const skillDir = join(root, '.workflow', 'src', 'skills', 'coretest');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), SKILL_MD, 'utf8');

    const targetDir = join(root, '.workflow', 'src', 'skills', 'targetSkill');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'SKILL.md'), '# old text', 'utf8');

    const yaml = [
      'version: 1',
      'skill: coretest',
      'entry: P4E1',
      'terminal: [P5S1]',
      'pause_nodes: []',
      'quote_min: 25',
      '',
      'write_scope:',
      '  - ".workflow/src/skills/targetSkill/**"',
      'allow_temp: false',
      '',
      'output:',
      '  final_requires: []',
      '  max_stop_blocks: 2',
      '',
    ].join('\n');
    writeFileSync(join(skillDir, 'rails.yaml'), yaml, 'utf8');

    const sessionId = uuid();
    const state = startState({ root, sessionId, skill: 'coretest', entry: 'P4E1' });
    state.node = 'P4S1';
    saveState(root, state);

    // Сессия сидит в root (НЕ в targetDir) — именно расхождение cwd сессии и
    // реального каталога после cd раньше давало ложный отказ (SKILL.md проверялся
    // как root/SKILL.md, вне write_scope).
    // ЗАДАЧА C2 (2026-09-22): прямые слэши — `\` вне кавычек bash снимает (`cd C:\Users…` →
    // `C:Users…`, cd не удаётся), такой каталог не литерал.
    const command = `cd ${targetDir.replace(/\\/g, '/')} && sed -i 's/old/new/' SKILL.md`;
    const r = decide({
      action: { tool: 'Bash', kind: 'shell', command, shell: 'posix' },
      ctx: { cwd: root, sessionId },
    });
    assert.equal(r.decision, 'allow');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('decide: cd в разрешённый каталог + запись ../outside -> deny (наивное разрешение от cwd сессии давало бы ложный allow)', () => {
  const base = mkdtempSync(join(tmpdir(), 'rails-core-cdescape-'));
  try {
    const root = join(base, 'root');
    const skillDir = join(root, '.workflow', 'src', 'skills', 'coretest');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), SKILL_MD, 'utf8');

    const targetDir = join(root, '.workflow', 'src', 'skills', 'targetSkill');
    const subDir = join(targetDir, 'sub');
    mkdirSync(subDir, { recursive: true });

    const yaml = [
      'version: 1',
      'skill: coretest',
      'entry: P4E1',
      'terminal: [P5S1]',
      'pause_nodes: []',
      'quote_min: 25',
      '',
      'write_scope:',
      '  - ".workflow/src/skills/targetSkill/**"',
      'allow_temp: false',
      '',
      'output:',
      '  final_requires: []',
      '  max_stop_blocks: 2',
      '',
    ].join('\n');
    writeFileSync(join(skillDir, 'rails.yaml'), yaml, 'utf8');

    const sessionId = uuid();
    const state = startState({ root, sessionId, skill: 'coretest', entry: 'P4E1' });
    state.node = 'P4S1';
    saveState(root, state);

    // Сессия сидит в targetDir/sub (уже внутри разрешённой области). Команда
    // заходит В targetDir (сам разрешённый каталог) и пишет на уровень ВЫШЕ его —
    // это должно быть deny. Наивное разрешение "../outside.txt" от cwd СЕССИИ
    // (targetDir/sub) даёт targetDir/outside.txt — тоже внутри scope, то есть
    // ложное allow: реальная запись (от targetDir, куда реально зашёл cd) уходит
    // на уровень выше — за пределы targetSkill.
    const command = `cd ${targetDir.replace(/\\/g, '/')} && touch ../outside.txt`;
    const r = decide({
      action: { tool: 'Bash', kind: 'shell', command, shell: 'posix' },
      ctx: { cwd: subDir, sessionId },
    });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /вне write_scope/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('decide: PowerShell-инструмент с "git commit" при deny_shell -> deny (раньше PowerShell шёл как kind "other", мимо deny_shell)', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const action = fromClaude({ tool_name: 'PowerShell', tool_input: { command: 'git commit -m "x"' } });
    assert.equal(action.kind, 'shell');
    const r = decide({ action, ctx: { cwd: root, sessionId } });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /коуч не делает git-операции/);
  });
});

test('decide: канарейка через PowerShell -> deny (раньше PowerShell шёл как kind "other", мимо канарейки)', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const action = fromClaude({ tool_name: 'PowerShell', tool_input: { command: 'echo RAILS_CANARY' } });
    assert.equal(action.kind, 'shell');
    const r = decide({ action, ctx: { cwd: root, sessionId } });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /RAILS_CANARY/);
  });
});

// --- ревью B2, раунд 2 (2026-09-22) -----------------------------------------------------

// HIGH: PowerShell считает кавычками и типографские ‘ ’ ‚ ‛ / “ ” „ (проверено запуском
// powershell.exe 5.1). Сканер их не знал: `--quote 'Переход к финальному этапу’; git commit
// -m x; ni PWNED; echo ‘…'` был одним закавыченным токеном → cli-вызов → allow с --session,
// и PowerShell выполнял всё после ’ — мимо deny_shell и write_scope.
test('decide (B2 r2, HIGH) + PowerShell: типографская ’ в --quote \'…\' закрывает строку — `; git commit …` виден, deny_shell срабатывает, короткого замыкания нет', () => {
  withProject(({ root }) => {
    writeCliStub(root);
    const { sessionId } = makeState(root, 'P4S1');
    const command = `node .workflow/src/rails/cli.mjs goto P5E1 --quote 'Переход к финальному этапу’; git commit -m x; ni ${markerPath(root)}; echo ‘теста ядра рельсов процедуры'`;
    const r = decide({ action: { tool: 'PowerShell', kind: 'shell', command, shell: 'powershell' }, ctx: { cwd: root, sessionId } });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /коуч не делает git-операции/);
    assert.equal(r.updatedCommand, undefined);
  });
});

for (const q of ["'", '‘', '’', '‚', '‛']) {
  test(`decide (B2 r2, HIGH) + PowerShell: --quote 'a${q}; ni PWNED; echo ‘b' (U+${q.codePointAt(0).toString(16)}) — не cli-вызов, короткого замыкания нет`, () => {
    withProject(({ root }) => {
      const { sessionId } = makeState(root, 'P4S1');
      const command = `node .workflow/src/rails/cli.mjs goto P5E1 --quote 'a${q}; ni ${markerPath(root)}; echo ‘b'`;
      const r = decide({ action: { tool: 'PowerShell', kind: 'shell', command, shell: 'powershell' }, ctx: { cwd: root, sessionId } });
      assert.equal(r.updatedCommand, undefined);
      assert.ok(r.decision === 'deny' || /RAILS: числится/.test(r.context ?? ''), JSON.stringify(r));
    });
  });
}

for (const q of ['"', '“', '”', '„']) {
  test(`decide (B2 r2, HIGH) + PowerShell: --quote "a${q}; ni PWNED; echo “b" (U+${q.codePointAt(0).toString(16)}) — не cli-вызов, короткого замыкания нет`, () => {
    withProject(({ root }) => {
      const { sessionId } = makeState(root, 'P4S1');
      const command = `node .workflow/src/rails/cli.mjs goto P5E1 --quote "a${q}; ni ${markerPath(root)}; echo “b"`;
      const r = decide({ action: { tool: 'PowerShell', kind: 'shell', command, shell: 'powershell' }, ctx: { cwd: root, sessionId } });
      assert.equal(r.updatedCommand, undefined);
      assert.ok(r.decision === 'deny' || /RAILS: числится/.test(r.context ?? ''), JSON.stringify(r));
    });
  });
}

test('decide (B2 r2) + PowerShell: ’ из лейбла в --quote "…" с $X — переписывается в \'…\' с удвоением ’’, argv получает цитату буквально', { skip: process.platform !== 'win32' ? 'PowerShell-специфичный тест' : false }, () => {
  withProject(({ root }) => {
    writeCliStub(root);
    const { sessionId } = makeState(root, 'P4S1');
    const rawQuote = 'Переход ’к финальному’ этапу ~$X теста';
    const command = `node .workflow/src/rails/cli.mjs goto P5E1 --quote "${rawQuote}"`;
    const r = decide({ action: { tool: 'PowerShell', kind: 'shell', command, shell: 'powershell' }, ctx: { cwd: root, sessionId } });
    assert.equal(r.decision, 'allow');
    assert.equal(r.updatedCommand, `node .workflow/src/rails/cli.mjs goto P5E1 --quote 'Переход ’’к финальному’’ этапу ~$X теста' --session ${sessionId}`);
    const argv = JSON.parse(runPowerShell(r.updatedCommand, root)).slice(2);
    assert.deepEqual(argv, ['goto', 'P5E1', '--quote', rawQuote, '--session', sessionId]);
  });
});

test('decide (B2 r2) + PowerShell: ’a; ni PWNED; echo b’ вне кавычек — для PowerShell это одна строка: cli-вызов, ni НЕ выполняется', { skip: process.platform !== 'win32' ? 'PowerShell-специфичный тест' : false }, () => {
  withProject(({ root }) => {
    writeCliStub(root);
    const { sessionId } = makeState(root, 'P4S1');
    const command = `node .workflow/src/rails/cli.mjs goto P5E1 --quote ’a; ni ${markerPath(root)}; echo b’`;
    const r = decide({ action: { tool: 'PowerShell', kind: 'shell', command, shell: 'powershell' }, ctx: { cwd: root, sessionId } });
    assert.equal(r.decision, 'allow');
    assert.equal(r.updatedCommand, `${command} --session ${sessionId}`);
    const argv = JSON.parse(runPowerShell(r.updatedCommand, root)).slice(2);
    assert.deepEqual(argv, ['goto', 'P5E1', '--quote', `a; ni ${markerPath(root)}; echo b`, '--session', sessionId]);
    assert.equal(existsSync(join(root, 'PWNED.txt')), false);
  });
});

// MEDIUM: сканер рекурсивен, строка из тысяч `"$(` давала RangeError; decide() ловила его
// catch-all'ом и отвечала allow — вместе с `git commit` в начале команды.
test('decide (B2 r2, MEDIUM): `git commit -m x; node …cli.mjs goto P1 --quote "$("$("$(…` ×6000 — deny_shell, исключения и «снимаю рельсы» нет', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const command = `git commit -m x; node .workflow/src/rails/cli.mjs goto P1 --quote ${'"$('.repeat(6000)}`;
    const origWrite = process.stderr.write;
    let stderr = '';
    process.stderr.write = (chunk) => { stderr += String(chunk); return true; };
    let r;
    try {
      r = decide({ action: { tool: 'Bash', kind: 'shell', command, shell: 'posix' }, ctx: { cwd: root, sessionId } });
    } finally {
      process.stderr.write = origWrite;
    }
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /коуч не делает git-операции/);
    assert.doesNotMatch(stderr, /снимаю рельсы|RangeError/);
    for (const d of ['posix', 'powershell']) {
      assert.equal(analyzeCliCommand(`node .workflow/src/rails/cli.mjs goto P1 --quote ${'"$('.repeat(20000)}`, d, 'sess-1').isCli, false, d);
    }
  });
});

// MEDIUM: `sort -o FILE`, `uniq IN OUT`, `less -o FILE` создают файл по любому пути — как
// «фильтры-читатели» в белом списке они давали короткое замыкание мимо write_scope
// (проверено запуском: маркер создавался).
for (const [label, command] of [
  ['sort -o FILE', 'node .workflow/src/rails/cli.mjs status | sort -o PWNED'],
  ['uniq - FILE', 'node .workflow/src/rails/cli.mjs status | uniq - PWNED'],
  ['less -o FILE', 'node .workflow/src/rails/cli.mjs status | less -o PWNED'],
  ['sort -o во втором сегменте цепочки', 'node .workflow/src/rails/cli.mjs status | head -3 && node .workflow/src/rails/cli.mjs status | sort -o PWNED'],
  ['sort без аргументов (писатель по любым аргументам — вне списка целиком)', 'node .workflow/src/rails/cli.mjs status | sort'],
]) {
  test(`decide (B2 r2, MEDIUM): \`| ${label}\` — не cli-вызов, короткого замыкания и --session нет`, () => {
    withProject(({ root }) => {
      const { sessionId } = makeState(root, 'P4S1');
      const cmd = command.replace(/PWNED/g, markerPath(root));
      const r = decide({ action: { tool: 'Bash', kind: 'shell', command: cmd, shell: 'posix' }, ctx: { cwd: root, sessionId } });
      assert.equal(r.updatedCommand, undefined, label);
      assert.ok(r.decision === 'deny' || /RAILS: числится/.test(r.context ?? ''), `${label}: ${JSON.stringify(r)}`);
    });
  });
}

test('decide (B2 r2): PowerShell `| uniq - FILE` — не cli (uniq.exe из Git пишет файл); `| Sort-Object` — cli', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const bad = decide({ action: { tool: 'PowerShell', kind: 'shell', command: `node .workflow/src/rails/cli.mjs status | uniq - ${markerPath(root)}`, shell: 'powershell' }, ctx: { cwd: root, sessionId } });
    assert.equal(bad.updatedCommand, undefined);
    const good = decide({ action: { tool: 'PowerShell', kind: 'shell', command: 'node .workflow/src/rails/cli.mjs status | Sort-Object', shell: 'powershell' }, ctx: { cwd: root, sessionId } });
    assert.equal(good.updatedCommand, `node .workflow/src/rails/cli.mjs status --session ${sessionId} | Sort-Object`);
  });
});

// LOW: хвостовой `&` и `(…)` после `&&` терялись в разборе — команда считалась cli-вызовом
// вопреки контракту («`&`, `(…)` — не cli»).
for (const [label, command] of [
  ['хвостовой & (фон)', 'node .workflow/src/rails/cli.mjs status &'],
  ['подоболочка после &&', 'node .workflow/src/rails/cli.mjs status && (node .workflow/src/rails/cli.mjs status)'],
  ['подоболочка после ;', 'node .workflow/src/rails/cli.mjs status ; (node .workflow/src/rails/cli.mjs status)'],
  ['хвостовой & и перевод строки', 'node .workflow/src/rails/cli.mjs status &\n'],
]) {
  test(`decide (B2 r2, LOW): ${label} — не cli-вызов, короткого замыкания нет`, () => {
    withProject(({ root }) => {
      const { sessionId } = makeState(root, 'P4S1');
      const r = decide({ action: { tool: 'Bash', kind: 'shell', command, shell: 'posix' }, ctx: { cwd: root, sessionId } });
      assert.equal(r.updatedCommand, undefined, label);
      assert.ok(r.decision === 'deny' || /RAILS: числится/.test(r.context ?? ''), `${label}: ${JSON.stringify(r)}`);
    });
  });
}

// --- ревью B2, раунд 3 (2026-09-22): CR (\r) --------------------------------------------------
//
// HIGH: сканер считал `\r` пробелом. Windows PowerShell 5.1 трактует одиночный CR как перевод
// строки: `status<CR>git commit -m x<CR>ni PWNED.txt<CR>Write-Output INJECTED` был одним
// cli-сегментом с «лишними аргументами» — allow с --session мимо deny_shell и write_scope, а
// powershell.exe выполнял все четыре statement'а (проверено запуском). Теперь CR под
// PowerShell — разделитель сегментов, и команда идёт по общим правилам.
const notCli = (r, label) => {
  assert.equal(r.updatedCommand, undefined, `${label}: короткого замыкания cli быть не должно`);
  assert.ok(r.decision === 'deny' || /RAILS: числится/.test(r.context ?? ''), `${label}: общие правила, не cli: ${JSON.stringify(r)}`);
};

test('decide (B2 r3, HIGH) + PowerShell: status<CR>git commit<CR>ni PWNED<CR>Write-Output — не cli-вызов, deny_shell срабатывает', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const command = `node .workflow/src/rails/cli.mjs status\rgit commit -m x\rni ${markerPath(root)}\rWrite-Output INJECTED`;
    const r = decide({ action: { tool: 'PowerShell', kind: 'shell', command, shell: 'powershell' }, ctx: { cwd: root, sessionId } });
    assert.equal(r.updatedCommand, undefined);
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /git-операции/);
    for (const [label, c] of [
      ['CR без git', `node .workflow/src/rails/cli.mjs status\rni ${markerPath(root)}\rWrite-Output INJECTED`],
      ['CRLF', `node .workflow/src/rails/cli.mjs status\r\nni ${markerPath(root)}`],
      ['CR после 2>&1', `node .workflow/src/rails/cli.mjs status 2>&1\rni ${markerPath(root)}`],
      ['CR после комментария', `node .workflow/src/rails/cli.mjs status #c\rni ${markerPath(root)}`],
      ['бэктик+CR приклеен к слову, LF после него — новый statement', `node .workflow/src/rails/cli.mjs status --x\`\r\nni ${markerPath(root)}`],
      ['бэктик+CR приклеен к слову без LF (аргумент с CR — не инертен)', `node .workflow/src/rails/cli.mjs status --x\`\rni ${markerPath(root)}`],
    ]) {
      notCli(decide({ action: { tool: 'PowerShell', kind: 'shell', command: c, shell: 'powershell' }, ctx: { cwd: root, sessionId } }), label);
    }
    // Контроль: CR внутри кавычек — литерал, команда остаётся cli-вызовом.
    const quoted = "node .workflow/src/rails/cli.mjs goto P5E1 --quote 'a\rb'";
    const ok = decide({ action: { tool: 'PowerShell', kind: 'shell', command: quoted, shell: 'powershell' }, ctx: { cwd: root, sessionId } });
    assert.equal(ok.updatedCommand, `${quoted} --session ${sessionId}`);
  });
});

test('decide (B2 r3, HIGH) + powershell.exe: одиночный CR действительно делит statement\'ы — исходная команда выполняет второй, разбор видит два сегмента', { skip: process.platform !== 'win32' ? 'PowerShell-специфичный тест' : false }, () => {
  withProject(({ root }) => {
    writeCliStub(root);
    const command = 'node .workflow/src/rails/cli.mjs status\rWrite-Output INJECTED';
    assert.match(runPowerShell(command, root), /INJECTED/, 'PowerShell выполнил statement после CR');
    assert.equal(analyzeCliCommand(command, 'powershell', 'sess-1').isCli, false);
  });
});

// MEDIUM: под bash `>&1<CR>PWNED.txt` — редирект `>&word` с нечисловым word (то же, что
// `&>файл`): файл создаётся. Сканер резал по CR — `>&1` проходил как безвредный редирект,
// `PWNED.txt` — как инертный аргумент, decide() давал allow с --session. Теперь CR под bash —
// символ слова, и `>&1<CR>PWNED.txt` — один токен-редирект не из безвредного списка.
test('decide (B2 r3, MEDIUM): `status >&1<CR>PWNED.txt` и другие CR вне кавычек (posix) — не cli-вызов, короткого замыкания нет', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    for (const [label, command] of [
      ['>&1<CR>PWNED', `node .workflow/src/rails/cli.mjs status >&1\r${markerPath(root)}`],
      ['>$null<CR>PWNED', 'node .workflow/src/rails/cli.mjs status >$null\rPWNED'],
      ['2>&1 >$null<CR>PWNED', 'node .workflow/src/rails/cli.mjs status 2>&1 >$null\rPWNED'],
      ['| head >$null<CR>PWNED', 'node .workflow/src/rails/cli.mjs status | head -1 >$null\rPWNED'],
      ['cd .<CR>PWNED', 'cd .\rPWNED && node .workflow/src/rails/cli.mjs status'],
      ['CR в подкоманде', 'node .workflow/src/rails/cli.mjs status\r'],
      ['CRLF между cli-вызовами', 'node .workflow/src/rails/cli.mjs status\r\nnode .workflow/src/rails/cli.mjs status'],
      ['бэкслеш+CR+LF', 'node .workflow/src/rails/cli.mjs status \\\r\ntouch PWNED'],
      ['CR в аргументе', 'node .workflow/src/rails/cli.mjs goto P5E1\r --quote x'],
    ]) {
      notCli(decide({ action: { tool: 'Bash', kind: 'shell', command, shell: 'posix' }, ctx: { cwd: root, sessionId } }), label);
    }
    const r = decide({ action: { tool: 'Bash', kind: 'shell', command: 'node .workflow/src/rails/cli.mjs status\rgit commit -m x', shell: 'posix' }, ctx: { cwd: root, sessionId } });
    assert.equal(r.decision, 'deny', 'deny_shell по тексту');
    // Контроль: CR внутри кавычек — литерал, cli-вызов сохраняется.
    const quoted = 'node .workflow/src/rails/cli.mjs goto P5E1 --quote "a\rb"';
    assert.equal(decide({ action: { tool: 'Bash', kind: 'shell', command: quoted, shell: 'posix' }, ctx: { cwd: root, sessionId } }).updatedCommand, `${quoted} --session ${sessionId}`);
  });
});

// msys-bash (Git for Windows, оба бинарника) молча удаляет CR из текста `-c`: `gi<CR>t commit`
// выполняет `git commit`, `tou<CR>ch X` создаёт файл, `ec<CR>ho RAILS_CANARY` — канарейка
// (проверено запуском). Регулярки deny_shell/canary/detectShellWrites по сырому тексту этого
// не видят — общие правила проверяются и по тексту без CR (commandTextVariants).
test('decide (B2 r3): CR внутри слова не обходит canary, deny_shell и write_scope (msys-bash удаляет CR)', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const run = (command, shell = 'posix') => decide({ action: { tool: shell === 'posix' ? 'Bash' : 'PowerShell', kind: 'shell', command, shell }, ctx: { cwd: root, sessionId } });
    const git = run('gi\rt commit -m x');
    assert.equal(git.decision, 'deny');
    assert.match(git.reason, /git-операции/);
    const touch = run(`tou\rch ${markerPath(root)}`);
    assert.equal(touch.decision, 'deny');
    assert.match(touch.reason, /вне write_scope/);
    const canary = run('ec\rho RAILS_CANARY');
    assert.equal(canary.decision, 'deny');
    assert.match(canary.reason, /RAILS_CANARY/);
    // Контроль: тот же текст без обфускации внутри write_scope — allow.
    assert.equal(run(`touch ${join(root, '.workflow', 'work', 'a.txt').replace(/\\/g, '/')}`).decision, 'allow');
    // PowerShell: `gi<CR>t commit` — два statement'а (`gi`, `t commit`), вариант без CR даёт
    // лишь лишний отказ — допустимо.
    assert.equal(run('gi\rt commit -m x', 'powershell').decision, 'deny');
  });
});

test('bash (B2 r3): msys-bash удаляет CR из текста команды — основание проверять правила по тексту без CR', { skip: process.platform !== 'win32' ? 'Git for Windows-специфичный тест' : false }, () => {
  assert.match(execSync('ec\rho INJECTED', { shell: 'bash', encoding: 'utf8' }), /^INJECTED/);
});

// LOW (pre-existing, ревью B2 раунд 3): якорь `rails/cli.mjs` принимал любой каталог —
// `node .workflow/work/rails/cli.mjs status` (файл, который агент вправе создать внутри
// write_scope) получал allow как cli-вызов: произвольный JS в обход всех правил. Теперь путь
// (от cwd или каталога `cd`-префикса) обязан вести к cli.mjs этого проекта.
test('decide (B2 r3, LOW): cli-вызов — только cli.mjs этого проекта; копия внутри write_scope или чужой каталог — не cli', () => {
  withProject(({ root }) => {
    writeCliStub(root);
    const { sessionId } = makeState(root, 'P4S1');
    const run = (command, cwd = root) => decide({ action: { tool: 'Bash', kind: 'shell', command, shell: 'posix' }, ctx: { cwd, sessionId } });
    for (const command of [
      'node .workflow/work/rails/cli.mjs status',
      'node .workflow/work/src/rails/cli.mjs status',
      `node ${join(root, '.workflow', 'work', 'rails', 'cli.mjs').replace(/\\/g, '/')} status`,
      'cd .workflow/work/evil && node .workflow/src/rails/cli.mjs status',
      'node ../rails/cli.mjs status',
      // Ревью B3, раунд 1 (2026-09-22): `<root>/src/rails/cli.mjs` — не канон вне workflowAi
      // (см. тест B3 r2 ниже); `cd .workflow/work` без `./` bash ищет по CDPATH.
      'node src/rails/cli.mjs status',
      'cd .workflow/work && node ../src/rails/cli.mjs status',
    ]) {
      notCli(run(command), command);
    }
    // cwd не в корне проекта: относительный путь ведёт не туда.
    notCli(run('node .workflow/src/rails/cli.mjs status', join(root, '.workflow', 'work')), 'cwd = .workflow/work');
    for (const command of [
      'node .workflow/src/rails/cli.mjs status',
      'node ./.workflow/src/rails/cli.mjs status',
      `node "${join(root, '.workflow', 'src', 'rails', 'cli.mjs')}" status`,
      `cd "${root}" && node .workflow/src/rails/cli.mjs status`,
      'cd ./.workflow/work && node ../src/rails/cli.mjs status',
    ]) {
      assert.equal(run(command).updatedCommand, `${command} --session ${sessionId}`, command);
    }
    assert.equal(run('node .workflow/src/rails/cli.mjs status', join(root, '.workflow', 'work')).updatedCommand, undefined);
    // Без scope (прямой вызов analyzeCliCommand) — только лексический якорь, как раньше.
    assert.equal(analyzeCliCommand('node any/rails/cli.mjs status', 'posix').isCli, true);
  });
});

// LOW (ревью B2 раунд 3): под PowerShell бэктик перед n t r … помечался неоднозначным, и
// `--quote "см. `rails.yaml`"` не переписывался — PowerShell превращал `r в CR, goto отклонял
// quote-mismatch (4 из 85 лейблов скилов). Агент написал именно эти символы — литерал.
test('decide (B2 r3, LOW) + PowerShell: --quote "см. `rails.yaml`, `tests/`" — переписывается в литерал, argv получает текст буквально', { skip: process.platform !== 'win32' ? 'PowerShell-специфичный тест' : false }, () => {
  withProject(({ root }) => {
    writeCliStub(root);
    const { sessionId } = makeState(root, 'P4S1');
    // Бэктик не последний символ цитаты: `" перед закрывающей кавычкой PowerShell сам читает
    // как экранированную кавычку — строка не закрыта (ошибка парсера PowerShell, не наша).
    const rawQuote = 'см. `rails.yaml` и `tests/`, отчёт `report_id: REPORT-NNN` в `templates/x.md` — шаблон';
    const command = `node .workflow/src/rails/cli.mjs goto P5E1 --quote "${rawQuote}"`;
    const r = decide({ action: { tool: 'PowerShell', kind: 'shell', command, shell: 'powershell' }, ctx: { cwd: root, sessionId } });
    assert.equal(r.updatedCommand, `node .workflow/src/rails/cli.mjs goto P5E1 --quote '${rawQuote}' --session ${sessionId}`);
    const argv = JSON.parse(runPowerShell(r.updatedCommand, root)).slice(2);
    assert.deepEqual(argv, ['goto', 'P5E1', '--quote', rawQuote, '--session', sessionId]);
    // Контроль: без переписывания PowerShell превращает `r/`t в CR/TAB.
    const orig = JSON.parse(runPowerShell(command, root)).slice(2);
    assert.match(orig[3], /[\r\t]/);
    assert.notEqual(orig[3], rawQuote);
  });
});

// --- ЗАДАЧА B3 (2026-09-22): распознавание cli-вызова после ревью B2 r3 ------------------------

// Фикстура для repro: «копия» cli.mjs, которую агент вправе создать внутри write_scope
// (`<dir>/.workflow/src/rails/cli.mjs`), печатает свою метку.
function writeCliCopy(dir, label = 'COPY-CLI') {
  const railsDir = join(dir, '.workflow', 'src', 'rails');
  mkdirSync(railsDir, { recursive: true });
  writeFileSync(join(railsDir, 'cli.mjs'), `console.log(${JSON.stringify(label)});\n`, 'utf8');
}

// Вывод shell'а и при ненулевом коде выхода (repro печатает и падает).
function shellOut(run, command, root) {
  try {
    return run(command, root);
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

// MEDIUM (ревью B2 r3): isCdSegment принимал каталог с раскрытием — `cd $PWD/…` давал
// cdDir = null, путь cli.mjs резолвился от ctx.cwd (корень → «cli.mjs проекта»), а shell
// переходил в каталог и запускал копию из write_scope: короткое замыкание allow мимо общих
// правил. Теперь cd-префикс засчитывается только с литеральным каталогом.
test('decide (B3, MEDIUM): cd-префикс с нелитеральным каталогом ($PWD, "$PWD/…", ~, -, glob) — не cli-вызов; bash реально запускает копию', () => {
  withProject(({ root }) => {
    writeCliStub(root);
    writeCliCopy(join(root, '.workflow', 'work', 'copy'));
    const { sessionId } = makeState(root, 'P4S1');
    const run = (command) => decide({ action: { tool: 'Bash', kind: 'shell', command, shell: 'posix' }, ctx: { cwd: root, sessionId } });
    const tail = 'node .workflow/src/rails/cli.mjs status';
    for (const cd of [
      'cd $PWD/.workflow/work/copy',
      'cd "$PWD/.workflow/work/copy"',
      'cd "${PWD}/.workflow/work/copy"',
      'cd ~+/.workflow/work/copy',
      'cd ~',
      'cd -',
      'cd .workflow/work/cop?',
      'cd .workflow/work/{copy,x}',
    ]) {
      notCli(run(`${cd} && ${tail}`), cd);
    }
    // Repro: исходная команда действительно запускает копию, а не cli.mjs проекта.
    assert.match(runBash(`cd $PWD/.workflow/work/copy && ${tail}`, root), /COPY-CLI/);
    assert.match(runBash(`cd "$PWD/.workflow/work/copy" && ${tail}`, root), /COPY-CLI/);
    assert.match(runBash(`cd ~+/.workflow/work/copy && ${tail}`, root), /COPY-CLI/);
    // `||` после cd: node выполняется, только если cd НЕ удался, — каталог cd к нему не относится.
    notCli(run(`cd "${root}" || ${tail}`), 'cd … ||');
    // Контроль: литеральный каталог — cli-вызов, путь резолвится от него.
    assert.equal(run(`cd "${root}" && ${tail}`).updatedCommand, `cd "${root}" && ${tail} --session ${sessionId}`);
    assert.equal(run(`cd "${root}" ; ${tail}`).updatedCommand, `cd "${root}" ; ${tail} --session ${sessionId}`);
    notCli(run(`cd .workflow/work/copy && ${tail}`), 'литеральный cd в копию');
  });
});

test('decide (B3, MEDIUM) + PowerShell: cd $PWD/… и cd с wildcard — не cli-вызов; powershell.exe реально запускает копию', () => {
  withProject(({ root }) => {
    writeCliStub(root);
    writeCliCopy(join(root, '.workflow', 'work', 'copy'));
    const { sessionId } = makeState(root, 'P4S1');
    const run = (command) => decide({ action: { tool: 'PowerShell', kind: 'shell', command, shell: 'powershell' }, ctx: { cwd: root, sessionId } });
    const tail = 'node .workflow/src/rails/cli.mjs status';
    for (const cd of ['cd $PWD/.workflow/work/copy', 'cd "$PWD/.workflow/work/copy"', "cd '.workflow/work/cop?'", "cd '.workflow/work/[c]opy'", "cd '~'", 'cd env:', 'cd C:']) {
      notCli(run(`${cd}; ${tail}`), cd);
    }
    assert.equal(run(`cd "${root}"; ${tail}`).updatedCommand, `cd "${root}"; ${tail} --session ${sessionId}`);
    if (process.platform === 'win32') {
      assert.match(shellOut(runPowerShell, `cd $PWD/.workflow/work/copy; ${tail}`, root), /COPY-CLI/);
      assert.match(shellOut(runPowerShell, `cd "$PWD/.workflow/work/copy"; ${tail}`, root), /COPY-CLI/);
      // Set-Location раскрывает wildcard даже в '…' (проверено запуском).
      assert.match(shellOut(runPowerShell, `cd '.workflow/work/cop?'; ${tail}`, root), /COPY-CLI/);
    }
  });
});

// Лексическое совпадение текста каталога с корнем не значит, что shell придёт туда же:
// `~` раскрывается в $HOME (bash) / домашний каталог (PowerShell, даже в '…'), `[r]oot` —
// шаблон (bash без кавычек, Set-Location — всегда). Корень с такими символами в пути даёт
// ложный отказ, cli.mjs «чужого» каталога — ложное разрешение; выбираем первое.
test('analyzeCliCommand (B3, MEDIUM): каталог cd, лексически равный корню, но раскрываемый shell\'ом (~, [..]) — не cli-вызов', () => {
  const base = mkdtempSync(join(tmpdir(), 'rails-b3-'));
  try {
    const tildeRoot = join(base, '~', 'root');
    const home = join(base, 'home');
    writeCliCopy(tildeRoot, 'REAL-CLI');
    writeCliCopy(join(home, 'root'));
    const tildeCmd = 'cd ~/root && node .workflow/src/rails/cli.mjs status';
    assert.equal(analyzeCliCommand(tildeCmd, 'posix', 'sess-1', { root: tildeRoot, cwd: base }).isCli, false);
    // bash идёт в $HOME/root, а не в <cwd>/~/root.
    const out = execSync(tildeCmd, { cwd: base, shell: 'bash', encoding: 'utf8', env: { ...process.env, HOME: home.replace(/\\/g, '/') } });
    assert.match(out, /COPY-CLI/);

    const globRoot = join(base, '[r]oot');
    writeCliCopy(globRoot, 'REAL-CLI');
    writeCliCopy(join(base, 'root'));
    const glob = `${base.replace(/\\/g, '/')}/[r]oot`;
    assert.equal(analyzeCliCommand(`cd ${glob} && node .workflow/src/rails/cli.mjs status`, 'posix', 'sess-1', { root: globRoot, cwd: base }).isCli, false);
    assert.equal(analyzeCliCommand(`cd '${glob}'; node .workflow/src/rails/cli.mjs status`, 'powershell', 'sess-1', { root: globRoot, cwd: base }).isCli, false);
    // Контроль: bash без кавычек раскрывает шаблон в каталог `root`.
    assert.match(execSync(`cd ${glob} && pwd`, { cwd: base, shell: 'bash', encoding: 'utf8' }), /\/root\s*$/);
    if (process.platform === 'win32') {
      assert.match(runPowerShell(`cd '${glob}'; node .workflow/src/rails/cli.mjs status`, base), /COPY-CLI/);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// Ложный allow того же класса (найден при B3): интерпретатор проверялся по окончанию пути
// (`…/node`), и `.workflow/work/node .workflow/src/rails/cli.mjs status` — скрипт агента из
// write_scope — проходил коротким замыканием. Теперь интерпретатор — только `node`/`node.exe`
// без каталога (поиск по PATH).
test('decide (B3): интерпретатор с каталогом (.workflow/work/node, ./node) — не cli-вызов; bash запускает скрипт агента', () => {
  withProject(({ root }) => {
    writeCliStub(root);
    const { sessionId } = makeState(root, 'P4S1');
    writeFileSync(join(root, '.workflow', 'work', 'node'), '#!/bin/sh\necho EVIL-NODE "$@"\n', 'utf8');
    const run = (command) => decide({ action: { tool: 'Bash', kind: 'shell', command, shell: 'posix' }, ctx: { cwd: root, sessionId } });
    for (const command of [
      '.workflow/work/node .workflow/src/rails/cli.mjs status',
      'cd .workflow/work && ./node ../src/rails/cli.mjs status',
      `${join(root, '.workflow', 'work', 'node').replace(/\\/g, '/')} .workflow/src/rails/cli.mjs status`,
    ]) {
      notCli(run(command), command);
    }
    if (process.platform === 'win32') {
      assert.match(runBash('.workflow/work/node .workflow/src/rails/cli.mjs status', root), /EVIL-NODE/);
    }
    assert.equal(run('node.exe .workflow/src/rails/cli.mjs status').updatedCommand, `node.exe .workflow/src/rails/cli.mjs status --session ${sessionId}`);
  });
});

// LOW → ложный allow (B3, проверено запуском powershell.exe 5.1): после `--%` PowerShell не
// разбирает кавычки, но `|` внутри '…' по-прежнему делит конвейер, а бэктик вне кавычек
// экранирует: `--quote 'a | ni PWNED | echo `'` сканер видит одним литералом, PowerShell
// выполняет `ni`. Кроме того, после `--%` одинарные кавычки уходят в argv буквально —
// переписанная `--quote '…'` рассыпалась. Любой `--%` под PowerShell — не cli-вызов.
test('decide (B3) + PowerShell: `--%` (stop-parsing) в команде — не cli-вызов, --quote не переписывается, --session не вставляется', () => {
  withProject(({ root }) => {
    writeCliStub(root);
    const { sessionId } = makeState(root, 'P4S1');
    const run = (command, shell = 'powershell') => decide({ action: { tool: shell === 'powershell' ? 'PowerShell' : 'Bash', kind: 'shell', command, shell }, ctx: { cwd: root, sessionId } });
    const inject = `node .workflow/src/rails/cli.mjs goto P5E1 --% --quote 'a | ni ${markerPath(root)} | echo \`'`;
    for (const command of [
      'node .workflow/src/rails/cli.mjs goto P5E1 --% --quote "a $X"',
      inject,
      'node .workflow/src/rails/cli.mjs status `--% a;b',
      "node .workflow/src/rails/cli.mjs status '--%' a",
      'node .workflow/src/rails/cli.mjs status --%',
    ]) {
      notCli(run(command), command);
      assert.equal(analyzeCliCommand(command, 'powershell', sessionId).isCli, false, command);
    }
    if (process.platform === 'win32') {
      shellOut(runPowerShell, inject, root);
      assert.equal(existsSync(join(root, 'PWNED.txt')), true, 'repro: PowerShell выполняет ni из «цитаты» после --%');
      rmSync(join(root, 'PWNED.txt'));
    }
    // POSIX: `--%` — обычный аргумент, cli-вызов сохраняется.
    const posix = 'node .workflow/src/rails/cli.mjs status --%';
    assert.equal(run(posix, 'posix').updatedCommand, `${posix} --session ${sessionId}`);
  });
});

// LOW (ревью B2 r3, ложный отказ): msys-путь Git Bash `/c/Users/…` в каталоге cd — на win32 под
// POSIX это `C:/Users/…` (builtin cd переводит его сам, и при MSYS_NO_PATHCONV=1 — проверено
// запуском); под PowerShell `/c/…` — путь от корня текущего диска, не переводится.
// Ревью B3 r2 (LOW, 2026-09-22): путь cli.mjs вида `/c/…` — не cli-вызов. Аргумент node.exe msys
// переводит, только пока не заданы MSYS_NO_PATHCONV/MSYS2_ARG_CONV_EXCL: иначе node открывает
// `<диск cwd>:\c\…`, а хук признавал путь каноническим C:/… и давал короткое замыкание.
test('decide (B3, LOW; B3 r3): msys-путь /<диск>/… под Git Bash — cli-вызов только в каталоге cd; путь cli.mjs /c/… — не cli (MSYS_NO_PATHCONV)', { skip: process.platform !== 'win32' ? 'msys-пути — только Git for Windows' : false }, () => {
  withProject(({ root }) => {
    writeCliStub(root);
    const { sessionId } = makeState(root, 'P4S1');
    const msys = `/${root[0].toLowerCase()}${root.slice(2).replace(/\\/g, '/')}`;
    const run = (command, shell = 'posix') => decide({ action: { tool: shell === 'posix' ? 'Bash' : 'PowerShell', kind: 'shell', command, shell }, ctx: { cwd: root, sessionId } });
    const noConv = { ...process.env, MSYS_NO_PATHCONV: '1' };
    const bashNoConv = (command) => execSync(command, { cwd: root, shell: 'bash', encoding: 'utf8', env: noConv, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const command of [
      `cd ${msys} && node .workflow/src/rails/cli.mjs status`,
      `cd /${root[0].toUpperCase()}${root.slice(2).replace(/\\/g, '/')} && node .workflow/src/rails/cli.mjs status`,
    ]) {
      const r = run(command);
      assert.equal(r.updatedCommand, `${command} --session ${sessionId}`, command);
      const argv = JSON.parse(runBash(r.updatedCommand, root)).slice(2);
      assert.deepEqual(argv, ['status', '--session', sessionId], command);
      assert.deepEqual(JSON.parse(bashNoConv(r.updatedCommand)).slice(2), ['status', '--session', sessionId], `${command} (MSYS_NO_PATHCONV=1)`);
    }
    for (const command of [
      `node ${msys}/.workflow/src/rails/cli.mjs status`,
      `node "${msys}/.workflow/src/rails/cli.mjs" status`,
      `${msys}/.workflow/src/rails/cli.mjs status`,
    ]) {
      notCli(run(command), command);
    }
    // Механизм (repro ревью B3 r2): с MSYS_NO_PATHCONV=1 node.exe получает `/c/…` как есть и
    // резолвит его от корня диска cwd (`C:\c\Users\…`), без переменной — `C:/Users/…`.
    const probe = `node -e "console.log(process.argv[1] + '|' + require('path').resolve(process.argv[1]))" ${msys}`;
    const [convRaw] = runBash(probe, root).trim().split('|');
    assert.equal(convRaw.toLowerCase(), root.replace(/\\/g, '/').toLowerCase());
    const [raw, resolved] = bashNoConv(probe).trim().split('|');
    assert.equal(raw, msys);
    assert.equal(resolved.toLowerCase(), `${root.slice(0, 3)}${msys.slice(1).replace(/\//g, '\\')}`.toLowerCase());
    // Не буква диска — не переводим (msys: /tmp → %TEMP%, /usr → каталог Git).
    notCli(run(`node /tmp${root.slice(2).replace(/\\/g, '/')}/.workflow/src/rails/cli.mjs status`), '/tmp/…');
    // PowerShell: /c/… — не msys-путь.
    notCli(run(`node ${msys}/.workflow/src/rails/cli.mjs status`, 'powershell'), 'PowerShell /c/…');
  });
});

// LOW (ревью B2 r3, ложный отказ): префикс присваивания `WORKFLOW_RAILS_SKILL=coach node …`
// (POSIX). Допустимы только переменные рельс с литеральным значением без `/` и `~`:
// NODE_OPTIONS, PATH, WORKFLOW_HOME и т. п. меняют, какой код выполнится или куда cli.mjs
// пишет, — такой префикс не cli-вызов.
test('decide (B3, LOW): префикс WORKFLOW_RAILS_*=литерал (POSIX) — cli-вызов; bash доносит argv с --session и переписанной --quote', () => {
  withProject(({ root }) => {
    writeCliStub(root);
    const { sessionId } = makeState(root, 'P4S1');
    const run = (command, shell = 'posix') => decide({ action: { tool: shell === 'posix' ? 'Bash' : 'PowerShell', kind: 'shell', command, shell }, ctx: { cwd: root, sessionId } });
    const status = 'WORKFLOW_RAILS_SKILL=coach node .workflow/src/rails/cli.mjs status';
    const r1 = run(status);
    assert.equal(r1.updatedCommand, `${status} --session ${sessionId}`);
    assert.deepEqual(JSON.parse(runBash(r1.updatedCommand, root)).slice(2), ['status', '--session', sessionId]);
    const goto = 'WORKFLOW_RAILS_SKILL="coach" WORKFLOW_RAILS_RUN=r-1 node .workflow/src/rails/cli.mjs goto P5E1 --quote "из `x`, $X"';
    const r2 = run(goto);
    assert.equal(r2.updatedCommand, `WORKFLOW_RAILS_SKILL="coach" WORKFLOW_RAILS_RUN=r-1 node .workflow/src/rails/cli.mjs goto P5E1 --quote 'из \`x\`, $X' --session ${sessionId}`);
    assert.deepEqual(JSON.parse(runBash(r2.updatedCommand, root)).slice(2), ['goto', 'P5E1', '--quote', 'из `x`, $X', '--session', sessionId]);
    for (const command of [
      'NODE_OPTIONS=--require=./.workflow/work/x.js node .workflow/src/rails/cli.mjs status',
      'PATH=.workflow/work node .workflow/src/rails/cli.mjs status',
      'WORKFLOW_HOME=.workflow/work node .workflow/src/rails/cli.mjs status',
      'WORKFLOW_RAILS_SKILL=$X node .workflow/src/rails/cli.mjs status',
      'WORKFLOW_RAILS_SKILL=~ node .workflow/src/rails/cli.mjs status',
      'WORKFLOW_RAILS_SESSION=../../x node .workflow/src/rails/cli.mjs status',
      'WORKFLOW_RAILS_SKILL+=x node .workflow/src/rails/cli.mjs status',
    ]) {
      notCli(run(command), command);
    }
    // PowerShell: `X=y node …` — не присваивание, а команда с именем `X=y`.
    notCli(run(status, 'powershell'), 'PowerShell');
  });
});

// --- ЗАДАЧА B3, раунд 2 (2026-09-22): дефекты ревью B3 r1 ---------------------------------------

const decideAs = (shell, command, cwd, sessionId) => decide({
  action: { tool: shell === 'powershell' ? 'PowerShell' : 'Bash', kind: 'shell', command, shell },
  ctx: { cwd, sessionId },
});

// MEDIUM: Set-Location снимает wildcard-экранирование даже в '…' — `cd 'j``k'` переходит в j`k
// (проверено запуском). Хук брал путь буквально; j``k — junction на .workflow/src, и ветка
// realpath признавала копию из j`k «своим» cli.mjs: allow с --session мимо общих правил.
test('decide (B3 r2, MEDIUM) + PowerShell: бэктик в каталоге cd (`cd \'j``k\'`, j``k — junction на .workflow/src) — не cli-вызов; powershell.exe запускает копию из j`k', () => {
  withProject(({ root }) => {
    writeCliStub(root);
    const { sessionId } = makeState(root, 'P4S1');
    const work = join(root, '.workflow', 'work');
    const src = join(root, '.workflow', 'src');
    createJunction(src, join(work, 'j``k'));
    mkdirSync(join(work, 'j`k', 'rails'), { recursive: true });
    writeFileSync(join(work, 'j`k', 'rails', 'cli.mjs'), 'console.log("COPY-CLI");\n', 'utf8');
    const chain = "cd '.workflow/work/j``k'; node rails/cli.mjs status";
    const dq = 'cd ".workflow/work/j````k"; node rails/cli.mjs status';
    // ctx.cwd = .workflow/src: `rails/cli.mjs` ведёт к cli.mjs проекта и от cwd — отказ только из-за бэктика.
    const abs = `cd '${work.replace(/\\/g, '/')}/j\`\`k'; node rails/cli.mjs status`;
    notCli(decideAs('powershell', chain, root, sessionId), chain);
    notCli(decideAs('powershell', dq, root, sessionId), dq);
    notCli(decideAs('powershell', abs, src, sessionId), abs);
    // `&&` (PowerShell 7): каталог cd единственный — отказ тоже только из-за бэктика.
    assert.equal(analyzeCliCommand("cd '.workflow/work/j``k' && node rails/cli.mjs status", 'powershell', sessionId, { root, cwd: root }).isCli, false);
    if (process.platform === 'win32') {
      assert.match(shellOut(runPowerShell, chain, root), /COPY-CLI/);
      assert.match(shellOut(runPowerShell, dq, root), /COPY-CLI/);
      assert.match(shellOut(runPowerShell, abs, src), /COPY-CLI/);
    }
  });
});

// MEDIUM: после `;`/перевода строки сегмент выполняется и при неудачном cd — в прежнем каталоге.
// bash отказывает в `cd nope/../..` («No such file or directory»), хук же резолвил путь от
// лексически свёрнутого каталога. Сессия в .workflow/work (Claude Code передаёт хуку cwd после
// `cd` прошлого вызова): копия .workflow/work/src/rails/cli.mjs запускалась коротким замыканием.
test('decide (B3 r2, MEDIUM): `cd ./nope/../..; node src/rails/cli.mjs status` из .workflow/work — не cli-вызов; bash отказывает в cd и запускает копию', () => {
  withProject(({ root }) => {
    writeCliStub(root);
    const { sessionId } = makeState(root, 'P4S1');
    const work = join(root, '.workflow', 'work');
    mkdirSync(join(work, 'src', 'rails'), { recursive: true });
    writeFileSync(join(work, 'src', 'rails', 'cli.mjs'), 'console.log("COPY-CLI");\n', 'utf8');
    const tail = 'node src/rails/cli.mjs status';
    const commands = [`cd ./nope/../..; ${tail}`, `cd nope/../..; ${tail}`, `cd ./nope/../..\n${tail}`];
    if (process.platform === 'win32') {
      // msys: `/c/..` — корень Git, cd не удаётся (хук видел C:/../<корень> → <корень>).
      commands.push(`cd /${root[0].toLowerCase()}/..${root.slice(2).replace(/\\/g, '/')}/.workflow; ${tail}`);
    }
    for (const command of commands) {
      notCli(decideAs('posix', command, work, sessionId), JSON.stringify(command));
      assert.match(shellOut(runBash, command, work), /COPY-CLI/, `repro: ${JSON.stringify(command)}`);
    }
    // Под `&&` при неудачном cd не выполняется ничего, но с B3 r3 подъём через несуществующий
    // каталог не подтверждается (isLinkOrUnknown: ошибка lstat — неизвестность) — ложный отказ.
    const and = `cd ./nope/../.. && ${tail}`;
    notCli(decideAs('posix', and, work, sessionId), and);
    assert.doesNotMatch(shellOut(runBash, and, work), /COPY-CLI|status/);
  });
});

// MEDIUM: то же при ctx.cwd = корень — `;`, перевод строки, `||` и `;` дальше по цепочке после
// cd. Каталог cd с `..` через несуществующий каталог или файл bash отвергает; PowerShell `cd src`
// без src/ — PathNotFound, следующий statement выполняется. Копия — <root>/rails/cli.mjs
// (у analyze-report write_scope "**").
test('decide (B3 r2, MEDIUM): после cd с `;`/переводом строки/`||` путь cli.mjs проверяется и от ctx.cwd; при неудачном cd shell запускает копию', () => {
  withProject(({ root }) => {
    writeCliStub(root);
    const { sessionId } = makeState(root, 'P4S1');
    mkdirSync(join(root, 'rails'), { recursive: true });
    writeFileSync(join(root, 'rails', 'cli.mjs'), 'console.log("COPY-CLI");\n', 'utf8');
    const tail = 'node rails/cli.mjs status';
    for (const command of [
      `cd ./nonexist/../.workflow/src ; ${tail}`,
      `cd ./.workflow/src/rails/cli.mjs/../.. ; ${tail}`,
      `cd ./nonexist/../.workflow/src\n${tail}`,
      `cd ./nonexist/../.workflow/src && ${tail} || ${tail}`,
      `cd ./nonexist/../.workflow/src && ${tail} ; ${tail}`,
      `cd ./src ; ${tail}`,
    ]) {
      notCli(decideAs('posix', command, root, sessionId), JSON.stringify(command));
      assert.match(shellOut(runBash, command, root), /COPY-CLI/, `repro: ${JSON.stringify(command)}`);
    }
    const ps = `cd src; ${tail}`;
    notCli(decideAs('powershell', ps, root, sessionId), ps);
    if (process.platform === 'win32') assert.match(shellOut(runPowerShell, ps, root), /COPY-CLI/);
    // Контроль: только `&&` после cd — cli-вызов; удачный cd запускает cli.mjs проекта, неудачный — ничего.
    const ok = `cd ./.workflow/src && ${tail}`;
    assert.equal(decideAs('posix', ok, root, sessionId).updatedCommand, `${ok} --session ${sessionId}`);
    assert.deepEqual(JSON.parse(runBash(`${ok} --session ${sessionId}`, root)).slice(2), ['status', '--session', sessionId]);
    // Неудачный cd: bash не выполняет ничего, хук с B3 r3 тоже не признаёт вызов своим
    // (подъём через несуществующий nonexist не подтверждён) — ложный отказ.
    const failing = `cd ./nonexist/../.workflow/src && ${tail}`;
    notCli(decideAs('posix', failing, root, sessionId), failing);
    assert.doesNotMatch(shellOut(runBash, failing, root), /COPY-CLI|status/);
  });
});

// HIGH: PowerShell 5.1 включает stop-parsing и для токенов, чей текст не содержит `--%`, — их
// значение после снятия кавычек и бэктиков равно `--%` (проверено запуском, как и типографские
// кавычки ‘’ “”). Проверка `command.includes('--%')` их не видела: `status -'-%' 'x | ni PWNED |
// echo `'` шёл коротким замыканием мимо canary/deny_shell/write_scope, PowerShell выполнял ni.
const STOP_PARSING_FORMS = ["-'-%'", '-"-%"', '-`-%', '--`%', "--'%'", '-"-"%', '`-`-%', "-''-%", '-""-%', '-‘-%’', '-“-%”', '-’’-%'];

test('decide (B3 r2, HIGH) + PowerShell: stop-parsing без подстроки `--%` (-\'-%\', --`%, -""-% …) — не cli-вызов; powershell.exe выполняет ni из «цитаты»', () => {
  withProject(({ root }) => {
    writeCliStub(root);
    const { sessionId } = makeState(root, 'P4S1');
    const marker = (i) => join(root, `PWNED_${i}.txt`).replace(/\\/g, '/');
    const commands = STOP_PARSING_FORMS.map((f, i) => `node .workflow/src/rails/cli.mjs status ${f} 'x | ni ${marker(i)} | echo \`'`);
    for (const command of commands) {
      assert.equal(command.includes('--%'), false, command);
      notCli(decideAs('powershell', command, root, sessionId), command);
      assert.equal(analyzeCliCommand(command, 'powershell', sessionId).isCli, false, command);
    }
    // deny_shell больше не обходится коротким замыканием.
    const git = "node .workflow/src/rails/cli.mjs status -'-%' 'x | git commit -m y | echo `'";
    const r = decideAs('powershell', git, root, sessionId);
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /git-операции/);
    // POSIX: тот же токен — обычный аргумент.
    assert.equal(analyzeCliCommand("node .workflow/src/rails/cli.mjs status -'-%'", 'posix', sessionId).isCli, true);
    // `u{2d} — escape pwsh 7 (не проверено запуском: pwsh нет): консервативно не cli.
    assert.equal(analyzeCliCommand('node .workflow/src/rails/cli.mjs status -"`u{2d}"-% x', 'powershell', sessionId).isCli, false);
    if (process.platform === 'win32') {
      // Repro одним процессом: stop-parsing действует до конца строки.
      shellOut(runPowerShell, commands.join('\n'), root);
      STOP_PARSING_FORMS.forEach((f, i) => assert.equal(existsSync(marker(i)), true, `repro ${f}: PowerShell выполнил ni`));
    }
  });
});

// LOW: msys-путь с `..` — Git Bash понимает `/c/..` как корень Git, `/c/../tmp` и
// `/c/Users/../../tmp` — как %TEMP%, а path.win32 сворачивает их в C:\tmp. Для проекта в
// <диск>:\tmp\… хук признавал `cd /c/../tmp/<проект> && node …` cli-вызовом, bash запускал копию в %TEMP%.
test('analyzeCliCommand (B3 r2, LOW): msys-путь с `..` (`cd /c/../tmp/…`) — не cli-вызов; Git Bash понимает `/c/..` как корень Git', { skip: process.platform !== 'win32' ? 'msys-пути — только Git for Windows' : false }, () => {
  const root = 'C:\\tmp\\rails-b3-msys-proj';
  const scope = { root, cwd: root };
  for (const command of [
    'cd /c/../tmp/rails-b3-msys-proj && node .workflow/src/rails/cli.mjs status',
    'cd /c/Users/../../tmp/rails-b3-msys-proj && node .workflow/src/rails/cli.mjs status',
    'node /c/../tmp/rails-b3-msys-proj/.workflow/src/rails/cli.mjs status',
  ]) {
    assert.equal(analyzeCliCommand(command, 'posix', 'sess-1', scope).isCli, false, command);
  }
  assert.equal(analyzeCliCommand('cd /c/tmp/rails-b3-msys-proj && node .workflow/src/rails/cli.mjs status', 'posix', 'sess-1', scope).isCli, true);
  // Механизм: `/c/..` в Git Bash — не C:/.
  const up = execSync('cd /c/.. && pwd -W', { shell: 'bash', encoding: 'utf8' }).trim();
  assert.notEqual(up.toLowerCase(), 'c:/');
});

// LOW (pre-existing, B2 r3): `<root>/src/rails/cli.mjs` принимался лексически в любом проекте, без
// проверки существования. У analyze-report write_scope "**" — агент кладёт свой src/rails/cli.mjs.
// Теперь канон — только .workflow/src/rails/cli.mjs; в workflowAi `.workflow/src/rails` — junction
// на src/rails, и `node src/rails/cli.mjs` проходит по realpath.
test('decide (B3 r2, LOW): src/rails/cli.mjs — не канон: копия агента не cli-вызов; раскладка workflowAi (.workflow/src/rails → src/rails) — cli по realpath', () => {
  const ghost = join(tmpdir(), `rails-b3-ghost-${uuid()}`);
  assert.equal(analyzeCliCommand('node src/rails/cli.mjs status', 'posix', 's1', { root: ghost, cwd: ghost }).isCli, false);
  withProject(({ root }) => {
    writeCliStub(root);
    const { sessionId } = makeState(root, 'P4S1');
    mkdirSync(join(root, 'src', 'rails'), { recursive: true });
    writeFileSync(join(root, 'src', 'rails', 'cli.mjs'), 'console.log("COPY-CLI");\n', 'utf8');
    notCli(decideAs('posix', 'node src/rails/cli.mjs status', root, sessionId), 'копия src/rails/cli.mjs');
    assert.match(runBash('node src/rails/cli.mjs status', root), /COPY-CLI/);
  });
  withProject(({ root }) => {
    mkdirSync(join(root, 'src', 'rails'), { recursive: true });
    writeFileSync(join(root, 'src', 'rails', 'cli.mjs'), 'console.log(JSON.stringify(process.argv));\n', 'utf8');
    createJunction(join(root, 'src', 'rails'), join(root, '.workflow', 'src', 'rails'));
    const { sessionId } = makeState(root, 'P4S1');
    const r = decideAs('posix', 'node src/rails/cli.mjs status', root, sessionId);
    assert.equal(r.updatedCommand, `node src/rails/cli.mjs status --session ${sessionId}`);
    assert.deepEqual(JSON.parse(runBash(r.updatedCommand, root)).slice(2), ['status', '--session', sessionId]);
  });
});

// Найдено при B3 r2 (проверено запуском): bash ищет относительный каталог cd, не начинающийся с
// `./`/`../`, по CDPATH — `cd .workflow/src` при CDPATH=.workflow/work переходит в копию.
// CDPATH shell'а агента хуку не известен: такой cd-префикс не литерал.
test('decide (B3 r2): относительный каталог cd без `./` под POSIX — не cli-вызов (CDPATH); `cd ./…` — cli', () => {
  withProject(({ root }) => {
    writeCliStub(root);
    writeCliCopy(join(root, '.workflow', 'work'));
    const { sessionId } = makeState(root, 'P4S1');
    const env = { ...process.env, CDPATH: '.workflow/work' };
    const bashEnv = (command) => execSync(command, { cwd: root, shell: 'bash', encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
    const bare = 'cd .workflow/src && node rails/cli.mjs status';
    notCli(decideAs('posix', bare, root, sessionId), bare);
    assert.match(bashEnv(bare), /COPY-CLI/);
    const dotted = 'cd ./.workflow/src && node rails/cli.mjs status';
    const r = decideAs('posix', dotted, root, sessionId);
    assert.equal(r.updatedCommand, `${dotted} --session ${sessionId}`);
    assert.deepEqual(JSON.parse(bashEnv(r.updatedCommand)).slice(2), ['status', '--session', sessionId]);
  });
});

// --- ЗАДАЧА B3, раунд 3 (2026-09-22): дефекты ревью B3 r2 ----------------------------------------

// Раскладка repro ревью B3 r2: копия <work>/c/.workflow/src/rails/cli.mjs (агент вправе создать её в
// write_scope) и junction <work>/lnk → <work>/c/d1/d2/d3. Из lnk `../../../` логически ведёт в
// корень проекта, физически — в <work>/c. Копия не в <work>/.workflow: иначе при ctx.cwd = lnk
// findProjectRoot принял бы <work> за корень проекта (отдельная дыра поиска корня, не cli.mjs).
function junctionLayout(root) {
  const work = join(root, '.workflow', 'work');
  writeCliCopy(join(work, 'c'));
  mkdirSync(join(work, 'c', 'd1', 'd2', 'd3'), { recursive: true });
  const lnk = join(work, 'lnk');
  createJunction(join(work, 'c', 'd1', 'd2', 'd3'), lnk);
  return { work, lnk };
}

// MEDIUM (ревью B3 r2, два отчёта): после `cd` в junction msys отдаёт node.exe ФИЗИЧЕСКИЙ каталог
// (цель ссылки), и `..` в пути cli.mjs поднимается от цели. Хук сворачивал `..` от логического
// каталога cd и признавал копию из write_scope «своим» cli.mjs: allow с --session мимо deny_shell.
// Второй вариант — ctx.cwd уже лежит за junction (`cd . && node ../../../…`). Теперь под POSIX `..`
// принимается, только если каталог подъёма не ссылка и родитель его realpath — realpath его
// текстового родителя (логический и физический подъём ведут в один каталог).
test('decide (B3 r3, MEDIUM): `cd ./.workflow/work/lnk && node ../../../.workflow/src/rails/cli.mjs` (lnk — junction) — не cli-вызов; bash запускает копию из цели junction', () => {
  withProject(({ root }) => {
    writeCliStub(root);
    const { sessionId } = makeState(root, 'P4S1');
    const { lnk } = junctionLayout(root);
    for (const command of [
      'cd ./.workflow/work/lnk && node ../../../.workflow/src/rails/cli.mjs status',
      'cd ./.workflow/work/lnk && ../../../.workflow/src/rails/cli.mjs status',
      'cd ./.workflow/work/lnk/. && node ./../../../.workflow/src/rails/cli.mjs status',
      `cd "${lnk}" && node ../../../.workflow/src/rails/cli.mjs status`,
    ]) {
      notCli(decideAs('posix', command, root, sessionId), command);
    }
    const chain = 'cd ./.workflow/work/lnk && node ../../../.workflow/src/rails/cli.mjs status';
    assert.match(runBash(chain, root), /COPY-CLI/, 'repro: bash запускает копию');
    // deny_shell больше не обходится коротким замыканием.
    const goto = 'cd ./.workflow/work/lnk && node ../../../.workflow/src/rails/cli.mjs goto P5E1 --quote "git commit -m x"';
    const r = decideAs('posix', goto, root, sessionId);
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /git-операции/);
    // ctx.cwd — сам junction (логический путь): `cd .` делает каталог физическим.
    const dot = 'cd . && node ../../../.workflow/src/rails/cli.mjs status';
    notCli(decideAs('posix', dot, lnk, sessionId), `ctx.cwd=lnk: ${dot}`);
    assert.match(runBash(dot, lnk), /COPY-CLI/, 'repro: bash с cwd=lnk после `cd .` запускает копию');
    // Без cd, через junction в самом пути: bash отдаёт node логический путь (запускается cli.mjs
    // проекта), но хук этого не моделирует — ложный отказ короткого замыкания допустим.
    notCli(decideAs('posix', 'node .workflow/work/lnk/../../../.workflow/src/rails/cli.mjs status', root, sessionId), 'lnk/.. без cd');
    // Контроль: `..` без ссылок на пути — cli-вызов, bash запускает cli.mjs проекта.
    const plain = 'cd ./.workflow/work && node ../../.workflow/src/rails/cli.mjs status';
    const ok = decideAs('posix', plain, root, sessionId);
    assert.equal(ok.updatedCommand, `${plain} --session ${sessionId}`);
    assert.deepEqual(JSON.parse(runBash(ok.updatedCommand, root)).slice(2), ['status', '--session', sessionId]);
    const up = 'node ../../.workflow/src/rails/cli.mjs status';
    assert.equal(decideAs('posix', up, join(root, '.workflow', 'work'), sessionId).updatedCommand, `${up} --session ${sessionId}`);
  });
});

// Контроль к MEDIUM выше: PowerShell поднимается по `..` логически — Set-Location в junction и
// node, запущенный оттуда, получают каталог ссылки, не цель (проверено запуском ревью B3 r2).
// Там `..` через junction по-прежнему cli-вызов, и powershell.exe запускает cli.mjs проекта.
test('decide (B3 r3) + PowerShell: ctx.cwd — junction, `node ../../../.workflow/src/rails/cli.mjs` — cli-вызов; powershell.exe запускает cli.mjs проекта', { skip: process.platform !== 'win32' ? 'PowerShell-специфичный тест' : false }, () => {
  withProject(({ root }) => {
    writeCliStub(root);
    const { sessionId } = makeState(root, 'P4S1');
    const { lnk } = junctionLayout(root);
    const command = 'node ../../../.workflow/src/rails/cli.mjs status';
    const r = decideAs('powershell', command, lnk, sessionId);
    assert.equal(r.updatedCommand, `${command} --session ${sessionId}`);
    assert.deepEqual(JSON.parse(runPowerShell(r.updatedCommand, lnk)).slice(2), ['status', '--session', sessionId]);
  });
});

// MEDIUM (ревью B3 r3, 2026-09-22, проверено запуском): ссылку, созданную Git Bash при
// MSYS=winsymlinks:sys, Windows видит обычным файлом с атрибутом System (при winsymlinks:lnk —
// файлом `.lnk`), поэтому lstat не считает её симлинком. Проверка подъёма по `..` такую ссылку
// пропускала, а bash через неё переходит и `..` ведёт в родителя ЦЕЛИ — запускалась копия
// cli.mjs из write_scope. Теперь «не каталог» по stat — тоже ссылка.
test('decide (B3 r3, MEDIUM): `cd ./.workflow/work/mlnk && node ../../../.workflow/src/rails/cli.mjs` (mlnk — msys-ссылка) — не cli-вызов; bash запускает копию из цели', { skip: process.platform !== 'win32' ? 'msys-ссылки — Git Bash на Windows' : false }, () => {
  withProject(({ root }) => {
    writeCliStub(root);
    const { sessionId } = makeState(root, 'P4S1');
    const work = join(root, '.workflow', 'work');
    writeCliCopy(join(work, 'c'));
    mkdirSync(join(work, 'c', 'd1', 'd2', 'd3'), { recursive: true });
    execFileSync('bash', ['-c', 'ln -s c/d1/d2/d3 mlnk'], { cwd: work, env: { ...process.env, MSYS: 'winsymlinks:sys' }, stdio: 'ignore' });
    // Взгляд Windows: либо настоящий симлинк (включён Developer Mode), либо файл — не каталог.
    const st = lstatSync(join(work, 'mlnk'));
    assert.ok(st.isSymbolicLink() || !st.isDirectory(), 'msys-ссылка не должна выглядеть обычным каталогом');
    const command = 'cd ./.workflow/work/mlnk && node ../../../.workflow/src/rails/cli.mjs status';
    notCli(decideAs('posix', command, root, sessionId), command);
    assert.match(shellOut(runBash, command, root), /COPY-CLI/, 'repro: bash запускает копию из цели msys-ссылки');
    // Контроль: тот же подъём без ссылки на пути — cli-вызов.
    const plain = 'cd ./.workflow/work && node ../../.workflow/src/rails/cli.mjs status';
    assert.equal(decideAs('posix', plain, root, sessionId).updatedCommand, `${plain} --session ${sessionId}`);
  });
});

// Контроль к MEDIUM выше (B3 r3): короткое имя 8.3 в ctx.cwd — не ссылка. realpath раскрывает его
// в длинное (проверено запуском), и сверка «realpath(cur) === cur» давала бы ложный отказ `..` на
// раннере GitHub, где TEMP короткий (см. find-root.mjs). Bash стартует в коротком пути, node
// сворачивает `..` от него же — запускается cli.mjs проекта.
test('decide (B3 r3): короткое имя 8.3 в ctx.cwd — `node ../../src/rails/cli.mjs` cli-вызов; bash запускает cli.mjs проекта', { skip: process.platform !== 'win32' ? 'имена 8.3 — только Windows' : false }, (t) => {
  withProject(({ root }) => {
    writeCliStub(root);
    const { sessionId } = makeState(root, 'P4S1');
    const work = join(root, '.workflow', 'work');
    mkdirSync(join(work, 'averylongdirectoryname'));
    const listing = execFileSync('cmd.exe', ['/c', 'dir', '/x', work], { encoding: 'latin1' });
    const m = /\s(AVERYL~\d)\s/i.exec(listing);
    if (!m) {
      t.skip('на томе TEMP не создаются имена 8.3');
      return;
    }
    const short = join(work, m[1]);
    const command = 'node ../../src/rails/cli.mjs status';
    const r = decideAs('posix', command, short, sessionId);
    assert.equal(r.updatedCommand, `${command} --session ${sessionId}`);
    assert.deepEqual(JSON.parse(runBash(r.updatedCommand, short)).slice(2), ['status', '--session', sessionId]);
  });
});

// LOW (ревью B3 r2, pre-existing с B2 r3): samePathText сворачивал регистр JS toLowerCase —
// U+212A (KELVIN SIGN) → 'k', а NTFS считает `.wor\u212Aflow` отдельным каталогом. Копия агента
// `.wor\u212Aflow/src/rails/cli.mjs` лексически совпадала с каноном: короткое замыкание мимо
// deny_shell, bash запускал копию. Теперь регистр сворачивается только у ASCII.
// Только win32: регистр сворачивается лишь там; APFS (macOS) сам сводит U+212A к `k` — там это
// один каталог, и копия затёрла бы заглушку (не проверено: macOS нет).
test('decide (B3 r3, LOW): `.wor\\u212Aflow/src/rails/cli.mjs` (KELVIN SIGN) — не cli-вызов; bash запускает копию', { skip: process.platform !== 'win32' ? 'свёртка регистра путей — только win32' : false }, () => {
  withProject(({ root }) => {
    writeCliStub(root);
    const { sessionId } = makeState(root, 'P4S1');
    const kelvin = '.wor\u212Aflow';
    const copyDir = join(root, kelvin, 'src', 'rails');
    mkdirSync(copyDir, { recursive: true });
    writeFileSync(join(copyDir, 'cli.mjs'), 'console.log("COPY-CLI");\n', 'utf8');
    const command = `node ${kelvin}/src/rails/cli.mjs status`;
    notCli(decideAs('posix', command, root, sessionId), command);
    notCli(decideAs('powershell', command, root, sessionId), `PowerShell: ${command}`);
    const goto = `node ${kelvin}/src/rails/cli.mjs goto P5E1 --quote "git commit -m x"`;
    const r = decideAs('posix', goto, root, sessionId);
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /git-операции/);
    assert.match(runBash(command, root), /COPY-CLI/, 'repro: файловая система различает имена, bash запускает копию');
    // Контроль: регистр ASCII по-прежнему не важен на win32 (NTFS), канон — cli-вызов.
    const upper = 'node .WORKFLOW/src/rails/cli.mjs status';
    assert.equal(decideAs('posix', upper, root, sessionId).updatedCommand, `${upper} --session ${sessionId}`);
  });
});

// LOW (ревью B3 r2, ложный отказ — задокументирован в README): после `cd <dir>;` путь cli.mjs
// обязан вести к cli.mjs проекта и от ctx.cwd (cd может не удаться, а PowerShell 5.1 не знает
// `&&`). При ctx.cwd ≠ корень (сессия из каталога-зонтика или подкаталога) относительный путь
// после `cd "<root>";` — не cli-вызов; обход — абсолютный путь к cli.mjs.
test('decide (B3 r3) + PowerShell: `cd "<root>"; node .workflow/src/rails/cli.mjs …` из подкаталога — не cli; с абсолютным путём к cli.mjs — cli, powershell.exe доносит argv', () => {
  withProject(({ root }) => {
    writeCliStub(root);
    const { sessionId } = makeState(root, 'P4S1');
    const sub = join(root, '.workflow', 'work');
    const quote = 'П5 ВХОД: не делать git commit без ревью';
    const rel = `cd "${root}"; node .workflow/src/rails/cli.mjs goto P5E1 --quote "${quote}"`;
    const r1 = decideAs('powershell', rel, sub, sessionId);
    assert.equal(r1.updatedCommand, undefined);
    assert.equal(r1.decision, 'deny');
    const cli = join(root, '.workflow', 'src', 'rails', 'cli.mjs').replace(/\\/g, '/');
    const abs = `cd "${root}"; node "${cli}" goto P5E1 --quote "${quote}"`;
    const r2 = decideAs('powershell', abs, sub, sessionId);
    assert.equal(r2.decision, 'allow');
    assert.equal(r2.updatedCommand, `${abs} --session ${sessionId}`);
    if (process.platform === 'win32') {
      assert.deepEqual(JSON.parse(runPowerShell(r2.updatedCommand, sub)).slice(2), ['goto', 'P5E1', '--quote', quote, '--session', sessionId]);
    }
  });
});

// --- ЗАДАЧА C2 (2026-09-22): консервативный разбор записи через shell — сквозной decide --------
//
// Первая версия разбора cd/переменных (ЗАДАЧА C) отклонена ревью: repro давали allow, а shell
// писал вне write_scope (round1-shell-writes.json, round3-writes-routed.json). Каждый repro
// high/medium ниже — deny (путь вне области или «путь не удалось определить»). Фикстура:
// write_scope .workflow/work/**, allow_temp: false (корень фикстуры сам лежит в %TEMP%).

test('decide (C2): repro ложных разрешений ревью ЗАДАЧИ C (Bash) — deny', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const work = join(root, '.workflow', 'work').replace(/\\/g, '/');
    const out = `${root.replace(/\\/g, '/')}/outside`;
    const cases = [
      // [команда, cwd сессии]
      [`X=$(touch ${out}/x.txt)`, work],
      [`FOO=bar > ${out}/x.txt`, work],
      [`X=1 cat a > ${out}/f.txt`, work],
      [`cd ${work} & touch ${out}/x.txt`, work],
      [`cd ${work} | tee ${out}/x.txt`, work],
      [`cd ${work} $(touch ${out}/x.txt)`, work],
      [`pushd ${work} && popd && touch x.txt`, root],
      [`cd ${work} && cd - && touch x.txt`, root],
      [`pushd ${work} && touch a.txt && popd && touch b.txt`, root],
      [`cd -- ${out} && touch x.txt`, work],
      [`cd -P ${out} && touch x.txt`, work],
      [`cd "${out}" 2>&1 && touch x.txt`, work],
      ['cd $UNSET_VAR_XYZ_123 && touch x.txt', work],
      ['cd "$PWD/.." && touch outside.txt', work],
      ['S=$(dirname "$PWD"); touch "$S/x.txt"', work],
      ['touch `pwd`/../x.txt', work],
      ['S="$NOPE_UNSET_VAR/outside"; touch "$S/x"', work],
      ['cd "$NOPE_UNSET_VAR" && touch x', work],
      ['cd $(mktemp -d) && touch x', work],
      [`(cd ${out} && touch x.txt)`, work],
      [`for d in ${out}; do cd $d; touch x.txt; done`, work],
      [`cat > ${work}/s.sh <<'EOF'\ncd ${work}\nEOF\ntouch after.txt`, root],
      [`echo \\>& touch ${markerPath(root)}`, work],
      [`node .workflow/src/rails/cli.mjs goto P5E1 --quote "a \\" b" ; echo INJECTED > ${markerPath(root)} ; echo "x"`, work],
      [`node .workflow/src/rails/cli.mjs status >&${markerPath(root)}`, work],
    ];
    for (const [command, cwd] of cases) {
      const r = decide({ action: { tool: 'Bash', kind: 'shell', command, shell: 'posix' }, ctx: { cwd, sessionId } });
      assert.equal(r.decision, 'deny', `${command} (cwd ${cwd}): ${JSON.stringify(r)}`);
      assert.match(r.reason, /вне write_scope|путь не удалось определить/, command);
    }
  }, { allowTemp: false });
});

test('decide (C2): repro ложных разрешений ревью ЗАДАЧИ C (PowerShell) — deny', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const work = join(root, '.workflow', 'work');
    const out = join(root, 'outside');
    const cases = [
      `$x = (Remove-Item ${out}\\x.txt)`,
      `$null = Remove-Item ${out}\\x.txt`,
      `$x = Get-Content a > ${out}\\f`,
      `Push-Location ${out}; Remove-Item x.txt`,
      `chdir ${out}; Remove-Item x.txt`,
      `Set-Location -Path ${out}; Remove-Item f.txt`,
      `Set-Location -LiteralPath ${out}; Remove-Item f.txt`,
      `Remove-Item "$x.Path\\x.txt"`,
      `$S = '${work}'; foreach ($S in '${out}') {}; Remove-Item "$S\\f"`,
      `New-Item -ItemType File ${out}\\n.txt`,
      `Write-Output x *> ${out}\\s.txt`,
    ];
    for (const command of cases) {
      const r = decide({ action: fromClaude({ tool_name: 'PowerShell', tool_input: { command } }), ctx: { cwd: work, sessionId } });
      assert.equal(r.decision, 'deny', `${command}: ${JSON.stringify(r)}`);
      assert.match(r.reason, /вне write_scope|путь не удалось определить/, command);
    }
  }, { allowTemp: false });
});

// Инциденты прохода коуча (2026-09-22): запись после `cd <каталог> &&` и через переменную,
// объявленную этой же командой, — внутри write_scope разрешена; тот же приём с каталогом вне
// области — отказ.
test('decide (C2, инциденты): cd <dir> && sed -i …, S=<dir>; sed -i … "$S/f", $S = \'<dir>\'; Remove-Item — allow в области, deny вне', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const work = join(root, '.workflow', 'work').replace(/\\/g, '/');
    const bash = (command, cwd = root) => decide({ action: { tool: 'Bash', kind: 'shell', command, shell: 'posix' }, ctx: { cwd, sessionId } });
    const ps = (command, cwd = root) => decide({ action: fromClaude({ tool_name: 'PowerShell', tool_input: { command } }), ctx: { cwd, sessionId } });
    assert.equal(bash(`cd ${work} && sed -i 's/old/new/' SKILL.md`).decision, 'allow');
    assert.equal(bash(`S="${work}"; sed -i "s/a/b/" "$S/rails-trials-report.mjs"`).decision, 'allow');
    assert.equal(ps(`$S = '${work}'; Remove-Item "$S\\f.txt"`).decision, 'allow');
    assert.equal(ps('Set-Location ./sub; Remove-Item f.txt', work).decision, 'allow', 'оба мира (cd удался / нет) внутри области');
    // тот же приём вне области
    assert.equal(bash(`cd ${work}/.. && sed -i 's/a/b/' SKILL.md`).decision, 'deny');
    assert.equal(bash(`S="${work}/.."; sed -i "s/a/b/" "$S/f"`).decision, 'deny');
    // cd с `;` из каталога вне области: при неудачном cd sed правит файл в прежнем каталоге
    assert.equal(bash(`cd ${work}; sed -i 's/a/b/' SKILL.md`).decision, 'deny');
  }, { allowTemp: false });
});

test('bash (C2): после `cd X;` при неудачном cd запись уходит в прежний каталог — основание для второго мира', { skip: process.platform !== 'win32' ? 'Git Bash — только win32' : false }, () => {
  withProject(({ root }) => {
    runBash('cd ./.workflow/work/nope; touch after-failed-cd.txt', root);
    assert.equal(existsSync(join(root, 'after-failed-cd.txt')), true);
  });
});

// --- ЗАДАЧА C2, раунд 2 (2026-09-22): дефекты ревью второй версии — сквозной decide -----------
//
// Repro ревью: allow, а shell писал/удалял вне write_scope. Каждый — deny. Плюс ложный отказ
// `cd <подкаталог> && sed -i …` (частая правка скила из корня) — теперь allow в области.

test('decide (C2 r2): Bash — динамическое имя присваивания, элемент массива, префиксы флагов GNU — deny', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const work = join(root, '.workflow', 'work').replace(/\\/g, '/');
    const out = `${root.replace(/\\/g, '/')}/outside`;
    const cases = [
      `S=${work}; n=S; declare "$n=${out}"; touch "$S/x1"`,
      `S=${work}; S[0]=${out}; touch "$S/x2"`,
      `S=${work}; n=S; printf -v "$n" %s ${out}; touch "$S/x3"`,
      `S=${work}; n=S; export "$n=${out}"; touch "$S/x4"`,
      `S=${work}; n=S; read -r "$n" < <(echo ${out}); touch "$S/x5"`,
      `cp --target ${out} a.txt`,
      `cp --t=${out} a.txt`,
      `sed --in s/a/b/ ${out}/f.txt`,
      `S[0]=x touch ${out}/f.txt`,
      `cp "$o" a.txt b.txt`,
    ];
    for (const command of cases) {
      const r = decideAs('posix', command, work, sessionId);
      assert.equal(r.decision, 'deny', `${command}: ${JSON.stringify(r)}`);
      assert.match(r.reason, /вне write_scope|путь не удалось определить/, command);
    }
  }, { allowTemp: false });
});

test('decide (C2 r2): PowerShell — массив через запятую, сплаттинг, `-Path:a,b`, тире –, префикс переключателя, `--` — deny', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const work = join(root, '.workflow', 'work');
    const out = join(root, 'outside').replace(/\\/g, '/');
    const cases = [
      `Remove-Item a ,${out}/keep.txt`,
      `Remove-Item a , ${out}/keep.txt`,
      `$p = @{ LiteralPath = "${out}/keep.txt" }; Remove-Item @p`,
      `$p = @{ Path = "${out}/f.txt" }; Set-Content @p -Value x`,
      `Remove-Item -Path a ,${out}/keep.txt`,
      `Remove-Item -Path:a,${out}/keep.txt`,
      `Set-Content –Path ${out}/en.txt –Value x`,
      `Set-Content -Fo ${out}/x.txt y`,
      `Remove-Item -- ${out}/keep.txt`,
    ];
    for (const command of cases) {
      const r = decideAs('powershell', command, work, sessionId);
      assert.equal(r.decision, 'deny', `${command}: ${JSON.stringify(r)}`);
      assert.match(r.reason, /вне write_scope|путь не удалось определить/, command);
    }
  }, { allowTemp: false });
});

test('decide (C2 r2): `cd <подкаталог без ./> && sed -i …` — allow в области; при CDPATH в команде — deny', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const rel = '.workflow/work/skills/coach';
    assert.equal(decideAs('posix', `cd ${rel} && sed -i 's/a/b/' SKILL.md`, root, sessionId).decision, 'allow');
    assert.equal(decideAs('posix', 'cd .workflow && sed -i s/a/b/ SKILL.md', root, sessionId).decision, 'deny', 'подкаталог вне области');
    assert.equal(decideAs('posix', `CDPATH=${root.replace(/\\/g, '/')}; cd ${rel} && sed -i s/a/b/ SKILL.md`, root, sessionId).decision, 'deny');
  }, { allowTemp: false });
});

test('decide (C2 r2): `set -P; cd ./<junction>/.. && touch …` — физический родитель цели ссылки вне области — deny', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const work = join(root, '.workflow', 'work');
    mkdirSync(join(root, 'outside'), { recursive: true });
    createJunction(join(root, 'outside'), join(work, 'lnk'));
    const r = decideAs('posix', 'set -P; cd ./lnk/.. && touch x6.txt', work, sessionId);
    assert.equal(r.decision, 'deny', JSON.stringify(r));
    assert.match(r.reason, /вне write_scope/);
    if (process.platform === 'win32') {
      // Git Bash: после set -P файл создаётся у родителя цели ссылки — в корне фикстуры
      runBash('set -P; cd ./lnk/.. && touch x6.txt', work);
      assert.equal(existsSync(join(root, 'x6.txt')), true);
    }
  }, { allowTemp: false });
});

test('shell (C2 r2): основания repro — PowerShell удаляет второй элемент `a ,b` и путь из @p, bash пишет по динамическому имени и `cp --target`', { skip: process.platform !== 'win32' ? 'powershell.exe и Git Bash — только win32' : false }, () => {
  withProject(({ root }) => {
    const work = join(root, '.workflow', 'work');
    const out = join(root, 'outside');
    mkdirSync(out, { recursive: true });
    const o = out.replace(/\\/g, '/');
    for (const name of ['k1.txt', 'k2.txt']) writeFileSync(join(out, name), 'x');
    writeFileSync(join(work, 'a.txt'), 'x');
    runPowerShell(`Remove-Item a.txt ,${o}/k1.txt; $p = @{ LiteralPath = "${o}/k2.txt" }; Remove-Item @p`, work);
    assert.equal(existsSync(join(out, 'k1.txt')), false, 'a ,b — второй элемент удалён');
    assert.equal(existsSync(join(out, 'k2.txt')), false, '@p — путь из хэш-таблицы удалён');
    writeFileSync(join(work, 'src.txt'), 'x');
    runBash(`S=${work.replace(/\\/g, '/')}; n=S; declare "$n=${o}"; touch "$S/x1.txt"; cp --target ${o} src.txt`, work);
    assert.equal(existsSync(join(out, 'x1.txt')), true, 'declare "$n=…" переписал $S');
    assert.equal(existsSync(join(out, 'src.txt')), true, 'cp --target = --target-directory');
  });
});

test('decide (C2 r2, LOW): вложенный интерпретатор и косвенные писатели — запись вне области видна — deny', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const work = join(root, '.workflow', 'work');
    const out = join(root, 'outside').replace(/\\/g, '/');
    const b64 = Buffer.from(`Remove-Item ${out}/keep.txt`, 'utf16le').toString('base64');
    const cases = [
      ['posix', `powershell.exe -NoProfile -Command "Remove-Item ${out}/keep.txt"`],
      ['posix', `powershell -e ${b64}`],
      ['posix', `bash -c 'rm -f ${out}/keep.txt'`],
      ['posix', `bash <<'EOF'\nrm -f ${out}/keep.txt\nEOF`],
      ['posix', `dd if=a.txt of=${out}/dd.img`],
      ['posix', `cmd //c del keep.txt`],
      ['powershell', `bash -c 'rm -f ${out}/keep.txt'`],
      ['powershell', `[IO.File]::WriteAllText('${out}/w.txt', 'x')`],
    ];
    for (const [shell, command] of cases) {
      const r = decideAs(shell, command, work, sessionId);
      assert.equal(r.decision, 'deny', `${shell}: ${command}: ${JSON.stringify(r)}`);
      assert.match(r.reason, /вне write_scope|путь не удалось определить/, command);
    }
    // контроль: та же запись внутри области — allow
    assert.equal(decideAs('posix', `bash -c 'touch ${work.replace(/\\/g, '/')}/in.txt'`, work, sessionId).decision, 'allow');
  }, { allowTemp: false });
});

// --- ЗАДАЧА C2, раунд 3 (2026-09-22): дефекты ревью третьей версии — сквозной decide ---------
//
// Repro ревью: decide давал allow, а Git Bash писал вне write_scope (`pushd +1`, разделитель
// heredoc с кавычками по частям, here-string, coproc/trap/function). Каждый — deny.

test('decide (C2 r3, HIGH): `pushd +N` и разбор heredoc/here-string — запись вне области видна, deny', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P4S1');
    const work = join(root, '.workflow', 'work').replace(/\\/g, '/');
    const out = `${root.replace(/\\/g, '/')}/outside`;
    mkdirSync(join(root, 'outside'), { recursive: true });
    const cases = [
      // [команда, cwd сессии]
      [`pushd ${work} && pushd +1 && echo hi > PWNED.txt`, root],
      ['pushd .workflow/work && pushd +1 && touch p3.txt', root],
      [`cat <<E"O"F\nhello\nEOF\ntouch ${out}/h1.txt\nE"O"F`, work],
      [`cat <<E\\OF\nhello\nEOF\ntouch ${out}/h2.txt\nE\\OF`, work],
      [`cat <<< EOF\ntouch ${out}/h3.txt\nEOF`, work],
      [`(( x = 1 << 2 ))\ntouch ${out}/h4.txt\n2`, work],
      [`coproc touch ${out}/c1.txt`, work],
      [`trap 'touch ${out}/t1.txt' EXIT`, work],
      [`function f { touch ${out}/f1.txt; }; f`, work],
      [`function f { cd ${out}; }; f; touch fx.txt`, work],
    ];
    for (const [command, cwd] of cases) {
      const r = decideAs('posix', command, cwd, sessionId);
      assert.equal(r.decision, 'deny', `${command} (cwd ${cwd}): ${JSON.stringify(r)}`);
      assert.match(r.reason, /вне write_scope|путь не удалось определить/, command);
    }
    // контроль: те же формы с записью внутри области — allow
    assert.equal(decideAs('posix', `pushd ${work} && touch p6.txt`, root, sessionId).decision, 'allow');
    assert.equal(decideAs('posix', "cat <<'EOF' > note.md\nhello\nEOF", work, sessionId).decision, 'allow');
    assert.equal(decideAs('posix', 'cat <<< hi > note2.md', work, sessionId).decision, 'allow');
  }, { allowTemp: false });
});

// Основание repro: Git Bash выполняет всё это, а разбор раньше не видел записи.
test('bash (C2 r3): pushd +1 возвращает в исходный каталог; тело heredoc кончается там, где снятый с кавычек разделитель', { skip: process.platform !== 'win32' ? 'Git Bash — только win32' : false }, () => {
  withProject(({ root }) => {
    const work = join(root, '.workflow', 'work');
    const sh = (command, cwd) => {
      try {
        runBash(command, cwd);
      } catch {
        /* `EOF: command not found` после тела heredoc — код возврата не важен */
      }
    };
    sh('pushd ./.workflow/work >/dev/null && pushd +1 >/dev/null && touch stack.txt', root);
    assert.equal(existsSync(join(root, 'stack.txt')), true, 'pushd +1 — исходный каталог, не work/+1');
    assert.equal(existsSync(join(work, '+1', 'stack.txt')), false);
    sh('cat <<E"O"F >/dev/null\nhello\nEOF\ntouch hd.txt\nE"O"F', root);
    sh('cat <<E\\OF >/dev/null\nhello\nEOF\ntouch hd2.txt\nE\\OF', root);
    sh('cat <<< EOF >/dev/null\ntouch hs.txt\nEOF', root);
    sh('coproc touch co.txt\nsleep 1', root);
    sh("trap 'touch tr.txt' EXIT", root);
    sh('function fn { touch fn.txt; }; fn', root);
    for (const f of ['hd.txt', 'hd2.txt', 'hs.txt', 'co.txt', 'tr.txt', 'fn.txt']) {
      assert.equal(existsSync(join(root, f)), true, `bash выполнил запись: ${f}`);
    }
  });
});

// Ревью 2026-09-24: apply_patch Kilo правит несколько файлов, а правило этапа и гард скилов
// смотрели только первый путь патча — второй проходил без проверки этапа.
test('decide: apply_patch — правило этапа срабатывает по любому пути патча, не только по первому', () => {
  withProject(({ root }) => {
    const { sessionId } = makeState(root, 'P5S1');
    const scratch = mkdtempSync(join(tmpdir(), 'rails-core-patch-'));
    try {
      const patch = fromKilo({ tool: 'apply_patch' }, { args: { patchText: [
        '*** Begin Patch',
        `*** Add File: ${join(scratch, 'first.txt')}`,
        '+x',
        `*** Add File: ${join(root, '.workflow', 'work', 'second.txt')}`,
        '+y',
        '*** End Patch',
      ].join('\n') } });
      const r = decide({ action: patch, ctx: { cwd: root, sessionId } });
      assert.equal(r.decision, 'deny');
      assert.match(r.reason, /разрешено только на этапах/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

test('decide (G0): apply_patch со вторым путём в каталоге скилов — отказ', () => {
  withProject(({ root }) => {
    const patch = fromKilo({ tool: 'apply_patch' }, { args: { patchText: [
      '*** Begin Patch',
      `*** Add File: ${join(root, 'notes.txt')}`,
      '+x',
      `*** Update File: ${join(root, '.workflow', 'src', 'skills', 'coretest', 'SKILL.md')}`,
      '@@',
      '-a',
      '+b',
      '*** End Patch',
    ].join('\n') } });
    const prev = process.env.WORKFLOW_RAILS_SKILL;
    delete process.env.WORKFLOW_RAILS_SKILL;
    try {
      const r = decide({ action: patch, ctx: { cwd: root, sessionId: uuid() } });
      assert.equal(r.decision, 'deny');
      assert.match(r.reason, /коуча/);
    } finally {
      if (prev !== undefined) process.env.WORKFLOW_RAILS_SKILL = prev;
    }
  });
});
