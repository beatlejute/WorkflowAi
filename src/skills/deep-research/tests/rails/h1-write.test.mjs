// H1: каталог скилов закрыт целиком (узел P0R2, прогон 2026-09-25: отчёт писался в
// .workflow/src/skills/deep-research/reports/ — в проекте это общая копия скилов), в том числе
// собственные гарды (принцип 17); ядро рельс не правится; отчёт по пути из тикета и секция
// Result тикета — пишутся; делегат освобождён.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { withProject, atNode, ctx, claude, decide } from './_project.mjs';

test('H1: отчёт по пути из тикета и секция Result тикета — пишутся (молчание)', () => {
  withProject(({ root }) => {
    const report = join(root, '.workflow', 'reports', 'RSH-001-research.md');
    const ticket = join(root, '.workflow', 'tickets', 'in-progress', 'RSH-001.md');
    const projectArtifact = join(root, 'analytics', 'market-research.md');
    for (const node of ['P3S2', 'P5S1', 'P9S1']) {
      const s = atNode(root, node);
      assert.equal(decide({ action: claude('Write', { file_path: report }), ctx: ctx(root, s) }).decision, 'allow', `отчёт ${node}`);
      assert.equal(decide({ action: claude('Write', { file_path: projectArtifact }), ctx: ctx(root, s) }).decision, 'allow', `артефакт по пути тикета ${node}`);
      assert.equal(decide({ action: claude('Edit', { file_path: ticket }), ctx: ctx(root, s) }).decision, 'allow', `тикет ${node}`);
    }
  });
});

test('H1: отчёт в каталог скила — отказ на любом узле (прогон 2026-09-25)', () => {
  withProject(({ root, link }) => {
    const inSkill = join(link, 'reports', 'chrome-mv3-formats_2026-09-25.md');
    const otherSkill = join(root, '.workflow', 'src', 'skills', 'other-skill', 'notes.md');
    for (const node of ['P3S2', 'P5S2', 'P9S1']) {
      const s = atNode(root, node);
      assert.equal(decide({ action: claude('Write', { file_path: inSkill }), ctx: ctx(root, s) }).decision, 'deny', `свой скил ${node}`);
      assert.equal(decide({ action: claude('Write', { file_path: otherSkill }), ctx: ctx(root, s) }).decision, 'deny', `чужой скил ${node}`);
    }
  });
});

test('H1: собственный rails.yaml, тесты гардов и ядро рельс — отказ (принцип 17)', () => {
  withProject(({ root, link }) => {
    const s = atNode(root, 'P3S2');
    for (const file of [
      join(link, 'rails.yaml'),
      join(link, 'tests', 'rails', 'h1-write.test.mjs'),
      join(root, '.workflow', 'src', 'rails', 'core.mjs'),
    ]) {
      assert.equal(decide({ action: claude('Edit', { file_path: file }), ctx: ctx(root, s) }).decision, 'deny', file);
    }
  });
});

test('H1: запись в rails.yaml через shell-редирект — тоже отказ', () => {
  withProject(({ root }) => {
    const r = decide({
      action: claude('Bash', { command: 'echo "cycles: []" > .workflow/src/skills/deep-research/rails.yaml' }),
      ctx: ctx(root, atNode(root, 'P3S2')),
    });
    assert.equal(r.decision, 'deny');
  });
});

test('H1: делегат (role executor) — молчание даже на запись rails.yaml', () => {
  withProject(({ root, link }) => {
    const r = decide({ action: claude('Edit', { file_path: join(link, 'rails.yaml') }), ctx: ctx(root, atNode(root, 'P3S2'), { role: 'executor' }) });
    assert.equal(r.decision, 'allow');
  });
});
