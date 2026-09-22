// Канарейка живости (узел P0S1), освобождение делегата, скоуп по каталогу, гард G0 без скила.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withCoachProject, atNode, ctx, claude, decide, CANON } from './_project.mjs';

test('канарейка: echo RAILS_CANARY на любом узле — отказ с текстом «рельсы активны»', () => {
  withCoachProject(({ root }) => {
    for (const node of ['P0S1', 'P4S2', 'P8S1']) {
      const r = decide({ action: claude('Bash', { command: 'echo RAILS_CANARY' }), ctx: ctx(root, atNode(root, node)) });
      assert.equal(r.decision, 'deny', node);
      assert.match(r.reason, /RAILS_CANARY/);
    }
  });
});

test('делегат: канарейка и любые действия — молчание (role=executor)', () => {
  withCoachProject(({ root }) => {
    const r = decide({ action: claude('Bash', { command: 'echo RAILS_CANARY' }), ctx: ctx(root, atNode(root, 'P0S1'), { role: 'executor' }) });
    assert.deepEqual(r, { decision: 'allow' });
  });
});

test('скоуп: вне проекта workflow — хук молчит даже на канарейку', () => {
  const base = mkdtempSync(join(tmpdir(), 'coach-rails-noproj-'));
  try {
    const r = decide({ action: claude('Bash', { command: 'echo RAILS_CANARY' }), ctx: { cwd: base, sessionId: randomUUID(), role: 'coordinator' } });
    assert.deepEqual(r, { decision: 'allow' });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('G0: без состояния сессии правка файла коуча (в том числе по каноническому пути) — отказ «только через коуча на рельсах»', () => {
  withCoachProject(({ root, link }) => {
    for (const file of [join(link, 'SKILL.md'), join(CANON, 'knowledge', 'rails-concept.md')]) {
      const r = decide({ action: claude('Edit', { file_path: file }), ctx: { cwd: root, sessionId: randomUUID() } });
      assert.equal(r.decision, 'deny', file);
      assert.match(r.reason, /cli\.mjs start coach/);
    }
  });
});
