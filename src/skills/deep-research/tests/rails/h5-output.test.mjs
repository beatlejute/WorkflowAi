// H5: финальный ответ — только в терминале P9S1: ответ и остановка — один узел (прогон
// 2026-09-25: отчёт на шаге перед прежним узлом остановки отклонён по положению). Суррогат
// «требует верификации» вне кавычек отклоняется (прогон 2026-09-21, TC-DEEP-RESEARCH-001,
// claude-haiku trial 1: суррогат в Executive Summary при отметке self-check «Нет суррогатов» —
// узел P0R5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withProject, loadSkillRuntime, loadState, atNode, SKILL } from './_project.mjs';
import { check } from '../../../../rails/output-check.mjs';

const REPORT = [
  '# Форматы Manifest V3',
  '',
  '## Executive Summary',
  'Расширение объявляется файлом manifest.json [Источник: Chrome for Developers, https://developer.chrome.com/docs/extensions/reference/manifest, 2026-09-21] [HIGH].',
  'Полный список форматов ресурсов [данные не найдены].',
].join('\n');

function verdict(root, text, node = 'P9S1') {
  const { config } = loadSkillRuntime(root, SKILL);
  return check(text, config, loadState(root, atNode(root, node)));
}

test('H5: отчёт с маркерами пробелов в терминале P9S1 — принят', () => {
  withProject(({ root }) => {
    assert.deepEqual(verdict(root, REPORT), { ok: true, missing: [] });
  });
});

test('H5: суррогат «требует верификации» как пометка факта — отказ', () => {
  withProject(({ root }) => {
    for (const bad of [
      'Полный официальный список форматов требует верификации через документацию.',
      'Доля рынка 12% (требует дополнительной верификации).',
      'Цифра ТРЕБУЕТ ВЕРИФИКАЦИИ.',
    ]) {
      assert.equal(verdict(root, `${REPORT}\n${bad}`).ok, false, bad);
    }
  });
});

test('H5: суррогат в кавычках — цитата правила в self-check — принят', () => {
  withProject(({ root }) => {
    for (const quoted of [
      '- [x] Нет суррогатов вроде «требует верификации»',
      '- [x] Нет пометок "требует верификации" без URL',
    ]) {
      assert.deepEqual(verdict(root, `${REPORT}\n${quoted}`), { ok: true, missing: [] }, quoted);
    }
  });
});

test('H5: узел выдачи результата — он же терминал: из P9E1 ответ отклонён, в графе после P9S1 узлов нет', () => {
  withProject(({ root }) => {
    const { graph } = loadSkillRuntime(root, SKILL);
    assert.equal(verdict(root, REPORT, 'P9E1').ok, false);
    assert.deepEqual(graph.outgoing('P9S1'), []);
  });
});

test('H5: отчёт из середины графа (P3S2) — отказ по положению', () => {
  withProject(({ root }) => {
    const r = verdict(root, REPORT, 'P3S2');
    assert.equal(r.ok, false);
    assert.ok(r.missing.some((m) => /position:/.test(m)), JSON.stringify(r.missing));
  });
});
