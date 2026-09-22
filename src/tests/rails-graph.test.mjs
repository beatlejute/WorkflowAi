import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMermaidBlocks, normalizeLabel, loadSkillGraph } from '../rails/graph.mjs';

const FIXTURES = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'rails', 'graph');

function errorCodes(result) {
  return result.errors.map((e) => e.code);
}

// --- parseMermaidBlocks --------------------------------------------------

test('parseMermaidBlocks: узлы, рёбра, инлайн-определение, метка на ребре, многострочный лейбл, комментарий и заголовок игнорируются', () => {
  const md = [
    '# doc',
    '',
    '```mermaid',
    'graph TD',
    '    %% этот комментарий не должен попасть в узлы',
    '    P0E1["Многострочный',
    'лейбл входа"] --> P0R1["П0 ПРАВИЛО: обычный однострочный лейбл длиной более 25 символов"]',
    '    P0R1 -->|"метка перехода"| P0S1["П0 ШАГ: инлайн-определение узла прямо в ребре графа"]',
    '```',
    '',
  ].join('\n');

  const { nodes, edges } = parseMermaidBlocks(md, 'test.md');

  const p0e1 = nodes.find((n) => n.id === 'P0E1' && n.shape === 'rect');
  assert.ok(p0e1, 'P0E1 должен быть определён');
  assert.equal(p0e1.label, 'Многострочный\nлейбл входа');
  assert.equal(p0e1.source, 'test.md');

  const p0s1 = nodes.find((n) => n.id === 'P0S1' && n.shape === 'rect');
  assert.ok(p0s1, 'P0S1 (инлайн-определение в ребре) должен быть найден');

  assert.equal(edges.length, 2);
  assert.deepEqual(
    edges.map((e) => [e.from, e.to, e.label]),
    [
      ['P0E1', 'P0R1', null],
      ['P0R1', 'P0S1', 'метка перехода'],
    ]
  );

  // комментарий не породил узлов/рёбер, заголовок graph TD не попал как statement
  assert.ok(!nodes.some((n) => n.id === 'TD' || n.id === 'graph'));
});

// --- parseMermaidBlocks: не падает на плохом входе (blocker-находка ревью) ---

test('parseMermaidBlocks: висячая стрелка без цели не бросает, даёт parse-error', () => {
  const md = ['```mermaid', 'graph TD', '    P0E1["Достаточно длинный лейбл входа для теста"] -->', '```'].join('\n');
  let result;
  assert.doesNotThrow(() => {
    result = parseMermaidBlocks(md, 'dangling.md');
  });
  assert.equal(result.edges.length, 0);
  assert.ok(result.errors.some((e) => e.code === 'parse-error'));
});

test('parseMermaidBlocks: метка ребра без кавычек (валидный mermaid, не наша грамматика) не бросает', () => {
  const md = ['```mermaid', 'graph TD', '    P0S1 -->|назад| P0E1', '```'].join('\n');
  let result;
  assert.doesNotThrow(() => {
    result = parseMermaidBlocks(md, 'unquoted-label.md');
  });
  assert.ok(result.errors.some((e) => e.code === 'parse-error'));
});

test('parseMermaidBlocks: нелатинский id вместо bad-id не бросает', () => {
  const md = ['```mermaid', 'graph TD', '    P0E1["Достаточно длинный лейбл входа для теста"] --> П0S1', '```'].join('\n');
  let result;
  assert.doesNotThrow(() => {
    result = parseMermaidBlocks(md, 'cyrillic-id.md');
  });
  assert.ok(result.errors.some((e) => e.code === 'parse-error'));
});

// --- parseMermaidBlocks: нераспознанный хвост не теряет уже разобранное (major-находка) ---

test('parseMermaidBlocks: длинная стрелка "--->" не поглощается — ребро не создаётся молча, есть parse-error', () => {
  const md = ['```mermaid', 'graph TD', '    P0S1 ---> P0E1', '```'].join('\n');
  const result = parseMermaidBlocks(md, 'long-arrow.md');
  assert.equal(result.edges.length, 0);
  assert.ok(result.errors.some((e) => e.code === 'parse-error'));
});

test('parseMermaidBlocks: "& X" после валидного ребра — ребро сохранено, хвост даёт parse-error, а не молча теряется', () => {
  const md = ['```mermaid', 'graph TD', '    P0E1 --> P0S1 & P0S2', '```'].join('\n');
  const result = parseMermaidBlocks(md, 'ampersand.md');
  assert.equal(result.edges.length, 1);
  assert.deepEqual([result.edges[0].from, result.edges[0].to], ['P0E1', 'P0S1']);
  assert.ok(result.errors.some((e) => e.code === 'parse-error' && e.text.includes('P0S2')));
});

test('parseMermaidBlocks: несколько ```mermaid``` блоков в одном файле склеиваются', () => {
  const md = [
    '```mermaid',
    'graph TD',
    '    P0E1["П0 ВХОД: первый блок с достаточно длинным лейблом узла"]',
    '```',
    'текст между блоками',
    '```mermaid',
    'graph TD',
    '    P0R1["П0 ПРАВИЛО: второй блок с достаточно длинным лейблом узла"]',
    '    P0E1 --> P0R1',
    '```',
  ].join('\n');

  const { nodes, edges } = parseMermaidBlocks(md, 'multi.md');
  assert.equal(nodes.filter((n) => n.shape).length, 2);
  assert.equal(edges.length, 1);
});

test('parseMermaidBlocks: хвост на строке открывающего забора (```mermaid с пробелом/атрибутами) не пропускает блок', () => {
  const md = ['```mermaid  ', 'graph TD', '    P0E1["Достаточно длинный лейбл узла для этого теста"]', '```'].join('\n');
  const { nodes } = parseMermaidBlocks(md, 'fence-tail.md');
  assert.ok(nodes.some((n) => n.id === 'P0E1' && n.shape === 'rect'));
});

test('parseMermaidBlocks: инлайн-упоминание ```mermaid``` в прозе (не с начала строки) не глотает следующий настоящий блок', () => {
  const md = [
    'В документации блоки ```mermaid``` inline.',
    '```mermaid',
    'graph TD',
    '    P0E1["Достаточно длинный лейбл узла для этого теста регрессии"]',
    '```',
  ].join('\n');
  const { nodes } = parseMermaidBlocks(md, 'inline-mention.md');
  assert.ok(nodes.some((n) => n.id === 'P0E1' && n.shape === 'rect'), 'настоящий блок после инлайн-упоминания должен разобраться');
});

// --- normalizeLabel --------------------------------------------------------

test('normalizeLabel: схлопывает пробелы/переносы, убирает <br/>, приводит кавычки и регистр', () => {
  assert.equal(normalizeLabel('  Текст   с   пробелами  '), 'текст с пробелами');
  assert.equal(normalizeLabel('строка1\nстрока2'), 'строка1 строка2');
  assert.equal(normalizeLabel('часть<br/>ещё часть'), 'часть ещё часть');
  assert.equal(normalizeLabel('часть<br />ещё'), 'часть ещё');
  assert.equal(normalizeLabel('«ёлочки» и "прямые"'), '"ёлочки" и "прямые"');
  assert.equal(normalizeLabel('‘одинарные’ и \'прямые\''), "'одинарные' и 'прямые'");
  assert.equal(normalizeLabel('ВЕРХНИЙ РЕГИСТР'), 'верхний регистр');
  // markdown-акценты лейбла агент при цитировании опускает (прогоны 2026-09-22, P0S3)
  assert.equal(normalizeLabel('`.workflow/src/skills/shared/*` — **Перед началом работы**'), '.workflow/src/skills/shared/ — перед началом работы');
  assert.equal(normalizeLabel('.workflow/src/skills/shared/ — Перед началом работы'), '.workflow/src/skills/shared/ — перед началом работы');
  assert.equal(normalizeLabel(null), '');
  assert.equal(normalizeLabel(undefined), '');
});

// --- loadSkillGraph + validate: валидный граф со склейкой фрагментов ------

test('loadSkillGraph: валидный граф (SKILL.md + workflows/extra.md) проходит без ошибок', () => {
  const dir = join(FIXTURES, 'valid');
  const config = { entry: 'P0E1', terminal: ['P2S1'], pause_nodes: [] };
  const graph = loadSkillGraph(dir, config);
  const result = graph.validate(config);

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.stats.nodes, 10);
  assert.equal(result.stats.edges, 10);
  assert.equal(result.stats.stages, 3);
  assert.deepEqual(result.stats.files, ['SKILL.md', 'workflows/extra.md']);
  assert.equal(result.stats.nodesByType.E, 3);
  assert.equal(result.stats.nodesByType.R, 3);
  assert.equal(result.stats.nodesByType.S, 3);
  assert.equal(result.stats.nodesByType.G, 1);
});

test('loadSkillGraph: Graph.node()/outgoing() отдают нормальные данные узла', () => {
  const dir = join(FIXTURES, 'valid');
  const config = { entry: 'P0E1', terminal: ['P2S1'] };
  const graph = loadSkillGraph(dir, config);

  const gate = graph.node('P0G1');
  assert.equal(gate.stage, 0);
  assert.equal(gate.type, 'G');
  assert.equal(gate.num, 1);
  assert.equal(gate.shape, 'diamond');
  assert.equal(gate.source, 'SKILL.md');

  const out = graph.outgoing('P0G1');
  assert.deepEqual(out, [
    { to: 'P1E1', label: 'да' },
    { to: 'P0S1', label: 'нет' },
  ]);

  assert.equal(graph.node('P9E9'), undefined);
  assert.deepEqual(graph.outgoing('P9E9'), []);
});

// --- каждый код ошибки/предупреждения из §3 — отдельным негативным случаем ---

test('validate: bad-id', () => {
  const dir = join(FIXTURES, 'bad-id');
  const config = { entry: 'P0E1' };
  const result = loadSkillGraph(dir, config).validate(config);
  assert.ok(errorCodes(result).includes('bad-id'));
  const err = result.errors.find((e) => e.code === 'bad-id');
  assert.equal(err.id, 'BAD1');
});

test('validate: dup-id', () => {
  const dir = join(FIXTURES, 'dup-id');
  const config = { entry: 'P0E1' };
  const result = loadSkillGraph(dir, config).validate(config);
  assert.ok(errorCodes(result).includes('dup-id'));
  const err = result.errors.find((e) => e.code === 'dup-id');
  assert.equal(err.id, 'P0E1');
});

test('validate: dup-id между файлами (SKILL.md и фрагмент)', () => {
  const dir = join(FIXTURES, 'dup-id-across-files');
  const config = { entry: 'P0E1', terminal: ['P0R1'] };
  const result = loadSkillGraph(dir, config).validate(config);
  const err = result.errors.find((e) => e.code === 'dup-id');
  assert.ok(err);
  assert.equal(err.id, 'P0E1');
  assert.deepEqual(err.sources.sort(), ['SKILL.md', 'workflows/frag.md']);
});

test('validate: semicolon-in-label — предупреждение, не ошибка (mermaid 12.0.0 разбирает «;» в кавычках)', () => {
  const dir = join(FIXTURES, 'semicolon-in-label');
  const config = { entry: 'P0E1' };
  const result = loadSkillGraph(dir, config).validate(config);
  assert.ok(!errorCodes(result).includes('semicolon-in-label'));
  assert.ok(result.warnings.some((w) => w.code === 'semicolon-in-label'));
});

test('validate: short-label (quote_min по умолчанию 25)', () => {
  const dir = join(FIXTURES, 'short-label');
  const config = { entry: 'P0E1' };
  const result = loadSkillGraph(dir, config).validate(config);
  assert.ok(errorCodes(result).includes('short-label'));
});

test('validate: short-label уважает переданный quote_min', () => {
  const dir = join(FIXTURES, 'short-label');
  const config = { entry: 'P0E1', quote_min: 5 };
  const result = loadSkillGraph(dir, config).validate(config);
  assert.ok(!errorCodes(result).includes('short-label'), '"Коротко" >= 5 символов');
});

test('validate: unknown-target', () => {
  const dir = join(FIXTURES, 'unknown-target');
  const config = { entry: 'P0E1' };
  const result = loadSkillGraph(dir, config).validate(config);
  const err = result.errors.find((e) => e.code === 'unknown-target');
  assert.ok(err);
  assert.equal(err.to, 'P9S9');
});

test('validate: unknown-target по стороне from (ребро исходит из неопределённого узла)', () => {
  const dir = join(FIXTURES, 'unknown-target-from');
  const config = { entry: 'P0E1' };
  const result = loadSkillGraph(dir, config).validate(config);
  const err = result.errors.find((e) => e.code === 'unknown-target' && e.from === 'P9S9');
  assert.ok(err);
});

test('validate: no-entry — entry не задан в конфиге', () => {
  const dir = join(FIXTURES, 'no-entry');
  const config = {};
  const result = loadSkillGraph(dir, config).validate(config);
  assert.ok(errorCodes(result).includes('no-entry'));
});

test('validate: bad-entry — entry существует, но не E-узел', () => {
  const dir = join(FIXTURES, 'bad-entry');
  const config = { entry: 'P0R1' };
  const result = loadSkillGraph(dir, config).validate(config);
  assert.ok(errorCodes(result).includes('bad-entry'));
});

test('validate: bad-entry — entry указывает на несуществующий узел', () => {
  const dir = join(FIXTURES, 'bad-entry');
  const config = { entry: 'P9E9' };
  const result = loadSkillGraph(dir, config).validate(config);
  assert.ok(errorCodes(result).includes('bad-entry'));
});

test('validate: orphan — узел недостижим из entry', () => {
  const dir = join(FIXTURES, 'orphan');
  const config = { entry: 'P0E1', terminal: ['P0R1', 'P1R1'] };
  const result = loadSkillGraph(dir, config).validate(config);
  const orphanIds = result.errors.filter((e) => e.code === 'orphan').map((e) => e.id);
  assert.deepEqual(orphanIds.sort(), ['P1E1', 'P1R1']);
});

test('validate: dead-end — нет исходящих рёбер и узел не terminal/pause', () => {
  const dir = join(FIXTURES, 'dead-end');
  const config = { entry: 'P0E1', terminal: [] };
  const result = loadSkillGraph(dir, config).validate(config);
  const err = result.errors.find((e) => e.code === 'dead-end');
  assert.ok(err);
  assert.equal(err.id, 'P0R1');
});

test('validate: dead-end не срабатывает, если узел в terminal', () => {
  const dir = join(FIXTURES, 'dead-end');
  const config = { entry: 'P0E1', terminal: ['P0R1'] };
  const result = loadSkillGraph(dir, config).validate(config);
  assert.ok(!errorCodes(result).includes('dead-end'));
});

test('validate: stage-no-entry — в этапе два E-узла', () => {
  const dir = join(FIXTURES, 'stage-no-entry');
  const config = { entry: 'P0E1', terminal: ['P0R1'] };
  const result = loadSkillGraph(dir, config).validate(config);
  const err = result.errors.find((e) => e.code === 'stage-no-entry');
  assert.ok(err);
  assert.equal(err.stage, 0);
  assert.equal(err.count, 2);
});

test('validate: stage-no-entry — в этапе нет ни одного E-узла (0)', () => {
  const dir = join(FIXTURES, 'stage-no-entry-zero');
  const config = { entry: 'P1E1' };
  const result = loadSkillGraph(dir, config).validate(config);
  const err = result.errors.find((e) => e.code === 'stage-no-entry' && e.stage === 0);
  assert.ok(err);
  assert.equal(err.count, 0);
});

test('validate: stage-order — R определён после S', () => {
  const dir = join(FIXTURES, 'stage-order');
  const config = { entry: 'P0E1', terminal: ['P0R1'] };
  const result = loadSkillGraph(dir, config).validate(config);
  const err = result.errors.find((e) => e.code === 'stage-order');
  assert.ok(err);
  assert.equal(err.id, 'P0R1');
});

test('validate: gate-edges — у гейта меньше двух рёбер и ребро без метки (оба условия сразу)', () => {
  const dir = join(FIXTURES, 'gate-edges');
  const config = { entry: 'P0E1', terminal: ['P0S1'] };
  const result = loadSkillGraph(dir, config).validate(config);
  const err = result.errors.find((e) => e.code === 'gate-edges');
  assert.ok(err);
  assert.equal(err.id, 'P0G1');
});

test('validate: gate-edges — изолированно условие «меньше двух рёбер» (единственное ребро с меткой)', () => {
  const dir = join(FIXTURES, 'gate-edges-count');
  const config = { entry: 'P0E1', terminal: ['P0S1'] };
  const result = loadSkillGraph(dir, config).validate(config);
  const err = result.errors.find((e) => e.code === 'gate-edges');
  assert.ok(err);
  assert.equal(err.id, 'P0G1');
  assert.match(err.message, /меньше двух/);
});

test('validate: gate-edges — изолированно условие «ребро без метки» (рёбер уже два)', () => {
  const dir = join(FIXTURES, 'gate-edges-unlabeled');
  const config = { entry: 'P0E1', terminal: ['P0S1', 'P0S2'] };
  const result = loadSkillGraph(dir, config).validate(config);
  const err = result.errors.find((e) => e.code === 'gate-edges');
  assert.ok(err);
  assert.equal(err.id, 'P0G1');
  assert.match(err.message, /без метки/);
  // gate-edges уже отразил дефект как error — unlabeled-branch warning для G/Q дублировать не должен.
  assert.ok(!result.warnings.some((w) => w.code === 'unlabeled-branch' && w.id === 'P0G1'));
});

test('validate: unlabeled-branch — предупреждение, не ошибка', () => {
  const dir = join(FIXTURES, 'unlabeled-branch');
  const config = { entry: 'P0E1', terminal: ['P0S2', 'P0S3'] };
  const result = loadSkillGraph(dir, config).validate(config);
  assert.ok(!errorCodes(result).includes('unlabeled-branch'));
  const warn = result.warnings.find((w) => w.code === 'unlabeled-branch');
  assert.ok(warn);
  assert.equal(warn.id, 'P0S1');
});

test('validate: unknown-terminal / unknown-pause — опечатка в rails.yaml не тонет молча', () => {
  const dir = join(FIXTURES, 'unknown-terminal-pause');
  const config = { entry: 'P0E1', terminal: ['P0S1', 'P9E9'], pause_nodes: ['P8Q8'] };
  const result = loadSkillGraph(dir, config).validate(config);
  const terminalErr = result.errors.find((e) => e.code === 'unknown-terminal');
  assert.ok(terminalErr);
  assert.equal(terminalErr.id, 'P9E9');
  const pauseErr = result.errors.find((e) => e.code === 'unknown-pause');
  assert.ok(pauseErr);
  assert.equal(pauseErr.id, 'P8Q8');
});

test('validate: stage-collision — один номер этапа в двух файлах', () => {
  const dir = join(FIXTURES, 'stage-collision');
  const config = { entry: 'P0E1', terminal: ['P0S1'] };
  const result = loadSkillGraph(dir, config).validate(config);
  const err = result.errors.find((e) => e.code === 'stage-collision');
  assert.ok(err);
  assert.equal(err.stage, 0);
  assert.deepEqual(err.sources.sort(), ['SKILL.md', 'workflows/frag.md']);
});

// --- validate: не падает на плохом rails.yaml (§7 «хук никогда не падает») ---

test('validate: terminal/pause_nodes не массив (плохой конфиг) — не бросает, просто не защищает узел', () => {
  const dir = join(FIXTURES, 'dead-end');
  const graph = loadSkillGraph(dir, { entry: 'P0E1' });
  assert.doesNotThrow(() => graph.validate({ entry: 'P0E1', terminal: 'P0R1' }));
  assert.doesNotThrow(() => graph.validate({ entry: 'P0E1', pause_nodes: 5 }));
});

test('validate: parse-error из loadSkillGraph доходит до validate().errors, а не теряется по пути', () => {
  const dir = join(FIXTURES, 'parse-error');
  const config = { entry: 'P0E1' };
  const result = loadSkillGraph(dir, config).validate(config);
  const err = result.errors.find((e) => e.code === 'parse-error');
  assert.ok(err);
  assert.equal(err.source, 'SKILL.md');
});

// --- loadSkillGraph: не падает на плохом fragments, не дублирует SKILL.md ---

test('loadSkillGraph: fragments — строка вместо массива не бросает, используется дефолт workflows/*.md', () => {
  const dir = join(FIXTURES, 'valid');
  const config = { entry: 'P0E1', terminal: ['P2S1'], fragments: 'workflows/*.md' };
  let graph;
  assert.doesNotThrow(() => {
    graph = loadSkillGraph(dir, config);
  });
  assert.deepEqual(graph.validate(config).stats.files, ['SKILL.md', 'workflows/extra.md']);
});

test('loadSkillGraph: fragments — не-строковые элементы отфильтровываются, не бросает', () => {
  const dir = join(FIXTURES, 'valid');
  const config = { entry: 'P0E1', terminal: ['P2S1'], fragments: [42, 'workflows/*.md'] };
  let graph;
  assert.doesNotThrow(() => {
    graph = loadSkillGraph(dir, config);
  });
  assert.deepEqual(graph.validate(config).stats.files, ['SKILL.md', 'workflows/extra.md']);
});

test('loadSkillGraph: fragments включает SKILL.md — не дублируется (нет ложного dup-id)', () => {
  const dir = join(FIXTURES, 'valid');
  const config = { entry: 'P0E1', terminal: ['P2S1'], fragments: ['SKILL.md', 'workflows/*.md'] };
  const result = loadSkillGraph(dir, config).validate(config);
  assert.ok(!result.errors.some((e) => e.code === 'dup-id'), 'SKILL.md не должен попасть в files дважды');
  assert.deepEqual(result.stats.files, ['SKILL.md', 'workflows/extra.md']);
});
