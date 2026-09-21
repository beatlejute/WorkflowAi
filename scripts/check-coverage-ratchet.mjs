#!/usr/bin/env node
/**
 * Гейт покрытия: у каждого файла свой порог — его измеренное покрытие.
 *
 * Прежний гейт — `c8 check-coverage` с `per-file: true` и одним порогом
 * 80/75 на всех — не проходил ни разу: из 11 прогонов CI `Tests` все красные,
 * ниже порога было 19 файлов. Гейт, который всегда красный, ничего не ловит.
 *
 * Здесь порог файла берётся из `coverage-baseline.json` — это покрытие,
 * измеренное на момент записи. Упасть ниже нельзя, подняться можно. Новый
 * файл, которого в базе нет, держит общий порог по умолчанию.
 *
 * База — минимум по Windows и Linux: ветки вида `process.platform === 'win32'`
 * покрываются на разных ОС по-разному, и порог одной системы уронил бы другую.
 *
 * Запуск после `npm run coverage` (нужен `coverage/coverage-summary.json`):
 *   node scripts/check-coverage-ratchet.mjs            — проверка
 *   node scripts/check-coverage-ratchet.mjs --update   — переписать базу
 *                                                       по текущему замеру
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUMMARY = path.join(ROOT, 'coverage', 'coverage-summary.json');
const BASELINE = path.join(ROOT, 'coverage-baseline.json');
const METRICS = ['lines', 'statements', 'functions', 'branches'];

/** Путь из отчёта c8 (абсолютный, с разделителями ОС) → ключ базы. */
function relativeKey(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** @returns {Map<string, Record<string, number>>} измеренное покрытие по файлам */
function measured() {
  if (!fs.existsSync(SUMMARY)) {
    console.error(`[coverage-ratchet] нет ${path.relative(ROOT, SUMMARY)} — сначала npm run coverage`);
    process.exit(1);
  }
  const summary = readJson(SUMMARY);
  const result = new Map();
  for (const [file, data] of Object.entries(summary)) {
    if (file === 'total') { continue; }
    result.set(relativeKey(file), Object.fromEntries(METRICS.map((m) => [m, data[m].pct])));
  }
  return result;
}

const current = measured();

if (process.argv.includes('--update')) {
  const previous = fs.existsSync(BASELINE) ? readJson(BASELINE) : {};
  const baseline = {
    _comment: previous._comment
      ?? 'Порог покрытия каждого файла. Пишется scripts/check-coverage-ratchet.mjs --update.',
    default: previous.default ?? { lines: 80, statements: 80, functions: 80, branches: 75 },
    files: Object.fromEntries([...current.entries()].sort(([a], [b]) => a.localeCompare(b)))
  };
  fs.writeFileSync(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`[coverage-ratchet] база переписана: ${current.size} файлов`);
  process.exit(0);
}

if (!fs.existsSync(BASELINE)) {
  console.error(`[coverage-ratchet] нет ${path.relative(ROOT, BASELINE)}`);
  process.exit(1);
}

const baseline = readJson(BASELINE);
const failures = [];

for (const [file, pct] of current) {
  const floor = baseline.files[file] ?? baseline.default;
  const source = baseline.files[file] ? 'база' : 'по умолчанию';
  for (const m of METRICS) {
    if (pct[m] < floor[m]) {
      failures.push(`${file}: ${m} ${pct[m]}% < ${floor[m]}% (${source})`);
    }
  }
}

// Запись базы без файла — мёртвая: порог, который ничего не проверяет.
for (const file of Object.keys(baseline.files)) {
  if (!current.has(file)) {
    failures.push(`${file}: есть в базе, нет в отчёте — файл удалён или переименован, уберите запись`);
  }
}

if (failures.length > 0) {
  console.error(`[coverage-ratchet] ниже порога: ${failures.length}`);
  for (const line of failures) { console.error(`  ${line}`); }
  process.exit(1);
}

console.log(`[coverage-ratchet] ok: ${current.size} файлов не ниже порога`);
