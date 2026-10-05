/**
 * `rails report --journal` и сообщения об ошибках CLI (src/rails/cli.mjs).
 *
 * Две зоны, одинаково важные для человека:
 *
 * 1. `report --journal <файл|каталог>` — единственный способ разобрать прогон
 *    раннера: журналы изолированных workdir'ов лежат файлами
 *    `tests/cases/<TC>/current/<agent>/rails-trial-N.jsonl`, а не в журнале
 *    проекта. Если обход каталога берёт не те файлы, уходит не на ту глубину
 *    или подсовывает журнал проекта вместо указанного — разбор прогона врёт.
 * 2. Сообщения об ошибках — это всё, что человек видит, когда команда не
 *    сработала. Неверный код выхода или пустой текст означают, что команда
 *    молча «получилась», и ошибка всплывёт позже и в другом месте.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { run } from '../rails/cli.mjs';
import { startState, saveState, loadState } from '../rails/state.mjs';
import { appendDenial, readJournal } from '../rails/journal.mjs';

// CLI через start --session пишет память «сессия → корень» в <WORKFLOW_HOME>/state — изолируем.
process.env.WORKFLOW_HOME = mkdtempSync(join(tmpdir(), 'rails-test-home-'));
process.on('exit', () => rmSync(process.env.WORKFLOW_HOME, { recursive: true, force: true }));

const uuid = () => randomUUID();

const SKILL_MD = `# Фикстура CLI отчётов и ошибок (skill=clifall)

\`\`\`mermaid
graph TD
    P4E1["П4 ВХОД: Начало этапа теста отчётов и ошибок CLI рельсов"]
    P4S1["П4 ШАГ: Выполнить шаг теста отчётов и ошибок CLI и продолжить"]
    P4E1 --> P4S1
    P4S1 --> P5E1

    P5E1["П5 ВХОД: Переход к финальному этапу теста отчётов и ошибок CLI"]
    P5S1["П5 ШАГ: Завершить работу и подготовить финальный ответ агента здесь"]
    P5E1 --> P5S1
\`\`\`
`;

const RAILS_YAML = [
  'version: 1',
  'skill: clifall',
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

const BROKEN_YAML = 'version: 1\nentry: [P4E1\n';
const YAML_WITHOUT_ENTRY = 'version: 1\nskill: clifall\nterminal: [P5S1]\n';

/**
 * @param {{yaml?: string, noSkillsDir?: boolean}} opts
 */
function withProject(opts, fn) {
  const base = mkdtempSync(join(tmpdir(), 'rails-clifall-'));
  try {
    const root = join(base, 'root');
    if (opts.noSkillsDir) {
      mkdirSync(join(root, '.workflow'), { recursive: true });
    } else {
      const skillDir = join(root, '.workflow', 'src', 'skills', 'clifall');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), SKILL_MD, 'utf8');
      writeFileSync(join(skillDir, 'rails.yaml'), opts.yaml ?? RAILS_YAML, 'utf8');
    }
    fn({ base, root });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function makeState(root, node) {
  const sessionId = uuid();
  const state = startState({ root, sessionId, skill: 'clifall', entry: 'P4E1' });
  state.node = node;
  saveState(root, state);
  return sessionId;
}

/** Валидное состояние, которое saveState() записать не может: файл read-only. */
function writeUnsaveableState(root, node) {
  const sessionId = uuid();
  const dir = join(root, '.workflow', 'state', 'rails');
  mkdirSync(dir, { recursive: true });
  const state = startState({ root, sessionId, skill: 'clifall', entry: 'P4E1' });
  state.node = node;
  saveState(root, state);
  const file = join(dir, `${sessionId}.json`);
  chmodSync(file, 0o444);
  return file;
}

/** Журнал рельсов занят каталогом — дозапись строки в него бросает EISDIR. */
function breakJournal(root) {
  mkdirSync(join(root, '.workflow', 'logs', 'rails-denials.jsonl'), { recursive: true });
}

function writeJournalFile(file, entries) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, entries.map((e) => JSON.stringify({ t: new Date().toISOString(), ...e })).join('\n') + '\n', 'utf8');
}

const denial = (node) => ({ type: 'denial', session: 'внешняя-сессия', skill: 'clifall', node, reason: 'тест' });

// --- report --journal: разбор журналов прогона -------------------------------------------

test('report --journal <файл>: читает указанный файл, а не журнал проекта', () => {
  withProject({}, ({ base, root }) => {
    // В журнале проекта — отказ по P4S1; во внешнем файле прогона — по P5E1.
    appendDenial(root, { session: 'сессия-проекта', skill: 'clifall', node: 'P4S1', reason: 'тест' });
    const trial = join(base, 'trials', 'rails-trial-1.jsonl');
    writeJournalFile(trial, [denial('P5E1')]);

    const r = run(['report', '--journal', trial], { cwd: root, env: {} });

    assert.equal(r.code, 0);
    assert.match(r.stdout, /\[1 файл\(ов\) из /);
    assert.match(r.stdout, /Всего записей: 1/);
    assert.match(r.stdout, /P5E1: 1/);
    assert.doesNotMatch(r.stdout, /P4S1/, 'разбор прогона обязан читать указанный журнал, а не подмешивать журнал проекта');
  });
});

test('report --journal <каталог>: собирает все *.jsonl рекурсивно, прочие файлы не трогает', () => {
  withProject({}, ({ base, root }) => {
    const dir = join(base, 'cases');
    writeJournalFile(join(dir, 'TC1', 'current', 'claude', 'rails-trial-1.jsonl'), [denial('P4S1')]);
    writeJournalFile(join(dir, 'TC1', 'current', 'claude', 'rails-trial-2.jsonl'), [denial('P4S1')]);
    writeJournalFile(join(dir, 'TC2', 'current', 'kilo', 'rails-trial-1.jsonl'), [denial('P5E1')]);
    // Не журналы: отчёт и лог рядом в том же каталоге прогона.
    writeFileSync(join(dir, 'TC1', 'current', 'report.json'), JSON.stringify(denial('P9S9')), 'utf8');
    writeFileSync(join(dir, 'TC1', 'current', 'stdout.log'), JSON.stringify(denial('P8S8')), 'utf8');

    const r = run(['report', '--journal', dir], { cwd: root, env: {} });

    assert.equal(r.code, 0);
    assert.match(r.stdout, /\[3 файл\(ов\) из /);
    assert.match(r.stdout, /Всего записей: 3/);
    assert.match(r.stdout, /P4S1: 2/);
    assert.match(r.stdout, /P5E1: 1/);
    assert.doesNotMatch(r.stdout, /P9S9|P8S8/, 'report.json и stdout.log — не журналы: их разбор дал бы выдуманные отказы');
  });
});

test('report --journal <каталог>: глубже шести уровней обход не идёт', () => {
  withProject({}, ({ base, root }) => {
    const dir = join(base, 'deep');
    const level6 = join(dir, 'l1', 'l2', 'l3', 'l4', 'l5', 'l6');
    writeJournalFile(join(level6, 'виден.jsonl'), [denial('P4S1')]);
    writeJournalFile(join(level6, 'l7', 'не-виден.jsonl'), [denial('P5E1')]);

    const r = run(['report', '--journal', dir], { cwd: root, env: {} });

    assert.equal(r.code, 0);
    assert.match(r.stdout, /\[1 файл\(ов\) из /, 'ограничитель глубины 6 удерживает обход от ухода в глубокое дерево');
    assert.match(r.stdout, /P4S1: 1/);
    assert.doesNotMatch(r.stdout, /P5E1/);
  });
});

// Канарейка — проверка живости, а не отказ (journal.summarize: canaries). Анализ журналов
// 2026-09-30: канарейка давала четверть–треть записей «отказов» и выводила P0S1/P0E1 в лидеры
// отказов по узлу; число канареек в отчёте нигде не печаталось.
test('report --journal: канарейка — отдельной строкой с числом и узлами, не в отказах и не в повторах', () => {
  withProject({}, ({ base, root }) => {
    const trial = join(base, 'trial', 'rails-trial-1.jsonl');
    const legacy = (node) => ({ ...denial(node), reason: `Отклонено: Bash: echo RAILS_CANARY\nПочему: RAILS_CANARY: рельсы активны, узел ${node}\nДоступно: …` });
    const canary = (node) => ({ type: 'canary', session: 'внешняя-сессия', skill: 'clifall', node, command: 'echo RAILS_CANARY' });
    writeJournalFile(trial, [canary('P0S1'), canary('P0S1'), legacy('P0S1'), legacy('P0E1'), denial('P4S1')]);

    const r = run(['report', '--journal', trial], { cwd: root, env: {} });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /\nКанарейка \(проверка живости, не отказ\): 4 \(\{"P0S1":3,"P0E1":1\}\)\n/);
    const byNode = r.stdout.slice(r.stdout.indexOf('Отказы по узлу:'), r.stdout.indexOf('Узлы с ≥3 повторами'));
    assert.match(byNode, /P4S1: 1/);
    assert.doesNotMatch(byNode, /P0S1|P0E1/, 'канарейка — не отказ по узлу');
    const repeated = r.stdout.slice(r.stdout.indexOf('Узлы с ≥3 повторами'), r.stdout.indexOf('Срабатывания потолков циклов'));
    assert.match(repeated, /\n {2}нет\n/, 'три канарейки P0S1 в одной сессии — не повтор');
  });
});

test('report: журнал без канареек — строка канарейки с нулём', () => {
  withProject({}, ({ root }) => {
    const r = run(['report'], { cwd: root, env: {} });
    assert.match(r.stdout, /\nКанарейка \(проверка живости, не отказ\): 0 \(\{\}\)\n/);
  });
});

test('report --journal <несуществующий путь>: пустой отчёт, а не журнал проекта', () => {
  withProject({}, ({ base, root }) => {
    appendDenial(root, { session: 'сессия-проекта', skill: 'clifall', node: 'P4S1', reason: 'тест' });

    const r = run(['report', '--journal', join(base, 'нет-такого-каталога')], { cwd: root, env: {} });

    assert.equal(r.code, 0, 'опечатка в пути не должна ронять команду разбора');
    assert.match(r.stdout, /\[0 файл\(ов\) из /);
    assert.match(r.stdout, /Всего записей: 0/);
    assert.doesNotMatch(r.stdout, /P4S1/, 'молчаливая подмена на журнал проекта выдала бы чужие отказы за результат прогона');
  });
});

// --- сообщения об ошибках: start ----------------------------------------------------------

test('start без имени скила: code 1 и подсказка по использованию', () => {
  withProject({}, ({ root }) => {
    const r = run(['start'], { cwd: root, env: {} });
    assert.equal(r.code, 1, 'нулевой код сказал бы вызывающему скрипту, что скил запущен');
    assert.match(r.stdout, /не указан скил/);
    assert.match(r.stdout, /start <skill>/);
  });
});

test('start несуществующего скила: code 1 и имя скила в тексте ошибки', () => {
  withProject({}, ({ root }) => {
    const r = run(['start', 'нетакогоскила', '--session', uuid()], { cwd: root, env: {} });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /Ошибка загрузки скила "нетакогоскила"/, 'без имени скила человек не поймёт, что именно опечатал');
  });
});

test('start скила, чей rails.yaml не задаёт entry: code 1 с названием причины', () => {
  withProject({ yaml: YAML_WITHOUT_ENTRY }, ({ root }) => {
    const sessionId = uuid();
    const r = run(['start', 'clifall', '--session', sessionId], { cwd: root, env: {} });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /не задаёт entry/);
    assert.equal(loadState(root, sessionId), null, 'состояние без entry создавать нельзя — сессия повисла бы в узле undefined');
  });
});

// --- сообщения об ошибках: goto -------------------------------------------------------------

test('goto без целевого узла: code 1 и подсказка по использованию', () => {
  withProject({}, ({ root }) => {
    const r = run(['goto', '--session', uuid()], { cwd: root, env: {} });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /не указан целевой узел/);
    assert.match(r.stdout, /--quote/);
  });
});

test('goto по несуществующей сессии: code 1 с идентификатором сессии в тексте', () => {
  withProject({}, ({ root }) => {
    makeState(root, 'P4S1'); // в проекте есть чужая сессия — угадывать её нельзя
    const missing = uuid();
    const r = run(['goto', 'P5E1', '--session', missing, '--quote', 'П4 ШАГ: Выполнить шаг теста отчётов и ошибок CLI и продолжить'], {
      cwd: root,
      env: {},
    });
    assert.equal(r.code, 1);
    assert.match(r.stdout, new RegExp(`состояние сессии ${missing} не найдено`));
  });
});

test('goto при битом rails.yaml: code 1 с текстом разбора конфига', () => {
  withProject({ yaml: BROKEN_YAML }, ({ root }) => {
    const sessionId = makeState(root, 'P4S1');
    const r = run(['goto', 'P5E1', '--session', sessionId, '--quote', 'П5 ВХОД: Переход к финальному этапу теста отчётов и ошибок CLI'], {
      cwd: root,
      env: {},
    });
    assert.equal(r.code, 1, 'нулевой код при битом конфиге означал бы «перешёл», хотя перехода не было');
    assert.match(r.stdout, /Ошибка загрузки скила "clifall"/);
    assert.equal(loadState(root, sessionId).node, 'P4S1', 'узел меняться не должен');
  });
});

test('goto: состояние не записывается -> отказ всё равно доходит до агента', () => {
  withProject({}, ({ root }) => {
    const file = writeUnsaveableState(root, 'P4S1');
    const sessionId = basename(file, '.json');

    try {
      const r = run(['goto', 'P5S1', '--session', sessionId], { cwd: root, env: {} });
      console.error('PROBE-STDOUT:', JSON.stringify(r.stdout));

      assert.equal(r.code, 2, 'битый файл состояния не повод отвечать стектрейсом вместо отказа');
      assert.match(r.stdout, /Отклонено: goto P5S1/);
      assert.match(r.stdout, /Доступно:/);
      const denials = readJournal(root, {}).filter((e) => e.type === 'denial');
      assert.equal(denials.length, 1, 'отказ обязан попасть в журнал даже когда состояние записать не удалось');
      assert.deepEqual(loadState(root, sessionId).denials, {}, 'цена: счётчик отказов на диск не лёг');
    } finally {
      chmodSync(file, 0o666);
    }
  });
});

test('goto: журнал недоступен -> отказ всё равно доходит до агента', () => {
  withProject({}, ({ root }) => {
    const sessionId = makeState(root, 'P4S1');
    breakJournal(root);

    const r = run(['goto', 'P5S1', '--session', sessionId], { cwd: root, env: {} });

    assert.equal(r.code, 2, 'недоступный журнал не отменяет отказ — иначе агент проехал бы мимо узла');
    assert.match(r.stdout, /Отклонено: goto P5S1/);
    assert.equal(readJournal(root, {}).length, 0);
    // Состояние пишется до журнала: счётчик отказов по узлу обязан сохраниться.
    assert.equal(loadState(root, sessionId).denials.P4S1, 1);
  });
});

// --- сообщения об ошибках и терпимость: status / reset / check ---------------------------------

test('status при битом графе: code 0, узел назван, лейбл пуст', () => {
  withProject({ yaml: BROKEN_YAML }, ({ root }) => {
    const sessionId = makeState(root, 'P4S1');
    const r = run(['status', '--session', sessionId], { cwd: root, env: {} });
    assert.equal(r.code, 0, 'status — единственный способ узнать, где сессия; при битом графе он нужен особенно');
    assert.match(r.stdout, /Узел: P4S1 «» \(этап 4, тип S\)/);
    assert.match(r.stdout, /Скил: clifall/);
    assert.match(r.stdout, /\nПереходы: граф скила не загружен \(см\. cli check --skill\)\n$/, 'перечня нет — это сказано, а не пропущено молча');
  });
});

test('reset при недоступном журнале: состояние всё равно удалено', () => {
  withProject({}, ({ root }) => {
    const sessionId = makeState(root, 'P4S1');
    breakJournal(root);

    const r = run(['reset', '--session', sessionId], { cwd: root, env: {} });

    assert.equal(r.code, 0);
    assert.match(r.stdout, new RegExp(`Сброшено: сессия ${sessionId}`));
    assert.equal(loadState(root, sessionId), null, 'сброс обязан состояться: иначе сессия залипает в старом узле');
    assert.ok(!existsSync(join(root, '.workflow', 'state', 'rails', `${sessionId}.json`)));
  });
});

test('check --all в проекте без каталога скилов: code 0 и прямой текст «скилов не найдено»', () => {
  withProject({ noSkillsDir: true }, ({ root }) => {
    const r = run(['check', '--all'], { cwd: root, env: {} });
    assert.equal(r.code, 0, 'отсутствие скилов — не ошибка проверки, иначе гейт краснеет на пустом проекте');
    assert.match(r.stdout, /Скилов не найдено/);
  });
});

test('check без --skill и без --all: code 1 и перечень того, что надо задать', () => {
  withProject({}, ({ root }) => {
    const r = run(['check'], { cwd: root, env: {} });
    assert.equal(r.code, 1, 'нулевой код без единой проверки — это «всё хорошо» на ровном месте');
    assert.match(r.stdout, /укажи --skill <name> или --all/);
  });
});
