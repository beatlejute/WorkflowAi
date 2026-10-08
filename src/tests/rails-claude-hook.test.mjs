import { test, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { handleHookInput, main } from '../rails/claude-hook.mjs';
import { StateError, startState, saveState, loadState } from '../rails/state.mjs';
import { readJournal } from '../rails/journal.mjs';
import { createJunction } from '../junction-manager.mjs';
import { pathToFileURL } from 'node:url';

const fsReadFileSync = fs.readFileSync;

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

// Transcript сессии: имя — <sessionId>.jsonl и sessionId в каждой записи, как
// у настоящего Claude Code (stop-хук проверяет принадлежность transcript
// сессии, 2026-10-06).
function writeTranscript(base, sessionId, entries) {
  const p = join(base, `${sessionId}.jsonl`);
  writeFileSync(p, entries.map((e) => JSON.stringify({ sessionId, ...e })).join('\n') + '\n', 'utf8');
  return p;
}

function withLifecycleReadFailure(lockFile, failAt, fn) {
  let reads = 0;
  const probe = mock.method(fs, 'readFileSync', (path, ...args) => {
    if (String(path) === lockFile && ++reads === failAt) throw new Error('клейм не читается');
    return fsReadFileSync(path, ...args);
  });
  syncBuiltinESMExports();
  try {
    return fn(() => reads);
  } finally {
    probe.mock.restore();
    syncBuiltinESMExports();
  }
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

// ЗАДАЧА B, 2026-09-22: --quote с бэктиками в двойных кавычках — переписывание в
// одинарные (core.mjs) должно дойти до updatedInput.command так же, как инъекция
// --session (тот же result.updatedCommand, тот же путь передачи).
test('PreToolUse: --quote с бэктиками в двойных кавычках -> updatedInput.command переписан в одинарные + --session', () => {
  withProject(({ root }) => {
    const sessionId = makeState(root, 'P4S1');
    const rawQuote = 'из `.workflow/reports/`, оценку записать в план текущего этапа';
    const r = handleHookInput(
      {
        hook_event_name: 'PreToolUse',
        session_id: sessionId,
        cwd: root,
        tool_name: 'Bash',
        tool_input: { command: `node .workflow/src/rails/cli.mjs goto P5E1 --quote "${rawQuote}"` },
      },
      {}
    );
    assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
    assert.equal(
      r.hookSpecificOutput.updatedInput.command,
      `node .workflow/src/rails/cli.mjs goto P5E1 --quote '${rawQuote}' --session ${sessionId}`
    );
  });
});

// ЗАДАЧА B2 (2026-09-22, ревью HIGH): `--quote '…'` с вложенным `--quote "$(…)"` внутри
// одинарных кавычек — это текст цитаты; первая версия переписывала его и отдавала shell'у
// $(…). Через адаптер updatedInput.command должен получить только --session.
test('PreToolUse: --quote \'…\' с вложенным --quote "$(touch PWNED)" -> updatedInput.command не переписан (только --session)', () => {
  withProject(({ root }) => {
    const sessionId = makeState(root, 'P4S1');
    const command = `node .workflow/src/rails/cli.mjs goto P5E1 --quote 'x --quote "$(touch PWNED) y"'`;
    const r = handleHookInput(
      { hook_event_name: 'PreToolUse', session_id: sessionId, cwd: root, tool_name: 'Bash', tool_input: { command } },
      {}
    );
    assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
    assert.equal(r.hookSpecificOutput.updatedInput.command, `${command} --session ${sessionId}`);
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

test('handleHookInput: StateError maps to PreToolUse deny and Stop block', () => {
  for (const event of ['PreToolUse', 'Stop']) {
    const input = { hook_event_name: event };
    Object.defineProperty(input, 'session_id', {
      get() { throw new StateError('состояние повреждено'); },
    });
    const result = handleHookInput(input, {});
    if (event === 'PreToolUse') {
      assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(result.hookSpecificOutput.permissionDecisionReason, /состояние повреждено/);
    } else {
      assert.equal(result.decision, 'block');
      assert.match(result.reason, /состояние повреждено/);
    }
  }
});

test('handleHookInput: сбой stderr и отсутствие корня не выбрасывают исключение', () => {
  const base = mkdtempSync(join(tmpdir(), 'rails-hook-no-root-'));
  const probe = mock.method(process.stderr, 'write', () => { throw new Error('stderr недоступен'); });
  try {
    const input = { cwd: base };
    Object.defineProperty(input, 'hook_event_name', {
      get() { throw new Error('поле события недоступно'); },
    });
    assert.equal(handleHookInput(input, {}), null);
  } finally {
    probe.mock.restore();
    rmSync(base, { recursive: true, force: true });
  }
});

test('Stop: если проектный корень пропал перед обработкой под замком, остановка безопасно пропускается', () => {
  withProject(({ root, base }) => {
    const sessionId = makeState(root, 'P4S1');
    let cwdReads = 0;
    const input = { hook_event_name: 'Stop', session_id: sessionId };
    Object.defineProperty(input, 'cwd', {
      get() { cwdReads += 1; return cwdReads === 1 ? root : base; },
    });
    assert.equal(handleHookInput(input, {}), null);
    assert.equal(cwdReads, 2);
    assert.equal(loadState(root, sessionId).counters['stop_blocks:P4S1'], undefined);
  });
});

// --- Stop ------------------------------------------------------------------------------

// Прогон PulseProxy 2026-09-27: хук пропускал любую остановку со stop_hook_active=true —
// Claude Code ставит его на остановке сразу после блока, и max_stop_blocks: 2 работал как 1.
test('Stop: stop_hook_active=true не снимает блок — max_stop_blocks: 2 даёт два блока подряд, третья остановка проходит', () => {
  withProject(({ root, base }) => {
    const sessionId = makeState(root, 'P4S1'); // не terminal
    const transcriptPath = writeTranscript(base, sessionId, [
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'ничего не подготовлено' }] } },
    ]);
    const input = { hook_event_name: 'Stop', session_id: sessionId, cwd: root, transcript_path: transcriptPath };

    assert.equal(handleHookInput(input, {}).decision, 'block');
    // Остановка сразу после блока — как её присылает Claude Code.
    assert.equal(handleHookInput({ ...input, stop_hook_active: true }, {}).decision, 'block');
    assert.equal(handleHookInput({ ...input, stop_hook_active: true }, {}), null);

    assert.equal(loadState(root, sessionId).counters['stop_blocks:P4S1'], 2);
    const stopBlocks = readJournal(root, {}).filter((e) => e.type === 'stop_block' && e.session === sessionId);
    assert.deepEqual(stopBlocks.map((e) => e.exhausted), [false, false, true]);
  });
});

test('Stop: stop_hook_active=true и ответ по rails.yaml в terminal -> null', () => {
  withProject(({ root, base }) => {
    const sessionId = makeState(root, 'P5S1');
    const transcriptPath = writeTranscript(base, sessionId, [
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Готово. RAILS: P5S1 завершено.' }] } },
    ]);
    const r = handleHookInput(
      { hook_event_name: 'Stop', session_id: sessionId, cwd: root, transcript_path: transcriptPath, stop_hook_active: true },
      {}
    );
    assert.equal(r, null);
    assert.equal(readJournal(root, {}).filter((e) => e.type === 'stop_block').length, 0);
  });
});

// Потолок — на узел: после перехода в другой нетерминальный узел агента снова возвращают,
// а исчерпанный узел при повторном заходе не блокирует (счётчик не обнуляется), поэтому
// блоков за жизнь состояния не больше max_stop_blocks × число узлов.
test('Stop: счётчик блоков по узлу — новый узел даёт новые блоки, исчерпанный узел при возврате пропускает', () => {
  withProject(({ root, base }) => {
    const sessionId = makeState(root, 'P4S1');
    const transcriptPath = writeTranscript(base, sessionId, [
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'ничего не подготовлено' }] } },
    ]);
    const input = { hook_event_name: 'Stop', session_id: sessionId, cwd: root, transcript_path: transcriptPath, stop_hook_active: true };
    const moveTo = (node) => {
      const s = loadState(root, sessionId);
      s.node = node;
      saveState(root, s);
    };

    assert.equal(handleHookInput(input, {}).decision, 'block');
    assert.equal(handleHookInput(input, {}).decision, 'block');
    assert.equal(handleHookInput(input, {}), null);

    moveTo('P5E1');
    assert.equal(handleHookInput(input, {}).decision, 'block');

    moveTo('P4S1');
    assert.equal(handleHookInput(input, {}), null);

    const counters = loadState(root, sessionId).counters;
    assert.equal(counters['stop_blocks:P4S1'], 2);
    assert.equal(counters['stop_blocks:P5E1'], 1);
  });
});

test('Stop: сбой чтения замка оставляет completion до следующей остановки', () => {
  withProject(({ root, base }) => {
    const sessionId = makeState(root, 'P5S1');
    const transcriptPath = writeTranscript(base, sessionId, [
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'RAILS: P5S1 завершено.' }] } },
    ]);
    const input = { hook_event_name: 'Stop', session_id: sessionId, cwd: root, transcript_path: transcriptPath };
    assert.equal(handleHookInput(input, {}), null);
    assert.ok(loadState(root, sessionId).completion);

    writeTranscript(base, sessionId, [
      { type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'новый, непроходной ответ' }] } },
    ]);
    const lockFile = join(root, '.workflow', 'state', 'rails', `.exit-lock-${sessionId}`);
    withLifecycleReadFailure(lockFile, 2, (readCount) => {
      const failed = handleHookInput(input, {});
      assert.equal(readCount(), 3);
      assert.equal(failed.decision, 'block');
      assert.match(failed.reason, /подтверждение(?: завершения)? не снято и след не записан/);
      assert.ok(loadState(root, sessionId).completion);
    });

    assert.equal(handleHookInput(input, {}).decision, 'block');
    assert.equal(loadState(root, sessionId).completion, undefined);
  });
});

test('Stop: invalidation failure after denied handoff blocks completion removal', () => {
  withProject(({ root, skillDir, base }) => {
    const yaml = RAILS_YAML.replace('terminal: [P5S1]', 'terminal: [P4S1]').replace('output:', [
      'handoff:',
      '  nodes: [P4S1]',
      '  requires: ["REQUEST: ", "REASON: ", "DONE: ", "REMAINING: "]',
      '  forbids: ["verdict = pass"]',
      '',
      'output:',
    ].join('\n'));
    writeFileSync(join(skillDir, 'rails.yaml'), yaml, 'utf8');
    const sessionId = makeState(root, 'P4S1');
    const transcriptPath = writeTranscript(base, sessionId, [
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Готово. RAILS: P4S1 завершено.' }] } },
    ]);
    const input = { hook_event_name: 'Stop', session_id: sessionId, cwd: root, transcript_path: transcriptPath };
    assert.equal(handleHookInput(input, {}), null);
    assert.ok(loadState(root, sessionId).completion);

    writeTranscript(base, sessionId, [
      { type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: [
        'RAILS_OUTCOME: out_of_scope', 'REQUEST: исходный запрос', 'REASON: вне компетенции',
        'DONE: проверена область', 'REMAINING: работа не выполнена',
      ].join('\n') }] } },
    ]);
    const lockFile = join(root, '.workflow', 'state', 'rails', `.exit-lock-${sessionId}`);
    withLifecycleReadFailure(lockFile, 3, (readCount) => {
      const blocked = handleHookInput(input, {});
      assert.equal(readCount(), 4);
      assert.equal(blocked.decision, 'block');
      assert.match(blocked.reason, /подтверждение не снято и след не записан/);
      assert.ok(loadState(root, sessionId).completion);
    });
  });
});

test('Stop: приостановка блокирует остановку, если completion нельзя снять', () => {
  withProject(({ root, base }) => {
    const sessionId = makeState(root, 'P5S1');
    const transcriptPath = writeTranscript(base, sessionId, [
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'RAILS: P5S1 завершено.' }] } },
    ]);
    const input = { hook_event_name: 'Stop', session_id: sessionId, cwd: root, transcript_path: transcriptPath };
    assert.equal(handleHookInput(input, {}), null);
    assert.ok(loadState(root, sessionId).completion);

    writeTranscript(base, sessionId, [
      { type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: [
        'RAILS_OUTCOME: blocked', 'ACTION: дождаться владельца', 'REASON: нужно подтверждение',
        'DONE: риск объяснён', 'REMAINING: решение владельца',
      ].join('\n') }] } },
    ]);
    const lockFile = join(root, '.workflow', 'state', 'rails', `.exit-lock-${sessionId}`);
    withLifecycleReadFailure(lockFile, 2, () => {
      const result = handleHookInput(input, {});
      assert.equal(result.decision, 'block');
      assert.match(result.reason, /подтверждение завершения не снято и след не записан/);
      assert.ok(loadState(root, sessionId).completion);
    });
  });
});

test('Stop: invalidateCompletion errors are swallowed for suspension and rejected output', () => {
  for (const response of [
    ['RAILS_OUTCOME: blocked', 'ACTION: дождаться владельца', 'REASON: нужно подтверждение',
      'DONE: риск объяснён', 'REMAINING: решение владельца'].join('\n'),
    'новый, непроходной ответ',
  ]) {
    withProject(({ root, base }) => {
      const sessionId = makeState(root, 'P5S1');
      const transcriptPath = writeTranscript(base, sessionId, [
        { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'RAILS: P5S1 завершено.' }] } },
      ]);
      const initial = { hook_event_name: 'Stop', session_id: sessionId, cwd: root, transcript_path: transcriptPath };
      assert.equal(handleHookInput(initial, {}), null);
      assert.ok(loadState(root, sessionId).completion);
      writeTranscript(base, sessionId, [
        { type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: response }] } },
      ]);

      let probe;
      let failed = false;
      const originalRealpath = fs.realpathSync.native;
      const input = { hook_event_name: 'Stop', session_id: sessionId, cwd: root };
      Object.defineProperty(input, 'transcript_path', {
        get() {
          if (!probe) {
            probe = mock.method(fs.realpathSync, 'native', (path, ...args) => {
              if (!failed && String(path) === root) {
                failed = true;
                throw new Error('корень временно недоступен');
              }
              return originalRealpath(path, ...args);
            });
            syncBuiltinESMExports();
          }
          return transcriptPath;
        },
      });
      try {
        const result = handleHookInput(input, {});
        assert.equal(failed, true);
        assert.ok(loadState(root, sessionId).completion);
        if (response.startsWith('RAILS_OUTCOME:')) assert.equal(result, null);
        else assert.equal(result.decision, 'block');
      } finally {
        probe?.mock.restore();
        syncBuiltinESMExports();
      }
    });
  }
});

test('Stop: max_stop_blocks: 0 -> нарушение не блокирует ни разу, но пишется в журнал', () => {
  withProject(({ root, base, skillDir }) => {
    writeFileSync(join(skillDir, 'rails.yaml'), RAILS_YAML.replace('max_stop_blocks: 2', 'max_stop_blocks: 0'), 'utf8');
    const sessionId = makeState(root, 'P4S1');
    const transcriptPath = writeTranscript(base, sessionId, [
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'ничего не подготовлено' }] } },
    ]);
    const r = handleHookInput(
      { hook_event_name: 'Stop', session_id: sessionId, cwd: root, transcript_path: transcriptPath },
      {}
    );
    assert.equal(r, null);
    const stopBlocks = readJournal(root, {}).filter((e) => e.type === 'stop_block' && e.session === sessionId);
    assert.deepEqual(stopBlocks.map((e) => e.exhausted), [true]);
  });
});

test('Stop: финальный ответ соответствует output.final_requires и находится в terminal -> null', () => {
  withProject(({ root, base }) => {
    const sessionId = makeState(root, 'P5S1'); // terminal-узел
    const transcriptPath = writeTranscript(base, sessionId, [
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
    const transcriptPath = writeTranscript(base, sessionId, [
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
    const stranger = uuid();
    const transcriptPath = writeTranscript(base, stranger, [
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'x' }] } },
    ]);
    const r = handleHookInput(
      { hook_event_name: 'Stop', session_id: stranger, cwd: root, transcript_path: transcriptPath },
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

// Прогон PulseProxy 2026-09-27: подсказка «start <skill>» в стадии execute-task, и агент
// стартовал скил из подсказки роли. При заданном скиле запуска подсказка называет его.
test('SessionStart: без состояния, задан WORKFLOW_RAILS_SKILL -> подсказка называет скил запуска и его вход, состояние не создаётся', () => {
  withProject(({ root }) => {
    const sessionId = uuid();
    const r = handleHookInput(
      { hook_event_name: 'SessionStart', session_id: sessionId, cwd: root },
      { WORKFLOW_RAILS_SKILL: 'hooktest', WORKFLOW_RAILS_ROLE: 'coordinator' }
    );
    const ctx = r.hookSpecificOutput.additionalContext;
    assert.match(ctx, new RegExp(sessionId));
    assert.match(ctx, /скил этого запуска — hooktest/);
    assert.match(ctx, /P4E1 «П4 ВХОД/);
    assert.match(ctx, /Другой скил в этом запуске не стартует/);
    assert.doesNotMatch(ctx, /<skill>/);
    // Имя переменной окружения агенту не называется: незачем знать, что подменять в команде.
    assert.doesNotMatch(ctx, /WORKFLOW_RAILS/);
    // Состояние по-прежнему создаёт первое действие: по его наличию раннер отличает
    // агента, не вызвавшего ни одного инструмента под рельсами.
    assert.equal(loadState(root, sessionId), null);
  });
});

test('SessionStart: WORKFLOW_RAILS_SKILL у исполнителя или у скила без rails.yaml -> общая подсказка «start <skill>»', () => {
  withProject(({ root }) => {
    const sessionId = uuid();
    const executor = handleHookInput(
      { hook_event_name: 'SessionStart', session_id: sessionId, cwd: root },
      { WORKFLOW_RAILS_SKILL: 'hooktest', WORKFLOW_RAILS_ROLE: 'executor' }
    );
    assert.match(executor.hookSpecificOutput.additionalContext, /cli\.mjs start <skill> --session/);

    mkdirSync(join(root, '.workflow', 'src', 'skills', 'norails'), { recursive: true });
    const noRails = handleHookInput(
      { hook_event_name: 'SessionStart', session_id: sessionId, cwd: root },
      { WORKFLOW_RAILS_SKILL: 'norails' }
    );
    assert.match(noRails.hookSpecificOutput.additionalContext, /cli\.mjs start <skill> --session/);
  });
});

test('SessionStart: зонтик и задан WORKFLOW_RAILS_SKILL -> команда старта скила запуска', () => {
  const base = mkdtempSync(join(tmpdir(), 'rails-hook-umbrella-'));
  try {
    const sessionId = uuid();
    const r = handleHookInput(
      { hook_event_name: 'SessionStart', session_id: sessionId, cwd: base },
      { WORKFLOW_RAILS_SKILL: 'hooktest' }
    );
    assert.match(r.hookSpecificOutput.additionalContext, new RegExp(`cli\\.mjs start hooktest --session ${sessionId}`));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
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

test('main: readStdin resolves empty input when stdin setup fails', async () => {
  const exitCode = process.exitCode;
  const probe = mock.method(process.stdin, 'setEncoding', () => { throw new Error('stdin закрыт'); });
  try {
    await main();
    assert.equal(process.exitCode, 0);
  } finally {
    probe.mock.restore();
    process.exitCode = exitCode;
  }
});

test('main: catches synchronous readStdin construction failure', async () => {
  const exitCode = process.exitCode;
  const OriginalPromise = globalThis.Promise;
  let pending;
  try {
    globalThis.Promise = class { constructor() { throw new Error('promise creation failed'); } };
    pending = main();
  } finally {
    globalThis.Promise = OriginalPromise;
  }
  try {
    await pending;
    assert.equal(process.exitCode, 0);
  } finally {
    process.exitCode = exitCode;
  }
});

test('main: stdout write failure is ignored and the hook exits successfully', async () => {
  const base = mkdtempSync(join(tmpdir(), 'rails-main-stdout-'));
  const exitCode = process.exitCode;
  const output = [];
  const encoding = mock.method(process.stdin, 'setEncoding', () => process.stdin);
  const events = mock.method(process.stdin, 'on', (event, listener) => {
    if (event === 'data') listener(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'нет', cwd: base }));
    if (event === 'end') listener();
    return process.stdin;
  });
  const write = mock.method(process.stdout, 'write', (chunk) => {
    output.push(String(chunk));
    throw new Error('stdout закрыт');
  });
  try {
    await main();
    assert.equal(process.exitCode, 0);
    assert.equal(output.length, 1);
    assert.match(output[0], /UserPromptSubmit/);
  } finally {
    write.mock.restore();
    events.mock.restore();
    encoding.mock.restore();
    process.exitCode = exitCode;
    rmSync(base, { recursive: true, force: true });
  }
});

test('isDirectRun: failed realpath does not start the hook', () => {
  const script = [
    "import fs from 'node:fs';",
    "import { mock } from 'node:test';",
    `const probe = mock.method(fs.realpathSync, 'native', () => { throw new Error('realpath unavailable'); });`,
    `process.argv[1] = ${JSON.stringify(HOOK_PATH)};`,
    `await import(${JSON.stringify(pathToFileURL(HOOK_PATH).href)});`,
    'probe.mock.restore();',
  ].join('\n');
  const stdout = execFileSync('node', ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(stdout, '');
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

test('unknown hook events are ignored', () => {
  withProject(({ root }) => {
    assert.equal(handleHookInput({ hook_event_name: 'PostToolUse', cwd: root }, {}), null);
  });
});

test('child_process: SessionStart emits the active session context', () => {
  withProject(({ root }) => {
    const sessionId = makeState(root, 'P4S1');
    const input = JSON.stringify({ hook_event_name: 'SessionStart', session_id: sessionId, cwd: root });
    const result = runHookProcess(input, root);
    assert.equal(result.code, 0);
    assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /hooktest/);
  });
});

test('child_process: unknown event produces no output', () => {
  withProject(({ root }) => {
    const input = JSON.stringify({ hook_event_name: 'PostToolUse', session_id: uuid(), cwd: root });
    const result = runHookProcess(input, root);
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), '');
  });
});
