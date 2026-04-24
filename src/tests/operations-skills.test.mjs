import { test, describe, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, symlinkSync, lstatSync } from 'node:fs';
import { listSkills } from '../lib/operations/skills.mjs';

describe('operations/skills.mjs', () => {
  let testDir, globalRoot, projectRoot, globalSkillsDir, projectSkillsDir;

  beforeEach(() => {
    testDir = join(tmpdir(), `workflow-skills-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    // Structure: testDir/src/skills (global) and testDir/project/.workflow/src/skills (project)
    // So projectRoot is testDir/project, and globalRoot is testDir
    projectRoot = join(testDir, 'project');
    globalSkillsDir = join(testDir, 'src', 'skills');
    projectSkillsDir = join(projectRoot, '.workflow', 'src', 'skills');

    // Create basic directory structure
    mkdirSync(projectRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test('TC1: Only shared directory (no ejected) → all source: "shared"', async () => {
    // Create global skills directory with two skills
    mkdirSync(join(globalSkillsDir, 'skill1'), { recursive: true });
    mkdirSync(join(globalSkillsDir, 'skill2'), { recursive: true });
    writeFileSync(join(globalSkillsDir, 'skill1', 'SKILL.md'), '# Skill 1');
    writeFileSync(join(globalSkillsDir, 'skill2', 'SKILL.md'), '# Skill 2');

    // Do NOT create project skills directory

    const skills = await listSkills(projectRoot);

    assert.equal(skills.length, 2, 'Should return 2 skills');

    const skill1 = skills.find(s => s.name === 'skill1');
    const skill2 = skills.find(s => s.name === 'skill2');

    assert.ok(skill1, 'Should find skill1');
    assert.ok(skill2, 'Should find skill2');

    assert.equal(skill1.source, 'shared', 'skill1 should have source: "shared"');
    assert.equal(skill2.source, 'shared', 'skill2 should have source: "shared"');

    assert.equal(skill1.path, join(globalSkillsDir, 'skill1'), 'skill1 path should be global path');
    assert.equal(skill2.path, join(globalSkillsDir, 'skill2'), 'skill2 path should be global path');
  });

  test('TC2: Ejected directory override → ejected version source: "ejected", duplicate shared excluded', async () => {
    // Create global skills with skill1 and skill2
    mkdirSync(join(globalSkillsDir, 'skill1'), { recursive: true });
    mkdirSync(join(globalSkillsDir, 'skill2'), { recursive: true });
    writeFileSync(join(globalSkillsDir, 'skill1', 'SKILL.md'), '# Global Skill 1');
    writeFileSync(join(globalSkillsDir, 'skill2', 'SKILL.md'), '# Global Skill 2');

    // Create ejected directory with skill1 (override) and skill3
    mkdirSync(join(projectSkillsDir, 'skill1'), { recursive: true });
    mkdirSync(join(projectSkillsDir, 'skill3'), { recursive: true });
    writeFileSync(join(projectSkillsDir, 'skill1', 'SKILL.md'), '# Ejected Skill 1');
    writeFileSync(join(projectSkillsDir, 'skill3', 'SKILL.md'), '# Ejected Skill 3');

    const skills = await listSkills(projectRoot);

    assert.equal(skills.length, 3, 'Should return 3 skills (skill1 ejected, skill2 shared, skill3 ejected)');

    const skill1 = skills.find(s => s.name === 'skill1');
    const skill2 = skills.find(s => s.name === 'skill2');
    const skill3 = skills.find(s => s.name === 'skill3');

    assert.ok(skill1, 'Should find skill1');
    assert.ok(skill2, 'Should find skill2');
    assert.ok(skill3, 'Should find skill3');

    // skill1 should be ejected version (override)
    assert.equal(skill1.source, 'ejected', 'skill1 should have source: "ejected" (overridden)');
    assert.equal(skill1.path, join(projectSkillsDir, 'skill1'), 'skill1 path should be ejected path');

    // skill2 should be shared (no override)
    assert.equal(skill2.source, 'shared', 'skill2 should have source: "shared" (not overridden)');
    assert.equal(skill2.path, join(globalSkillsDir, 'skill2'), 'skill2 path should be global path');

    // skill3 should be ejected
    assert.equal(skill3.source, 'ejected', 'skill3 should have source: "ejected"');
    assert.equal(skill3.path, join(projectSkillsDir, 'skill3'), 'skill3 path should be ejected path');
  });

  test('TC3: No project skills directory → only shared skills', async () => {
    // Create only global skills
    mkdirSync(join(globalSkillsDir, 'skill1'), { recursive: true });
    mkdirSync(join(globalSkillsDir, 'skill2'), { recursive: true });
    writeFileSync(join(globalSkillsDir, 'skill1', 'SKILL.md'), '# Skill 1');
    writeFileSync(join(globalSkillsDir, 'skill2', 'SKILL.md'), '# Skill 2');

    // Explicitly do NOT create project skills directory

    const skills = await listSkills(projectRoot);

    assert.equal(skills.length, 2, 'Should return 2 skills from global directory');

    for (const skill of skills) {
      assert.equal(skill.source, 'shared', `${skill.name} should have source: "shared"`);
    }
  });

  test('TC4: Junction/symlink on project skills directory → all source: "shared"', async () => {
    // Create global skills
    mkdirSync(join(globalSkillsDir, 'skill1'), { recursive: true });
    mkdirSync(join(globalSkillsDir, 'skill2'), { recursive: true });
    writeFileSync(join(globalSkillsDir, 'skill1', 'SKILL.md'), '# Skill 1');
    writeFileSync(join(globalSkillsDir, 'skill2', 'SKILL.md'), '# Skill 2');

    // Create project skills directory as a junction/symlink to global skills directory
    mkdirSync(join(projectRoot, '.workflow', 'src'), { recursive: true });

    // Use symlinkSync with appropriate type for platform
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    symlinkSync(globalSkillsDir, projectSkillsDir, linkType);

    // Verify it's actually a symlink/junction
    const stats = lstatSync(projectSkillsDir);
    assert.ok(stats.isSymbolicLink(), 'Project skills directory should be a symlink/junction');

    const skills = await listSkills(projectRoot);

    assert.equal(skills.length, 2, 'Should return 2 skills');

    for (const skill of skills) {
      assert.equal(skill.source, 'shared', `${skill.name} should have source: "shared" (junction is treated as shared)`);
      // When junction, paths should point to global skills
      assert.equal(skill.path, join(globalSkillsDir, skill.name), `${skill.name} path should be global path`);
    }
  });

  test('TC5: Empty global skills directory → empty array', async () => {
    // Create empty global skills directory
    mkdirSync(globalSkillsDir, { recursive: true });

    const skills = await listSkills(projectRoot);

    assert.equal(skills.length, 0, 'Should return empty array when no skills exist');
  });

  test('TC6: Mixed global and ejected skills with some shared overrides', async () => {
    // Global: skill1, skill2, skill3
    mkdirSync(join(globalSkillsDir, 'skill1'), { recursive: true });
    mkdirSync(join(globalSkillsDir, 'skill2'), { recursive: true });
    mkdirSync(join(globalSkillsDir, 'skill3'), { recursive: true });
    writeFileSync(join(globalSkillsDir, 'skill1', 'SKILL.md'), '# Global Skill 1');
    writeFileSync(join(globalSkillsDir, 'skill2', 'SKILL.md'), '# Global Skill 2');
    writeFileSync(join(globalSkillsDir, 'skill3', 'SKILL.md'), '# Global Skill 3');

    // Ejected: skill2, skill4 (override skill2, add skill4)
    mkdirSync(join(projectSkillsDir, 'skill2'), { recursive: true });
    mkdirSync(join(projectSkillsDir, 'skill4'), { recursive: true });
    writeFileSync(join(projectSkillsDir, 'skill2', 'SKILL.md'), '# Ejected Skill 2');
    writeFileSync(join(projectSkillsDir, 'skill4', 'SKILL.md'), '# Ejected Skill 4');

    const skills = await listSkills(projectRoot);

    assert.equal(skills.length, 4, 'Should return 4 unique skills');

    const skill1 = skills.find(s => s.name === 'skill1');
    const skill2 = skills.find(s => s.name === 'skill2');
    const skill3 = skills.find(s => s.name === 'skill3');
    const skill4 = skills.find(s => s.name === 'skill4');

    // skill1: shared (global only)
    assert.equal(skill1.source, 'shared', 'skill1 should be shared (global only)');

    // skill2: ejected (overridden)
    assert.equal(skill2.source, 'ejected', 'skill2 should be ejected (overridden)');

    // skill3: shared (global only)
    assert.equal(skill3.source, 'shared', 'skill3 should be shared (global only)');

    // skill4: ejected (ejected only)
    assert.equal(skill4.source, 'ejected', 'skill4 should be ejected (ejected only)');
  });
});
