// Канарейка живости (узел P0S1): рельсы отклоняют echo RAILS_CANARY у координатора
// и молчат у делегата; безвредная команда без записи — молчание.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withProject, atNode, ctx, claude, decide } from './_project.mjs';

test('канарейка: координатор на P0S1 — отказ с упоминанием RAILS_CANARY', () => {
  withProject(({ root }) => {
    const r = decide({ action: claude('Bash', { command: 'echo RAILS_CANARY' }), ctx: ctx(root, atNode(root, 'P0S1')) });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /RAILS_CANARY/);
  });
});

test('канарейка: делегат (role executor) — молчание', () => {
  withProject(({ root }) => {
    const r = decide({ action: claude('Bash', { command: 'echo RAILS_CANARY' }), ctx: ctx(root, atNode(root, 'P0S1'), { role: 'executor' }) });
    assert.equal(r.decision, 'allow');
  });
});

test('чтение лога и скрипт метрик — молчание (действия не привязаны к этапам без инцидента)', () => {
  withProject(({ root }) => {
    const s = atNode(root, 'P10S3');
    for (const command of [
      'node .workflow/src/skills/analyze-report/scripts/calc-plan-metrics.js PLAN-001',
      'grep -n ANL-001 .workflow/logs/pipeline_2026-09-21.log',
    ]) {
      assert.equal(decide({ action: claude('Bash', { command }), ctx: ctx(root, s) }).decision, 'allow', command);
    }
  });
});
