// H1 и H2: принцип No Fix — ревьюер пишет только запись в своём тикете на ревью.
// Правки кода проекта, чужих тикетов, планов, собственных гардов и ядра рельс — отказ.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { withProject, atNode, ctx, claude, decide, ticket } from './_project.mjs';

test('H1: правка файла проекта — отказ на любом узле (No Fix)', () => {
  withProject(({ root }) => {
    const src = join(root, 'src', 'app.ts');
    for (const node of ['P3S1', 'P4S2', 'P6S1']) {
      const s = atNode(root, node);
      assert.equal(decide({ action: claude('Edit', { file_path: src }), ctx: ctx(root, s) }).decision, 'deny', `Edit ${node}`);
      assert.equal(decide({ action: claude('Write', { file_path: src }), ctx: ctx(root, s) }).decision, 'deny', `Write ${node}`);
    }
  });
});

test('H1: правка файла проекта через shell-редирект — тоже отказ', () => {
  withProject(({ root }) => {
    const s = atNode(root, 'P4S2');
    const r = decide({ action: claude('Bash', { command: 'echo "export const a = 2;" > src/app.ts' }), ctx: ctx(root, s) });
    assert.equal(r.decision, 'deny');
  });
});

test('H2: чужие тикеты и планы — отказ', () => {
  withProject(({ root }) => {
    const s = atNode(root, 'P6S1');
    for (const p of [
      ticket(root, 'in-progress', 'TASK-002.md'),
      ticket(root, 'done', 'TASK-003.md'),
      join(root, '.workflow', 'plans', 'PLAN-001.md'),
    ]) {
      assert.equal(decide({ action: claude('Write', { file_path: p }), ctx: ctx(root, s) }).decision, 'deny', p);
    }
  });
});

test('H2: собственный rails.yaml, тесты гардов и ядро рельс — отказ (принцип 17)', () => {
  withProject(({ root, link }) => {
    const s = atNode(root, 'P6S1');
    for (const p of [
      join(link, 'rails.yaml'),
      join(link, 'tests', 'rails', 'h1-no-fix.test.mjs'),
      join(root, '.workflow', 'src', 'rails', 'core.mjs'),
    ]) {
      assert.equal(decide({ action: claude('Edit', { file_path: p }), ctx: ctx(root, s) }).decision, 'deny', p);
    }
  });
});

test('H1: чтение любых файлов проекта разрешено — ревью читает всё', () => {
  withProject(({ root }) => {
    const s = atNode(root, 'P3S1');
    for (const p of [join(root, 'src', 'app.ts'), ticket(root, 'in-progress', 'TASK-002.md')]) {
      assert.equal(decide({ action: claude('Read', { file_path: p }), ctx: ctx(root, s) }).decision, 'allow', p);
    }
  });
});
