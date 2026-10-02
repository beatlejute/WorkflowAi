// H5: потолки циклов. 10 → 10 считает оба возврата к разбиению задач — P10G1 → P10S6 (задача
// не одним действием) и P10G2 → P10S6 (митигация без задачи-получателя); 5 → 10 — возвраты от
// самопроверки к извлечению данных; 5 → 5 — повторы валидации. Выход после потолка — узел
// вопроса стейкхолдеру P6S3, и reason каждого потолка его называет. ListeningGlass PLAN-002
// (2026-09-30): reason циклов велел «спроси стейкхолдера», а pause_nodes был пуст — законной
// остановки для вопроса стейкхолдеру в графе не было. Путь вперёд потолки не расходует, и
// переход после ответа стейкхолдера (P6S3 → P10S2, 6 → 10) потолка не имеет.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withProject, atNode, loadSkillRuntime, loadState, SKILL } from './_project.mjs';
import { applyGoto, readyQuote } from '../../../../rails/state.mjs';

function runtime(root, node) {
  const { config, graph } = loadSkillRuntime(root, SKILL);
  const state = loadState(root, atNode(root, node));
  const go = (to) => applyGoto(state, graph, config, { node: to, quote: readyQuote(graph.node(to)?.label, config.quote_min) });
  const walk = (path) => {
    for (const to of path) {
      const r = go(to);
      assert.equal(r.ok, true, `${state.node} → ${to}: ${JSON.stringify(r)}`);
    }
  };
  return { state, go, walk };
}

const P10S6_TO_P10G1 = ['P10S7', 'P10S11', 'P10S8', 'P10S12', 'P10G1'];
const P10S6_TO_P10G2 = [...P10S6_TO_P10G1, 'P10S9', 'P10G2'];

test('H5: возвраты к разбиению задач от обоих гейтов делят потолок 10 → 10; у гейта митигаций выход — P6S3', () => {
  withProject(({ root }) => {
    const { state, go, walk } = runtime(root, 'P10G1');
    assert.equal(go('P10S6').ok, true, 'возврат 1: P10G1 → P10S6');
    walk(P10S6_TO_P10G2);
    assert.equal(go('P10S6').ok, true, 'возврат 2: P10G2 → P10S6');
    walk(P10S6_TO_P10G2);
    assert.equal(go('P10S6').ok, true, 'возврат 3: P10G2 → P10S6');
    walk(P10S6_TO_P10G2);
    const fourth = go('P10S6');
    assert.equal(fourth.ok, false);
    assert.equal(fourth.code, 'cycle_limit');
    assert.match(fourth.reason, /у гейта митигаций задай вопрос стейкхолдеру в узле P6S3/);
    assert.match(fourth.reason, /у гейта одного действия оставь задачу одним действием/);
    assert.equal(go('P6S3').ok, true, 'ребро «нет, а возврат отклонён потолком цикла» ведёт в узел паузы');
    assert.equal(state.node, 'P6S3');
  });
});

test('H5: 5 → 5 — три повтора валидации, четвёртый отклонён; выход — P6S3', () => {
  withProject(({ root }) => {
    const { go } = runtime(root, 'P5Q1');
    for (let i = 1; i <= 3; i += 1) {
      assert.equal(go('P5S5').ok, true, `повтор ${i}: P5Q1 → P5S5`);
      assert.equal(go('P5Q1').ok, true, `ход вперёд ${i}: P5S5 → P5Q1`);
    }
    const fourth = go('P5S5');
    assert.equal(fourth.ok, false);
    assert.equal(fourth.code, 'cycle_limit');
    assert.match(fourth.reason, /перейди в узел P6S3 и сообщи стейкхолдеру список ошибок валидатора/);
    assert.equal(go('P6S3').ok, true);
  });
});

test('H5: 5 → 10 — три возврата от самопроверки, четвёртый отклонён; выход — P6S3, после ответа — назад к данным', () => {
  withProject(({ root }) => {
    const { go, walk } = runtime(root, 'P5G1');
    const toGate = ['P10S3', 'P10S4', 'P10S5', 'P10S6', ...P10S6_TO_P10G2, 'P10S10', 'P5E1', 'P5S1', 'P5S2', 'P5S6', 'P5S3', 'P5G1'];
    for (let i = 1; i <= 3; i += 1) {
      assert.equal(go('P10S2').ok, true, `возврат ${i}: P5G1 → P10S2`);
      walk(toGate);
    }
    const fourth = go('P10S2');
    assert.equal(fourth.ok, false);
    assert.equal(fourth.code, 'cycle_limit');
    assert.match(fourth.reason, /спроси стейкхолдера в узле P6S3/);
    assert.equal(go('P6S3').ok, true);
    // ответ стейкхолдера возвращает к извлечению данных: 6 → 10 потолка не имеет
    assert.equal(go('P10S2').ok, true, 'P6S3 → P10S2 после потолка 5 → 10');
  });
});
