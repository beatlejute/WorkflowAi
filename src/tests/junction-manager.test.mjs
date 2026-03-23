import { test, describe, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { tmpdir, homedir } from 'node:os';
import { join, basename } from 'node:path';
import { existsSync, mkdirSync, rmSync, writeFileSync, readdirSync, lstatSync } from 'node:fs';
import {
  createJunction,
  removeJunction,
  isJunction,
  createHardlink,
  removeHardlink,
  createSkillJunctions,
  createScriptHardlinks,
  ejectSkill,
  listSkillsWithStatus
} from '../junction-manager.mjs';

describe('junction-manager module', () => {
  const testDir = join(tmpdir(), 'junction-manager-test-' + Date.now());
  let globalDir, projectDir;

  beforeEach(() => {
    globalDir = join(testDir, 'global');
    projectDir = join(testDir, 'project');
    mkdirSync(join(globalDir, 'skills', 'skill1'), { recursive: true });
    mkdirSync(join(globalDir, 'skills', 'skill2'), { recursive: true });
    mkdirSync(join(globalDir, 'scripts'), { recursive: true });
    writeFileSync(join(globalDir, 'skills', 'skill1', 'SKILL.md'), '# Skill 1');
    writeFileSync(join(globalDir, 'skills', 'skill2', 'SKILL.md'), '# Skill 2');
    writeFileSync(join(globalDir, 'scripts', 'script1.js'), 'console.log("script1");');
    writeFileSync(join(globalDir, 'scripts', 'script2.js'), 'console.log("script2");');
    mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('createJunction', () => {
    test('creates junction on Windows', { skip: process.platform !== 'win32' }, () => {
      const target = join(globalDir, 'skills', 'skill1');
      const link = join(projectDir, 'links', 'skill1');
      createJunction(target, link);
      assert.strictEqual(existsSync(link), true);
    });

    test('creates symlink on Unix', { skip: process.platform === 'win32' }, () => {
      const target = join(globalDir, 'skills', 'skill1');
      const link = join(projectDir, 'links', 'skill1');
      createJunction(target, link);
      assert.strictEqual(existsSync(link), true);
      assert.strictEqual(lstatSync(link).isSymbolicLink(), true);
    });

    test('throws when target does not exist', () => {
      assert.throws(() => {
        createJunction('/nonexistent/path', join(projectDir, 'link'));
      });
    });

    test('creates parent directories', () => {
      const target = join(globalDir, 'skills', 'skill1');
      const link = join(projectDir, 'deep', 'nested', 'link');
      createJunction(target, link);
      assert.strictEqual(existsSync(link), true);
    });
  });

  describe('removeJunction', () => {
    test('removes existing junction', () => {
      const target = join(globalDir, 'skills', 'skill1');
      const link = join(projectDir, 'link');
      createJunction(target, link);
      removeJunction(link);
      assert.strictEqual(existsSync(link), false);
    });

    test('does not throw when junction does not exist', () => {
      assert.doesNotThrow(() => {
        removeJunction(join(projectDir, 'nonexistent'));
      });
    });
  });

  describe('isJunction', () => {
    test('returns true for junction/symlink', () => {
      const target = join(globalDir, 'skills', 'skill1');
      const link = join(projectDir, 'link');
      createJunction(target, link);
      assert.strictEqual(isJunction(link), true);
    });

    test('returns false for regular directory', () => {
      const dir = join(projectDir, 'regular');
      mkdirSync(dir);
      assert.strictEqual(isJunction(dir), false);
    });

    test('returns false for non-existent path', () => {
      assert.strictEqual(isJunction(join(projectDir, 'nonexistent')), false);
    });
  });

  describe('createHardlink', () => {
    test('creates hardlink on Windows', { skip: process.platform !== 'win32' }, () => {
      const target = join(globalDir, 'scripts', 'script1.js');
      const link = join(projectDir, 'links', 'script1.js');
      createHardlink(target, link);
      assert.strictEqual(existsSync(link), true);
    });

    test('creates hardlink on Unix', { skip: process.platform === 'win32' }, () => {
      const target = join(globalDir, 'scripts', 'script1.js');
      const link = join(projectDir, 'links', 'script1.js');
      createHardlink(target, link);
      assert.strictEqual(existsSync(link), true);
    });

    test('throws when target does not exist', () => {
      assert.throws(() => {
        createHardlink('/nonexistent/file.js', join(projectDir, 'link.js'));
      });
    });

    test('creates parent directories', () => {
      const target = join(globalDir, 'scripts', 'script1.js');
      const link = join(projectDir, 'deep', 'nested', 'script.js');
      createHardlink(target, link);
      assert.strictEqual(existsSync(link), true);
    });
  });

  describe('removeHardlink', () => {
    test('removes existing hardlink', () => {
      const target = join(globalDir, 'scripts', 'script1.js');
      const link = join(projectDir, 'link.js');
      createHardlink(target, link);
      removeHardlink(link);
      assert.strictEqual(existsSync(link), false);
    });

    test('does not throw when hardlink does not exist', () => {
      assert.doesNotThrow(() => {
        removeHardlink(join(projectDir, 'nonexistent.js'));
      });
    });
  });

  describe('createSkillJunctions', () => {
    test('creates junctions for all skills', () => {
      const projectSkillsDir = join(projectDir, 'skills');
      createSkillJunctions(globalDir, projectSkillsDir);
      assert.strictEqual(existsSync(join(projectSkillsDir, 'skill1')), true);
      assert.strictEqual(existsSync(join(projectSkillsDir, 'skill2')), true);
    });

    test('creates skills directory if not exists', () => {
      createSkillJunctions(globalDir, join(projectDir, 'new-skills'));
      assert.strictEqual(existsSync(join(projectDir, 'new-skills', 'skill1')), true);
    });

    test('does nothing when global skills do not exist', () => {
      const emptyGlobalDir = join(testDir, 'empty-global');
      mkdirSync(emptyGlobalDir, { recursive: true });
      createSkillJunctions(emptyGlobalDir, join(projectDir, 'skills'));
      assert.strictEqual(existsSync(join(projectDir, 'skills')), false);
    });
  });

  describe('createScriptHardlinks', () => {
    test('creates hardlinks for all scripts', () => {
      const projectScriptsDir = join(projectDir, 'scripts');
      createScriptHardlinks(globalDir, projectScriptsDir);
      assert.strictEqual(existsSync(join(projectScriptsDir, 'script1.js')), true);
      assert.strictEqual(existsSync(join(projectScriptsDir, 'script2.js')), true);
    });

    test('creates scripts directory if not exists', () => {
      createScriptHardlinks(globalDir, join(projectDir, 'new-scripts'));
      assert.strictEqual(existsSync(join(projectDir, 'new-scripts', 'script1.js')), true);
    });

    test('does nothing when global scripts do not exist', () => {
      const emptyGlobalDir = join(testDir, 'empty-global');
      mkdirSync(emptyGlobalDir, { recursive: true });
      createScriptHardlinks(emptyGlobalDir, join(projectDir, 'scripts'));
      assert.strictEqual(existsSync(join(projectDir, 'scripts')), false);
    });
  });

  describe('ejectSkill', () => {
    test('replaces junction with real directory', () => {
      const projectSkillsDir = join(projectDir, 'skills');
      createSkillJunctions(globalDir, projectSkillsDir);
      ejectSkill('skill1', globalDir, projectSkillsDir);
      const skillPath = join(projectSkillsDir, 'skill1');
      assert.strictEqual(existsSync(skillPath), true);
      assert.strictEqual(isJunction(skillPath), false);
      assert.strictEqual(existsSync(join(skillPath, 'SKILL.md')), true);
    });

    test('throws when skill does not exist in global dir', () => {
      const projectSkillsDir = join(projectDir, 'skills');
      assert.throws(() => {
        ejectSkill('nonexistent-skill', globalDir, projectSkillsDir);
      });
    });
  });

  describe('listSkillsWithStatus', () => {
    test('returns shared for junction skills', () => {
      const projectSkillsDir = join(projectDir, 'skills');
      createSkillJunctions(globalDir, projectSkillsDir);
      const result = listSkillsWithStatus(globalDir, projectSkillsDir);
      const skill1 = result.find(s => s.name === 'skill1');
      assert.strictEqual(skill1.status, 'shared');
    });

    test('returns ejected for ejected skills', () => {
      const projectSkillsDir = join(projectDir, 'skills');
      createSkillJunctions(globalDir, projectSkillsDir);
      ejectSkill('skill1', globalDir, projectSkillsDir);
      const result = listSkillsWithStatus(globalDir, projectSkillsDir);
      const skill1 = result.find(s => s.name === 'skill1');
      assert.strictEqual(skill1.status, 'ejected');
    });

    test('returns project-only for project-only skills', () => {
      const projectSkillsDir = join(projectDir, 'skills');
      mkdirSync(join(projectSkillsDir, 'project-skill'), { recursive: true });
      writeFileSync(join(projectSkillsDir, 'project-skill', 'SKILL.md'), '# Project Skill');
      const result = listSkillsWithStatus(globalDir, projectSkillsDir);
      const projectSkill = result.find(s => s.name === 'project-skill');
      assert.strictEqual(projectSkill.status, 'project-only');
    });

    test('returns empty array when no skills exist', () => {
      const emptyGlobalDir = join(testDir, 'empty-global');
      mkdirSync(emptyGlobalDir, { recursive: true });
      const result = listSkillsWithStatus(emptyGlobalDir, join(projectDir, 'skills'));
      assert.strictEqual(result.length, 0);
    });
  });
});