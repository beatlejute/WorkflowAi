/**
 * Конвертер шкалы рубрики в пять уровней (src/lib/rubric-levels.mjs).
 *
 * Реальные рубрики канона читаются только на чтение: все 42 файла
 * src/skills/*\/tests/rubrics/*.md разбираются (2026-09-26; до этого две рубрики
 * manual-testing держали уровни списком под «## Проходной балл»).
 * Синтетические рубрики пишутся во временный каталог ОС и снимаются в after().
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rubricLevels, RubricLevelsError } from '../lib/rubric-levels.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SKILLS_DIR = join(PROJECT_ROOT, 'src', 'skills');

function canonRubrics() {
  const files = [];
  for (const skill of readdirSync(SKILLS_DIR)) {
    const dir = join(SKILLS_DIR, skill, 'tests', 'rubrics');
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      if (name.endsWith('.md') && statSync(file).isFile()) files.push(file);
    }
  }
  return files;
}

// Число рубрик меняет коуч, поэтому тест держит не счёт, а свойство: каждая
// рубрика канона разбирается в пять уровней (2026-09-26 — 42 из 42, после
// перевода двух рубрик manual-testing со списка на таблицу).
describe('rubric-levels: рубрики канона', () => {
  it('рубрика с таблицей уровней даёт пять уровней, отказ — только рубрике без таблицы', () => {
    const parsed = [];
    const failed = [];
    for (const file of canonRubrics()) {
      const name = relative(SKILLS_DIR, file).replace(/\\/g, '/');
      const text = readFileSync(file, 'utf8');
      try {
        const levels = rubricLevels(text, name);
        assert.equal(levels.length, 5, name);
        assert.ok(levels.every(level => level.length > 0 && !level.includes('**')), name);
        parsed.push(name);
      } catch (err) {
        assert.ok(err instanceof RubricLevelsError, `${name}: ${err.message}`);
        assert.ok(err.message.includes(name), err.message);
        assert.match(err.message, /no level table/, `${name}: таблица уровней неполная`);
        failed.push(name);
      }
    }

    assert.ok(parsed.length > 0, 'в каноне есть рубрики с таблицей уровней');
    // С 2026-09-26 таблица уровней есть у всех рубрик канона: рубрику без неё
    // судья Jev не читает, и её оценки молча уходят к судье эскалации по полной цене.
    assert.deepEqual(failed, [], 'все рубрики канона — с таблицей уровней');
  });
});

describe('rubric-levels: синтетические рубрики', () => {
  let root;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'wf-rubric-levels-'));
  });
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function parseFile(name, text) {
    const file = join(root, name);
    writeFileSync(file, text);
    return rubricLevels(readFileSync(file, 'utf8'), name);
  }

  it('жирные номера и жирный текст — уровни по возрастанию без ** и обрамляющих |', () => {
    const levels = parseFile('bold.md', [
      '## Шкала оценки',
      '| Балл | Описание |',
      '|------|----------|',
      '| **5** | **всё** сделано |',
      '| **4** | почти всё |',
      '| **3** | половина |',
      '| **2** | мало |',
      '| **1** | ничего |',
    ].join('\r\n'));

    assert.deepEqual(levels, ['ничего', 'мало', 'половина', 'почти всё', 'всё сделано']);
  });

  it('таблица без жирных чисел и без заголовка «Шкала»', () => {
    const levels = parseFile('plain.md', [
      '| 1 | один |', '| 2 | два |', '| 3 | три |', '| 4 | четыре |', '| 5 | пять |',
    ].join('\n'));

    assert.deepEqual(levels, ['один', 'два', 'три', 'четыре', 'пять']);
  });

  it('четыре уровня — ошибка с номером недостающего', () => {
    assert.throws(
      () => parseFile('four.md', ['| 1 | a |', '| 2 | b |', '| 3 | c |', '| 4 | d |'].join('\n')),
      (err) => err instanceof RubricLevelsError && /four\.md/.test(err.message) && /level\(s\) 5/.test(err.message),
    );
  });

  it('повтор уровня — берётся первая строка, как в пилоте Jev', () => {
    const levels = parseFile('repeat.md', [
      '| 1 | a |', '| 2 | b |', '| 3 | c |', '| 4 | d |', '| 5 | e |', '| 3 | другая тройка |',
    ].join('\n'));

    assert.equal(levels[2], 'c');
  });

  it('нет таблицы — ошибка «no level table»', () => {
    assert.throws(() => parseFile('list.md', '## Проходной балл\n\n- **5** — всё\n'), /no level table/);
  });
});
