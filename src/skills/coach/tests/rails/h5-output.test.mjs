// H5: финальный ответ только в терминале (P8S2) с обязательными строками; в узле вопроса
// стейкхолдеру (pause_nodes) — только маркер; в остальных узлах — отказ по положению.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withCoachProject, loadSkillRuntime, loadState, atNode } from './_project.mjs';
import { check } from '../../../../rails/output-check.mjs';

const REPORT = 'RAILS: P8S2 «Остановиться. Коуч не делает ничего сверх этого»\nverdict=ready_for_user_review\nФайлы: SKILL.md, tests/cases/TC-COACH-005-rails-anatomy.yaml';

test('H5: отчёт в P8S2 с маркером, verdict и списком файлов — принят', () => {
  withCoachProject(({ root }) => {
    const { config } = loadSkillRuntime(root, 'coach');
    const state = loadState(root, atNode(root, 'P8S2'));
    assert.deepEqual(check(REPORT, config, state), { ok: true, missing: [] });
  });
});

test('H5: отчёт без verdict — отказ, missing называет пропущенное требование', () => {
  withCoachProject(({ root }) => {
    const { config } = loadSkillRuntime(root, 'coach');
    const state = loadState(root, atNode(root, 'P8S2'));
    const r = check(REPORT.replace('verdict=ready_for_user_review\n', ''), config, state);
    assert.equal(r.ok, false);
    assert.ok(r.missing.some((m) => /verdict/.test(m)));
  });
});

test('H5: финальный ответ из середины графа (P4S2) — отказ по положению', () => {
  withCoachProject(({ root }) => {
    const { config } = loadSkillRuntime(root, 'coach');
    const state = loadState(root, atNode(root, 'P4S2'));
    const r = check(REPORT, config, state);
    assert.equal(r.ok, false);
    assert.ok(r.missing.some((m) => /position:/.test(m)));
  });
});

test('H5: вопрос стейкхолдеру в pause-узле P3S5 — нужен только маркер, verdict не требуется', () => {
  withCoachProject(({ root }) => {
    const { config } = loadSkillRuntime(root, 'coach');
    const state = loadState(root, atNode(root, 'P3S5'));
    assert.equal(check('RAILS: P3S5 «Покажи стейкхолдеру очищенный черновик»\nПравки готовы, runner ~$0.4 — запускаем?', config, state).ok, true);
    assert.equal(check('Правки готовы — запускаем?', config, state).ok, false, 'без маркера');
  });
});
