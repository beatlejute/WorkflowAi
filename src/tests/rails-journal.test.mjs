import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { appendDenial, appendEvent, readJournal, summarize } from '../rails/journal.mjs';

function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'rails-journal-'));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('appendDenial: пишет jsonl-строку с type=denial и полями skill/node', () => {
  withRoot((root) => {
    appendDenial(root, { session: 's1', skill: 'coach', node: 'P4S2', reason: 'нет ребра' });
    const raw = readFileSync(join(root, '.workflow', 'logs', 'rails-denials.jsonl'), 'utf8');
    const lines = raw.trim().split('\n');
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.type, 'denial');
    assert.equal(entry.skill, 'coach');
    assert.equal(entry.node, 'P4S2');
    assert.ok(entry.t);
  });
});

test('appendDenial: не даёт полю type в entry переопределить "denial"', () => {
  withRoot((root) => {
    appendDenial(root, { skill: 'coach', node: 'P1S1', type: 'something-else' });
    const [entry] = readJournal(root);
    assert.equal(entry.type, 'denial');
  });
});

test('appendEvent: пишет произвольный тип события', () => {
  withRoot((root) => {
    appendEvent(root, { type: 'reset', session: 's1', skill: 'coach' });
    appendEvent(root, { type: 'error', message: 'boom' });
    const entries = readJournal(root);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].type, 'reset');
    assert.equal(entries[1].type, 'error');
  });
});

test('readJournal: без файла -> пустой массив', () => {
  withRoot((root) => {
    assert.deepEqual(readJournal(root), []);
  });
});

test('readJournal: пропускает повреждённые строки', () => {
  withRoot((root) => {
    const dir = join(root, '.workflow', 'logs');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'rails-denials.jsonl');
    writeFileSync(
      file,
      ['{"type":"denial","skill":"coach","node":"P1S1"}', '{not valid json', '', '{"type":"reset"}'].join(
        '\n'
      ) + '\n',
      'utf8'
    );
    const entries = readJournal(root);
    assert.equal(entries.length, 2);
  });
});

test('readJournal: пропускает валидный JSON, но не объект (null, число, строка, массив)', () => {
  withRoot((root) => {
    const dir = join(root, '.workflow', 'logs');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'rails-denials.jsonl');
    writeFileSync(
      file,
      [
        'null',
        '42',
        '"просто строка"',
        '[1,2,3]',
        '{"type":"denial","skill":"coach","node":"P1S1"}',
      ].join('\n') + '\n',
      'utf8'
    );
    const entries = readJournal(root);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].node, 'P1S1');
  });
});

test('readJournal: фильтр по skill', () => {
  withRoot((root) => {
    appendDenial(root, { skill: 'coach', node: 'P1S1' });
    appendDenial(root, { skill: 'other-skill', node: 'P1S1' });
    const entries = readJournal(root, { skill: 'coach' });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].skill, 'coach');
  });
});

// minor-находка ревью: записи без поля skill (reset/error/stop_block,
// записанные без него) раньше молча выпадали из отчёта по конкретному
// скилу — фильтр исключает только записи с ЯВНО другим skill.
test('readJournal: фильтр по skill не отбрасывает записи без поля skill', () => {
  withRoot((root) => {
    appendEvent(root, { type: 'reset', session: 's1' }); // без skill
    appendDenial(root, { skill: 'other-skill', node: 'P1S1' });
    appendDenial(root, { skill: 'coach', node: 'P1S1' });
    const entries = readJournal(root, { skill: 'coach' });
    assert.equal(entries.length, 2);
    assert.ok(entries.some((e) => e.type === 'reset'));
    assert.ok(entries.some((e) => e.skill === 'coach'));
    assert.ok(!entries.some((e) => e.skill === 'other-skill'));
  });
});

test('readJournal: фильтр по days отсекает старые записи', () => {
  withRoot((root) => {
    const dir = join(root, '.workflow', 'logs');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'rails-denials.jsonl');
    const old = new Date(Date.now() - 10 * 86400000).toISOString();
    const recent = new Date().toISOString();
    writeFileSync(
      file,
      [
        JSON.stringify({ t: old, type: 'denial', skill: 'coach', node: 'P1S1' }),
        JSON.stringify({ t: recent, type: 'denial', skill: 'coach', node: 'P1S1' }),
      ].join('\n') + '\n',
      'utf8'
    );
    const entries = readJournal(root, { days: 3 });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].t, recent);
  });
});

test('summarize: отказы по узлу и узлы с >=3 повторами в одной сессии', () => {
  withRoot((root) => {
    appendDenial(root, { session: 's1', skill: 'coach', node: 'P4S2' });
    appendDenial(root, { session: 's1', skill: 'coach', node: 'P4S2' });
    appendDenial(root, { session: 's1', skill: 'coach', node: 'P4S2' });
    appendDenial(root, { session: 's2', skill: 'coach', node: 'P4S2' });
    appendDenial(root, { session: 's1', skill: 'coach', node: 'P5R1' });

    const entries = readJournal(root);
    const s = summarize(entries);

    assert.equal(s.total, 5);
    assert.equal(s.denialsByNode['P4S2'], 4);
    assert.equal(s.denialsByNode['P5R1'], 1);
    assert.equal(s.repeatedNodes.length, 1);
    assert.deepEqual(s.repeatedNodes[0], { node: 'P4S2', session: 's1', count: 3 });
  });
});

test('summarize: потолки, сбросы, Stop-блоки, ошибки хука', () => {
  withRoot((root) => {
    appendEvent(root, { type: 'reset', session: 's1' });
    appendEvent(root, { type: 'reset', session: 's2' });
    appendEvent(root, { type: 'error', message: 'boom' });
    appendEvent(root, { type: 'stop_block', node: 'P8S1' });
    appendEvent(root, { type: 'stop_block', node: 'P8S1' });
    appendEvent(root, { type: 'cycle_limit', key: 'cycle:5>4' });
    appendEvent(root, { type: 'action_limit', key: 'action:run_tests' });

    const s = summarize(readJournal(root));
    assert.equal(s.resets, 2);
    assert.equal(s.errors, 1);
    assert.equal(s.stopBlocks.total, 2);
    assert.equal(s.stopBlocks.byNode['P8S1'], 2);
    assert.equal(s.cycleLimitHits['cycle:5>4'], 1);
    assert.equal(s.actionLimitHits['action:run_tests'], 1);
  });
});

test('summarize: на пустом массиве не падает', () => {
  const s = summarize([]);
  assert.equal(s.total, 0);
  assert.deepEqual(s.denialsByNode, {});
  assert.deepEqual(s.repeatedNodes, []);
});

test('summarize: не падает на мусоре в entries (null, число, массив вперемешку с записями)', () => {
  const entries = [null, 42, ['x'], { type: 'denial', session: 's1', node: 'P1S1' }];
  assert.doesNotThrow(() => {
    const s = summarize(entries);
    assert.equal(s.denialsByNode['P1S1'], 1);
  });
});

// minor-находка ревью: total считал и мусорные (не-объектные) элементы,
// которые дальше пропускаются, — раздувая счётчик обработанных записей.
test('summarize: total считает только фактически обработанные (объектные) записи, не мусор', () => {
  const entries = [null, 42, 'строка', { type: 'denial', session: 's1', node: 'P1S1' }];
  const s = summarize(entries);
  assert.equal(s.total, 1);
});

// minor-находка ревью: summarize(null) падал ("not iterable") — не выполнен
// критерий "модуль не падает на плохом входе".
test('summarize: null вместо entries не бросает, трактуется как пустой журнал', () => {
  assert.doesNotThrow(() => {
    const s = summarize(null);
    assert.equal(s.total, 0);
  });
});

test('summarize: repeatedNodes разделяет одноимённые узлы разных сессий (регресс склейки ключа)', () => {
  // Раньше ключ session+node склеивался в одну строку — здесь проверяется,
  // что подсчёт по-прежнему раздельный по сессиям после перехода на
  // вложенный Map(session -> Map(node -> count)).
  const entries = [
    { type: 'denial', session: 's1', node: 'P1S1' },
    { type: 'denial', session: 's1', node: 'P1S1' },
    { type: 'denial', session: 's1', node: 'P1S1' },
    { type: 'denial', session: 's2', node: 'P1S1' },
    { type: 'denial', session: 's2', node: 'P1S1' },
  ];
  const s = summarize(entries);
  assert.equal(s.repeatedNodes.length, 1);
  assert.deepEqual(s.repeatedNodes[0], { node: 'P1S1', session: 's1', count: 3 });
});
