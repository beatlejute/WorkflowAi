#!/usr/bin/env node

/**
 * scripts-check-rails-wrappers.test.mjs — развязка результата у двух обёрток
 * над `rails cli`: `src/scripts/check-rails-coverage.js` и
 * `src/scripts/check-rails-graph.js`.
 *
 * Зачем файл появился. Обе обёртки живут по конвенции `check-mcp.js`: код
 * выхода ВСЕГДА 0, а логический результат — в блоке `---RESULT---`, который
 * читает раннер. Значит единственное, что отделяет «скил переведён начисто» от
 * «половина инвариантов потеряна», — одна строка `status:` и одна строка
 * `reason:`. Раньше у `check-rails-coverage.js` был прогон только по исходу
 * «есть непокрытые фразы»: ветка успеха не исполнялась ни разу, и подмена
 * местами двух тернарников (или их текстов) прошла бы мимо всех тестов — гейт
 * конверсии либо пропустил бы непокрытый скил как зелёный, либо вечно краснел
 * бы на полностью покрытом.
 *
 * Второй сюжет файла — определение прямого запуска. Обёртка обязана выполнять
 * проверку ТОЛЬКО когда её саму запустили файлом. Если она станет считать
 * прямым запуском и случай «входного файла нет вовсе» (`node -e`, `--import`,
 * подключение из другого скрипта), то простой импорт модуля выполнит полную
 * проверку, напечатает чужому процессу свой блок `---RESULT---` и убьёт его
 * `process.exit(0)` — раннер получит результат стадии, которую никто не звал.
 *
 * Все фикстуры — во временных каталогах: git-репозиторий базовой версии
 * создаётся заново под каждый тест, репозиторий проекта не трогается.
 *
 * Запуск:
 *   node --test --import ./src/tests/_rails-home.mjs src/tests/scripts-check-rails-wrappers.test.mjs
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../..');
const SCRIPTS_DIR = join(PROJECT_ROOT, 'src', 'scripts');
const CHECK_COVERAGE = join(SCRIPTS_DIR, 'check-rails-coverage.js');
const CHECK_GRAPH = join(SCRIPTS_DIR, 'check-rails-graph.js');

// Фраза-инвариант базовой версии: строка с ⛔ длиннее 25 символов — ровно то,
// что §12 требует не терять при переводе прозы скила в граф.
const INVARIANT = '⛔ Коуч не выполняет git-операции — коммит делает исключительно пользователь.';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** Запуск скрипта-обёртки настоящим процессом node; код выхода и весь вывод. */
function runScript(scriptPath, args, cwd) {
  try {
    // stdio задан явно: иначе execFileSync дублирует stderr скрипта в вывод прогона.
    const stdout = execFileSync(process.execPath, [scriptPath, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status ?? 1, stdout: (err.stdout || '') + (err.stderr || '') };
  }
}

/** Поля блока `---RESULT---` — то, что из вывода читает раннер. */
function parseResult(stdout) {
  const marker = '---RESULT---';
  const start = stdout.indexOf(marker);
  const end = stdout.indexOf(marker, start + marker.length);
  if (start === -1 || end === -1) return null;
  const out = {};
  for (const line of stdout.slice(start + marker.length, end).split('\n')) {
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (m) out[m[1].trim()] = m[2].trim();
  }
  return out;
}

/**
 * Проект с git-репозиторием и скилом, у которого базовая (дографовая) версия
 * лежит в коммите. Возвращает корень проекта и sha базовой версии.
 */
function makeSkillRepo(skill) {
  const base = mkdtempSync(join(tmpdir(), 'wrappers-'));
  const root = join(base, 'root');
  const skillDir = join(root, '.workflow', 'src', 'skills', skill);
  mkdirSync(skillDir, { recursive: true });
  git(['init', '--quiet'], root);
  git(['config', 'user.email', 'test@example.com'], root);
  git(['config', 'user.name', 'Test'], root);
  // Без этого git на Windows пишет в stderr предупреждение про LF→CRLF на каждый файл
  // фикстуры: чужой шум в выводе прогона мешает читать настоящие падения.
  git(['config', 'core.autocrlf', 'false'], root);
  writeFileSync(join(skillDir, 'SKILL.md'), `# Скил ${skill}\n\n${INVARIANT}\n`, 'utf8');
  git(['add', '-A'], root);
  git(['commit', '--quiet', '-m', 'baseline'], root);
  const baselineRef = git(['rev-parse', 'HEAD'], root).trim();
  return { base, root, skillDir, baselineRef };
}

// --- check-rails-coverage.js: обе стороны развязки результата -------------------------

test('check-rails-coverage.js: инвариант базовой версии остался в скиле -> status: ok', () => {
  const { base, root, baselineRef } = makeSkillRepo('covok');
  try {
    const r = runScript(CHECK_COVERAGE, ['--skill', 'covok', '--baseline', baselineRef], root);
    const data = parseResult(r.stdout);

    assert.ok(data, `блок ---RESULT--- обязателен, раннер читает только его. Вывод:\n${r.stdout}`);
    assert.equal(
      data.status,
      'ok',
      'полностью покрытый скил обязан получить ok: иначе гейт конверсии красный всегда и перестаёт что-либо значить'
    );
    assert.equal(
      data.reason,
      'все фразы-инварианты покрыты',
      'причина успеха идёт в отчёт человеку — она не должна говорить о непокрытых фразах'
    );
    assert.equal(r.code, 0, 'конвенция check-mcp.js: код выхода всегда 0, результат — в status');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('check-rails-coverage.js: инвариант потерян при конверсии -> status: fail и названная причина', () => {
  const { base, root, skillDir, baselineRef } = makeSkillRepo('covfail');
  try {
    // Конверсия «в граф», при которой фраза-инвариант не перенесена никуда.
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '# Скил covfail\n\n```mermaid\ngraph TD\n    P1E1["П1 ВХОД: начало этапа"]\n```\n',
      'utf8'
    );

    const r = runScript(CHECK_COVERAGE, ['--skill', 'covfail', '--baseline', baselineRef], root);
    const data = parseResult(r.stdout);

    assert.ok(data, `блок ---RESULT--- обязателен. Вывод:\n${r.stdout}`);
    assert.equal(
      data.status,
      'fail',
      'скил с потерянным инвариантом обязан получить fail: иначе непокрытая конверсия проезжает гейт как зелёная'
    );
    assert.equal(
      data.reason,
      'есть непокрытые фразы — см. вывод выше',
      'причина обязана отправить человека к перечню потерянных фраз выше'
    );
    assert.match(
      r.stdout,
      /Непокрытые фразы:/,
      'перечень потерянных фраз обязан быть напечатан до блока результата — иначе по fail нечего чинить'
    );
    assert.equal(r.code, 0, 'конвенция check-mcp.js: код выхода всегда 0, результат — в status');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// --- определение прямого запуска: входного файла нет ----------------------------------
//
// `node -e` (и `--import`, и любое подключение обёртки как модуля) оставляет
// process.argv[1] пустым. Обёртка обязана в этом случае промолчать.

function importWithoutEntryFile(scriptPath, cwd) {
  // Дочерний процесс без входного файла: process.argv[1] === undefined
  // (проверено запуском: `node -e "…"` даёт argv длиной 1).
  const code = "import(process.env.__MOD).then(() => console.log('IMPORT-DONE'))";
  try {
    const stdout = execFileSync(process.execPath, ['-e', code], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, __MOD: pathToFileURL(scriptPath).href },
    });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status ?? 1, stdout: (err.stdout || '') + (err.stderr || '') };
  }
}

test('check-rails-coverage.js: подключение модулем без входного файла не запускает проверку', () => {
  const { base, root } = makeSkillRepo('covimport');
  try {
    const r = importWithoutEntryFile(CHECK_COVERAGE, root);

    assert.doesNotMatch(
      r.stdout,
      /---RESULT---/,
      'обёртка, подключённая как модуль, не должна печатать чужому процессу блок результата: раннер зачтёт стадию, которую никто не запускал'
    );
    assert.match(
      r.stdout,
      /IMPORT-DONE/,
      'после импорта процесс обязан продолжить работу: main() внутри вызывает process.exit(0) и оборвал бы хозяина'
    );
    assert.equal(r.code, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('check-rails-graph.js: подключение модулем без входного файла не запускает проверку', () => {
  const { base, root } = makeSkillRepo('graphimport');
  try {
    const r = importWithoutEntryFile(CHECK_GRAPH, root);

    assert.doesNotMatch(
      r.stdout,
      /---RESULT---/,
      'обёртка, подключённая как модуль, не должна печатать чужому процессу блок результата'
    );
    assert.match(
      r.stdout,
      /IMPORT-DONE/,
      'после импорта процесс обязан продолжить работу, а не умереть от process.exit(0) внутри обёртки'
    );
    assert.equal(r.code, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
