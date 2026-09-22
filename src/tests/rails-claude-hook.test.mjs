import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { handleHookInput } from '../rails/claude-hook.mjs';
import { startState, saveState, loadState } from '../rails/state.mjs';
import { readJournal } from '../rails/journal.mjs';
import { createJunction } from '../junction-manager.mjs';

// Хук через decide() пишет память «сессия → корень» в <WORKFLOW_HOME>/state —
// изолируем (наследуется и дочерними процессами execFileSync).
process.env.WORKFLOW_HOME = mkdtempSync(join(tmpdir(), 'rails-test-home-'));
process.on('exit', () => rmSync(process.env.WORKFLOW_HOME, { recursive: true, force: true }));

const RAILS_DIR = join(process.cwd(), 'src', 'rails');
const HOOK_PATH = join(RAILS_DIR, 'claude-hook.mjs');

const uuid = () => randomUUID();

// --- фикстура: root с .workflow, скил "hooktest" -----------------------------
//
// Граф: этап 4: P4E1(вход) -> P4S1(шаг) -> P5E1; этап 5: P5E1(вход) -> P5S1(шаг, terminal).
// rails.yaml: canary "echo RAILS_CANARY", output.final_requires содержит один паттерн.

const SKILL_MD = `# Фикстура claude-hook (skill=hooktest)

\`\`\`mermaid
graph TD
    P4E1["П4 ВХОД: Начало этапа теста хука claude для рельсов процедуры"]
    P4S1["П4 ШАГ: Выполнить шаг теста хука claude и продолжить дальше"]
    P4E1 --> P4S1
    P4S1 --> P5E1

    P5E1["П5 ВХОД: Переход к финальному этапу теста хука claude процедуры"]
    P5S1["П5 ШАГ: Завершить работу и подготовить финальный ответ агента здесь"]
    P5E1 --> P5S1
\`\`\`
`;

const RAILS_YAML = [
  'version: 1',
  'skill: hooktest',
  'entry: P4E1',
  'terminal: [P5S1]',
  'pause_nodes: []',
  'quote_min: 25',
  'canary: "echo RAILS_CANARY"',
  '',
  'output:',
  '  final_requires:',
  '    - "RAILS:\\\\s*P\\\\d+[ERSGQ]\\\\d+"',
  '  max_stop_blocks: 2',
  '',
].join('\n');

function withProject(fn) {
  const base = mkdtempSync(join(tmpdir(), 'rails-hook-'));
  try {
    const root = join(base, 'root');
    const skillDir = join(root, '.workflow', 'src', 'skills', 'hooktest');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), SKILL_MD, 'utf8');
    writeFileSync(join(skillDir, 'rails.yaml'), RAILS_YAML, 'utf8');
    fn({ base, root, skillDir });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function makeState(root, node) {
  const sessionId = uuid();
  const state = startState({ root, sessionId, skill: 'hooktest', entry: 'P4E1' });
  state.node = node;
  saveState(root, state);
  return sessionId;
}

function writeTranscript(base, entries) {
  const p = join(base, 'transcript.jsonl');
  writeFileSync(p, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  return p;
}

// --- неизвестное событие ------------------------------------------------------------

test('handleHookInput: неизвестный hook_event_name -> null', () => {
  const r = handleHookInput({ hook_event_name: 'SomethingElse' }, {});
  assert.equal(r, null);
});

test('handleHookInput: input=null -> null, не бросает', () => {
  assert.doesNotThrow(() => {
    const r = handleHookInput(null, {});
    assert.equal(r, null);
  });
});

// --- PreToolUse ----------------------------------------------------------------------

test('PreToolUse: разрешённое действие -> null (пустой вывод)', () => {
  withProject(({ root }) => {
    const sessionId = makeState(root, 'P4S1');
    const r = handleHookInput(
      {
        hook_event_name: 'PreToolUse',
        session_id: sessionId,
        cwd: root,
        tool_name: 'Read',
        tool_input: {},
      },
      {}
    );
    assert.equal(r, null);
  });
});

test('PreToolUse: канарейка -> hookSpecificOutput permissionDecision deny', () => {
  withProject(({ root }) => {
    const sessionId = makeState(root, 'P4S1');
    const r = handleHookInput(
      {
        hook_event_name: 'PreToolUse',
        session_id: sessionId,
        cwd: root,
        tool_name: 'Bash',
        tool_input: { command: 'echo RAILS_CANARY' },
      },
      {}
    );
    assert.equal(r.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(r.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(r.hookSpecificOutput.permissionDecisionReason, /RAILS_CANARY/);
  });
});

test('PreToolUse: cli.mjs без --session -> updatedInput с добавленным --session', () => {
  withProject(({ root }) => {
    const sessionId = makeState(root, 'P4S1');
    const r = handleHookInput(
      {
        hook_event_name: 'PreToolUse',
        session_id: sessionId,
        cwd: root,
        tool_name: 'Bash',
        tool_input: { command: 'node .workflow/src/rails/cli.mjs status' },
      },
      {}
    );
    assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
    assert.equal(
      r.hookSpecificOutput.updatedInput.command,
      `node .workflow/src/rails/cli.mjs status --session ${sessionId}`
    );
  });
});

test('PreToolUse: agent_id во входе -> роль executor -> allow (null) даже для канарейки', () => {
  withProject(({ root }) => {
    const sessionId = makeState(root, 'P4S1');
    const r = handleHookInput(
      {
        hook_event_name: 'PreToolUse',
        session_id: sessionId,
        cwd: root,
        agent_id: 'sub-1',
        tool_name: 'Bash',
        tool_input: { command: 'echo RAILS_CANARY' },
      },
      {}
    );
    assert.equal(r, null);
  });
});

// --- PostToolUse ---------------------------------------------------------------------

test('PostToolUse: allow с context -> additionalContext "RAILS: числится ..."', () => {
  withProject(({ root }) => {
    const sessionId = makeState(root, 'P4S1');
    const r = handleHookInput(
      {
        hook_event_name: 'PostToolUse',
        session_id: sessionId,
        cwd: root,
        tool_name: 'Read',
        tool_input: {},
      },
      {}
    );
    assert.equal(r.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.match(r.hookSpecificOutput.additionalContext, /^RAILS: числится P4S1 «/);
  });
});

// --- blocker-фикс: PostToolUse не тратит потолок stage_actions.max_per_session ------
//
// Фикстура с stage_actions (kilo-hooktest — локальная, отдельная от «hooktest»
// выше, у неё есть write_scope + stage_actions.do_edit с max_per_session).

const STAGE_SKILL_MD = `# Фикстура claude-hook post (skill=hookteststage)

\`\`\`mermaid
graph TD
    P4E1["П4 ВХОД: Начало этапа теста хука claude с правилом правки для рельсов"]
    P4R1["П4 ПРАВИЛО: Править можно только внутри рабочей области теста хука claude"]
    P4S1["П4 ШАГ: Внести правку рабочего файла теста хука claude и продолжить"]
    P4E1 --> P4R1
    P4R1 --> P4S1
    P4S1 --> P5E1

    P5E1["П5 ВХОД: Переход к финальному этапу теста хука claude процедуры здесь"]
    P5S1["П5 ШАГ: Завершить работу и подготовить финальный ответ агента здесь"]
    P5E1 --> P5S1
\`\`\`
`;

const STAGE_RAILS_YAML = [
  'version: 1',
  'skill: hookteststage',
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

test('PreToolUse(edit) -> PostToolUse -> PreToolUse(edit): с max_per_session=2 второй Pre разрешён, denial нет, counters=1 после первого цикла', () => {
  const base = mkdtempSync(join(tmpdir(), 'rails-hook-post-'));
  try {
    const root = join(base, 'root');
    const skillDir = join(root, '.workflow', 'src', 'skills', 'hookteststage');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), STAGE_SKILL_MD, 'utf8');
    writeFileSync(join(skillDir, 'rails.yaml'), STAGE_RAILS_YAML, 'utf8');
    mkdirSync(join(root, '.workflow', 'work'), { recursive: true });

    const sessionId = uuid();
    const state = startState({ root, sessionId, skill: 'hookteststage', entry: 'P4E1' });
    state.node = 'P4S1';
    saveState(root, state);

    const target = join(root, '.workflow', 'work', 'file.txt');
    const preInput = {
      hook_event_name: 'PreToolUse',
      session_id: sessionId,
      cwd: root,
      tool_name: 'Edit',
      tool_input: { file_path: target },
    };
    const postInput = { ...preInput, hook_event_name: 'PostToolUse' };

    const pre1 = handleHookInput(preInput, {});
    assert.equal(pre1, null); // allow без hookSpecificOutput.permissionDecision:"deny"

    handleHookInput(postInput, {});

    const afterFirstCycle = loadState(root, sessionId);
    assert.equal(afterFirstCycle.counters['action:do_edit'], 1, 'Post не должен был потратить потолок второй раз');

    const pre2 = handleHookInput(preInput, {});
    assert.equal(pre2, null, 'второй Pre обязан быть разрешён при max_per_session=2');

    const finalState = loadState(root, sessionId);
    assert.equal(finalState.counters['action:do_edit'], 2);

    const entries = readJournal(root, {});
    const denials = entries.filter((e) => e.type === 'denial' && e.session === sessionId);
    assert.equal(denials.length, 0, 'ни одного реального отказа в этой последовательности быть не должно');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('PostToolUse: без активного состояния -> null (тихо, без ошибки)', () => {
  withProject(({ root }) => {
    const r = handleHookInput(
      { hook_event_name: 'PostToolUse', session_id: uuid(), cwd: root, tool_name: 'Read', tool_input: {} },
      {}
    );
    assert.equal(r, null);
  });
});

// --- minor-фикс: необработанное исключение -> null + запись type:"error" в журнал ---

test('handleHookInput: необработанное исключение вне decide() -> null, но пишет type:"error" в журнал', () => {
  withProject(({ root }) => {
    const sessionId = uuid();
    const input = { cwd: root, session_id: sessionId };
    Object.defineProperty(input, 'hook_event_name', {
      get() {
        throw new Error('искусственный сбой для теста outer-catch');
      },
      enumerable: true,
    });

    const r = handleHookInput(input, {});
    assert.equal(r, null);

    const entries = readJournal(root, {});
    const errorEntries = entries.filter((e) => e.type === 'error' && e.session === sessionId);
    assert.equal(errorEntries.length, 1);
    assert.match(errorEntries[0].message, /искусственный сбой/);
  });
});

// --- Stop ------------------------------------------------------------------------------

test('Stop: stop_hook_active=true -> null, не блокирует', () => {
  withProject(({ root, base }) => {
    const sessionId = makeState(root, 'P5S1');
    const transcriptPath = writeTranscript(base, [
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'что угодно' }] } },
    ]);
    const r = handleHookInput(
      {
        hook_event_name: 'Stop',
        session_id: sessionId,
        cwd: root,
        transcript_path: transcriptPath,
        stop_hook_active: true,
      },
      {}
    );
    assert.equal(r, null);
  });
});

test('Stop: финальный ответ соответствует output.final_requires и находится в terminal -> null', () => {
  withProject(({ root, base }) => {
    const sessionId = makeState(root, 'P5S1'); // terminal-узел
    const transcriptPath = writeTranscript(base, [
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Готово. RAILS: P5S1 завершено.' }] } },
    ]);
    const r = handleHookInput(
      { hook_event_name: 'Stop', session_id: sessionId, cwd: root, transcript_path: transcriptPath },
      {}
    );
    assert.equal(r, null);
  });
});

test('Stop: нарушение -> block, счётчик stop_blocks растёт, после исчерпания max_stop_blocks -> null', () => {
  withProject(({ root, base }) => {
    const sessionId = makeState(root, 'P4S1'); // не terminal и без нужного текста
    const transcriptPath = writeTranscript(base, [
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'ничего не подготовлено' }] } },
    ]);
    const input = { hook_event_name: 'Stop', session_id: sessionId, cwd: root, transcript_path: transcriptPath };

    const r1 = handleHookInput(input, {});
    assert.equal(r1.decision, 'block');
    assert.match(r1.reason, /output/);

    const r2 = handleHookInput(input, {});
    assert.equal(r2.decision, 'block');

    // max_stop_blocks: 2 — третье нарушение подряд больше не блокирует.
    const r3 = handleHookInput(input, {});
    assert.equal(r3, null);

    const state = loadState(root, sessionId);
    assert.equal(state.counters['stop_blocks:P4S1'], 2);

    const entries = readJournal(root, {});
    const stopBlocks = entries.filter((e) => e.type === 'stop_block' && e.session === sessionId);
    assert.equal(stopBlocks.length, 3);
    assert.equal(stopBlocks[0].exhausted, false);
    assert.equal(stopBlocks[2].exhausted, true);
  });
});

test('Stop: без активной сессии/состояния -> null', () => {
  withProject(({ root, base }) => {
    const transcriptPath = writeTranscript(base, [
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'x' }] } },
    ]);
    const r = handleHookInput(
      { hook_event_name: 'Stop', session_id: uuid(), cwd: root, transcript_path: transcriptPath },
      {}
    );
    assert.equal(r, null);
  });
});

// --- UserPromptSubmit ------------------------------------------------------------------

test('UserPromptSubmit: маркер коррекции ("нет, ...") -> additionalContext + flags.correction_pending', () => {
  withProject(({ root }) => {
    const sessionId = makeState(root, 'P4S1');
    const r = handleHookInput(
      { hook_event_name: 'UserPromptSubmit', session_id: sessionId, cwd: root, prompt: 'нет, это не то' },
      {}
    );
    assert.match(r.hookSpecificOutput.additionalContext, /ГЛАВНЫМ ПРАВИЛОМ/);
    assert.match(r.hookSpecificOutput.additionalContext, /P4S1/);

    const state = loadState(root, sessionId);
    assert.equal(state.flags.correction_pending, true);
  });
});

test('UserPromptSubmit: без маркеров коррекции -> null', () => {
  withProject(({ root }) => {
    const sessionId = makeState(root, 'P4S1');
    const r = handleHookInput(
      { hook_event_name: 'UserPromptSubmit', session_id: sessionId, cwd: root, prompt: 'продолжай, всё хорошо' },
      {}
    );
    assert.equal(r, null);
  });
});

test('UserPromptSubmit: "почему не" где-то в середине текста -> триггерит', () => {
  withProject(({ root }) => {
    const sessionId = makeState(root, 'P4S1');
    const r = handleHookInput(
      { hook_event_name: 'UserPromptSubmit', session_id: sessionId, cwd: root, prompt: 'а почему не сделал так?' },
      {}
    );
    assert.match(r.hookSpecificOutput.additionalContext, /ГЛАВНЫМ ПРАВИЛОМ/);
  });
});

// --- SessionStart --------------------------------------------------------------------

test('SessionStart: активное состояние -> additionalContext со скилом и узлом', () => {
  withProject(({ root }) => {
    const sessionId = makeState(root, 'P4S1');
    const r = handleHookInput({ hook_event_name: 'SessionStart', session_id: sessionId, cwd: root }, {});
    assert.match(r.hookSpecificOutput.additionalContext, /hooktest/);
    assert.match(r.hookSpecificOutput.additionalContext, /P4S1/);
  });
});

test('SessionStart: без состояния -> подсказка с session_id и командой start (агент обязан знать свою сессию)', () => {
  withProject(({ root }) => {
    const sessionId = uuid();
    const r = handleHookInput({ hook_event_name: 'SessionStart', session_id: sessionId, cwd: root }, {});
    const ctx = r.hookSpecificOutput.additionalContext;
    assert.match(ctx, new RegExp(sessionId));
    assert.match(ctx, /cli\.mjs start <skill> --session/);
  });
});

test('SessionStart: cwd вне проекта (зонтик) -> подсказка с session_id, не null', () => {
  const base = mkdtempSync(join(tmpdir(), 'rails-hook-umbrella-'));
  try {
    const sessionId = uuid();
    const r = handleHookInput({ hook_event_name: 'SessionStart', session_id: sessionId, cwd: base }, {});
    assert.match(r.hookSpecificOutput.additionalContext, new RegExp(sessionId));
    assert.match(r.hookSpecificOutput.additionalContext, /не найден/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// --- через child_process: настоящий процесс claude-hook.mjs (§9.1, §13) ------------

function runHookProcess(stdin, cwd) {
  try {
    const stdout = execFileSync('node', [HOOK_PATH], { cwd, input: stdin, encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

test('child_process: мусорный stdin -> код выхода 0, пустой stdout', () => {
  withProject(({ root }) => {
    const r = runHookProcess('это не json вовсе {{{', root);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), '');
  });
});

test('child_process: пустой stdin -> код выхода 0, пустой stdout', () => {
  withProject(({ root }) => {
    const r = runHookProcess('', root);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), '');
  });
});

test('child_process: PreToolUse-канарейка через настоящий stdin -> код выхода 0, ожидаемый JSON deny', () => {
  withProject(({ root }) => {
    const sessionId = makeState(root, 'P4S1');
    const input = JSON.stringify({
      hook_event_name: 'PreToolUse',
      session_id: sessionId,
      cwd: root,
      tool_name: 'Bash',
      tool_input: { command: 'echo RAILS_CANARY' },
    });
    const r = runHookProcess(input, root);
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /RAILS_CANARY/);
  });
});

// --- blocker-фикс: запуск через junction (продакшн-раскладка §2/§11) --------------
//
// В проекте `.workflow/src/rails` — junction на `~/.workflow/rails/` (init.mjs:352
// вызывает хук по этому пути). `import.meta.url` главного модуля Node реалпасит,
// а `process.argv[1]` оставляет путём через junction как он был передан — раньше
// (`import.meta.url === pathToFileURL(argv[1]).href`) это ломало isDirectRun(),
// main() не вызывался, и хук молчал даже на канарейку. Тест воспроизводит именно
// эту раскладку: junction на src/rails, запуск по пути ЧЕРЕЗ junction.

test('child_process: PreToolUse-канарейка через junction на src/rails (продакшн-раскладка) -> код выхода 0, JSON deny', () => {
  withProject(({ root, base }) => {
    const junctionRoot = mkdtempSync(join(tmpdir(), 'rails-hook-junction-'));
    const junctionDir = join(junctionRoot, 'rails');
    try {
      createJunction(RAILS_DIR, junctionDir);
      const hookPathViaJunction = join(junctionDir, 'claude-hook.mjs');

      const sessionId = makeState(root, 'P4S1');
      const input = JSON.stringify({
        hook_event_name: 'PreToolUse',
        session_id: sessionId,
        cwd: root,
        tool_name: 'Bash',
        tool_input: { command: 'echo RAILS_CANARY' },
      });
      let result;
      try {
        const stdout = execFileSync('node', [hookPathViaJunction], { cwd: root, input, encoding: 'utf8' });
        result = { code: 0, stdout };
      } catch (err) {
        result = { code: err.status ?? 1, stdout: err.stdout || '' };
      }
      assert.equal(result.code, 0);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /RAILS_CANARY/);
    } finally {
      rmSync(junctionRoot, { recursive: true, force: true });
    }
  });
});
