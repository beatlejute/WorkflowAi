/**
 * Исполнитель проверок DoD и разбор их записи (src/lib/check-runner.mjs, PLAN-002,
 * задачи 12–13): каждое правило «Ограничений исполнителя проверок», каждый вид
 * expect, усечение вывода, предел его хранения, таймаут с укороченным параметром
 * и четыре формы записи проверки под пунктом DoD; та же запись без пункта — строка
 * «Проверка:» плана (PLAN-002, задача 3) — разбирается так же.
 *
 * Рабочий корень — временный каталог ОС; удаляется в after.
 *
 * Запуск: node --import ./src/tests/_rails-home.mjs --test src/tests/check-runner.test.mjs
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  runCheck,
  parseDodChecks,
  parseCheckRecord,
  isDodFormat2,
  CHECK_TIMEOUT_MS,
  CHECK_OUTPUT_LIMIT,
  CHECK_CAPTURE_LIMIT
} from '../lib/check-runner.mjs';

let root;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-runner-'));
  fs.writeFileSync(path.join(root, 'probe.txt'), 'probe', 'utf8');
  // Пишет файл-маркер с именем из первого аргумента: программа для опций, которые
  // запускают указанный исполняемый файл (git grep -O).
  fs.writeFileSync(path.join(root, 'mark.js'), "require('fs').writeFileSync(process.argv[2], '')", 'utf8');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'check-runner-fixture',
    private: true,
    scripts: {
      test: 'node -e "process.exit(0)"',
      probe: 'node -e "process.stdout.write(\'probe-script\')"',
      sleeper: 'node -e "setTimeout(() => require(\'fs\').writeFileSync(\'tree-marker\', \'\'), 8000)"'
    }
  }), 'utf8');
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function run(check, expect = 'exit 0', options = {}) {
  return runCheck({ check, expect, projectRoot: root, ...options });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Отказ без запуска: команда пишет файл-маркер первым же действием, и после
 * отказа маркера нет.
 */
async function assertDeniedBeforeStart(check, reasonPrefix, expect = 'exit 0') {
  const marker = `started-${Math.random().toString(36).slice(2)}`;
  const result = await run(check.replaceAll('{marker}', marker), expect);
  assert.equal(result.status, 'denied', `${check}: ${JSON.stringify(result)}`);
  assert.ok(result.reason.startsWith(reasonPrefix), `${check}: причина ${result.reason}`);
  assert.equal(result.exit_code, null);
  assert.equal(result.duration_ms, 0);
  assert.equal(fs.existsSync(path.join(root, marker)), false, `${check}: процесс запускался`);
}

const WRITE_MARKER = 'node -e "require(\'fs\').writeFileSync(\'{marker}\', \'\')"';

// ---------------------------------------------------------------------------
// Критерии приёмки задачи 12
// ---------------------------------------------------------------------------

test('node -e с expect exit 0 даёт passed', async () => {
  const result = await run('node -e "process.exit(0)"', 'exit 0');
  assert.equal(result.status, 'passed');
  assert.equal(result.exit_code, 0);
  assert.equal(result.reason, null);
  assert.equal(typeof result.duration_ms, 'number');
});

test('curl даёт denied', async () => {
  const result = await run('curl https://example.com', 'exit 0');
  assert.equal(result.status, 'denied');
  assert.equal(result.reason, 'executable_not_allowed: curl');
});

test('node a.js; rm x даёт denied', async () => {
  const result = await run('node a.js; rm x', 'exit 0');
  assert.equal(result.status, 'denied');
  assert.equal(result.reason, 'shell_operator: ;');
});

test('команда дольше таймаута даёт timeout, процесс завершается', async () => {
  assert.equal(CHECK_TIMEOUT_MS, 120_000);
  // Граница — время жизни самой команды, а не фиксированные 2 с: под c8 и полным
  // параллельным набором на Windows снятие дерева taskkill заняло больше 2 с
  // (прогон coverage 2026-09-26: ответ через 2513 мс при таймауте 300 мс).
  const LATE_MS = 8000;
  const started = Date.now();
  const result = await run(
    `node -e "setTimeout(() => require('fs').writeFileSync('late-marker', ''), ${LATE_MS})"`,
    'exit 0',
    { timeoutMs: 300 }
  );
  assert.equal(result.status, 'timeout');
  assert.equal(result.reason, 'timeout_ms: 300');
  assert.ok(Date.now() - started < LATE_MS, `ответ пришёл не раньше, чем команда закончилась бы сама: ${Date.now() - started} мс`);
  await sleep(Math.max(0, LATE_MS + 500 - (Date.now() - started)));
  assert.equal(fs.existsSync(path.join(root, 'late-marker')), false, 'процесс пережил таймаут');
});

test('таймаут снимает дерево процессов: дочерний node под npm тоже завершается', async () => {
  // Внук пишет маркер через 8 с — с запасом над таймаутом и снятием дерева под
  // нагрузкой (taskkill под c8 занимал больше 2 с, см. тест выше).
  const started = Date.now();
  const result = await run('npm run sleeper', 'exit 0', { timeoutMs: 1500 });
  assert.equal(result.status, 'timeout');
  await sleep(Math.max(0, 8500 - (Date.now() - started)));
  assert.equal(fs.existsSync(path.join(root, 'tree-marker')), false, 'дочерний процесс пережил таймаут');
});

// ---------------------------------------------------------------------------
// Разрешённые исполняемые файлы
// ---------------------------------------------------------------------------

test('npm test и npm run <скрипт> исполняются', async () => {
  assert.equal((await run('npm test', 'exit 0')).status, 'passed');
  const script = await run('npm run probe', 'stdout contains probe-script');
  assert.equal(script.status, 'passed', JSON.stringify(script));
});

test('npm run <скрипт> -- <аргументы> проходит ограничения', async () => {
  const result = await run('npm run probe -- extra', 'stdout contains probe-script');
  assert.equal(result.status, 'passed', JSON.stringify(result));
});

test('git: каждая разрешённая подкоманда проходит ограничения', async () => {
  for (const subcommand of ['status', 'diff', 'log', 'show', 'ls-files', 'rev-parse', 'grep']) {
    const result = await run(`git ${subcommand}`, 'exit 0');
    assert.notEqual(result.status, 'denied', `git ${subcommand}: ${result.reason}`);
  }
});

test('pytest, python, dotnet, rg, grep проходят ограничения', async () => {
  // Установлены они не везде: отсутствующий файл даёт failed (spawn_failed), а не denied.
  for (const executable of ['pytest', 'python', 'dotnet', 'rg', 'grep']) {
    const result = await run(`${executable} --version`, 'exit 0');
    assert.notEqual(result.status, 'denied', `${executable}: ${result.reason}`);
  }
});

// ---------------------------------------------------------------------------
// Запрещено
// ---------------------------------------------------------------------------

test('прочие исполняемые файлы — denied', async () => {
  for (const executable of ['curl', 'wget', 'npx', 'rm', 'del', 'rmdir', 'Remove-Item', 'bash', 'cmd']) {
    await assertDeniedBeforeStart(`${executable} x`, `executable_not_allowed: ${executable}`);
  }
});

test('npm: кроме test и run <скрипт> — denied', async () => {
  await assertDeniedBeforeStart('npm install left-pad', 'npm_subcommand_not_allowed: install');
  await assertDeniedBeforeStart('npm', 'npm_subcommand_not_allowed');
  await assertDeniedBeforeStart('npm run', 'npm_run_without_script');
  await assertDeniedBeforeStart('npm run --silent probe', 'npm_run_without_script');
  // Опции самого npm: --script-shell запустил бы скрипт другим исполняемым файлом.
  await assertDeniedBeforeStart('npm test --script-shell=curl', 'option_not_allowed: npm --script-shell=curl');
  await assertDeniedBeforeStart('npm run probe --script-shell=curl', 'option_not_allowed: npm');
});

test('git: другие подкоманды, глобальные опции и запуск пейджера — denied', async () => {
  await assertDeniedBeforeStart('git push', 'git_subcommand_not_allowed: push');
  await assertDeniedBeforeStart('git clone https://example.com/x', 'git_subcommand_not_allowed: clone');
  await assertDeniedBeforeStart('git -c core.pager=curl log', 'git_subcommand_not_allowed: -c');
  await assertDeniedBeforeStart('git', 'git_subcommand_not_allowed');
  await assertDeniedBeforeStart('git grep -Ocurl foo', 'option_not_allowed: git -Ocurl');
  await assertDeniedBeforeStart('git grep --open-files-in-pager=curl foo', 'option_not_allowed: git');
});

test('git grep: пейджер через начало длинной опции и цифры в связке — denied', async () => {
  // --no-index ищет в каталоге без репозитория: без отказа git запустил бы
  // `node mark.js <маркер>`, и маркер появился бы.
  const pager = 'node mark.js {marker}';
  await assertDeniedBeforeStart(`git grep --no-index "--open=${pager}" probe`, 'option_not_allowed: git --open=node mark.js');
  await assertDeniedBeforeStart(`git grep --no-index "--open-files=${pager}" probe`, 'option_not_allowed: git --open-files=');
  await assertDeniedBeforeStart(`git grep --no-index "--op=${pager}" probe`, 'option_not_allowed: git --op=');
  await assertDeniedBeforeStart(`git grep --no-index "-3O${pager}" probe`, 'option_not_allowed: git -3Onode mark.js');
  await assertDeniedBeforeStart('git grep --no-index --open probe', 'option_not_allowed: git --open');
});

test('git grep: --or и --only-matching — не пейджер, проходят ограничения', async () => {
  for (const option of ['--or', '--only-matching']) {
    const result = await run(`git grep --no-index -e probe ${option} -e x`, 'exit 0');
    assert.notEqual(result.status, 'denied', `${option}: ${result.reason}`);
  }
});

test('rg --pre и --hostname-bin — denied', async () => {
  await assertDeniedBeforeStart('rg --pre curl foo', 'option_not_allowed: rg --pre');
  await assertDeniedBeforeStart('rg --pre=curl foo', 'option_not_allowed: rg --pre=curl');
  await assertDeniedBeforeStart('rg --hostname-bin curl --hyperlink-format=file://{host}{path} foo', 'option_not_allowed: rg --hostname-bin');
  await assertDeniedBeforeStart('rg --hostname-bin=curl --hyperlink-format=file://{host}{path} foo', 'option_not_allowed: rg --hostname-bin=curl');
});

test('операторы оболочки вне кавычек — denied, процесс не запускается', async () => {
  const cases = [
    [`${WRITE_MARKER} ; node x.js`, 'shell_operator: ;'],
    [`${WRITE_MARKER} && node x.js`, 'shell_operator: &&'],
    [`${WRITE_MARKER} || node x.js`, 'shell_operator: ||'],
    [`${WRITE_MARKER} & node x.js`, 'shell_operator: &'],
    [`${WRITE_MARKER} | node x.js`, 'shell_operator: |'],
    [`${WRITE_MARKER} > out.txt`, 'shell_operator: >'],
    [`${WRITE_MARKER} < in.txt`, 'shell_operator: <'],
    [`${WRITE_MARKER} \`node x.js\``, 'shell_operator: `'],
    [`${WRITE_MARKER} $(node x.js)`, 'shell_operator: $('],
  ];
  for (const [check, reason] of cases) {
    await assertDeniedBeforeStart(check, reason);
  }
});

test('подстановки внутри двойных кавычек — denied, в одинарных — текст', async () => {
  await assertDeniedBeforeStart('node -e "$(node x.js)"', 'shell_operator: $(');
  await assertDeniedBeforeStart('node -e "`node x.js`"', 'shell_operator: `');
  const literal = await run("node -e \"process.stdout.write(process.argv[1])\" '$(x) `y` ; | >'");
  assert.equal(literal.status, 'passed');
  assert.equal(literal.stdout, '$(x) `y` ; | >');
});

test('| и > внутри двойных кавычек — часть аргумента, не оператор', async () => {
  const result = await run('node -e "process.exit(2 > 1 || 0 ? 0 : 1)"', 'exit 0');
  assert.equal(result.status, 'passed', JSON.stringify(result));
});

test('незакрытая кавычка и пустая команда — denied', async () => {
  await assertDeniedBeforeStart('node -e "process.exit(0)', 'unbalanced_quotes');
  await assertDeniedBeforeStart("node -e 'process.exit(0)", 'unbalanced_quotes');
  await assertDeniedBeforeStart('   ', 'empty_command');
  const missing = await runCheck({ expect: 'exit 0', projectRoot: root });
  assert.equal(missing.status, 'denied');
  assert.equal(missing.reason, 'empty_command');
});

// ---------------------------------------------------------------------------
// Запуск без оболочки, рабочий каталог
// ---------------------------------------------------------------------------

test('команда разбирается в argv и запускается без оболочки: переменные и маски не раскрываются', async () => {
  const result = await run(
    'node -e "process.stdout.write(JSON.stringify(process.argv.slice(1)))" \'a b\' "c\\"d" $HOME %PATH% * C:\\dir\\file.txt'
  );
  assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.deepEqual(JSON.parse(result.stdout), ['a b', 'c"d', '$HOME', '%PATH%', '*', 'C:\\dir\\file.txt']);
});

test('рабочий каталог — корень проекта', async () => {
  const result = await run('node -e "process.exit(require(\'fs\').existsSync(\'probe.txt\') ? 0 : 1)"', 'exit 0');
  assert.equal(result.status, 'passed', JSON.stringify(result));
});

test('процесс не стартовал — failed с причиной spawn_failed', async () => {
  const result = await runCheck({
    check: 'node -e "process.exit(0)"',
    expect: 'exit 0',
    projectRoot: path.join(root, 'no-such-dir')
  });
  assert.equal(result.status, 'failed');
  assert.ok(result.reason.startsWith('spawn_failed: '), result.reason);
  assert.equal(result.exit_code, null);
});

// ---------------------------------------------------------------------------
// Виды expect
// ---------------------------------------------------------------------------

test('expect exit <N>: совпадение кода — passed, иначе failed с причиной', async () => {
  assert.equal((await run('node -e "process.exit(3)"', 'exit 3')).status, 'passed');
  const failed = await run('node -e "process.exit(3)"', 'exit 0');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.exit_code, 3);
  assert.equal(failed.reason, 'exit_code: expected 0, got 3');
});

test('expect stdout contains <текст>', async () => {
  const check = 'node -e "process.stdout.write(\'hello world\')"';
  assert.equal((await run(check, 'stdout contains lo wo')).status, 'passed');
  const failed = await run(check, 'stdout contains bye');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.reason, 'stdout_lacks: bye');
});

test('expect stdout not contains <текст>', async () => {
  const check = 'node -e "process.stdout.write(\'hello world\')"';
  assert.equal((await run(check, 'stdout not contains bye')).status, 'passed');
  const failed = await run(check, 'stdout not contains world');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.reason, 'stdout_contains: world');
});

test('expect stdout matches /<регэксп>/', async () => {
  const check = 'node -e "process.stdout.write(\'v25.1\')"';
  assert.equal((await run(check, 'stdout matches /^v\\d+\\.\\d/')).status, 'passed');
  const failed = await run(check, 'stdout matches /^[1-9]/');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.reason, 'stdout_no_match: /^[1-9]/');
});

test('виды stdout код возврата не сравнивают — он остаётся в результате', async () => {
  const result = await run('node -e "process.stdout.write(\'x\'); process.exit(2)"', 'stdout contains x');
  assert.equal(result.status, 'passed');
  assert.equal(result.exit_code, 2);
});

test('неизвестный вид expect и битый регэксп — denied до запуска', async () => {
  await assertDeniedBeforeStart(WRITE_MARKER, 'unknown_expect: stderr contains x', 'stderr contains x');
  await assertDeniedBeforeStart(WRITE_MARKER, 'unknown_expect: exit zero', 'exit zero');
  await assertDeniedBeforeStart(WRITE_MARKER, 'unknown_expect: stdout matches ^x$', 'stdout matches ^x$');
  await assertDeniedBeforeStart(WRITE_MARKER, 'unknown_expect: ', '');
  await assertDeniedBeforeStart(WRITE_MARKER, 'bad_regex: ', 'stdout matches /(/');
  // Без поля expect: помощник run подставил бы `exit 0`, поэтому вызов прямой.
  const noExpect = await runCheck({ check: WRITE_MARKER.replace('{marker}', 'no-expect-marker'), projectRoot: root });
  assert.equal(noExpect.status, 'denied');
  assert.equal(noExpect.reason, 'unknown_expect: ');
  assert.equal(fs.existsSync(path.join(root, 'no-expect-marker')), false, 'процесс запускался');
});

// ---------------------------------------------------------------------------
// Вывод в evidence
// ---------------------------------------------------------------------------

test('stdout и stderr длиннее лимита усекаются с пометкой, ожидание сверяется с полным выводом', async () => {
  const total = CHECK_OUTPUT_LIMIT + 1000;
  const result = await run(
    `node -e "process.stdout.write('HEAD' + 'a'.repeat(${total - 4})); process.stderr.write('b'.repeat(${total}))"`,
    'stdout contains HEAD'
  );
  assert.equal(result.status, 'passed', 'начало вывода, срезанное в evidence, видно ожиданию');
  const marker = `[усечено: последние ${CHECK_OUTPUT_LIMIT} из ${total} символов]\n`;
  assert.equal(result.stdout, marker + 'a'.repeat(CHECK_OUTPUT_LIMIT));
  assert.equal(result.stderr, marker + 'b'.repeat(CHECK_OUTPUT_LIMIT));
});

test('вывод ровно в лимит не усекается', async () => {
  const result = await run(`node -e "process.stdout.write('a'.repeat(${CHECK_OUTPUT_LIMIT}))"`);
  assert.equal(result.stdout, 'a'.repeat(CHECK_OUTPUT_LIMIT));
  assert.equal(result.stderr, '');
});

test('предел хранения по умолчанию — 16 МБ на поток', () => {
  assert.equal(CHECK_CAPTURE_LIMIT, 16 * 1024 * 1024);
});

test('stdout сверх предела хранения: ожидание по stdout — failed, в evidence — хвост потока', async () => {
  const captureLimit = 64 * 1024;
  const total = captureLimit * 4;
  const check = `node -e "process.stdout.write('HEAD' + 'a'.repeat(${total - 8}) + 'TAIL')"`;
  const marker = `[усечено: последние ${CHECK_OUTPUT_LIMIT} символов из ${total} байт]\n`;

  const contains = await run(check, 'stdout contains HEAD', { captureLimit });
  assert.equal(contains.status, 'failed');
  assert.equal(contains.reason, `stdout_too_large: ${total}`);
  assert.equal(contains.stdout, marker + 'a'.repeat(CHECK_OUTPUT_LIMIT - 4) + 'TAIL');
  // По неполному выводу `not contains` дал бы ложный passed.
  const notContains = await run(check, 'stdout not contains XYZ', { captureLimit });
  assert.equal(notContains.status, 'failed');
  assert.equal(notContains.reason, `stdout_too_large: ${total}`);
  // Код возврата от объёма вывода не зависит.
  assert.equal((await run(check, 'exit 0', { captureLimit })).status, 'passed');
});

test('stderr сверх предела хранения не мешает ожиданию по stdout', async () => {
  const captureLimit = 64 * 1024;
  const total = captureLimit * 2;
  const result = await run(
    `node -e "process.stdout.write('ok'); process.stderr.write('b'.repeat(${total}))"`,
    'stdout contains ok',
    { captureLimit }
  );
  assert.equal(result.status, 'passed', JSON.stringify(result.reason));
  assert.equal(result.stderr, `[усечено: последние ${CHECK_OUTPUT_LIMIT} символов из ${total} байт]\n` + 'b'.repeat(CHECK_OUTPUT_LIMIT));
});

test('бесконечный вывод доходит до таймаута, хранится только хвост', async () => {
  const result = await run(
    'node -e "setInterval(() => process.stdout.write(\'a\'.repeat(65536)), 0)"',
    'stdout contains a',
    { timeoutMs: 1500, captureLimit: 64 * 1024 }
  );
  assert.equal(result.status, 'timeout');
  assert.match(result.stdout, /^\[усечено: последние 4000 символов из \d+ байт\]\na{4000}$/);
});

// ---------------------------------------------------------------------------
// Разбор записи проверки: parseDodChecks
// ---------------------------------------------------------------------------

const PLAN_EXAMPLE = [
  '## Описание',
  '',
  '- [ ] чужой пункт вне DoD',
  '  - check: `node x.js`, expect: `exit 0`',
  '',
  '## Критерии готовности (Definition of Done)',
  '',
  '- [ ] Раннер сохраняет запись вызова судьи по каждой попытке',
  '  - check: `node -e "process.exit(require(\'fs\').existsSync(\'.workflow/state/judge/IMPL-041.json\') ? 0 : 1)"`, expect: `exit 0`',
  '- [ ] Прежние тесты раннера тестов скилов зелёные',
  '  - check: `node --import ./src/tests/_rails-home.mjs --test src/tests/run-skill-tests.test.mjs`, expect: `exit 0`, regression: `true`',
  '- [ ] Текст ошибки понятен пользователю',
  '  - prose: `понятность формулировки командой не проверить`',
  '- [x] Кнопка «Экспорт» стоит справа от поиска и не перекрывает его',
  '  - visual: `.workflow/evidence/screens/IMPL-041-export.png`',
  '',
  '---',
  '',
  '## Результат выполнения',
  '',
  '- [ ] пункт после DoD',
  '  - prose: `не пункт DoD`',
  ''
].join('\n');

test('parseDodChecks: четыре формы из «Формата записи проверки»', () => {
  assert.deepEqual(parseDodChecks(PLAN_EXAMPLE), [
    {
      index: 1,
      text: 'Раннер сохраняет запись вызова судьи по каждой попытке',
      checked: false,
      kind: 'check',
      command: 'node -e "process.exit(require(\'fs\').existsSync(\'.workflow/state/judge/IMPL-041.json\') ? 0 : 1)"',
      expect: 'exit 0',
      regression: false,
      error: null
    },
    {
      index: 2,
      text: 'Прежние тесты раннера тестов скилов зелёные',
      checked: false,
      kind: 'check',
      command: 'node --import ./src/tests/_rails-home.mjs --test src/tests/run-skill-tests.test.mjs',
      expect: 'exit 0',
      regression: true,
      error: null
    },
    {
      index: 3,
      text: 'Текст ошибки понятен пользователю',
      checked: false,
      kind: 'prose',
      reason: 'понятность формулировки командой не проверить',
      error: null
    },
    {
      index: 4,
      text: 'Кнопка «Экспорт» стоит справа от поиска и не перекрывает его',
      checked: true,
      kind: 'visual',
      mask: '.workflow/evidence/screens/IMPL-041-export.png',
      error: null
    }
  ]);
});

test('parseDodChecks: тикет с CRLF разбирается так же', () => {
  assert.deepEqual(parseDodChecks(PLAN_EXAMPLE.replace(/\n/g, '\r\n')), parseDodChecks(PLAN_EXAMPLE));
});

test('parseDodChecks: пункт без формы и пункт с несколькими формами', () => {
  const body = [
    '## Критерии готовности (Definition of Done)',
    '',
    '- [ ] Без проверки',
    '  - просто уточнение, не проверка',
    '- [ ] Две строки проверки',
    '  - prose: `a`',
    '  - visual: `b.png`',
    '- [ ] Две формы в одной строке',
    '  - check: `node x.js`, expect: `exit 0`, prose: `c`',
    '- [ ] Две проверки check',
    '  - check: `node x.js`, expect: `exit 0`',
    '  - check: `node y.js`, expect: `exit 0`',
    '- [ ] Только expect',
    '  - expect: `exit 0`'
  ].join('\n');
  assert.deepEqual(
    parseDodChecks(body).map(({ index, kind, error }) => ({ index, kind, error })),
    [
      { index: 1, kind: null, error: 'no_form' },
      { index: 2, kind: null, error: 'multiple_forms' },
      { index: 3, kind: null, error: 'multiple_forms' },
      { index: 4, kind: null, error: 'multiple_forms' },
      { index: 5, kind: null, error: 'no_form' }
    ]
  );
});

test('parseDodChecks: неполная форма сохраняет вид и называет ошибку', () => {
  const body = [
    '## Definition of Done',
    '- [ ] check без expect',
    '  - check: `node x.js`',
    '- [ ] check без обратных кавычек',
    '  - check: node x.js, expect: `exit 0`',
    '- [ ] regression не true',
    '  - check: `node x.js`, expect: `exit 0`, regression: `false`',
    '- [ ] regression без обратных кавычек',
    '  - check: `node x.js`, expect: `exit 0`, regression: true',
    '- [ ] prose пустой',
    '  - prose: ``',
    '- [ ] visual без пути',
    '  - visual:',
    '- [ ] prose с expect',
    '  - prose: `причина`, expect: `exit 0`'
  ].join('\n');
  assert.deepEqual(
    parseDodChecks(body).map(({ kind, regression, error }) => ({ kind, regression, error })),
    [
      { kind: 'check', regression: false, error: 'check_without_expect' },
      { kind: 'check', regression: false, error: 'check_without_command' },
      { kind: 'check', regression: false, error: 'bad_regression' },
      { kind: 'check', regression: false, error: 'bad_regression' },
      { kind: 'prose', regression: undefined, error: 'prose_without_reason' },
      { kind: 'visual', regression: undefined, error: 'visual_without_path' },
      { kind: 'prose', regression: undefined, error: 'keys_without_check' }
    ]
  );
});

test('parseDodChecks: check и expect в соседних строках одного пункта сливаются', () => {
  const body = [
    '## Критерии готовности',
    '- [ ] Разнесённая проверка',
    '  - check: `node x.js`',
    '  - expect: `stdout contains ok`'
  ].join('\n');
  const [item] = parseDodChecks(body);
  assert.equal(item.kind, 'check');
  assert.equal(item.command, 'node x.js');
  assert.equal(item.expect, 'stdout contains ok');
  assert.equal(item.error, null);
});

test('parseDodChecks: нет секции DoD — пустой список', () => {
  assert.deepEqual(parseDodChecks('## Описание\n\n- [ ] x\n  - prose: `y`\n'), []);
  assert.deepEqual(parseDodChecks(''), []);
  assert.deepEqual(parseDodChecks(undefined), []);
});

test('parseCheckRecord: запись без пункта разбирается как проверка пункта DoD', () => {
  const records = [
    'check: `node x.js`, expect: `exit 0`',
    'check: `npm test`, expect: `exit 0`, regression: `true`',
    'prose: `причина`',
    'visual: `.workflow/evidence/screens/*.png`',
    'check: `node x.js`',
    'prose: `причина`, visual: `a.png`',
    'см. check: `node x.js`, expect: `exit 0`'
  ];
  for (const record of records) {
    const [{ index, text, checked, ...form }] = parseDodChecks(`## Критерии готовности\n- [ ] пункт\n  - ${record}\n`);
    assert.deepEqual(parseCheckRecord(record), form, record);
  }
  // Строку не с ключа проверки parseDodChecks под пунктом не читает — у записи нет формы.
  assert.equal(parseCheckRecord('см. check: `node x.js`, expect: `exit 0`').error, 'no_form');
  assert.equal(parseCheckRecord(undefined).error, 'no_form');
});

test('isDodFormat2: только dod_format 2', () => {
  assert.equal(isDodFormat2({ dod_format: 2 }), true);
  assert.equal(isDodFormat2({ dod_format: '2' }), true);
  assert.equal(isDodFormat2({ dod_format: 1 }), false);
  assert.equal(isDodFormat2({}), false);
  assert.equal(isDodFormat2(undefined), false);
});
