/**
 * Режим фактов команды оценок (src/scripts/model-scores.js; правила — src/lib/model-facts.mjs):
 * на stdin строки `{"id", "host"}`, на stdout `{as_of, citation, models: [...]}` с оценкой
 * `intelligence` (правила R1–R4) и бесплатностью (флаг kilo, `:free`, цена каталога).
 *
 * Что охраняется:
 *  - оценка: прямая запись; id с маршрутом; id без производителя — единственная запись
 *    с тем же последним сегментом, двух производителей — без оценки; недатированный id —
 *    новейшая версия со slug без даты; датированный id — своя версия; псевдоним
 *    `~<производитель>/<имя>-latest`; семейство без токенов версии; id CLI с датой
 *    (`m-x-4-5-20251001`) — член семейства с той же датой; у новейшей версии нет оценки —
 *    следующая по новизне;
 *  - бесплатность: флаг kilo `isFree: true` у id вне каталога и у id, чья запись
 *    каталога с ценой, — бесплатная; `isFree: false` сильнее `:free` и нулевой цены
 *    каталога; цена kilo 0 без `isFree` при цене каталога > 0 — платная; `:free` —
 *    бесплатная; нулевая цена каталога — бесплатная; без записи — платная (`unknown`);
 *    id без записи с датой — цена члена семейства с той же датой, без даты — цены нет
 *    (`unknown`); хост claude — по цене каталога; цена — прямой записи id: недатированный
 *    платный id с бесплатной новейшей версией (R2) и платный псевдоним с бесплатной целью
 *    — платные;
 *  - градация: пороги — оценки опорных моделей из аргументов (`--anchor-high`,
 *    `--anchor-medium`), `high` — не ниже опоры высокого, `medium` — выше опоры среднего,
 *    `low` — не выше неё; опоры не названы, не оценены или вывернуты — WARN и уровня нет;
 *    оценка взята у младшей версии семейства — `level_source: older`; поправка из своей
 *    практики (`--overrides`, имя уровня или своя оценка) бьёт данные, ключ — в любой
 *    форме (id, без маршрута, без варианта, slug), значение не уровень и не число —
 *    WARN и уровня нет; файла нет — WARN, уровни по данным; голое имя модели принимается
 *    при единственном производителе, неоднозначное — WARN и игнор; опора вне каталога
 *    кэша заказывает загрузку старше часа; в прежнем режиме опоры и поправки не читаются;
 *  - режим и кэш: смесь строк — выход 1; прежний режим — прежний вывод; кэш v1 без
 *    `models` в режиме фактов загружается заново, в прежнем — нет; ключ `models`
 *    переживает чтение прежним режимом; сбой kilo — WARN, выход 0, флаги только по
 *    OpenRouter; kilo и GET идут параллельно (интервалы перекрываются).
 *
 * Каталог и оценки — локальный сервер (_model-server.mjs), kilo — фейковый `kilo.cmd`
 * (Windows) / `kilo` (POSIX) первым в PATH, как в kilo-models-list-script.test.mjs.
 * Сеть наружу и ~/.workflow тесты не трогают. Имена моделей нейтральные.
 *
 * Запуск: node --import ./src/tests/_rails-home.mjs --test src/tests/scripts-model-scores-facts.test.mjs
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, delimiter } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TEST_KEY, startModelServer, sendJson } from './_model-server.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(PROJECT_ROOT, 'src', 'scripts', 'model-scores.js');

const rec = (id, slug, { prompt = '0.000001', completion = '0.000002', created = null, alias = null } = {}) => ({
  id, canonical_slug: slug, created, pricing: { prompt, completion }, ...(alias ? { alias_target: { slug: alias } } : {}),
});
const CATALOG = {
  data: [
    rec('vendor-a/model-one', 'vendor-a/model-one-20260101'),
    rec('vendor-s/model-solo-5', 'vendor-s/model-solo-5-20260301'),
    rec('vendor-t/model-twin', 'vendor-t/model-twin-20260101'),
    rec('vendor-u/model-twin', 'vendor-u/model-twin-20260101'),
    rec('vendor-b/model-pro', 'vendor-b/model-pro-20260423'),
    rec('vendor-b/model-pro-0501', 'vendor-b/model-pro-20260501'),
    rec('vendor-b/model-pro-0813', 'vendor-b/model-pro-20260813', { prompt: '0', completion: '0' }),
    rec('~vendor-c/model-flash-latest', '~vendor-c/model-flash-latest', { alias: 'vendor-c/model-v2-flash' }),
    rec('vendor-c/model-v1-flash', 'vendor-c/model-v1-flash-20260101'),
    rec('vendor-c/model-v2-flash', 'vendor-c/model-v2-flash-20260910', { prompt: '0', completion: '0' }),
    rec('vendor-d/model-v2-lite', 'vendor-d/model-v2-lite-20260101'),
    rec('vendor-d/model-v3-lite', 'vendor-d/model-v3-lite-20260601'),
    rec('vendor-e/m-x-4.5', 'vendor-e/m-4.5-x-20251001'),
    rec('vendor-e/m-x-4.5-0301', 'vendor-e/m-4.5-x-20260301'),
    rec('vendor-f/model-max', 'vendor-f/model-max-20260920'),
    rec('vendor-f/model-max-0801', 'vendor-f/model-max-20260801'),
    rec('vendor-z/model-zero', 'vendor-z/model-zero-20260101', { prompt: '0', completion: '0' }),
    // Имя model-pair: у vendor-p без варианта, у vendor-q только вариант :free — голый ключ
    // model-pair неоднозначен (вариант не делает производителя другим).
    rec('vendor-p/model-pair', 'vendor-p/model-pair-20260101'),
    rec('vendor-q/model-pair:free', 'vendor-q/model-pair:free-20260101'),
    // Производитель в фиде — z-ai, а kilo называет его модели zai (GLM, 2026-10-12):
    // семейство ищется при обоих написаниях, запись версии — при сохранённом токене.
    rec('z-ai/model-glide', 'z-ai/model-glide-20260826'),
    rec('z-ai/model-glide-4-7', 'z-ai/model-glide-4-7-20260119'),
  ],
};
const bench = (slug, intelligence, coding = null) => ({ model_permaslug: slug, intelligence_index: intelligence, coding_index: coding, agentic_index: null });
const META = { as_of: '2026-09-27T00:00:00.000Z', citation: 'Source: Bench Lab via Test Hub.', source_url: 'https://bench.example' };
const BENCHMARKS = {
  data: [
    bench('vendor-a/model-one-20260101', 30.5, 60.1),
    bench('vendor-s/model-solo-5-20260301', 40),
    bench('vendor-t/model-twin-20260101', 11),
    bench('vendor-b/model-pro-20260423', 30.4),
    bench('vendor-b/model-pro-20260501', 33),
    bench('vendor-b/model-pro-20260813', 36),
    bench('vendor-c/model-v1-flash-20260101', 20),
    bench('vendor-c/model-v2-flash-20260910', 39.5),
    bench('vendor-d/model-v2-lite-20260101', 15),
    bench('vendor-d/model-v3-lite-20260601', 25),
    bench('vendor-e/m-4.5-x-20251001', 16.9),
    bench('vendor-e/m-4.5-x-20260301', 20),
    bench('vendor-f/model-max-20260801', 45),
    bench('z-ai/model-glide-20260826', 41.8, 71.5),
    bench('z-ai/model-glide-4-7-20260119', 30.2),
  ],
  meta: META,
};

const BASE = mkdtempSync(join(tmpdir(), 'wf-model-scores-facts-'));
after(() => rmSync(BASE, { recursive: true, force: true }));

// Фейковый kilo: печатает FAKE_KILO_STDOUT через FAKE_KILO_SLEEP_MS и выходит с FAKE_KILO_EXIT.
const KILO_DIR = join(BASE, 'bin');
mkdirSync(KILO_DIR, { recursive: true });
// FAKE_KILO_LOG — файл, куда пишутся время старта и конца (проверка параллельности).
writeFileSync(join(KILO_DIR, 'kilo-stub.mjs'), `
import fs from 'node:fs';
const out = process.env.FAKE_KILO_STDOUT || '';
const log = process.env.FAKE_KILO_LOG || '';
const start = Date.now();
setTimeout(() => {
  if (log) fs.writeFileSync(log, JSON.stringify({ start, end: Date.now() }));
  process.stdout.write(out);
  process.exitCode = Number(process.env.FAKE_KILO_EXIT || '0');
}, Number(process.env.FAKE_KILO_SLEEP_MS || '0'));
`);
if (process.platform === 'win32') {
  writeFileSync(join(KILO_DIR, 'kilo.cmd'), '@node "%~dp0kilo-stub.mjs" %*\r\n');
} else {
  writeFileSync(join(KILO_DIR, 'kilo'), '#!/bin/sh\nexec node "$(dirname "$0")/kilo-stub.mjs" "$@"\n');
  chmodSync(join(KILO_DIR, 'kilo'), 0o755);
}
const kiloEntry = (idLine, obj) => `${idLine}\n${JSON.stringify(obj, null, 2)}\n`;
const KILO_OUT = [
  kiloEntry('kilo/vendor-k/model-stealth', { id: 'vendor-k/model-stealth', providerID: 'kilo', cost: { input: 0, output: 0 }, isFree: true }),
  kiloEntry('kilo/vendor-k/model-trial:free', { id: 'vendor-k/model-trial:free', providerID: 'kilo', cost: { input: 0, output: 0 }, isFree: false }),
  kiloEntry('vendor-a/model-one', { id: 'model-one', providerID: 'vendor-a', cost: { input: 0, output: 0 } }),
  // Флаг kilo против цены каталога: у vendor-a/model-one цена > 0, у vendor-z/model-zero — 0.
  kiloEntry('kilo/vendor-a/model-one', { id: 'vendor-a/model-one', providerID: 'kilo', cost: { input: 0, output: 0 }, isFree: true }),
  kiloEntry('kilo/vendor-z/model-zero', { id: 'vendor-z/model-zero', providerID: 'kilo', cost: { input: 0, output: 0 }, isFree: false }),
].join('');

const ENV_KEYS = ['PATH', 'FAKE_KILO_STDOUT', 'FAKE_KILO_EXIT', 'FAKE_KILO_SLEEP_MS', 'FAKE_KILO_LOG'];

function run(args, stdin, { kilo = KILO_OUT, kiloExit = 0, kiloSleepMs = 0, kiloLog = '' } = {}) {
  const saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.PATH = `${KILO_DIR}${delimiter}${saved.PATH || ''}`;
  process.env.FAKE_KILO_STDOUT = kilo;
  process.env.FAKE_KILO_EXIT = String(kiloExit);
  process.env.FAKE_KILO_SLEEP_MS = String(kiloSleepMs);
  process.env.FAKE_KILO_LOG = kiloLog;
  let child;
  try {
    // Окружение копируется при запуске: восстановить process.env можно сразу после spawn.
    child = spawn(process.execPath, [SCRIPT, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
  return new Promise((done) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (exitCode) => done({ stdout, stderr, exitCode }));
    child.stdin.end(stdin);
  });
}

const factsInput = (lines) => `${lines.map(([id, host = null]) => JSON.stringify({ id, host })).join('\n')}\n`;

describe('model-scores: режим фактов', () => {
  let server;
  let delayMs = 0;
  // Время прихода запроса и отправки ответа сервера: [{ arrived, answered }].
  const timeline = [];
  let root;
  let keyFile;
  let cacheFile;

  before(async () => {
    server = await startModelServer((req, res) => {
      if (req.headers.authorization !== `Bearer ${TEST_KEY}`) {
        sendJson(res, 401, { error: { code: 401, message: 'No auth credentials found' } });
        return;
      }
      const body = req.url.startsWith('/models') ? CATALOG : BENCHMARKS;
      const entry = { arrived: Date.now(), answered: null };
      timeline.push(entry);
      setTimeout(() => {
        entry.answered = Date.now();
        sendJson(res, 200, body);
      }, delayMs);
    });
  });
  after(async () => { await server?.close(); });
  beforeEach(() => {
    delayMs = 0;
    root = mkdtempSync(join(BASE, 'case-'));
    keyFile = join(root, 'service.key');
    writeFileSync(keyFile, `${TEST_KEY}\n`);
    cacheFile = join(root, 'cache', 'model-scores.json');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const args = () => ['--benchmarks-url', server.url('/benchmarks'), '--models-url', server.url('/models'), '--key-file', keyFile, '--cache', cacheFile, '--timeout', '5'];
  const facts = async (lines, options) => {
    const seen = server.requests.length;
    const result = await run(args(), factsInput(lines), options);
    const hits = server.requests.length - seen;
    const out = result.exitCode === 0 ? JSON.parse(result.stdout) : null;
    const byId = out ? Object.fromEntries(out.models.map((m) => [`${m.id}|${m.host ?? ''}`, m])) : {};
    return { ...result, hits, out, get: (id, host = null) => byId[`${id}|${host ?? ''}`] };
  };

  it('оценка: прямая запись, маршрут, без производителя, R2, датированный id, псевдоним, семейство, CLI с датой, R4, написание производителя', async () => {
    const ids = [
      ['vendor-a/model-one'], ['route-x/vendor-a/model-one'], ['model-solo-5'], ['model-twin'],
      ['vendor-b/model-pro'], ['vendor-b/model-pro-0501'], ['vendor-c/model-flash'], ['vendor-d/model-lite'],
      ['m-x-4-5-20251001'], ['vendor-f/model-max'],
      ['zai/model-glide'], ['route-x/zai/model-glide'], ['zai/model-glide-4-7'],
    ];
    const r = await facts(ids);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.hits, 2);
    assert.equal(r.out.as_of, META.as_of);
    assert.equal(r.out.citation, META.citation);
    const score = (id) => [r.get(id).intelligence, r.get(id).resolved];
    assert.deepEqual(score('vendor-a/model-one'), [30.5, 'vendor-a/model-one-20260101']);
    assert.equal(r.get('vendor-a/model-one').coding, 60.1);
    assert.deepEqual(score('route-x/vendor-a/model-one'), [30.5, 'vendor-a/model-one-20260101']);
    assert.deepEqual(score('model-solo-5'), [40, 'vendor-s/model-solo-5-20260301']);
    assert.deepEqual(score('model-twin'), [null, null]);
    assert.match(r.stderr, /WARN model-scores: model "model-twin" is ambiguous/);
    assert.deepEqual(score('vendor-b/model-pro'), [36, 'vendor-b/model-pro-20260813']);
    assert.deepEqual(score('vendor-b/model-pro-0501'), [33, 'vendor-b/model-pro-20260501']);
    assert.deepEqual(score('vendor-c/model-flash'), [39.5, 'vendor-c/model-v2-flash-20260910']);
    assert.deepEqual(score('vendor-d/model-lite'), [25, 'vendor-d/model-v3-lite-20260601']);
    assert.deepEqual(score('m-x-4-5-20251001'), [16.9, 'vendor-e/m-4.5-x-20251001']);
    assert.deepEqual(score('vendor-f/model-max'), [45, 'vendor-f/model-max-20260801']);
    // Фид пишет z-ai, запрос — zai: запись всё равно находится (GLM, 2026-10-12).
    assert.deepEqual(score('zai/model-glide'), [41.8, 'z-ai/model-glide-20260826']);
    assert.deepEqual(score('route-x/zai/model-glide'), [41.8, 'z-ai/model-glide-20260826']);
    assert.deepEqual(score('zai/model-glide-4-7'), [30.2, 'z-ai/model-glide-4-7-20260119']);
  });

  it('бесплатность: kilo, :free, цена каталога, неизвестно; хост claude — по цене', async () => {
    const r = await facts([
      ['kilo/vendor-k/model-stealth', 'kilo'], ['kilo/vendor-k/model-trial:free', 'kilo'], ['vendor-a/model-one', 'kilo'],
      ['route-x/vendor-a/model-free:free'], ['vendor-z/model-zero'], ['vendor-q/unknown-model'], ['model-solo-5', 'claude'],
      ['m-x-4-5-20251001', 'claude'], ['vendor-k/model-stealth'],
      ['kilo/vendor-a/model-one', 'kilo'], ['kilo/vendor-z/model-zero', 'kilo'], ['vendor-d/model-lite'],
      ['vendor-b/model-pro'], ['vendor-b/model-pro-0813'], ['~vendor-c/model-flash-latest'], ['vendor-c/model-v2-flash'],
    ]);
    assert.equal(r.exitCode, 0, r.stderr);
    const free = (id, host = null) => [r.get(id, host).free, r.get(id, host).free_source];
    assert.deepEqual(free('kilo/vendor-k/model-stealth', 'kilo'), [true, 'kilo']);
    assert.equal(r.get('kilo/vendor-k/model-stealth', 'kilo').intelligence, null);
    assert.deepEqual(free('kilo/vendor-k/model-trial:free', 'kilo'), [false, 'kilo']);
    assert.deepEqual(free('vendor-a/model-one', 'kilo'), [false, 'openrouter_price']);
    assert.deepEqual(free('route-x/vendor-a/model-free:free'), [true, 'openrouter_id']);
    assert.deepEqual(free('vendor-z/model-zero'), [true, 'openrouter_price']);
    assert.deepEqual(free('vendor-q/unknown-model'), [false, 'unknown']);
    assert.deepEqual(free('model-solo-5', 'claude'), [false, 'openrouter_price']);
    // Записи нет, дата id совпала с членом семейства — цена этого члена.
    assert.deepEqual(free('m-x-4-5-20251001', 'claude'), [false, 'openrouter_price']);
    // Записи нет, даты в id нет — новейший член семейства даёт оценку, но не цену.
    assert.deepEqual(free('vendor-d/model-lite'), [false, 'unknown']);
    // Флаг kilo сильнее цены каталога в обе стороны (предупреждение стейкхолдера, правило 4).
    assert.deepEqual(free('kilo/vendor-a/model-one', 'kilo'), [true, 'kilo']);
    assert.deepEqual(free('kilo/vendor-z/model-zero', 'kilo'), [false, 'kilo']);
    // Хост не kilo — флаг kilo не читается, даже если id совпал бы.
    assert.deepEqual(free('vendor-k/model-stealth'), [false, 'unknown']);
    // Цена — прямой записи id, не новейшей версии R2 и не цели псевдонима: оценку даёт
    // бесплатная новейшая версия, но недатированный платный id остаётся платным.
    assert.deepEqual(free('vendor-b/model-pro'), [false, 'openrouter_price']);
    assert.equal(r.get('vendor-b/model-pro').intelligence, 36);
    assert.deepEqual(free('vendor-b/model-pro-0813'), [true, 'openrouter_price']);
    assert.deepEqual(free('~vendor-c/model-flash-latest'), [false, 'openrouter_price']);
    assert.equal(r.get('~vendor-c/model-flash-latest').intelligence, 39.5);
    assert.deepEqual(free('vendor-c/model-v2-flash'), [true, 'openrouter_price']);
  });

  it('без хоста kilo kilo не запускается; сбой kilo — WARN, выход 0, флаги только по OpenRouter', async () => {
    const noKilo = await facts([['vendor-z/model-zero']], { kiloExit: 3, kilo: '' });
    assert.equal(noKilo.exitCode, 0);
    assert.doesNotMatch(noKilo.stderr, /kilo/);

    const failed = await facts([['kilo/vendor-k/model-stealth', 'kilo'], ['kilo/vendor-k/model-trial:free', 'kilo']], { kiloExit: 2 });
    assert.equal(failed.exitCode, 0, failed.stderr);
    assert.match(failed.stderr, /WARN model-scores: kilo free flags not read/);
    assert.deepEqual([failed.get('kilo/vendor-k/model-stealth', 'kilo').free, failed.get('kilo/vendor-k/model-stealth', 'kilo').free_source], [false, 'unknown']);
    assert.deepEqual([failed.get('kilo/vendor-k/model-trial:free', 'kilo').free, failed.get('kilo/vendor-k/model-trial:free', 'kilo').free_source], [true, 'openrouter_id']);
  });

  // Параллельность — по перекрытию интервалов, а не по стенным часам: под нагрузкой
  // прогона покрытия (npm run coverage) замер «быстрее суммы задержек» проваливался и у
  // параллельного кода (4,8 с при сумме 3 с, 2026-09-28).
  it('kilo и GET каталога идут параллельно', async () => {
    delayMs = 1500;
    const kiloLog = join(root, 'kilo-times.json');
    const from = timeline.length;
    const r = await facts([['kilo/vendor-k/model-stealth', 'kilo']], { kiloSleepMs: 1500, kiloLog });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.get('kilo/vendor-k/model-stealth', 'kilo').free, true);
    const gets = timeline.slice(from);
    assert.equal(gets.length, 2);
    const kiloRun = JSON.parse(readFileSync(kiloLog, 'utf8'));
    // Последовательно (kilo, затем GET) первый GET пришёл бы после конца kilo; (GET, затем
    // kilo) — kilo стартовал бы после ответа на второй GET.
    assert.ok(gets[0].arrived < kiloRun.end, `первый GET ${gets[0].arrived} после конца kilo ${kiloRun.end}`);
    assert.ok(kiloRun.start < gets[1].answered, `kilo ${kiloRun.start} после ответа на второй GET ${gets[1].answered}`);
  });

  it('смесь строк id и JSON — bad input, выход 1', async () => {
    const r = await run(args(), 'vendor-a/model-one\n{"id":"vendor-a/model-one","host":null}\n');
    assert.equal(r.exitCode, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /bad input/);
    const broken = await run(args(), '{"id": 5}\n');
    assert.equal(broken.exitCode, 1);
    assert.match(broken.stderr, /bad input/);
  });

  it('прежний режим: прежний вывод; ключ models пишется в кэш и переживает чтение прежним режимом', async () => {
    const legacy = await run(args(), 'route-x/vendor-a/model-one\nvendor-b/model-pro\nmodel-solo-5\n');
    assert.equal(legacy.exitCode, 0, legacy.stderr);
    assert.equal(legacy.stdout, `${JSON.stringify({
      as_of: META.as_of, citation: META.citation,
      // Прежнее сопоставление снимает первый сегмент всегда: `vendor-b/model-pro` →
      // `model-pro`, записи нет — оценки нет (факты режима выше этим не ограничены).
      scores: {
        'route-x/vendor-a/model-one': { intelligence: 30.5, coding: 60.1, agentic: null },
      },
    })}\n`);
    const cache = JSON.parse(readFileSync(cacheFile, 'utf8'));
    assert.equal(cache.version, 1);
    assert.deepEqual(cache.models['vendor-z/model-zero'], { created: null, prompt: '0', completion: '0', alias_target: null });
    assert.equal(cache.models['~vendor-c/model-flash-latest'].alias_target, 'vendor-c/model-v2-flash');

    const seen = server.requests.length;
    const again = await run(args(), 'route-x/vendor-a/model-one\n');
    assert.equal(again.exitCode, 0);
    assert.equal(server.requests.length, seen, 'свежий кэш — без загрузки');
    assert.deepEqual(JSON.parse(readFileSync(cacheFile, 'utf8')).models, cache.models);
  });

  it('кэш v1 без models: режим фактов загружает заново, прежний — нет', async () => {
    const old = {
      version: 1, fetched_at: new Date().toISOString(), as_of: 'old', citation: 'Old citation', source_url: null,
      catalog: { 'vendor-a/model-one': 'vendor-a/model-one-20260101' },
      benchmarks: { 'vendor-a/model-one-20260101': { intelligence: 1, coding: 2, agentic: 3 } },
    };
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(old));

    const seen = server.requests.length;
    const legacy = await run(args(), 'vendor-a/model-one\n');
    assert.equal(legacy.exitCode, 0);
    assert.equal(server.requests.length, seen);
    assert.equal(JSON.parse(legacy.stdout).citation, 'Old citation');

    const r = await facts([['vendor-a/model-one']]);
    assert.equal(r.hits, 2);
    assert.equal(r.out.citation, META.citation);
    assert.ok(JSON.parse(readFileSync(cacheFile, 'utf8')).models, 'кэш с models');
  });

  // Градация: опоры задаются аргументами, поправки — файлом. Помощник тот же, но с
  // добавочными аргументами команды (--anchor-high, --overrides и прочие).
  const factsExtra = async (lines, extra = [], options) => {
    const result = await run([...args(), ...extra], factsInput(lines), options);
    const out = result.exitCode === 0 ? JSON.parse(result.stdout) : null;
    const byId = out ? Object.fromEntries(out.models.map((m) => [`${m.id}|${m.host ?? ''}`, m])) : {};
    return { ...result, out, get: (id, host = null) => byId[`${id}|${host ?? ''}`] };
  };
  // Опорами берутся датированные версии: недатированный id разрешается в новейшую
  // версию семейства (правило R2), и опора «съезжала» бы вместе с фидом.
  const ANCHORS = ['--anchor-high', 'vendor-b/model-pro-0813', '--anchor-medium', 'vendor-e/m-x-4.5-20251001'];

  it('градация: пороги — оценки опор, уровень по ним; оценка младшей версии — source older', async () => {
    const r = await factsExtra([
      ['vendor-a/model-one'], ['vendor-s/model-solo-5'], ['vendor-b/model-pro'], ['vendor-b/model-pro-0501'],
      ['vendor-e/m-x-4.5-20251001'], ['vendor-d/model-v3-lite'], ['vendor-d/model-v2-lite'], ['vendor-f/model-max'],
      ['kilo/vendor-k/model-stealth', 'kilo'],
    ], ANCHORS);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.deepEqual(r.out.levels, {
      high: 36, medium: 16.9, anchors: { high: 'vendor-b/model-pro-0813', medium: 'vendor-e/m-x-4.5-20251001' },
    });
    const level = (id, host = null) => [r.get(id, host).level, r.get(id, host).level_source];
    assert.deepEqual(level('vendor-a/model-one'), ['medium', 'feed']);
    assert.deepEqual(level('vendor-s/model-solo-5'), ['high', 'feed']);
    assert.deepEqual(level('vendor-b/model-pro'), ['high', 'feed']);
    assert.deepEqual(level('vendor-b/model-pro-0501'), ['medium', 'feed']);
    // Ровно на опоре среднего — низ («ниже уровня опоры» — строгое неравенство).
    assert.deepEqual(level('vendor-e/m-x-4.5-20251001'), ['low', 'feed']);
    assert.deepEqual(level('vendor-d/model-v3-lite'), ['medium', 'feed']);
    assert.deepEqual(level('vendor-d/model-v2-lite'), ['low', 'feed']);
    // Оценки самой версии нет — взята у младшей (правило R4).
    assert.deepEqual(level('vendor-f/model-max'), ['high', 'older']);
    assert.deepEqual(level('kilo/vendor-k/model-stealth', 'kilo'), [null, null]);
  });

  it('градация: опоры не названы, не оценены или вывернуты — уровня нет и WARN', async () => {
    const none = await factsExtra([['vendor-a/model-one']]);
    assert.equal(none.exitCode, 0, none.stderr);
    assert.match(none.stderr, /WARN model-scores: level anchors not scored/);
    assert.deepEqual([none.out.levels.high, none.out.levels.medium, none.get('vendor-a/model-one').level], [null, null, null]);

    const backward = await factsExtra([['vendor-a/model-one']], ['--anchor-high', 'vendor-e/m-x-4.5', '--anchor-medium', 'vendor-b/model-pro']);
    assert.equal(backward.exitCode, 0, backward.stderr);
    assert.match(backward.stderr, /WARN model-scores: level anchors out of order/);
    assert.equal(backward.get('vendor-a/model-one').level, null);

    const missing = await factsExtra([['vendor-a/model-one']], ['--anchor-high', 'vendor-q/unknown-model', '--anchor-medium', 'vendor-e/m-x-4.5']);
    assert.match(missing.stderr, /WARN model-scores: level anchors not scored/);
    assert.equal(missing.get('vendor-a/model-one').level, null);
  });

  it('градация: поправка своей практики бьёт оценку данных, ключ — в любой форме', async () => {
    const file = join(root, 'levels.yaml');
    writeFileSync(file, [
      'overrides:',
      '  "vendor-k/model-stealth": high',
      '  "route-x/vendor-a/model-one:free": 40',
      '  "vendor-d/model-v2-lite": medium',
      '  "vendor-q/unknown-model": superb',
      '',
    ].join('\n'));
    const r = await factsExtra([
      ['kilo/vendor-k/model-stealth', 'kilo'], ['route-x/vendor-a/model-one:free'], ['vendor-a/model-one'],
      ['vendor-d/model-v2-lite'], ['vendor-q/unknown-model'], ['vendor-d/model-v3-lite'],
    ], [...ANCHORS, '--overrides', file]);
    assert.equal(r.exitCode, 0, r.stderr);
    const level = (id) => [r.get(id).level, r.get(id).level_source];
    assert.deepEqual([r.get('kilo/vendor-k/model-stealth', 'kilo').level, r.get('kilo/vendor-k/model-stealth', 'kilo').level_source], ['high', 'override']);
    // Своя оценка 40 ≥ опоры высокого уровня: уровень считается теми же порогами.
    assert.deepEqual(level('route-x/vendor-a/model-one:free'), ['high', 'override']);
    assert.deepEqual(level('vendor-a/model-one'), ['medium', 'feed']);
    assert.deepEqual(level('vendor-d/model-v2-lite'), ['medium', 'override']);
    assert.deepEqual(level('vendor-q/unknown-model'), [null, null]);
    assert.match(r.stderr, /WARN model-scores: level override for "vendor-q\/unknown-model" is neither a level/);
    assert.deepEqual(level('vendor-d/model-v3-lite'), ['medium', 'feed']);
  });

  it('градация: файла поправок нет — WARN, уровни по данным', async () => {
    const r = await factsExtra([['vendor-a/model-one']], [...ANCHORS, '--overrides', join(root, 'нет-такого.yaml')]);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stderr, /WARN model-scores: overrides not read \(ENOENT\)/);
    assert.deepEqual([r.get('vendor-a/model-one').level, r.get('vendor-a/model-one').level_source], ['medium', 'feed']);
  });

  it('градация: голое имя модели — при одном производителе работает, неоднозначное — WARN и игнор', async () => {
    const file = join(root, 'bare.yaml');
    writeFileSync(file, ['overrides:', '  "model-one": high', '  "model-twin": high', ''].join('\n'));
    const r = await factsExtra([
      ['vendor-a/model-one'], ['vendor-t/model-twin'], ['vendor-u/model-twin'],
    ], [...ANCHORS, '--overrides', file]);
    assert.equal(r.exitCode, 0, r.stderr);
    // Единственный производитель имени model-one (vendor-a) — голый ключ применяется.
    assert.deepEqual([r.get('vendor-a/model-one').level, r.get('vendor-a/model-one').level_source], ['high', 'override']);
    // Два производителя имени model-twin — WARN, поправка не применяется.
    assert.match(r.stderr, /WARN model-scores: level override key "model-twin" is ambiguous \(vendors vendor-t, vendor-u\) — ignored/);
    assert.notEqual(r.get('vendor-t/model-twin').level_source, 'override');
    assert.notEqual(r.get('vendor-u/model-twin').level_source, 'override');
  });

  it('градация: голый входной id без производителя при двух производителях — WARN и игнор', async () => {
    const file = join(root, 'bare-input.yaml');
    writeFileSync(file, ['overrides:', '  "model-twin": high', ''].join('\n'));
    // Входной id — само голое имя (без производителя): проверка однозначности та же.
    const r = await factsExtra([['model-twin']], [...ANCHORS, '--overrides', file]);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stderr, /WARN model-scores: level override key "model-twin" is ambiguous \(vendors vendor-t, vendor-u\) — ignored/);
    assert.notEqual(r.get('model-twin').level_source, 'override');
  });

  it('градация: вариант :free у второго производителя делает голый ключ неоднозначным', async () => {
    const file = join(root, 'pair.yaml');
    writeFileSync(file, ['overrides:', '  "model-pair": high', ''].join('\n'));
    // Имя model-pair есть у vendor-p (без варианта) и vendor-q (только :free): вариант
    // снимается при подсчёте производителей — ключ неоднозначен.
    const r = await factsExtra([['vendor-p/model-pair']], [...ANCHORS, '--overrides', file]);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stderr, /WARN model-scores: level override key "model-pair" is ambiguous \(vendors vendor-p, vendor-q\) — ignored/);
    assert.notEqual(r.get('vendor-p/model-pair').level_source, 'override');
  });

  it('градация: недействительные опоры — строковая поправка уровень держит, числовая молчит', async () => {
    const file = join(root, 'invalid-anchors.yaml');
    writeFileSync(file, ['overrides:', '  "vendor-d/model-v3-lite": high', '  "vendor-a/model-one": 40', ''].join('\n'));
    // Равные опоры (high ≤ medium) — пороги не сосчитаны.
    const r = await factsExtra([['vendor-d/model-v3-lite'], ['vendor-a/model-one']],
      ['--anchor-high', 'vendor-b/model-pro', '--anchor-medium', 'vendor-b/model-pro', '--overrides', file]);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stderr, /level anchors out of order/);
    assert.deepEqual(r.out.levels, { high: null, medium: null, anchors: { high: 'vendor-b/model-pro', medium: 'vendor-b/model-pro' } });
    // Строковая поправка 'high' сохраняет уровень даже без порогов; числовая 40 — нет.
    assert.deepEqual([r.get('vendor-d/model-v3-lite').level, r.get('vendor-d/model-v3-lite').level_source], ['high', 'override']);
    assert.deepEqual([r.get('vendor-a/model-one').level, r.get('vendor-a/model-one').level_source], [null, null]);
  });

  it('обновление кэша: опора вне каталога кэша заказывает загрузку старше часа', async () => {
    const agedCache = () => ({
      version: 1,
      fetched_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
      as_of: 'cached', citation: 'Cached citation', source_url: null,
      catalog: {
        'vendor-a/model-one': 'vendor-a/model-one-20260101',
        'vendor-b/model-pro-0813': 'vendor-b/model-pro-20260813',
        'vendor-e/m-x-4.5-0301': 'vendor-e/m-4.5-x-20260301',
      },
      benchmarks: {
        'vendor-a/model-one-20260101': { intelligence: 30.5, coding: 60.1, agentic: null },
        'vendor-b/model-pro-20260813': { intelligence: 36, coding: null, agentic: null },
        'vendor-e/m-4.5-x-20260301': { intelligence: 20, coding: null, agentic: null },
      },
      models: {},
    });
    mkdirSync(dirname(cacheFile), { recursive: true });

    // Опоры нет в каталоге кэша — загрузка заказывается (>1 ч), как у ключа кандидата.
    const seen0 = server.requests.length;
    writeFileSync(cacheFile, JSON.stringify(agedCache()));
    const missing = await run([...args(), '--anchor-high', 'vendor-q/missing', '--anchor-medium', 'vendor-e/m-x-4.5-0301'], factsInput([['vendor-a/model-one']]));
    assert.equal(missing.exitCode, 0, missing.stderr);
    assert.equal(server.requests.length - seen0, 2, 'опора вне каталога — загрузка');

    // Кандидат и обе опоры в каталоге — загрузки нет (кэш младше 24 ч).
    const seen1 = server.requests.length;
    writeFileSync(cacheFile, JSON.stringify(agedCache()));
    const present = await run([...args(), '--anchor-high', 'vendor-b/model-pro-0813', '--anchor-medium', 'vendor-e/m-x-4.5-0301'], factsInput([['vendor-a/model-one']]));
    assert.equal(present.exitCode, 0, present.stderr);
    assert.equal(server.requests.length - seen1, 0, 'опоры и кандидат в каталоге — без загрузки');
  });

  it('обновление кэша: отсутствовавшая опора после загрузки оценена, пороги сосчитаны', async () => {
    const aged = {
      version: 1,
      fetched_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
      as_of: 'cached', citation: 'Cached citation', source_url: null,
      catalog: { 'vendor-a/model-one': 'vendor-a/model-one-20260101' },
      benchmarks: { 'vendor-a/model-one-20260101': { intelligence: 30.5, coding: null, agentic: null } },
      models: {},
    };
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(aged));
    const seen = server.requests.length;
    const r = await factsExtra([['vendor-a/model-one']], [...ANCHORS]);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(server.requests.length - seen, 2, 'опоры нет в старом каталоге — загрузка');
    assert.equal(r.out.as_of, META.as_of, 'ответ по свежему кэшу');
    assert.deepEqual([r.out.levels.high, r.out.levels.medium], [36, 16.9], 'опоры оценены после загрузки');
  });

  it('градация: в прежнем режиме опоры и поправки не читаются, вывод прежний', async () => {
    // Прежний режим ждёт id участника пула: маршрут отбрасывается (memberKey).
    const r = await run([...args(), ...ANCHORS], 'route-x/vendor-a/model-one\n');
    assert.equal(r.exitCode, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(out).sort(), ['as_of', 'citation', 'scores']);
    assert.deepEqual(out.scores['route-x/vendor-a/model-one'], { intelligence: 30.5, coding: 60.1, agentic: null });
  });

  it('загрузка не удалась без кэша — WARN, выход 0, флаг kilo остаётся', async () => {
    writeFileSync(keyFile, 'wrong-key\n');
    const r = await facts([['kilo/vendor-k/model-stealth', 'kilo'], ['vendor-a/model-one']]);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stderr, /WARN model-scores: catalog not loaded/);
    assert.equal(r.out.as_of, null);
    assert.deepEqual([r.get('kilo/vendor-k/model-stealth', 'kilo').free, r.get('kilo/vendor-k/model-stealth', 'kilo').free_source], [true, 'kilo']);
    assert.deepEqual([r.get('vendor-a/model-one').intelligence, r.get('vendor-a/model-one').free_source], [null, 'unknown']);
  });
});
