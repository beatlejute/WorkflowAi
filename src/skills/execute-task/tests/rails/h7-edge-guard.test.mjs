// H7: страж ребра P0Q1 → P7E1. Ответ «нет» («тикет не найден») агент даёт сам.
// Инцидент 2026-09-27: тикет лежал в in-progress/ с готовыми тестами, claude-haiku ответил
// «нет», ушёл к выводу и выдал status blocked «Result пуст» — тикет ушёл в blocked/.
// Страж привязан к тикету запуска ({ticket} — ticket_id стадии): чужой тикет в in-progress/
// ветку не закрывает, без тикета запуска страж не действует.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync, writeFileSync } from 'node:fs';
import { withProject, atNode, loadState, loadSkillRuntime, ticket, SKILL } from './_project.mjs';
import { applyGoto } from '../../../../rails/state.mjs';

const P7E1_QUOTE = 'Вывести структурированный результат пайплайну';
const P1E1_QUOTE = 'Проверить существующий прогресс. ОБЯЗАТЕЛЬНО перед';

function gotoFrom(root, node, target, quote, runTicket) {
  const s = atNode(root, node);
  const state = loadState(root, s);
  const { config, graph } = loadSkillRuntime(root, SKILL);
  return { result: applyGoto(state, graph, config, { node: target, quote, root, ticket: runTicket }), state };
}

test('H7: тикет запуска в in-progress/ есть — «нет» на P0Q1 (к выводу) отклонён', () => {
  withProject(({ root }) => {
    const { result, state } = gotoFrom(root, 'P0Q1', 'P7E1', P7E1_QUOTE, 'TASK-001');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'edge_guard');
    assert.match(result.reason, /ветка «тикет не найден» закрыта/);
    assert.match(result.reason, /in-progress\/TASK-001\.md/);
    assert.equal(state.node, 'P0Q1');
  });
});

test('H7: тикет запуска в in-progress/ есть — «да» на P0Q1 проходит', () => {
  withProject(({ root }) => {
    const { result } = gotoFrom(root, 'P0Q1', 'P1E1', P1E1_QUOTE, 'TASK-001');
    assert.equal(result.ok, true);
  });
});

test('H7: тикета запуска нет, в in-progress/ лежит чужой — «нет» на P0Q1 проходит', () => {
  withProject(({ root }) => {
    unlinkSync(ticket(root, 'in-progress'));
    writeFileSync(ticket(root, 'in-progress', 'TASK-009.md'), '# TASK-009\n', 'utf8');
    const { result } = gotoFrom(root, 'P0Q1', 'P7E1', P7E1_QUOTE, 'TASK-001');
    assert.equal(result.ok, true);
  });
});

test('H7: без тикета запуска (ручной старт) страж не действует', () => {
  withProject(({ root }) => {
    const { result } = gotoFrom(root, 'P0Q1', 'P7E1', P7E1_QUOTE, undefined);
    assert.equal(result.ok, true);
  });
});
