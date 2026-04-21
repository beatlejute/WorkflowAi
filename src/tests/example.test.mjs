import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { initProject } from '../init.mjs';

test('initProject creates .workflow/state/ directory', () => {
  const projectRoot = join(tmpdir(), `workflow-example-state-test-${Date.now()}`);

  try {
    initProject(projectRoot, { force: true });

    assert.ok(
      existsSync(join(projectRoot, '.workflow', 'state')),
      '.workflow/state/ should exist after initProject'
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('initProject creates .workflow/config/agent-health-rules.yaml with non-empty content', () => {
  const projectRoot = join(tmpdir(), `workflow-example-rules-test-${Date.now()}`);

  try {
    initProject(projectRoot, { force: true });

    const rulesPath = join(projectRoot, '.workflow', 'config', 'agent-health-rules.yaml');

    assert.ok(
      existsSync(rulesPath) && readFileSync(rulesPath, 'utf8').length > 0,
      'agent-health-rules.yaml should exist and be non-empty'
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
