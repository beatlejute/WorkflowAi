/**
 * Бенчмарк `snapshot()` на живом `src/` репозитория.
 *
 * Прежде жил в `artifact-snapshot.test.mjs` и шёл внутри `npm test`, где
 * `node --test` гоняет все файлы параллельно. Там он мерил конкуренцию, а не
 * код: в CI-подобном окружении на Windows p95 = 4489 мс при пороге 1500 мс,
 * тот же файл отдельно — p50 ≈ 220 мс, p95 ≈ 260 мс (три прогона). К тому же
 * соседний `run-skill-tests` во время прогона создаёт временные скилы прямо в
 * `src/skills/`, и снимок считал чужие файлы.
 *
 * Теперь запускается отдельно: `npm run bench`. Имя `*.bench.mjs` не
 * подпадает под глоб `src/tests/*.test.mjs`, поэтому в `npm test` не входит.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshot } from '../lib/artifact-snapshot.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('Case 8: benchmark snapshot on real src directory', async (t) => {
  const projectRoot = path.resolve(__dirname, '../..');
  const iterations = 10;
  const durations = [];

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    const snap = await snapshot(projectRoot, {
      includePaths: ['src'],
      excludePatterns: []
    });
    const end = performance.now();

    durations.push(end - start);
  }

  // Вычисляем median и p95
  const sortedDurations = [...durations].sort((a, b) => a - b);
  const median = sortedDurations[Math.floor(sortedDurations.length / 2)];
  const p95Idx = Math.ceil(sortedDurations.length * 0.95) - 1;
  const p95 = sortedDurations[p95Idx];

  const fileCountSnap = await snapshot(projectRoot, {
    includePaths: ['src'],
    excludePatterns: []
  });
  const fileCount = fileCountSnap.fs.size;

  console.log(`[benchmark] snapshot p50=${Math.round(median)}ms p95=${Math.round(p95)}ms files=${fileCount}`);

  assert(median < 800, `median (${Math.round(median)}ms) should be < 800ms`);
  assert(p95 < 1500, `p95 (${Math.round(p95)}ms) should be < 1500ms`);
});
