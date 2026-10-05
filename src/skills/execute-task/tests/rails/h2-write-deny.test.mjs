// H2: исполнитель не создаёт тикеты и планы и не правит тикеты вне in-progress/
// (инциденты PulseProxy CHG-051, CHG-047, COACH-SYNTH-1); собственные гарды и ядро рельс
// не правятся (принцип 17); свой тикет в in-progress/ и файлы проекта — пишутся.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
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

test('H2: создание плана в .workflow/plans/current/ и archive/ — отказ, в том числе shell-редиректом', () => {
  withProject(({ root }) => {
    const s = atNode(root, 'P3S1');
    for (const dir of ['current', 'archive']) {
      const plan = join(root, '.workflow', 'plans', dir, 'PLAN-002.md');
      assert.equal(decide({ action: claude('Write', { file_path: plan }), ctx: ctx(root, s) }).decision, 'deny', dir);
    }
    assert.equal(
      decide({ action: claude('Bash', { command: 'echo "# PLAN-002" > .workflow/plans/current/PLAN-002.md' }), ctx: ctx(root, s) }).decision,
      'deny',
    );
  });
});

// 2026-09-28: административный тикет «обновить шаблон плана» встал в blocked/ — запрет всего
// .workflow/plans/** не давал исполнителю тронуть свой единственный результат.
test('H2: шаблон плана в .workflow/plans/templates/ — пишется на этапе 3', () => {
  withProject(({ root }) => {
    const s = atNode(root, 'P3S1');
    const template = join(root, '.workflow', 'plans', 'templates', 'TMPL-001.md');
    assert.equal(decide({ action: claude('Edit', { file_path: template }), ctx: ctx(root, s) }).decision, 'allow');
  });
});

// 2026-09-27: исполнитель тикета тестирования правил SKILL.md и rails.yaml другого скила через
// .workflow/src/skills/ — в общей копии скилов всех проектов; рельсы не отклонили.
// 2026-10-05: write-policy — чужие скилы закрыты всем, кроме коуча: и ссылка на
// канон, и независимая локальная копия (второй раунд ревью: исключение сужено).
test('H2: чужой скил — отказ и канонической ссылкой, и локальной копией', () => {
  withProject(({ root, link }) => {
    const s = atNode(root, 'P3S1');
    const independent = join(root, '.workflow', 'src', 'skills', 'other-skill');
    mkdirSync(independent, { recursive: true });
    for (const name of ['SKILL.md', 'rails.yaml']) {
      // link — junction на канон скила: для execute-task это чужой файл канона.
      assert.equal(decide({ action: claude('Edit', { file_path: join(link, name) }), ctx: ctx(root, s) }).decision, 'deny', `канон ${name}`);
      assert.equal(decide({ action: claude('Edit', { file_path: join(independent, name) }), ctx: ctx(root, s) }).decision, 'deny', `независимая копия ${name}`);
    }
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
