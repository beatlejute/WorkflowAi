import { test, describe, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { listPlans, getPlan } from '../lib/operations/plans.mjs';

describe('operations/plans.mjs', () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = join(tmpdir(), `workflow-plans-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(projectRoot, 'plans', 'current'), { recursive: true });
    mkdirSync(join(projectRoot, 'plans', 'archive'), { recursive: true });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  test('TC1: listPlans without filter returns plans from both current and archive', async () => {
    // Create test plans in current/
    writeFileSync(join(projectRoot, 'plans', 'current', 'PLAN-001.md'), `---
id: PLAN-001
title: Plan One
status: active
---
# Plan One
Body content`);

    writeFileSync(join(projectRoot, 'plans', 'current', 'PLAN-002.md'), `---
id: PLAN-002
title: Plan Two
status: draft
---
# Plan Two
Body content`);

    // Create test plans in archive/
    writeFileSync(join(projectRoot, 'plans', 'archive', 'PLAN-003.md'), `---
id: PLAN-003
title: Plan Three
status: completed
---
# Plan Three
Body content`);

    writeFileSync(join(projectRoot, 'plans', 'archive', 'PLAN-004.md'), `---
id: PLAN-004
title: Plan Four
status: draft
---
# Plan Four
Body content`);

    const plans = await listPlans(projectRoot);

    assert.equal(plans.length, 4, 'Should return 4 plans (2 from current + 2 from archive)');
    assert.deepEqual(
      plans.map(p => p.id).sort(),
      ['PLAN-001', 'PLAN-002', 'PLAN-003', 'PLAN-004'],
      'Should return all plan IDs'
    );
  });

  test('TC2: listPlans with status filter returns only plans with matching status', async () => {
    // Create test plans with different statuses
    writeFileSync(join(projectRoot, 'plans', 'current', 'PLAN-001.md'), `---
id: PLAN-001
title: Plan One
status: active
---
# Plan One`);

    writeFileSync(join(projectRoot, 'plans', 'current', 'PLAN-002.md'), `---
id: PLAN-002
title: Plan Two
status: draft
---
# Plan Two`);

    writeFileSync(join(projectRoot, 'plans', 'archive', 'PLAN-003.md'), `---
id: PLAN-003
title: Plan Three
status: draft
---
# Plan Three`);

    writeFileSync(join(projectRoot, 'plans', 'archive', 'PLAN-004.md'), `---
id: PLAN-004
title: Plan Four
status: completed
---
# Plan Four`);

    const draftPlans = await listPlans(projectRoot, { status: 'draft' });

    assert.equal(draftPlans.length, 2, 'Should return 2 draft plans');
    assert.deepEqual(
      draftPlans.map(p => p.id).sort(),
      ['PLAN-002', 'PLAN-003'],
      'Should return only draft plans from both current and archive'
    );

    const activePlans = await listPlans(projectRoot, { status: 'active' });
    assert.equal(activePlans.length, 1, 'Should return 1 active plan');
    assert.equal(activePlans[0].id, 'PLAN-001', 'Should be PLAN-001');
  });

  test('TC3: getPlan returns {frontmatter, body, path} for existing plan', async () => {
    const planContent = `---
id: PLAN-001
title: Test Plan
status: active
author: tester
created_at: 2026-04-24T00:00:00Z
---
# Test Plan

## Section 1
This is the body content`;

    writeFileSync(join(projectRoot, 'plans', 'current', 'PLAN-001.md'), planContent);

    const plan = await getPlan(projectRoot, 'PLAN-001');

    assert.ok(plan, 'Should return a plan object');
    assert.ok(plan.frontmatter, 'Should have frontmatter');
    assert.ok(plan.body, 'Should have body');
    assert.ok(plan.path, 'Should have path');

    assert.equal(plan.frontmatter.id, 'PLAN-001', 'Frontmatter should have correct id');
    assert.equal(plan.frontmatter.title, 'Test Plan', 'Frontmatter should have correct title');
    assert.equal(plan.frontmatter.status, 'active', 'Frontmatter should have correct status');
    assert.equal(plan.frontmatter.author, 'tester', 'Frontmatter should have correct author');

    assert.ok(plan.body.includes('## Section 1'), 'Body should contain section heading');
    assert.ok(plan.body.includes('This is the body content'), 'Body should contain content');
    assert.ok(plan.path.includes('PLAN-001.md'), 'Path should include filename');
  });

  test('TC3b: getPlan works with plan from archive', async () => {
    const planContent = `---
id: PLAN-005
title: Archived Plan
status: completed
---
# Archived Plan`;

    writeFileSync(join(projectRoot, 'plans', 'archive', 'PLAN-005.md'), planContent);

    const plan = await getPlan(projectRoot, 'PLAN-005');

    assert.ok(plan, 'Should find plan in archive');
    assert.equal(plan.frontmatter.id, 'PLAN-005', 'Should parse frontmatter correctly');
    assert.equal(plan.frontmatter.status, 'completed', 'Should have correct status');
  });

  test('TC4: getPlan throws error with code PLAN_NOT_FOUND for non-existent plan', async () => {
    writeFileSync(join(projectRoot, 'plans', 'current', 'PLAN-001.md'), `---
id: PLAN-001
title: Plan One
---
# Plan One`);

    assert.rejects(
      async () => {
        await getPlan(projectRoot, 'PLAN-999');
      },
      (err) => {
        return err.code === 'PLAN_NOT_FOUND' && err.planId === 'PLAN-999';
      },
      'Should throw error with code PLAN_NOT_FOUND'
    );
  });

  test('TC4b: getPlan is case-insensitive when matching plan IDs', async () => {
    writeFileSync(join(projectRoot, 'plans', 'current', 'PLAN-001.md'), `---
id: PLAN-001
title: Plan One
---
# Plan One`);

    const plan = await getPlan(projectRoot, 'plan-001');
    assert.ok(plan, 'Should find plan with lowercase ID');
    assert.equal(plan.frontmatter.id, 'PLAN-001', 'Should return correct frontmatter');
  });

  test('TC5: listPlans returns empty array when directories are empty', async () => {
    const plans = await listPlans(projectRoot);
    assert.equal(plans.length, 0, 'Should return empty array');
  });

  test('TC6: listPlans ignores non-markdown files', async () => {
    writeFileSync(join(projectRoot, 'plans', 'current', 'PLAN-001.md'), `---
id: PLAN-001
title: Plan One
---`);

    writeFileSync(join(projectRoot, 'plans', 'current', 'README.txt'), 'Not a plan');
    writeFileSync(join(projectRoot, 'plans', 'current', 'config.json'), '{}');

    const plans = await listPlans(projectRoot);
    assert.equal(plans.length, 1, 'Should only return .md files');
    assert.equal(plans[0].id, 'PLAN-001', 'Should be the markdown plan');
  });

  test('TC7: listPlans handles plans without status in frontmatter', async () => {
    writeFileSync(join(projectRoot, 'plans', 'current', 'PLAN-001.md'), `---
id: PLAN-001
title: Plan One
---`);

    const plans = await listPlans(projectRoot);
    assert.equal(plans.length, 1, 'Should include plan without status');
    assert.equal(plans[0].status, 'unknown', 'Should set status to unknown when not specified');
  });

  test('TC8: listPlans handles plans without id in frontmatter', async () => {
    writeFileSync(join(projectRoot, 'plans', 'current', 'PLAN-001.md'), `---
title: Plan One
status: active
---`);

    const plans = await listPlans(projectRoot);
    assert.equal(plans.length, 1, 'Should include plan without id');
    assert.equal(plans[0].id, 'PLAN-001', 'Should use filename as id when not in frontmatter');
  });

  test('TC9: getPlan returns correct path to file', async () => {
    const planPath = join(projectRoot, 'plans', 'current', 'PLAN-TEST.md');
    writeFileSync(planPath, `---
id: PLAN-TEST
title: Test Plan
---`);

    const plan = await getPlan(projectRoot, 'PLAN-TEST');
    assert.equal(plan.path, planPath, 'Should return absolute path to plan file');
  });
});
