#!/usr/bin/env node

/**
 * Команда оценок участников пула моделей (`models.scores` в pipeline.yaml).
 *
 * Раннер при раскрытии пула с селектором пишет в stdin полные id участников, по
 * одному на строку, и читает из stdout один JSON-объект — оценки идут только во
 * вход агента-селектора: пул они не режут и не переупорядочивают. Формат
 * источника знает только этот скрипт, раннер — нет.
 *
 *   node model-scores.js --benchmarks-url <url> --models-url <url> --key-file <путь>
 *     [--cache <путь>] [--timeout <с>]
 *
 * Адреса — только из аргументов. Источник по поставляемому конфигу — оценки
 * `benchmarks` (intelligence/coding/agentic) и каталог моделей: оба GET с ключом
 * `Authorization: Bearer`, ключ — файл `--key-file` (`~` — домашний каталог), в
 * вывод он не попадает. Прокси и допуск `http:` только для своей машины — как у
 * клиента модели (lib/model-client.mjs, getJson). `--timeout` — на каждый GET,
 * по умолчанию 20 с: оба GET укладываются в 60 с команды раннера.
 *
 * Сопоставление id участника с оценкой:
 *   1. ключ — полный id без первого сегмента-маршрута (`route/vendor/model:free` → `vendor/model:free`);
 *   2. ключ → запись каталога с тем же `id` → её `canonical_slug`;
 *   3. `canonical_slug` → строка оценок с тем же `model_permaslug`.
 * Участника без записи каталога или без строки оценок в выводе нет; оценка
 * `null` в источнике — `null` в выводе.
 *
 * Кэш — `--cache`, по умолчанию `<WORKFLOW_HOME|~/.workflow>/cache/model-scores.json`,
 * общий для проектов машины. Оба GET заново, когда:
 *   1. файла нет, он не читается или `version` другая;
 *   2. кэшу 24 ч и больше или дата загрузки в будущем (сбитые часы);
 *   3. ключа участника нет в каталоге кэша и кэшу 1 ч и больше — модель, которой
 *      нет в каталоге, иначе давала бы загрузку на каждом старте раннера.
 * Загрузка не удалась — прежний кэш и WARN в stderr; кэша нет — ошибка в stderr
 * и выход 1. Запись — временный файл того же каталога и rename поверх
 * (replaceFileAtomicSync): второй раннер не прочитает частичный файл.
 *
 * Вывод:
 *   {"as_of": "<as_of источника>", "citation": "<атрибуция источника>",
 *    "scores": {"<полный id>": {"intelligence": 33.7, "coding": 68.1, "agentic": 45.8}}}
 *
 * Режим фактов — команда `selection.scores` стадии с выбором модели (README, «Выбор
 * модели стадии»). Режим — по входу: все непустые строки начинаются с `{` — факты, ни
 * одна — прежний режим выше (его вывод не менялся), смесь — `bad input`, выход 1.
 * Строка входа — `{"id": "<id модели, как её вызывает агент>", "host": "kilo"|"claude"|null}`.
 * Вывод — один JSON:
 *   {"as_of", "citation", "models": [{"id", "host", "resolved": "<slug оценки>"|null,
 *     "intelligence", "coding", "agentic", "free": <bool>,
 *     "free_source": "kilo"|"openrouter_id"|"openrouter_price"|"unknown"}]}
 * Правила оценки и бесплатности — lib/model-facts.mjs. Флаг `isFree` kilo читается
 * `kilo models --verbose` (lib/kilo-catalog.mjs), только если во входе есть хост kilo,
 * параллельно с GET каталога: худший случай — max(18 с kilo, 2 × 20 с GET) в пределах
 * 60 с раннера; своего кэша у kilo нет — флаг должен быть свежим. Сбой kilo — WARN,
 * флаги только по OpenRouter, выход 0. Сбой загрузки без кэша — WARN и пустой каталог:
 * оценок нет, но флаг kilo остаётся — бесплатная модель kilo не уходит в платные из-за
 * сети OpenRouter.
 *
 * Кэш — `version: 1`, ключ `models` добавочный: `{"<id каталога>": {"created": <unix с>|null,
 * "prompt": "<цена>"|null, "completion": "<цена>"|null, "alias_target": "<slug>"|null}}` —
 * цена и указатель `~…-latest` каталога. Читатель 1.16.x лишний ключ пропускает. Кэш без
 * `models` в режиме фактов считается устаревшим (одна лишняя пара GET, если его переписал
 * старый раннер другого проекта); прежний режим его не перечитывает.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getJson, resolveModelKey, redactNetworkDetail } from '../lib/model-client.mjs';
import { replaceFileAtomicSync } from '../lib/utils.mjs';
import { getGlobalDir } from '../global-dir.mjs';
import { runKiloVerbose, parseVerbose } from '../lib/kilo-catalog.mjs';
import { modelFacts, directRecord, catalogIndex } from '../lib/model-facts.mjs';

const CACHE_VERSION = 1;
const DEFAULT_TIMEOUT_S = 20;
const HOUR_MS = 60 * 60 * 1000;
const MAX_AGE_MS = 24 * HOUR_MS;
const UNKNOWN_KEY_MIN_AGE_MS = HOUR_MS;
// Предел `kilo models --verbose` в режиме фактов: замеры 7,7–18,4 с (П6), и kilo идёт
// параллельно с GET (2 × 20 с) — 45 с оставляют запас до таймаута раннера 60 с.
const KILO_TIMEOUT_MS = 45_000;

class ScoresError extends Error {}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const take = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new ScoresError(`${arg} needs a value`);
      i++;
      return value;
    };
    if (arg === '--benchmarks-url') opts.benchmarksUrl = take();
    else if (arg === '--models-url') opts.modelsUrl = take();
    else if (arg === '--key-file') opts.keyFile = take();
    else if (arg === '--cache') opts.cache = take();
    else if (arg === '--timeout') opts.timeout = Number(take());
    else throw new ScoresError(`unknown argument: ${arg}`);
  }
  for (const [flag, value] of [['--benchmarks-url', opts.benchmarksUrl], ['--models-url', opts.modelsUrl], ['--key-file', opts.keyFile]]) {
    if (!value) throw new ScoresError(`${flag} is required`);
  }
  if (opts.timeout !== undefined && !(Number.isFinite(opts.timeout) && opts.timeout > 0)) {
    throw new ScoresError('--timeout must be a number > 0');
  }
  opts.timeout ??= DEFAULT_TIMEOUT_S;
  opts.cache ??= path.join(getGlobalDir(), 'cache', 'model-scores.json');
  return opts;
}

/** Полный id без маршрута: `route/vendor/model` → `vendor/model`. */
function memberKey(fullId) {
  const slash = fullId.indexOf('/');
  return slash === -1 ? fullId : fullId.slice(slash + 1);
}

/**
 * Вход команды: `{ mode: 'legacy', ids }` — id по строке, как раньше; `{ mode: 'facts',
 * lines }` — строки JSON `{id, host}`. Смесь или испорченная строка фактов — ScoresError.
 */
function readInput() {
  let text = '';
  try {
    text = fs.readFileSync(0, 'utf-8');
  } catch {
    return { mode: 'legacy', ids: [] };
  }
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const json = lines.filter((line) => line.startsWith('{')).length;
  if (json === 0) return { mode: 'legacy', ids: [...new Set(lines)] };
  if (json !== lines.length) throw new ScoresError('bad input: id lines mixed with JSON lines');
  const facts = lines.map((line) => {
    let value = null;
    try {
      value = JSON.parse(line);
    } catch {
      // value остаётся null — ошибка ниже
    }
    if (!value || typeof value.id !== 'string' || !value.id
      || !(value.host === undefined || value.host === null || typeof value.host === 'string')) {
      throw new ScoresError(`bad input: not a {"id", "host"} line: ${line.slice(0, 200)}`);
    }
    return { id: value.id, host: value.host ?? null };
  });
  return { mode: 'facts', lines: facts };
}

/** Кэш версии CACHE_VERSION с датой загрузки; иначе null (правило 1). */
function readCache(file) {
  let cache;
  try {
    cache = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
  if (cache?.version !== CACHE_VERSION || !Number.isFinite(Date.parse(cache.fetched_at))
    || typeof cache.catalog !== 'object' || cache.catalog === null
    || typeof cache.benchmarks !== 'object' || cache.benchmarks === null) {
    return null;
  }
  return cache;
}

function needsRefresh(cache, keys, now) {
  if (!cache) return true;
  const age = now - Date.parse(cache.fetched_at);
  // Дата из будущего (сбитые часы, битый файл) — как просроченный кэш: иначе общий для
  // машины кэш не обновлялся бы, пока часы её не догонят.
  if (!(age >= 0) || age >= MAX_AGE_MS) return true;
  return age >= UNKNOWN_KEY_MIN_AGE_MS && keys.some((key) => !Object.hasOwn(cache.catalog, key));
}

const indexValue = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function dataArray(json, what) {
  if (!Array.isArray(json?.data)) throw new ScoresError(`${what} response has no data array`);
  return json.data;
}

/** Оба GET и новый кэш; сбой — исключение. */
async function fetchCache(opts, now) {
  const key = resolveModelKey({ id: 'model-scores', auth: { file: opts.keyFile } });
  const request = { key, timeoutS: opts.timeout };
  const models = dataArray(await getJson(opts.modelsUrl, request), 'models');
  const benchmarksJson = await getJson(opts.benchmarksUrl, request);
  const rows = dataArray(benchmarksJson, 'benchmarks');

  const catalog = {};
  const modelMeta = {};
  const priceText = (value) => (typeof value === 'string' ? value : (typeof value === 'number' && Number.isFinite(value) ? String(value) : null));
  for (const model of models) {
    if (typeof model?.id !== 'string' || Object.hasOwn(catalog, model.id)) continue;
    catalog[model.id] = typeof model.canonical_slug === 'string' ? model.canonical_slug : null;
    modelMeta[model.id] = {
      created: indexValue(model.created),
      prompt: priceText(model.pricing?.prompt),
      completion: priceText(model.pricing?.completion),
      alias_target: typeof model.alias_target?.slug === 'string' ? model.alias_target.slug : null,
    };
  }
  const benchmarks = {};
  for (const row of rows) {
    const slug = row?.model_permaslug;
    if (typeof slug !== 'string' || Object.hasOwn(benchmarks, slug)) continue;
    benchmarks[slug] = {
      intelligence: indexValue(row.intelligence_index),
      coding: indexValue(row.coding_index),
      agentic: indexValue(row.agentic_index),
    };
  }
  const meta = benchmarksJson.meta || {};
  return {
    version: CACHE_VERSION,
    fetched_at: new Date(now).toISOString(),
    as_of: meta.as_of ?? null,
    citation: meta.citation ?? null,
    source_url: meta.source_url ?? null,
    catalog,
    benchmarks,
    models: modelMeta,
  };
}

function writeCache(file, cache) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    replaceFileAtomicSync(file, `${JSON.stringify(cache, null, 2)}\n`, { warn: (message) => warn(message) });
  } catch (err) {
    warn(`cache not written: ${err.code || err.message}`);
  }
}

function warn(message) {
  process.stderr.write(`WARN model-scores: ${message.replace(/\s+/g, ' ').trim()}\n`);
}

function scoresFor(ids, cache) {
  const scores = {};
  for (const id of ids) {
    const slug = cache.catalog[memberKey(id)];
    const row = typeof slug === 'string' && Object.hasOwn(cache.benchmarks, slug) ? cache.benchmarks[slug] : null;
    if (row) scores[id] = { intelligence: row.intelligence ?? null, coding: row.coding ?? null, agentic: row.agentic ?? null };
  }
  return scores;
}

/** Объекты моделей `kilo models --verbose` по id строки; сбой kilo — WARN и null. */
async function readKilo() {
  try {
    const output = await runKiloVerbose({ timeoutMs: KILO_TIMEOUT_MS });
    return new Map(parseVerbose(output, { warn: (message) => warn(`kilo models: ${message}`) }).map((entry) => [entry.id, entry.obj]));
  } catch (err) {
    warn(`kilo free flags not read, free models by OpenRouter only: ${err.message}`);
    return null;
  }
}

async function facts(opts, lines) {
  // kilo — параллельно с GET каталога: его 8–18 с не складываются с загрузкой.
  const kilo = lines.some((line) => line.host === 'kilo') ? readKilo() : Promise.resolve(null);
  const now = Date.now();
  let cache = readCache(opts.cache);
  // Ключ «не из каталога» — id без прямой записи (правило R1): такой id обновляет кэш
  // старше часа, как ключ участника в прежнем режиме.
  const index = cache ? catalogIndex(cache) : null;
  const keys = lines.map((line) => (index ? directRecord(line.id, index)?.id : null) ?? line.id);
  const stale = !cache || typeof cache.models !== 'object' || cache.models === null;
  if (stale || needsRefresh(cache, keys, now)) {
    try {
      cache = await fetchCache(opts, now);
      writeCache(opts.cache, cache);
    } catch (err) {
      const detail = redactNetworkDetail(err.message);
      if (cache) {
        warn(`scores not refreshed, using cache of ${cache.fetched_at}: ${detail}`);
      } else {
        warn(`catalog not loaded, no scores and no catalog prices: ${detail}`);
        cache = { as_of: null, citation: null, catalog: {}, benchmarks: {}, models: {} };
      }
    }
  }
  const models = modelFacts(lines, cache, await kilo, warn);
  return { as_of: cache.as_of ?? null, citation: cache.citation ?? null, models };
}

async function main() {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const input = readInput();
    if (input.mode === 'facts') {
      process.stdout.write(`${JSON.stringify(await facts(opts, input.lines))}\n`);
      return 0;
    }
    const { ids } = input;
    const now = Date.now();
    let cache = readCache(opts.cache);
    if (needsRefresh(cache, ids.map(memberKey), now)) {
      try {
        cache = await fetchCache(opts, now);
        writeCache(opts.cache, cache);
      } catch (err) {
        if (!cache) throw err;
        warn(`scores not refreshed, using cache of ${cache.fetched_at}: ${redactNetworkDetail(err.message)}`);
      }
    }
    process.stdout.write(`${JSON.stringify({ as_of: cache.as_of, citation: cache.citation, scores: scoresFor(ids, cache) })}\n`);
    return 0;
  } catch (err) {
    const errorClass = err.class ? ` (${err.class})` : '';
    process.stderr.write(`model-scores: ${redactNetworkDetail(err.message).replace(/\s+/g, ' ').trim()}${errorClass}\n`);
    return 1;
  }
}

// Код выхода — process.exitCode, а не process.exit: на POSIX запись в трубу асинхронна,
// и process.exit сразу после печати обрезал бы вывод сверх буфера трубы.
main().then((code) => { process.exitCode = code; });
