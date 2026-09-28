/**
 * Скрипт записи события `reset` (src/scripts/reset-model-history.js, PLAN-004,
 * задачи 27–28, В8) — дочерним процессом во временном проекте с журналом запусков.
 *
 * Что охраняется:
 *  - успех: `status: ok` и `model: <ключ>` в блоке RESULT, выход 0, журнал получает
 *    ровно одну строку `reset`; ключ с `/` и `:` передаётся как есть; корень проекта
 *    ищется вверх от рабочего каталога;
 *  - отказ: `status: error`, `code: <код>`, `error: <текст>`, выход 1, журнал не
 *    меняется — без `--reason`, без значения у аргумента, с неизвестным аргументом
 *    (BAD_INPUT), с моделью без событий `run` (NO_RUNS), без `.workflow/` выше рабочего
 *    каталога (NO_PROJECT).
 *
 * Изоляция: временный проект в каталоге ОС на тест, teardown в afterEach.
 *
 * Запуск: node --import ./src/tests/_rails-home.mjs --test src/tests/scripts-reset-model-history.test.mjs
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { findProjectRoot } from '../lib/find-root.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'reset-model-history.js');

const MODEL = 'vendor/model-x:free';

let root = null;
afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = null;
});

function logPath(project) {
  return path.join(project, '.workflow', 'metrics', 'agent-runs.jsonl');
}

/** Временный проект с журналом: два запуска MODEL и один запуск другой модели. */
function newProject() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-model-history-'));
  fs.mkdirSync(path.dirname(logPath(root)), { recursive: true });
  const runs = [MODEL, MODEL, 'model-b'].map((model, i) => JSON.stringify({
    type: 'run', ts: `2026-09-28T10:0${i}:00.000Z`, skill: 'execute-task', ticket: `IMPL-${i + 1}`,
    ticket_type: 'impl', agent: 'agent-a', model, status: 'ok', changed_files: 0,
  }));
  fs.writeFileSync(logPath(root), `${runs.join('\n')}\n`, 'utf8');
  return root;
}

function lines(project) {
  return fs.readFileSync(logPath(project), 'utf8').split('\n').filter((l) => l.trim());
}

function run(cwd, args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Поля единственного блока RESULT. */
function resultFields(stdout) {
  const match = stdout.match(/---RESULT---\r?\n([\s\S]*?)\r?\n---RESULT---/);
  assert.ok(match, `нет блока RESULT в выводе:\n${stdout}`);
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const at = line.indexOf(': ');
    if (at > 0) fields[line.slice(0, at)] = line.slice(at + 2);
  }
  return fields;
}

describe('reset-model-history.js', () => {
  test('успех: status ok, выход 0, одна строка reset в журнале', () => {
    const project = newProject();
    const before = lines(project);

    const out = run(project, ['--model', MODEL, '--reason', 'чистый лист']);
    assert.equal(out.code, 0, out.stdout + out.stderr);
    const fields = resultFields(out.stdout);
    assert.equal(fields.status, 'ok');
    assert.equal(fields.model, MODEL);

    const after = lines(project);
    assert.equal(after.length, before.length + 1);
    assert.deepEqual(after.slice(0, before.length), before);
    const event = JSON.parse(after.at(-1));
    assert.equal(event.type, 'reset');
    assert.equal(event.model, MODEL);
    assert.equal(event.reason, 'чистый лист');
    assert.ok(!Number.isNaN(Date.parse(event.ts)), 'ts — дата ISO');
  });

  test('корень проекта ищется вверх от рабочего каталога', () => {
    const project = newProject();
    const nested = path.join(project, 'src', 'deep');
    fs.mkdirSync(nested, { recursive: true });

    const out = run(nested, ['--reason', 'из подкаталога', '--model', 'model-b']);
    assert.equal(out.code, 0, out.stdout + out.stderr);
    assert.equal(resultFields(out.stdout).status, 'ok');
    assert.equal(JSON.parse(lines(project).at(-1)).model, 'model-b');
    assert.equal(fs.existsSync(path.join(nested, '.workflow')), false, 'журнал не создан в подкаталоге');
  });

  for (const [name, args] of [
    ['без --reason', ['--model', MODEL]],
    ['без --model', ['--reason', 'x']],
    ['аргумент без значения', ['--model', MODEL, '--reason']],
    ['пустая причина', ['--model', MODEL, '--reason', '  ']],
    ['неизвестный аргумент', ['--model', MODEL, '--reason', 'x', '--force']],
    ['лишний позиционный аргумент', ['--model', MODEL, '--reason', 'x', 'extra']],
  ]) {
    test(`BAD_INPUT: ${name} — status error, выход 1, журнал не меняется`, () => {
      const project = newProject();
      const before = lines(project);

      const out = run(project, args);
      assert.equal(out.code, 1, out.stdout + out.stderr);
      const fields = resultFields(out.stdout);
      assert.equal(fields.status, 'error');
      assert.equal(fields.code, 'BAD_INPUT');
      assert.ok(fields.error, 'текст ошибки есть');
      assert.deepEqual(lines(project), before);
    });
  }

  test('NO_RUNS: модели нет в журнале — status error, выход 1, журнал не меняется', () => {
    const project = newProject();
    const before = lines(project);

    const out = run(project, ['--model', 'vendor/model-x', '--reason', 'опечатка в ключе']);
    assert.equal(out.code, 1, out.stdout + out.stderr);
    const fields = resultFields(out.stdout);
    assert.equal(fields.status, 'error');
    assert.equal(fields.code, 'NO_RUNS');
    assert.match(fields.error, /vendor\/model-x/);
    assert.deepEqual(lines(project), before);
  });

  test('NO_PROJECT: над рабочим каталогом нет .workflow/ — status error, выход 1', (t) => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-model-history-noproj-'));
    // Скрипт ищет корень так же (findProjectRoot, тот же WORKFLOW_HOME): если выше
    // временного каталога ОС лежит чужой .workflow/, проверять здесь нечего.
    try {
      findProjectRoot(root);
      t.skip('выше временного каталога ОС есть .workflow/ — корень найдётся');
      return;
    } catch {
      // корня нет — проверяем отказ
    }
    const out = run(root, ['--model', MODEL, '--reason', 'x']);
    assert.equal(out.code, 1, out.stdout + out.stderr);
    const fields = resultFields(out.stdout);
    assert.equal(fields.status, 'error');
    assert.equal(fields.code, 'NO_PROJECT');
    assert.match(fields.error, /\.workflow/);
    assert.equal(fs.existsSync(path.join(root, '.workflow')), false, 'каталог проекта не создан');
  });
});
