/**
 * Performance benchmark: pick-next-task core logic with 100 tickets in ready/
 *
 * Tests the actual FS operations from pick-next-task.js in-process (real FS, no mock).
 * This approach isolates FS latency from Node.js process startup overhead, matching
 * the design of the approval-hook and mark-blocked benchmarks.
 *
 * Logic replicated from src/scripts/pick-next-task.js:
 *   readdirSync(ready/) → for each: readFileSync + parseFrontmatter →
 *   filter (conditions/deps) + sort by priority → pick first eligible
 *   (calculateReviewMetrics analog: second scan of ready/ for aggregate stats)
 *
 * Backlog mix: 70 impl (non-human) + 30 human, priorities cycling 1-5.
 * State is stable: pick-next-task does not move ready tickets.
 *
 * 100 tickets in ready/, 100 iterations. CI fails if p95 > 500ms.
 *
 * Run: node --test src/tests/perf-pick-next-task-large-backlog.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'url';
import { parseFrontmatter } from 'workflow-ai/lib/utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ITERATIONS = 100;
const TICKET_COUNT = 100;
const P95_THRESHOLD_MS = 500;

// Replicated from src/scripts/pick-next-task.js — readReadyTickets + pickNextTicket
function readTicketsFromDir(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md') && f !== '.gitkeep.md');
  const tickets = [];
  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(dir, file), 'utf8');
      const { frontmatter } = parseFrontmatter(content);
      tickets.push({ id: frontmatter.id || file.replace('.md', ''), frontmatter });
    } catch {
      // skip unreadable
    }
  }
  return tickets;
}

function pickNextTicket(readyDir) {
  const tickets = readTicketsFromDir(readyDir);

  const nonHuman = [];
  const human = [];

  for (const ticket of tickets) {
    if (ticket.frontmatter.type === 'human') {
      human.push(ticket);
    } else {
      nonHuman.push(ticket);
    }
  }

  if (nonHuman.length > 0) {
    nonHuman.sort((a, b) => {
      const pa = a.frontmatter.priority ?? 999;
      const pb = b.frontmatter.priority ?? 999;
      return pa !== pb ? pa - pb : new Date(a.frontmatter.created_at ?? 0) - new Date(b.frontmatter.created_at ?? 0);
    });
    return { status: 'found', ticket_id: nonHuman[0].id };
  }

  if (human.length > 0) {
    human.sort((a, b) => (a.frontmatter.priority ?? 999) - (b.frontmatter.priority ?? 999));
    return { status: 'human_ready', ticket_id: human[0].id, pending_count: human.length };
  }

  return { status: 'empty' };
}

// Simulates calculateReviewMetrics (second pass across all ticket dirs)
function calculateReviewMetrics(allDirs) {
  let total = 0;
  for (const dir of allDirs) {
    const tickets = readTicketsFromDir(dir);
    total += tickets.length;
  }
  return { tickets_with_reviews: total };
}

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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-pick-next-task-'));
  const ticketsDir = path.join(tmpDir, '.workflow', 'tickets');

  const subdirs = ['ready', 'done', 'in-progress', 'review', 'blocked', 'archive', 'backlog'];
  for (const dir of subdirs) {
    fs.mkdirSync(path.join(ticketsDir, dir), { recursive: true });
  }
  const allDirs = subdirs.map(d => path.join(ticketsDir, d));
  const readyDir = path.join(ticketsDir, 'ready');

  // 70 impl (non-human) + 30 human, priorities cycling 1-5
  for (let i = 0; i < TICKET_COUNT; i++) {
    const type = i < 70 ? 'impl' : 'human';
    const id = `BENCH-${String(i + 1).padStart(3, '0')}`;
    const priority = (i % 5) + 1;
    fs.writeFileSync(path.join(readyDir, `${id}.md`), ticketContent(id, type, priority));
  }

  const latencies = [];

  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();

    // Primary selection (O(N) reads + sort)
    const result = pickNextTicket(readyDir);

    // Secondary scan: simulate calculateReviewMetrics (reads all ticket dirs)
    calculateReviewMetrics(allDirs);

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
