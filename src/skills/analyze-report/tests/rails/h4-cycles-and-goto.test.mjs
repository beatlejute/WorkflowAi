// H4: переход только по ребру с цитатой лейбла; потолки возвратов из гейтов
// (самопроверка П5, валидация веток П10 и П20 — по 3); маршрут отчёт → валидация ветки.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withProject, loadSkillRuntime, loadState, atNode, SKILL } from './_project.mjs';
import { applyGoto } from '../../../../rails/state.mjs';

const Q_P10S3 = 'Рассчитай метрики прогресса — загрузи `algorithms/progress-assessment.md`';
const Q_P20S3 = 'Оцени результат vs цели — загрузи `knowledge/analysis-frameworks.md`';
const Q_P5S1 = 'Проверь что секция результата выполнения заполнена';

function ceiling(root, gate, target, quote, back) {
  const { config, graph } = loadSkillRuntime(root, SKILL);
  const state = loadState(root, atNode(root, gate));
  for (let i = 1; i <= 3; i += 1) {
    const r = applyGoto(state, graph, config, { node: target, quote });
    assert.equal(r.ok, true, `возврат ${i}: ${JSON.stringify(r)}`);
    state.node = back;
  }
  return applyGoto(state, graph, config, { node: target, quote });
}

test('H4: валидация PROGRESS — три возврата к метрикам, четвёртый отклонён потолком', () => {
  withProject(({ root }) => {
    const fourth = ceiling(root, 'P10G1', 'P10S3', Q_P10S3, 'P10G1');
    assert.equal(fourth.ok, false);
    assert.equal(fourth.code, 'cycle_limit');
    assert.match(fourth.reason, /has_gaps/);
  });
});

test('H4: валидация RETROSPECTIVE — потолок 3', () => {
  withProject(({ root }) => {
    const fourth = ceiling(root, 'P20G1', 'P20S3', Q_P20S3, 'P20G1');
    assert.equal(fourth.code, 'cycle_limit');
  });
});

test('H4: самопроверка П5 — потолок 3', () => {
  withProject(({ root }) => {
    const fourth = ceiling(root, 'P5G1', 'P5S1', Q_P5S1, 'P5G1');
    assert.equal(fourth.code, 'cycle_limit');
  });
});

test('goto: из отчёта ядра (P3Q1) — только в валидацию ветки, мимо неё в самопроверку нельзя', () => {
  withProject(({ root }) => {
    const { config, graph } = loadSkillRuntime(root, SKILL);
    const state = loadState(root, atNode(root, 'P3Q1'));
    const skip = applyGoto(state, graph, config, { node: 'P5E1', quote: 'Self-check перед завершением тикета' });
    assert.equal(skip.ok, false);
    assert.equal(skip.code, 'no-edge');
    const ok = applyGoto(state, graph, config, { node: 'P10G1', quote: 'Валидация PROGRESS. Все метрики рассчитаны на основе реальных данных' });
    assert.equal(ok.ok, true, JSON.stringify(ok));
  });
});

test('goto: пересказ вместо цитаты — отказ с точкой расхождения', () => {
  withProject(({ root }) => {
    const { config, graph } = loadSkillRuntime(root, SKILL);
    const state = loadState(root, atNode(root, 'P6Q1'));
    const r = applyGoto(state, graph, config, { node: 'P6S1', quote: 'completed — выведу блок результата со статусом' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'quote-mismatch');
    assert.equal(state.node, 'P6Q1');
  });
});
