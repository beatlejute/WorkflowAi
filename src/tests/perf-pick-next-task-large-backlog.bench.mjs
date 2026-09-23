/**
 * Часы: p95 выбора следующего тикета на 100 тикетах в ready/ (боевые функции из
 * src/scripts/pick-next-task-core.js).
 *
 * Файл назван .bench.mjs, поэтому в основной набор (`npm test` — src/tests/*.test.mjs)
 * он не попадает: бюджет по стенным часам мерит не код, а загрузку машины, и в полном
 * наборе краснел без всякого регресса. Алгоритмическую стоимость охраняет
 * src/tests/perf-pick-next-task-large-backlog.test.mjs в основном наборе, а часы
 * гоняются отдельной целью и по одному замеру за раз:
 *
 *   npm run bench:perf
 *
 * Порог не ослаблен: p95 ≤ 500 мс за 100 итераций, как и был. Состав доски:
 * 70 impl + 30 human, приоритеты по кругу 1-5. Состояние стабильно: выбор
 * ready-тикетов их не перемещает.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createTicketContext, pickNextTicket, calculateReviewMetrics } from '../scripts/pick-next-task-core.js';

const ITERATIONS = 100;
const TICKET_COUNT = 100;
const P95_THRESHOLD_MS = 500;

function calcP95(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, idx)];
}

function ticketContent(id, type, priority) {
  return `---
id: "${id}"
title: "Benchmark ${id}"
priority: ${priority}
type: "${type}"
created_at: "2026-04-01T10:00:00.000Z"
updated_at: "2026-04-01T10:00:00.000Z"
conditions: []
dependencies: []
tags: []
---

## Description

Benchmark ticket ${id}.

## Критерии готовности (Definition of Done)

- [ ] Done
`;
}

test(`pick-next-task: p95 latency ≤ ${P95_THRESHOLD_MS}ms with ${TICKET_COUNT} ready tickets, ${ITERATIONS} iterations`, () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-pick-next-task-'));
  const ticketsDir = path.join(tmpDir, '.workflow', 'tickets');

  for (const dir of ['ready', 'done', 'in-progress', 'review', 'blocked', 'archive', 'backlog']) {
    fs.mkdirSync(path.join(ticketsDir, dir), { recursive: true });
  }
  const readyDir = path.join(ticketsDir, 'ready');

  // 70 impl (non-human) + 30 human, приоритеты по кругу 1-5
  for (let i = 0; i < TICKET_COUNT; i++) {
    const type = i < 70 ? 'impl' : 'human';
    const id = `BENCH-${String(i + 1).padStart(3, '0')}`;
    fs.writeFileSync(path.join(readyDir, `${id}.md`), ticketContent(id, type, (i % 5) + 1));
  }

  const ctx = createTicketContext(tmpDir);
  const latencies = [];

  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();

    const result = pickNextTicket(ctx);
    calculateReviewMetrics(ctx);

    const elapsed = performance.now() - start;

    assert.strictEqual(result.status, 'found', `Iteration ${i}: unexpected status "${result.status}"`);
    latencies.push(elapsed);
  }

  const p95Latency = calcP95(latencies);
  const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const maxLatency = Math.max(...latencies);

  console.log(
    `pick-next-task perf (${TICKET_COUNT} tickets): avg=${avgLatency.toFixed(2)}ms  p95=${p95Latency.toFixed(2)}ms  max=${maxLatency.toFixed(2)}ms`
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });

  assert.ok(
    p95Latency <= P95_THRESHOLD_MS,
    `p95 ${p95Latency.toFixed(2)}ms exceeds threshold ${P95_THRESHOLD_MS}ms`
  );
});
