import { test } from 'node:test';
import assert from 'node:assert';
import { getLastReviewStatus } from '../lib/review-section.mjs';

test('getLastReviewStatus: legacy 3-column table (Дата | Статус | Самари)', () => {
  const content = `---
id: TEST-001
---

## Ревью

| Дата | Статус | Самари |
|------|--------|--------|
| 2026-05-01 | ✅ passed | OK |

Some other content`;

  const result = getLastReviewStatus(content);
  assert.strictEqual(result, 'passed');
});

test('getLastReviewStatus: 4-column table (Дата | Агент | Статус | Самари)', () => {
  const content = `---
id: TEST-002
---

## Ревью

| Дата | Агент | Статус | Самари |
|------|-------|--------|--------|
| 2026-05-01 | AI | ❌ failed | Error in validation |

Other content`;

  const result = getLastReviewStatus(content);
  assert.strictEqual(result, 'failed');
});

test('getLastReviewStatus: header with Status (English whitelist)', () => {
  const content = `---
id: TEST-003
---

## Ревью

| Date | Status | Summary |
|------|--------|---------|
| 2026-05-01 | ✅ passed | Test passed |

Content`;

  const result = getLastReviewStatus(content);
  assert.strictEqual(result, 'passed');
});

test('getLastReviewStatus: header with Вердикт (whitelist)', () => {
  const content = `---
id: TEST-004
---

## Ревью

| Дата | Вердикт | Заметка |
|------|---------|---------|
| 2026-05-01 | ⏭️ skipped | Not applicable |

Content`;

  const result = getLastReviewStatus(content);
  assert.strictEqual(result, 'skipped');
});

test('getLastReviewStatus: header with custom column (MyCustomCol) returns null', () => {
  const content = `---
id: TEST-005
---

## Ревью

| Дата | MyCustomCol | Заметка |
|------|-------------|---------|
| 2026-05-01 | Some value | Text |

Content`;

  const result = getLastReviewStatus(content);
  assert.strictEqual(result, null);
});

test('getLastReviewStatus: no ## Ревью section returns null', () => {
  const content = `---
id: TEST-006
---

## Something Else

| Col1 | Col2 |
|------|------|
| val1 | val2 |`;

  const result = getLastReviewStatus(content);
  assert.strictEqual(result, null);
});

test('getLastReviewStatus: multi-row table returns status from last non-empty row', () => {
  const content = `---
id: TEST-007
---

## Ревью

| Дата | Статус | Самари |
|------|--------|--------|
| 2026-05-01 | ✅ passed | First attempt |
| 2026-05-02 | ❌ failed | Regression found |
| 2026-05-03 | ✅ passed | Final verification |

Content`;

  const result = getLastReviewStatus(content);
  assert.strictEqual(result, 'passed', 'Should return status from last row, not first');
});

test('getLastReviewStatus: header Verdict (English) in whitelist', () => {
  const content = `---
id: TEST-008
---

## Ревью

| Date | Verdict | Summary |
|------|---------|---------|
| 2026-05-01 | ✅ passed | OK |

Content`;

  const result = getLastReviewStatus(content);
  assert.strictEqual(result, 'passed');
});

test('getLastReviewStatus: multiple Review sections uses last one', () => {
  const content = `---
id: TEST-009
---

## Ревью

| Дата | Статус | Самари |
|------|--------|--------|
| 2026-05-01 | ✅ passed | First review |

## Other Section

Some text

## Ревью

| Дата | Статус | Самари |
|------|--------|--------|
| 2026-05-02 | ❌ failed | Second review |

Content`;

  const result = getLastReviewStatus(content);
  assert.strictEqual(result, 'failed', 'Should use last ## Ревью section');
});

test('getLastReviewStatus: normalize пройден (Russian)', () => {
  const content = `---
id: TEST-010
---

## Ревью

| Дата | Статус | Самари |
|------|--------|--------|
| 2026-05-01 | ✅ пройден | Test |

Content`;

  const result = getLastReviewStatus(content);
  assert.strictEqual(result, 'passed');
});

test('getLastReviewStatus: normalize не пройден (Russian)', () => {
  const content = `---
id: TEST-011
---

## Ревью

| Дата | Статус | Самари |
|------|--------|--------|
| 2026-05-01 | ❌ не пройден | Test |

Content`;

  const result = getLastReviewStatus(content);
  assert.strictEqual(result, 'failed');
});

test('getLastReviewStatus: non-string input returns null', () => {
  const result = getLastReviewStatus(null);
  assert.strictEqual(result, null);
});
