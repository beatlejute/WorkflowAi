/**
 * Аварийные развилки плагина Kilo (src/rails/kilo-plugin.mjs).
 *
 * Плагин грузится в каждый запуск Kilo и оборачивает каждый вызов
 * инструмента. `tool.execute.before` отклоняет вызов броском — значит любой
 * НЕзапланированный бросок из хука Kilo трактует так же: как отказ
 * инструмента. Развилки «рельсы отходят в сторону» (чужой каталог, битый
 * rails.yaml, вызов без sessionID, состояние без скила) обязаны возвращаться
 * тихо, иначе ломается чужой инструмент, а не рельса.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { createHooks } from '../rails/kilo-plugin.mjs';
import { startState, saveState } from '../rails/state.mjs';
import { readJournal } from '../rails/journal.mjs';

// Плагин через decide() пишет память «сессия → корень» в <WORKFLOW_HOME>/state — изолируем.
process.env.WORKFLOW_HOME = mkdtempSync(join(tmpdir(), 'rails-test-home-'));
process.on('exit', () => rmSync(process.env.WORKFLOW_HOME, { recursive: true, force: true }));

const uuid = () => randomUUID();

// P4S2 — узел с лейблом заведомо длиннее 80 символов: подсказка обязана его обрезать,
// иначе весь вывод инструмента тонет в пересказе графа.
const LONG_LABEL =
  'П4 ШАГ: Очень длинный лейбл узла для проверки обрезки подсказки плагина, который заведомо длиннее восьмидесяти символов и целиком в подсказку попасть не должен';

const SKILL_MD = `# Фикстура аварийных развилок плагина kilo (skill=kilofall)

\`\`\`mermaid
graph TD
    P4E1["П4 ВХОД: Начало этапа теста аварийных развилок плагина kilo"]
    P4S1["П4 ШАГ: Выполнить шаг теста аварийных развилок плагина и продолжить"]
    P4S2["${LONG_LABEL}"]
    P4E1 --> P4S1
    P4S1 --> P4S2
    P4S2 --> P5E1

    P5E1["П5 ВХОД: Переход к финальному этапу теста аварийных развилок плагина"]
    P5S1["П5 ШАГ: Завершить работу и подготовить финальный ответ агента здесь"]
    P5E1 --> P5S1
\`\`\`
`;

const RAILS_YAML = [
  'version: 1',
  'skill: kilofall',
  'entry: P4E1',
  'terminal: [P5S1]',
  'pause_nodes: []',
  'quote_min: 25',
  'canary: "echo RAILS_CANARY"',
  '',
  'output:',
  '  final_requires: []',
  '  max_stop_blocks: 2',
  '',
].join('\n');

const BROKEN_YAML = 'version: 1\nentry: [P4E1\n';

async function withProject(opts, fn) {
  const base = mkdtempSync(join(tmpdir(), 'rails-kilofall-'));
  try {
    const root = join(base, 'root');
    const skillDir = join(root, '.workflow', 'src', 'skills', 'kilofall');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), SKILL_MD, 'utf8');
    writeFileSync(join(skillDir, 'rails.yaml'), opts.broken ? BROKEN_YAML : RAILS_YAML, 'utf8');
    return await fn({ base, root, skillDir });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

async function withForeignDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rails-kilo-foreign-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeState(root, node) {
  const sessionID = uuid();
  const state = startState({ root, sessionId: sessionID, skill: 'kilofall', entry: 'P4E1' });
  state.node = node;
  saveState(root, state);
  return sessionID;
}

/** Снимок состояния без поля skill — так выглядит обрезанный или чужой файл. */
function writeStateWithoutSkill(root, node) {
  const sessionID = uuid();
  const dir = join(root, '.workflow', 'state', 'rails');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionID}.json`), JSON.stringify({ session: sessionID, node }), 'utf8');
  return sessionID;
}

// --- tool.execute.after: тихие возвраты ------------------------------------------------

test('after: вызов без sessionID -> вывод инструмента не тронут', async () => {
  await withProject({}, async ({ root }) => {
    const hooks = createHooks(root, {});
    const output = { output: 'исходный вывод инструмента', args: {} };
    await assert.doesNotReject(() => hooks['tool.execute.after']({ tool: 'read', callID: 'c1' }, output));
    assert.equal(
      output.output,
      'исходный вывод инструмента',
      'без sessionID узел неизвестен — подсказка назвала бы чужой узел'
    );
  });
});

test('after: каталог без .workflow -> вывод чужого инструмента не тронут', async () => {
  await withForeignDir(async (dir) => {
    const hooks = createHooks(dir, {});
    const output = { output: 'исходный вывод инструмента', args: {} };
    await assert.doesNotReject(() => hooks['tool.execute.after']({ tool: 'read', sessionID: uuid(), callID: 'c1' }, output));
    assert.equal(output.output, 'исходный вывод инструмента', 'в чужом проекте плагин обязан молчать');
  });
});

test('after: состояние без скила -> вывод не тронут', async () => {
  await withProject({}, async ({ root }) => {
    const sessionID = writeStateWithoutSkill(root, 'P4S1');
    const hooks = createHooks(root, {});
    const output = { output: 'исходный вывод инструмента', args: {} };
    await assert.doesNotReject(() => hooks['tool.execute.after']({ tool: 'read', sessionID, callID: 'c1' }, output));
    assert.equal(output.output, 'исходный вывод инструмента', 'скил не запущен — рельсам нечего сообщать');
  });
});

test('after: битый rails.yaml -> вывод не тронут, вызов Kilo не падает', async () => {
  await withProject({ broken: true }, async ({ root }) => {
    const sessionID = makeState(root, 'P4S1');
    const hooks = createHooks(root, {});
    const output = { output: 'исходный вывод инструмента', args: {} };
    await assert.doesNotReject(() => hooks['tool.execute.after']({ tool: 'read', sessionID, callID: 'c1' }, output));
    assert.equal(output.output, 'исходный вывод инструмента', 'опечатка в rails.yaml не должна ронять каждый вызов инструмента');
  });
});

// --- tool.execute.after: форма подсказки -------------------------------------------------

test('after: узла нет в графе -> подсказка называет узел с пустым лейблом', async () => {
  await withProject({}, async ({ root }) => {
    const sessionID = makeState(root, 'P7S3'); // такого узла в графе фикстуры нет
    const hooks = createHooks(root, {});
    const output = { output: 'исходный вывод', args: {} };
    await hooks['tool.execute.after']({ tool: 'read', sessionID, callID: 'c1' }, output);
    assert.match(
      output.output,
      /RAILS: числится P7S3 «»$/,
      'узел исчез из графа после правки скила — плагин обязан сказать это честно, а не показать «undefined»'
    );
  });
});

test('after: длинный лейбл узла обрезан до 80 символов', async () => {
  await withProject({}, async ({ root }) => {
    const sessionID = makeState(root, 'P4S2');
    const hooks = createHooks(root, {});
    const output = { output: '', args: {} };
    await hooks['tool.execute.after']({ tool: 'read', sessionID, callID: 'c1' }, output);

    const label = /«([^»]*)»/u.exec(output.output)[1];
    assert.ok(LONG_LABEL.length > 80, 'фикстура обязана давать лейбл длиннее порога');
    assert.equal(label.length, 81, 'обрезка до 80 символов плюс многоточие');
    assert.equal(label, `${LONG_LABEL.slice(0, 80)}…`);
    assert.ok(
      !output.output.includes(LONG_LABEL),
      'целиком лейбл в подсказку попадать не должен — он вытесняет настоящий вывод инструмента'
    );
  });
});

// --- роль исполнителя из окружения ---------------------------------------------------------

test('before: WORKFLOW_RAILS_ROLE=executor -> делегат не упирается в гарды ведущего', async () => {
  await withProject({}, async ({ root }) => {
    const sessionID = makeState(root, 'P4S1');
    const output = { args: { command: 'echo RAILS_CANARY' } };

    // Контроль: у ведущего та же команда отклоняется — значит канарейка в фикстуре работает.
    const lead = createHooks(root, {});
    await assert.rejects(() => lead['tool.execute.before']({ tool: 'bash', sessionID, callID: 'c1' }, { ...output }), /RAILS_CANARY/);

    const delegate = createHooks(root, { WORKFLOW_RAILS_ROLE: 'executor' });
    await assert.doesNotReject(
      () => delegate['tool.execute.before']({ tool: 'bash', sessionID, callID: 'c2' }, output),
      'делегат, не распознанный по роли, упирается в гарды чужой сессии и встаёт'
    );
  });
});

// --- дедупликация по callID ------------------------------------------------------------------

test('before: один и тот же callID -> один отказ в журнале; без callID -> два', async () => {
  await withProject({}, async ({ root }) => {
    const withId = makeState(root, 'P4S1');
    const hooks = createHooks(root, {});
    const cmd = () => ({ args: { command: 'echo RAILS_CANARY' } });

    // Kilo передал callID: повтор хука (рельсы зарегистрированы дважды) считается одним вызовом.
    await assert.rejects(() => hooks['tool.execute.before']({ tool: 'bash', sessionID: withId, callID: 'dup' }, cmd()));
    await assert.rejects(() => hooks['tool.execute.before']({ tool: 'bash', sessionID: withId, callID: 'dup' }, cmd()));
    const dedup = readJournal(root, {}).filter((e) => e.type === 'denial' && e.session === withId);
    assert.equal(dedup.length, 1, 'повтор одного вызова не должен дважды тратить потолки и плодить записи в журнале');

    // callID нет — дедуплицировать нечем, и это видно: два отказа на два вызова.
    const noId = makeState(root, 'P4S1');
    await assert.rejects(() => hooks['tool.execute.before']({ tool: 'bash', sessionID: noId }, cmd()));
    await assert.rejects(() => hooks['tool.execute.before']({ tool: 'bash', sessionID: noId }, cmd()));
    const plain = readJournal(root, {}).filter((e) => e.type === 'denial' && e.session === noId);
    assert.equal(plain.length, 2, 'без идентификатора вызова каждый вызов учитывается отдельно');
  });
});
