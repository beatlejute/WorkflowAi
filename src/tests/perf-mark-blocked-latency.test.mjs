/**
 * Performance benchmark: mark-blocked core logic
 *
 * Tests the actual FS operations from mark-blocked.js in-process (real FS, no mock).
 * This approach (direct function call vs spawnSync) isolates FS latency from
 * Node.js process startup overhead (~150-250ms on Windows), matching the design
 * of the approval-hook benchmark.
 *
 * 100 iterations on real tmpdir. CI fails if p95 > 200ms.
 *
 * Logic replicated from src/scripts/mark-blocked.js:
 *   findTicketFile → readFileSync → parseFrontmatter → update fields →
 *   serializeFrontmatter → writeFileSync → existsSync(stateDir) → appendFileSync
 *
 * Run: node --test src/tests/perf-mark-blocked-latency.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'url';
import { parseFrontmatter, serializeFrontmatter } from 'workflow-ai/lib/utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ITERATIONS = 100;
const P95_THRESHOLD_MS = 200;

// Replicated from src/scripts/mark-blocked.js
function findTicketFile(ticketId, searchDir) {
  const files = fs.readdirSync(searchDir, { withFileTypes: true });
  for (const file of files) {
    const fullPath = path.join(searchDir, file.name);
    if (file.isDirectory()) {
      const found = findTicketFile(ticketId, fullPath);
      if (found) return found;
    } else if (file.isFile() && file.name.endsWith('.md') && file.name.startsWith(ticketId)) {
      return fullPath;
    }
  }
  return null;
}

// Core mark-blocked operation on real FS (identical to script logic, minus CLI parsing)
function markBlocked(ticketId, attempts, reason, ticketsDir, alertsFile) {
  const ticketFile = findTicketFile(ticketId, ticketsDir);
  if (!ticketFile) throw new Error(`Ticket ${ticketId} not found`);

  const content = fs.readFileSync(ticketFile, 'utf8');
  const { frontmatter, body } = parseFrontmatter(content);

  const now = new Date().toISOString();
  frontmatter.auto_blocked_reason = reason;
  frontmatter.auto_blocked_attempts = attempts;
  frontmatter.auto_blocked_at = now;

  fs.writeFileSync(ticketFile, serializeFrontmatter(frontmatter) + body, 'utf8');

  const alertEntry = JSON.stringify({
    timestamp: now,
    severity: 'warning',
    kind: 'ticket_auto_blocked',
    ticket_id: ticketId,
    attempts,
    reason,
    stage: 'review-result',
  }) + '\n';
  fs.appendFileSync(alertsFile, alertEntry, 'utf8');
}

function calcP95(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, idx)];
}

test(`mark-blocked: p95 latency ≤ ${P95_THRESHOLD_MS}ms over ${ITERATIONS} iterations`, () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-mark-blocked-'));
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
    markBlocked(ticketId, i + 1, `benchmark_run_${i}`, ticketsDir, alertsFile);
    const elapsed = performance.now() - start;
    latencies.push(elapsed);
  }

  const p95Latency = calcP95(latencies);
  const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const maxLatency = Math.max(...latencies);

  console.log(
    `mark-blocked perf: avg=${avgLatency.toFixed(2)}ms  p95=${p95Latency.toFixed(2)}ms  max=${maxLatency.toFixed(2)}ms`
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });

  assert.ok(
    p95Latency <= P95_THRESHOLD_MS,
    `p95 ${p95Latency.toFixed(2)}ms exceeds threshold ${P95_THRESHOLD_MS}ms`
  );
});
