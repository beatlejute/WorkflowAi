import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import {
  loadState,
  saveState,
  deleteState,
  startState,
  applyGoto,
  allowedTransitions,
  checkActionLimit,
  currentNodeInfo,
  bumpCounter,
  newestSessionId,
  normalizeLabel,
} from '../rails/state.mjs';
import { loadSkillGraph } from '../rails/graph.mjs';

const FIXTURES = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'rails', 'graph');

function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'rails-state-'));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Фейковый Graph — тот же контракт, что у настоящего `graph.mjs`:
// `node(id) -> node|undefined`, `outgoing(id) -> [{to, label}]` (проверено
// тестом ниже на реальном Graph из `loadSkillGraph`, фикстура `graph/valid`).
function makeGraph(nodes, edges) {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  return {
    node: (id) => nodeMap.get(id),
    outgoing: (id) => edges.filter((e) => e.from === id).map((e) => ({ to: e.to, label: e.label ?? null })),
  };
}

const NODES = [
  { id: 'P4E1', type: 'E', stage: 4, label: 'П4 ВХОД: правка файлов скила — начало этапа' },
  { id: 'P4R1', type: 'R', stage: 4, label: 'П4 ПРАВИЛО: писать только внутри области скила' },
  { id: 'P4S1', type: 'S', stage: 4, label: 'П4 ШАГ: внести правку в SKILL.md согласно плану' },
  { id: 'P5E1', type: 'E', stage: 5, label: 'П5 ВХОД: прогон тестов после правки скила' },
  { id: 'P5S1', type: 'S', stage: 5, label: 'П5 ШАГ: запустить run-skill-tests и дождаться результата' },
];
const EDGES = [
  { from: 'P4E1', to: 'P4R1' },
  { from: 'P4R1', to: 'P4S1' },
  { from: 'P4S1', to: 'P5E1', label: 'да' },
  { from: 'P5E1', to: 'P5S1' },
  { from: 'P5S1', to: 'P4E1', label: 'три круга не сошлись' }, // цикл 5 -> 4
];
const GRAPH = makeGraph(NODES, EDGES);

const CONFIG = {
  quote_min: 25,
  cycles: [
    { from: 5, to: 4, max: 3, reason: 'Три круга «правка → тест» не сошлись — выход к человеку' },
  ],
};

// --- цикл внутри этапа (from == to): считается только возврат назад ----------
// Первый прогон коуча 2026-09-22: три штатных шага вперёд P1R1 → P1R2 → P1R3 упёрлись
// в cycle_limit — потолок обязан считать только возвраты (гейт → шаг), не цепочку.

test('applyGoto: from == to — переходы вперёд по цепочке E → R → S → G потолком не считаются, возврат G → S считается', () => {
  const nodes = [
    { id: 'P4E1', type: 'E', stage: 4, label: 'П4 ВХОД: правка файлов скила — начало этапа' },
    { id: 'P4R1', type: 'R', stage: 4, label: 'П4 ПРАВИЛО: писать только внутри области скила' },
    { id: 'P4S1', type: 'S', stage: 4, label: 'П4 ШАГ: внести правку в SKILL.md согласно плану' },
    { id: 'P4G1', type: 'G', stage: 4, label: 'П4 ГЕЙТ: файл перечитан и принципы пройдены?' },
    { id: 'P5E1', type: 'E', stage: 5, label: 'П5 ВХОД: прогон тестов после правки скила' },
  ];
  const edges = [
    { from: 'P4E1', to: 'P4R1' },
    { from: 'P4R1', to: 'P4S1' },
    { from: 'P4S1', to: 'P4G1' },
    { from: 'P4G1', to: 'P5E1', label: 'да' },
    { from: 'P4G1', to: 'P4S1', label: 'нет' },
  ];
  const graph = makeGraph(nodes, edges);
  const config = { quote_min: 25, cycles: [{ from: 4, to: 4, max: 2, reason: 'Self-check не сходится — выход к человеку' }] };
  const state = { node: 'P4E1', history: [], counters: {}, denials: {} };

  assert.equal(applyGoto(state, graph, config, { node: 'P4R1', quote: 'писать только внутри области скила' }).ok, true);
  assert.equal(applyGoto(state, graph, config, { node: 'P4S1', quote: 'внести правку в SKILL.md согласно плану' }).ok, true);
  assert.equal(applyGoto(state, graph, config, { node: 'P4G1', quote: 'файл перечитан и принципы пройдены' }).ok, true);
  assert.equal(state.counters['cycle:4>4'], undefined, 'шаги вперёд не считаются циклом');

  assert.equal(applyGoto(state, graph, config, { node: 'P4S1', quote: 'внести правку в SKILL.md согласно плану' }).ok, true);
  assert.equal(state.counters['cycle:4>4'], 1);
  state.node = 'P4G1';
  assert.equal(applyGoto(state, graph, config, { node: 'P4S1', quote: 'внести правку в SKILL.md согласно плану' }).ok, true);
  assert.equal(state.counters['cycle:4>4'], 2);
  state.node = 'P4G1';
  const third = applyGoto(state, graph, config, { node: 'P4S1', quote: 'внести правку в SKILL.md согласно плану' });
  assert.equal(third.ok, false);
  assert.equal(third.code, 'cycle_limit');
  assert.match(third.reason, /человеку/);
});

// --- loadState / saveState / deleteState ------------------------------------

test('saveState -> loadState: round-trip', () => {
  withRoot((root) => {
    const state = startState({ root, sessionId: 'sess-1', skill: 'coach', entry: 'P4E1' });
    const loaded = loadState(root, 'sess-1');
    assert.deepEqual(loaded, state);
  });
});

test('loadState: нет файла -> null', () => {
  withRoot((root) => {
    assert.equal(loadState(root, 'nope'), null);
  });
});

test('loadState: битый JSON -> null', () => {
  withRoot((root) => {
    const state = startState({ root, sessionId: 'sess-1', skill: 'coach', entry: 'P4E1' });
    const path = join(root, '.workflow', 'state', 'rails', 'sess-1.json');
    writeFileSync(path, '{ не json', 'utf8');
    assert.equal(loadState(root, 'sess-1'), null);
  });
});

test('saveState: атомарная запись — не оставляет .tmp файлов', () => {
  withRoot((root) => {
    const state = startState({ root, sessionId: 'sess-1', skill: 'coach', entry: 'P4E1' });
    saveState(root, state);
    const dir = join(root, '.workflow', 'state', 'rails');
    const entries = readdirSync(dir);
    assert.deepEqual(entries, ['sess-1.json']);
  });
});

test('deleteState: удаляет файл, повторный вызов не падает', () => {
  withRoot((root) => {
    startState({ root, sessionId: 'sess-1', skill: 'coach', entry: 'P4E1' });
    const path = join(root, '.workflow', 'state', 'rails', 'sess-1.json');
    assert.ok(existsSync(path));
    deleteState(root, 'sess-1');
    assert.ok(!existsSync(path));
    assert.doesNotThrow(() => deleteState(root, 'sess-1'));
  });
});

test('startState: создаёт состояние в entry с пустыми счётчиками/историей', () => {
  withRoot((root) => {
    const state = startState({ root, sessionId: 'sess-1', skill: 'coach', entry: 'P4E1', run: 'run-1' });
    assert.equal(state.node, 'P4E1');
    assert.equal(state.skill, 'coach');
    assert.equal(state.run, 'run-1');
    assert.deepEqual(state.history, []);
    assert.deepEqual(state.counters, {});
    assert.deepEqual(state.denials, {});
    assert.equal(state.flags.correction_pending, false);
  });
});

// --- sessionId — защита от path traversal -----------------------------------

test('startState: sessionId с разделителем пути -> ошибка', () => {
  withRoot((root) => {
    assert.throws(() => startState({ root, sessionId: '../evil', skill: 'coach', entry: 'P4E1' }));
  });
});

test('loadState: sessionId с разделителем пути -> null (не бросает наружу)', () => {
  // loadState по конвенции этого файла (как pause-request.mjs) любую
  // проблему с чтением, включая некорректный sessionId, превращает в
  // null, а не бросает исключение.
  withRoot((root) => {
    assert.equal(loadState(root, '../evil'), null);
  });
});

// --- bumpCounter --------------------------------------------------------------

test('bumpCounter: увеличивает счётчик и возвращает новое значение', () => {
  const state = { counters: {} };
  assert.equal(bumpCounter(state, 'action:run_tests'), 1);
  assert.equal(bumpCounter(state, 'action:run_tests'), 2);
  assert.equal(state.counters['action:run_tests'], 2);
});

// --- allowedTransitions --------------------------------------------------------

test('allowedTransitions: рёбра текущего узла, лейбл обрезан до 60 символов', () => {
  const state = { node: 'P4S1' };
  const allowed = allowedTransitions(state, GRAPH);
  assert.equal(allowed.length, 1);
  assert.equal(allowed[0].id, 'P5E1');
  assert.ok(allowed[0].label.length <= 60);
  assert.equal(allowed[0].label, NODES.find((n) => n.id === 'P5E1').label.slice(0, 60));
});

// --- applyGoto: успешный переход ----------------------------------------------

test('applyGoto: успешный переход по цитате из лейбла цели', () => {
  const state = { node: 'P4E1', history: [], counters: {}, denials: {} };
  const r = applyGoto(state, GRAPH, CONFIG, {
    node: 'P4R1',
    quote: 'писать только внутри области скила',
  });
  assert.equal(r.ok, true);
  assert.equal(state.node, 'P4R1');
  assert.equal(state.history.length, 1);
  assert.deepEqual(state.history[0], { t: state.history[0].t, from: 'P4E1', to: 'P4R1' });
});

test('applyGoto: цитата не чувствительна к регистру и типографским кавычкам', () => {
  const state = { node: 'P4E1', history: [], counters: {}, denials: {} };
  const r = applyGoto(state, GRAPH, CONFIG, {
    node: 'P4R1',
    quote: 'ПИСАТЬ только внутри области скила',
  });
  assert.equal(r.ok, true);
});

// --- applyGoto: отказы --------------------------------------------------------

test('applyGoto: переход без ребра -> отказ, denials[node] инкрементирован', () => {
  const state = { node: 'P4E1', history: [], counters: {}, denials: {} };
  const r = applyGoto(state, GRAPH, CONFIG, {
    node: 'P5S1', // нет прямого ребра из P4E1
    quote: 'запустить run-skill-tests и дождаться результата',
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /нет ребра/);
  assert.equal(state.node, 'P4E1'); // не сдвинулся
  assert.equal(state.denials['P4E1'], 1);
  assert.ok(Array.isArray(r.allowed));
});

test('applyGoto: цитата короче quote_min -> отказ', () => {
  const state = { node: 'P4E1', history: [], counters: {}, denials: {} };
  const r = applyGoto(state, GRAPH, CONFIG, { node: 'P4R1', quote: 'слишком коротко' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /короче/);
  assert.equal(state.node, 'P4E1');
});

test('applyGoto: цитата не из лейбла цели (пересказ своими словами) -> отказ', () => {
  const state = { node: 'P4E1', history: [], counters: {}, denials: {} };
  const r = applyGoto(state, GRAPH, CONFIG, {
    node: 'P4R1',
    quote: 'это правило совсем про другое и звучит иначе',
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /не найдена/);
  assert.equal(state.node, 'P4E1');
});

test('applyGoto: несколько отказов подряд накапливают denials[node]', () => {
  const state = { node: 'P4E1', history: [], counters: {}, denials: {} };
  applyGoto(state, GRAPH, CONFIG, { node: 'P4R1', quote: 'коротко' });
  applyGoto(state, GRAPH, CONFIG, { node: 'P4R1', quote: 'коротко' });
  applyGoto(state, GRAPH, CONFIG, { node: 'P4R1', quote: 'коротко' });
  assert.equal(state.denials['P4E1'], 3);
});

// --- applyGoto: потолок цикла ---------------------------------------------------

test('applyGoto: потолок цикла — 3 перехода 5->4 проходят, 4-й отклоняется', () => {
  const state = { node: 'P5S1', history: [], counters: {}, denials: {} };
  const goBack = () =>
    applyGoto(state, GRAPH, CONFIG, {
      node: 'P4E1',
      quote: 'правка файлов скила — начало этапа',
    });
  const goForward = () => {
    // Вернуться на P5S1: E1 -> R1 -> S1 -> E1(5) -> S1(5), для простоты
    // теста прыгаем прямо по известным рёбрам графа.
    applyGoto(state, GRAPH, CONFIG, { node: 'P4R1', quote: 'писать только внутри области скила' });
    applyGoto(state, GRAPH, CONFIG, { node: 'P4S1', quote: 'внести правку в SKILL.md согласно плану' });
    applyGoto(state, GRAPH, CONFIG, { node: 'P5E1', quote: 'прогон тестов после правки скила' });
    applyGoto(state, GRAPH, CONFIG, { node: 'P5S1', quote: 'запустить run-skill-tests и дождаться результата' });
  };

  let r = goBack();
  assert.equal(r.ok, true);
  assert.equal(state.counters['cycle:5>4'], 1);
  goForward();

  r = goBack();
  assert.equal(r.ok, true);
  assert.equal(state.counters['cycle:5>4'], 2);
  goForward();

  r = goBack();
  assert.equal(r.ok, true);
  assert.equal(state.counters['cycle:5>4'], 3);
  goForward();

  r = goBack();
  assert.equal(r.ok, false);
  assert.match(r.reason, /выход к человеку/);
  assert.equal(state.node, 'P5S1'); // не сдвинулся
  assert.equal(state.counters['cycle:5>4'], 3); // не выросло сверх потолка
});

// --- applyGoto / allowedTransitions: настоящий Graph (не фейк) -----------------
// major-находка ревью: фейк в этом файле рассчитан на контракт
// getNode/edgesFrom, реальный graph.mjs даёт node/outgoing — с настоящим
// графом applyGoto падал (`graph.edgesFrom is not a function`).

test('applyGoto/allowedTransitions: работают с настоящим Graph из loadSkillGraph (фикстура graph/valid)', () => {
  const graph = loadSkillGraph(join(FIXTURES, 'valid'), {});
  const config = { quote_min: 25 };
  const state = { node: 'P0E1', history: [], counters: {}, denials: {} };

  const allowed = allowedTransitions(state, graph);
  assert.equal(allowed.length, 1);
  assert.equal(allowed[0].id, 'P0R1');

  const ok = applyGoto(state, graph, config, {
    node: 'P0R1',
    quote: 'перед стартом всегда проверяй текущее состояние сессии',
  });
  assert.equal(ok.ok, true);
  assert.equal(state.node, 'P0R1');

  const bad = applyGoto(state, graph, config, {
    node: 'P2E1', // нет прямого ребра из P0R1
    quote: 'финальный этап — подготовка ответа пользователю',
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'no-edge');
});

// --- applyGoto: коды отказов (minor-находка ревью) -----------------------------

test('applyGoto: код отказа "no-edge" при переходе без ребра', () => {
  const state = { node: 'P4E1', history: [], counters: {}, denials: {} };
  const r = applyGoto(state, GRAPH, CONFIG, { node: 'P5S1', quote: 'запустить run-skill-tests и дождаться результата' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'no-edge');
});

test('applyGoto: код отказа "short-quote" при короткой цитате', () => {
  const state = { node: 'P4E1', history: [], counters: {}, denials: {} };
  const r = applyGoto(state, GRAPH, CONFIG, { node: 'P4R1', quote: 'слишком коротко' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'short-quote');
});

test('applyGoto: код отказа "quote-mismatch" при цитате не из лейбла цели', () => {
  const state = { node: 'P4E1', history: [], counters: {}, denials: {} };
  const r = applyGoto(state, GRAPH, CONFIG, {
    node: 'P4R1',
    quote: 'это правило совсем про другое и звучит иначе',
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'quote-mismatch');
});

// Отказ показывает точку расхождения цитаты с лейблом (журналы прогонов 2026-09-22:
// по одной обрезанной цитате нельзя было отличить пересказ от раскрытого shell'ом `$X`).
test('applyGoto: quote-mismatch — отказ называет точку расхождения: совпавший хвост, продолжение цитаты и лейбла', () => {
  const state = { node: 'P4E1', history: [], counters: {}, denials: {} };
  const r = applyGoto(state, GRAPH, CONFIG, {
    node: 'P4R1',
    quote: 'П4 ПРАВИЛО: писать только вне области скила',
  });
  assert.equal(r.code, 'quote-mismatch');
  assert.match(r.reason, /совпадает до «…[^»]*писать только вн»/);
  assert.match(r.reason, /дальше в цитате «е области скила»/);
  assert.match(r.reason, /в лейбле «утри области скила»/);
  assert.doesNotMatch(r.reason, /одинарные кавычки/, 'подсказка про $ — только когда расхождение на $');
});

test('applyGoto: quote-mismatch на «$» в лейбле -> подсказка про одинарные кавычки', () => {
  const graph = makeGraph(
    [
      { id: 'P3S4', type: 'S', stage: 3, label: 'П3 ШАГ: собрать черновик' },
      { id: 'P3Q1', type: 'Q', stage: 3, label: 'П3 ВЫБОР: прогон runner платный (~$X, ~Y минут) — нужен confirm?' },
    ],
    [{ from: 'P3S4', to: 'P3Q1' }]
  );
  const state = { node: 'P3S4', history: [], counters: {}, denials: {} };
  // так цитата доходит до cli.mjs после `--quote "…~$X…"`: shell раскрыл $X в пустоту
  const r = applyGoto(state, graph, { quote_min: 25 }, { node: 'P3Q1', quote: 'П3 ВЫБОР: прогон runner платный (~, ~Y минут)' });
  assert.equal(r.code, 'quote-mismatch');
  assert.match(r.reason, /в лейбле «\$x, ~y минут/);
  assert.match(r.reason, /одинарные кавычки/);
});

// ЗАДАЧА B, 2026-09-22: normalizeLabel (graph.mjs) снимает бэктики из лейбла ДО сверки
// цитаты — старая подсказка смотрела на normLabel в точке расхождения и там бэктика
// никогда нет (он уже вырезан), поэтому про порчу бэктиком подсказка не срабатывала.
test('applyGoto: quote-mismatch на бэктике в лейбле -> подсказка про одинарные кавычки (подсказка идёт по СЫРОМУ лейблу, не по нормализованному)', () => {
  const graph = makeGraph(
    [
      { id: 'P5S2', type: 'S', stage: 5, label: 'П5 ШАГ: подготовить черновик отчёта' },
      { id: 'P5R3', type: 'R', stage: 5, label: 'П5 ПРАВИЛО: собрать отчёт из `.workflow/reports/`, оценку записать в план' },
    ],
    [{ from: 'P5S2', to: 'P5R3' }]
  );
  const state = { node: 'P5S2', history: [], counters: {}, denials: {} };
  // так цитата доходит до cli.mjs после `--quote "…из `.workflow/reports/`, оценку…"`:
  // bash выполнил `.workflow/reports/` как подкоманду, содержимое между бэктиками пропало.
  const r = applyGoto(state, graph, { quote_min: 25 }, { node: 'P5R3', quote: 'П5 ПРАВИЛО: собрать отчёт из , оценку записать в план' });
  assert.equal(r.code, 'quote-mismatch');
  assert.match(r.reason, /одинарные кавычки/);
});

// ЗАДАЧА B2 (2026-09-22, ревью LOW): подсказка про одинарные кавычки — и на ветке «не
// совпадает даже начало»: когда `$X`/бэктик стоит в первых ~10 символах лейбла, порча
// shell'ом даёт расхождение сразу в начале цитаты, а подсказка выдавалась только после lo >= 10.
test('applyGoto: quote-mismatch «даже начало» при `$`/бэктике в сыром лейбле -> подсказка про одинарные кавычки; без них — нет', () => {
  const graph = makeGraph(
    [
      { id: 'P5S2', type: 'S', stage: 5, label: 'П5 ШАГ: подготовить черновик отчёта' },
      { id: 'P5R3', type: 'R', stage: 5, label: 'П5 ПРАВИЛО: стоит $X, а `$Y` минут — подтверждение агента обязательно перед стартом' },
    ],
    [{ from: 'P5S2', to: 'P5R3' }]
  );
  const state = { node: 'P5S2', history: [], counters: {}, denials: {} };
  // так цитата доходит до cli.mjs: $X и `$Y` раскрылись в пустоту — расхождение в первых 10 символах
  const r = applyGoto(state, graph, { quote_min: 25 }, { node: 'P5R3', quote: 'стоит ,  а  минут — подтверждение агента обязательно перед стартом' });
  assert.equal(r.code, 'quote-mismatch');
  assert.match(r.reason, /не совпадает даже начало/);
  assert.match(r.reason, /одинарные кавычки/);
  assert.equal((r.reason.match(/одинарные кавычки/g) || []).length, 1, 'подсказка одна, без дублей');

  const plain = applyGoto({ node: 'P4E1', history: [], counters: {}, denials: {} }, GRAPH, CONFIG, { node: 'P4R1', quote: 'это правило совсем про другое и звучит иначе' });
  assert.match(plain.reason, /не совпадает даже начало/);
  assert.doesNotMatch(plain.reason, /одинарные кавычки/, 'в лейбле без ` и $ подсказки нет');
});

test('applyGoto: quote-mismatch без общего начала -> «не совпадает даже начало»', () => {
  const state = { node: 'P4E1', history: [], counters: {}, denials: {} };
  const r = applyGoto(state, GRAPH, CONFIG, { node: 'P4R1', quote: 'это правило совсем про другое и звучит иначе' });
  assert.match(r.reason, /не совпадает даже начало/);
});

test('applyGoto: код отказа "cycle_limit" и ключ цикла при превышении потолка', () => {
  const state = { node: 'P5S1', history: [], counters: { 'cycle:5>4': 3 }, denials: {} };
  const r = applyGoto(state, GRAPH, CONFIG, { node: 'P4E1', quote: 'правка файлов скила — начало этапа' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'cycle_limit');
  assert.equal(r.key, 'cycle:5>4');
});

test('applyGoto: не падает на состоянии без counters/denials/history (повреждённый JSON)', () => {
  const state = { node: 'P4E1' };
  assert.doesNotThrow(() => {
    const r = applyGoto(state, GRAPH, CONFIG, { node: 'P4R1', quote: 'писать только внутри области скила' });
    assert.equal(r.ok, true);
  });
  assert.deepEqual(state.history.map((h) => h.to), ['P4R1']);
});

// --- checkActionLimit -------------------------------------------------------------

test('checkActionLimit: 3 запуска проходят, 4-й отклоняется (max_per_session: 3)', () => {
  const state = { counters: {} };
  const r1 = checkActionLimit(state, 'run_tests', 3);
  const r2 = checkActionLimit(state, 'run_tests', 3);
  const r3 = checkActionLimit(state, 'run_tests', 3);
  const r4 = checkActionLimit(state, 'run_tests', 3);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(r3.ok, true);
  assert.equal(r4.ok, false);
  assert.equal(r4.code, 'action_limit');
  assert.match(r4.reason, /выход к человеку/);
  assert.equal(state.counters['action:run_tests'], 3); // 4-й отказ не увеличил счётчик
});

test('checkActionLimit: счётчики разных правил не пересекаются', () => {
  const state = { counters: {} };
  checkActionLimit(state, 'run_tests', 3);
  checkActionLimit(state, 'run_tests', 3);
  const r = checkActionLimit(state, 'next_test_id', undefined); // без max_per_session — не ограничен
  assert.equal(r.ok, true);
  assert.equal(state.counters['action:run_tests'], 2);
  assert.equal(state.counters['action:next_test_id'], 1);
});

test('checkActionLimit: не падает без state.counters', () => {
  const state = {};
  assert.doesNotThrow(() => checkActionLimit(state, 'run_tests', 3));
});

// --- currentNodeInfo ---------------------------------------------------------------

test('currentNodeInfo: E-узел -> isEntry=true', () => {
  const info = currentNodeInfo({ node: 'P4E1' });
  assert.deepEqual(info, { stage: 4, type: 'E', isEntry: true });
});

test('currentNodeInfo: R/S/G/Q-узел -> isEntry=false', () => {
  assert.equal(currentNodeInfo({ node: 'P4R1' }).isEntry, false);
  assert.equal(currentNodeInfo({ node: 'P4S1' }).isEntry, false);
  assert.equal(currentNodeInfo({ node: 'P4G1' }).isEntry, false);
  assert.equal(currentNodeInfo({ node: 'P4Q1' }).isEntry, false);
});

test('currentNodeInfo: некорректный id -> null-поля, isEntry=false', () => {
  assert.deepEqual(currentNodeInfo({ node: 'not-a-node' }), { stage: null, type: null, isEntry: false });
  assert.deepEqual(currentNodeInfo({}), { stage: null, type: null, isEntry: false });
});

// --- newestSessionId ------------------------------------------------------------

test('newestSessionId: нет состояний -> null', () => {
  withRoot((root) => {
    assert.equal(newestSessionId(root), null);
  });
});

test('newestSessionId: возвращает самый свежий по mtime', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rails-state-'));
  try {
    startState({ root, sessionId: 'old', skill: 'coach', entry: 'P4E1' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    startState({ root, sessionId: 'new', skill: 'coach', entry: 'P4E1' });
    assert.equal(newestSessionId(root), 'new');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- null/не-объект на входе (minor-находка ревью: критерий "не падает на
// плохом входе" не выполнялся для всех экспортов) ---------------------------

test('applyGoto: null вместо state не бросает, а трактуется как пустое состояние', () => {
  assert.doesNotThrow(() => {
    const r = applyGoto(null, GRAPH, CONFIG, { node: 'P4R1', quote: 'писать только внутри области скила' });
    // node текущего (несуществующего) состояния - undefined, у него нет
    // рёбер в графе -> закономерный отказ "нет ребра", а не падение.
    assert.equal(r.ok, false);
    assert.equal(r.code, 'no-edge');
  });
});

test('checkActionLimit: null вместо state не бросает', () => {
  assert.doesNotThrow(() => {
    const r = checkActionLimit(null, 'run_tests', 3);
    assert.equal(r.ok, true);
  });
});

test('allowedTransitions: null вместо state не бросает, возвращает []', () => {
  assert.doesNotThrow(() => {
    assert.deepEqual(allowedTransitions(null, GRAPH), []);
  });
});

test('bumpCounter: null вместо state не бросает', () => {
  assert.doesNotThrow(() => {
    assert.equal(bumpCounter(null, 'action:x'), 1);
  });
});

test('newestSessionId: null вместо root не бросает, возвращает null', () => {
  assert.doesNotThrow(() => {
    assert.equal(newestSessionId(null), null);
  });
});

// --- normalizeLabel --------------------------------------------------------------

test('normalizeLabel: схлопывает пробелы, кавычки, регистр, <br/>', () => {
  assert.equal(
    normalizeLabel('  Текст   с "кавычками"<br/> и  «ёлочками»  '),
    'текст с "кавычками" и "ёлочками"'
  );
});
