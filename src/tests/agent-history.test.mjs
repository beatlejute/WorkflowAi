/**
 * Журнал запусков агентов в тикете — секция «## История работы»
 * (src/lib/agent-history.mjs). Раннер дописывает строку после каждой стадии
 * (src/runner.mjs, audit-log), разбор строк используют аудиты таймаутов и прерываний,
 * а классификатор исхода решает, что записать в столбец «Статус». До этого файла
 * покрытие модуля было 50% строк.
 *
 * Что охраняется:
 *  - строка встаёт в таблицу, а не после неё; таблица создаётся, если её нет;
 *  - старая трёхстолбцовая таблица мигрирует на четыре столбца без потери строк;
 *  - вертикальная черта в значении экранируется и переживает разбор;
 *  - изменённые файлы запуска со сбоем (`files`) — пятая колонка «Изменённые файлы»:
 *    заголовок в пять колонок появляется с первой такой строкой, прежние строки и строки
 *    без файлов остаются в четыре ячейки, статус — в своей ячейке; разбор этого файла и
 *    calc-metrics.js скила create-report (статус и время по имени колонки) читают обе
 *    формы, время со смещением зоны calc-metrics читает как абсолютное;
 *  - классификатор отличает таймаут, прерывание, блокировку, лимит, сеть, авторизацию
 *    и пустой ответ ИИ-агента — от этого зависит, что человек увидит в истории;
 *  - запись переживает открытого читателя. Дефект, закрытый тем же изменением
 *    (проверено запуском 2026-09-24 на NTFS): своя запись temp + rename падала EPERM,
 *    строка терялась, раннер только писал предупреждение. Теперь запись идёт через
 *    общий replaceFileAtomicSync. На Linux rename поверх открытого файла разрешён, и
 *    тест там проходит в любом случае — он охраняет именно Windows.
 *
 * Запуск: node --test --import ./src/tests/_rails-home.mjs src/tests/agent-history.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { appendAgentRun, parseAgentHistory, classifyAgentResult, hasExecuteTaskRun } from '../lib/agent-history.mjs';
import { parseHistoryRows, parseHistoryTime } from '../skills/create-report/scripts/calc-metrics.js';

const ENTRY = { timestamp: '2026-09-24 10:00', skill: 'execute-task', agent: 'claude-sonnet', status: 'ok' };

function withTicket(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-history-'));
  const file = path.join(dir, 'IMPL-001.md');
  if (content !== null) fs.writeFileSync(file, content, 'utf8');
  try {
    fn(file, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const read = (file) => fs.readFileSync(file, 'utf8');

// ---------- appendAgentRun ----------

test('запись: неполный вход — отказ с кодом, файл не трогается', () => {
  withTicket('# Тикет\n', (file) => {
    assert.deepEqual(appendAgentRun(null, ENTRY), { ok: false, code: 'INVALID_INPUT' });
    assert.deepEqual(appendAgentRun(file, null), { ok: false, code: 'INVALID_INPUT' });
    assert.deepEqual(appendAgentRun(file, { ...ENTRY, agent: '' }), { ok: false, code: 'INVALID_ENTRY' });
    assert.equal(read(file), '# Тикет\n');
  });
});

test('запись: файла нет — READ_ERROR, файл не создаётся', () => {
  withTicket(null, (file) => {
    const r = appendAgentRun(file, ENTRY);
    assert.equal(r.code, 'READ_ERROR');
    assert.equal(fs.existsSync(file), false);
  });
});

test('запись: секции нет — создаётся в конце с таблицей из четырёх столбцов', () => {
  withTicket('---\nid: "IMPL-001"\n---\n\n# Тикет', (file) => {
    assert.deepEqual(appendAgentRun(file, ENTRY), { ok: true });
    const content = read(file);
    assert.match(content, /# Тикет\n\n## История работы\n\n\| Дата\/время \| Скил \| Агент \| Статус \|\n\|-+\|/);
    assert.deepEqual(parseAgentHistory(content), [ENTRY]);
  });
});

test('запись: таблица есть — строка встаёт после последней строки, следующая секция цела', () => {
  const before = [
    '# Тикет', '', '## История работы', '',
    '| Дата/время | Скил | Агент | Статус |',
    '|------------|------|-------|--------|',
    '| 2026-09-23 09:00 | check-relevance | script | ok |',
    '', '## Ревью', '', 'текст ревью', '',
  ].join('\n');
  withTicket(before, (file) => {
    appendAgentRun(file, ENTRY);
    const content = read(file);
    const history = parseAgentHistory(content);
    assert.deepEqual(history.map((r) => r.skill), ['check-relevance', 'execute-task']);
    assert.match(content, /## Ревью\n\nтекст ревью/, 'следующая секция не задета');
    assert.ok(content.indexOf('execute-task') < content.indexOf('## Ревью'), 'строка внутри таблицы, а не после секции');
  });
});

test('запись: секция без таблицы — таблица создаётся', () => {
  withTicket('# Тикет\n\n## История работы\n\nпока пусто\n', (file) => {
    appendAgentRun(file, ENTRY);
    assert.deepEqual(parseAgentHistory(read(file)), [ENTRY]);
  });
});

test('запись: трёхстолбцовая таблица мигрирует, старые строки получают unknown', () => {
  const before = [
    '# Тикет', '', '## История работы', '',
    '| Дата/время | Скил | Агент |',
    '|------------|------|-------|',
    '| 2026-09-20 08:00 | decompose-plan | claude-opus |',
    '',
  ].join('\n');
  withTicket(before, (file) => {
    appendAgentRun(file, ENTRY);
    const content = read(file);
    assert.match(content, /\| Дата\/время \| Скил \| Агент \| Статус \|/);
    assert.deepEqual(parseAgentHistory(content), [
      { timestamp: '2026-09-20 08:00', skill: 'decompose-plan', agent: 'claude-opus', status: 'unknown' },
      ENTRY,
    ]);
  });
});

test('запись: вертикальная черта в значении экранируется и переживает разбор', () => {
  withTicket('# Тикет\n', (file) => {
    appendAgentRun(file, { ...ENTRY, status: 'error | exit 1' });
    const content = read(file);
    assert.match(content, /error \\\| exit 1/);
    assert.equal(parseAgentHistory(content)[0].status, 'error | exit 1');
  });
});

test('запись: тикет держит открытым другой читатель — строка всё равно записана', () => {
  withTicket('---\nid: "IMPL-001"\n---\n\n# Тикет\n', (file, dir) => {
    const stderrWrite = process.stderr.write;
    const warn = console.warn;
    process.stderr.write = () => true;
    console.warn = () => {};
    const fd = fs.openSync(file, 'r');
    let r;
    try {
      r = appendAgentRun(file, ENTRY);
    } finally {
      fs.closeSync(fd);
      process.stderr.write = stderrWrite;
      console.warn = warn;
    }
    assert.deepEqual(r, { ok: true }, 'на NTFS прежняя запись падала EPERM и теряла строку');
    assert.deepEqual(parseAgentHistory(read(file)), [ENTRY]);
    assert.deepEqual(fs.readdirSync(dir), ['IMPL-001.md'], 'временных файлов не осталось');
  });
});

// ---------- parseAgentHistory ----------

test('разбор: секции нет — пустой список', () => {
  assert.deepEqual(parseAgentHistory('# Тикет\n\n## Ревью\n'), []);
});

test('разбор: строка неверной ширины пропускается с предупреждением', () => {
  const content = [
    '## История работы', '',
    '| Дата/время | Скил | Агент | Статус |',
    '|---|---|---|---|',
    '| 2026-09-24 | a | b | ok |',
    '| только | две |',
    '',
  ].join('\n');
  const warn = console.warn;
  const warned = [];
  console.warn = (m) => warned.push(m);
  try {
    assert.deepEqual(parseAgentHistory(content), [{ timestamp: '2026-09-24', skill: 'a', agent: 'b', status: 'ok' }]);
  } finally {
    console.warn = warn;
  }
  assert.equal(warned.length, 1);
  assert.match(warned[0], /Invalid row/);
});

// ---------- изменённые файлы запуска со сбоем ----------

const FAILED = { timestamp: '2026-10-01T03:12:45+05:00', skill: 'execute-task', agent: 'kilo-free(m)', status: 'timeout' };
const tableLines = (content) => content.split('\n').filter((l) => l.startsWith('|'));

test('файлы: секции нет — таблица в пять колонок, пути в обратных кавычках через запятую', () => {
  withTicket('# Тикет\n', (file) => {
    assert.deepEqual(appendAgentRun(file, { ...FAILED, files: ['src/a.js', 'src/b|c.js'] }), { ok: true });
    const content = read(file);
    assert.deepEqual(tableLines(content), [
      '| Дата/время | Скил | Агент | Статус | Изменённые файлы |',
      '|------------|------|-------|--------|------------------|',
      '| 2026-10-01T03:12:45+05:00 | execute-task | kilo-free(m) | timeout | `src/a.js`, `src/b\\|c.js` |',
    ]);
    assert.deepEqual(parseAgentHistory(content), [{ ...FAILED, files: '`src/a.js`, `src/b|c.js`' }]);
  });
});

test('файлы: таблица в четыре колонки — заголовок расширяется, прежние строки и строки без файлов — четыре ячейки', () => {
  const before = [
    '# Тикет', '', '## История работы', '',
    '| Дата/время | Скил | Агент | Статус |',
    '|------------|------|-------|--------|',
    '| 2026-09-30 10:00:00 | execute-task | a | error |',
    '', '## Ревью', '',
  ].join('\n');
  withTicket(before, (file) => {
    assert.deepEqual(appendAgentRun(file, { ...FAILED, files: ['src/x.js'], files_total: 33 }), { ok: true });
    assert.deepEqual(appendAgentRun(file, { ...ENTRY, timestamp: '2026-10-01T04:00:00+05:00' }), { ok: true });
    const content = read(file);
    assert.deepEqual(tableLines(content), [
      '| Дата/время | Скил | Агент | Статус | Изменённые файлы |',
      '|------------|------|-------|--------|------------------|',
      '| 2026-09-30 10:00:00 | execute-task | a | error |',
      '| 2026-10-01T03:12:45+05:00 | execute-task | kilo-free(m) | timeout | `src/x.js`, … ещё 32 |',
      '| 2026-10-01T04:00:00+05:00 | execute-task | claude-sonnet | ok |',
    ]);
    assert.match(content, /\n## Ревью\n/, 'следующая секция на месте');
    assert.deepEqual(parseAgentHistory(content).map((r) => [r.status, r.files]), [
      ['error', undefined], ['timeout', '`src/x.js`, … ещё 32'], ['ok', undefined],
    ]);

    // Читатель истории скила create-report: статус и время — по имени колонки.
    const rows = parseHistoryRows(content);
    assert.deepEqual(rows.map((r) => r.status), ['error', 'timeout', 'ok']);
    assert.equal(parseHistoryTime(rows[1].at), Date.parse('2026-09-30T22:12:45Z'), 'время со смещением — абсолютное');
    assert.equal(parseHistoryTime(rows[0].at), new Date(2026, 8, 30, 10, 0, 0).getTime(), 'время без зоны — местное');
    assert.equal(hasExecuteTaskRun(content), true);
  });
});

test('файлы: пустой список или не массив — строка в четыре ячейки, заголовок прежний', () => {
  withTicket('# Тикет\n', (file) => {
    appendAgentRun(file, { ...FAILED, files: [] });
    appendAgentRun(file, { ...FAILED, files: 'src/a.js' });
    const table = tableLines(read(file));
    assert.equal(table[0], '| Дата/время | Скил | Агент | Статус |');
    assert.deepEqual(table.slice(2), [
      '| 2026-10-01T03:12:45+05:00 | execute-task | kilo-free(m) | timeout |',
      '| 2026-10-01T03:12:45+05:00 | execute-task | kilo-free(m) | timeout |',
    ]);
  });
});

test('файлы: трёхстолбцовая таблица — миграция на четыре и сразу пятая колонка', () => {
  const before = ['## История работы', '', '| Дата | Скил | Агент |', '|---|---|---|', '| 2026-09-20 08:00 | decompose-plan | claude-opus |', ''].join('\n');
  withTicket(before, (file) => {
    appendAgentRun(file, { ...FAILED, status: 'error', files: ['a.md'] });
    assert.deepEqual(tableLines(read(file)), [
      '| Дата/время | Скил | Агент | Статус | Изменённые файлы |',
      '|------------|------|-------|--------|------------------|',
      '| 2026-09-20 08:00 | decompose-plan | claude-opus | unknown |',
      '| 2026-10-01T03:12:45+05:00 | execute-task | kilo-free(m) | error | `a.md` |',
    ]);
  });
});

// ---------- hasExecuteTaskRun ----------

test('исполнитель брал тикет: строка execute-task в «Истории работы»', () => {
  const table = (...rows) => ['## История работы', '', '| Дата/время | Скил | Агент | Статус |', '|---|---|---|---|', ...rows].join('\n');
  assert.equal(hasExecuteTaskRun(`# Тикет\n\n${table('| 2026-09-28 08:25:49 | execute-task | kilo-free(a) | rate_limit |')}\n`), true);
  assert.equal(hasExecuteTaskRun(`# Тикет\n\n${table('| 2026-09-28 08:41:59 | review-result | b | ok |')}\n`), false, 'только ревью');
  assert.equal(hasExecuteTaskRun('# Тикет\n\n## Ревью\n'), false, 'секции нет');
  assert.equal(hasExecuteTaskRun(undefined), false, 'текста нет');
  assert.equal(
    hasExecuteTaskRun(`${table('| 2026-09-28 | review-result | b | ok |')}\n\n## Заметки\n\n| x | execute-task | y | ok |\n`),
    false,
    'строка другой секции не в счёт',
  );
});

// ---------- classifyAgentResult ----------

const base = { exitCode: 0, stderr: '', stdout: '---RESULT---\nstatus: default\n---RESULT---', timedOut: false, signal: null, parsedResult: { status: 'default' }, agentType: 'ai' };

test('классификатор: каждый исход распознаётся, порядок проверок соблюдён', () => {
  const cases = [
    [{ timedOut: true, exitCode: 1 }, 'timeout'],
    [{ signal: 'SIGTERM', exitCode: null }, 'aborted'],
    [{ signal: 'SIGKILL', exitCode: null }, 'aborted'],
    [{ exitCode: 130 }, 'aborted'],
    [{ exitCode: 137 }, 'aborted'],
    [{ parsedResult: { status: 'blocked' } }, 'blocked'],
    [{ parsedResult: { status: 'irrelevant' } }, 'skipped_relevance'],
    [{ exitCode: 1, stderr: 'HTTP 429 Too Many Requests' }, 'rate_limit'],
    [{ exitCode: 1, stderr: 'Qwen OAuth quota exceeded' }, 'rate_limit'],
    [{ exitCode: 1, stderr: 'connect ECONNREFUSED 127.0.0.1:443' }, 'network_error'],
    [{ exitCode: 1, stderr: 'getaddrinfo ENOTFOUND api.example' }, 'network_error'],
    [{ exitCode: 1, stderr: 'Error 401: invalid api key' }, 'auth_error'],
    [{ exitCode: 1, stderr: 'Error: Forbidden: {"error":{"code":"403","message":"Forbidden"}}' }, 'auth_error'],
    // Текст скила execute-task в stderr (рельсы печатают узлы) — не отказ доступа.
    [{ exitCode: -1, stderr: 'RAILS: числится P2G1 «П2 ГЕЙТ: Все обязательные файлы контекста прочитаны без permission denied?»' }, 'error'],
    [{ exitCode: 1, stderr: "EACCES: permission denied, open 'x'" }, 'error'],
    [{ stdout: '   ', parsedResult: null }, 'empty_response'],
    [{ parsedResult: null }, 'empty_response'],
    [{}, 'ok'],
    [{ agentType: 'script', parsedResult: null, stdout: '' }, 'ok'],
    [{ exitCode: 2, stderr: 'boom' }, 'error'],
  ];
  for (const [patch, expected] of cases) {
    assert.equal(classifyAgentResult({ ...base, ...patch }), expected, JSON.stringify(patch));
  }
});

test('классификатор: таймаут важнее сигнала, блокировка важнее лимита в stderr', () => {
  assert.equal(classifyAgentResult({ ...base, timedOut: true, signal: 'SIGTERM' }), 'timeout');
  assert.equal(classifyAgentResult({ ...base, parsedResult: { status: 'blocked' }, stderr: 'HTTP 429 Too Many Requests' }), 'blocked');
});

// rate_limit — только если запуск закончился на ограничении (три последние строки
// stderr): статус даёт градацию `throttled` без запрета модели (src/lib/agent-runs.mjs).
// kilo пишет в stderr вывод инструментов и каждый 429, после которого сам повторил
// запрос; такой запуск, упавший на другом, — сбой, а не ограничение.
test('классификатор: rate_limit — по концу stderr, 429 из середины не в счёт', () => {
  const retried = 'level=ERROR message="stream error" error.error="AI_APICallError: [Poolside] Rate limit exceeded"';
  const work = ['→ Read src/a.ts', '→ Read src/b.ts', '$ npm test', '33/33 tests pass'].join('\n');
  const cases = [
    [`${work}\n${retried}\n${retried}\nError: [Poolside] Rate limit exceeded\n\n`, 'rate_limit'],
    [`${work}\nError: quota\n* Quota exceeded for metric: x\nPlease retry in 18s.`, 'rate_limit'],
    [`${retried}\n${work}\nError: TypeError: x is undefined`, 'error'],
    [`${retried}\n${work}\nconnect ECONNREFUSED 127.0.0.1:443`, 'network_error'],
    [`${retried}\n${work}\nHTTP 401 Unauthorized`, 'auth_error'],
    ['Error: boom\n    at run (src/index.ts:429:17)', 'error'],
    ['-rw-r--r-- 1 user 197121  429 Sep 27 IMPL-101.md', 'error'],
    [`| 2026-09-22 09:03:01 | execute-task | agent-a | rate_limit |\n${work}`, 'error'],
  ];
  for (const [stderr, expected] of cases) {
    assert.equal(classifyAgentResult({ ...base, exitCode: 1, stderr }), expected, JSON.stringify(stderr));
  }
});
