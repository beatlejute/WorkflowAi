// H6: финальный ответ — только в терминале P7S2, кончается блоком ---RESULT--- со status
// default или blocked, и без перечислений пунктов DoD в stdout. Инцидент PulseProxy CHG-052:
// дубль-чеклист DoD дал 6 retry и затем blocked (кейс TC-EXECUTE-TASK-002).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withProject, loadSkillRuntime, loadState, atNode, SKILL } from './_project.mjs';
import { check } from '../../../../rails/output-check.mjs';

const SUMMARY = 'выполнено: создан src/utils/slugify.ts, покрыт 7 unit-тестами, дополнена CONFIG.md\n';
const DEFAULT = `${SUMMARY}---RESULT---\nstatus: default\n---RESULT---\n`;
const BLOCKED = `выполнено частично: контекст исчерпан\n---RESULT---\nstatus: blocked\nreason: "призрачное выполнение — секция Result пуста"\n---RESULT---\n`;

function verdict(root, text, node = 'P7S2') {
  const { config } = loadSkillRuntime(root, SKILL);
  return check(text, config, loadState(root, atNode(root, node)));
}

test('H6: одна строка summary плюс блок RESULT со status default или blocked — приняты', () => {
  withProject(({ root }) => {
    assert.deepEqual(verdict(root, DEFAULT), { ok: true, missing: [] });
    assert.deepEqual(verdict(root, BLOCKED), { ok: true, missing: [] });
  });
});

test('H6: ответ без блока ---RESULT--- или без статуса — отказ', () => {
  withProject(({ root }) => {
    assert.equal(verdict(root, SUMMARY).ok, false);
    assert.equal(verdict(root, `${SUMMARY}---RESULT---\nreport: нет\n---RESULT---`).ok, false);
  });
});

test('H6: перечисление пунктов DoD с галочками в stdout — отказ', () => {
  withProject(({ root }) => {
    const withChecklist = `Проверка:\n- [x] Все чекбоксы DoD отмечены\n- [x] Result заполнен\n${DEFAULT}`;
    const r = verdict(root, withChecklist);
    assert.equal(r.ok, false);
    assert.ok(r.missing.some((m) => m.startsWith('forbidden:')), JSON.stringify(r.missing));
  });
});

test('H6: декларация self-check списком из двух и более пунктов — отказ', () => {
  withProject(({ root }) => {
    const declared = `Резюме:\n- Result заполнен\n- Frontmatter не модифицирован\n${DEFAULT}`;
    const r = verdict(root, declared);
    assert.equal(r.ok, false);
    assert.ok(r.missing.some((m) => m.startsWith('forbidden:')), JSON.stringify(r.missing));
  });
});

test('H6: финальный ответ не в терминале — отказ по положению', () => {
  withProject(({ root }) => {
    const r = verdict(root, DEFAULT, 'P3S1');
    assert.equal(r.ok, false);
    assert.ok(r.missing.some((m) => m.startsWith('position:')), JSON.stringify(r.missing));
  });
});
