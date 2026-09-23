// H6: финальный ответ — только в терминале P6S2, с обязательными строками отчёта.
// План создаётся черновиком: объявить его утверждённым от своего имени нельзя —
// approved ставит стейкхолдер (узел P6R1, knowledge/plan-lifecycle.md). Планировщик,
// сообщивший «план утверждён», снимает с человека решение по scope, которое по
// узлу P0R1 принимает только он.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withProject, loadSkillRuntime, loadState, atNode, SKILL } from './_project.mjs';
import { check } from '../../../../rails/output-check.mjs';

const OK = 'RAILS: P6S2\nverdict = draft\nФайлы: .workflow/plans/current/PLAN-002.md\n';

function answer(root, text, node = 'P6S2') {
  const { config } = loadSkillRuntime(root, SKILL);
  return check(text, config, loadState(root, atNode(root, node)));
}

test('H6: отчёт с обязательными строками в терминале — принят', () => {
  withProject(({ root }) => {
    assert.deepEqual(answer(root, OK), { ok: true, missing: [] });
  });
});

test('H6: нет строки узла, вердикта или списка файлов — отказ', () => {
  withProject(({ root }) => {
    assert.equal(answer(root, 'verdict = draft\nФайлы: PLAN-002.md').ok, false);
    assert.equal(answer(root, 'RAILS: P6S2\nФайлы: PLAN-002.md').ok, false);
    assert.equal(answer(root, 'RAILS: P6S2\nverdict = draft').ok, false);
  });
});

test('H6: план, объявленный утверждённым, — отказ', () => {
  withProject(({ root }) => {
    for (const tail of ['\nстатус: approved', '\nстатус плана: утверждён', '\nstatus: approved']) {
      const r = answer(root, OK + tail);
      assert.equal(r.ok, false, tail);
      assert.ok(r.missing.some((m) => m.startsWith('forbidden:')), `${tail}: ${JSON.stringify(r.missing)}`);
    }
  });
});

test('H6: финальный ответ не в терминале — отказ по положению', () => {
  withProject(({ root }) => {
    const r = answer(root, OK, 'P10S6');
    assert.equal(r.ok, false);
    assert.ok(r.missing.some((m) => m.startsWith('position:')), JSON.stringify(r.missing));
  });
});
