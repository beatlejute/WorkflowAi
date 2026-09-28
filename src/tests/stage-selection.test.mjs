/**
 * Чистая логика выбора модели стадии (src/lib/stage-selection.mjs): полосы уровней,
 * нижняя граница тикета, порядок обхода, тикет и промпт селектора, разбор ответа,
 * разбор вывода команды фактов, раскрытие пулов в кандидатов.
 *
 * Что охраняется:
 *  - полосы равной ширины между min и max оценок выживших; max — уровень N, min — 1,
 *    без оценки — 1, полосы нулевой ширины — N, ниже min — 0 (только для границы);
 *  - граница считает refused, empty, artifacts_failed и review_failed (и отказ формы
 *    FIX-032: `status: ok`, `result_status: blocked`), не считает crashed,
 *    crashed_after_work, throttled, stopped, pending и запуски до `reset`; агент без
 *    факта — оценка события, без неё — пропуск; граница не выше maxLevel − 1;
 *  - обход: бесплатные ≥ R' по возрастанию, платные ≥ R' по возрастанию, хвост по
 *    убыванию с бесплатными первыми; внутри уровня — не запускавшиеся, ранжир, список;
 *    R не выше границы поднимается; выход — перестановка выживших над границей;
 *  - промпт: только переданные кандидаты, без цен и причин отсева, история без id;
 *  - required_level вне 1..N или не целое — null (unknown_level).
 *
 * Имена агентов и моделей нейтральные. Файлы — только тикет во временном каталоге ОС.
 *
 * Запуск: node --import ./src/tests/_rails-home.mjs --test src/tests/stage-selection.test.mjs
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  isGoverned, governedLists, flattenSurvivors, computeBands, levelOf, ticketFloor, capFloor, walkOrder,
  parseRequiredLevel, selectionTicket, buildSelectionPrompt, parseFactsOutput, stageCandidates, factLine,
  DESCRIPTION_LIMIT, loadStageFacts, factsOf,
} from '../lib/stage-selection.mjs';
import { gradeRuns } from '../lib/agent-runs.mjs';

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-selection-'));
after(() => fs.rmSync(BASE, { recursive: true, force: true }));

describe('полосы уровней', () => {
  const bands = computeBands([10, 20, 60, null], 5);

  it('равная ширина между min и max, max — N, min — 1, без оценки — 1', () => {
    assert.deepEqual(bands, { min: 10, max: 60, N: 5, w: 10 });
    assert.equal(levelOf(bands, 10), 1);
    assert.equal(levelOf(bands, 19.9), 1);
    assert.equal(levelOf(bands, 20), 2);
    assert.equal(levelOf(bands, 49.9), 4);
    assert.equal(levelOf(bands, 50), 5);
    assert.equal(levelOf(bands, 60), 5);
    assert.equal(levelOf(bands, null), 1);
  });

  it('ниже min — 0, выше max — N', () => {
    assert.equal(levelOf(bands, 5), 0);
    assert.equal(levelOf(bands, 99), 5);
  });

  it('полосы нулевой ширины — уровень N; оценок нет — все 1', () => {
    const flat = computeBands([30, 30], 4);
    assert.equal(levelOf(flat, 30), 4);
    assert.equal(levelOf(flat, null), 1);
    const none = computeBands([null, null], 4);
    assert.deepEqual(none, { min: null, max: null, N: 4, w: 0 });
    assert.equal(levelOf(none, 42), 1);
  });

  it('реальные оценки поставляемого списка: haiku 1, sonnet 4, opus 5', () => {
    const real = computeBands([16.9, 38.2, 50.8], 5);
    assert.equal(levelOf(real, 16.9), 1);
    assert.equal(levelOf(real, 38.2), 4);
    assert.equal(levelOf(real, 50.8), 5);
  });
});

// Журнал: запуск исполнителя, затем (по желанию) контроль и ревью.
function run(agent, extra = {}) {
  return { type: 'run', skill: 'execute-task', ticket: 'IMPL-1', agent, model: `m-${agent}`, status: 'ok', changed_files: 2, ...extra };
}

describe('нижняя граница тикета', () => {
  const bands = computeBands([10, 60], 5);
  const scores = { 'agent-a': 10, 'agent-b': 30, 'agent-c': 55, 'agent-d': 45, 'agent-e': 45 };
  const scoreOf = (r) => (Object.hasOwn(scores, r.agent) ? { known: true, score: scores[r.agent] } : { known: false });

  it('считает refused, empty, artifacts_failed, review_failed; история без id', () => {
    const events = [
      run('agent-a', { status: 'blocked' }),
      run('agent-a', { changed_files: 0 }),
      run('agent-b'), { type: 'verify', ticket: 'IMPL-1', status: 'failed', fail_reasons: ['x'] },
      run('agent-d'), { type: 'verify', ticket: 'IMPL-1', status: 'passed' }, { type: 'review', ticket: 'IMPL-1', status: 'failed' },
    ];
    const graded = gradeRuns(events);
    assert.deepEqual(graded.map((r) => r.grade), ['refused', 'empty', 'artifacts_failed', 'review_failed']);
    const result = ticketFloor(graded, 'IMPL-1', scoreOf, bands);
    assert.equal(result.floor, 4);
    assert.equal(result.executorRuns, 4);
    assert.deepEqual(result.history, [
      { level: 1, outcome: 'refused' }, { level: 1, outcome: 'empty' },
      { level: 3, outcome: 'artifacts_failed' }, { level: 4, outcome: 'review_failed' },
    ]);
    assert.ok(!JSON.stringify(result.history).includes('agent-'), 'в истории нет id');
  });

  it('отказ формы FIX-032 (status: ok, result_status: blocked, 3 файла) — refused, поднимает границу', () => {
    const graded = gradeRuns([run('agent-c', { result_status: 'blocked', changed_files: 3 })]);
    assert.equal(graded[0].grade, 'refused');
    assert.equal(ticketFloor(graded, 'IMPL-1', scoreOf, bands).floor, 5);
  });

  it('не считает crashed, crashed_after_work, throttled, stopped, pending и запуски до reset', () => {
    const events = [
      run('agent-c', { status: 'error', changed_files: 0 }),
      run('agent-c', { status: 'error', changed_files: 2 }), { type: 'verify', ticket: 'IMPL-1', status: 'failed', fail_reasons: ['x'] },
      run('agent-c', { status: 'rate_limit', changed_files: 0 }),
      run('agent-c', { status: 'model_banned', changed_files: 0 }),
      run('agent-c'),
      run('agent-d', { changed_files: 0 }),
      { type: 'reset', model: 'm-agent-d' },
    ];
    const graded = gradeRuns(events);
    assert.deepEqual(graded.map((r) => r.grade), ['crashed', 'artifacts_failed', 'throttled', 'stopped', 'pending']);
    assert.equal(graded[1].crashed_after_work, true);
    assert.equal(ticketFloor(graded, 'IMPL-1', scoreOf, bands).floor, 0);
  });

  it('другой тикет не считается; агент без факта — оценка события, без неё — пропуск', () => {
    const graded = gradeRuns([
      run('agent-c', { ticket: 'IMPL-2', changed_files: 0 }),
      run('gone-agent', { changed_files: 0, score: 30 }),
      run('lost-agent', { changed_files: 0 }),
    ]);
    const byEvent = (r) => (Object.hasOwn(r, 'score') ? { known: true, score: r.score } : scoreOf(r));
    const result = ticketFloor(graded, 'IMPL-1', byEvent, bands);
    assert.equal(result.floor, 3);
    assert.deepEqual(result.skipped, ['lost-agent']);
  });

  it('модель без оценки — уровень 1; нет тикета — граница 0', () => {
    const graded = gradeRuns([run('agent-x', { changed_files: 0 })]);
    assert.equal(ticketFloor(graded, 'IMPL-1', () => ({ known: true, score: null }), bands).floor, 1);
    assert.equal(ticketFloor(graded, null, scoreOf, bands).floor, 0);
  });

  it('граница не выше maxLevel − 1: сильнейший уровень остаётся', () => {
    assert.equal(capFloor(5, 5), 4);
    assert.equal(capFloor(2, 5), 2);
    assert.equal(capFloor(3, 1), 0);
  });
});

describe('порядок обхода', () => {
  const levels = { 'free-1': 1, 'paid-2': 2, 'free-4': 4, 'paid-4': 4, 'paid-3': 3, 'free-3': 3, 'free-5': 5 };
  const survivors = Object.keys(levels);
  const base = { survivors, levelOf: (id) => levels[id], freeOf: (id) => id.startsWith('free') };

  it('бесплатные ≥ R по возрастанию, затем платные ≥ R, затем хвост по убыванию, бесплатные первыми', () => {
    assert.deepEqual(walkOrder({ ...base, R: 3, floor: 0 }),
      ['free-3', 'free-4', 'free-5', 'paid-3', 'paid-4', 'paid-2', 'free-1']);
  });

  it('бесплатный уровня 4 — раньше платного уровня 2 при R = 2', () => {
    const order = walkOrder({ ...base, R: 2, floor: 0 });
    assert.ok(order.indexOf('free-4') < order.indexOf('paid-2'), order.join(', '));
  });

  it('хвост: в уровне бесплатные раньше платных', () => {
    assert.deepEqual(walkOrder({ ...base, R: 5, floor: 0 }),
      ['free-5', 'free-4', 'paid-4', 'free-3', 'paid-3', 'paid-2', 'free-1']);
  });

  it('R не выше границы поднимается до границы + 1; уровни не выше границы выпадают', () => {
    assert.deepEqual(walkOrder({ ...base, R: 1, floor: 3 }), ['free-4', 'free-5', 'paid-4']);
    assert.deepEqual(walkOrder({ ...base, R: null, floor: 0 }), walkOrder({ ...base, R: 1, floor: 0 }));
  });

  it('внутри уровня: не запускавшиеся, затем ранжир, затем порядок списка', () => {
    const same = { survivors: ['a-1', 'a-2', 'a-3', 'a-4'], levelOf: () => 2, freeOf: () => false };
    assert.deepEqual(walkOrder({ ...same, R: 2, floor: 0 }), ['a-1', 'a-2', 'a-3', 'a-4']);
    assert.deepEqual(walkOrder({ ...same, R: 2, floor: 0, ranking: ['a-3', 'a-2'] }), ['a-3', 'a-2', 'a-1', 'a-4']);
    assert.deepEqual(walkOrder({ ...same, R: 2, floor: 0, ranking: ['a-3', 'a-2'], notRun: new Set(['a-4', 'a-2']) }),
      ['a-2', 'a-4', 'a-3', 'a-1']);
  });

  it('выход — всегда перестановка выживших над границей', () => {
    for (const R of [null, 1, 2, 3, 4, 5, 9]) {
      for (const floor of [0, 1, 2, 4]) {
        const order = walkOrder({ ...base, R, floor, ranking: ['paid-3', 'unknown-id'] });
        assert.deepEqual([...order].sort(), survivors.filter((id) => levels[id] > floor).sort(), `R=${R} floor=${floor}`);
      }
    }
  });
});

describe('ответ селектора', () => {
  it('required_level: целое 1..N; вне диапазона и не целое — null', () => {
    assert.equal(parseRequiredLevel('3', 5), 3);
    assert.equal(parseRequiredLevel(' 5 ', 5), 5);
    for (const bad of ['0', '6', '2.5', 'two', '', null, undefined, '-1']) assert.equal(parseRequiredLevel(bad, 5), null, String(bad));
  });
});

describe('тикет и промпт селектора', () => {
  const ticketFile = path.join(BASE, 'IMPL-1.md');
  fs.writeFileSync(ticketFile, [
    '---',
    'id: IMPL-1',
    'title: "Нейтральный тикет"',
    'priority: 2',
    'type: impl',
    'required_capabilities: [mcp]',
    'context:',
    '  files: [a.js, b.js, c.js]',
    '  references: [doc-1]',
    '  notes: "короткие заметки"',
    'tags: [tag-a]',
    '---',
    '## Описание',
    '',
    '<!-- комментарий шаблона -->',
    'Описание задачи.',
    '',
    '## Детали задачи',
    '',
    'X'.repeat(3000),
    '',
    '## Критерии готовности (Definition of Done)',
    '',
    '- [ ] пункт один',
    '',
    '## Результат выполнения',
    '',
  ].join('\n'));

  it('поля тикета: frontmatter, описание до DoD с обрезкой, счётчики context, история', () => {
    const ticket = selectionTicket(ticketFile, { id: 'IMPL-1', type: 'impl', executorRuns: 2, floorLevel: 1, history: [{ level: 1, outcome: 'refused' }] });
    assert.equal(ticket.title, 'Нейтральный тикет');
    assert.equal(ticket.priority, 2);
    assert.equal(ticket.complexity, 'medium');
    assert.deepEqual(ticket.required_capabilities, ['mcp']);
    assert.deepEqual(ticket.tags, ['tag-a']);
    assert.ok(ticket.description.startsWith('## Описание'), ticket.description.slice(0, 40));
    assert.ok(!ticket.description.includes('комментарий шаблона'));
    assert.equal(ticket.description.length, DESCRIPTION_LIMIT);
    assert.ok(ticket.description.endsWith('…'));
    assert.equal(ticket.dod, '- [ ] пункт один');
    assert.equal(ticket.notes, 'короткие заметки');
    assert.equal(ticket.files, 3);
    assert.equal(ticket.references, 1);
    assert.equal(ticket.executor_runs, 2);
    assert.equal(ticket.floor_level, 1);
    assert.deepEqual(ticket.history, [{ level: 1, outcome: 'refused' }]);
  });

  it('нет файла — пустые поля и complexity по умолчанию', () => {
    const ticket = selectionTicket(path.join(BASE, 'missing.md'), { id: 'IMPL-9', type: 'impl' });
    assert.equal(ticket.title, '');
    assert.equal(ticket.description, '');
    assert.equal(ticket.complexity, 'medium');
    assert.equal(ticket.files, 0);
  });

  it('промпт: JSON-блок только с переданными кандидатами, без цен и причин отсева', () => {
    const candidates = [
      { id: 'pool-x@vendor-a/model-one:free', kind: 'pool_member', free: true, level: 3, scores: { intelligence: 33, coding: 60, agentic: 40 } },
      { id: 'agent-b', kind: 'agent', free: false, level: 1, scores: null },
    ];
    const prompt = buildSelectionPrompt({ stage: 'stage-a', ticket: { id: 'IMPL-1', history: [{ level: 1, outcome: 'empty' }] }, levels: ['l1', 'l2', 'l3'], candidates, citation: 'Source: test' });
    const block = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(prompt)[1]);
    assert.equal(block.mode, 'models');
    assert.equal(block.stage, 'stage-a');
    assert.deepEqual(block.levels, ['l1', 'l2', 'l3']);
    assert.deepEqual(block.candidates, candidates);
    assert.equal(block.scores_citation, 'Source: test');
    assert.match(prompt, /required_level/);
    assert.doesNotMatch(prompt, /price|pricing|unhealthy|banned|prompt\b/i);
  });
});

describe('вывод команды фактов', () => {
  it('факты по id и хосту; числа — только конечные; free — только true', () => {
    const parsed = parseFactsOutput(JSON.stringify({
      as_of: 'a', citation: 'c',
      models: [
        { id: 'vendor-a/model-one', host: 'kilo', resolved: 'vendor-a/model-one-20260101', intelligence: 30, coding: 'x', agentic: null, free: true, free_source: 'kilo' },
        { id: 'vendor-a/model-one', host: 'claude', intelligence: 31, free: 'yes' },
        { id: 'vendor-a/model-one', host: 'kilo', intelligence: 99 },
        { nope: true },
      ],
    }));
    assert.equal(parsed.as_of, 'a');
    assert.equal(parsed.facts.size, 2);
    assert.deepEqual(parsed.facts.get('vendor-a/model-one\u0000kilo'), {
      id: 'vendor-a/model-one', host: 'kilo', resolved: 'vendor-a/model-one-20260101',
      intelligence: 30, coding: null, agentic: null, free: true, free_source: 'kilo',
    });
    assert.equal(parsed.facts.get('vendor-a/model-one\u0000claude').free, false);
    assert.equal(parsed.facts.get('vendor-a/model-one\u0000claude').free_source, 'unknown');
  });

  it('не JSON или без models — причина', () => {
    for (const bad of ['not json', '{}', '{"models": {}}', '[]']) {
      assert.equal(parseFactsOutput(bad).reason, 'output is not JSON with "models" array', bad);
    }
  });
});

describe('стадия под выбором и её кандидаты', () => {
  const stage = {
    selection: { selector: 's', scores: ['x'], levels: ['a', 'b'] },
    agents: ['pool-x', 'agent-a', 'pool-x'],
    agents_by_type: {
      qa: { agents: ['agent-b', 'agent-a'] },
      docs: { agents: ['agent-c'], selection: false },
      fix: { selection: false },
    },
  };
  const pipeline = {
    default_agents: ['agent-z'],
    agents: {
      'pool-x': { command: 'kilo', args: ['-m', '{model}', 'run'], models: { list: ['x'], match: ['.'] } },
      'pool-x@vendor-a/m-1': { command: 'kilo', args: ['-m', 'vendor-a/m-1', 'run'], pool: 'pool-x' },
      'pool-x@vendor-a/m-2': { command: 'kilo', args: ['-m', 'vendor-a/m-2', 'run'], pool: 'pool-x' },
      'agent-a': { command: 'claude', args: ['--model', 'model-a', '-p'] },
      'agent-b': { command: 'node', args: ['x.js'] },
      'agent-c': { command: 'claude', args: ['--model', 'model-c'] },
    },
  };

  it('isGoverned: стадия с selection, тип с selection: false — нет', () => {
    assert.equal(isGoverned(stage, 'impl'), true);
    assert.equal(isGoverned(stage, 'qa'), true);
    assert.equal(isGoverned(stage, 'docs'), false);
    assert.equal(isGoverned(stage, 'fix'), false);
    assert.equal(isGoverned(stage, null), true);
    assert.equal(isGoverned({ agents: ['a'] }, 'impl'), false);
  });

  it('списки под выбором и кандидаты: пулы — участниками, повтор — один раз', () => {
    assert.deepEqual(governedLists(pipeline, stage), [stage.agents, stage.agents_by_type.qa.agents]);
    assert.deepEqual(governedLists(pipeline, { ...stage, agents: undefined }), [pipeline.default_agents, stage.agents_by_type.qa.agents]);
    assert.deepEqual(stageCandidates(pipeline, stage), ['pool-x@vendor-a/m-1', 'pool-x@vendor-a/m-2', 'agent-a', 'agent-b']);
  });

  it('строка фактов: id модели и хост; без id модели — null', () => {
    assert.deepEqual(factLine(pipeline.agents['pool-x@vendor-a/m-1']), { id: 'vendor-a/m-1', host: 'kilo' });
    assert.deepEqual(factLine(pipeline.agents['agent-a']), { id: 'model-a', host: 'claude' });
    assert.equal(factLine(pipeline.agents['agent-b']), null);
  });

  it('flattenSurvivors: место-пул — участники, пул дважды — на первой позиции', () => {
    const out = flattenSurvivors(['agent-a', 'pool-x', 'agent-b', 'pool-x'], {
      isPool: (id) => id === 'pool-x',
      membersOf: () => ['pool-x@vendor-a/m-2', 'pool-x@vendor-a/m-1'],
    });
    assert.deepEqual(out, [
      { id: 'agent-a', pool: null },
      { id: 'pool-x@vendor-a/m-2', pool: 'pool-x' },
      { id: 'pool-x@vendor-a/m-1', pool: 'pool-x' },
      { id: 'agent-b', pool: null },
    ]);
  });
});

// Ревью 2026-09-28, третий раунд: ни у одного кандидата нет id модели — команда фактов не
// запускается. Пустой stdin model-scores.js принимал за прежний режим пула, и ответ без
// `models` раннер записывал в сбой команды.
describe('факты стадии без id моделей', () => {
  it('команда не запускается, предупреждения о сбое нет, кандидаты без оценок и платные', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-facts-empty-'));
    const marker = path.join(dir, 'called');
    const pipeline = {
      agents: {
        'agent-a': { command: 'claude', args: ['-p'] },
        'agent-b': { command: 'node', args: ['x.js'] },
      },
      stages: {
        s1: {
          selection: { selector: 'sel', scores: [process.execPath, '-e', `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`], levels: ['a', 'b'] },
          agents: ['agent-a', 'agent-b'],
        },
      },
    };
    const lines = [];
    const logger = { info: (m) => lines.push(`INFO ${m}`), warn: (m) => lines.push(`WARN ${m}`), error: (m) => lines.push(`ERROR ${m}`) };
    try {
      await loadStageFacts(pipeline, { projectRoot: dir, logger });
      assert.equal(fs.existsSync(marker), false, 'команда фактов запускалась');
      assert.ok(!lines.some((l) => l.includes('selection.scores failed')), lines.join('\n'));
      assert.equal(factsOf(pipeline, 's1', 'agent-a'), null, 'фактов у кандидата без id модели нет — без оценки и платный');
      assert.ok(lines.some((l) => l.startsWith('INFO FACTS stage="s1" candidates=2 scored=0 free=0 ')), lines.join('\n'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
