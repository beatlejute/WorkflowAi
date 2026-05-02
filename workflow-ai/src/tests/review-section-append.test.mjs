import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { appendReviewEntry } from '../lib/review-section.mjs';

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'test-review-section-'));
}

function cleanup(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('appendReviewEntry: no section — creates section with 4-column header', () => {
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
      date: '2026-05-02',
      status: 'passed',
      summary: 'Initial review',
      agent: 'claude-sonnet'
    };

    const result = appendReviewEntry(ticketPath, entry);
    assert.strictEqual(result.ok, true);

    const updated = fs.readFileSync(ticketPath, 'utf8');
    assert.match(updated, /## Ревью/);
    assert.match(updated, /\| Дата \| Статус \| Самари \| Агент \|/);
    assert.match(updated, /\| 2026-05-02 \| ✅ passed \| Initial review \| claude-sonnet \|/);
  } finally {
    cleanup(tempDir);
  }
});

test('appendReviewEntry: legacy 3-column table — appends row, legacy rows contain unknown in Agent', () => {
  const tempDir = createTempDir();
  try {
    const ticketPath = path.join(tempDir, 'ticket.md');
    const initialContent = `---
id: TEST-002
title: Test ticket
---

## Ревю

| Дата | Статус | Самари |
|------|--------|--------|
| 2026-05-01 | ✅ passed | First check |
| 2026-05-01 | ❌ failed | Second check |
`;
    fs.writeFileSync(ticketPath, initialContent, 'utf8');

    const entry = {
      date: '2026-05-02',
      status: 'passed',
      summary: 'Final check',
      agent: 'claude-opus'
    };

    const result = appendReviewEntry(ticketPath, entry);
    assert.strictEqual(result.ok, true);

    const updated = fs.readFileSync(ticketPath, 'utf8');
    // New row should have agent column filled
    assert.match(updated, /\| 2026-05-02 \| ✅ passed \| Final check \| claude-opus \|/);
    // Old rows remain unchanged (no migration in appendReviewEntry)
    assert.match(updated, /\| 2026-05-01 \| ✅ passed \| First check \|/);
    assert.match(updated, /\| 2026-05-01 \| ❌ failed \| Second check \|/);
  } finally {
    cleanup(tempDir);
  }
});

test('appendReviewEntry: 4-column table — appends row without migration', () => {
  const tempDir = createTempDir();
  try {
    const ticketPath = path.join(tempDir, 'ticket.md');
    const initialContent = `---
id: TEST-003
title: Test ticket
---

## Ревью

| Дата | Статус | Самари | Агент |
|------|--------|--------|-------|
| 2026-05-01 | ✅ passed | First check | claude-sonnet |
`;
    fs.writeFileSync(ticketPath, initialContent, 'utf8');

    const entry = {
      date: '2026-05-02',
      status: 'passed',
      summary: 'Second check',
      agent: 'claude-opus'
    };

    const result = appendReviewEntry(ticketPath, entry);
    assert.strictEqual(result.ok, true);

    const updated = fs.readFileSync(ticketPath, 'utf8');
    // Original row should remain unchanged
    assert.match(updated, /\| 2026-05-01 \| ✅ passed \| First check \| claude-sonnet \|/);
    // New row appended
    assert.match(updated, /\| 2026-05-02 \| ✅ passed \| Second check \| claude-opus \|/);
  } finally {
    cleanup(tempDir);
  }
});

test('appendReviewEntry: status passed → converts to ✅ passed', () => {
  const tempDir = createTempDir();
  try {
    const ticketPath = path.join(tempDir, 'ticket.md');
    const initialContent = `---
id: TEST-004
---

## Ревью

| Дата | Статус | Самари | Агент |
|------|--------|--------|-------|
| 2026-05-01 | ✅ passed | Test 1 | AI |
`;
    fs.writeFileSync(ticketPath, initialContent, 'utf8');

    const entry = {
      date: '2026-05-02',
      status: 'passed',
      summary: 'Test 2',
      agent: 'claude-sonnet'
    };

    const result = appendReviewEntry(ticketPath, entry);
    assert.strictEqual(result.ok, true);

    const updated = fs.readFileSync(ticketPath, 'utf8');
    assert.match(updated, /\| 2026-05-02 \| ✅ passed \| Test 2 \| claude-sonnet \|/);
  } finally {
    cleanup(tempDir);
  }
});

test('appendReviewEntry: status failed → converts to ❌ failed', () => {
  const tempDir = createTempDir();
  try {
    const ticketPath = path.join(tempDir, 'ticket.md');
    const initialContent = `---
id: TEST-005
---

## Ревью

| Дата | Статус | Самари | Агент |
|------|--------|--------|-------|
| 2026-05-01 | ✅ passed | Test 1 | AI |
`;
    fs.writeFileSync(ticketPath, initialContent, 'utf8');

    const entry = {
      date: '2026-05-02',
      status: 'failed',
      summary: 'Test 2 failed',
      agent: 'claude-opus'
    };

    const result = appendReviewEntry(ticketPath, entry);
    assert.strictEqual(result.ok, true);

    const updated = fs.readFileSync(ticketPath, 'utf8');
    assert.match(updated, /\| 2026-05-02 \| ❌ failed \| Test 2 failed \| claude-opus \|/);
  } finally {
    cleanup(tempDir);
  }
});

test('appendReviewEntry: status skipped → converts to ⏭️ skipped', () => {
  const tempDir = createTempDir();
  try {
    const ticketPath = path.join(tempDir, 'ticket.md');
    const initialContent = `---
id: TEST-006
---

## Ревью

| Дата | Статус | Самари | Агент |
|------|--------|--------|-------|
| 2026-05-01 | ✅ passed | Test 1 | AI |
`;
    fs.writeFileSync(ticketPath, initialContent, 'utf8');

    const entry = {
      date: '2026-05-02',
      status: 'skipped',
      summary: 'Test 2 skipped',
      agent: 'claude-sonnet'
    };

    const result = appendReviewEntry(ticketPath, entry);
    assert.strictEqual(result.ok, true);

    const updated = fs.readFileSync(ticketPath, 'utf8');
    assert.match(updated, /\| 2026-05-02 \| ⏭️ skipped \| Test 2 skipped \| claude-sonnet \|/);
  } finally {
    cleanup(tempDir);
  }
});

test('appendReviewEntry: frontmatter not changed after append', () => {
  const tempDir = createTempDir();
  try {
    const ticketPath = path.join(tempDir, 'ticket.md');
    const initialContent = `---
id: TEST-007
title: Original title
priority: 1
tags:
  - test
  - important
---

## Описание

Some content.

## Ревью

| Дата | Статус | Самари | Агент |
|------|--------|--------|-------|
| 2026-05-01 | ✅ passed | Check 1 | AI |
`;
    fs.writeFileSync(ticketPath, initialContent, 'utf8');

    const entry = {
      date: '2026-05-02',
      status: 'passed',
      summary: 'Check 2',
      agent: 'claude-sonnet'
    };

    const result = appendReviewEntry(ticketPath, entry);
    assert.strictEqual(result.ok, true);

    const updated = fs.readFileSync(ticketPath, 'utf8');
    assert.match(updated, /^---\nid: TEST-007\ntitle: Original title\npriority: 1\ntags:\n  - test\n  - important\n---/);
  } finally {
    cleanup(tempDir);
  }
});

test('appendReviewEntry: agent field missing → uses unknown', () => {
  const tempDir = createTempDir();
  try {
    const ticketPath = path.join(tempDir, 'ticket.md');
    const initialContent = `---
id: TEST-008
---

Body content.
`;
    fs.writeFileSync(ticketPath, initialContent, 'utf8');

    const entry = {
      date: '2026-05-02',
      status: 'passed',
      summary: 'No agent specified'
    };

    const result = appendReviewEntry(ticketPath, entry);
    assert.strictEqual(result.ok, true);

    const updated = fs.readFileSync(ticketPath, 'utf8');
    assert.match(updated, /\| 2026-05-02 \| ✅ passed \| No agent specified \| unknown \|/);
  } finally {
    cleanup(tempDir);
  }
});

test('appendReviewEntry: file not found — returns error', () => {
  const result = appendReviewEntry('/nonexistent/path/ticket.md', {
    date: '2026-05-02',
    status: 'passed',
    summary: 'Test'
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'FILE_NOT_FOUND');
});

test('appendReviewEntry: missing required fields — returns error', () => {
  const tempDir = createTempDir();
  try {
    const ticketPath = path.join(tempDir, 'ticket.md');
    fs.writeFileSync(ticketPath, 'test', 'utf8');

    // Missing date
    let result = appendReviewEntry(ticketPath, {
      status: 'passed',
      summary: 'Test'
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'INVALID_ENTRY');

    // Missing status
    result = appendReviewEntry(ticketPath, {
      date: '2026-05-02',
      summary: 'Test'
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'INVALID_ENTRY');

    // Missing summary
    result = appendReviewEntry(ticketPath, {
      date: '2026-05-02',
      status: 'passed'
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'INVALID_ENTRY');
  } finally {
    cleanup(tempDir);
  }
});
