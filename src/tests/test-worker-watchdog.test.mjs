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
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const PRELOAD = pathToFileURL(path.join(__dirname, '_rails-home.mjs')).href;
const FIXTURES = path.join(__dirname, 'fixtures');

// Сколько ждём, пока дочерний прогон завершится сам. Без страховки он не
// завершится никогда, поэтому по истечении бюджета убиваем его и валим тест.
const SELF_EXIT_BUDGET_MS = 25_000;

function runNodeTest(fixture, capMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    // NODE_TEST_CONTEXT выставлен в нашем собственном воркере; унаследованный
    // он заставляет дочерний `node --test` отказаться запускать файлы
    // («run() is being called recursively»), поэтому убираем его.
    const env = { ...process.env, WORKFLOW_TEST_WORKER_CAP_MS: String(capMs) };
    delete env.NODE_TEST_CONTEXT;
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
    }, SELF_EXIT_BUDGET_MS);

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
