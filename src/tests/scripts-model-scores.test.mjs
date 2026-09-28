/**
 * Скрипт оценок участников пула (src/scripts/model-scores.js).
 *
 * На stdin — полные id участников, на stdout — один JSON с оценками по
 * сопоставлению `id без маршрута → canonical_slug каталога → model_permaslug
 * строки оценок`. Каталог и оценки отдаёт локальный сервер (_model-server.mjs),
 * он считает обращения и проверяет заголовок Authorization. Кэш — `--cache` во
 * временном каталоге ОС; возраст кэша задаётся полем `fetched_at` файла. Сеть
 * наружу и ~/.workflow тесты не трогают, каталог снимается в afterEach.
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TEST_KEY, startModelServer, sendJson } from './_model-server.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(PROJECT_ROOT, 'src', 'scripts', 'model-scores.js');

const HOUR_MS = 60 * 60 * 1000;

// Нейтральные данные: маршруты route-x/route-y, производители vendor-a/b/c.
const CATALOG = {
  data: [
    { id: 'vendor-a/model-one:free', canonical_slug: 'vendor-a/model-one-20260101' },
    { id: 'vendor-a/model-two:free', canonical_slug: 'vendor-a/model-two-20260102' },
    { id: 'vendor-b/model-three', canonical_slug: 'vendor-b/model-three-20260103' },
  ],
};
const META = {
  as_of: '2026-09-27T00:00:00.000Z',
  version: 'v1',
  source: 'bench-lab',
  source_url: 'https://bench.example',
  citation: 'Source: Bench Lab (bench.example) via Test Hub.',
};
const BENCHMARKS = {
  data: [
    { source: 'bench-lab', model_permaslug: 'vendor-a/model-one-20260101', display_name: 'One', intelligence_index: 30.5, coding_index: 60.1, agentic_index: 40.2 },
    { source: 'bench-lab', model_permaslug: 'vendor-a/model-two-20260102', display_name: 'Two', intelligence_index: null, coding_index: 12.5, agentic_index: null },
    { source: 'bench-lab', model_permaslug: 'vendor-z/other-20260109', display_name: 'Other', intelligence_index: 1, coding_index: 2, agentic_index: 3 },
  ],
  meta: META,
};

const ONE = 'route-x/vendor-a/model-one:free';
const ONE_OTHER_ROUTE = 'route-y/vendor-a/model-one:free';
const TWO = 'route-x/vendor-a/model-two:free';
const NO_BENCH = 'route-x/vendor-b/model-three';
const NOT_IN_CATALOG = 'route-x/vendor-c/unknown:free';
const ALL_IDS = [ONE, ONE_OTHER_ROUTE, TWO, NO_BENCH, NOT_IN_CATALOG];
const KNOWN_IDS = [ONE, TWO, NO_BENCH];

const EXPECTED_SCORES = {
  [ONE]: { intelligence: 30.5, coding: 60.1, agentic: 40.2 },
  [ONE_OTHER_ROUTE]: { intelligence: 30.5, coding: 60.1, agentic: 40.2 },
  [TWO]: { intelligence: null, coding: 12.5, agentic: null },
};

function run(args, stdin) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (exitCode) => done({ stdout, stderr, exitCode }));
    child.stdin.end(stdin);
  });
}

describe('model-scores: оценки участников с кэшем', () => {
  let server;
  let mode;
  let root;
  let keyFile;
  let cacheFile;

  before(async () => {
    server = await startModelServer((req, res) => {
      if (req.headers.authorization !== `Bearer ${TEST_KEY}`) {
        sendJson(res, 401, { error: { code: 401, message: 'No auth credentials found' } });
        return;
      }
      const route = req.url.startsWith('/models') ? 'models' : 'benchmarks';
      const how = mode[route] || 'ok';
      if (how === 'fail') {
        sendJson(res, 500, { error: { code: 500, message: 'Internal Server Error' } });
      } else if (how === 'notjson') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html>maintenance</html>');
      } else if (how === 'nodata') {
        sendJson(res, 200, { meta: META });
      } else {
        sendJson(res, 200, route === 'models' ? CATALOG : BENCHMARKS);
      }
    });
  });
  after(async () => {
    await server?.close();
  });

  beforeEach(() => {
    mode = {};
    root = mkdtempSync(join(tmpdir(), 'wf-model-scores-'));
    keyFile = join(root, 'service.key');
    writeFileSync(keyFile, `${TEST_KEY}\n`);
    cacheFile = join(root, 'cache', 'nested', 'model-scores.json');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const args = () => [
    '--benchmarks-url', server.url('/benchmarks?source=bench-lab'),
    '--models-url', server.url('/models'),
    '--key-file', keyFile,
    '--cache', cacheFile,
    '--timeout', '5',
  ];
  const scores = async (ids) => {
    const seen = server.requests.length;
    const result = await run(args(), `${ids.join('\n')}\n`);
    const requests = server.requests.slice(seen);
    assert.ok(!result.stdout.includes(TEST_KEY) && !result.stderr.includes(TEST_KEY), 'ключ не печатается');
    return { ...result, requests, hits: requests.length };
  };
  // Кэш с заданным возрастом: fetched_at = сейчас − ageMs.
  const writeCache = (ageMs, overrides = {}) => {
    const cache = {
      version: 1,
      fetched_at: new Date(Date.now() - ageMs).toISOString(),
      as_of: '2026-09-01T00:00:00.000Z',
      citation: 'Old citation',
      source_url: 'https://bench.example',
      catalog: {
        'vendor-a/model-one:free': 'vendor-a/model-one-20260101',
        'vendor-a/model-two:free': 'vendor-a/model-two-20260102',
        'vendor-b/model-three': 'vendor-b/model-three-20260103',
      },
      benchmarks: {
        'vendor-a/model-one-20260101': { intelligence: 1, coding: 2, agentic: 3 },
        'vendor-a/model-two-20260102': { intelligence: 4, coding: 5, agentic: 6 },
      },
      ...overrides,
    };
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(cache));
  };

  it('без кэша: загрузка обоих GET с ключом, сопоставление id → canonical_slug → model_permaslug, атрибуция', async () => {
    const { stdout, exitCode, requests, hits } = await scores(ALL_IDS);

    assert.equal(exitCode, 0, stdout);
    assert.equal(hits, 2);
    assert.deepEqual(requests.map((r) => r.url).sort(), ['/benchmarks?source=bench-lab', '/models']);
    for (const request of requests) {
      assert.equal(request.method, 'GET');
      assert.equal(request.headers.authorization, `Bearer ${TEST_KEY}`);
    }
    const out = JSON.parse(stdout);
    assert.equal(out.as_of, META.as_of);
    assert.equal(out.citation, META.citation);
    // null-оценка — null; без строки оценок и без записи каталога — нет в scores
    assert.deepEqual(out.scores, EXPECTED_SCORES);
  });

  it('кэш пишется в новый каталог через временный файл: после записи в каталоге только файл кэша', async () => {
    const { exitCode } = await scores(ALL_IDS);

    assert.equal(exitCode, 0);
    assert.deepEqual(readdirSync(dirname(cacheFile)), ['model-scores.json']);
    const cache = JSON.parse(readFileSync(cacheFile, 'utf-8'));
    assert.equal(cache.version, 1);
    assert.ok(Math.abs(Date.now() - Date.parse(cache.fetched_at)) < HOUR_MS);
    assert.equal(cache.as_of, META.as_of);
    assert.equal(cache.citation, META.citation);
    assert.equal(cache.source_url, META.source_url);
    assert.deepEqual(cache.catalog, {
      'vendor-a/model-one:free': 'vendor-a/model-one-20260101',
      'vendor-a/model-two:free': 'vendor-a/model-two-20260102',
      'vendor-b/model-three': 'vendor-b/model-three-20260103',
    });
    assert.deepEqual(cache.benchmarks['vendor-a/model-one-20260101'], { intelligence: 30.5, coding: 60.1, agentic: 40.2 });
    assert.deepEqual(cache.benchmarks['vendor-a/model-two-20260102'], { intelligence: null, coding: 12.5, agentic: null });
  });

  it('второй запуск в пределах часа, в том числе с ключом не из каталога, — без обращений к серверу', async () => {
    const first = await scores(ALL_IDS);
    const second = await scores(ALL_IDS);

    assert.equal(first.hits, 2);
    assert.equal(second.exitCode, 0);
    assert.equal(second.hits, 0);
    assert.deepEqual(JSON.parse(second.stdout), JSON.parse(first.stdout));
  });

  it('ключ не из каталога при кэше старше часа — загрузка; моложе часа — без загрузки', async () => {
    writeCache(30 * 60 * 1000);
    const withinHour = await scores([ONE, NOT_IN_CATALOG]);
    assert.equal(withinHour.exitCode, 0);
    assert.equal(withinHour.hits, 0);
    assert.deepEqual(JSON.parse(withinHour.stdout).scores, { [ONE]: { intelligence: 1, coding: 2, agentic: 3 } });

    writeCache(2 * HOUR_MS);
    const olderThanHour = await scores([ONE, NOT_IN_CATALOG]);
    assert.equal(olderThanHour.exitCode, 0);
    assert.equal(olderThanHour.hits, 2);
    assert.deepEqual(JSON.parse(olderThanHour.stdout).scores, { [ONE]: EXPECTED_SCORES[ONE] });
  });

  it('известные ключи: кэш моложе 24 ч — без загрузки, старше 24 ч — загрузка', async () => {
    writeCache(23 * HOUR_MS);
    const fresh = await scores(KNOWN_IDS);
    assert.equal(fresh.exitCode, 0);
    assert.equal(fresh.hits, 0);
    assert.equal(JSON.parse(fresh.stdout).citation, 'Old citation');

    writeCache(25 * HOUR_MS);
    const stale = await scores(KNOWN_IDS);
    assert.equal(stale.exitCode, 0);
    assert.equal(stale.hits, 2);
    assert.equal(JSON.parse(stale.stdout).citation, META.citation);
  });

  // Кэш общий для всех проектов машины: дата из будущего (сбитые часы, битый файл) не
  // должна отключать обновление, пока часы её не догонят.
  it('fetched_at в будущем — загрузка, как у просроченного кэша', async () => {
    writeCache(-3 * 24 * HOUR_MS);
    const future = await scores(KNOWN_IDS);
    assert.equal(future.exitCode, 0, future.stderr);
    assert.equal(future.hits, 2);
    assert.equal(JSON.parse(future.stdout).citation, META.citation);
    assert.ok(Date.parse(JSON.parse(readFileSync(cacheFile, 'utf-8')).fetched_at) <= Date.now(), 'новый кэш с текущей датой');
  });

  it('другая версия кэша или нечитаемый файл — загрузка', async () => {
    writeCache(0, { version: 999 });
    const otherVersion = await scores(KNOWN_IDS);
    assert.equal(otherVersion.exitCode, 0);
    assert.equal(otherVersion.hits, 2);

    writeFileSync(cacheFile, '{ не json');
    const broken = await scores(KNOWN_IDS);
    assert.equal(broken.exitCode, 0);
    assert.equal(broken.hits, 2);
    assert.equal(JSON.parse(readFileSync(cacheFile, 'utf-8')).version, 1);
  });

  it('сбой сервера при прежнем кэше — прежние оценки, WARN в stderr, выход 0, кэш не тронут', async () => {
    writeCache(25 * HOUR_MS);
    mode = { models: 'fail', benchmarks: 'fail' };
    const before = readFileSync(cacheFile, 'utf-8');

    const { stdout, stderr, exitCode, hits } = await scores(KNOWN_IDS);

    assert.equal(exitCode, 0, stderr);
    assert.equal(hits, 1, 'один GET без повторов, второй после сбоя не идёт');
    assert.match(stderr, /WARN/);
    const out = JSON.parse(stdout);
    assert.equal(out.citation, 'Old citation');
    assert.deepEqual(out.scores, {
      [ONE]: { intelligence: 1, coding: 2, agentic: 3 },
      [TWO]: { intelligence: 4, coding: 5, agentic: 6 },
    });
    assert.equal(readFileSync(cacheFile, 'utf-8'), before);
  });

  it('сбой сервера без кэша — выход 1, stdout пуст, файл кэша не создан', async () => {
    mode = { models: 'fail' };
    const { stdout, stderr, exitCode, hits } = await scores(KNOWN_IDS);

    assert.equal(exitCode, 1);
    assert.equal(hits, 1);
    assert.equal(stdout, '');
    assert.notEqual(stderr.trim(), '');
    assert.equal(existsSync(cacheFile), false);
  });

  it('ответ не JSON или без data — сбой загрузки', async () => {
    mode = { models: 'notjson' };
    const notJson = await scores(KNOWN_IDS);
    assert.equal(notJson.exitCode, 1);
    assert.equal(notJson.hits, 1);

    mode = { benchmarks: 'nodata' };
    const noData = await scores(KNOWN_IDS);
    assert.equal(noData.exitCode, 1);
    assert.equal(noData.hits, 2);
    assert.equal(existsSync(cacheFile), false);
  });

  it('ключ не принят сервером — сбой загрузки, ключ не в выводе', async () => {
    writeFileSync(keyFile, 'wrong-key-value\n');
    const { exitCode, stdout, stderr, hits } = await scores(KNOWN_IDS);

    assert.equal(exitCode, 1);
    assert.equal(hits, 1);
    assert.ok(!stdout.includes('wrong-key-value') && !stderr.includes('wrong-key-value'));
  });
});
