import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, statSync, readdirSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { initProject } from '../init.mjs';
import { getGlobalDir } from '../global-dir.mjs';
import { isJunction } from '../junction-manager.mjs';

let testGlobalDir;
let originalWorkflowHome;

beforeEach(() => {
  originalWorkflowHome = process.env.WORKFLOW_HOME;
  testGlobalDir = join(tmpdir(), `workflow-init-global-${Date.now()}`);
  process.env.WORKFLOW_HOME = testGlobalDir;
});

afterEach(() => {
  if (originalWorkflowHome === undefined) {
    delete process.env.WORKFLOW_HOME;
  } else {
    process.env.WORKFLOW_HOME = originalWorkflowHome;
  }
  rmSync(testGlobalDir, { recursive: true, force: true });
});

test('initProject creates 16 directories', () => {
  const tmpDir = join(tmpdir(), `workflow-init-test-${Date.now()}`);

  try {
    const result = initProject(tmpDir, { force: true });

    assert.strictEqual(result.errors.length, 0, `Errors: ${result.errors.join(', ')}`);

    const workflowDir = join(tmpDir, '.workflow');
    assert.ok(existsSync(workflowDir), '.workflow directory should exist');

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
      'tests/skills'
    ];

    for (const dir of expectedDirs) {
      const fullPath = join(workflowDir, dir);
      assert.ok(existsSync(fullPath), `${dir} should exist`);
      const stats = statSync(fullPath);
      assert.ok(stats.isDirectory(), `${dir} should be a directory`);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('initProject creates skill junctions from global dir', () => {
  const tmpDir = join(tmpdir(), `workflow-init-skills-test-${Date.now()}`);

  try {
    const result = initProject(tmpDir, { force: true });

    const skillsDir = join(tmpDir, '.workflow', 'src', 'skills');
    assert.ok(existsSync(skillsDir), 'skills directory should exist');

    const globalDir = getGlobalDir();
    const globalSkillsDir = join(globalDir, 'skills');

    if (existsSync(globalSkillsDir)) {
      const globalSkills = readdirSync(globalSkillsDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name);

      for (const skill of globalSkills) {
        const skillPath = join(skillsDir, skill);
        assert.ok(existsSync(skillPath), `${skill} skill should exist`);
        assert.ok(isJunction(skillPath), `${skill} should be a junction/symlink`);
      }
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('initProject creates script hardlinks from global dir', () => {
  const tmpDir = join(tmpdir(), `workflow-init-scripts-test-${Date.now()}`);

  try {
    initProject(tmpDir, { force: true });

    const scriptsDir = join(tmpDir, '.workflow', 'src', 'scripts');
    assert.ok(existsSync(scriptsDir), 'scripts directory should exist');

    const globalDir = getGlobalDir();
    const globalScriptsDir = join(globalDir, 'scripts');
    if (existsSync(globalScriptsDir)) {
      const globalScripts = readdirSync(globalScriptsDir);
      for (const script of globalScripts) {
        const scriptPath = join(scriptsDir, script);
        assert.ok(existsSync(scriptPath), `${script} should exist as hardlink`);
      }
    }
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

    const stats = statSync(skillsLink);
    assert.ok(
      stats.isSymbolicLink() || stats.isDirectory(),
      '.kilocode/skills should be symlink/junction/directory'
    );
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
      gitignoreContent.includes('.workflow/'),
      '.gitignore should include .workflow/'
    );
    assert.ok(
      gitignoreContent.includes('.kilocode/'),
      '.gitignore should include .kilocode/'
    );
    assert.ok(
      gitignoreContent.includes('CLAUDE.md'),
      '.gitignore should include CLAUDE.md'
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

    const stepsText = result.steps.join('\n');
    assert.ok(stepsText.includes('directory structure'), 'Should mention directory structure');
    assert.ok(stepsText.includes('skills') || stepsText.includes('skill'), 'Should mention skills');
    assert.ok(stepsText.includes('CLAUDE.md'), 'Should mention CLAUDE.md generation');
    assert.ok(stepsText.includes('QWEN.md'), 'Should mention QWEN.md generation');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('initProject cleans up tmp directory after test', () => {
  const tmpDir = join(tmpdir(), `workflow-init-cleanup-test-${Date.now()}`);

  initProject(tmpDir, { force: true });
  assert.ok(existsSync(tmpDir), 'tmp dir should exist before cleanup');

  rmSync(tmpDir, { recursive: true, force: true });
  assert.ok(!existsSync(tmpDir), 'tmp dir should not exist after cleanup');
});

test('initProject creates .workflow/tests/skills/.gitkeep', () => {
  const tmpDir = join(tmpdir(), `workflow-init-gitkeep-test-${Date.now()}`);

  try {
    initProject(tmpDir, { force: true });

    const gitkeepPath = join(tmpDir, '.workflow', 'tests', 'skills', '.gitkeep');
    assert.ok(existsSync(gitkeepPath), '.workflow/tests/skills/.gitkeep should exist');

    const stats = statSync(gitkeepPath);
    assert.ok(stats.isFile(), '.gitkeep should be a file');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('initProject does NOT create .workflow/metrics/skill-tests/', () => {
  const tmpDir = join(tmpdir(), `workflow-init-no-metrics-test-${Date.now()}`);

  try {
    initProject(tmpDir, { force: true });

    const metricsDir = join(tmpDir, '.workflow', 'metrics', 'skill-tests');
    assert.ok(!existsSync(metricsDir), '.workflow/metrics/skill-tests/ should NOT exist');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('initProject is idempotent (second run does not break initialized project)', () => {
  const tmpDir = join(tmpdir(), `workflow-init-idempotent-test-${Date.now()}`);

  try {
    // First run
    const result1 = initProject(tmpDir, { force: true });
    assert.strictEqual(result1.errors.length, 0, `First run should have no errors: ${result1.errors.join(', ')}`);

    // Verify .workflow/tests/skills/.gitkeep exists after first run
    const gitkeepPath = join(tmpDir, '.workflow', 'tests', 'skills', '.gitkeep');
    const gitkeepExistsAfterFirst = existsSync(gitkeepPath);

    // Second run (idempotency check)
    const result2 = initProject(tmpDir, { force: true });
    assert.strictEqual(result2.errors.length, 0, `Second run should have no errors: ${result2.errors.join(', ')}`);

    // Verify .workflow/tests/skills/.gitkeep still exists after second run
    assert.ok(existsSync(gitkeepPath), '.gitkeep should still exist after second run');

    // Verify directory still exists
    const testsSkillsDir = join(tmpDir, '.workflow', 'tests', 'skills');
    assert.ok(existsSync(testsSkillsDir), 'tests/skills directory should still exist');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
