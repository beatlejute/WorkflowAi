import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { createPiHooks } from '../rails/pi-extension.mjs';
import { fromPi } from '../rails/actions.mjs';
import { startState, saveState } from '../rails/state.mjs';

// decide() пишет память «сессия → корень» в <WORKFLOW_HOME>/state — изолируем.
process.env.WORKFLOW_HOME = mkdtempSync(join(tmpdir(), 'rails-pi-test-home-'));
process.on('exit', () => rmSync(process.env.WORKFLOW_HOME, { recursive: true, force: true }));

const uuid = () => randomUUID();

// --- фикстура: то же дерево и скил, что в rails-kilo-plugin.test.mjs -------------
const SKILL_MD = `# Фикстура pi-extension (skill=pites тест)

\`\`\`mermaid
graph TD
    P4E1["П4 ВХОД: Начало этапа теста расширения pi для рельсов процедуры"]
    P4R1["П4 ПРАВИЛО: Править можно только внутри рабочей области теста pi"]
    P4S1["П4 ШАГ: Внести правку рабочего файла теста pi и продолжить дальше"]
    P4E1 --> P4R1
    P4R1 --> P4S1
    P4S1 --> P5E1

    P5E1["П5 ВХОД: Переход к финальному этапу теста расширения pi процедуры"]
    P5S1["П5 ШАГ: Завершить работу и подготовить финальный ответ агента здесь"]
    P5E1 --> P5S1
\`\`\`
`;

const RAILS_YAML = [
  'version: 1',
  'skill: pites тест',
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

async function withProject(fn) {
  const base = mkdtempSync(join(tmpdir(), 'rails-pi-'));
  try {
    const root = join(base, 'root');
    const skillDir = join(root, '.workflow', 'src', 'skills', 'pites тест');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), SKILL_MD, 'utf8');
    writeFileSync(join(skillDir, 'rails.yaml'), RAILS_YAML, 'utf8');
    mkdirSync(join(root, '.workflow', 'work'), { recursive: true });
    return await fn({ root });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function makeState(root, node) {
  const sessionId = uuid();
  const state = startState({ root, sessionId, skill: 'pites тест', entry: 'P4E1' });
  state.node = node;
  saveState(root, state);
  return sessionId;
}

/** Контекст pi: рабочий каталог сессии и идентификатор из менеджера сессий. */
function piCtx(root, sessionId) {
  return { cwd: root, sessionManager: { getSessionId: () => sessionId } };
}

const call = (name, root, extra = {}) => ({ toolName: name, toolCallId: 'c1', input: {}, ...extra });

// --- форма ----------------------------------------------------------------------

test('createPiHooks: возвращает tool_call и tool_result', () => {
  const hooks = createPiHooks({});
  assert.equal(typeof hooks.tool_call, 'function');
  assert.equal(typeof hooks.tool_result, 'function');
});

// --- fromPi: имена и поля инструментов pi -----------------------------------------

test('fromPi: оболочка, файлы, чтение, MCP и неизвестный инструмент', () => {
  assert.deepEqual(fromPi(call('bash', null, { input: { command: 'ls' } })),
    { tool: 'bash', kind: 'shell', command: 'ls', shell: 'posix' });
  assert.deepEqual(fromPi(call('powershell', null, { input: { command: 'Get-ChildItem' } })),
    { tool: 'powershell', kind: 'shell', command: 'Get-ChildItem', shell: 'powershell' });
  assert.deepEqual(fromPi(call('edit', null, { input: { path: 'a.txt', edits: [{ oldText: 'a', newText: 'b' }] } })),
    { tool: 'edit', kind: 'edit', path: 'a.txt' });
  assert.deepEqual(fromPi(call('write', null, { input: { path: 'b.txt', content: 'x' } })),
    { tool: 'write', kind: 'write', path: 'b.txt' });
  for (const name of ['read', 'grep', 'find', 'ls']) {
    assert.equal(fromPi(call(name, null)).kind, 'read', name);
  }
  assert.deepEqual(fromPi(call('mcp__pw__click', null)),
    { tool: 'mcp__pw__click', kind: 'mcp', server: 'pw', mcpTool: 'click' });
  assert.equal(fromPi(call('some_custom_tool', null)).kind, 'other');
});

// --- tool_call: отказ, разрешение, правка команды ----------------------------------

test('tool_call: канарейка -> блок с текстом отказа модель получит', async () => {
  await withProject(async ({ root }) => {
    const sessionId = makeState(root, 'P4S1');
    const hooks = createPiHooks({});
    const event = call('bash', root, { input: { command: 'echo RAILS_CANARY' } });

    const result = await hooks.tool_call(event, piCtx(root, sessionId));
    assert.equal(result.block, true);
    assert.match(result.reason, /RAILS_CANARY/);
  });
});

test('tool_call: разрешённое действие -> блок не выставлен', async () => {
  await withProject(async ({ root }) => {
    const sessionId = makeState(root, 'P5S1');
    const hooks = createPiHooks({});
    const event = call('read', root, { input: { path: '.workflow/work/a.txt' } });

    assert.equal(await hooks.tool_call(event, piCtx(root, sessionId)), undefined);
  });
});

test('tool_call: правка вне области записи отклонена (поле path, а не file_path)', async () => {
  await withProject(async ({ root }) => {
    const sessionId = makeState(root, 'P4S1');
    const hooks = createPiHooks({});
    const event = call('edit', root, { input: { path: 'outside.txt', edits: [] } });

    const result = await hooks.tool_call(event, piCtx(root, sessionId));
    assert.equal(result.block, true);
  });
});

test('tool_call: pi-инструмент write с полем path виден защите (не уходит в other)', async () => {
  await withProject(async ({ root }) => {
    const sessionId = makeState(root, 'P4S1');
    const hooks = createPiHooks({});
    const event = call('write', root, { input: { path: 'outside.txt', content: 'x' } });

    const result = await hooks.tool_call(event, piCtx(root, sessionId));
    assert.equal(result.block, true);
  });
});

test('tool_call: вне проекта с .workflow/ расширение молчит', async () => {
  const base = mkdtempSync(join(tmpdir(), 'rails-pi-plain-'));
  try {
    const hooks = createPiHooks({});
    const event = call('bash', base, { input: { command: 'echo RAILS_CANARY' } });
    assert.equal(await hooks.tool_call(event, piCtx(base, uuid())), undefined);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('tool_call: инъекция --session правит event.input.command', async () => {
  await withProject(async ({ root }) => {
    const sessionId = makeState(root, 'P4S1');
    const hooks = createPiHooks({});
    const event = call('bash', root, { input: { command: 'node .workflow/src/rails/cli.mjs status' } });

    await hooks.tool_call(event, piCtx(root, sessionId));
    assert.equal(event.input.command, `node .workflow/src/rails/cli.mjs status --session ${sessionId}`);
  });
});

// --- tool_call: рабочий каталог вызова и песочница вне проекта ---------------------

test('tool_call: относительный путь разрешается от рабочего каталога вызова, не от корня', async () => {
  await withProject(async ({ root }) => {
    // Без права записи во временный каталог: песочница разрешает любую запись в %TEMP%,
    // и разница между резолюцией от корня и от каталога вызова была бы не видна.
    const railsYaml = join(root, '.workflow', 'src', 'skills', 'pites тест', 'rails.yaml');
    writeFileSync(railsYaml, RAILS_YAML.replace('allow_temp: true', 'allow_temp: false'), 'utf8');
    const sessionId = makeState(root, 'P4S1');
    const hooks = createPiHooks({});
    const sub = join(root, 'sub');
    mkdirSync(sub, { recursive: true });
    const event = call('write', sub, { input: { path: '../.workflow/work/rel.txt', content: 'x' } });

    // Из подкаталога этот путь ведёт в область записи проекта — отказа быть не должно.
    assert.equal(await hooks.tool_call(event, piCtx(sub, sessionId)), undefined);
  });
});

test('tool_call: песочница тестов держит запись и вне проекта с .workflow/', async () => {
  const base = mkdtempSync(join(tmpdir(), 'rails-pi-plain-sandbox-'));
  const sandbox = join(base, 'sandbox');
  mkdirSync(sandbox, { recursive: true });
  const prev = process.env.WORKFLOW_SANDBOX_ROOT;
  process.env.WORKFLOW_SANDBOX_ROOT = sandbox;
  try {
    const hooks = createPiHooks({});
    // Путь вне песочницы и вне %TEMP%: внутри %TEMP% песочница разрешает запись,
    // кроме чужих песочниц wf-test-*.
    const outside = join(homedir(), 'rails-pi-sandbox-' + randomUUID() + '.txt');
    const event = call('write', base, { input: { path: outside, content: 'x' } });
    const result = await hooks.tool_call(event, piCtx(base, uuid()));

    assert.equal(result?.block, true);
  } finally {
    if (prev === undefined) delete process.env.WORKFLOW_SANDBOX_ROOT;
    else process.env.WORKFLOW_SANDBOX_ROOT = prev;
    rmSync(base, { recursive: true, force: true });
  }
});

// --- tool_result: подсказка узла --------------------------------------------------

test('tool_result: подсказка узла добавлена, прежнее содержимое сохранено', async () => {
  await withProject(async ({ root }) => {
    const sessionId = makeState(root, 'P4S1');
    const hooks = createPiHooks({});
    const event = { toolName: 'read', toolCallId: 'c1', content: [{ type: 'text', text: 'файл прочитан' }] };

    const result = await hooks.tool_result(event, piCtx(root, sessionId));
    assert.equal(result.content.length, 2);
    assert.deepEqual(result.content[0], { type: 'text', text: 'файл прочитан' });
    assert.match(result.content[1].text, /^RAILS: числится P4S1/);
  });
});

test('tool_result: исполнителю подсказка не добавляется', async () => {
  await withProject(async ({ root }) => {
    const sessionId = makeState(root, 'P4S1');
    const hooks = createPiHooks({ WORKFLOW_RAILS_ROLE: 'executor' });
    const event = { toolName: 'read', toolCallId: 'c1', content: [{ type: 'text', text: 'x' }] };

    assert.equal(await hooks.tool_result(event, piCtx(root, sessionId)), undefined);
  });
});

test('tool_result: состояния сессии нет — подсказки тоже нет', async () => {
  await withProject(async ({ root }) => {
    const hooks = createPiHooks({});
    const event = { toolName: 'read', toolCallId: 'c1', content: [{ type: 'text', text: 'x' }] };

    assert.equal(await hooks.tool_result(event, piCtx(root, uuid())), undefined);
  });
});

test('tool_result: результат без текстовых блоков не трогается', async () => {
  await withProject(async ({ root }) => {
    const sessionId = makeState(root, 'P4S1');
    const hooks = createPiHooks({});

    assert.equal(await hooks.tool_result({ toolName: 'read', content: 'строка' }, piCtx(root, sessionId)), undefined);
    assert.equal(await hooks.tool_result({ toolName: 'read' }, piCtx(root, sessionId)), undefined);
  });
});

test('tool_result: недоступный менеджер сессий не роняет вызов', async () => {
  await withProject(async ({ root }) => {
    const hooks = createPiHooks({});
    const ctx = { cwd: root, sessionManager: { getSessionId: () => { throw new Error('нет сессии'); } } };

    assert.equal(await hooks.tool_result({ toolName: 'read', content: [] }, ctx), undefined);
    assert.equal(await hooks.tool_call(call('read', root), ctx), undefined);
  });
});

// --- фабрика расширения -----------------------------------------------------------

test('расширение: регистрирует tool_call и tool_result у pi', async () => {
  const { default: workflowRails } = await import('../rails/pi-extension.mjs');
  const registered = [];
  const pi = { on: (name, handler) => { registered.push([name, typeof handler]); } };

  workflowRails(pi);
  assert.deepEqual(registered, [['tool_call', 'function'], ['tool_result', 'function']]);
});
