import { test, describe, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { tmpdir, homedir } from 'node:os';
import { join, basename } from 'node:path';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import {
  createJunction,
  removeJunction,
  isJunction,
  createHardlink,
  removeHardlink,
  createSkillJunctions,
  createScriptJunction,
  createConfigJunction,
  ejectScripts,
  ejectConfigs,
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
    mkdirSync(join(globalDir, 'configs'), { recursive: true });
    writeFileSync(join(globalDir, 'configs', 'config.yaml'), 'version: "1.0"');
    writeFileSync(join(globalDir, 'configs', 'pipeline.yaml'), 'steps: []');
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

    test('preserves ejected skills and does not overwrite them', () => {
      const projectSkillsDir = join(projectDir, 'skills');
      createSkillJunctions(globalDir, projectSkillsDir);
      ejectSkill('skill1', globalDir, projectSkillsDir);
      const customContent = '# Custom Skill 1';
      writeFileSync(join(projectSkillsDir, 'skill1', 'SKILL.md'), customContent);

      createSkillJunctions(globalDir, projectSkillsDir);

      assert.strictEqual(isJunction(join(projectSkillsDir, 'skill1')), false);
      const content = readFileSync(join(projectSkillsDir, 'skill1', 'SKILL.md'), 'utf-8');
      assert.strictEqual(content, customContent);
      assert.strictEqual(isJunction(join(projectSkillsDir, 'skill2')), true);
    });
  });

  describe('createScriptJunction', () => {
    test('creates junction for scripts directory', () => {
      const projectScriptsDir = join(projectDir, 'scripts');
      createScriptJunction(globalDir, projectScriptsDir);
      assert.strictEqual(existsSync(projectScriptsDir), true);
      assert.strictEqual(isJunction(projectScriptsDir), true);
      assert.strictEqual(existsSync(join(projectScriptsDir, 'script1.js')), true);
      assert.strictEqual(existsSync(join(projectScriptsDir, 'script2.js')), true);
    });

    test('does nothing when global scripts do not exist', () => {
      const emptyGlobalDir = join(testDir, 'empty-global');
      mkdirSync(emptyGlobalDir, { recursive: true });
      createScriptJunction(emptyGlobalDir, join(projectDir, 'scripts'));
      assert.strictEqual(existsSync(join(projectDir, 'scripts')), false);
    });

    test('preserves ejected scripts and does not overwrite them', () => {
      const projectScriptsDir = join(projectDir, 'scripts');
      createScriptJunction(globalDir, projectScriptsDir);
      ejectScripts(globalDir, projectScriptsDir);
      const customContent = 'console.log("custom");';
      writeFileSync(join(projectScriptsDir, 'script1.js'), customContent);

      createScriptJunction(globalDir, projectScriptsDir);

      assert.strictEqual(isJunction(projectScriptsDir), false);
      const content = readFileSync(join(projectScriptsDir, 'script1.js'), 'utf-8');
      assert.strictEqual(content, customContent);
    });
  });

  describe('ejectScripts', () => {
    test('replaces junction with real directory', () => {
      const projectScriptsDir = join(projectDir, 'scripts');
      createScriptJunction(globalDir, projectScriptsDir);
      ejectScripts(globalDir, projectScriptsDir);
      assert.strictEqual(existsSync(projectScriptsDir), true);
      assert.strictEqual(isJunction(projectScriptsDir), false);
      assert.strictEqual(existsSync(join(projectScriptsDir, 'script1.js')), true);
      assert.strictEqual(existsSync(join(projectScriptsDir, 'script2.js')), true);
    });

    test('throws when global scripts do not exist', () => {
      const emptyGlobalDir = join(testDir, 'empty-global');
      mkdirSync(emptyGlobalDir, { recursive: true });
      assert.throws(() => {
        ejectScripts(emptyGlobalDir, join(projectDir, 'scripts'));
      });
    });
  });

  describe('createConfigJunction', () => {
    test('creates junction for config directory', () => {
      const projectConfigDir = join(projectDir, 'config');
      createConfigJunction(globalDir, projectConfigDir);
      assert.strictEqual(existsSync(projectConfigDir), true);
      assert.strictEqual(isJunction(projectConfigDir), true);
      assert.strictEqual(existsSync(join(projectConfigDir, 'config.yaml')), true);
      assert.strictEqual(existsSync(join(projectConfigDir, 'pipeline.yaml')), true);
    });

    test('does nothing when global configs do not exist', () => {
      const emptyGlobalDir = join(testDir, 'empty-global');
      mkdirSync(emptyGlobalDir, { recursive: true });
      createConfigJunction(emptyGlobalDir, join(projectDir, 'config'));
      assert.strictEqual(existsSync(join(projectDir, 'config')), false);
    });

    test('preserves ejected configs and does not overwrite them', () => {
      const projectConfigDir = join(projectDir, 'config');
      createConfigJunction(globalDir, projectConfigDir);
      ejectConfigs(globalDir, projectConfigDir);
      const customContent = 'version: "2.0"';
      writeFileSync(join(projectConfigDir, 'config.yaml'), customContent);

      createConfigJunction(globalDir, projectConfigDir);

      assert.strictEqual(isJunction(projectConfigDir), false);
      const content = readFileSync(join(projectConfigDir, 'config.yaml'), 'utf-8');
      assert.strictEqual(content, customContent);
    });
  });

  describe('ejectConfigs', () => {
    test('replaces junction with real directory', () => {
      const projectConfigDir = join(projectDir, 'config');
      createConfigJunction(globalDir, projectConfigDir);
      ejectConfigs(globalDir, projectConfigDir);
      assert.strictEqual(existsSync(projectConfigDir), true);
      assert.strictEqual(isJunction(projectConfigDir), false);
      assert.strictEqual(existsSync(join(projectConfigDir, 'config.yaml')), true);
      assert.strictEqual(existsSync(join(projectConfigDir, 'pipeline.yaml')), true);
    });

    test('throws when global configs do not exist', () => {
      const emptyGlobalDir = join(testDir, 'empty-global');
      mkdirSync(emptyGlobalDir, { recursive: true });
      assert.throws(() => {
        ejectConfigs(emptyGlobalDir, join(projectDir, 'config'));
      });
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