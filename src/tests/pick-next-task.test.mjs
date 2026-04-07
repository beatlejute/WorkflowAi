#!/usr/bin/env node

/**
 * Интеграционные тесты дедупликации в pick-next-task.js
 *
 * Тестируют логику обнаружения и архивации дубликатов:
 * - Если тикет найден в ready/ и в одной из других колонок (done/, in-progress/, review/, blocked/),
 *   он перемещается в archive/ и исключается из выборки.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'url';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const SCRIPT_PATH = path.join(PROJECT_ROOT, 'src', 'scripts', 'pick-next-task.js');

function createTicket(id, title = `Test ticket ${id}`, priority = 2, type = 'impl', planId = 'PLAN-TEST') {
  return `---
id: ${id}
title: ${title}
priority: ${priority}
type: ${type}
created_at: "2026-04-06T10:00:00Z"
updated_at: "2026-04-06T10:00:00Z"
parent_plan: plans/current/${planId}.md
conditions: []
dependencies: []
tags:
  - test
---

## Описание

Test ticket description for ${id}.

## Критерии готовности (Definition of Done)

- [ ] Test completed
`;
}

function createTempWorkflow(baseDir, tickets) {
  const workflowDir = path.join(baseDir, '.workflow');
  const ticketsDir = path.join(workflowDir, 'tickets');

  const dirs = ['ready', 'done', 'in-progress', 'review', 'blocked', 'archive', 'backlog'];
  for (const dir of dirs) {
    fs.mkdirSync(path.join(ticketsDir, dir), { recursive: true });
  }

  const plansDir = path.join(workflowDir, 'plans', 'current');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.writeFileSync(
    path.join(plansDir, 'PLAN-TEST.md'),
    `# Plan: PLAN-TEST

---
id: PLAN-TEST
title: Test Plan
status: active
created_at: "2026-04-06T10:00:00Z"
---

## Цель

Test plan for deduplication tests.
`
  );

  for (const [dir, ticketList] of Object.entries(tickets)) {
    for (const ticket of ticketList) {
      const ticketPath = path.join(ticketsDir, dir, `${ticket.id}.md`);
      fs.writeFileSync(ticketPath, ticket.content);
    }
  }
}

function runPickNextTask(workdir) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [SCRIPT_PATH], {
      cwd: workdir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });

    child.on('error', (err) => {
      reject(err);
    });

    setTimeout(() => reject(new Error('Timeout for ' + workdir)), 5000);
  });
}

function parseResult(stdout) {
  const marker = '---RESULT---';
  const startIdx = stdout.indexOf(marker);
  const endIdx = stdout.indexOf(marker, startIdx + marker.length);

  if (startIdx === -1 || endIdx === -1) {
    return null;
  }

  const resultBlock = stdout.substring(startIdx + marker.length, endIdx).trim();
  const lines = resultBlock.split('\n');
  const data = {};

  for (const line of lines) {
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (match) {
      data[match[1].trim()] = match[2].trim();
    }
  }

  return data;
}

describe('Deduplication — Duplicate in done/', () => {
  let tempDir = null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-next-task-'));
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should skip and archive duplicate in done/', async () => {
    const tickets = {
      ready: [
        { id: 'IMPL-001', content: createTicket('IMPL-001', 'Duplicate in ready', 2) }
      ],
      done: [
        { id: 'IMPL-001', content: createTicket('IMPL-001', 'Duplicate in done', 2) }
      ]
    };

    createTempWorkflow(tempDir, tickets);

    const result = await runPickNextTask(tempDir);
    const data = parseResult(result.stdout);

    assert.strictEqual(data?.status, 'empty', 'Should return empty when ticket is archived');
  });
});

describe('Deduplication — Duplicate in review/', () => {
  let tempDir = null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-next-task-'));
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should skip and archive duplicate in review/', async () => {
    const tickets = {
      ready: [
        { id: 'IMPL-002', content: createTicket('IMPL-002', 'Duplicate in ready', 2) }
      ],
      review: [
        { id: 'IMPL-002', content: createTicket('IMPL-002', 'Duplicate in review', 2) }
      ]
    };

    createTempWorkflow(tempDir, tickets);

    const result = await runPickNextTask(tempDir);
    const data = parseResult(result.stdout);

    assert.strictEqual(data?.status, 'empty', 'Should return empty when ticket is archived');
  });
});

describe('Deduplication — Duplicate in blocked/', () => {
  let tempDir = null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-next-task-'));
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should skip and archive duplicate in blocked/', async () => {
    const tickets = {
      ready: [
        { id: 'IMPL-003', content: createTicket('IMPL-003', 'Duplicate in ready', 2) }
      ],
      blocked: [
        { id: 'IMPL-003', content: createTicket('IMPL-003', 'Duplicate in blocked', 2) }
      ]
    };

    createTempWorkflow(tempDir, tickets);

    const result = await runPickNextTask(tempDir);
    const data = parseResult(result.stdout);

    assert.strictEqual(data?.status, 'empty', 'Should return empty when ticket is archived');
  });
});

describe('Deduplication — Duplicate in in-progress/', () => {
  let tempDir = null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-next-task-'));
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should skip and archive duplicate in in-progress/', async () => {
    const tickets = {
      ready: [
        { id: 'IMPL-004', content: createTicket('IMPL-004', 'Duplicate in ready', 2) }
      ],
      'in-progress': [
        { id: 'IMPL-004', content: createTicket('IMPL-004', 'Duplicate in in-progress', 2) }
      ]
    };

    createTempWorkflow(tempDir, tickets);

    const result = await runPickNextTask(tempDir);
    const data = parseResult(result.stdout);

    assert.strictEqual(data?.status, 'empty', 'Should return empty when ticket is archived');
  });
});

describe('Deduplication — No duplicate', () => {
  let tempDir = null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-next-task-'));
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should select ticket when no duplicate exists', async () => {
    const tickets = {
      ready: [
        { id: 'IMPL-005', content: createTicket('IMPL-005', 'Unique ticket', 2) }
      ]
    };

    createTempWorkflow(tempDir, tickets);

    const result = await runPickNextTask(tempDir);
    const data = parseResult(result.stdout);

    assert.strictEqual(data?.status, 'found', 'Should find ticket');
    assert.strictEqual(data?.ticket_id, 'IMPL-005', 'Should return correct ticket id');
  });
});

describe('Deduplication — Multiple tickets, one duplicate', () => {
  let tempDir = null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-next-task-'));
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should select second ticket when first is duplicate', async () => {
    const tickets = {
      ready: [
        { id: 'IMPL-006', content: createTicket('IMPL-006', 'First ticket', 1) },
        { id: 'IMPL-007', content: createTicket('IMPL-007', 'Second ticket', 2) }
      ],
      done: [
        { id: 'IMPL-006', content: createTicket('IMPL-006', 'First in done', 1) }
      ]
    };

    createTempWorkflow(tempDir, tickets);

    const result = await runPickNextTask(tempDir);
    const data = parseResult(result.stdout);

    assert.strictEqual(data?.status, 'found', 'Should find remaining ticket');
    assert.strictEqual(data?.ticket_id, 'IMPL-007', 'Should return second ticket after first is archived');
  });
});

console.log('Running pick-next-task deduplication tests...\n');