import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { findProjectRoot } from '../lib/find-root.mjs';

test('findProjectRoot finds .workflow/ in current directory', () => {
  const testDir = join(tmpdir(), 'find-root-test-current');
  
  try {
    // Setup: create temp dir with .workflow/
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(join(testDir, '.workflow'), { recursive: true });
    
    const result = findProjectRoot(testDir);
    assert.strictEqual(result, resolve(testDir));
  } finally {
    // Cleanup
    rmSync(testDir, { recursive: true, force: true });
  }
});

test('findProjectRoot finds .workflow/ in parent directory (walks up)', () => {
  const testDir = join(tmpdir(), 'find-root-test-parent');
  const nestedDir = join(testDir, 'level1', 'level2', 'level3');
  
  try {
    // Setup: create temp dir with .workflow/ and nested subdirs
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(nestedDir, { recursive: true });
    mkdirSync(join(testDir, '.workflow'), { recursive: true });
    
    const result = findProjectRoot(nestedDir);
    assert.strictEqual(result, resolve(testDir));
  } finally {
    // Cleanup
    rmSync(testDir, { recursive: true, force: true });
  }
});

test('findProjectRoot throws error when .workflow/ is not found', () => {
  const testDir = join(tmpdir(), 'find-root-test-notfound');
  
  try {
    // Setup: create temp dir without .workflow/
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
    
    assert.throws(
      () => findProjectRoot(testDir),
      (err) => {
        assert.ok(err.message.includes('Could not find .workflow/ directory'));
        assert.ok(err.message.includes('Run "workflow init" first'));
        return true;
      }
    );
  } finally {
    // Cleanup
    rmSync(testDir, { recursive: true, force: true });
  }
});

test('findProjectRoot stops at filesystem root (no infinite loop)', () => {
  // This test verifies the function doesn't hang when searching from root
  // We use a path that will quickly reach the filesystem root
  const rootLikeDir = tmpdir(); // Start from temp dir, will walk up to root
  
  // The function should throw rather than loop infinitely
  assert.throws(
    () => findProjectRoot(rootLikeDir),
    (err) => {
      assert.ok(err.message.includes('Could not find .workflow/ directory'));
      return true;
    }
  );
});

test('findProjectRoot uses process.cwd() by default', () => {
  // This test verifies the function works with cwd
  // We just check it doesn't throw unexpectedly when .workflow exists
  const result = findProjectRoot();
  assert.ok(typeof result === 'string');
  assert.ok(result.length > 0);
});
