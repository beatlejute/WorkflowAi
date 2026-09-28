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
 */

import fs from 'node:fs';
import path from 'node:path';
import { getJson, resolveModelKey, redactNetworkDetail } from '../lib/model-client.mjs';
import { replaceFileAtomicSync } from '../lib/utils.mjs';
import { getGlobalDir } from '../global-dir.mjs';

const CACHE_VERSION = 1;
const DEFAULT_TIMEOUT_S = 20;
const HOUR_MS = 60 * 60 * 1000;
const MAX_AGE_MS = 24 * HOUR_MS;
const UNKNOWN_KEY_MIN_AGE_MS = HOUR_MS;

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

function readIds() {
  let text = '';
  try {
    text = fs.readFileSync(0, 'utf-8');
  } catch {
    return [];
  }
  return [...new Set(text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
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
  for (const model of models) {
    if (typeof model?.id !== 'string' || Object.hasOwn(catalog, model.id)) continue;
    catalog[model.id] = typeof model.canonical_slug === 'string' ? model.canonical_slug : null;
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

async function main() {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const ids = readIds();
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
