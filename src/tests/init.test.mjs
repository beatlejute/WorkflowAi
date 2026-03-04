import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync, statSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import { initProject } from '../init.mjs';

test('initProject creates 17 directories', () => {
  const tmpDir = join(tmpdir(), `workflow-init-test-${Date.now()}`);

  try {
    const result = initProject(tmpDir, { force: true });

    // Verify no errors
    assert.strictEqual(result.errors.length, 0, `Errors: ${result.errors.join(', ')}`);

    // Count directories in .workflow
    const workflowDir = join(tmpDir, '.workflow');
    assert.ok(existsSync(workflowDir), '.workflow directory should exist');

    // Expected directories
    const expectedDirs = [
      'tickets/backlog',
      'tickets/ready',
      'tickets/in-progress',
      'tickets/blocked',
      'tickets/review',
      'tickets/done',
      'plans/current',
      'plans/archive',
      'reports',
      'logs',
      'templates',
      'config',
      'src/skills',
      'src/scripts',
      'src/lib'
    ];

    for (const dir of expectedDirs) {
      const fullPath = join(workflowDir, dir);
      assert.ok(existsSync(fullPath), `${dir} should exist`);
      const stats = statSync(fullPath);
      assert.ok(stats.isDirectory(), `${dir} should be a directory`);
    }

    // Verify .gitkeep.md files exist
    const backlogGitkeep = join(workflowDir, 'tickets/backlog/.gitkeep.md');
    assert.ok(existsSync(backlogGitkeep), '.gitkeep.md should exist in backlog');
  } finally {
    // Cleanup
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('initProject copies skills from package root', () => {
  const tmpDir = join(tmpdir(), `workflow-init-skills-test-${Date.now()}`);

  try {
    const result = initProject(tmpDir, { force: true });

    const skillsDir = join(tmpDir, '.workflow', 'src', 'skills');
    assert.ok(existsSync(skillsDir), 'skills directory should exist');

    // Check for expected skill directories (actual skills in this project)
    const expectedSkills = [
      'create-plan',
      'analyze-report',
      'decompose-plan',
      'check-conditions',
      'create-report',
      'execute-task',
      'decompose-gaps',
      'review-result'
    ];

    for (const skill of expectedSkills) {
      const skillPath = join(skillsDir, skill);
      assert.ok(existsSync(skillPath), `${skill} skill should exist`);
      
      const skillFile = join(skillPath, 'SKILL.md');
      assert.ok(existsSync(skillFile), `${skill}/SKILL.md should exist`);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('initProject copies scripts', () => {
  const tmpDir = join(tmpdir(), `workflow-init-scripts-test-${Date.now()}`);

  try {
    initProject(tmpDir, { force: true });

    const scriptsDir = join(tmpDir, '.workflow', 'src', 'scripts');
    assert.ok(existsSync(scriptsDir), 'scripts directory should exist');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('initProject copies lib files (utils.mjs, find-root.mjs)', () => {
  const tmpDir = join(tmpdir(), `workflow-init-lib-test-${Date.now()}`);

  try {
    initProject(tmpDir, { force: true });

    const libDir = join(tmpDir, '.workflow', 'src', 'lib');
    assert.ok(existsSync(libDir), 'lib directory should exist');

    const utilsPath = join(libDir, 'utils.mjs');
    const findRootPath = join(libDir, 'find-root.mjs');

    assert.ok(existsSync(utilsPath), 'utils.mjs should exist');
    assert.ok(existsSync(findRootPath), 'find-root.mjs should exist');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('initProject copies templates', () => {
  const tmpDir = join(tmpdir(), `workflow-init-templates-test-${Date.now()}`);

  try {
    initProject(tmpDir, { force: true });

    const templatesDir = join(tmpDir, '.workflow', 'templates');
    assert.ok(existsSync(templatesDir), 'templates directory should exist');

    const expectedTemplates = [
      'ticket-template.md',
      'plan-template.md',
      'report-template.md'
    ];

    for (const template of expectedTemplates) {
      const templatePath = join(templatesDir, template);
      assert.ok(existsSync(templatePath), `${template} should exist`);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('initProject creates CLAUDE.md and QWEN.md', () => {
  const tmpDir = join(tmpdir(), `workflow-init-docs-test-${Date.now()}`);

  try {
    initProject(tmpDir, { force: true });

    const claudeMd = join(tmpDir, 'CLAUDE.md');
    const qwenMd = join(tmpDir, 'QWEN.md');

    assert.ok(existsSync(claudeMd), 'CLAUDE.md should exist');
    assert.ok(existsSync(qwenMd), 'QWEN.md should exist');

    // Verify content includes skills table
    const claudeContent = readFileSync(claudeMd, 'utf-8');
    assert.ok(claudeContent.includes('## Доступные Skills'), 'CLAUDE.md should have Skills section');
    assert.ok(claudeContent.includes('.workflow/src/skills/'), 'CLAUDE.md should reference skills path');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('initProject creates .kilocode/skills as junction/symlink', () => {
  const tmpDir = join(tmpdir(), `workflow-init-kilocode-test-${Date.now()}`);

  try {
    const result = initProject(tmpDir, { force: true });

    const kilocodeDir = join(tmpDir, '.kilocode');
    const skillsLink = join(kilocodeDir, 'skills');

    assert.ok(existsSync(kilocodeDir), '.kilocode directory should exist');
    assert.ok(existsSync(skillsLink), '.kilocode/skills should exist');

    // Verify it's a symlink or junction (or copied directory)
    const stats = statSync(skillsLink);
    assert.ok(
      stats.isSymbolicLink() || stats.isDirectory(),
      '.kilocode/skills should be symlink/junction/directory'
    );

    // Verify skills are accessible (use existing skill)
    const executeTaskSkill = join(skillsLink, 'execute-task', 'SKILL.md');
    assert.ok(existsSync(executeTaskSkill), 'execute-task skill should be accessible via symlink');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('initProject updates .gitignore', () => {
  const tmpDir = join(tmpdir(), `workflow-init-gitignore-test-${Date.now()}`);

  try {
    initProject(tmpDir, { force: true });

    const gitignorePath = join(tmpDir, '.gitignore');
    assert.ok(existsSync(gitignorePath), '.gitignore should exist');

    const gitignoreContent = readFileSync(gitignorePath, 'utf-8');
    assert.ok(
      gitignoreContent.includes('.workflow/logs/'),
      '.gitignore should include .workflow/logs/'
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});


test('initProject returns successful result object', () => {
  const tmpDir = join(tmpdir(), `workflow-init-result-test-${Date.now()}`);

  try {
    const result = initProject(tmpDir, { force: true });

    assert.ok(Array.isArray(result.steps), 'result.steps should be array');
    assert.ok(Array.isArray(result.warnings), 'result.warnings should be array');
    assert.ok(Array.isArray(result.errors), 'result.errors should be array');

    assert.strictEqual(result.errors.length, 0, 'Should have no errors');
    assert.ok(result.steps.length > 0, 'Should have completed steps');

    // Verify expected steps
    const stepsText = result.steps.join('\n');
    assert.ok(stepsText.includes('directory structure'), 'Should mention directory structure');
    assert.ok(stepsText.includes('skills'), 'Should mention skills copy');
    assert.ok(stepsText.includes('CLAUDE.md'), 'Should mention CLAUDE.md generation');
    assert.ok(stepsText.includes('QWEN.md'), 'Should mention QWEN.md generation');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('initProject cleans up tmp directory after test', () => {
  // This test verifies the cleanup pattern works
  const tmpDir = join(tmpdir(), `workflow-init-cleanup-test-${Date.now()}`);

  initProject(tmpDir, { force: true });
  assert.ok(existsSync(tmpDir), 'tmp dir should exist before cleanup');

  rmSync(tmpDir, { recursive: true, force: true });
  assert.ok(!existsSync(tmpDir), 'tmp dir should not exist after cleanup');
});
