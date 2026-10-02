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

// Узел вопроса стейкхолдеру P6S3 — пауза (pause_nodes): лейблы P6E1 и P6S3 разрешают ответ
// в нём, а без pause_nodes выходной слой отклонял его по положению. ListeningGlass PLAN-002
// (2026-09-30): P5S4 велел «сообщи и остановись», reason циклов — «спроси стейкхолдера», а
// pause_nodes был пуст — законной остановки для вопроса стейкхолдеру в графе не было.
const QUESTION = 'Скрипт get-next-id.js недоступен — продолжить не могу, нужен ответ.\nRAILS: P6S3\n';

test('H6: вопрос стейкхолдеру в узле паузы P6S3 со строкой RAILS: P6S3 — принят, без неё — отказ', () => {
  withProject(({ root }) => {
    assert.deepEqual(answer(root, QUESTION, 'P6S3'), { ok: true, missing: [] });
    const bare = answer(root, 'Скрипт get-next-id.js недоступен — продолжить не могу, нужен ответ.\n', 'P6S3');
    assert.equal(bare.ok, false);
    assert.ok(bare.missing.some((m) => /RAILS/.test(m)), JSON.stringify(bare.missing));
    assert.ok(!bare.missing.some((m) => m.startsWith('position:')), 'P6S3 — узел паузы, положение верное');
  });
});

test('H6: вопрос стейкхолдеру, объявивший план утверждённым, — отказ', () => {
  withProject(({ root }) => {
    for (const tail of ['\nстатус: approved', '\nстатус плана: утверждён', '\nstatus: approved']) {
      const r = answer(root, QUESTION + tail, 'P6S3');
      assert.equal(r.ok, false, tail);
      assert.ok(r.missing.some((m) => m.startsWith('forbidden:')), `${tail}: ${JSON.stringify(r.missing)}`);
    }
  });
});
