import { test, describe, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { getGlobalDir, ensureGlobalDir, isGlobalDirStale, refreshGlobalDir } from '../global-dir.mjs';

describe('global-dir module', () => {
  const testPackageRoot = join(tmpdir(), 'global-dir-test-pkg');
  const testGlobalDir = join(tmpdir(), `global-dir-test-home-${Date.now()}`);
  let originalWorkflowHome;

  beforeEach(() => {
    originalWorkflowHome = process.env.WORKFLOW_HOME;
    process.env.WORKFLOW_HOME = testGlobalDir;

    rmSync(testPackageRoot, { recursive: true, force: true });
    rmSync(testGlobalDir, { recursive: true, force: true });

    mkdirSync(join(testPackageRoot, 'src', 'skills', 'test-skill'), { recursive: true });
    mkdirSync(join(testPackageRoot, 'src', 'scripts'), { recursive: true });
    writeFileSync(join(testPackageRoot, 'package.json'), JSON.stringify({ version: '1.0.0' }));
    writeFileSync(join(testPackageRoot, 'src', 'skills', 'test-skill', 'SKILL.md'), '# Test Skill');
    writeFileSync(join(testPackageRoot, 'src', 'scripts', 'test-script.js'), 'console.log("test");');
  });

  afterEach(() => {
    if (originalWorkflowHome === undefined) {
      delete process.env.WORKFLOW_HOME;
    } else {
      process.env.WORKFLOW_HOME = originalWorkflowHome;
    }
    rmSync(testPackageRoot, { recursive: true, force: true });
    rmSync(testGlobalDir, { recursive: true, force: true });
  });

  describe('getGlobalDir', () => {
    test('returns WORKFLOW_HOME when set', () => {
      const result = getGlobalDir();
      assert.strictEqual(result, testGlobalDir);
    });

    test('returns absolute path', () => {
      const result = getGlobalDir();
      assert.ok(result.startsWith('/') || result.match(/^[A-Z]:/i));
    });
  });

  describe('isGlobalDirStale', () => {
    test('returns true when global dir does not exist', () => {
      const result = isGlobalDirStale(testPackageRoot);
      assert.strictEqual(result, true);
    });

    test('returns true when version file does not exist', () => {
      mkdirSync(testGlobalDir, { recursive: true });
      const result = isGlobalDirStale(testPackageRoot);
      assert.strictEqual(result, true);
    });

    test('returns true when version in global dir is outdated', () => {
      mkdirSync(testGlobalDir, { recursive: true });
      writeFileSync(join(testGlobalDir, '.version'), '0.0.1');
      const result = isGlobalDirStale(testPackageRoot);
      assert.strictEqual(result, true);
    });

    test('returns false when version matches', () => {
      mkdirSync(testGlobalDir, { recursive: true });
      writeFileSync(join(testGlobalDir, '.version'), '1.0.0');
      const result = isGlobalDirStale(testPackageRoot);
      assert.strictEqual(result, false);
    });
  });

  describe('ensureGlobalDir', () => {
    test('creates global dir when it does not exist', () => {
      ensureGlobalDir(testPackageRoot);

      assert.strictEqual(existsSync(testGlobalDir), true);
      assert.strictEqual(existsSync(join(testGlobalDir, '.version')), true);
      assert.strictEqual(readFileSync(join(testGlobalDir, '.version'), 'utf-8'), '1.0.0');
    });

    test('copies skills and scripts when creating new global dir', () => {
      ensureGlobalDir(testPackageRoot);

      assert.strictEqual(existsSync(join(testGlobalDir, 'skills', 'test-skill', 'SKILL.md')), true);
      assert.strictEqual(existsSync(join(testGlobalDir, 'scripts', 'test-script.js')), true);
    });

    test('does not recreate when version matches', () => {
      mkdirSync(testGlobalDir, { recursive: true });
      writeFileSync(join(testGlobalDir, '.version'), '1.0.0');
      const initialContent = 'unchanged content';
      mkdirSync(join(testGlobalDir, 'skills', 'existing'), { recursive: true });
      writeFileSync(join(testGlobalDir, 'skills', 'existing', 'file.txt'), initialContent);

      ensureGlobalDir(testPackageRoot);

      assert.strictEqual(readFileSync(join(testGlobalDir, 'skills', 'existing', 'file.txt'), 'utf-8'), initialContent);
    });

    test('updates when version is stale', () => {
      mkdirSync(testGlobalDir, { recursive: true });
      writeFileSync(join(testGlobalDir, '.version'), '0.0.1');

      ensureGlobalDir(testPackageRoot);

      assert.strictEqual(readFileSync(join(testGlobalDir, '.version'), 'utf-8'), '1.0.0');
    });
  });

  describe('refreshGlobalDir', () => {
    test('forces update of global dir', () => {
      mkdirSync(testGlobalDir, { recursive: true });
      writeFileSync(join(testGlobalDir, '.version'), '1.0.0');

      refreshGlobalDir(testPackageRoot);

      assert.strictEqual(existsSync(join(testGlobalDir, 'skills', 'test-skill', 'SKILL.md')), true);
      assert.strictEqual(existsSync(join(testGlobalDir, 'scripts', 'test-script.js')), true);
    });

    test('overwrites existing files', () => {
      mkdirSync(join(testGlobalDir, 'skills', 'test-skill'), { recursive: true });
      writeFileSync(join(testGlobalDir, 'skills', 'test-skill', 'SKILL.md'), 'old content');

      refreshGlobalDir(testPackageRoot);

      assert.strictEqual(readFileSync(join(testGlobalDir, 'skills', 'test-skill', 'SKILL.md'), 'utf-8'), '# Test Skill');
    });
  });
});
