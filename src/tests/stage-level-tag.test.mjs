/**
 * Тег минимального уровня у места списка стадии (`free-kilo[medium]`) — чистая логика:
 * разбор и печать места (parsePlace/formatPlace, src/lib/model-pools.mjs), ступень
 * кандидата (levelTierOf) и порядок обхода со ступенями (walkOrder) —
 * src/lib/stage-selection.mjs.
 *
 * Что охраняется:
 *  - parsePlace: тег, отсутствие тега, неизвестное слово уровня (invalid, не бросает),
 *    пробелы вокруг id и уровня; formatPlace — обратно к записи места;
 *  - levelTierOf: 0 — тега нет или уровень подтверждён и не ниже требуемого, 1 — уровня
 *    нет (неоценённый — середина очереди), 2 — уровень подтверждён и ниже требуемого
 *    (последний резерв);
 *  - walkOrder со ступенями: все ступени 0 — прежними группами, затем ступень 1, затем
 *    ступень 2; внутри ступени — уровень по убыванию, бесплатные раньше, незапускавшиеся
 *    раньше, ранжир селектора, порядок списка; без tierOf поведение прежнее;
 *  - список стадии с тегом не теряет кандидатов: governedLists отдаёт базовые id, а
 *    stageCandidates находит пул и агента.
 *
 * Имена агентов, пулов и моделей нейтральные; файлов тест не пишет.
 *
 * Запуск: node --import ./src/tests/_rails-home.mjs --test src/tests/stage-level-tag.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parsePlace, formatPlace } from '../lib/model-pools.mjs';
import { levelTierOf, walkOrder, governedLists, stageCandidates } from '../lib/stage-selection.mjs';
import { LEVELS } from '../lib/model-facts.mjs';

describe('parsePlace / formatPlace', () => {
  it('тег, отсутствие тега, лишние пробелы', () => {
    assert.deepEqual(parsePlace('free-kilo[medium]'), { id: 'free-kilo', minLevel: 'medium' });
    assert.deepEqual(parsePlace('free-kilo'), { id: 'free-kilo', minLevel: null });
    assert.equal(parsePlace('free-kilo').invalid, undefined);
    assert.deepEqual(parsePlace(' free-kilo [ medium ] '), { id: 'free-kilo', minLevel: 'medium' });
    for (const level of LEVELS) assert.deepEqual(parsePlace(`x[${level}]`), { id: 'x', minLevel: level });
  });

  it('неизвестное слово уровня — invalid, тег считается отсутствующим, не бросает', () => {
    assert.deepEqual(parsePlace('free-kilo[superb]'), { id: 'free-kilo', minLevel: null, invalid: 'superb' });
    assert.deepEqual(parsePlace('free-kilo[]'), { id: 'free-kilo', minLevel: null, invalid: '' });
    assert.deepEqual(parsePlace('free-kilo[ MID ]'), { id: 'free-kilo', minLevel: null, invalid: 'MID' });
  });

  it('повреждённый синтаксис скобок — invalid (место не запускается молча)', () => {
    assert.deepEqual(parsePlace('a[medium'), { id: 'a', minLevel: null, invalid: 'a[medium' }, 'нет закрывающей скобки');
    assert.deepEqual(parsePlace('a[medium]garbage['), { id: 'a', minLevel: null, invalid: 'a[medium]garbage[' }, 'посторонние символы');
    assert.deepEqual(parsePlace('a]'), { id: 'a', minLevel: null, invalid: 'a]' }, 'закрывающая скобка без открывающей');
    assert.deepEqual(parsePlace('a[b][c]'), { id: 'a', minLevel: null, invalid: 'a[b][c]' }, 'двойной тег');
  });

  it('formatPlace — обратно к записи места', () => {
    assert.equal(formatPlace('free-kilo', 'medium'), 'free-kilo[medium]');
    assert.equal(formatPlace('free-kilo', null), 'free-kilo');
    for (const level of LEVELS) assert.equal(parsePlace(formatPlace('x', level)).minLevel, level);
  });
});

describe('levelTierOf — ступень кандидата', () => {
  it('0 — нет тега или уровень не ниже; 1 — уровня нет; 2 — уровень ниже требуемого', () => {
    assert.equal(levelTierOf(null, null), 0);
    assert.equal(levelTierOf('low', null), 0, 'без тега порядок не меняется');
    assert.equal(levelTierOf('high', null), 0);
    assert.equal(levelTierOf('medium', 'medium'), 0);
    assert.equal(levelTierOf('high', 'medium'), 0);
    assert.equal(levelTierOf(null, 'medium'), 1, 'неоценённый — середина');
    assert.equal(levelTierOf('low', 'medium'), 2);
    assert.equal(levelTierOf('low', 'high'), 2);
  });
});

describe('walkOrder со ступенями тега', () => {
  const levels = { a: 1, b: 3, c: 2, d: 4, e: 1 };
  const free = { a: true, b: false, c: true, d: false, e: false };
  const tiers = { a: 0, b: 0, c: 1, d: 0, e: 2 };
  const survivors = Object.keys(levels);
  const base = { survivors, levelOf: (id) => levels[id], freeOf: (id) => free[id] };

  it('ступень 0 — прежними группами; затем ступень 1 (середина), затем ступень 2 (конец)', () => {
    // R = 2: b(3)/d(4) — платные ≥ R по возрастанию; a(1) — хвост; c — ступень 1; e — ступень 2.
    assert.deepEqual(walkOrder({ ...base, tierOf: (id) => tiers[id], R: 2, floor: 0 }), ['b', 'd', 'a', 'c', 'e']);
  });

  it('без tierOf — прежнее поведение (все ступень 0)', () => {
    // Все ступень 0: бесплатный c(2) ≥ R, затем платные b(3), d(4), затем хвост a(1, free), e(1).
    assert.deepEqual(walkOrder({ ...base, R: 2, floor: 0 }), ['c', 'b', 'd', 'a', 'e']);
    assert.deepEqual(walkOrder({ ...base, R: 2, floor: 0 }), walkOrder({ ...base, tierOf: () => 0, R: 2, floor: 0 }));
  });

  it('внутри ступени: ранжир селектора, затем порядок списка', () => {
    const same = { survivors: ['p1', 'p2', 'p3', 'p4'], levelOf: () => 2, freeOf: () => false };
    const t = { p1: 1, p2: 1, p3: 2, p4: 1 };
    assert.deepEqual(
      walkOrder({ ...same, tierOf: (id) => t[id], R: 1, floor: 0, ranking: ['p4', 'p2'] }),
      ['p4', 'p2', 'p1', 'p3'],
    );
  });

  it('ступени вместе с notRun и настоящим floor: фильтр по границе и незапускавшиеся в ступени', () => {
    const lv = { x: 1, y: 4, z: 2, w: 3, v: 2 };
    const t = { x: 2, y: 0, z: 1, w: 0, v: 1 };
    const order = walkOrder({
      survivors: Object.keys(lv), levelOf: (id) => lv[id], freeOf: () => false,
      tierOf: (id) => t[id], R: 1, floor: 1, notRun: new Set(['v']),
    });
    // floor=1 отсекает x(1); ступень 0 — w(3), y(4); ступень 1 — v(2, незапускавшийся) раньше z(2).
    assert.deepEqual(order, ['w', 'y', 'v', 'z']);
    assert.deepEqual([...order].sort(), ['v', 'w', 'y', 'z'], 'перестановка выживших над границей');
  });

  it('выход — всегда перестановка выживших над границей', () => {
    for (const R of [null, 1, 3]) {
      for (const floor of [0, 1]) {
        const order = walkOrder({ ...base, tierOf: (id) => tiers[id], R, floor });
        assert.deepEqual([...order].sort(), survivors.filter((id) => levels[id] > floor).sort(), `R=${R} floor=${floor}`);
      }
    }
  });
});

describe('список стадии с тегом не теряет кандидатов', () => {
  const pipeline = {
    agents: {
      'pool-x': { command: 'kilo', args: ['-m', '{model}', 'run'], models: { list: ['x'], match: ['.'] } },
      'pool-x@vendor-a/m-1': { pool: 'pool-x' },
      'pool-x@vendor-a/m-2': { pool: 'pool-x' },
      'agent-a': { command: 'claude', args: ['--model', 'model-a'] },
    },
  };
  const stage = {
    selection: { selector: 's', scores: ['x'], levels: ['a', 'b'] },
    agents: ['pool-x[medium]', 'agent-a[high]', 'agent-a'],
  };

  it('governedLists отдаёт базовые id, stageCandidates находит пул и агента', () => {
    assert.deepEqual(governedLists(pipeline, stage), [['pool-x', 'agent-a', 'agent-a']]);
    assert.deepEqual(stageCandidates(pipeline, stage), ['pool-x@vendor-a/m-1', 'pool-x@vendor-a/m-2', 'agent-a']);
  });

  it('пул с тегом в agents_by_type.<тип> (qa) не теряет кандидатов', () => {
    const qaStage = { selection: { selector: 's', scores: ['x'], levels: ['a', 'b'] }, agents: ['agent-a'], agents_by_type: { qa: { agents: ['pool-x[high]', 'agent-a'] } } };
    assert.deepEqual(governedLists(pipeline, qaStage), [['agent-a'], ['pool-x', 'agent-a']]);
    assert.deepEqual(stageCandidates(pipeline, qaStage), ['agent-a', 'pool-x@vendor-a/m-1', 'pool-x@vendor-a/m-2']);
  });
});
