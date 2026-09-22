// H1: коуч пишет только в .workflow/src/skills/** и coach-backlog.yaml; свой rails.yaml,
// tests/rails и ядро rails — write_deny. Инциденты 2026-09-21 (rails.yaml коуча).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withCoachProject, atNode, ctx, claude, decide, CANON } from './_project.mjs';

test('H1: Write тикета в .workflow/tickets вне write_scope — отказ (утечка фикстуры 2026-09-21)', () => {
  withCoachProject(({ root }) => {
    const s = atNode(root, 'P4S2');
    const r = decide({ action: claude('Write', { file_path: join(root, '.workflow', 'tickets', 'backlog', 'IMPL-999.md') }), ctx: ctx(root, s) });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /вне write_scope/);
  });
});

test('H1: Write в knowledge коуча по проектному пути на этапе П4 — молчание', () => {
  withCoachProject(({ root, link }) => {
    const s = atNode(root, 'P4S2');
    const r = decide({ action: claude('Write', { file_path: join(link, 'knowledge', 'new-note.md') }), ctx: ctx(root, s) });
    assert.equal(r.decision, 'allow');
  });
});

test('H1: Edit коуча по каноническому пути (через junction) на этапе П4 — молчание (realpath, §2)', () => {
  withCoachProject(({ root }) => {
    const s = atNode(root, 'P4S2');
    const r = decide({ action: claude('Edit', { file_path: join(CANON, 'SKILL.md') }), ctx: ctx(root, s) });
    assert.equal(r.decision, 'allow');
  });
});

test('H1b: Edit собственного rails.yaml коуча — отказ (принцип 17)', () => {
  withCoachProject(({ root, link }) => {
    const s = atNode(root, 'P4S2');
    const r = decide({ action: claude('Edit', { file_path: join(link, 'rails.yaml') }), ctx: ctx(root, s) });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /write_deny/);
  });
});

test('H1b: Write в ядро rails проекта (.workflow/src/rails) — отказ', () => {
  withCoachProject(({ root }) => {
    const s = atNode(root, 'P4S2');
    const r = decide({ action: claude('Write', { file_path: join(root, '.workflow', 'src', 'rails', 'core.mjs') }), ctx: ctx(root, s) });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /write_deny/);
  });
});

test('H1: Write во временный каталог — молчание (allow_temp)', () => {
  withCoachProject(({ root }) => {
    const s = atNode(root, 'P4S2');
    const r = decide({ action: claude('Write', { file_path: join(tmpdir(), 'coach-rails-probe', 'note.txt') }), ctx: ctx(root, s) });
    assert.equal(r.decision, 'allow');
  });
});

test('H1: делегат (role=executor) пишет куда угодно — молчание', () => {
  withCoachProject(({ root }) => {
    const s = atNode(root, 'P4S2');
    const r = decide({ action: claude('Write', { file_path: join(root, '.workflow', 'tickets', 'backlog', 'X.md') }), ctx: ctx(root, s, { role: 'executor' }) });
    assert.deepEqual(r, { decision: 'allow' });
  });
});
