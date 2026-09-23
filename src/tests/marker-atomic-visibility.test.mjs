// Маркер запущенного пайплайна (.workflow/logs/.pipeline.lock) появляется в каталоге
// целиком или не появляется вовсе.
//
// Инцидент 2026-09-24: writeMarker создавал файл через openSync(path, 'wx') и писал
// содержимое вторым вызовом. Между ними в каталоге лежит файл нулевой длины, а readMarker
// на пустом содержимом отдаёт null — «маркера нет». Цена: второй запуск пайплайна в этот
// момент считает, что никто не работает, и стартует параллельно — ровно то, что singleton
// и должен предотвращать; команда остановки в это же окно отвечает «нечего останавливать».
// Проявление в наборе: runner-singleton.test.mjs под нагрузкой падал с «Config file not
// found» — второй запуск не увидел живой маркер и пошёл выполнять пайплайн.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeMarker, readMarker } from '../lib/marker.mjs';

const MARKER_REL = join('.workflow', 'logs', '.pipeline.lock');

const payload = (pid = 4242) => ({
  pid,
  started_at: new Date().toISOString(),
  started_by: 'test',
  run_id: 'pipeline_test',
  pipeline_log: '.workflow/logs/pipeline_test.log',
  project_root: 'unused',
  pipeline_version: '1.0.0'
});

function withProject(fn) {
  const root = mkdtempSync(join(tmpdir(), 'marker-atomic-'));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Снимок состояния маркера глазами читателя: 'none' — файла нет, 'valid' — читается
 * и содержит pid, 'partial' — файл есть, но читателю не даётся (пустой или битый JSON).
 */
function snapshot(root) {
  const markerPath = join(root, MARKER_REL);
  if (!fs.existsSync(markerPath)) return 'none';
  const marker = readMarker(root);
  if (marker && typeof marker.pid === 'number') return 'valid';
  return `partial(${JSON.stringify(readFileSync(markerPath, 'utf-8').slice(0, 40))})`;
}

test('маркер: читатель ни в одной точке записи не видит пустой или битый файл', () => {
  withProject((root) => {
    const seen = [];
    const patched = ['openSync', 'writeFileSync', 'writeSync', 'closeSync', 'linkSync', 'renameSync', 'unlinkSync'];
    const original = {};
    for (const name of patched) {
      if (typeof fs[name] !== 'function') continue;
      original[name] = fs[name];
      fs[name] = (...args) => {
        const result = original[name](...args);
        seen.push(snapshot(root));
        return result;
      };
    }

    try {
      writeMarker(root, payload());
    } finally {
      for (const [name, fn] of Object.entries(original)) fs[name] = fn;
    }

    const bad = seen.filter((state) => state.startsWith('partial'));
    assert.deepEqual(bad, [], `между вызовами fs читатель видел неполный маркер: ${bad.join(', ')}`);
    assert.equal(snapshot(root), 'valid', 'после записи маркер обязан читаться');
  });
});

test('маркер: повторная запись поверх живого маркера — отказ, содержимое прежнего не тронуто', () => {
  withProject((root) => {
    writeMarker(root, payload(1111));
    assert.throws(() => writeMarker(root, payload(2222)), /already exists/);
    assert.equal(readMarker(root).pid, 1111, 'чужой маркер не перезаписывается');
  });
});

test('маркер: после записи рядом не остаётся временных файлов', () => {
  withProject((root) => {
    writeMarker(root, payload());
    const logsDir = join(root, '.workflow', 'logs');
    const leftovers = readdirSync(logsDir).filter((name) => name !== '.pipeline.lock');
    assert.deepEqual(leftovers, [], `в каталоге логов остался мусор: ${leftovers.join(', ')}`);
  });
});
