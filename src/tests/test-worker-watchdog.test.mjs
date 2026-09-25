#!/usr/bin/env node

/**
 * Регресс на класс «воркер не отпустил ресурс → весь набор висит».
 *
 * `node --test` (isolation=process) считает файл завершённым только когда
 * дочерний процесс вышел. Любая незакрытая ручка внутри теста (незавершённый
 * polling-цикл, таймер, watcher, дочерний процесс) оставляет воркер живым
 * навсегда: сам тест при этом может быть зелёным, а прогон стоит без отчёта.
 * `--test-timeout` от этого не спасает — он ограничивает тест, а не жизнь
 * процесса. Страховка живёт в `src/tests/_rails-home.mjs` (он подгружается
 * через `--import` в каждый воркер) и добивает залипший воркер по таймеру.
 *
 * Тест запускает `node --test` на двух фикстурах: с утечкой (должен выйти сам,
 * кодом ≠ 0 и с маркером страховки) и без утечки (страховка не мешает).
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveWorkerCapMs, DEFAULT_WORKER_CAP_MS } from './_rails-home.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const PRELOAD = pathToFileURL(path.join(__dirname, '_rails-home.mjs')).href;
const FIXTURES = path.join(__dirname, 'fixtures');

// Сколько ждём, пока дочерний прогон завершится сам. Без страховки он не
// завершится никогда, поэтому по истечении бюджета убиваем его и валим тест.
const SELF_EXIT_BUDGET_MS = 25_000;

function runNodeTest(fixture, capMs, { budgetMs = SELF_EXIT_BUDGET_MS, tmp = null } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    // NODE_TEST_CONTEXT выставлен в нашем собственном воркере; унаследованный
    // он заставляет дочерний `node --test` отказаться запускать файлы
    // («run() is being called recursively»), поэтому убираем его.
    const env = { ...process.env, WORKFLOW_TEST_WORKER_CAP_MS: String(capMs) };
    delete env.NODE_TEST_CONTEXT;
    // свой временный каталог дочернего прогона: его tmpdir() — только его
    if (tmp) Object.assign(env, { TMPDIR: tmp, TEMP: tmp, TMP: tmp });
    const child = spawn(
      process.execPath,
      ['--test', '--import', PRELOAD, path.join(FIXTURES, fixture)],
      { cwd: PROJECT_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] }
    );

    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });

    let killedByBudget = false;
    const budget = setTimeout(() => {
      killedByBudget = true;
      child.kill('SIGKILL');
    }, budgetMs);

    child.on('error', err => { clearTimeout(budget); reject(err); });
    child.on('exit', (code, signal) => {
      clearTimeout(budget);
      resolve({ code, signal, output, killedByBudget, elapsedMs: Date.now() - started });
    });
  });
}

test('залипший воркер добивается страховкой, а не висит вечно', async () => {
  const capMs = 2000;
  const run = await runNodeTest('worker-leaks-poll-loop.mjs', capMs);

  assert.equal(
    run.killedByBudget,
    false,
    `прогон с утечкой не вышел сам за ${SELF_EXIT_BUDGET_MS} мс — набор повис бы; вывод:\n${run.output}`
  );
  assert.notEqual(
    run.code,
    0,
    `утечка ручки должна давать ненулевой код выхода, а не тихий успех; вывод:\n${run.output}`
  );
  assert.match(
    run.output,
    /test-worker-watchdog/,
    `в выводе должен быть маркер страховки с именем файла-виновника; вывод:\n${run.output}`
  );
  assert.match(
    run.output,
    /WORKFLOW_TEST_WORKER_CAP_MS/,
    'страховка знает только стенные часы: она обязана назвать порог и переменную, ' +
    `которой его поднимают, иначе честно долгий файл выглядит как утечка; вывод:\n${run.output}`
  );
  assert.ok(
    run.elapsedMs >= capMs,
    `страховка не должна срабатывать раньше своего срока (${run.elapsedMs} мс < ${capMs} мс)`
  );
});

test('здоровый воркер страховка не трогает', async () => {
  const run = await runNodeTest('worker-exits-cleanly.mjs', 60_000);

  assert.equal(run.killedByBudget, false, `чистый прогон должен выйти сам; вывод:\n${run.output}`);
  assert.equal(run.code, 0, `чистый прогон должен быть зелёным; вывод:\n${run.output}`);
  assert.doesNotMatch(
    run.output,
    /test-worker-watchdog/,
    `страховка не должна срабатывать на файле без утечек; вывод:\n${run.output}`
  );
});

test('воркер, заблокированный синхронно, тоже добивается', async () => {
  // Класс отдельный: главный поток не доходит до timers-фазы, поэтому таймер
  // внутри процесса (даже просроченный) не стреляет — проверено запуском на
  // src/tests/init.test.mjs с cap=100 мс: страховка молчала все 36 с прогона.
  // Добить может только наблюдатель вне главного потока.
  const capMs = 2000;
  const run = await runNodeTest('worker-blocks-sync.mjs', capMs);

  assert.equal(
    run.killedByBudget,
    false,
    `синхронно заблокированный прогон не вышел сам за ${SELF_EXIT_BUDGET_MS} мс — набор повис бы; вывод:\n${run.output}`
  );
  assert.notEqual(
    run.code,
    0,
    `добитый воркер должен давать ненулевой код выхода, а не тихий успех; вывод:\n${run.output}`
  );
  assert.match(
    run.output,
    /test-worker-watchdog/,
    `в выводе должен быть маркер страховки с именем файла-виновника; вывод:\n${run.output}`
  );
  assert.ok(
    run.elapsedMs >= capMs,
    `страховка не должна срабатывать раньше своего срока (${run.elapsedMs} мс < ${capMs} мс)`
  );
});

test('преднагрузка внутри worker thread инертна — иначе поток заводит поток', async () => {
  // `--import` живёт в execArgv, а его наследует и worker thread. Без отсечки
  // по isMainThread преднагрузка в потоке-наблюдателе заводила бы следующего
  // наблюдателя, и так до упора. Наблюдаемый след той же ветки — свой
  // WORKFLOW_HOME: если преднагрузка в потоке отработала целиком, поток
  // подменяет каталог на свой (проверено запуском на копии без отсечки).
  const { Worker } = await import('node:worker_threads');
  const homeInMain = process.env.WORKFLOW_HOME;

  assert.ok(
    homeInMain,
    'тест имеет смысл только под --import ./src/tests/_rails-home.mjs: WORKFLOW_HOME не выставлен'
  );

  const report = await new Promise((resolve, reject) => {
    const worker = new Worker(path.join(FIXTURES, 'worker-thread-reports-home.mjs'));
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('поток не отчитался за 10000 мс'));
    }, 10_000);
    worker.once('message', value => {
      clearTimeout(timer);
      worker.terminate().then(() => resolve(value), reject);
    });
    worker.once('error', err => { clearTimeout(timer); reject(err); });
  });

  assert.equal(report.isMainThread, false, 'фикстура должна отчитываться из потока, а не из главного');
  assert.equal(
    report.home,
    homeInMain,
    'преднагрузка в потоке не должна создавать свой WORKFLOW_HOME: значит отсечка по isMainThread снята, ' +
    'а с ней вернулась и рекурсия потоков'
  );
});

// ---------------------------------------------------------------------------
// Порог страховки приходит строкой из окружения. Кривое значение раньше давало
// NaN, страховка молча не вставала — и набор висел вечно ровно там, где её и
// ждали (ни лога, ни падения). Разбор значения вынесен в resolveWorkerCapMs и
// покрыт отдельно, чтобы опечатка в CI не оборачивалась тишиной.
// ---------------------------------------------------------------------------

test('порог страховки: пустое значение и отсутствие переменной — порог по умолчанию', () => {
  const warnings = [];
  const warn = message => warnings.push(message);

  assert.equal(resolveWorkerCapMs({}, warn), DEFAULT_WORKER_CAP_MS);
  assert.equal(resolveWorkerCapMs({ WORKFLOW_TEST_WORKER_CAP_MS: '' }, warn), DEFAULT_WORKER_CAP_MS);
  assert.deepEqual(warnings, [], 'пустая переменная — штатный случай, ругаться не на что');
});

test('порог страховки: число берётся как есть, 0 выключает страховку', () => {
  const warnings = [];
  const warn = message => warnings.push(message);

  assert.equal(resolveWorkerCapMs({ WORKFLOW_TEST_WORKER_CAP_MS: '2000' }, warn), 2000);
  assert.equal(resolveWorkerCapMs({ WORKFLOW_TEST_WORKER_CAP_MS: '0' }, warn), 0);
  assert.deepEqual(warnings, [], 'валидные значения не должны ничего печатать');
});

test('порог страховки: не число — порог по умолчанию и видимое предупреждение', () => {
  for (const raw of ['5s', 'abc', '-1', 'NaN']) {
    const warnings = [];
    const capMs = resolveWorkerCapMs({ WORKFLOW_TEST_WORKER_CAP_MS: raw }, message => warnings.push(message));

    assert.equal(capMs, DEFAULT_WORKER_CAP_MS, `"${raw}" не должно выключать страховку`);
    assert.equal(warnings.length, 1, `"${raw}": предупреждение должно быть ровно одно`);
    assert.match(warnings[0], /WORKFLOW_TEST_WORKER_CAP_MS/, `"${raw}": в предупреждении должно быть имя переменной`);
  }
});

test('кривое значение переменной: страховка встаёт на порог по умолчанию, а не молчит', async () => {
  // Сквозная проверка того же класса: значение «5s» вместо числа. До правки в
  // выводе не было ничего — Number('5s') = NaN, страховка молча не вставала.
  // Фикстура взята здоровая, а не с утечкой: залипший прогон пришлось бы снимать
  // сигналом, а снятый воркер не выполняет свой хук на выходе и оставляет
  // каталог в %TEMP% — за прогон набора ровно один такой и накапливался.
  const run = await runNodeTest('worker-exits-cleanly.mjs', '5s');

  assert.match(
    run.output,
    /WORKFLOW_TEST_WORKER_CAP_MS="5s"/,
    `кривое значение должно быть названо в выводе; вывод:\n${run.output}`
  );
  assert.equal(run.killedByBudget, false, 'здоровая фикстура обязана выйти сама');
  assert.equal(run.code, 0, `прогон должен быть зелёным; вывод:\n${run.output}`);
});

test('преднагрузка убирает свой каталог, даже если тест подменил WORKFLOW_HOME', async () => {
  // Хук на выходе читал переменную, а не помнил свой каталог. Файл теста,
  // подменивший WORKFLOW_HOME на собственный дом (так делают тесты хука,
  // плагина Kilo и CLI), уводил хук на чужой каталог: свой оставался в %TEMP%
  // навсегда. За один прогон набора так накапливалось 9 каталогов.
  //
  // Дочерний прогон получает собственный временный каталог. В общем %TEMP% в это
  // же время заводят свои дома соседние файлы набора, и под `npm run coverage` на
  // CI Windows 2026-09-25 чужой живой каталог засчитался утечкой.
  const tmp = mkdtempSync(path.join(tmpdir(), 'watchdog-tmp-'));
  try {
    const run = await runNodeTest('worker-overrides-home.mjs', 60_000, { tmp });
    assert.equal(run.code, 0, `фикстура должна быть зелёной; вывод:\n${run.output}`);

    const leaked = readdirSync(tmp).filter(name => name.startsWith('rails-test-home-'));
    assert.deepEqual(leaked, [], `каталоги остались во временном каталоге: ${leaked.join(', ')}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
