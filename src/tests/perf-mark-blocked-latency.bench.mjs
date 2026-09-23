/**
 * Часы: p95 задержки mark-blocked (боевая функция из src/scripts/mark-blocked-core.js).
 *
 * Файл назван .bench.mjs, поэтому в основной набор (`npm test` — src/tests/*.test.mjs)
 * он не попадает: бюджет по стенным часам мерит не код, а загрузку машины, и в полном
 * наборе краснел без всякого регресса. Алгоритмическую стоимость охраняет
 * src/tests/perf-mark-blocked-latency.test.mjs в основном наборе, а часы гоняются
 * отдельной целью и по одному замеру за раз:
 *
 *   npm run bench:perf
 *
 * Порог не ослаблен: p95 ≤ 200 мс за 100 итераций, как и был.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { markBlockedTicket } from '../scripts/mark-blocked-core.js';

const ITERATIONS = 100;
const P95_THRESHOLD_MS = 200;

function calcP95(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, idx)];
}

test(`mark-blocked: p95 latency ≤ ${P95_THRESHOLD_MS}ms over ${ITERATIONS} iterations`, () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-mark-blocked-'));
  const ticketsDir = path.join(tmpDir, '.workflow', 'tickets');
  const stateDir = path.join(tmpDir, '.workflow', 'state');
  const alertsFile = path.join(stateDir, 'alerts.jsonl');

  for (const dir of ['ready', 'in-progress', 'blocked', 'done', 'review', 'backlog', 'approvals']) {
    fs.mkdirSync(path.join(ticketsDir, dir), { recursive: true });
  }
  fs.mkdirSync(stateDir, { recursive: true });

  const ticketId = 'BENCH-001';
  const ticketPath = path.join(ticketsDir, 'ready', `${ticketId}.md`);
  fs.writeFileSync(ticketPath, `---
id: "${ticketId}"
title: "Benchmark ${ticketId}"
priority: 2
type: "impl"
created_at: "2026-04-01T10:00:00.000Z"
updated_at: "2026-04-01T10:00:00.000Z"
---

## Description

Benchmark test ticket.
`);

  const latencies = [];

  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    markBlockedTicket({
      ticketId,
      attempts: i + 1,
      reason: `benchmark_run_${i}`,
      ticketsDir,
      stateDir,
      alertsFile,
      project: 'bench',
    });
    const elapsed = performance.now() - start;
    latencies.push(elapsed);
  }

  const p95Latency = calcP95(latencies);
  const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const maxLatency = Math.max(...latencies);

  console.log(
    `mark-blocked perf: avg=${avgLatency.toFixed(2)}ms  p95=${p95Latency.toFixed(2)}ms  max=${maxLatency.toFixed(2)}ms`
  );

  // Записи алертов накопились — значит мерили работу, а не пустой вызов.
  const alerts = fs.readFileSync(alertsFile, 'utf8').trim().split('\n');
  assert.equal(alerts.length, ITERATIONS);

  fs.rmSync(tmpDir, { recursive: true, force: true });

  assert.ok(
    p95Latency <= P95_THRESHOLD_MS,
    `p95 ${p95Latency.toFixed(2)}ms exceeds threshold ${P95_THRESHOLD_MS}ms`
  );
});
