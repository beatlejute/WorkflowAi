import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { createHooks, WorkflowRails } from '../rails/kilo-plugin.mjs';
import { startState, saveState, loadState } from '../rails/state.mjs';
import { readJournal } from '../rails/journal.mjs';

// Плагин через decide() пишет память «сессия → корень» в <WORKFLOW_HOME>/state — изолируем.
process.env.WORKFLOW_HOME = mkdtempSync(join(tmpdir(), 'rails-test-home-'));
process.on('exit', () => rmSync(process.env.WORKFLOW_HOME, { recursive: true, force: true }));

const uuid = () => randomUUID();

// --- фикстура: та же форма, что в rails-core.test.mjs, скил "kilotest" -------
//
// Этап 4: P4E1(вход) -> P4R1(правило) -> P4S1(шаг, do_edit, max_per_session 1) -> P5E1
// Этап 5: P5E1(вход) -> P5S1(шаг, terminal)

const SKILL_MD = `# Фикстура kilo-plugin (skill=kilotest)

\`\`\`mermaid
graph TD
    P4E1["П4 ВХОД: Начало этапа теста плагина kilo для рельсов процедуры"]
    P4R1["П4 ПРАВИЛО: Править можно только внутри рабочей области теста kilo"]
    P4S1["П4 ШАГ: Внести правку рабочего файла теста kilo и продолжить дальше"]
    P4E1 --> P4R1
    P4R1 --> P4S1
    P4S1 --> P5E1

    P5E1["П5 ВХОД: Переход к финальному этапу теста плагина kilo процедуры"]
    P5S1["П5 ШАГ: Завершить работу и подготовить финальный ответ агента здесь"]
    P5E1 --> P5S1
\`\`\`
`;

const RAILS_YAML = [
  'version: 1',
  'skill: kilotest',
  'entry: P4E1',
  'terminal: [P5S1]',
  'pause_nodes: []',
  'quote_min: 25',
  'canary: "echo RAILS_CANARY"',
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
  '    max_per_session: 1',
  '',
  'output:',
  '  final_requires: []',
  '  max_stop_blocks: 2',
  '',
].join('\n');

// async, потому что все вызывающие тесты — асинхронные (await на хуках kilo);
// без await на fn() временный каталог удалялся бы (finally) раньше, чем
// завершится асинхронное тело теста.
async function withProject(fn) {
  const base = mkdtempSync(join(tmpdir(), 'rails-kilo-'));
  try {
    const root = join(base, 'root');
    const skillDir = join(root, '.workflow', 'src', 'skills', 'kilotest');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), SKILL_MD, 'utf8');
    writeFileSync(join(skillDir, 'rails.yaml'), RAILS_YAML, 'utf8');
    mkdirSync(join(root, '.workflow', 'work'), { recursive: true });
    return await fn({ root, skillDir });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function makeState(root, node) {
  const sessionId = uuid();
  const state = startState({ root, sessionId, skill: 'kilotest', entry: 'P4E1' });
  state.node = node;
  saveState(root, state);
  return sessionId;
}

// --- createHooks: форма ------------------------------------------------------------

test('createHooks: возвращает tool.execute.before и tool.execute.after', () => {
  const hooks = createHooks('/tmp/whatever', {});
  assert.equal(typeof hooks['tool.execute.before'], 'function');
  assert.equal(typeof hooks['tool.execute.after'], 'function');
});

// --- tool.execute.before: throw на deny -----------------------------------------------

test('tool.execute.before: канарейка -> throw с текстом отказа', async () => {
  await withProject(async ({ root }) => {
    const sessionID = makeState(root, 'P4S1');
    const hooks = createHooks(root, { WORKFLOW_RAILS_SESSION: undefined });
    const input = { tool: 'bash', sessionID, callID: 'c1' };
    const output = { args: { command: 'echo RAILS_CANARY' } };

    await assert.rejects(
      () => hooks['tool.execute.before'](input, output),
      (err) => {
        assert.match(err.message, /RAILS_CANARY/);
        return true;
      }
    );
  });
});

test('tool.execute.before: разрешённое действие -> не бросает', async () => {
  await withProject(async ({ root }) => {
    const sessionID = makeState(root, 'P5S1');
    const hooks = createHooks(root, {});
    const input = { tool: 'read', sessionID, callID: 'c1' };
    const output = { args: {} };
    await assert.doesNotReject(() => hooks['tool.execute.before'](input, output));
  });
});

test('tool.execute.before: инъекция --session мутирует output.args.command', async () => {
  await withProject(async ({ root }) => {
    const sessionID = makeState(root, 'P4S1');
    const hooks = createHooks(root, {});
    const input = { tool: 'bash', sessionID, callID: 'c1' };
    const output = { args: { command: 'node .workflow/src/rails/cli.mjs status' } };
    await hooks['tool.execute.before'](input, output);
    assert.equal(output.args.command, `node .workflow/src/rails/cli.mjs status --session ${sessionID}`);
  });
});

test('tool.execute.before: stage_actions max_per_session=1 -> второй edit бросает', async () => {
  await withProject(async ({ root }) => {
    const sessionID = makeState(root, 'P4S1');
    const hooks = createHooks(root, {});
    const target = join(root, '.workflow', 'work', 'file.txt');
    // Разные callID — разные вызовы (одинаковый callID core дедуплицирует как повтор хука).
    const output = { args: { filePath: target } };

    await assert.doesNotReject(() => hooks['tool.execute.before']({ tool: 'edit', sessionID, callID: 'c1' }, output));
    await assert.rejects(() => hooks['tool.execute.before']({ tool: 'edit', sessionID, callID: 'c2' }, output), /потолок действия/);
  });
});

// --- tool.execute.after: дописывает output.output -----------------------------------

test('tool.execute.after: дописывает "RAILS: числится ..." в output.output', async () => {
  await withProject(async ({ root }) => {
    const sessionID = makeState(root, 'P5S1');
    const hooks = createHooks(root, {});
    const input = { tool: 'read', sessionID, callID: 'c1' };
    const output = { output: 'исходный вывод инструмента', args: {} };
    await hooks['tool.execute.after'](input, output);
    assert.match(output.output, /^исходный вывод инструмента\n\nRAILS: числится P5S1 «/);
  });
});

test('tool.execute.after: output.output изначально отсутствует -> не падает', async () => {
  await withProject(async ({ root }) => {
    const sessionID = makeState(root, 'P5S1');
    const hooks = createHooks(root, {});
    const input = { tool: 'read', sessionID, callID: 'c1' };
    const output = { args: {} };
    await assert.doesNotReject(() => hooks['tool.execute.after'](input, output));
    assert.match(output.output, /^\n\nRAILS: числится/);
  });
});

// --- blocker-фикс: after не тратит потолок stage_actions.max_per_session -----------

test('before(edit) -> after -> before(edit): с max_per_session=2 второй before разрешён, denial нет, counters=1 после первого цикла', async () => {
  const base = mkdtempSync(join(tmpdir(), 'rails-kilo-post-'));
  try {
    const root = join(base, 'root');
    const skillDir = join(root, '.workflow', 'src', 'skills', 'kilotest2');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), SKILL_MD.replace(/kilotest/g, 'kilotest2'), 'utf8');
    writeFileSync(
      join(skillDir, 'rails.yaml'),
      RAILS_YAML.replace('skill: kilotest', 'skill: kilotest2').replace('max_per_session: 1', 'max_per_session: 2'),
      'utf8'
    );
    mkdirSync(join(root, '.workflow', 'work'), { recursive: true });

    const sessionID = uuid();
    const state = startState({ root, sessionId: sessionID, skill: 'kilotest2', entry: 'P4E1' });
    state.node = 'P4S1';
    saveState(root, state);

    const hooks = createHooks(root, {});
    const target = join(root, '.workflow', 'work', 'file.txt');
    const input = { tool: 'edit', sessionID, callID: 'c1' };
    const output = { args: { filePath: target }, output: '' };

    await hooks['tool.execute.before'](input, output);
    await hooks['tool.execute.after'](input, output);

    const afterFirstCycle = loadState(root, sessionID);
    assert.equal(afterFirstCycle.counters['action:do_edit'], 1, 'after не должен был потратить потолок второй раз');

    // Второй настоящий вызов — другой callID (одинаковый core считает повтором хука).
    await assert.doesNotReject(() => hooks['tool.execute.before']({ tool: 'edit', sessionID, callID: 'c2' }, output));

    const finalState = loadState(root, sessionID);
    assert.equal(finalState.counters['action:do_edit'], 2);

    const entries = readJournal(root, {});
    const denials = entries.filter((e) => e.type === 'denial' && e.session === sessionID);
    assert.equal(denials.length, 0, 'ни одного реального отказа в этой последовательности быть не должно');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('tool.execute.after: role=executor -> не пишет в output.output', async () => {
  await withProject(async ({ root }) => {
    const sessionID = makeState(root, 'P5S1');
    const hooks = createHooks(root, { WORKFLOW_RAILS_ROLE: 'executor' });
    const input = { tool: 'read', sessionID, callID: 'c1' };
    const output = { output: 'исходный вывод', args: {} };
    await hooks['tool.execute.after'](input, output);
    assert.equal(output.output, 'исходный вывод');
  });
});

// --- WorkflowRails: интерфейс плагина ------------------------------------------------

test('WorkflowRails: async-фабрика возвращает те же хуки, что createHooks', async () => {
  await withProject(async ({ root }) => {
    const hooks = await WorkflowRails({ directory: root });
    assert.equal(typeof hooks['tool.execute.before'], 'function');
    assert.equal(typeof hooks['tool.execute.after'], 'function');
  });
});
