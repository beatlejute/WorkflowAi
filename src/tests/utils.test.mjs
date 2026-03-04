import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseFrontmatter, serializeFrontmatter, printResult, getPackageRoot } from '../lib/utils.mjs';

// ============ parseFrontmatter tests ============

test('parseFrontmatter parses file with frontmatter', () => {
  const content = `---
title: Test Document
priority: 1
tags:
  - test
  - example
---

This is the body content.
`;

  const result = parseFrontmatter(content);

  assert.deepStrictEqual(result.frontmatter, {
    title: 'Test Document',
    priority: 1,
    tags: ['test', 'example']
  });
  assert.strictEqual(result.body.trim(), 'This is the body content.');
});

test('parseFrontmatter returns empty frontmatter for file without frontmatter', () => {
  const content = 'Just plain content without frontmatter.';

  const result = parseFrontmatter(content);

  assert.deepStrictEqual(result.frontmatter, {});
  assert.strictEqual(result.body, content);
});

test('parseFrontmatter handles empty file', () => {
  const content = '';

  const result = parseFrontmatter(content);

  assert.deepStrictEqual(result.frontmatter, {});
  assert.strictEqual(result.body, '');
});

test('parseFrontmatter throws on invalid YAML', () => {
  const content = `---
title: Test
  invalid: yaml: syntax
---

Body
`;

  assert.throws(
    () => parseFrontmatter(content),
    (err) => {
      assert.ok(err.message.includes('Failed to parse frontmatter'));
      return true;
    }
  );
});

test('parseFrontmatter handles nested frontmatter', () => {
  const content = `---
author:
  name: John Doe
  email: john@example.com
status: active
---

Content here.
`;

  const result = parseFrontmatter(content);

  assert.deepStrictEqual(result.frontmatter, {
    author: {
      name: 'John Doe',
      email: 'john@example.com'
    },
    status: 'active'
  });
  assert.strictEqual(result.body.trim(), 'Content here.');
});

// ============ serializeFrontmatter tests ============

test('serializeFrontmatter serializes simple object', () => {
  const frontmatter = {
    title: 'Test',
    priority: 1
  };

  const result = serializeFrontmatter(frontmatter);

  assert.ok(result.startsWith('---\n'));
  assert.ok(result.endsWith('---\n'));
  assert.ok(result.includes('title: Test'));
  assert.ok(result.includes('priority: 1'));
});

test('serializeFrontmatter serializes object with nesting', () => {
  const frontmatter = {
    author: {
      name: 'Jane Doe',
      email: 'jane@example.com'
    },
    status: 'draft'
  };

  const result = serializeFrontmatter(frontmatter);

  assert.ok(result.startsWith('---\n'));
  assert.ok(result.endsWith('---\n'));
  assert.ok(result.includes('author:'));
  assert.ok(result.includes('name: Jane Doe'));
  assert.ok(result.includes('email: jane@example.com'));
  assert.ok(result.includes('status: draft'));
});

test('serializeFrontmatter round-trip with parseFrontmatter', () => {
  const original = {
    title: 'Round Trip Test',
    priority: 2,
    tags: ['test', 'roundtrip'],
    metadata: {
      author: 'Test Author',
      created: '2026-03-03'
    }
  };

  const serialized = serializeFrontmatter(original);
  const parsed = parseFrontmatter(serialized + '\nBody content');

  assert.deepStrictEqual(parsed.frontmatter, original);
});

// ============ printResult tests ============

test('printResult outputs to stdout in correct format', () => {
  const result = {
    status: 'success',
    tasks: 5,
    completed: 3
  };

  // Capture console.log output
  const originalLog = console.log;
  const loggedLines = [];
  console.log = (...args) => {
    loggedLines.push(args.join(' '));
  };

  try {
    printResult(result);

    assert.strictEqual(loggedLines[0], '---RESULT---');
    assert.strictEqual(loggedLines[1], 'status: success');
    assert.strictEqual(loggedLines[2], 'tasks: 5');
    assert.strictEqual(loggedLines[3], 'completed: 3');
    assert.strictEqual(loggedLines[4], '---RESULT---');
  } finally {
    console.log = originalLog;
  }
});

test('printResult handles empty object', () => {
  const result = {};

  const originalLog = console.log;
  const loggedLines = [];
  console.log = (...args) => {
    loggedLines.push(args.join(' '));
  };

  try {
    printResult(result);

    assert.strictEqual(loggedLines[0], '---RESULT---');
    assert.strictEqual(loggedLines[1], '---RESULT---');
  } finally {
    console.log = originalLog;
  }
});

// ============ getPackageRoot tests ============

test('getPackageRoot returns path containing package.json', async () => {
  const { existsSync } = await import('node:fs');
  const { join } = await import('node:path');

  const root = getPackageRoot();

  assert.ok(typeof root === 'string');
  assert.ok(root.length > 0);
  assert.ok(existsSync(join(root, 'package.json')), 'package.json should exist in package root');
});

test('getPackageRoot returns absolute path', async () => {
  const { isAbsolute } = await import('node:path');

  const root = getPackageRoot();

  assert.ok(isAbsolute(root), 'getPackageRoot should return absolute path');
});
