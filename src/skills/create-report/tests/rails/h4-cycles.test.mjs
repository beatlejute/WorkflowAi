// H4: потолок возврата из гейта полноты «Проблем» (P10G2 → P10S6) — три возврата,
// четвёртый отклонён (отчёты 2026-09-29…30: «проблем нет» при 23 строках ❌ у 12 тикетов
// плана и при записанном дефекте; кейс TC-CREATE-REPORT-006). Прямой ход P10S6 → P10G2
// потолок не расходует.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withProject, atNode, loadSkillRuntime, loadState, SKILL } from './_project.mjs';
import { applyGoto } from '../../../../rails/state.mjs';

const Q_P10S6 = 'Выдели проблемы и аномалии. Проблемы: по каждой заблокированной задаче';
const Q_P10G2 = 'Полнота «Проблем» — каждый тикет problem_tickets из вывода скрипта';

test('H4: гейт полноты «Проблем» — три возврата к выделению проблем, четвёртый отклонён потолком', () => {
  withProject(({ root }) => {
    const { config, graph } = loadSkillRuntime(root, SKILL);
    const state = loadState(root, atNode(root, 'P10G2'));
    for (let i = 1; i <= 3; i += 1) {
      const back = applyGoto(state, graph, config, { node: 'P10S6', quote: Q_P10S6 });
      assert.equal(back.ok, true, `возврат ${i}: ${JSON.stringify(back)}`);
      const forward = applyGoto(state, graph, config, { node: 'P10G2', quote: Q_P10G2 });
      assert.equal(forward.ok, true, `ход вперёд ${i}: ${JSON.stringify(forward)}`);
    }
    const fourth = applyGoto(state, graph, config, { node: 'P10S6', quote: Q_P10S6 });
    assert.equal(fourth.ok, false);
    assert.equal(fourth.code, 'cycle_limit');
    assert.match(fourth.reason, /Полнота «Проблем» не сходится трижды/);
  });
});
