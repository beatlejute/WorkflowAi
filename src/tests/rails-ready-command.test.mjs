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
  test('короткий лейбл — целиком, длинный — до 60 символов по границе фразы', () => {
    assert.equal(readyQuote('П1 ШАГ: прочитать тикет и записать план работ'), 'П1 ШАГ: прочитать тикет и записать план работ');
    const long = 'П2 ПРАВИЛО: отчёт кладётся по пути из тикета, а не в каталог reports, и только после валидации';
    const q = readyQuote(long);
    assert.ok(q.length <= 60, q);
    assert.ok(long.startsWith(q), q);
    // Инцидент 2026-09-30: цитата «…тикета, а не» кончалась висящим словом, и модель дописывала
    // фразу своими словами. Граница фразы в пределах 60 символов важнее последнего пробела.
    assert.equal(q, 'П2 ПРАВИЛО: отчёт кладётся по пути из тикета', `обрезка по границе фразы: «${q}»`);
  });

  // Лейблы execute-task из журнала отказов PulseProxy 2026-09-29…30 (canon_quote кластера
  // quote-denials-label-phrasing): прежняя готовая цитата кончалась «…с более чем 5» и
  // «…тикета, а не», показ лейбла — «…а не типо».
  test('лейбл с фразами длиннее 60 символов — цитата до конца последней фразы, не висящее слово', () => {
    const p2s2 = 'П2 ШАГ: Ленивая загрузка справочников — задача с более чем 5 шагами DoD читает справочник по месту';
    assert.equal(readyQuote(p2s2), 'П2 ШАГ: Ленивая загрузка справочников');
    const p3r1 = 'П3 ПРАВИЛО: Подход определяется содержимым тикета, а не типом. Тикет требует изменения кода';
    assert.equal(readyQuote(p3r1), 'П3 ПРАВИЛО: Подход определяется содержимым тикета');
    // фраза короче quote_min не годится — берётся следующая граница
    assert.equal(readyQuote('П0 ВЫБОР: тикет, найденный в in-progress/, и описание с DoD прочитаны полностью и до конца?'), 'П0 ВЫБОР: тикет, найденный в in-progress/');
    // «т. е.» — не конец фразы
    assert.equal(readyQuote('П1 ШАГ: сверить план с DoD тикета, т. е. каждый пункт с проверкой и её итогом'), 'П1 ШАГ: сверить план с DoD тикета');
    // границы фразы в 60 символах нет — запасной вариант, последний пробел
    const noPhrase = 'П0 ВЫБОР: Тикет найден в in-progress/ и его описание с DoD прочитаны полностью';
    const q = readyQuote(noPhrase);
    assert.equal(noPhrase[q.length], ' ', `обрезка по слову: «${q}»`);
    for (const label of [p2s2, p3r1, noPhrase]) {
      const r = readyQuote(label);
      assert.ok(normalizeLabel(r).length >= 25 && normalizeLabel(label).includes(normalizeLabel(r)), r);
    }
  });

  test('describeTransitions: лейбл строки — та же цитата, что в команде, без оборванного слова', () => {
    const graph = {
      node: (id) => ({ P1S1: { id: 'P1S1', label: 'П1 ШАГ: вход' }, P3R1: { id: 'P3R1', label: 'П3 ПРАВИЛО: Подход определяется содержимым тикета, а не типом. Тикет требует изменения кода' } })[id],
      outgoing: (id) => (id === 'P1S1' ? [{ to: 'P3R1', label: null }] : []),
    };
    const [line] = describeTransitions({ node: 'P1S1' }, graph, { quote_min: 25 });
    assert.equal(line, "P3R1: П3 ПРАВИЛО: Подход определяется содержимым тикета → node .workflow/src/rails/cli.mjs goto P3R1 --quote 'П3 ПРАВИЛО: Подход определяется содержимым тикета'");
    assert.doesNotMatch(line, /типо(?!м)/, 'прежний показ slice(0, 60) обрывал «типом» на «типо»');
  });

  // Ревью 2026-10-01: после деления по апострофу цитата — кусок из середины лейбла, и строка
  // теряла тип и этап узла («B: — the real chunk…», «t touch — …»).
  test('describeTransitions: цитата не с начала лейбла — строкой идёт начало лейбла, команда с той же цитатой', () => {
    const labels = {
      P1S1: "П1 ШАГ: 'x' — the real chunk of the label that is long enough to be quoted here ok",
      P2R1: "П2 ПРАВИЛО: Don't touch — anything outside of the work area, it is forbidden by rules",
    };
    const graph = {
      node: (id) => (labels[id] ? { id, label: labels[id] } : { id, label: 'П0 ШАГ: вход' }),
      outgoing: (id) => (id === 'P0S1' ? Object.keys(labels).map((to) => ({ to, label: null })) : []),
    };
    const [a, b] = describeTransitions({ node: 'P0S1' }, graph, { quote_min: 25 });
    assert.ok(a.startsWith("P1S1: П1 ШАГ: 'x' — the real chunk"), a);
    assert.ok(a.endsWith(`--quote '${readyQuote(labels.P1S1)}'`), a);
    assert.ok(b.startsWith("P2R1: П2 ПРАВИЛО: Don't touch —"), b);
    assert.ok(b.endsWith("--quote 't touch — anything outside of the work area'"), b);
  });

  // Ревью 2026-10-01: «слово короче трёх букв» пропускало «т.д» (три символа с точкой), и
  // цитата кончалась «…и т.д»; запасная обрезка по пробелу кончалась «…, т. е.».
  test('readyQuote: сокращения «т.д.», «т. е.» не кончают цитату', () => {
    assert.equal(readyQuote('П3 ШАГ: Проверь все файлы и т.д. и тому подобное прочее ещё больше слов тут'), 'П3 ШАГ: Проверь все файлы и т.д. и тому подобное прочее ещё');
    const tp = 'П3 ШАГ: сверь всё и т. п. дальше по тексту идут ещё слова без границы фразы';
    const qtp = readyQuote(tp);
    assert.ok(qtp.includes('и т. п. дальше') && tp[qtp.length] === ' ', `«т. п.» внутри — не граница: «${qtp}»`);
    const q = readyQuote('П4 ШАГ: Сделай это быстро аккуратно и затем то же самое т. е. повтори всё ещё раз снова');
    assert.equal(q, 'П4 ШАГ: Сделай это быстро аккуратно и затем то же самое');
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
