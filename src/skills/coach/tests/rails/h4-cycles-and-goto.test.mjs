// H4: переход только по ребру и с цитатой лейбла; потолок цикла «тест → правка» (5→4, max 3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withCoachProject, loadSkillRuntime, loadState, atNode } from './_project.mjs';
import { applyGoto, saveState } from '../../../../rails/state.mjs';

const QUOTE_P4E1 = 'Правка файлов скила. Edit и Write разрешены только на этом этапе';

test('goto: переход по ребру с цитатой лейбла ≥ 25 символов — принят', () => {
  withCoachProject(({ root }) => {
    const { config, graph } = loadSkillRuntime(root, 'coach');
    const state = loadState(root, atNode(root, 'P5Q1'));
    const r = applyGoto(state, graph, config, { node: 'P4E1', quote: QUOTE_P4E1 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(state.node, 'P4E1');
  });
});

test('goto: короткая цитата, пересказ и переход без ребра — отказ с перечнем допустимых', () => {
  withCoachProject(({ root }) => {
    const { config, graph } = loadSkillRuntime(root, 'coach');
    const state = loadState(root, atNode(root, 'P5Q1'));
    assert.equal(applyGoto(state, graph, config, { node: 'P4E1', quote: 'Правка файлов' }).ok, false, 'короткая');
    assert.equal(applyGoto(state, graph, config, { node: 'P4E1', quote: 'теперь я иду править файлы скила как обычно' }).ok, false, 'пересказ');
    const noEdge = applyGoto(state, graph, config, { node: 'P8S2', quote: 'Остановиться. Коуч не делает ничего сверх этого' });
    assert.equal(noEdge.ok, false, 'нет ребра P5Q1 -> P8S2');
    assert.ok(Array.isArray(noEdge.allowed) && noEdge.allowed.some((a) => a.id === 'P4E1' || a === 'P4E1'), JSON.stringify(noEdge));
    assert.equal(state.node, 'P5Q1');
  });
});

test('H4: цикл П5 -> П4 — три возврата приняты, четвёртый отклонён с выходом к человеку', () => {
  withCoachProject(({ root }) => {
    const { config, graph } = loadSkillRuntime(root, 'coach');
    const state = loadState(root, atNode(root, 'P5Q1'));
    for (let i = 1; i <= 3; i += 1) {
      const r = applyGoto(state, graph, config, { node: 'P4E1', quote: QUOTE_P4E1 });
      assert.equal(r.ok, true, `возврат ${i}: ${JSON.stringify(r)}`);
      state.node = 'P5Q1';
      saveState(root, state);
    }
    const fourth = applyGoto(state, graph, config, { node: 'P4E1', quote: QUOTE_P4E1 });
    assert.equal(fourth.ok, false);
    assert.match(String(fourth.reason), /человек/);
  });
});
