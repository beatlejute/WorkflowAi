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

import { appendAgentRun, parseAgentHistory, classifyAgentResult } from '../lib/agent-history.mjs';

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
    [{ exitCode: 1, stderr: 'permission denied' }, 'auth_error'],
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
  assert.equal(classifyAgentResult({ ...base, parsedResult: { status: 'blocked' }, stderr: '429' }), 'blocked');
});
