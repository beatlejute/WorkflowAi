/**
 * Журнал запусков агентов `.workflow/metrics/agent-runs.jsonl` (src/lib/agent-runs.mjs,
 * PLAN-003, задача 4) — запись и чтение (задача 5).
 *
 * Что охраняется:
 *  - `appendRunEvent` дописывает ровно одну строку JSON за вызов, порядок вызовов —
 *    порядок строк файла; `ts` подставляется, если не задан, а заданный не трогается;
 *  - `readRunEvents` отдаёт события в порядке файла; строка, не разбираемая как JSON-
 *    объект с полем `type`-строкой (оборванная запись, JSON-массив, JSON-скаляр, объект
 *    без `type`), пропускается без падения чтения;
 *  - нет файла журнала — `readRunEvents` отдаёт пустой массив, а не бросает;
 *  - дописывание из двух процессов одновременно (раннер и будущий MCP `unban`, «Риски»
 *    плана) не перемешивает строки: каждая запись остаётся отдельной целой строкой,
 *    ни одна не теряется и не задваивается.
 *
 * Корень изоляции — временный каталог ОС на каждый тест, удаляется в afterEach.
 *
 * Запуск: node --import ./src/tests/_rails-home.mjs --test src/tests/agent-runs.test.mjs
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { appendRunEvent, readRunEvents, runsLogPath } from '../lib/agent-runs.mjs';

let root;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runs-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test('appendRunEvent: одна строка за вызов, порядок файла — порядок вызовов', () => {
  const first = appendRunEvent(root, { type: 'run', ticket: 'IMPL-1', agent: 'agent-a', model: 'model-a', status: 'ok' });
  const second = appendRunEvent(root, { type: 'run', ticket: 'IMPL-2', agent: 'agent-b', model: 'model-b', status: 'ok' });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);

  const raw = fs.readFileSync(runsLogPath(root), 'utf8');
  const lines = raw.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), first.event);
  assert.deepEqual(JSON.parse(lines[1]), second.event);

  const events = readRunEvents(root);
  assert.deepEqual(events, [first.event, second.event]);
  assert.equal(events[0].ticket, 'IMPL-1');
  assert.equal(events[1].ticket, 'IMPL-2');
});

test('appendRunEvent: ts подставляется в ISO UTC, если не задан; заданный сохраняется как есть', () => {
  const before = Date.now();
  const auto = appendRunEvent(root, { type: 'run', ticket: 'IMPL-1' });
  const after = Date.now();
  assert.equal(typeof auto.event.ts, 'string');
  const parsed = Date.parse(auto.event.ts);
  assert.ok(Number.isFinite(parsed) && parsed >= before && parsed <= after, auto.event.ts);
  assert.equal(new Date(parsed).toISOString(), auto.event.ts, 'ts — ISO UTC (toISOString)');

  const explicit = appendRunEvent(root, { type: 'unban', ts: '2020-01-01T00:00:00.000Z', model: 'model-a', reason: 'ручное снятие' });
  assert.equal(explicit.event.ts, '2020-01-01T00:00:00.000Z');
});

test('readRunEvents: нет файла журнала — пустой массив, не исключение', () => {
  assert.equal(fs.existsSync(runsLogPath(root)), false);
  assert.deepEqual(readRunEvents(root), []);
});

test('readRunEvents: испорченная и посторонняя строка пропускаются, остальные читаются по порядку', () => {
  const file = runsLogPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const good1 = { type: 'run', ticket: 'IMPL-1', ts: '2026-01-01T00:00:00.000Z' };
  const good2 = { type: 'verify', ticket: 'IMPL-2', ts: '2026-01-02T00:00:00.000Z' };
  const lines = [
    JSON.stringify(good1),
    '{ "type": "run", "ticket": "broken"', // оборванная запись — не разбирается как JSON
    '[1, 2, 3]', // JSON-массив, не объект
    '"просто строка"', // JSON-скаляр, не объект
    '{"ts": "2026-01-03T00:00:00.000Z"}', // объект без строкового поля type
    '{"type": 42, "ts": "2026-01-04T00:00:00.000Z"}', // type не строка
    '   ', // пустая строка (только пробелы)
    JSON.stringify(good2),
    '', // хвостовой перенос строки даёт пустой элемент при split
  ];
  fs.writeFileSync(file, lines.join('\n'), 'utf8');

  assert.deepEqual(readRunEvents(root), [good1, good2]);
});

test('одновременная запись из двух процессов не перемешивает и не теряет строки', async () => {
  const libHref = new URL('../lib/agent-runs.mjs', import.meta.url).href;
  const COUNT = 300;

  function spawnWriter(label) {
    const script = path.join(root, `writer-${label}.mjs`);
    fs.writeFileSync(script, [
      `import { appendRunEvent } from ${JSON.stringify(libHref)};`,
      `const root = ${JSON.stringify(root)};`,
      `const label = ${JSON.stringify(label)};`,
      `const count = ${COUNT};`,
      'for (let i = 0; i < count; i++) {',
      '  const res = appendRunEvent(root, {',
      "    type: 'run', worker: label, seq: i, pid: process.pid,",
      "    ticket: 'IMPL-1', agent: 'agent-a', model: 'model-a', status: 'ok',",
      "    filler: 'x'.repeat(180),",
      '  });',
      '  if (!res.ok) {',
      "    process.stderr.write('APPEND_FAILED:' + res.error + '\\n');",
      '    process.exitCode = 1;',
      '  }',
      '}',
    ].join('\n'));
    return new Promise((resolveWriter, reject) => {
      const child = spawn(process.execPath, [script], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('exit', (code) => resolveWriter({ code, stderr }));
    });
  }

  const [a, b] = await Promise.all([spawnWriter('a'), spawnWriter('b')]);
  assert.equal(a.code, 0, a.stderr);
  assert.equal(b.code, 0, b.stderr);

  const raw = fs.readFileSync(runsLogPath(root), 'utf8');
  const lines = raw.split('\n').filter((l) => l.length > 0);
  // Строк ровно вдвое больше COUNT: ни одна запись не срослась с соседней и не
  // распалась на две — иначе split('\n') дал бы другое число строк.
  assert.equal(lines.length, COUNT * 2, 'каждая запись осталась отдельной строкой');

  // JSON.parse бросает на перемешанной строке — если дошли досюда, все строки целые.
  const parsed = lines.map((line) => JSON.parse(line));

  const events = readRunEvents(root);
  assert.equal(events.length, COUNT * 2, 'readRunEvents не потерял и не пропустил ни одной строки');

  for (const label of ['a', 'b']) {
    const seqs = parsed.filter((e) => e.worker === label).map((e) => e.seq);
    assert.equal(seqs.length, COUNT, `процесс ${label}: все ${COUNT} записей на месте`);
    assert.deepEqual(seqs, Array.from({ length: COUNT }, (_, i) => i), `процесс ${label}: порядок его записей сохранён`);
  }
});
