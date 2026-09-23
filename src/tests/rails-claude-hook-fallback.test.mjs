/**
 * Аварийные развилки хука Claude Code (src/rails/claude-hook.mjs).
 *
 * Хук зарегистрирован глобально и срабатывает на КАЖДОМ вызове инструмента.
 * Если развилка «рельсы отходят в сторону» вместо тихого возврата бросит
 * исключение, у человека ломается не рельса, а весь инструмент — и ровно
 * там, где рельсы и должны были уступить: в чужом проекте без .workflow,
 * при битом rails.yaml, при недоступном журнале. Поэтому каждый тест ниже
 * проверяет ДВЕ вещи: что хук вернул (тишина или подсказка) и что он ничего
 * не написал в stderr — строка в stderr означает, что сработал внешний
 * catch, то есть развилка свою работу не сделала.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { handleHookInput } from '../rails/claude-hook.mjs';
import { startState, saveState, loadState } from '../rails/state.mjs';
import { readJournal } from '../rails/journal.mjs';

// Хук через decide() пишет память «сессия → корень» в <WORKFLOW_HOME>/state —
// изолируем, чтобы временные проекты не вытесняли реальные сессии из ~/.workflow.
process.env.WORKFLOW_HOME = mkdtempSync(join(tmpdir(), 'rails-test-home-'));
process.on('exit', () => rmSync(process.env.WORKFLOW_HOME, { recursive: true, force: true }));

const uuid = () => randomUUID();

// --- фикстура ---------------------------------------------------------------------

const SKILL_MD = `# Фикстура аварийных развилок хука (skill=hookfall)

\`\`\`mermaid
graph TD
    P4E1["П4 ВХОД: Начало этапа теста аварийных развилок хука рельсов"]
    P4S1["П4 ШАГ: Выполнить шаг теста аварийных развилок хука и продолжить"]
    P4E1 --> P4S1
    P4S1 --> P5E1

    P5E1["П5 ВХОД: Переход к финальному этапу теста аварийных развилок хука"]
    P5S1["П5 ШАГ: Завершить работу и подготовить финальный ответ агента здесь"]
    P5E1 --> P5S1
\`\`\`
`;

const RAILS_YAML = [
  'version: 1',
  'skill: hookfall',
  'entry: P4E1',
  'terminal: [P5S1]',
  'pause_nodes: []',
  'quote_min: 25',
  // Канарейка нужна одному тесту ниже: это гард ведущего, на котором видно,
  // распознан делегат или нет (у ведущего команда запрещена, у делегата — нет).
  'canary: "echo RAILS_CANARY"',
  '',
  'output:',
  '  final_requires: []',
  '  max_stop_blocks: 2',
  '',
].join('\n');

// Незакрытая flow-последовательность: js-yaml бросает на разборе,
// значит loadSkillRuntime() бросает — это «битый rails.yaml» из жизни.
const BROKEN_YAML = 'version: 1\nentry: [P4E1\n';

/**
 * Временный проект со скилом hookfall.
 * @param {{broken?: boolean}} opts broken — rails.yaml не парсится
 */
function withProject(opts, fn) {
  const base = mkdtempSync(join(tmpdir(), 'rails-hookfall-'));
  try {
    const root = join(base, 'root');
    const skillDir = join(root, '.workflow', 'src', 'skills', 'hookfall');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), SKILL_MD, 'utf8');
    writeFileSync(join(skillDir, 'rails.yaml'), opts.broken ? BROKEN_YAML : RAILS_YAML, 'utf8');
    fn({ base, root, skillDir });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

/** Каталог без единого .workflow вверх по дереву — «чужой проект». */
function withForeignDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rails-foreign-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeState(root, node) {
  const sessionId = uuid();
  const state = startState({ root, sessionId, skill: 'hookfall', entry: 'P4E1' });
  state.node = node;
  saveState(root, state);
  return sessionId;
}

/**
 * Состояние, которое читается, но не записывается: в файле нет поля `session`,
 * из которого saveState() строит путь. Так выглядит обрезанный или правленный
 * руками снимок состояния. loadState() его отдаёт, saveState() на нём бросает.
 */
function writeUnsaveableState(root, node) {
  const sessionId = uuid();
  const dir = join(root, '.workflow', 'state', 'rails');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${sessionId}.json`),
    JSON.stringify({ skill: 'hookfall', node, counters: {}, history: [] }),
    'utf8'
  );
  return sessionId;
}

/** Журнал рельсов занят каталогом — дозапись строки в него бросает EISDIR. */
function breakJournal(root) {
  mkdirSync(join(root, '.workflow', 'logs', 'rails-denials.jsonl'), { recursive: true });
}

/**
 * Вызывает хук, перехватывая его stderr. Пустой stderr — признак того, что
 * сработала именно проверяемая развилка, а не внешний catch «снимаю рельсы».
 */
function callHook(input, env = {}) {
  const original = process.stderr.write;
  let captured = '';
  process.stderr.write = (chunk) => {
    captured += String(chunk);
    return true;
  };
  try {
    const result = handleHookInput(input, env);
    return { result, stderr: captured };
  } finally {
    process.stderr.write = original;
  }
}

// --- роль исполнителя из WORKFLOW_RAILS_ROLE ---------------------------------------

test('PostToolUse: WORKFLOW_RAILS_ROLE=executor -> делегату не подсовывают узел ведущего', () => {
  withProject({}, ({ root }) => {
    const sessionId = makeState(root, 'P4S1');
    const input = { hook_event_name: 'PostToolUse', session_id: sessionId, cwd: root, tool_name: 'Read' };

    // Контроль: без роли ведущий подсказку получает — значит сцена рабочая.
    const lead = callHook(input, {});
    assert.match(lead.result.hookSpecificOutput.additionalContext, /RAILS: числится P4S1/);

    const delegate = callHook(input, { WORKFLOW_RAILS_ROLE: 'executor' });
    assert.equal(
      delegate.result,
      null,
      'делегат, не распознанный по роли, начнёт отчитываться по узлу чужой сессии'
    );
    assert.equal(delegate.stderr, '');
  });
});

/**
 * Пустая строка в WORKFLOW_RAILS_ROLE — это «переменная объявлена, но не
 * заполнена» (оболочка подставила пустое значение вместо неустановленного).
 * Ролью она считаться не должна: роль обязана уйти в undefined, чтобы
 * core.mjs подхватил настоящее значение из окружения процесса — там `??`,
 * а пустую строку `??` пропускает как готовый ответ.
 *
 * Цена ошибки: делегат с пустой строкой вместо роли перестаёт быть
 * исполнителем и упирается в гарды ведущего — работа встаёт на первой же
 * команде, которую ведущему запрещает rails.yaml.
 *
 * Сцена берёт PreToolUse: только там роль доходит до развилки
 * `role === 'executor'` в core.mjs. В PostToolUse сравнение идёт в самом
 * хуке, и '' там ведёт себя как undefined — сломанный гард виден не был бы.
 */
test('PreToolUse: пустой WORKFLOW_RAILS_ROLE не затирает роль исполнителя из окружения', () => {
  withProject({}, ({ root }) => {
    const sessionId = makeState(root, 'P4S1');
    const input = {
      hook_event_name: 'PreToolUse',
      session_id: sessionId,
      cwd: root,
      tool_name: 'Bash',
      tool_input: { command: 'echo RAILS_CANARY' },
    };

    // Контроль: ведущему эта команда запрещена — значит сцена рабочая
    // и «разрешено» ниже получено именно распознанной ролью делегата.
    const lead = callHook(input, {});
    assert.equal(lead.result.hookSpecificOutput.permissionDecision, 'deny');

    const saved = process.env.WORKFLOW_RAILS_ROLE;
    process.env.WORKFLOW_RAILS_ROLE = 'executor';
    try {
      const delegate = callHook(input, { WORKFLOW_RAILS_ROLE: '' });
      assert.equal(
        delegate.result,
        null,
        'пустая строка сошла за роль — делегат встал в гарды ведущего и работу продолжить не может'
      );
      assert.equal(delegate.stderr, '');
    } finally {
      if (saved === undefined) delete process.env.WORKFLOW_RAILS_ROLE;
      else process.env.WORKFLOW_RAILS_ROLE = saved;
    }
  });
});

// --- корень проекта не найден: хук в чужом проекте ----------------------------------

test('PostToolUse в каталоге без .workflow: тишина, ни строки в stderr', () => {
  withForeignDir((dir) => {
    const { result, stderr } = callHook({
      hook_event_name: 'PostToolUse',
      session_id: uuid(),
      cwd: dir,
      tool_name: 'Read',
    });
    assert.equal(result, null);
    assert.equal(stderr, '', 'в чужом проекте хук обязан молчать, а не сыпать стектрейсом на каждый вызов');
  });
});

test('Stop в каталоге без .workflow: финальный ответ не блокируется, stderr пуст', () => {
  withForeignDir((dir) => {
    const { result, stderr } = callHook({
      hook_event_name: 'Stop',
      session_id: uuid(),
      cwd: dir,
      transcript_path: join(dir, 'нет-такого.jsonl'),
    });
    assert.equal(result, null, 'иначе рельсы чужого проекта не дают агенту завершить ответ');
    assert.equal(stderr, '');
  });
});

test('UserPromptSubmit в каталоге без .workflow: подсказка о коррекции есть, но без узла', () => {
  withForeignDir((dir) => {
    const { result, stderr } = callHook({
      hook_event_name: 'UserPromptSubmit',
      session_id: uuid(),
      cwd: dir,
      prompt: 'нет, не туда',
    });
    const context = result.hookSpecificOutput.additionalContext;
    assert.match(context, /сверься с ГЛАВНЫМ ПРАВИЛОМ/);
    assert.doesNotMatch(context, /узла/, 'без корня проекта узел неизвестен — называть его нельзя');
    assert.equal(stderr, '');
  });
});

// --- битый rails.yaml: граф не грузится --------------------------------------------

test('PostToolUse при битом rails.yaml: тишина вместо падения инструмента', () => {
  withProject({ broken: true }, ({ root }) => {
    const sessionId = makeState(root, 'P4S1');
    const { result, stderr } = callHook({
      hook_event_name: 'PostToolUse',
      session_id: sessionId,
      cwd: root,
      tool_name: 'Read',
    });
    assert.equal(result, null);
    assert.equal(stderr, '', 'опечатка в rails.yaml не должна ломать каждый вызов инструмента');
  });
});

test('Stop при битом rails.yaml: агенту дают завершить ответ', () => {
  withProject({ broken: true }, ({ root, base }) => {
    const sessionId = makeState(root, 'P4S1');
    const { result, stderr } = callHook({
      hook_event_name: 'Stop',
      session_id: sessionId,
      cwd: root,
      transcript_path: join(base, 'нет-такого.jsonl'),
    });
    assert.equal(result, null, 'иначе битый конфиг запирает сессию: ответ не выпускают, а починить нечем');
    assert.equal(stderr, '');
  });
});

test('UserPromptSubmit при битом графе: подсказка называет узел, лейбл пустой', () => {
  withProject({ broken: true }, ({ root }) => {
    const sessionId = makeState(root, 'P4S1');
    const { result, stderr } = callHook({
      hook_event_name: 'UserPromptSubmit',
      session_id: sessionId,
      cwd: root,
      prompt: 'нет, не то',
    });
    assert.match(result.hookSpecificOutput.additionalContext, /узла P4S1 «»/);
    assert.equal(stderr, '');
    // Отметка о коррекции обязана лечь на диск даже без графа.
    assert.equal(loadState(root, sessionId).flags.correction_pending, true);
  });
});

test('SessionStart при битом графе: сессия и узел названы, лейбл пустой', () => {
  withProject({ broken: true }, ({ root }) => {
    const sessionId = makeState(root, 'P4S1');
    const { result, stderr } = callHook({ hook_event_name: 'SessionStart', session_id: sessionId, cwd: root });
    const context = result.hookSpecificOutput.additionalContext;
    assert.match(context, /активен скил hookfall, узел P4S1 «»/);
    assert.equal(stderr, '', 'битый граф не повод встречать человека стектрейсом при старте сессии');
  });
});

// --- журнал и состояние недоступны ---------------------------------------------------

test('Stop: журнал недоступен -> блок финального ответа всё равно выставлен', () => {
  withProject({}, ({ root, base }) => {
    const sessionId = makeState(root, 'P4S1');
    breakJournal(root);

    const { result, stderr } = callHook({
      hook_event_name: 'Stop',
      session_id: sessionId,
      cwd: root,
      transcript_path: join(base, 'нет-такого.jsonl'),
    });

    assert.equal(result.decision, 'block', 'потеря записи в журнале не отменяет несоответствие ответа rails.yaml');
    assert.match(result.reason, /не соответствует rails\.yaml\.output/);
    assert.equal(stderr, '');
    assert.equal(readJournal(root, {}).length, 0, 'журнал занят каталогом — записей и не должно быть');
    // Счётчик stop-блоков обязан вырасти: иначе потолок max_stop_blocks не наступит никогда.
    assert.equal(loadState(root, sessionId).counters['stop_blocks:P4S1'], 1);
  });
});

test('Stop: состояние не записывается -> блок доходит до агента, счётчик на диске не растёт', () => {
  withProject({}, ({ root, base }) => {
    const sessionId = writeUnsaveableState(root, 'P4S1');

    const { result, stderr } = callHook({
      hook_event_name: 'Stop',
      session_id: sessionId,
      cwd: root,
      transcript_path: join(base, 'нет-такого.jsonl'),
    });

    assert.equal(result.decision, 'block', 'битый файл состояния не должен ронять завершение сессии');
    assert.equal(stderr, '');
    // Запись в журнал идёт до сохранения состояния — она обязана остаться.
    const stopBlocks = readJournal(root, {}).filter((e) => e.type === 'stop_block');
    assert.equal(stopBlocks.length, 1);
    assert.equal(stopBlocks[0].node, 'P4S1');
    // Цена: счётчик не сохранился, значит блок повторится — но инструмент жив.
    assert.equal(loadState(root, sessionId).counters['stop_blocks:P4S1'], undefined);
  });
});

test('UserPromptSubmit: состояние не записывается -> подсказка с узлом всё равно приходит', () => {
  withProject({}, ({ root }) => {
    const sessionId = writeUnsaveableState(root, 'P4S1');

    const { result, stderr } = callHook({
      hook_event_name: 'UserPromptSubmit',
      session_id: sessionId,
      cwd: root,
      prompt: 'нет, не туда',
    });

    assert.match(result.hookSpecificOutput.additionalContext, /узла P4S1 «П4 ШАГ/);
    assert.equal(stderr, '');
    // Цена: флаг correction_pending на диск не лёг — рельсы забудут о коррекции.
    assert.equal(loadState(root, sessionId).flags, undefined);
  });
});

// --- внешний catch: журнал записать некуда --------------------------------------------

test('исключение в хуке + корня проекта нет: хук не бросает, только строка в stderr', () => {
  withForeignDir((dir) => {
    const input = { session_id: uuid(), cwd: dir };
    // Поле-геттер, бросающее при чтении: так выглядит любое падение ВНЕ decide().
    Object.defineProperty(input, 'hook_event_name', {
      get() {
        throw new Error('искусственный сбой развилки журнала');
      },
    });

    let captured;
    assert.doesNotThrow(() => {
      captured = callHook(input);
    }, 'исключение из хука доходит до Claude Code и ломает вызов инструмента');

    assert.equal(captured.result, null);
    assert.match(captured.stderr, /снимаю рельсы/);
    assert.match(captured.stderr, /искусственный сбой развилки журнала/);
  });
});

test('исключение в хуке + журнал недоступен: хук не бросает, запись теряется молча', () => {
  withProject({}, ({ root }) => {
    breakJournal(root);
    const input = { session_id: uuid(), cwd: root };
    Object.defineProperty(input, 'hook_event_name', {
      get() {
        throw new Error('искусственный сбой при недоступном журнале');
      },
    });

    let captured;
    assert.doesNotThrow(() => {
      captured = callHook(input);
    }, 'недоступный журнал не должен превращать сбой хука в сбой инструмента');

    assert.equal(captured.result, null);
    assert.match(captured.stderr, /снимаю рельсы/);
    assert.equal(readJournal(root, {}).length, 0);
  });
});
