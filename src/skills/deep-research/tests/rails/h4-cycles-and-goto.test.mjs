// H4: переход только по ребру с цитатой лейбла; потолки возвратов из гейтов — валидация
// базового чеклиста П3, self-check П5, дополнительная проверка каждой ветки (по 3);
// маршрут отчёт → дополнительная проверка своей ветки → self-check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withProject, loadSkillRuntime, loadState, atNode, SKILL } from './_project.mjs';
import { applyGoto } from '../../../../rails/state.mjs';

function ceiling(root, gate, target, quote) {
  const { config, graph } = loadSkillRuntime(root, SKILL);
  const state = loadState(root, atNode(root, gate));
  for (let i = 1; i <= 3; i += 1) {
    const r = applyGoto(state, graph, config, { node: target, quote });
    assert.equal(r.ok, true, `${gate} возврат ${i}: ${JSON.stringify(r)}`);
    state.node = gate;
  }
  return applyGoto(state, graph, config, { node: target, quote });
}

test('H4: валидация базового чеклиста П3 — три возврата к синтезу, четвёртый отклонён потолком', () => {
  withProject(({ root }) => {
    const fourth = ceiling(root, 'P3G1', 'P3S1', 'Синтез — загрузи `algorithms/synthesis.md`');
    assert.equal(fourth.ok, false);
    assert.equal(fourth.code, 'cycle_limit');
    assert.match(fourth.reason, /Пробелы и ограничения/);
  });
});

test('H4: self-check П5 — потолок 3, выход к человеку', () => {
  withProject(({ root }) => {
    const fourth = ceiling(root, 'P5G1', 'P5S1', 'Проверь что секция Result заполнена');
    assert.equal(fourth.code, 'cycle_limit');
    assert.match(fourth.reason, /НЕ завершён/);
  });
});

test('H4: дополнительная проверка каждой ветки — потолок 3', () => {
  withProject(({ root }) => {
    const branches = [
      ['P10G1', 'P10S2', 'Собери данные о размере рынка'],
      ['P20G1', 'P20S2', 'Составь список конкурентов'],
      ['P30G1', 'P30S3', 'Классифицируй тренды. Mega-trend'],
      ['P40G1', 'P40S3', 'Нормализуй данные — единая методология'],
      ['P50G1', 'P50S2', 'Составь longlist — 1) поиск по категории'],
      ['P60G1', 'P60S3', 'Проведи исследование — 1) сформулируй 3-5 поисковых запросов'],
    ];
    for (const [gate, target, quote] of branches) {
      assert.equal(ceiling(root, gate, target, quote).code, 'cycle_limit', gate);
    }
  });
});

test('goto: из выбора ветки П3 — только в проверку ветки, мимо неё в self-check нельзя', () => {
  withProject(({ root }) => {
    const { config, graph } = loadSkillRuntime(root, SKILL);
    const state = loadState(root, atNode(root, 'P3Q1'));
    const skip = applyGoto(state, graph, config, { node: 'P5E1', quote: 'Self-check перед завершением тикета' });
    assert.equal(skip.ok, false);
    assert.equal(skip.code, 'no-edge');
    const ok = applyGoto(state, graph, config, { node: 'P10G1', quote: 'Дополнительная проверка MARKET — TAM/SAM/SOM корректны' });
    assert.equal(ok.ok, true, JSON.stringify(ok));
  });
});

test('goto: из ветки в результат мимо П3 и self-check нельзя', () => {
  withProject(({ root }) => {
    const { config, graph } = loadSkillRuntime(root, SKILL);
    const state = loadState(root, atNode(root, 'P60S3'));
    const skip = applyGoto(state, graph, config, { node: 'P9E1', quote: 'Результат исследования и остановка' });
    assert.equal(skip.ok, false);
    assert.equal(skip.code, 'no-edge');
  });
});

test('goto: пересказ вместо цитаты — отказ, узел не меняется', () => {
  withProject(({ root }) => {
    const { config, graph } = loadSkillRuntime(root, SKILL);
    const state = loadState(root, atNode(root, 'P5S3'));
    const r = applyGoto(state, graph, config, { node: 'P5S4', quote: 'проверю, что у всех фактов есть ссылки на источники' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'quote-mismatch');
    assert.equal(state.node, 'P5S3');
  });
});
