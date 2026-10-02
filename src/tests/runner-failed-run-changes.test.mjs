/**
 * Запуск агента со сбоем и правками в рабочем дереве (StageExecutor.executeWithFallback,
 * src/runner.mjs) и время строки «Истории работы».
 *
 * 2026-09-30: запуск исполнителя упал по таймауту, успев удалить ключ локали; следующая
 * попытка вставила его заново с выдуманным описанием. Шаг P1S2 скила execute-task сверяет
 * рабочее дерево после строки истории со статусом error, timeout или network_error, но
 * какие файлы тронул оборванный запуск, раннер не называл — только их число в журнале, а
 * в незакоммиченном дереве лежит и работа других тикетов. Время строки истории было
 * местным без зоны, и исполнители переписывали его в Result с меткой Z.
 *
 * Что охраняется:
 *  - запуск со сбоем (error) с правками: событие run — changed_files и changed_paths
 *    (пути от корня проекта, по алфавиту); строка истории — статус в своей ячейке, пути в
 *    колонке «Изменённые файлы»;
 *  - удачный запуск с правками — без changed_paths и без колонки файлов;
 *  - время строки истории — ISO 8601 со смещением местной зоны, в окне запуска.
 *
 * Корень — временный проект без git (снимок обходом каталога), агент — node-скрипт вне
 * корня. Имена агентов нейтральные.
 *
 * Запуск: node --import ./src/tests/_rails-home.mjs --test src/tests/runner-failed-run-changes.test.mjs
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { StageExecutor } from '../runner.mjs';
import { parseAgentHistory } from '../lib/agent-history.mjs';

const TEMPS = [];
afterEach(() => {
  for (const dir of TEMPS.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function makeProject() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-failed-run-changes-'));
  TEMPS.push(base);
  const root = path.join(base, 'project');
  const outside = path.join(base, 'outside');
  const dir = path.join(root, '.workflow', 'tickets', 'in-progress');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  const ticketPath = path.join(dir, 'IMPL-1.md');
  fs.writeFileSync(ticketPath, '---\nid: IMPL-1\ntype: impl\n---\n\n# Тикет\n');
  return { root, outside, ticketPath };
}

/** Агент: пишет `writes` (от корня проекта), затем выходит с `exit` (0 — с блоком RESULT). */
function writeStub(outside, { writes, exit }) {
  const file = path.join(outside, `agent-${exit}.mjs`);
  fs.writeFileSync(file, `import fs from 'node:fs';
import path from 'node:path';
for (const rel of ${JSON.stringify(writes)}) {
  fs.mkdirSync(path.dirname(rel), { recursive: true });
  fs.writeFileSync(rel, 'written');
}
${exit === 0 ? "process.stdout.write('---RESULT---\\nstatus: passed\\n---RESULT---\\n');" : "process.stderr.write('boom: agent crashed\\n');"}
process.exit(${exit});
`);
  return file;
}

function makeExecutor(root, stub) {
  const config = {
    pipeline: {
      name: 'failed-run-changes', version: '1.0', entry: 'none', context: {}, stages: {},
      execution: { artifact_snapshot_enabled: false, timeout_per_stage: 60 },
      agents: { 'agent-a': { command: 'node', args: [stub], capabilities: ['text'] } },
    },
  };
  return new StageExecutor(config, { ticket_id: 'IMPL-1' }, {}, {}, null, null, root, { runId: 'run-1' });
}

const STAGE = { agents: ['agent-a'], skill: 'execute-task', instructions: 'Выполни тикет' };

function runEvents(root) {
  const file = path.join(root, '.workflow', 'metrics', 'agent-runs.jsonl');
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'run');
}

// Смещение местной зоны в форме ISO 8601 (`+05:00`) — на машине теста.
function localZone(date) {
  const offset = -date.getTimezoneOffset();
  const pad = (n) => String(n).padStart(2, '0');
  return `${offset >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

test('сбой с правками: пути в событии run и в колонке «Изменённые файлы» строки истории', async () => {
  const { root, outside, ticketPath } = makeProject();
  const executor = makeExecutor(root, writeStub(outside, { writes: ['src/locale.js', 'docs/notes.md'], exit: 1 }));

  await assert.rejects(() => executor.executeWithFallback('execute-task', STAGE), (err) => err.exitCode === 1);

  const [event] = runEvents(root);
  assert.equal(event.status, 'error');
  assert.equal(event.changed_files, 2);
  assert.deepEqual(event.changed_paths, ['docs/notes.md', 'src/locale.js']);

  const content = fs.readFileSync(ticketPath, 'utf8');
  const history = parseAgentHistory(content);
  assert.equal(history.length, 1, content);
  assert.equal(history[0].status, 'error', 'статус — в своей ячейке');
  assert.equal(history[0].files, '`docs/notes.md`, `src/locale.js`');
  assert.match(content, /\| Статус \| Изменённые файлы \|/);
});

test('удачный запуск с правками: пути не пишутся ни в событие, ни в историю', async () => {
  const { root, outside, ticketPath } = makeProject();
  const executor = makeExecutor(root, writeStub(outside, { writes: ['src/app.js'], exit: 0 }));

  const result = await executor.executeWithFallback('execute-task', STAGE);
  assert.equal(result.status, 'passed');

  const [event] = runEvents(root);
  assert.equal(event.status, 'ok');
  assert.equal(event.changed_files, 1);
  assert.ok(!('changed_paths' in event), JSON.stringify(event));

  const content = fs.readFileSync(ticketPath, 'utf8');
  assert.equal(parseAgentHistory(content)[0].files, undefined);
  assert.doesNotMatch(content, /Изменённые файлы/);
});

test('время строки истории — ISO 8601 со смещением местной зоны, в окне запуска', async () => {
  const { root, outside, ticketPath } = makeProject();
  const executor = makeExecutor(root, writeStub(outside, { writes: [], exit: 0 }));

  const started = Date.now();
  await executor.executeWithFallback('execute-task', STAGE);
  const finished = Date.now();

  const [row] = parseAgentHistory(fs.readFileSync(ticketPath, 'utf8'));
  assert.match(row.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  const at = Date.parse(row.timestamp);
  // Секунды без долей: нижняя граница — начало секунды старта.
  assert.ok(at >= Math.floor(started / 1000) * 1000 && at <= finished, `${row.timestamp} вне окна запуска`);
  assert.ok(row.timestamp.endsWith(localZone(new Date(at))), `смещение не местной зоны: ${row.timestamp}`);
});
