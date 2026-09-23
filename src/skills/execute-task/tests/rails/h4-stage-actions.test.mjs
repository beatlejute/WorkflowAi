// H4: правка своего тикета допустима только на этапах 3 (инкрементальная запись) и
// 5 (итоговый Result). Наблюдение 2026-04-19: модели выдавали RESULT со status default
// без единого Edit файла тикета, а правка до чтения прогресса перезаписывала сделанное.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withProject, atNode, ctx, claude, decide, ticket } from './_project.mjs';

test('H4: Edit своего тикета до этапа 3 — отказ', () => {
  withProject(({ root }) => {
    for (const node of ['P0S3', 'P1S1', 'P2S1']) {
      const s = atNode(root, node);
      const r = decide({ action: claude('Edit', { file_path: ticket(root, 'in-progress') }), ctx: ctx(root, s) });
      assert.equal(r.decision, 'deny', node);
    }
  });
});

test('H4: Edit своего тикета на этапах 3 и 5 — молчание', () => {
  withProject(({ root }) => {
    for (const node of ['P3S1', 'P3S2', 'P5S1']) {
      const s = atNode(root, node);
      const r = decide({ action: claude('Edit', { file_path: ticket(root, 'in-progress') }), ctx: ctx(root, s) });
      assert.equal(r.decision, 'allow', node);
    }
  });
});

test('H4: Edit своего тикета на этапах 4, 6 и 7 — отказ: там проверяют, а не пишут', () => {
  withProject(({ root }) => {
    for (const node of ['P4S1', 'P6S2', 'P7S1']) {
      const s = atNode(root, node);
      const r = decide({ action: claude('Edit', { file_path: ticket(root, 'in-progress') }), ctx: ctx(root, s) });
      assert.equal(r.decision, 'deny', node);
    }
  });
});

test('H4: чтение тикета разрешено на любом этапе', () => {
  withProject(({ root }) => {
    for (const node of ['P0S3', 'P1S1', 'P6S2']) {
      const s = atNode(root, node);
      const r = decide({ action: claude('Read', { file_path: ticket(root, 'in-progress') }), ctx: ctx(root, s) });
      assert.equal(r.decision, 'allow', node);
    }
  });
});
