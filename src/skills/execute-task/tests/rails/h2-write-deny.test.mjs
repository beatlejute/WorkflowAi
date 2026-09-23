// H2: исполнитель не создаёт тикеты и планы и не правит тикеты вне in-progress/
// (инциденты PulseProxy CHG-051, CHG-047, COACH-SYNTH-1); собственные гарды и ядро рельс
// не правятся (принцип 17); свой тикет в in-progress/ и файлы проекта — пишутся.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { withProject, atNode, ctx, claude, decide, ticket } from './_project.mjs';

test('H2: тикеты вне in-progress/ — отказ на любом узле', () => {
  withProject(({ root }) => {
    for (const dir of ['backlog', 'ready', 'review', 'done']) {
      for (const node of ['P3S1', 'P5S1', 'P1S1']) {
        const s = atNode(root, node);
        const p = ticket(root, dir, 'TASK-000.md');
        assert.equal(decide({ action: claude('Edit', { file_path: p }), ctx: ctx(root, s) }).decision, 'deny', `Edit ${dir} ${node}`);
        assert.equal(decide({ action: claude('Write', { file_path: p }), ctx: ctx(root, s) }).decision, 'deny', `Write ${dir} ${node}`);
      }
    }
  });
});

test('H2: создание плана в .workflow/plans/ — отказ, в том числе shell-редиректом', () => {
  withProject(({ root }) => {
    const s = atNode(root, 'P3S1');
    const plan = join(root, '.workflow', 'plans', 'PLAN-002.md');
    assert.equal(decide({ action: claude('Write', { file_path: plan }), ctx: ctx(root, s) }).decision, 'deny');
    assert.equal(
      decide({ action: claude('Bash', { command: 'echo "# PLAN-002" > .workflow/plans/PLAN-002.md' }), ctx: ctx(root, s) }).decision,
      'deny',
    );
  });
});

test('H2: свой тикет в in-progress/ и файлы проекта — пишутся на этапах 3 и 5', () => {
  withProject(({ root }) => {
    for (const node of ['P3S1', 'P5S1']) {
      const s = atNode(root, node);
      assert.equal(decide({ action: claude('Edit', { file_path: ticket(root, 'in-progress') }), ctx: ctx(root, s) }).decision, 'allow', node);
    }
    const s = atNode(root, 'P3S1');
    assert.equal(decide({ action: claude('Write', { file_path: join(root, 'src', 'utils', 'slugify.ts') }), ctx: ctx(root, s) }).decision, 'allow');
  });
});

test('H2: собственный rails.yaml, тесты гардов и ядро рельс — отказ (принцип 17)', () => {
  withProject(({ root, link }) => {
    const s = atNode(root, 'P3S1');
    for (const p of [
      join(link, 'rails.yaml'),
      join(link, 'tests', 'rails', 'h2-write-deny.test.mjs'),
      join(root, '.workflow', 'src', 'rails', 'core.mjs'),
    ]) {
      assert.equal(decide({ action: claude('Edit', { file_path: p }), ctx: ctx(root, s) }).decision, 'deny', p);
    }
  });
});
