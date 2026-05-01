#!/usr/bin/env node

/**
 * Race condition test: multiple human tickets
 *
 * Сценарий: pipeline содержит два созревших human-тикета в ready/.
 * Runner встаёт на manual-gate для первого.
 * После approve первого → pick-next-task вызывается снова.
 * Runner должен увидеть второй human-тикет и не потерять его.
 *
 * Реализация: мокируем структуру .workflow/tickets/, pick-next-task логику,
 * и проверяем что оба тикета обработаны.
 */

import test from "node:test";
import assert from "node:assert";
import path from "path";

// Helper to create mock ticket content
function createTicket({
  id = 'TEST-001',
  title = 'Test Ticket',
  priority = 2,
  type = 'impl',
  planId = 'PLAN-TEST',
  conditions = [],
  dependencies = []
} = {}) {
  let conditionsYaml;
  if (conditions.length === 0) {
    conditionsYaml = '[]';
  } else {
    conditionsYaml = '\n' + conditions.map(c => `  - type: ${c.type}\n    value: ${JSON.stringify(c.value)}`).join('\n');
  }

  let dependenciesYaml;
  if (dependencies.length === 0) {
    dependenciesYaml = '[]';
  } else {
    dependenciesYaml = '\n' + dependencies.map(d => `  - ${d}`).join('\n');
  }

  return `---
id: ${id}
title: ${title}
priority: ${priority}
type: ${type}
created_at: "2026-04-30T10:00:00Z"
updated_at: "2026-04-30T10:00:00Z"
parent_plan: plans/current/${planId}.md
conditions: ${conditionsYaml}
dependencies: ${dependenciesYaml}
tags:
  - test
---

## Описание

Test ticket: ${id}

## Критерии готовности (Definition of Done)

- [ ] Test completed
`;
}

// Mock fs module for ticket operations
class MockTicketFs {
  constructor() {
    this.files = new Map(); // filePath -> content
    this.directories = new Set(); // dirPath
  }

  existsSync(path) {
    if (this.directories.has(path)) return true;
    return this.files.has(path);
  }

  readdirSync(dirPath) {
    // Return files in this directory
    const files = [];
    for (const [filePath, _] of this.files) {
      const dir = filePath.substring(0, filePath.lastIndexOf('/'));
      if (dir === dirPath) {
        const filename = filePath.substring(filePath.lastIndexOf('/') + 1);
        files.push(filename);
      }
    }
    return files;
  }

  readFileSync(filePath, encoding) {
    if (!this.files.has(filePath)) {
      throw new Error(`ENOENT: no such file or directory, open '${filePath}'`);
    }
    return this.files.get(filePath);
  }

  writeFileSync(filePath, content, encoding) {
    const dir = filePath.substring(0, filePath.lastIndexOf('/'));
    if (!this.directories.has(dir)) {
      this.directories.add(dir);
    }
    this.files.set(filePath, content);
  }

  // Helpers
  setDirectory(dirPath) {
    this.directories.add(dirPath);
  }

  setFile(filePath, content) {
    const dir = filePath.substring(0, filePath.lastIndexOf('/'));
    if (!this.directories.has(dir)) {
      this.directories.add(dir);
    }
    this.files.set(filePath, content);
  }

  moveFile(fromPath, toPath) {
    if (!this.files.has(fromPath)) {
      throw new Error(`ENOENT: no such file, rename '${fromPath}'`);
    }
    const content = this.files.get(fromPath);
    this.files.delete(fromPath);
    this.setFile(toPath, content);
  }

  getFile(filePath) {
    return this.files.get(filePath);
  }
}

// Simplified pick-next-task logic (from src/scripts/pick-next-task.js)
function pickNextTask(ticketsDir, fsModule) {
  const readyDir = `${ticketsDir}/ready`;

  // Check if ready/ exists and has files
  if (!fsModule.existsSync(readyDir)) {
    return { status: 'empty' };
  }

  const files = fsModule.readdirSync(readyDir);

  // Separate human and non-human tickets
  const humanTickets = [];
  const nonHumanTickets = [];

  for (const file of files) {
    if (!file.endsWith('.md')) continue;

    const filePath = `${readyDir}/${file}`;
    try {
      const content = fsModule.readFileSync(filePath, 'utf8');

      // Parse frontmatter to get type
      const match = content.match(/^---\n([\s\S]*?)\n---/);
      if (match) {
        const frontmatter = match[1];
        const typeMatch = frontmatter.match(/^type: (\w+)/m);
        const idMatch = frontmatter.match(/^id: ([\w-]+)/m);
        const priorityMatch = frontmatter.match(/^priority: (\d+)/m);
        const titleMatch = frontmatter.match(/^title: (.+)/m);

        if (typeMatch && idMatch) {
          const ticket = {
            id: idMatch[1],
            type: typeMatch[1],
            priority: priorityMatch ? parseInt(priorityMatch[1]) : 999,
            title: titleMatch ? titleMatch[1] : 'Untitled'
          };

          if (ticket.type === 'human') {
            humanTickets.push(ticket);
          } else {
            nonHumanTickets.push(ticket);
          }
        }
      }
    } catch (err) {
      // Skip invalid files
    }
  }

  // First pass: return non-human if exists
  if (nonHumanTickets.length > 0) {
    // Sort by priority
    nonHumanTickets.sort((a, b) => a.priority - b.priority);
    const ticket = nonHumanTickets[0];
    return {
      status: 'found',
      ticket_id: ticket.id,
      type: ticket.type,
      priority: ticket.priority,
      title: ticket.title
    };
  }

  // Second pass: return human if exists
  if (humanTickets.length > 0) {
    // Sort by priority
    humanTickets.sort((a, b) => a.priority - b.priority);
    const ticket = humanTickets[0];
    return {
      status: 'human_ready',
      ticket_id: ticket.id,
      priority: ticket.priority,
      title: ticket.title,
      pending_count: humanTickets.length
    };
  }

  return { status: 'empty' };
}

// ============================================================================
// Test 1: Two human tickets in ready — first one picked
// ============================================================================

test('Scenario 1: Two human tickets exist, first picked by priority', () => {
  const mockFs = new MockTicketFs();
  const workflowDir = '.workflow';
  const ticketsDir = `${workflowDir}/tickets`;

  // Setup: create ready/ directory with two human tickets
  mockFs.setDirectory(`${ticketsDir}/ready`);

  const human1 = createTicket({
    id: 'HUMAN-001',
    title: 'First Human Task',
    type: 'human',
    priority: 2
  });
  const human2 = createTicket({
    id: 'HUMAN-002',
    title: 'Second Human Task',
    type: 'human',
    priority: 3
  });

  mockFs.setFile(`${ticketsDir}/ready/HUMAN-001.md`, human1);
  mockFs.setFile(`${ticketsDir}/ready/HUMAN-002.md`, human2);

  // First pick-next-task call
  const result1 = pickNextTask(ticketsDir, mockFs);

  assert.equal(result1.status, 'human_ready', 'Should return human_ready');
  assert.equal(result1.ticket_id, 'HUMAN-001', 'Should pick first ticket (lower priority = higher importance)');
  assert.equal(result1.pending_count, 2, 'Should report two pending human tickets');
});

// ============================================================================
// Test 2: After first ticket moves to in-progress, second is still available
// ============================================================================

test('Scenario 2: First human ticket moved to in-progress, second still in ready', () => {
  const mockFs = new MockTicketFs();
  const workflowDir = '.workflow';
  const ticketsDir = `${workflowDir}/tickets`;

  // Setup: ready/ with two human tickets
  mockFs.setDirectory(`${ticketsDir}/ready`);
  mockFs.setDirectory(`${ticketsDir}/in-progress`);

  const human1 = createTicket({
    id: 'HUMAN-001',
    title: 'First Human Task',
    type: 'human',
    priority: 2
  });
  const human2 = createTicket({
    id: 'HUMAN-002',
    title: 'Second Human Task',
    type: 'human',
    priority: 3
  });

  mockFs.setFile(`${ticketsDir}/ready/HUMAN-001.md`, human1);
  mockFs.setFile(`${ticketsDir}/ready/HUMAN-002.md`, human2);

  // First pick: HUMAN-001
  const result1 = pickNextTask(ticketsDir, mockFs);
  assert.equal(result1.ticket_id, 'HUMAN-001');

  // Simulate moving HUMAN-001 to in-progress
  mockFs.moveFile(`${ticketsDir}/ready/HUMAN-001.md`, `${ticketsDir}/in-progress/HUMAN-001.md`);

  // Second pick: should now pick HUMAN-002
  const result2 = pickNextTask(ticketsDir, mockFs);

  assert.equal(result2.status, 'human_ready', 'Should still return human_ready');
  assert.equal(result2.ticket_id, 'HUMAN-002', 'Should pick second ticket');
  assert.equal(result2.pending_count, 1, 'Should report one pending human ticket');
});

// ============================================================================
// Test 3: Sequential processing of human tickets through pipeline
// ============================================================================

test('Scenario 3: Sequential approval of two human tickets', () => {
  const mockFs = new MockTicketFs();
  const workflowDir = '.workflow';
  const ticketsDir = `${workflowDir}/tickets`;
  const approvalDir = `${workflowDir}/approvals`;

  // Setup directories
  ['ready', 'in-progress', 'done'].forEach(d => {
    mockFs.setDirectory(`${ticketsDir}/${d}`);
  });
  mockFs.setDirectory(approvalDir);

  // Create two human tickets
  const human1 = createTicket({
    id: 'HUMAN-010',
    title: 'First Human Gate',
    type: 'human',
    priority: 1
  });
  const human2 = createTicket({
    id: 'HUMAN-011',
    title: 'Second Human Gate',
    type: 'human',
    priority: 2
  });

  mockFs.setFile(`${ticketsDir}/ready/HUMAN-010.md`, human1);
  mockFs.setFile(`${ticketsDir}/ready/HUMAN-011.md`, human2);

  // ========== Iteration 1: Pick and gate first ticket ==========
  const iter1 = pickNextTask(ticketsDir, mockFs);
  assert.equal(iter1.ticket_id, 'HUMAN-010', 'Iteration 1: should pick HUMAN-010');
  assert.equal(iter1.pending_count, 2, 'Iteration 1: should see 2 pending');

  // Move HUMAN-010 to in-progress (simulating pipeline execution)
  mockFs.moveFile(`${ticketsDir}/ready/HUMAN-010.md`, `${ticketsDir}/in-progress/HUMAN-010.md`);

  // Create approval gate for HUMAN-010
  const approval1 = {
    status: 'pending',
    ticket_id: 'HUMAN-010',
    created_at: new Date().toISOString()
  };
  mockFs.setFile(`${approvalDir}/HUMAN-010_manual-gate_001.json`, JSON.stringify(approval1, null, 2));

  // ========== Iteration 2: Approve first ticket, pick second ==========
  // Simulate approval
  const approvalContent1 = JSON.parse(mockFs.getFile(`${approvalDir}/HUMAN-010_manual-gate_001.json`));
  approvalContent1.status = 'approved';
  approvalContent1.decided_by = 'manual';
  mockFs.writeFileSync(`${approvalDir}/HUMAN-010_manual-gate_001.json`, JSON.stringify(approvalContent1, null, 2), 'utf8');

  // Move HUMAN-010 to done (after approval)
  mockFs.moveFile(`${ticketsDir}/in-progress/HUMAN-010.md`, `${ticketsDir}/done/HUMAN-010.md`);

  // Now pick again — should get HUMAN-011
  const iter2 = pickNextTask(ticketsDir, mockFs);
  assert.equal(iter2.ticket_id, 'HUMAN-011', 'Iteration 2: should pick HUMAN-011');
  assert.equal(iter2.pending_count, 1, 'Iteration 2: should see 1 pending');

  // ========== Iteration 3: Process second ticket ==========
  mockFs.moveFile(`${ticketsDir}/ready/HUMAN-011.md`, `${ticketsDir}/in-progress/HUMAN-011.md`);

  const approval2 = {
    status: 'pending',
    ticket_id: 'HUMAN-011',
    created_at: new Date().toISOString()
  };
  mockFs.setFile(`${approvalDir}/HUMAN-011_manual-gate_001.json`, JSON.stringify(approval2, null, 2));

  // Approve HUMAN-011
  const approvalContent2 = JSON.parse(mockFs.getFile(`${approvalDir}/HUMAN-011_manual-gate_001.json`));
  approvalContent2.status = 'approved';
  approvalContent2.decided_by = 'manual';
  mockFs.writeFileSync(`${approvalDir}/HUMAN-011_manual-gate_001.json`, JSON.stringify(approvalContent2, null, 2), 'utf8');

  // Move to done
  mockFs.moveFile(`${ticketsDir}/in-progress/HUMAN-011.md`, `${ticketsDir}/done/HUMAN-011.md`);

  // ========== Iteration 4: No more tickets ==========
  const iter3 = pickNextTask(ticketsDir, mockFs);
  assert.equal(iter3.status, 'empty', 'Iteration 3: should be empty (all done)');

  // Verify both tickets are in done/
  assert(mockFs.existsSync(`${ticketsDir}/done/HUMAN-010.md`), 'HUMAN-010 should be in done/');
  assert(mockFs.existsSync(`${ticketsDir}/done/HUMAN-011.md`), 'HUMAN-011 should be in done/');
});

// ============================================================================
// Test 4: Three human tickets with different priorities
// ============================================================================

test('Scenario 4: Multiple human tickets processed by priority order', () => {
  const mockFs = new MockTicketFs();
  const workflowDir = '.workflow';
  const ticketsDir = `${workflowDir}/tickets`;

  mockFs.setDirectory(`${ticketsDir}/ready`);

  // Create three human tickets with different priorities
  mockFs.setFile(`${ticketsDir}/ready/HUMAN-020.md`, createTicket({
    id: 'HUMAN-020',
    type: 'human',
    priority: 3  // Lowest priority (highest urgency = lowest number)
  }));
  mockFs.setFile(`${ticketsDir}/ready/HUMAN-021.md`, createTicket({
    id: 'HUMAN-021',
    type: 'human',
    priority: 1  // Highest priority (highest urgency)
  }));
  mockFs.setFile(`${ticketsDir}/ready/HUMAN-022.md`, createTicket({
    id: 'HUMAN-022',
    type: 'human',
    priority: 2
  }));

  // Should pick HUMAN-021 (priority 1)
  const result = pickNextTask(ticketsDir, mockFs);
  assert.equal(result.ticket_id, 'HUMAN-021', 'Should pick highest priority (lowest number)');
  assert.equal(result.pending_count, 3, 'Should report all 3 pending');
});

// ============================================================================
// Test 5: Human tickets don't interfere with non-human priority
// ============================================================================

test('Scenario 5: Non-human ticket takes priority over human', () => {
  const mockFs = new MockTicketFs();
  const workflowDir = '.workflow';
  const ticketsDir = `${workflowDir}/tickets`;

  mockFs.setDirectory(`${ticketsDir}/ready`);

  // Create mixed tickets
  mockFs.setFile(`${ticketsDir}/ready/IMPL-100.md`, createTicket({
    id: 'IMPL-100',
    type: 'impl',
    priority: 2
  }));
  mockFs.setFile(`${ticketsDir}/ready/HUMAN-030.md`, createTicket({
    id: 'HUMAN-030',
    type: 'human',
    priority: 1  // Higher priority than impl
  }));

  // Should pick IMPL-100 (non-human takes precedence)
  const result = pickNextTask(ticketsDir, mockFs);
  assert.equal(result.status, 'found', 'Should return found (non-human)');
  assert.equal(result.ticket_id, 'IMPL-100', 'Should pick non-human ticket');
  assert.equal(result.type, 'impl');
});

// ============================================================================
// Test 6: No lost tickets — verify counts remain accurate
// ============================================================================

test('Scenario 6: Ticket counts remain accurate (no lost tickets)', () => {
  const mockFs = new MockTicketFs();
  const workflowDir = '.workflow';
  const ticketsDir = `${workflowDir}/tickets`;

  mockFs.setDirectory(`${ticketsDir}/ready`);
  mockFs.setDirectory(`${ticketsDir}/in-progress`);

  // Create 5 human tickets
  for (let i = 1; i <= 5; i++) {
    mockFs.setFile(`${ticketsDir}/ready/HUMAN-${100 + i}.md`, createTicket({
      id: `HUMAN-${100 + i}`,
      type: 'human',
      priority: i
    }));
  }

  let processed = [];

  // Process tickets one by one
  for (let i = 0; i < 5; i++) {
    const result = pickNextTask(ticketsDir, mockFs);
    assert.equal(result.status, 'human_ready', `Pick ${i + 1}: should be human_ready`);
    assert.equal(result.pending_count, 5 - i, `Pick ${i + 1}: pending count should be ${5 - i}`);

    processed.push(result.ticket_id);

    // Move to in-progress
    mockFs.moveFile(
      `${ticketsDir}/ready/${result.ticket_id}.md`,
      `${ticketsDir}/in-progress/${result.ticket_id}.md`
    );
  }

  // Verify all 5 tickets were processed
  assert.equal(processed.length, 5, 'Should process exactly 5 tickets');
  assert.deepEqual(
    processed.sort(),
    ['HUMAN-101', 'HUMAN-102', 'HUMAN-103', 'HUMAN-104', 'HUMAN-105'].sort(),
    'Should process all tickets without loss'
  );

  // Final pick should be empty
  const final = pickNextTask(ticketsDir, mockFs);
  assert.equal(final.status, 'empty', 'Should be empty after processing all');
});

console.log('Running multiple human tickets race condition tests...\n');
