// H6: финальный ответ — только в терминале P6S2, ровно один блок ---RESULT--- со status
// passed или failed. Чужой статус (default, skipped, blocked) раннер трактует как сбой
// стадии, а второй блок ломает разбор вердикта.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withProject, loadSkillRuntime, loadState, atNode, SKILL } from './_project.mjs';
import { check } from '../../../../rails/output-check.mjs';

const BODY = 'Вердикт ревью: все критерии DoD подтверждены артефактами.\n\n';
const PASSED = `${BODY}---RESULT---\nstatus: passed\nissues: []\n---RESULT---\n`;
const FAILED = `${BODY}---RESULT---\nstatus: failed\nissues:\n  - "Пункт DoD 2 не выполнен: ожидалось X, получено Y"\n---RESULT---\n`;

function verdict(root, text, node = 'P6S2') {
  const { config } = loadSkillRuntime(root, SKILL);
  return check(text, config, loadState(root, atNode(root, node)));
}

test('H6: passed и failed в терминале — приняты', () => {
  withProject(({ root }) => {
    assert.deepEqual(verdict(root, PASSED), { ok: true, missing: [] });
    assert.deepEqual(verdict(root, FAILED), { ok: true, missing: [] });
  });
});

test('H6: ответ без блока или без статуса — отказ', () => {
  withProject(({ root }) => {
    assert.equal(verdict(root, BODY).ok, false);
    assert.equal(verdict(root, `${BODY}---RESULT---\nissues: []\n---RESULT---`).ok, false);
  });
});

test('H6: чужой статус — отказ с пометкой forbidden', () => {
  withProject(({ root }) => {
    for (const status of ['default', 'skipped', 'done', 'blocked', 'completed']) {
      const r = verdict(root, `${BODY}---RESULT---\nstatus: ${status}\n---RESULT---`);
      assert.equal(r.ok, false, status);
      assert.ok(r.missing.some((m) => m.startsWith('forbidden:')) || r.missing.length > 0, status);
    }
  });
});

test('H6: два блока ---RESULT--- в ответе — отказ', () => {
  withProject(({ root }) => {
    const twice = `${PASSED}\nи ещё раз:\n${PASSED}`;
    const r = verdict(root, twice);
    assert.equal(r.ok, false);
    assert.ok(r.missing.some((m) => m.startsWith('forbidden:')), JSON.stringify(r.missing));
  });
});

test('H6: финальный ответ не в терминале — отказ по положению', () => {
  withProject(({ root }) => {
    const r = verdict(root, PASSED, 'P4S2');
    assert.equal(r.ok, false);
    assert.ok(r.missing.some((m) => m.startsWith('position:')), JSON.stringify(r.missing));
  });
});
