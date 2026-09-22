// H1: план не правится (аудит 2026-09-21, узел P0R3); собственные гарды и ядро рельс
// не правятся (принцип 17); тикеты и отчёты — пишутся; делегат освобождён.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { withProject, atNode, ctx, claude, decide } from './_project.mjs';

test('H1: Edit и Write плана в .workflow/plans/ — отказ на любом узле', () => {
  withProject(({ root }) => {
    const plan = join(root, '.workflow', 'plans', 'PLAN-001.md');
    for (const node of ['P10S12', 'P20S1', 'P6S1']) {
      const s = atNode(root, node);
      assert.equal(decide({ action: claude('Edit', { file_path: plan }), ctx: ctx(root, s) }).decision, 'deny', `Edit ${node}`);
      assert.equal(decide({ action: claude('Write', { file_path: plan }), ctx: ctx(root, s) }).decision, 'deny', `Write ${node}`);
    }
  });
});

test('H1: запись плана через shell-редирект — тоже отказ', () => {
  withProject(({ root }) => {
    const r = decide({
      action: claude('Bash', { command: 'echo "status: completed" > .workflow/plans/PLAN-001.md' }),
      ctx: ctx(root, atNode(root, 'P10S12')),
    });
    assert.equal(r.decision, 'deny');
  });
});

test('H1: секция результата тикета и отчёт — пишутся (молчание)', () => {
  withProject(({ root }) => {
    const s = atNode(root, 'P5S1');
    const ticket = join(root, '.workflow', 'tickets', 'in-progress', 'ANL-001.md');
    const report = join(root, '.workflow', 'reports', 'ANALYSIS-001.md');
    assert.equal(decide({ action: claude('Edit', { file_path: ticket }), ctx: ctx(root, s) }).decision, 'allow');
    assert.equal(decide({ action: claude('Write', { file_path: report }), ctx: ctx(root, s) }).decision, 'allow');
  });
});

test('H1: собственный rails.yaml, тесты гардов и ядро рельс — отказ (принцип 17)', () => {
  withProject(({ root, link }) => {
    const s = atNode(root, 'P5S1');
    for (const file of [
      join(link, 'rails.yaml'),
      join(link, 'tests', 'rails', 'h1-write.test.mjs'),
      join(root, '.workflow', 'src', 'rails', 'core.mjs'),
    ]) {
      assert.equal(decide({ action: claude('Edit', { file_path: file }), ctx: ctx(root, s) }).decision, 'deny', file);
    }
  });
});

test('H1: делегат (role executor) — молчание даже на запись плана', () => {
  withProject(({ root }) => {
    const plan = join(root, '.workflow', 'plans', 'PLAN-001.md');
    const r = decide({ action: claude('Edit', { file_path: plan }), ctx: ctx(root, atNode(root, 'P10S12'), { role: 'executor' }) });
    assert.equal(r.decision, 'allow');
  });
});
