import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { appendAgentRun, parseAgentHistory } from '../lib/agent-history.mjs';

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'test-agent-history-'));
}

function cleanup(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('appendAgentRun: no section — creates section with 4-column header', () => {
  const tempDir = createTempDir();
  try {
    const ticketPath = path.join(tempDir, 'ticket.md');
    const initialContent = `---
id: TEST-001
title: Test ticket
---

## Описание

Some description here.
`;
    fs.writeFileSync(ticketPath, initialContent, 'utf8');

    const entry = {
      timestamp: '2026-05-02 15:00:00',
      skill: 'execute-task',
      agent: 'claude-sonnet',
      status: 'ok'
    };

    const result = appendAgentRun(ticketPath, entry);
    assert.strictEqual(result.ok, true);

    const updated = fs.readFileSync(ticketPath, 'utf8');
    assert.match(updated, /## История работы/);
    assert.match(updated, /\| Дата\/время \| Скил \| Агент \| Статус \|/);
    assert.match(updated, /\| 2026-05-02 15:00:00 \| execute-task \| claude-sonnet \| ok \|/);
  } finally {
    cleanup(tempDir);
  }
});

test('appendAgentRun: legacy 3-column table — migrates to 4-column with unknown status', () => {
  const tempDir = createTempDir();
  try {
    const ticketPath = path.join(tempDir, 'ticket.md');
    const initialContent = `---
id: TEST-002
title: Test ticket
---

## Описание

Some description.

## История работы

| Дата/время | Скил | Агент |
|------------|------|-------|
| 2026-05-01 10:00:00 | coach | claude-opus |
| 2026-05-01 11:00:00 | execute-task | claude-sonnet |
`;
    fs.writeFileSync(ticketPath, initialContent, 'utf8');

    const entry = {
      timestamp: '2026-05-02 15:00:00',
      skill: 'review-result',
      agent: 'claude-opus',
      status: 'ok'
    };

    const result = appendAgentRun(ticketPath, entry);
    assert.strictEqual(result.ok, true);

    const updated = fs.readFileSync(ticketPath, 'utf8');
    // Header migrated to 4 columns
    assert.match(updated, /\| Дата\/время \| Скил \| Агент \| Статус \|/);
    // Old rows should have 'unknown' in status
    assert.match(updated, /\| 2026-05-01 10:00:00 \| coach \| claude-opus \| unknown \|/);
    assert.match(updated, /\| 2026-05-01 11:00:00 \| execute-task \| claude-sonnet \| unknown \|/);
    // New row appended with actual status
    assert.match(updated, /\| 2026-05-02 15:00:00 \| review-result \| claude-opus \| ok \|/);
  } finally {
    cleanup(tempDir);
  }
});

test('appendAgentRun: 4-column table — appends row without migration', () => {
  const tempDir = createTempDir();
  try {
    const ticketPath = path.join(tempDir, 'ticket.md');
    const initialContent = `---
id: TEST-003
title: Test ticket
---

## История работы

| Дата/время | Скил | Агент | Статус |
|------------|------|-------|--------|
| 2026-05-01 10:00:00 | coach | claude-opus | ok |
`;
    fs.writeFileSync(ticketPath, initialContent, 'utf8');

    const entry = {
      timestamp: '2026-05-02 15:00:00',
      skill: 'execute-task',
      agent: 'claude-sonnet',
      status: 'ok'
    };

    const result = appendAgentRun(ticketPath, entry);
    assert.strictEqual(result.ok, true);

    const updated = fs.readFileSync(ticketPath, 'utf8');
    // Original row should remain unchanged
    assert.match(updated, /\| 2026-05-01 10:00:00 \| coach \| claude-opus \| ok \|/);
    // New row appended
    assert.match(updated, /\| 2026-05-02 15:00:00 \| execute-task \| claude-sonnet \| ok \|/);
  } finally {
    cleanup(tempDir);
  }
});

test('appendAgentRun: multiple sequential appends — rows in correct order', () => {
  const tempDir = createTempDir();
  try {
    const ticketPath = path.join(tempDir, 'ticket.md');
    const initialContent = `---
id: TEST-004
title: Test ticket
---

## Описание

Content before history.
`;
    fs.writeFileSync(ticketPath, initialContent, 'utf8');

    // First append
    let result = appendAgentRun(ticketPath, {
      timestamp: '2026-05-01 10:00:00',
      skill: 'coach',
      agent: 'claude-opus',
      status: 'ok'
    });
    assert.strictEqual(result.ok, true);

    // Second append
    result = appendAgentRun(ticketPath, {
      timestamp: '2026-05-01 11:00:00',
      skill: 'execute-task',
      agent: 'claude-sonnet',
      status: 'error'
    });
    assert.strictEqual(result.ok, true);

    // Third append
    result = appendAgentRun(ticketPath, {
      timestamp: '2026-05-01 12:00:00',
      skill: 'review-result',
      agent: 'claude-opus',
      status: 'ok'
    });
    assert.strictEqual(result.ok, true);

    const updated = fs.readFileSync(ticketPath, 'utf8');
    const parsed = parseAgentHistory(updated);

    assert.strictEqual(parsed.length, 3);
    assert.strictEqual(parsed[0].timestamp, '2026-05-01 10:00:00');
    assert.strictEqual(parsed[1].timestamp, '2026-05-01 11:00:00');
    assert.strictEqual(parsed[2].timestamp, '2026-05-01 12:00:00');
    assert.strictEqual(parsed[2].skill, 'review-result');
    assert.strictEqual(parsed[2].agent, 'claude-opus');
    assert.strictEqual(parsed[2].status, 'ok');
  } finally {
    cleanup(tempDir);
  }
});

test('appendAgentRun: frontmatter not changed after append', () => {
  const tempDir = createTempDir();
  try {
    const ticketPath = path.join(tempDir, 'ticket.md');
    const initialContent = `---
id: TEST-005
title: Original title
priority: 1
tags:
  - test
  - important
---

Body content.
`;
    fs.writeFileSync(ticketPath, initialContent, 'utf8');

    const entry = {
      timestamp: '2026-05-02 15:00:00',
      skill: 'execute-task',
      agent: 'claude-sonnet',
      status: 'ok'
    };

    const result = appendAgentRun(ticketPath, entry);
    assert.strictEqual(result.ok, true);

    const updated = fs.readFileSync(ticketPath, 'utf8');
    assert.match(updated, /^---\nid: TEST-005\ntitle: Original title\npriority: 1\ntags:\n  - test\n  - important\n---/);
  } finally {
    cleanup(tempDir);
  }
});

test('appendAgentRun: body before section not changed', () => {
  const tempDir = createTempDir();
  try {
    const ticketPath = path.join(tempDir, 'ticket.md');
    const bodyContent = `---
id: TEST-006
---

## Описание

This is the description.

Some paragraph with details.

Another paragraph.
`;
    fs.writeFileSync(ticketPath, bodyContent, 'utf8');

    const entry = {
      timestamp: '2026-05-02 15:00:00',
      skill: 'execute-task',
      agent: 'claude-sonnet',
      status: 'ok'
    };

    const result = appendAgentRun(ticketPath, entry);
    assert.strictEqual(result.ok, true);

    const updated = fs.readFileSync(ticketPath, 'utf8');
    assert.match(updated, /## Описание\n\nThis is the description\.\n\nSome paragraph with details\.\n\nAnother paragraph\./);
  } finally {
    cleanup(tempDir);
  }
});

test('appendAgentRun: pipe in cell escaped as \\|', () => {
  const tempDir = createTempDir();
  try {
    const ticketPath = path.join(tempDir, 'ticket.md');
    const initialContent = `---
id: TEST-007
---

## Описание

Content.
`;
    fs.writeFileSync(ticketPath, initialContent, 'utf8');

    const entry = {
      timestamp: '2026-05-02 15:00:00',
      skill: 'coach | review',
      agent: 'claude-opus | claude-sonnet',
      status: 'ok | passed'
    };

    const result = appendAgentRun(ticketPath, entry);
    assert.strictEqual(result.ok, true);

    const updated = fs.readFileSync(ticketPath, 'utf8');
    // Check that pipes are escaped in the file
    assert.match(updated, /\| 2026-05-02 15:00:00 \| coach \\| review \| claude-opus \\| claude-sonnet \| ok \\| passed \|/);

    // Check that parseAgentHistory correctly unescapes and reads back
    const parsed = parseAgentHistory(updated);
    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0].skill, 'coach | review');
    assert.strictEqual(parsed[0].agent, 'claude-opus | claude-sonnet');
    assert.strictEqual(parsed[0].status, 'ok | passed');
  } finally {
    cleanup(tempDir);
  }
});

test('appendAgentRun: invalid input — missing ticketPath', () => {
  const entry = {
    timestamp: '2026-05-02 15:00:00',
    skill: 'execute-task',
    agent: 'claude-sonnet',
    status: 'ok'
  };

  const result = appendAgentRun(null, entry);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'INVALID_INPUT');
});

test('appendAgentRun: invalid entry — missing timestamp', () => {
  const tempDir = createTempDir();
  try {
    const ticketPath = path.join(tempDir, 'ticket.md');
    fs.writeFileSync(ticketPath, '---\nid: TEST\n---\n\nBody', 'utf8');

    const entry = {
      skill: 'execute-task',
      agent: 'claude-sonnet',
      status: 'ok'
    };

    const result = appendAgentRun(ticketPath, entry);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'INVALID_ENTRY');
  } finally {
    cleanup(tempDir);
  }
});

test('appendAgentRun: invalid entry — missing skill', () => {
  const tempDir = createTempDir();
  try {
    const ticketPath = path.join(tempDir, 'ticket.md');
    fs.writeFileSync(ticketPath, '---\nid: TEST\n---\n\nBody', 'utf8');

    const entry = {
      timestamp: '2026-05-02 15:00:00',
      agent: 'claude-sonnet',
      status: 'ok'
    };

    const result = appendAgentRun(ticketPath, entry);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'INVALID_ENTRY');
  } finally {
    cleanup(tempDir);
  }
});
