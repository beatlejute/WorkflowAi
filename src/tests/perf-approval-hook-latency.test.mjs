/**
 * Performance benchmark: approval-hook (updateApprovalFilesHook from move-ticket.js)
 *
 * 100 iterations on real FS (tmpdir). Measures p95 latency of the hook itself
 * (FS: existsSync + readdirSync + readFileSync + writeFileSync for one pending file).
 * CI fails if p95 > 50ms.
 *
 * Note: move-ticket.js has module-level side effects, so the hook is replicated here
 * (identical logic to src/scripts/move-ticket.js#updateApprovalFilesHook).
 *
 * Run: node --test src/tests/perf-approval-hook-latency.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ITERATIONS = 100;
const P95_THRESHOLD_MS = 50;

// Replicated from src/scripts/move-ticket.js — keep in sync if hook logic changes.
function updateApprovalFilesHook(ticketId, target, workflowDir) {
  try {
    const approvalsDir = path.join(workflowDir, 'approvals');
    if (fs.existsSync(approvalsDir)) {
      const files = fs.readdirSync(approvalsDir);
      const escapedTicketId = ticketId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`^${escapedTicketId}_manual-gate-.*_\\d+\\.json$`);
      for (const file of files) {
        if (!pattern.test(file)) continue;
        const filePath = path.join(approvalsDir, file);
        try {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          if (data.status === 'pending') {
            data.status = 'approved';
            data.decided_by = 'move-ticket';
            data.comment = `auto-approved on move to ${target}`;
            data.updated_at = new Date().toISOString();
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
          }
        } catch (err) {
          // corrupt file — skip, do not fail
        }
      }
    }
  } catch (err) {
    // hook error must not fail the move operation
  }
}

function calcP95(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, idx)];
}

test(`approval-hook: p95 latency ≤ ${P95_THRESHOLD_MS}ms over ${ITERATIONS} iterations`, () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-approval-hook-'));
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
    // Reset approval file to pending state (setup, outside timing window)
    fs.writeFileSync(approvalFile, pendingPayload, 'utf8');

    const start = performance.now();
    updateApprovalFilesHook(ticketId, target, workflowDir);
    const elapsed = performance.now() - start;

    latencies.push(elapsed);
  }

  const p95Latency = calcP95(latencies);
  const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const maxLatency = Math.max(...latencies);

  console.log(
    `approval-hook perf: avg=${avgLatency.toFixed(2)}ms  p95=${p95Latency.toFixed(2)}ms  max=${maxLatency.toFixed(2)}ms`
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });

  assert.ok(
    p95Latency <= P95_THRESHOLD_MS,
    `p95 ${p95Latency.toFixed(2)}ms exceeds threshold ${P95_THRESHOLD_MS}ms`
  );
});
