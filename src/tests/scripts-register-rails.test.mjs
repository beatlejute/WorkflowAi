#!/usr/bin/env node

/**
 * scripts-register-rails.test.mjs — `src/scripts/register-rails.js`.
 *
 * Зачем файл появился: модуль не загружался ни одним тестом — ни одной строки
 * из 111. При этом он единственный в пакете, кто пишет НЕ в свой прогон, а в
 * чужое рабочее окружение: junction на ядро rails в `.workflow/src/rails`,
 * хуки Claude Code в `.claude/settings.local.json` (а с `--user` — в
 * машинный `~/.claude/settings.json`), загрузчик Kilo-плагина и строку в чужой
 * `.gitignore`. Ошибка здесь портит не прогон, а рабочий каталог человека, и
 * заметна она станет не сразу.
 *
 * Поэтому здесь проверяется не факт записи, а её цена:
 *   • отказ обязан быть отказом — при отсутствующем или пустом `<globalDir>/rails`
 *     и в каталоге без `.workflow/` не должно появиться ни junction, ни хуков:
 *     хук с путём в никуда молча отключает рельсы во всех сессиях проекта.
 *     Отсутствие ссылки проверяется через `lstat`, а не `existsSync`/`isJunction`:
 *     оба идут ПО ссылке и дохлый junction показывают как отсутствующий (см. noEntry);
 *   • чужие ключи и чужой формат `hooks` не трогаются, битый JSON не
 *     перезаписывается (§11: своё дописываем, чужое не стираем);
 *   • строка `.workflow/state/` дописывается в `.gitignore` один раз и не
 *     затирает его содержимое;
 *   • `--umbrella` ставит только хуки (без junction и без Kilo-загрузчика),
 *     `--user` пишет ровно в `<домашний каталог>/.claude/settings.json`;
 *   • подключение модулем (без входного файла) не регистрирует ничего.
 *
 * НАСТОЯЩИЕ НАСТРОЙКИ ПОЛЬЗОВАТЕЛЯ. Режим `--user` берёт домашний каталог из
 * `os.homedir()`, параметра для подмены у него нет. Поэтому все тесты этого
 * режима идут ДОЧЕРНИМ ПРОЦЕССОМ с подменёнными USERPROFILE/HOME (что
 * `os.homedir()` их уважает — проверено запуском на этой машине), а до и после
 * прогона снимается хеш настоящего `~/.claude/settings.json` и сверяется:
 * регистрацию хуков в реальных настройках правит только человек.
 *
 * Запуск:
 *   node --test --import ./src/tests/_rails-home.mjs src/tests/scripts-register-rails.test.mjs
 */

import { test, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  lstatSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { registerRails, unregisterRails, userSettingsPath } from '../scripts/register-rails.js';
import { isJunction } from '../junction-manager.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../..');
const SCRIPT = join(PROJECT_ROOT, 'src', 'scripts', 'register-rails.js');
const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'Stop', 'UserPromptSubmit', 'SessionStart'];

const trash = [];
function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  trash.push(dir);
  return dir;
}
after(() => {
  // rmSync рекурсивно снимает junction как ссылку и не выедает её цель
  // (проверено запуском на этой машине: файл в цели junction пережил удаление дерева).
  for (const dir of trash.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

/**
 * Глобальная установка с ядром rails: ровно то, что требует registerRails.
 * `missing` — каталога `rails/` нет; `empty` — он есть и пуст; `coreMissing` —
 * он есть и не пуст, но без `claude-hook.mjs` (неполная копия ядра).
 */
function makeGlobalDir({ empty = false, missing = false, coreMissing = false } = {}) {
  const globalDir = tmp('reg-rails-global-');
  if (missing) return globalDir;
  const rails = join(globalDir, 'rails');
  mkdirSync(rails, { recursive: true });
  if (coreMissing) {
    writeFileSync(join(rails, 'README.md'), '# ядро rails скопировано не полностью\n', 'utf8');
    return globalDir;
  }
  if (!empty) {
    writeFileSync(join(rails, 'claude-hook.mjs'), '// заглушка ядра rails\n', 'utf8');
    writeFileSync(join(rails, 'kilo-plugin.mjs'), 'export const WorkflowRails = {};\n', 'utf8');
  }
  return globalDir;
}

/** Проект с `.workflow/` — то, что register-rails считает пригодным корнем. */
function makeProject(prefix = 'reg-rails-project-') {
  const root = tmp(prefix);
  mkdirSync(join(root, '.workflow'), { recursive: true });
  return root;
}

function withGlobalDir(globalDir, fn) {
  const prev = process.env.WORKFLOW_HOME;
  process.env.WORKFLOW_HOME = globalDir;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.WORKFLOW_HOME;
    else process.env.WORKFLOW_HOME = prev;
  }
}

function readSettings(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Запись хука rails для события: та, что помечена `_workflow_rails`. */
function railsHookEntry(settings, event) {
  const groups = settings.hooks?.[event];
  if (!Array.isArray(groups)) return null;
  for (const group of groups) {
    const hit = (group.hooks || []).find((h) => h._workflow_rails === true);
    if (hit) return hit;
  }
  return null;
}

/**
 * В каталоге нет записи с таким именем — ни настоящего каталога, ни живой
 * ссылки, ни дохлой (junction с удалённой или никогда не существовавшей целью).
 *
 * Почему не `existsSync` и не `isJunction`: оба идут ПО ссылке и на дохлый
 * junction отвечают false (`isJunction` гасит такой случай на своём `existsSync`,
 * src/junction-manager.mjs:43-45). Проверено запуском на этой машине:
 * `mklink /J` на несуществующую цель проходит успешно, запись в каталоге есть,
 * при этом existsSync=false, isJunction=false, а lstat видит ссылку. Для рельсов
 * это и есть худший исход отказа: `.workflow/src/rails` в проекте человека
 * присутствует, хуки зарегистрированы, ядра за ссылкой нет — рельсы выглядят
 * установленными и молчат.
 */
function noEntry(path) {
  try {
    lstatSync(path);
    return false;
  } catch (err) {
    if (err.code === 'ENOENT') return true;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Страховка: настоящие настройки пользователя до и после всего файла
// ---------------------------------------------------------------------------

const REAL_USER_SETTINGS = join(homedir(), '.claude', 'settings.json');
let realSettingsFingerprint = null;

function fingerprint(path) {
  if (!existsSync(path)) return 'ОТСУТСТВУЕТ';
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

before(() => {
  realSettingsFingerprint = fingerprint(REAL_USER_SETTINGS);
});

after(() => {
  assert.equal(
    fingerprint(REAL_USER_SETTINGS),
    realSettingsFingerprint,
    `${REAL_USER_SETTINGS} изменился за прогон. Регистрацию хуков в настоящих настройках правит только человек — ` +
      'тест, который её трогает, ломает рабочее окружение вне репозитория'
  );
});

// ---------------------------------------------------------------------------
// Проектный режим
// ---------------------------------------------------------------------------

test('registerRails: в проекте появляются junction на ядро, хуки Claude, загрузчик Kilo и строка в .gitignore', () => {
  const globalDir = makeGlobalDir();
  const root = makeProject();

  const result = withGlobalDir(globalDir, () => registerRails(root));

  const railsDir = join(root, '.workflow', 'src', 'rails');
  assert.ok(isJunction(railsDir), '.workflow/src/rails обязан быть ссылкой на глобальное ядро, а не копией');
  assert.ok(
    existsSync(join(railsDir, 'claude-hook.mjs')),
    'через ссылку обязано быть видно ядро: без claude-hook.mjs хук Claude указывает в никуда и рельсы молча выключены'
  );
  assert.equal(result.railsDir, railsDir);

  const settings = readSettings(result.settings);
  assert.equal(result.settings, join(root, '.claude', 'settings.local.json'), 'хуки проекта идут в settings.local.json проекта');
  const expectedCommand = join(root, '.workflow', 'src', 'rails', 'claude-hook.mjs');
  for (const event of HOOK_EVENTS) {
    const hook = railsHookEntry(settings, event);
    assert.ok(hook, `${event}: без записи хука рельсы на этом событии не работают вовсе`);
    assert.equal(hook.type, 'command');
    assert.ok(
      hook.command.includes(expectedCommand),
      `${event}: путь хука обязан быть абсолютным путём проекта — относительный сломается при смене рабочего каталога сессии`
    );
  }

  const loader = readFileSync(result.loader, 'utf8');
  assert.equal(result.loader, join(root, '.kilo', 'plugin', 'workflow-rails.js'));
  assert.match(loader, /WorkflowRails/, 'загрузчик Kilo обязан реэкспортировать плагин, иначе Kilo рельсы не подхватит');

  assert.match(
    readFileSync(join(root, '.gitignore'), 'utf8'),
    /^\.workflow\/state\/$/m,
    'без этой строки состояние рельсов уедет в чужой коммит'
  );
});

test('registerRails: повторный вызов не плодит строку в .gitignore и не стирает чужие строки', () => {
  const globalDir = makeGlobalDir();
  const root = makeProject();
  writeFileSync(join(root, '.gitignore'), 'node_modules/\ncoverage/\n', 'utf8');

  withGlobalDir(globalDir, () => {
    registerRails(root);
    registerRails(root);
  });

  const lines = readFileSync(join(root, '.gitignore'), 'utf8').split(/\r?\n/).filter(Boolean);
  assert.deepEqual(
    lines.filter((l) => l.trim() === '.workflow/state/').length,
    1,
    'строка дописывается один раз: повторная регистрация не должна отращивать .gitignore на каждый запуск'
  );
  assert.ok(lines.includes('node_modules/') && lines.includes('coverage/'), 'чужие строки .gitignore обязаны уцелеть');
});

// ---------------------------------------------------------------------------
// Отказы: ничего не должно быть записано
// ---------------------------------------------------------------------------

test('registerRails: нет <globalDir>/rails — отказ с названным путём, и в проекте ничего не создано', () => {
  const globalDir = makeGlobalDir({ missing: true });
  const root = makeProject();

  assert.throws(
    () => withGlobalDir(globalDir, () => registerRails(root)),
    (err) => {
      assert.match(err.message, /отсутствует или пуст/);
      assert.ok(err.message.includes(join(globalDir, 'rails')), 'сообщение обязано назвать путь, который человеку чинить');
      assert.match(err.message, /workflow update/, 'сообщение обязано назвать способ починки');
      return true;
    }
  );

  assert.ok(!existsSync(join(root, '.claude')), 'при отказе хуки не пишутся: хук с путём в никуда молча выключает рельсы');
  assert.ok(
    noEntry(join(root, '.workflow', 'src', 'rails')),
    'при отказе ссылки на ядро не создаётся ВООБЩЕ никакой: дохлый junction в проекте — это рельсы, которые выглядят установленными и молчат'
  );
  assert.ok(!existsSync(join(root, '.gitignore')), 'при отказе чужой .gitignore не трогается');
});

test('registerRails: <globalDir>/rails существует, но пуст — тот же отказ (ядро не скопировано)', () => {
  const globalDir = makeGlobalDir({ empty: true });
  const root = makeProject();

  assert.throws(
    () => withGlobalDir(globalDir, () => registerRails(root)),
    /отсутствует или пуст/,
    'пустой каталог ядра — не установленное ядро: ссылка на него дала бы рабочий на вид проект с мёртвыми хуками'
  );
  assert.ok(!existsSync(join(root, '.claude')), 'при отказе хуки не пишутся');
  const railsDir = join(root, '.workflow', 'src', 'rails');
  assert.ok(
    !isJunction(railsDir),
    'ссылка на пустое ядро не создаётся: иначе в проекте человека появляются рельсы, которые выглядят установленными, а за ссылкой пусто'
  );
  assert.ok(
    noEntry(railsDir),
    'после отказа записи .workflow/src/rails быть не должно даже дохлой ссылкой: existsSync такую ссылку не видит, а Claude Code по ней уже ходит'
  );
});

test('registerRails: ядро скопировано не полностью (нет claude-hook.mjs) — отказ до записи хуков', () => {
  const globalDir = makeGlobalDir({ coreMissing: true });
  const root = makeProject();

  assert.throws(
    () => withGlobalDir(globalDir, () => registerRails(root)),
    /ядро rails недоступно после junction/,
    'проверка после создания ссылки обязательна: каталог ядра бывает не пуст, но без самого хука'
  );

  assert.ok(
    !existsSync(join(root, '.claude')),
    'хуки не пишутся, пока хук-скрипт не найден: запись с путём к несуществующему файлу молча выключает рельсы во всех сессиях проекта'
  );
  assert.ok(!existsSync(join(root, '.kilo')), 'загрузчик Kilo при отказе тоже не пишется');
});

test('registerRails: каталог без .workflow/ — отказ и ни одного файла в чужом каталоге', () => {
  const globalDir = makeGlobalDir();
  const notAProject = tmp('reg-rails-notaproject-');
  writeFileSync(join(notAProject, 'README.md'), 'чужой каталог\n', 'utf8');

  assert.throws(
    () => withGlobalDir(globalDir, () => registerRails(notAProject)),
    /нет \.workflow\//,
    'регистрация в каталоге без проекта разложила бы хуки и .kilo в случайную папку человека'
  );

  assert.ok(!existsSync(join(notAProject, '.claude')), 'чужой каталог обязан остаться нетронутым');
  assert.ok(!existsSync(join(notAProject, '.kilo')), 'чужой каталог обязан остаться нетронутым');
  assert.deepEqual(readFileSync(join(notAProject, 'README.md'), 'utf8'), 'чужой каталог\n');
});

// ---------------------------------------------------------------------------
// Зонтик над проектами
// ---------------------------------------------------------------------------

test('registerRails --umbrella: только хуки с путём к глобальному ядру, без junction и без Kilo-загрузчика', () => {
  const globalDir = makeGlobalDir();
  const root = tmp('reg-rails-umbrella-');

  const result = withGlobalDir(globalDir, () => registerRails(root, { umbrella: true }));

  assert.equal(result.umbrella, true);
  assert.equal(result.railsDir, null, 'у зонтика нет своего .workflow/, ссылке на ядро там взяться неоткуда');
  assert.equal(result.loader, null, 'Kilo читает конфиг проекта, зонтику загрузчик не нужен');
  assert.ok(!existsSync(join(root, '.kilo')), 'зонтик не должен получать каталог .kilo');

  const settings = readSettings(result.settings);
  const expectedCommand = join(globalDir, 'rails', 'claude-hook.mjs');
  for (const event of HOOK_EVENTS) {
    const hook = railsHookEntry(settings, event);
    assert.ok(hook, `${event}: запись хука обязана быть`);
    assert.ok(
      hook.command.includes(expectedCommand),
      `${event}: у зонтика путь хука — глобальное ядро; путь вида <зонтик>/.workflow/… указывал бы в несуществующий каталог`
    );
  }
});

test('registerRails --umbrella: битый settings.local.json не перезаписывается, регистрация отказывает', () => {
  const globalDir = makeGlobalDir();
  const root = tmp('reg-rails-badjson-');
  const settingsPath = join(root, '.claude', 'settings.local.json');
  mkdirSync(dirname(settingsPath), { recursive: true });
  const original = '{ это не JSON, а заметка человека\n';
  writeFileSync(settingsPath, original, 'utf8');

  assert.throws(
    () => withGlobalDir(globalDir, () => registerRails(root, { umbrella: true })),
    /не удалось слить/,
    'молчаливый успех на битом файле означал бы, что хуков нет, а человек считает их поставленными'
  );
  assert.equal(
    readFileSync(settingsPath, 'utf8'),
    original,
    'чужой файл обязан остаться байт в байт: начать с пустого объекта — значит стереть чужие ключи'
  );
});

// ---------------------------------------------------------------------------
// Снятие хуков
// ---------------------------------------------------------------------------

test('unregisterRails: снимает только записи rails, чужие хуки и чужие ключи остаются', () => {
  const globalDir = makeGlobalDir();
  const root = makeProject();
  const settingsPath = join(root, '.claude', 'settings.local.json');

  withGlobalDir(globalDir, () => registerRails(root));

  // Чужая запись в том же событии и чужой ключ верхнего уровня.
  const settings = readSettings(settingsPath);
  settings.hooks.PreToolUse.unshift({ matcher: 'Bash', hooks: [{ type: 'command', command: 'node чужой-хук.mjs' }] });
  settings.permissions = { allow: ['Bash(git status:*)'] };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');

  const returned = unregisterRails(root);
  assert.equal(returned, settingsPath, 'функция обязана вернуть путь, который человеку показать');

  const after = readSettings(settingsPath);
  assert.equal(railsHookEntry(after, 'PreToolUse'), null, 'записи rails обязаны исчезнуть — иначе снятие рельсов их не снимает');
  assert.equal(
    JSON.stringify(after.hooks.PreToolUse),
    JSON.stringify([{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node чужой-хук.mjs' }] }]),
    'чужой хук обязан уцелеть дословно'
  );
  assert.deepEqual(after.permissions, { allow: ['Bash(git status:*)'] }, 'чужие ключи верхнего уровня не трогаются');
});

test('unregisterRails: в проекте без settings.local.json — null, и файл не создаётся', () => {
  const root = makeProject();

  assert.equal(
    unregisterRails(root),
    null,
    'нечего снимать — обязан быть честный null, а не путь к файлу, которого нет'
  );
  assert.ok(!existsSync(join(root, '.claude', 'settings.local.json')), 'снятие хуков не должно создавать настройки');
});

test('userSettingsPath: ровно <домашний каталог>/.claude/settings.json', () => {
  assert.equal(
    userSettingsPath(),
    join(homedir(), '.claude', 'settings.json'),
    'по этому пути пишет режим --user: промах здесь означает хуки не там, где их ищет Claude Code'
  );
});

// ---------------------------------------------------------------------------
// CLI: разбор аргументов, сообщения, коды выхода
//
// Режим --user идёт дочерним процессом с подменённым домашним каталогом:
// подмены внутри процесса os.homedir() не видит, а писать в настоящие
// ~/.claude настройки тесту запрещено.
// ---------------------------------------------------------------------------

function runCli(args, { globalDir, home = null, cwd = PROJECT_ROOT } = {}) {
  const env = { ...process.env, WORKFLOW_HOME: globalDir };
  if (home) {
    env.USERPROFILE = home;
    env.HOME = home;
  }
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

test('CLI: позиционный аргумент — корень проекта; сообщение называет все три записанных места', () => {
  const globalDir = makeGlobalDir();
  const root = makeProject();

  const r = runCli([root], { globalDir });

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /rails зарегистрированы:/);
  assert.match(r.stdout, /junction:/, 'человек должен увидеть, где теперь лежит ссылка на ядро');
  assert.match(r.stdout, /claude:/, 'человек должен увидеть, в какой файл настроек попали хуки');
  assert.match(r.stdout, /kilo:/, 'человек должен увидеть путь загрузчика Kilo');
  assert.match(r.stdout, /Перезапусти сессию/, 'без перезапуска сессии хуки не загрузятся — об этом обязано быть сказано');
  assert.ok(existsSync(join(root, '.claude', 'settings.local.json')), 'хуки обязаны появиться в указанном проекте');
});

test('CLI: --umbrella называет каталог-зонтик, а не пользователя', () => {
  const globalDir = makeGlobalDir();
  const root = tmp('reg-rails-cli-umbrella-');

  const r = runCli(['--umbrella', root], { globalDir });

  assert.equal(r.code, 0, r.stderr);
  assert.match(
    r.stdout,
    new RegExp(`на уровне зонтика ${root.replace(/[\\^$*+?.()|[\]{}]/g, '\\$&')}`),
    'сообщение обязано назвать именно тот каталог, куда легли хуки: иначе человек не поймёт, что чинить'
  );
  assert.ok(!existsSync(join(root, '.kilo')), 'зонтику загрузчик Kilo не ставится');
});

test('CLI: каталог без .workflow/ — код выхода 1 и причина на stderr', () => {
  const globalDir = makeGlobalDir();
  const notAProject = tmp('reg-rails-cli-notaproject-');

  const r = runCli([notAProject], { globalDir });

  assert.equal(
    r.code,
    1,
    'ненулевой код — единственное, по чему вызывающий скрипт поймёт, что рельсы не зарегистрированы'
  );
  assert.match(r.stderr, /register-rails: /, 'сообщение обязано быть подписано скриптом, чтобы его нашли в логе');
  assert.match(r.stderr, /нет \.workflow\//, 'причина обязана быть названа, а не сведена к стектрейсу');
  assert.ok(!existsSync(join(notAProject, '.claude')), 'после отказа чужой каталог пуст');
});

test('CLI --user: хуки пишутся в <домашний каталог>/.claude/settings.json подменённого дома', () => {
  const globalDir = makeGlobalDir();
  const home = tmp('reg-rails-fakehome-');

  const r = runCli(['--user'], { globalDir, home });

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /на уровне пользователя/, 'сообщение обязано отличать машинную регистрацию от проектной');

  const settingsPath = join(home, '.claude', 'settings.json');
  assert.ok(existsSync(settingsPath), 'хуки обязаны лечь ровно в settings.json домашнего каталога');

  const settings = readSettings(settingsPath);
  const expectedCommand = join(globalDir, 'rails', 'claude-hook.mjs');
  for (const event of HOOK_EVENTS) {
    const hook = railsHookEntry(settings, event);
    assert.ok(hook, `${event}: запись хука обязана быть`);
    assert.ok(
      hook.command.includes(expectedCommand),
      `${event}: машинный хук обязан указывать на глобальное ядро — проектного пути у сессии вне проекта нет`
    );
  }

  assert.ok(!existsSync(join(home, '.kilo')), 'машинная регистрация ставит только хуки Claude');
  assert.ok(!existsSync(join(home, '.workflow', 'src', 'rails')), 'машинная регистрация не создаёт ссылку на ядро в доме');
});

test('CLI --user --unregister: снимает хуки из подменённого дома и говорит, что снял', () => {
  const globalDir = makeGlobalDir();
  const home = tmp('reg-rails-fakehome-unreg-');

  assert.equal(runCli(['--user'], { globalDir, home }).code, 0);
  const settingsPath = join(home, '.claude', 'settings.json');
  assert.ok(railsHookEntry(readSettings(settingsPath), 'PreToolUse'), 'предпосылка: хуки поставлены');

  const r = runCli(['--user', '--unregister'], { globalDir, home });

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /хуки rails сняты/, 'человеку нужно подтверждение, что снятие состоялось');
  assert.ok(r.stdout.includes(settingsPath), 'сообщение обязано назвать изменённый файл');
  assert.equal(
    railsHookEntry(readSettings(settingsPath), 'PreToolUse'),
    null,
    'после снятия записей rails остаться не должно: иначе хук продолжает запускаться после «снятия»'
  );
});

test('CLI --user: битый ~/.claude/settings.json не перезаписывается, регистрация отказывает', () => {
  const globalDir = makeGlobalDir();
  const home = tmp('reg-rails-fakehome-badjson-');
  const settingsPath = join(home, '.claude', 'settings.json');
  mkdirSync(dirname(settingsPath), { recursive: true });
  const original = '{ "hooks": [это не объект, а массив\n';
  writeFileSync(settingsPath, original, 'utf8');

  const r = runCli(['--user'], { globalDir, home });

  assert.equal(r.code, 1, 'молчаливый нулевой код оставил бы человека с уверенностью, что машинные хуки поставлены');
  assert.match(r.stderr, /не удалось слить hooks/, 'причина обязана быть названа');
  assert.ok(r.stderr.includes(settingsPath), 'сообщение обязано назвать файл настроек, который человеку разбирать');
  assert.equal(
    readFileSync(settingsPath, 'utf8'),
    original,
    'машинные настройки обязаны остаться байт в байт: это файл, который правит только человек'
  );
});

test('CLI --user --unregister: снимать нечего — сообщение называет файл настроек того дома, где искали', () => {
  const globalDir = makeGlobalDir();
  const home = tmp('reg-rails-fakehome-nothing-');

  const r = runCli(['--user', '--unregister'], { globalDir, home });

  assert.equal(r.code, 0, 'нечего снимать — это не ошибка');
  assert.match(r.stdout, /не найдены|ничего не менял/, 'сообщение обязано сказать, что файл не тронут');
  assert.ok(
    r.stdout.includes(join(home, '.claude', 'settings.json')),
    'в машинном режиме сообщение обязано назвать settings.json домашнего каталога, а не переданный путь: иначе человек ищет хуки не там, где скрипт смотрел'
  );
  assert.ok(!existsSync(join(home, '.claude', 'settings.json')), 'снятие хуков не должно создавать машинные настройки');
});

test('CLI --unregister: снимать нечего — честное сообщение и нулевой код', () => {
  const globalDir = makeGlobalDir();
  const root = makeProject();

  const r = runCli(['--unregister', root], { globalDir });

  assert.equal(r.code, 0, 'нечего снимать — это не ошибка');
  assert.match(
    r.stdout,
    /не найдены|ничего не менял/,
    'сообщение обязано сказать, что файл не тронут: «снято» на нетронутом файле ввело бы человека в заблуждение'
  );
  assert.ok(r.stdout.includes(root), 'сообщение обязано назвать каталог, в котором искали');
});

test('register-rails.js: подключение модулем без входного файла ничего не регистрирует', () => {
  const globalDir = makeGlobalDir();
  const root = makeProject();

  // process.argv[1] пуст — так выглядит подключение через `node -e`, `--import`
  // или импорт из другого скрипта (проверено запуском: argv у `node -e` длиной 1).
  const code = "import(process.env.__MOD).then(() => console.log('IMPORT-DONE'))";
  const stdout = execFileSync(process.execPath, ['-e', code], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WORKFLOW_HOME: globalDir, __MOD: pathToFileURL(SCRIPT).href },
  });

  assert.match(stdout, /IMPORT-DONE/, 'импорт обязан завершиться: process.exit(1) внутри оборвал бы хозяина');
  assert.ok(
    !existsSync(join(root, '.claude')),
    'импорт модуля не должен регистрировать хуки в текущем каталоге: так рельсы приезжают в чужой проект без ведома человека'
  );
  assert.ok(!existsSync(join(root, '.kilo')), 'импорт модуля не должен создавать загрузчик Kilo');
  assert.ok(!existsSync(join(root, '.gitignore')), 'импорт модуля не должен дописывать чужой .gitignore');
});
