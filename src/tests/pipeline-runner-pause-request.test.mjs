/**
 * Кооперативная пауза раннера: `.workflow/state/pause-request.json`.
 *
 * Раннер проверяет запрос между стадиями и держит следующую стадию, пока
 * файл адресован ему. Строки PAUSED/RESUMED читает расширение VS Code.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PipelineRunner } from '../runner.mjs';
import { pauseRequestPath, readPauseRequest, RUNNER_CAPABILITIES } from '../lib/pause-request.mjs';

function createTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wf-pause-request-'));
}

function cleanupDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function createConfig() {
  return {
    pipeline: {
      name: 'pause-request-test',
      version: '1.0',
      agents: {},
      stages: {
        first: { type: 'update-counter', counter: 'first', goto: { default: 'second' } },
        second: { type: 'update-counter', counter: 'second', goto: { default: 'end' } }
      },
      entry: 'first',
      // Не 0: раннер читает `delay_between_stages || 5`, и ноль превращается
      // в пять секунд.
      execution: { max_steps: 20, delay_between_stages: 0.01, timeout_per_stage: 30 },
      context: {}
    }
  };
}

function writeRequest(root, pid, requestedAt = new Date().toISOString()) {
  const file = pauseRequestPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid, requested_at: requestedAt, requested_by: 'test' }));
}

function readLog(runner) {
  try {
    return fs.readFileSync(runner.logFilePath, 'utf8');
  } catch {
    return '';
  }
}

async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) { return true; }
    await new Promise(r => setTimeout(r, 20));
  }
  return false;
}

test('readPauseRequest отдаёт запрос только своему pid', () => {
  const root = createTmpDir();
  try {
    assert.equal(readPauseRequest(root, process.pid), null, 'без файла запроса нет');
    writeRequest(root, process.pid + 1);
    assert.equal(readPauseRequest(root, process.pid), null, 'чужой pid — не запрос');
    writeRequest(root, process.pid);
    assert.equal(readPauseRequest(root, process.pid).pid, process.pid);
    const now = Date.now();
    writeRequest(root, process.pid, new Date(now - 60_000).toISOString());
    assert.equal(readPauseRequest(root, process.pid, now), null, 'запрос старше старта раннера — чужой');
    assert.ok(readPauseRequest(root, process.pid, now - 120_000), 'запрос моложе старта — свой');
    writeRequest(root, process.pid, 'not a date');
    assert.equal(readPauseRequest(root, process.pid, now), null, 'без даты возраст не проверить');
    fs.writeFileSync(pauseRequestPath(root), '{ не json');
    assert.equal(readPauseRequest(root, process.pid), null, 'нечитаемый файл — не запрос');
  } finally {
    cleanupDir(root);
  }
});

test('раннер объявляет pause-request в capabilities', () => {
  assert.ok(RUNNER_CAPABILITIES.includes('pause-request'));
});

test('запрос паузы держит следующую стадию до удаления файла', async () => {
  const root = createTmpDir();
  try {
    const runner = new PipelineRunner(createConfig(), { project: root });
    runner.pausePollMs = 20;
    // Запрос — после старта раннера: так его пишет расширение, увидев lock.
    writeRequest(root, process.pid);
    const done = runner.run();

    assert.ok(await waitFor(() => readLog(runner).includes('PAUSED before stage="first"')), 'нет строки PAUSED');
    // Пауза стоит до первой стадии: ни одна ещё не выполнялась.
    await new Promise(r => setTimeout(r, 100));
    assert.equal(runner.stepCount, 0);
    assert.equal(runner.counters.first, undefined);

    fs.unlinkSync(pauseRequestPath(root));
    const result = await done;

    const log = readLog(runner);
    assert.ok(log.includes('RESUMED stage="first"'), 'нет строки RESUMED');
    assert.ok(log.includes('Pipeline completed successfully!'));
    assert.equal(runner.counters.first, 1);
    assert.equal(runner.counters.second, 1);
    assert.ok(result.steps >= 3);
  } finally {
    cleanupDir(root);
  }
});

test('запрос для другого pid раннер не останавливает', async () => {
  const root = createTmpDir();
  try {
    writeRequest(root, process.pid + 1);
    const runner = new PipelineRunner(createConfig(), { project: root });
    runner.pausePollMs = 20;
    await runner.run();

    const log = readLog(runner);
    assert.ok(!log.includes('PAUSED'), 'чужой запрос не должен ставить паузу');
    assert.ok(log.includes('Pipeline completed successfully!'));
  } finally {
    cleanupDir(root);
  }
});

test('запрос, оставшийся от прошлого запуска с тем же pid, раннер не останавливает', async () => {
  const root = createTmpDir();
  try {
    writeRequest(root, process.pid, new Date(Date.now() - 60_000).toISOString());
    const runner = new PipelineRunner(createConfig(), { project: root });
    runner.pausePollMs = 20;
    await runner.run();

    const log = readLog(runner);
    assert.ok(!log.includes('PAUSED'), 'старый запрос не должен ставить паузу');
    assert.ok(log.includes('Pipeline completed successfully!'));
  } finally {
    cleanupDir(root);
  }
});

test('остановка во время паузы завершает раннер без RESUMED и без новых стадий', async () => {
  const root = createTmpDir();
  try {
    const runner = new PipelineRunner(createConfig(), { project: root });
    runner.pausePollMs = 20;
    // Пауза после первой стадии: запрос появляется, как только она отработала.
    const originalUpdate = runner.executeUpdateCounter.bind(runner);
    runner.executeUpdateCounter = (stageId, stage) => {
      const result = originalUpdate(stageId, stage);
      if (stageId === 'first') { writeRequest(root, process.pid); }
      return result;
    };
    const done = runner.run();

    assert.ok(await waitFor(() => readLog(runner).includes('PAUSED before stage="second"')), 'нет строки PAUSED');
    runner.running = false;
    await done;

    const log = readLog(runner);
    assert.ok(!log.includes('RESUMED'), 'после остановки RESUMED не пишется');
    assert.equal(runner.counters.first, 1);
    assert.equal(runner.counters.second, undefined, 'вторая стадия не должна была начаться');
  } finally {
    cleanupDir(root);
  }
});
