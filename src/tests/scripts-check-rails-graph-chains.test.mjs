#!/usr/bin/env node

/**
 * scripts-check-rails-graph-chains.test.mjs — предупреждение check-rails-graph.js о цепочке
 * узлов ПРАВИЛО одного этапа длиннее трёх.
 *
 * Анализ прогонов 2026-09-30 (PulseProxy PLAN-020, ListeningGlass PLAN-001): у execute-task
 * цепочки P0R1–P0R9 и P3R1–P3R8 дают 27 переходов до первой правки, а критерий коуча
 * «R-узлов 3–7» ничем не проверялся. Это предупреждение, не ошибка: status остаётся ok.
 *
 * Фикстуры — во временных каталогах.
 *
 * Запуск:
 *   node --test --import ./src/tests/_rails-home.mjs src/tests/scripts-check-rails-graph-chains.test.mjs
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { cpSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { ruleChains, skillsFromArgs, MAX_RULE_CHAIN } from '../scripts/check-rails-graph.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHECK_GRAPH = join(resolve(__dirname, '../..'), 'src', 'scripts', 'check-rails-graph.js');

function fakeGraph(edges) {
  return { outgoing: (id) => edges.filter(([from]) => from === id).map(([, to]) => ({ to, label: null })) };
}

test('ruleChains: больше трёх R-узлов этапа подряд — цепочка; три — нет', () => {
  assert.equal(MAX_RULE_CHAIN, 3);
  const four = fakeGraph([['P0E1', 'P0R1'], ['P0R1', 'P0R2'], ['P0R2', 'P0R3'], ['P0R3', 'P0R4'], ['P0R4', 'P0S1']]);
  assert.deepEqual(ruleChains(four, 'P0E1'), [{ stage: 0, ids: ['P0R1', 'P0R2', 'P0R3', 'P0R4'] }]);
  const three = fakeGraph([['P0E1', 'P0R1'], ['P0R1', 'P0R2'], ['P0R2', 'P0R3'], ['P0R3', 'P0S1']]);
  assert.deepEqual(ruleChains(three, 'P0E1'), []);
});

test('ruleChains: шаг между правилами и правила разных этапов цепочку рвут; ветвление — самый длинный путь', () => {
  const broken = fakeGraph([['P0E1', 'P0R1'], ['P0R1', 'P0R2'], ['P0R2', 'P0S1'], ['P0S1', 'P0R3'], ['P0R3', 'P0R4'], ['P0R4', 'P1E1'], ['P1E1', 'P1R1'], ['P1R1', 'P1R2']]);
  assert.deepEqual(ruleChains(broken, 'P0E1'), []);
  const stages = fakeGraph([['P0E1', 'P0R1'], ['P0R1', 'P0R2'], ['P0R2', 'P1R1'], ['P1R1', 'P1R2']]);
  assert.deepEqual(ruleChains(stages, 'P0E1'), [], 'P0R2 → P1R1 — другой этап');
  const branch = fakeGraph([['P2E1', 'P2R1'], ['P2R1', 'P2R2'], ['P2R1', 'P2R5'], ['P2R2', 'P2R3'], ['P2R3', 'P2R4'], ['P2R5', 'P2S1'], ['P2R4', 'P2R1']]);
  assert.deepEqual(ruleChains(branch, 'P2E1'), [{ stage: 2, ids: ['P2R1', 'P2R2', 'P2R3', 'P2R4'] }], 'петля не зацикливает обход');
  // недостижимые из entry узлы не считаются (это ошибка orphan самого check)
  const orphan = fakeGraph([['P0E1', 'P0S1'], ['P0R1', 'P0R2'], ['P0R2', 'P0R3'], ['P0R3', 'P0R4']]);
  assert.deepEqual(ruleChains(orphan, 'P0E1'), []);
});

// --- прогон скрипта на проекте во временном каталоге --------------------------------

function makeSkill(rules) {
  const base = mkdtempSync(join(tmpdir(), 'rails-chains-'));
  const root = join(base, 'root');
  const skillDir = join(root, '.workflow', 'src', 'skills', 'chains');
  mkdirSync(skillDir, { recursive: true });
  const names = ['Первое', 'Второе', 'Третье', 'Четвёртое', 'Пятое'];
  const ids = names.slice(0, rules).map((_, i) => `P0R${i + 1}`);
  const lines = [
    '    P0E1["П0 ВХОД: Начало этапа проверки цепочек правил графа скила"]',
    ...ids.map((id, i) => `    ${id}["П0 ПРАВИЛО: ${names[i]} правило этапа проверки цепочек графа"]`),
    '    P0S1["П0 ШАГ: Завершить проверку цепочек правил графа и выйти"]',
  ];
  const chain = ['P0E1', ...ids, 'P0S1'];
  for (let i = 0; i + 1 < chain.length; i += 1) lines.push(`    ${chain[i]} --> ${chain[i + 1]}`);
  writeFileSync(join(skillDir, 'SKILL.md'), `# Скил chains\n\n\`\`\`mermaid\ngraph TD\n${lines.join('\n')}\n\`\`\`\n`, 'utf8');
  writeFileSync(join(skillDir, 'rails.yaml'), [
    'version: 1',
    'skill: chains',
    'entry: P0E1',
    'terminal: [P0S1]',
    'pause_nodes: []',
    'quote_min: 25',
    'output:',
    '  final_requires: []',
    '  max_stop_blocks: 2',
    '',
  ].join('\n'), 'utf8');
  return { base, root };
}

function runScript(args, cwd) {
  try {
    return execFileSync(process.execPath, [CHECK_GRAPH, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return (err.stdout || '') + (err.stderr || '');
  }
}

test('check-rails-graph.js: четыре правила подряд — предупреждение rule-chain, status ok', () => {
  const { base, root } = makeSkill(4);
  try {
    for (const args of [['--skill', 'chains'], ['--all']]) {
      const out = runScript(args, root);
      assert.match(out, /Скил "chains":\n {2}OK/, out);
      assert.match(out, /\[warn:rule-chain\] Скил "chains", этап 0: 4 узла ПРАВИЛО подряд \(P0R1 → P0R2 → P0R3 → P0R4\) — больше 3/, out);
      assert.match(out, /status: ok/, 'предупреждение не ошибка: раннер не должен валить стадию');
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('check-rails-graph.js: три правила подряд — без предупреждения', () => {
  const { base, root } = makeSkill(3);
  try {
    const out = runScript(['--skill', 'chains'], root);
    assert.match(out, /status: ok/, out);
    assert.doesNotMatch(out, /rule-chain/, out);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// Ревью 2026-10-01: при `--all --skill x` cli.mjs check проверял все скилы (сначала --all), а
// предупреждения печатались только для x; текст «без ветвления» не совпадал с алгоритмом (берётся
// самый длинный путь, ветвления в нём допускаются).
test('check-rails-graph.js: скилы — тем же порядком, что cli check; текст предупреждения — по алгоритму', () => {
  const { base, root } = makeSkill(4);
  try {
    const skills = join(root, '.workflow', 'src', 'skills');
    cpSync(join(skills, 'chains'), join(skills, 'chains2'), { recursive: true });
    mkdirSync(join(skills, 'no-rails'), { recursive: true });
    assert.deepEqual(skillsFromArgs(root, ['--all', '--skill', 'chains']).sort(), ['chains', 'chains2']);
    assert.deepEqual(skillsFromArgs(root, ['--skill', 'chains2']), ['chains2']);
    assert.deepEqual(skillsFromArgs(root, ['--skill', '--all']).sort(), ['chains', 'chains2'], '--skill без значения — булев, --all');
    assert.deepEqual(skillsFromArgs(root, []), []);
    const out = runScript(['--all', '--skill', 'chains'], root);
    assert.match(out, /\[warn:rule-chain\] Скил "chains", этап 0/, out);
    assert.match(out, /\[warn:rule-chain\] Скил "chains2", этап 0/, out);
    assert.match(out, /самый длинный путь по правилам этапа, ветвления в нём возможны/, out);
    assert.doesNotMatch(out, /без ветвления/, out);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
