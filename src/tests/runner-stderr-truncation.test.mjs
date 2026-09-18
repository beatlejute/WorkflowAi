import { test, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { truncateStderrLine, StageExecutor } from '../runner.mjs';

// FIX-16. При ошибке LLM-провайдера в stderr попадает сериализованный request
// body с промптами — наблюдались строки по 74–232 КБ и pipeline-логи до 9.9 МБ.
// Плюс это утечка содержимого контекста агентов в лог.

const sandboxes = [];

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'runner-stderr-'));
  sandboxes.push(dir);
  return dir;
}

after(() => {
  for (const dir of sandboxes) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** StageExecutor без конструктора: тому нужен конфиг и правила health-классификатора. */
function executorIn(projectRoot) {
  const executor = Object.create(StageExecutor.prototype);
  executor.projectRoot = projectRoot;
  return executor;
}

test('короткая строка stderr не трогается', () => {
  const line = 'AI_APICallError: 407 Proxy Authentication Required';
  assert.strictEqual(truncateStderrLine(line), line);
});

test('длинная строка режется head+tail с маркером', () => {
  const line = 'x'.repeat(100 * 1024);
  const result = truncateStderrLine(line);

  assert.ok(result.length < 3000, `осталось ${result.length} символов`);
  assert.match(result, /\.\.\.\[TRUNCATED \d+ bytes\]\.\.\./);
  assert.ok(result.startsWith('x'.repeat(100)), 'начало строки должно сохраняться');
  assert.ok(result.endsWith('x'.repeat(100)), 'хвост строки должен сохраняться');
});

test('строка >100 КБ не попадает в лог целиком', () => {
  const root = sandbox();
  const huge = `{"prompt":"${'A'.repeat(120 * 1024)}"}`;
  const stderr = `AI_APICallError: request failed\n${huge}\nstack trace line`;

  const { lines, dumpPath } = executorIn(root).prepareStderrForLog(stderr, 'execute-task');

  assert.strictEqual(lines.length, 3, 'строки не склеиваются и не теряются');
  assert.strictEqual(lines[0], 'AI_APICallError: request failed');
  assert.strictEqual(lines[2], 'stack trace line');
  assert.ok(lines[1].length < 3000, `в лог ушло ${lines[1].length} символов`);
  assert.ok(
    lines.join('\n').length < stderr.length / 10,
    'усечённый вывод должен быть кратно меньше исходного'
  );
  assert.ok(dumpPath, 'при усечении должен появиться путь к полному stderr');
});

test('полный stderr сохраняется рядом с логом', () => {
  const root = sandbox();
  const stderr = `head\n${'B'.repeat(50 * 1024)}`;

  const { dumpPath } = executorIn(root).prepareStderrForLog(stderr, 'decompose-plan');

  assert.match(dumpPath, /^\.workflow\/logs\/stderr\/decompose-plan-\d+\.log$/);
  const dumped = resolve(root, dumpPath);
  assert.ok(existsSync(dumped), 'файл с полным stderr должен существовать');
  assert.strictEqual(readFileSync(dumped, 'utf8'), stderr, 'дамп не должен быть усечён');
});

test('без усечения дамп не создаётся', () => {
  const root = sandbox();

  const { lines, dumpPath } = executorIn(root).prepareStderrForLog('warn: nothing special', 'coach');

  assert.deepStrictEqual(lines, ['warn: nothing special']);
  assert.strictEqual(dumpPath, null);
  assert.ok(!existsSync(join(root, '.workflow', 'logs', 'stderr')), 'лишних директорий быть не должно');
});

test('stageId с разделителями пути не уводит дамп из директории логов', () => {
  const root = sandbox();
  const stderr = 'C'.repeat(5000);

  const { dumpPath } = executorIn(root).prepareStderrForLog(stderr, '../../etc/passwd');

  assert.ok(dumpPath.startsWith('.workflow/logs/stderr/'), `путь уехал: ${dumpPath}`);
});
