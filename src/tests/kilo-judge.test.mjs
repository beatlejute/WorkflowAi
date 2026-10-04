import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { judge, extractVerdict, copyImages, buildKiloPrompt, resolveKilo } from '../scripts/kilo-judge.js';

// Судья без вызова провайдера: run-функция подставляет результат процесса
// (анализ «coach» 2026-10-04: сбой, эхо промпта и вывод инструментов не дают вердикт —
// принимается только строка VERDICT: <балл> / <одноразовый маркер этого запуска>;
// источник строки не доказывается — модель может напечатать маркер и в середине
// транскрипта, это записанное ограничение, а не гарантия «только финальный ответ»).

const JUDGE_PROMPT = `## Rubric
- Criterion: test
- score: 5 if ok; score: 1 if not.

## Target Agent Output
Claims: done.

## Task
Judge.

Please evaluate the output
`;

// Извлекает одноразовый маркер из промпта, который judge передал run-функции.
function tokenOf(prompt) {
  const m = String(prompt).match(/\/ ([0-9a-f]{12})\s*$/);
  assert.ok(m, 'промпт обязан кончаться требованием VERDICT / <маркер>');
  return m[1];
}

test('kilo-judge: ненулевой exit — agent_error, «score:» из сбойного вывода не становится вердиктом', async () => {
  await assert.rejects(
    judge({ model: 'm' }, JUDGE_PROMPT, async (opts, cwd, prompt) => {
      assert.match(prompt, /VERDICT: <итоговый балл от 1 до 5> \/ [0-9a-f]{12}/);
      return { code: 1, stdout: '', stderr: 'prompt echo: score: 5\nprovider failed' };
    }),
    (err) => err.class === 'agent_error' && /exited 1/.test(err.message),
  );
});

test('kilo-judge: ответ без строки VERDICT/маркер — unparsed, даже если «score:» есть в обоих потоках', async () => {
  await assert.rejects(
    judge({ model: 'm' }, JUDGE_PROMPT, async () => ({
      code: 0,
      stdout: 'score: 1\nreason: failed criterion',
      stderr: 'diagnostic echoed example score: 5',
    })),
    (err) => err.class === 'unparsed' && /VERDICT/.test(err.message),
  );
});

test('kilo-judge: вердикт берётся из финального ответа модели (маркер из промпта), эхо не мешает', async () => {
  const r = await judge({ model: 'm' }, JUDGE_PROMPT, async (opts, cwd, prompt) => {
    const token = tokenOf(prompt);
    return {
      code: 0,
      // в stdout — отрицательный вердикт без маркера, в stderr — эхо чужого примера
      stdout: 'score: 1\nreason: failed criterion',
      stderr: `tool echoed example VERDICT: 5 / deadbeefdead\nfinal answer\nVERDICT: 2 / ${token}`,
    };
  });
  assert.equal(r.score, 2);
  assert.equal(r.images, 0);
});

test('kilo-judge: вердикт с чужим или подменённым маркером не принимается', () => {
  assert.equal(extractVerdict('VERDICT: 5 / deadbeefdead', '1234abcd1234'), null);
  assert.equal(extractVerdict('VERDICT: 5', '1234abcd1234'), null);
  assert.equal(extractVerdict('VERDICT: <score> / 1234abcd1234', '1234abcd1234'), null);
  assert.equal(extractVerdict('\x1b[31mVERDICT: 4 / 1234abcd1234\x1b[0m', '1234abcd1234'), 4);
  assert.equal(extractVerdict('VERDICT: 1 / 1234abcd1234\nVERDICT: 4 / 1234abcd1234', '1234abcd1234'), 4);
});

test('kilo-judge: требование VERDICT добавляется и без изображений (prose-вопрос)', () => {
  const prompt = buildKiloPrompt(JUDGE_PROMPT, [], '1234abcd1234');
  assert.match(prompt, /VERDICT: <итоговый балл от 1 до 5> \/ 1234abcd1234$/);
  assert.equal(buildKiloPrompt(JUDGE_PROMPT, [], '1234abcd1234'), prompt);
});

test('kilo-judge: копии не перезаписывают друг друга при коллизии имён (x.png, 2-x.png, x.png)', () => {
  const src = mkdtempSync(join(tmpdir(), 'kilo-judge-src-'));
  const dst = mkdtempSync(join(tmpdir(), 'kilo-judge-dst-'));
  const resolved = new Map();
  const contents = new Map();
  for (const [mention, rel] of [['a/x.png', 'a/x.png'], ['b/2-x.png', 'b/2-x.png'], ['c/x.png', 'c/x.png']]) {
    const file = join(src, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, rel, 'utf8');
    resolved.set(mention, file);
    contents.set(mention, rel);
  }
  try {
    const copies = copyImages(resolved, dst);
    const names = copies.map(([, name]) => name);
    assert.equal(new Set(names).size, 3, 'имена копий уникальны');
    for (const [mention, name] of copies) {
      assert.equal(readFileSync(join(dst, name), 'utf8'), contents.get(mention), name);
    }
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(dst, { recursive: true, force: true });
  }
});

test('kilo-judge: --kilo перекрывает поиск по PATH', () => {
  assert.deepEqual(resolveKilo({}, 'Z:/tools/kilo'), { node: process.execPath, bin: 'Z:/tools/kilo' });
  assert.deepEqual(resolveKilo({ KILO_BIN: 'W:/kilo' }), { node: process.execPath, bin: 'W:/kilo' });
});
