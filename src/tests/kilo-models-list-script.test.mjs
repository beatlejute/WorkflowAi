/**
 * Адаптер списка моделей kilo (src/scripts/kilo-models-list.js): разбор вывода
 * `kilo models --verbose` в JSON-строки интерфейса команды списка пула — по одной
 * строке `{"id", "capabilities", "note"}` на модель. Настоящий kilo подменён
 * фейковым `kilo.cmd` (Windows) / `kilo` (POSIX) во временном каталоге, первым в
 * PATH дочернего процесса: адаптер ищет команду `kilo` через PATH (shell на
 * Windows), как раннер ищет агентов, а не по своему аргументу.
 *
 * Что охраняется:
 *  - `capabilities.input.image: true` → `"capabilities":["multimodal"]`, иначе
 *    поле в строке отсутствует;
 *  - `note` — `in=<cost.input> out=<cost.output> tools=<capabilities.toolcall>
 *    free=<isFree или ->`, значения — как есть;
 *  - id JSON-объекта не совпал со строкой id перед ним — WARN в stderr, в
 *    итоговой строке — id из вывода kilo;
 *  - объект не разобрался (испорченный JSON) — WARN в stderr, эта модель
 *    пропущена, соседние модели остаются на месте;
 *  - `kilo` завершился не нулевым кодом — адаптер завершается кодом 1, причина —
 *    в stderr, ни одна строка модели не напечатана;
 *  - объект без закрывающей `}` — WARN о нём, следующая модель не теряется;
 *  - CRLF в выводе kilo не ломает разбор;
 *  - вывод больше буфера трубы доходит до медленного читателя целиком.
 *
 * Запуск: node --import ./src/tests/_rails-home.mjs --test src/tests/kilo-models-list-script.test.mjs
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(TESTS_DIR, '..', 'scripts', 'kilo-models-list.js');

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-models-list-'));
after(() => fs.rmSync(BASE, { recursive: true, force: true }));

// Фейковый kilo — паттерн kilo-models.test.mjs (writeFakeKilo): на Windows
// `kilo.cmd` зовёт node-скрипт рядом с собой, на POSIX — sh-обёртка. Здесь скрипт
// просто печатает готовый текст `--verbose` из окружения (или FAKE_KILO_COUNT
// сгенерированных моделей — большой вывод в окружение не влезает: на Windows предел
// переменной 32 КБ) и завершается заданным кодом — сам разбор формата не его дело, это
// проверяет адаптер. Код выхода — process.exitCode: process.exit не ждёт записи в трубу.
let binNo = 0;
function fakeKiloDir() {
  const dir = path.join(BASE, `bin-${++binNo}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'kilo-stub.mjs'), `
const count = Number(process.env.FAKE_KILO_COUNT || '0');
let out = process.env.FAKE_KILO_STDOUT || '';
if (count > 0) {
  const parts = [];
  for (let i = 0; i < count; i++) {
    const obj = { id: 'vendor-a/model-' + i, providerID: 'prov-a', cost: { input: 0, output: 0 },
      capabilities: { toolcall: true, input: { image: i % 2 === 0 } }, isFree: true };
    parts.push('prov-a/vendor-a/model-' + i + '\\n' + JSON.stringify(obj, null, 2));
  }
  out = parts.join('\\n') + '\\n';
}
const err = process.env.FAKE_KILO_STDERR || '';
process.stdout.write(out);
if (err) process.stderr.write(err);
process.exitCode = Number(process.env.FAKE_KILO_EXIT || '0');
`);
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(dir, 'kilo.cmd'), `@node "%~dp0kilo-stub.mjs" %*\r\n`);
  } else {
    const sh = path.join(dir, 'kilo');
    fs.writeFileSync(sh, `#!/bin/sh\nexec node "$(dirname "$0")/kilo-stub.mjs" "$@"\n`);
    fs.chmodSync(sh, 0o755);
  }
  return dir;
}

const ENV_KEYS = ['PATH', 'FAKE_KILO_STDOUT', 'FAKE_KILO_STDERR', 'FAKE_KILO_EXIT', 'FAKE_KILO_COUNT'];

/** Запуск адаптера с фейковым kilo первым в PATH; { code, out, err } дочернего процесса. */
function runAdapter({ stdout = '', exit = 0, stderr = '' } = {}) {
  const dir = fakeKiloDir();
  const saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.PATH = `${dir}${path.delimiter}${saved.PATH || ''}`;
  process.env.FAKE_KILO_STDOUT = stdout;
  process.env.FAKE_KILO_STDERR = stderr;
  process.env.FAKE_KILO_EXIT = String(exit);
  try {
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    return { code: r.status, out: r.stdout, err: r.stderr };
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
}

/** Один объект формата `--verbose`: строка id, затем JSON в несколько строк. */
function verboseEntry(idLine, obj) {
  return `${idLine}\n${JSON.stringify(obj, null, 2)}`;
}

function outLines(out) {
  return out.split('\n').filter((l) => l.trim() !== '');
}

test('картинка есть — capabilities:[multimodal]; картинки нет — поле отсутствует', () => {
  const withImage = verboseEntry('prov-a/vendor-a/model-a', {
    id: 'vendor-a/model-a', providerID: 'prov-a', cost: { input: 0, output: 0 },
    capabilities: { toolcall: true, input: { image: true } },
  });
  const withoutImage = verboseEntry('prov-a/vendor-a/model-b', {
    id: 'vendor-a/model-b', providerID: 'prov-a', cost: { input: 1, output: 2 },
    capabilities: { toolcall: false, input: { image: false } },
  });
  const r = runAdapter({ stdout: `${withImage}\n${withoutImage}\n` });
  assert.equal(r.code, 0, r.out + r.err);
  const out = outLines(r.out).map((l) => JSON.parse(l));
  assert.deepEqual(out[0], { id: 'prov-a/vendor-a/model-a', capabilities: ['multimodal'], note: 'in=0 out=0 tools=true free=-' });
  assert.deepEqual(out[1], { id: 'prov-a/vendor-a/model-b', note: 'in=1 out=2 tools=false free=-' });
  assert.ok(!('capabilities' in out[1]), 'без картинки поля capabilities в строке нет');
});

test('isFree есть — free=<значение>; isFree нет — free=-', () => {
  const withFree = verboseEntry('prov-a/vendor-a/model-c', {
    id: 'vendor-a/model-c', providerID: 'prov-a', cost: { input: 0, output: 0 },
    capabilities: { toolcall: true }, isFree: true,
  });
  const withoutFree = verboseEntry('prov-a/vendor-a/model-d', {
    id: 'vendor-a/model-d', providerID: 'prov-a', cost: { input: 0, output: 0 },
    capabilities: { toolcall: true },
  });
  const r = runAdapter({ stdout: `${withFree}\n${withoutFree}\n` });
  assert.equal(r.code, 0, r.out + r.err);
  const out = outLines(r.out).map((l) => JSON.parse(l));
  assert.equal(out[0].note, 'in=0 out=0 tools=true free=true');
  assert.equal(out[1].note, 'in=0 out=0 tools=true free=-');
});

test('id объекта не совпадает со строкой — WARN в stderr, в итоге строка из вывода kilo', () => {
  const entry = verboseEntry('prov-a/vendor-a/model-e', {
    id: 'vendor-a/other-model', providerID: 'prov-a', cost: { input: 0, output: 0 }, capabilities: { toolcall: true },
  });
  const r = runAdapter({ stdout: `${entry}\n` });
  assert.equal(r.code, 0, r.out + r.err);
  const out = outLines(r.out).map((l) => JSON.parse(l));
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'prov-a/vendor-a/model-e', 'берётся строка id, а не providerID+id объекта');
  assert.match(r.err, /prov-a\/vendor-a\/other-model/, 'в WARN — вычисленный id объекта');
  assert.match(r.err, /prov-a\/vendor-a\/model-e/, 'в WARN — строка id из вывода');
});

test('испорченный объект — WARN в stderr, модель пропущена, соседние — на месте', () => {
  const good1 = verboseEntry('prov-a/vendor-a/model-f', {
    id: 'vendor-a/model-f', providerID: 'prov-a', cost: { input: 0, output: 0 }, capabilities: { toolcall: true },
  });
  const broken = 'prov-a/vendor-a/model-g\n{\n  "id": "vendor-a/model-g",\n  not valid json\n}';
  const good2 = verboseEntry('prov-a/vendor-a/model-h', {
    id: 'vendor-a/model-h', providerID: 'prov-a', cost: { input: 0, output: 0 }, capabilities: { toolcall: true },
  });
  const r = runAdapter({ stdout: `${good1}\n${broken}\n${good2}\n` });
  assert.equal(r.code, 0, r.out + r.err);
  const ids = outLines(r.out).map((l) => JSON.parse(l).id);
  assert.deepEqual(ids, ['prov-a/vendor-a/model-f', 'prov-a/vendor-a/model-h']);
  assert.match(r.err, /model-g/, 'WARN называет id пропущенной модели');
});

// Объект без закрывающей `}` не должен забирать следующую модель: строка `{` в первой
// колонке — начало объекта следующей модели, её строка id — перед ней.
test('объект без закрывающей } — WARN о нём, следующая модель не теряется', () => {
  const unclosed = 'prov-a/vendor-a/model-k\n{\n  "id": "vendor-a/model-k",\n  "providerID": "prov-a",';
  const next = verboseEntry('prov-a/vendor-a/model-l', {
    id: 'vendor-a/model-l', providerID: 'prov-a', cost: { input: 0, output: 0 }, capabilities: { toolcall: true },
  });
  const last = verboseEntry('prov-a/vendor-a/model-m', {
    id: 'vendor-a/model-m', providerID: 'prov-a', cost: { input: 0, output: 0 }, capabilities: { toolcall: true },
  });
  const r = runAdapter({ stdout: `${unclosed}\n${next}\n${last}\n` });
  assert.equal(r.code, 0, r.out + r.err);
  const ids = outLines(r.out).map((l) => JSON.parse(l).id);
  assert.deepEqual(ids, ['prov-a/vendor-a/model-l', 'prov-a/vendor-a/model-m']);
  assert.match(r.err, /model-k.*not closed/, 'WARN называет модель без закрывающей скобки');
});

// Запись в трубу на POSIX асинхронна: process.exit сразу после печати терял хвост вывода
// сверх буфера трубы (живой список — 789 моделей, ~82 КБ), и пул молча терял участников.
// Читатель здесь медленный — труба заполнена к моменту, когда адаптер закончил печать.
test('вывод больше буфера трубы — медленный читатель получает все строки', async () => {
  const COUNT = 3000;
  const dir = fakeKiloDir();
  // Окружение — правкой process.env, как runAdapter: на Windows имя PATH в копии
  // окружения — «Path», и второй ключ PATH рядом с ним дал бы двусмысленность.
  const saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  let child;
  try {
    process.env.PATH = `${dir}${path.delimiter}${saved.PATH || ''}`;
    process.env.FAKE_KILO_COUNT = String(COUNT);
    for (const key of ['FAKE_KILO_STDOUT', 'FAKE_KILO_STDERR', 'FAKE_KILO_EXIT']) delete process.env[key];
    child = spawn(process.execPath, [SCRIPT], { stdio: ['ignore', 'pipe', 'pipe'] });
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
  const r = await new Promise((resolve) => {
    let out = '';
    let err = '';
    let code;
    let ended = false;
    let reading = false;
    const done = () => { if (code !== undefined && ended) resolve({ code, out, err }); };
    // Слушатель 'readable' без чтения: поток не течёт, труба заполняется, а раннер
    // child_process не сбрасывает такой поток на выходе процесса (без слушателя данные
    // были бы выброшены). Чтение — через 1,5 с, итог — после 'end' потока.
    const drain = () => {
      if (!reading) return;
      let chunk;
      while ((chunk = child.stdout.read()) !== null) out += chunk;
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('readable', drain);
    child.stdout.on('end', () => { ended = true; done(); });
    child.stderr.on('data', (d) => { err += d; });
    setTimeout(() => { reading = true; drain(); }, 1500);
    child.on('close', (exitCode) => { code = exitCode; done(); });
  });
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.length > 200 * 1024, `вывод больше буфера трубы: ${r.out.length} байт; stderr: ${r.err}`);
  const lines = outLines(r.out);
  assert.equal(lines.length, COUNT, `строк ${lines.length} из ${COUNT}`);
  assert.equal(JSON.parse(lines.at(-1)).id, `prov-a/vendor-a/model-${COUNT - 1}`);
});

test('kilo завершился не нулевым кодом — адаптер выходит 1, причина в stderr, моделей нет', () => {
  const r = runAdapter({ exit: 1, stderr: 'boom: upstream failed\n' });
  assert.equal(r.code, 1);
  assert.equal(r.out, '');
  assert.match(r.err, /boom: upstream failed/);
});

test('CRLF в выводе kilo не ломает разбор', () => {
  const obj = {
    id: 'vendor-a/model-i', providerID: 'prov-a', cost: { input: 0, output: 0 },
    capabilities: { toolcall: true, input: { image: true } },
  };
  const crlf = verboseEntry('prov-a/vendor-a/model-i', obj).replace(/\n/g, '\r\n');
  const r = runAdapter({ stdout: `${crlf}\r\n` });
  assert.equal(r.code, 0, r.out + r.err);
  const out = outLines(r.out).map((l) => JSON.parse(l));
  assert.deepEqual(out, [{ id: 'prov-a/vendor-a/model-i', capabilities: ['multimodal'], note: 'in=0 out=0 tools=true free=-' }]);
});

test('формат строки: id, capabilities, note вида in=… out=… tools=… free=…', () => {
  const entry = verboseEntry('prov-a/vendor-a/model-j', {
    id: 'vendor-a/model-j', providerID: 'prov-a', cost: { input: 3, output: 7 },
    capabilities: { toolcall: true, input: { image: true } }, isFree: false,
  });
  const r = runAdapter({ stdout: `${entry}\n` });
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(outLines(r.out).length, 1);
  assert.deepEqual(JSON.parse(outLines(r.out)[0]), {
    id: 'prov-a/vendor-a/model-j',
    capabilities: ['multimodal'],
    note: 'in=3 out=7 tools=true free=false',
  });
});
