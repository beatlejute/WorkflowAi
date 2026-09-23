// H1 и H2: планировщик пишет ровно один артефакт — файл плана в current/.
// Тикеты создаёт скил декомпозиции, код продукта правит исполнитель, архив планов
// ведёт жизненный цикл. Инцидент PulseProxy DEF-016-001: планирование предписало
// значение вместо критерия приёмки, значение оказалось неверным — планировщик не
// запускает и не проверяет код, значит и не правит его.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { withProject, atNode, ctx, claude, decide, plan } from './_project.mjs';

test('H1: файл плана в current/ — запись разрешена на этапе сохранения', () => {
  withProject(({ root }) => {
    const s = atNode(root, 'P5S5');
    assert.equal(decide({ action: claude('Write', { file_path: plan(root) }), ctx: ctx(root, s) }).decision, 'allow');
  });
});

test('H2: тикеты, архив планов и код продукта — отказ на любом узле', () => {
  withProject(({ root }) => {
    for (const node of ['P10S6', 'P5S5', 'P6S1']) {
      const s = atNode(root, node);
      for (const p of [
        join(root, '.workflow', 'tickets', 'ready', 'TASK-002.md'),
        plan(root, 'archive', 'PLAN-001.md'),
        join(root, 'src', 'app.ts'),
      ]) {
        assert.equal(decide({ action: claude('Write', { file_path: p }), ctx: ctx(root, s) }).decision, 'deny', `${node}: ${p}`);
      }
    }
  });
});

test('H2: запись тикета через shell-редирект — тоже отказ', () => {
  withProject(({ root }) => {
    const s = atNode(root, 'P10S6');
    const command = 'echo "# TASK-003" > .workflow/tickets/ready/TASK-003.md';
    assert.equal(decide({ action: claude('Bash', { command }), ctx: ctx(root, s) }).decision, 'deny');
  });
});

test('H2: собственный rails.yaml, тесты гардов и ядро рельс — отказ (принцип 17)', () => {
  withProject(({ root, link }) => {
    const s = atNode(root, 'P5S5');
    for (const p of [
      join(link, 'rails.yaml'),
      join(link, 'tests', 'rails', 'h1-write-scope.test.mjs'),
      join(root, '.workflow', 'src', 'rails', 'core.mjs'),
    ]) {
      assert.equal(decide({ action: claude('Edit', { file_path: p }), ctx: ctx(root, s) }).decision, 'deny', p);
    }
  });
});

test('H1: чтение любых файлов проекта разрешено — план собирается из источников', () => {
  withProject(({ root }) => {
    const s = atNode(root, 'P10S2');
    for (const p of [join(root, 'src', 'app.ts'), join(root, '.workflow', 'tickets', 'ready', 'TASK-001.md')]) {
      assert.equal(decide({ action: claude('Read', { file_path: p }), ctx: ctx(root, s) }).decision, 'allow', p);
    }
  });
});

test('канарейка и роль исполнителя', () => {
  withProject(({ root }) => {
    const s = atNode(root, 'P0S1');
    const denied = decide({ action: claude('Bash', { command: 'echo RAILS_CANARY' }), ctx: ctx(root, s) });
    assert.equal(denied.decision, 'deny');
    assert.match(denied.reason, /RAILS_CANARY/);
    const executor = decide({ action: claude('Bash', { command: 'echo RAILS_CANARY' }), ctx: ctx(root, s, { role: 'executor' }) });
    assert.equal(executor.decision, 'allow');
  });
});
