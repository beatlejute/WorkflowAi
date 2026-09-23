/**
 * Часы: p95 задержки approval-хука (боевая функция из src/scripts/move-ticket-core.js).
 *
 * Файл назван .bench.mjs, поэтому в основной набор (`npm test` — src/tests/*.test.mjs)
 * он не попадает. Причина: бюджет по стенным часам падал в полном наборе, где десяток
 * воркеров одновременно молотит диск, и был зелёным в изоляции — такой красный никто
 * не считал настоящим. Алгоритмическую стоимость (число обращений к диску, от нагрузки
 * не зависит) охраняет src/tests/perf-approval-hook-latency.test.mjs в основном наборе,
 * а часы гоняются отдельной целью и по одному замеру за раз:
 *
 *   npm run bench:perf
 *
 * Порог не ослаблен: p95 ≤ 50 мс за 100 итераций, как и был.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { updateApprovalFilesHook } from '../scripts/move-ticket-core.js';

const ITERATIONS = 100;
const P95_THRESHOLD_MS = 50;

function calcP95(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, idx)];
}

test(`approval-hook: p95 latency ≤ ${P95_THRESHOLD_MS}ms over ${ITERATIONS} iterations`, () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-approval-hook-'));
  const workflowDir = path.join(tmpDir, '.workflow');
  const approvalsDir = path.join(workflowDir, 'approvals');
  fs.mkdirSync(approvalsDir, { recursive: true });

  const ticketId = 'BENCH-001';
  const target = 'in-progress';
  const approvalFile = path.join(approvalsDir, `${ticketId}_manual-gate-test_001.json`);

  const pendingPayload = JSON.stringify({
    status: 'pending',
    ticket_id: ticketId,
    created_at: new Date().toISOString(),
  }, null, 2);

  const latencies = [];

  for (let i = 0; i < ITERATIONS; i++) {
    // Возврат гейта в pending — подготовка, вне окна измерения
    fs.writeFileSync(approvalFile, pendingPayload, 'utf8');

    const start = performance.now();
    updateApprovalFilesHook(ticketId, target, fs, workflowDir);
    const elapsed = performance.now() - start;

    latencies.push(elapsed);
  }

  const p95Latency = calcP95(latencies);
  const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const maxLatency = Math.max(...latencies);

  console.log(
    `approval-hook perf: avg=${avgLatency.toFixed(2)}ms  p95=${p95Latency.toFixed(2)}ms  max=${maxLatency.toFixed(2)}ms`
  );

  // Гейт действительно закрывался — иначе мерили бы пустой вызов.
  const decided = JSON.parse(fs.readFileSync(approvalFile, 'utf8'));
  assert.equal(decided.status, 'approved');

  fs.rmSync(tmpDir, { recursive: true, force: true });

  assert.ok(
    p95Latency <= P95_THRESHOLD_MS,
    `p95 ${p95Latency.toFixed(2)}ms exceeds threshold ${P95_THRESHOLD_MS}ms`
  );
});
