#!/usr/bin/env node
/**
 * Готовая команда перехода (state.readyQuote / gotoCommand / describeTransitions).
 *
 * Прогон deep-research 2026-09-25: haiku после отказа рельс писала «пройду граф
 * правильно» и снова не делала ни одного перехода — отказ и вывод CLI называли
 * допустимые узлы, но не команду. Теперь каждый переход идёт с командой, которую
 * `goto` примет как есть; здесь это проверяется и на всех графах скилов канона.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readyQuote, gotoCommand, describeTransitions, applyGoto, normalizeLabel } from '../rails/state.mjs';
import { loadRailsConfig } from '../rails/rails-config.mjs';
import { loadSkillGraph } from '../rails/graph.mjs';

const SKILLS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');
const SINGLE_QUOTES = /['‘-‛]/;

describe('readyQuote', () => {
  test('короткий лейбл — целиком, длинный — до 60 символов по границе слова', () => {
    assert.equal(readyQuote('П1 ШАГ: прочитать тикет и записать план работ'), 'П1 ШАГ: прочитать тикет и записать план работ');
    const long = 'П2 ПРАВИЛО: отчёт кладётся по пути из тикета, а не в каталог reports, и только после валидации';
    const q = readyQuote(long);
    assert.ok(q.length <= 60, q);
    assert.ok(long.startsWith(q), q);
    assert.ok(long[q.length] === ' ', `обрезка по границе слова: «${q}»`);
  });

  test('без одиночных кавычек: и прямой апостроф, и типографские закрыли бы \'…\' в PowerShell', () => {
    const label = "П3 ШАГ: it's ok — запустить проверку ссылок отчёта и собрать список ‘битых’ адресов";
    const q = readyQuote(label);
    assert.ok(q, 'цитата нашлась');
    assert.equal(SINGLE_QUOTES.test(q), false, q);
    assert.ok(normalizeLabel(label).includes(normalizeLabel(q)));
  });

  test('разметка и пиктограммы снимаются так же, как при сверке цитаты', () => {
    const label = '⛔ П0 ПРАВИЛО: **исследование** только через `perplexity-research.js`, без веб-поиска';
    const q = readyQuote(label);
    assert.equal(/[`*⛔]/.test(q), false, q);
    assert.ok(normalizeLabel(label).includes(normalizeLabel(q)));
  });

  test('ни один кусок не дотягивает до quote_min — null, команда с местом под цитату', () => {
    assert.equal(readyQuote("короткий 'лейбл'", 25), null);
    assert.equal(gotoCommand('P1S1', "короткий 'лейбл'"), "node .workflow/src/rails/cli.mjs goto P1S1 --quote '<дословная цитата лейбла P1S1>'");
  });
});

describe('готовые команды на графах скилов канона', () => {
  const skills = fs.readdirSync(SKILLS_DIR).filter((s) => fs.existsSync(path.join(SKILLS_DIR, s, 'rails.yaml')));

  test('скилы на рельсах есть', () => {
    assert.ok(skills.length > 0);
  });

  for (const skill of skills) {
    test(`${skill}: каждый переход — команда с цитатой, которую goto принимает`, () => {
      const dir = path.join(SKILLS_DIR, skill);
      const config = loadRailsConfig(dir);
      const graph = loadSkillGraph(dir, config);
      let edges = 0;
      for (const from of graph._defined.keys()) {
        const lines = describeTransitions({ node: from, skill }, graph, config);
        for (const e of graph.outgoing(from)) {
          edges += 1;
          const line = lines.find((l) => l.startsWith(`${e.to}: `));
          const m = / → node \.workflow\/src\/rails\/cli\.mjs goto (\S+) --quote '([^']*)'$/.exec(line ?? '');
          assert.ok(m, `${from} → ${e.to}: ${line}`);
          assert.equal(m[1], e.to);
          assert.equal(SINGLE_QUOTES.test(m[2]), false, `${e.to}: ${m[2]}`);
          const state = { version: 1, session: 's', skill, node: from, history: [], counters: {}, denials: {}, flags: {} };
          const r = applyGoto(state, graph, config, { node: e.to, quote: m[2] });
          assert.ok(r.ok, `${from} → ${e.to}: ${r.code} ${r.reason}`);
        }
      }
      assert.ok(edges > 0);
    });
  }
});
