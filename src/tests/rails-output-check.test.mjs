import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { check, lastAssistantText } from '../rails/output-check.mjs';

const CONFIG = {
  terminal: ['P8S3'],
  pause_nodes: ['P3Q1', 'P7S2'],
  output: {
    final_requires: ['RAILS:\\s*P\\d+[ERSGQ]\\d+', 'verdict\\s*=', 'Файлы:'],
  },
};

test('check: все требования выполнены и узел терминальный -> ok', () => {
  const text = 'RAILS: P8S3 сделано\nverdict=pass\nФайлы: a.js, b.js';
  const r = check(text, CONFIG, { node: 'P8S3' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.missing, []);
});

test('check: узел pause_nodes тоже допустим', () => {
  const text = 'RAILS: P3Q1\nverdict=ask\nФайлы: нет';
  const r = check(text, CONFIG, { node: 'P3Q1' });
  assert.equal(r.ok, true);
});

test('check: регистронезависимость (флаг i)', () => {
  const text = 'rails: P8S3\nVERDICT=pass\nфайлы: a.js';
  const r = check(text, CONFIG, { node: 'P8S3' });
  assert.equal(r.ok, true);
});

test('check: недостающее требование попадает в missing', () => {
  const text = 'RAILS: P8S3\nФайлы: a.js'; // нет verdict=
  const r = check(text, CONFIG, { node: 'P8S3' });
  assert.equal(r.ok, false);
  assert.ok(r.missing.includes('verdict\\s*='));
});

test('check: узел не terminal и не pause_nodes -> нарушение положения', () => {
  const text = 'RAILS: P4S2\nverdict=pass\nФайлы: a.js';
  const r = check(text, CONFIG, { node: 'P4S2' });
  assert.equal(r.ok, false);
  assert.ok(r.missing.some((m) => m.startsWith('position:')));
});

test('check: пустой текст -> все требования отсутствуют', () => {
  const r = check('', CONFIG, { node: 'P8S3' });
  assert.equal(r.ok, false);
  assert.equal(r.missing.length, 3);
});

test('check: отсутствующий output.final_requires не падает', () => {
  const r = check('что угодно', { terminal: ['P1S1'] }, { node: 'P1S1' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.missing, []);
});

test('check: suspension from any node preserves state and is not PASS', () => {
  const state = { node: 'P0E1', history: [], counters: { actions: 4 }, denials: { P0E1: 1 } };
  const before = structuredClone(state);
  for (const outcome of ['blocked', 'needs_user']) {
    const text = `RAILS_OUTCOME: ${outcome}\nACTION: owner permission\nREASON: write denied\nDONE: inspected sources\nREMAINING: apply fix`;
    assert.deepEqual(check(text, CONFIG, state), { ok: true, missing: [], outcome });
    assert.deepEqual(state, before);
  }
});

test('check: suspension needs every nonempty report field and rejects PASS', () => {
  const text = 'RAILS_OUTCOME: needs_user\nACTION: permission\nREASON: denied\nDONE: inspected\nREMAINING: ';
  assert.equal(check(text, CONFIG, { node: 'P0R3' }).ok, false);
  const complete = text + 'fix';
  assert.equal(check(complete + '\nverdict=pass', CONFIG, { node: 'P0R3' }).ok, false);
  assert.equal(check('quoted ' + complete, CONFIG, { node: 'P0R3' }).ok, false);
});

// --- lastAssistantText -------------------------------------------------------

function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rails-output-check-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 2026-09-23, при переводе execute-task: часть инвариантов скила — запреты на форму ответа
// («не перечисляй пункты DoD в stdout», «не декларируй self-check»), а выходной слой умел
// только требовать наличие. `final_forbids` / `pause_forbids` — регулярки, которые совпасть
// НЕ должны; элемент missing помечен префиксом `forbidden:`.
const FORBIDS_CONFIG = {
  terminal: ['P8S3'],
  pause_nodes: ['P3Q1'],
  output: {
    final_requires: ['---RESULT---'],
    final_forbids: ['\\[x\\]', '(?:^|\\n)[ \\t]*[-*] .+(?:\\n[ \\t]*[-*] .+)+'],
    pause_forbids: ['---RESULT---'],
  },
};

test('check: запрещённый паттерн в финальном ответе -> missing с префиксом forbidden:', () => {
  const ok = check('выполнено: модуль и тесты\n---RESULT---', FORBIDS_CONFIG, { node: 'P8S3' });
  assert.equal(ok.ok, true, JSON.stringify(ok.missing));

  const checkbox = check('готово [x] пункт DoD\n---RESULT---', FORBIDS_CONFIG, { node: 'P8S3' });
  assert.equal(checkbox.ok, false);
  assert.deepEqual(checkbox.missing, ['forbidden:\\[x\\]']);

  const list = check('---RESULT---\n- пункт один\n- пункт два', FORBIDS_CONFIG, { node: 'P8S3' });
  assert.equal(list.ok, false);
  assert.equal(list.missing.length, 1);
  assert.match(list.missing[0], /^forbidden:/);
});

test('check: forbids берутся по положению — в узле-паузе действует pause_forbids', () => {
  const atPause = check('Вопрос стейкхолдеру: какой вариант?', FORBIDS_CONFIG, { node: 'P3Q1' });
  assert.equal(atPause.ok, true, JSON.stringify(atPause.missing));

  const resultAtPause = check('---RESULT---\nstatus: default', FORBIDS_CONFIG, { node: 'P3Q1' });
  assert.equal(resultAtPause.ok, false);
  assert.deepEqual(resultAtPause.missing, ['forbidden:---RESULT---']);

  // В терминале pause_forbids не применяется, а final_forbids — применяется.
  const atTerminal = check('---RESULT---', FORBIDS_CONFIG, { node: 'P8S3' });
  assert.equal(atTerminal.ok, true, JSON.stringify(atTerminal.missing));
});

test('check: битая регулярка в forbids ответ не глушит (в отличие от requires)', () => {
  const config = { terminal: ['P8S3'], pause_nodes: [], output: { final_forbids: ['([unclosed'] } };
  const r = check('любой текст', config, { node: 'P8S3' });
  assert.equal(r.ok, true, JSON.stringify(r.missing));
});

test('check: битая handoff-регулярка отражается в пропусках', () => {
  const config = {
    handoff: { nodes: ['P0R3'], requires: ['['], forbids: ['forbidden'] },
  };
  const text = 'RAILS_OUTCOME: out_of_scope\nREASON: forbidden запрос';
  const result = check(text, config, { node: 'P0R3' });
  assert.deepEqual(result, {
    ok: false,
    missing: ['handoff:regex:[', 'handoff:forbids:forbidden'],
    outcome: 'out_of_scope',
  });
});

test('check: пустая handoff-политика сообщает отсутствующие требования', () => {
  const result = check('RAILS_OUTCOME: out_of_scope\nREASON: вне компетенции', {
    handoff: { nodes: ['P0R3'], requires: ['REASON'], forbids: ['forbidden'] },
    terminal: ['P0R3'],
  }, { node: 'P0R3' });
  assert.deepEqual(result, { ok: true, missing: [], outcome: 'out_of_scope' });
  assert.equal(check('RAILS_OUTCOME: out_of_scope\nREASON: вне компетенции', {
    handoff: { nodes: ['P0R3'] }, terminal: ['P0R3'],
  }, { node: 'P0R3' }).ok, false);
});

test('check: битая required-регулярка попадает в missing', () => {
  const result = check('ответ', { terminal: ['P8S3'], output: { final_requires: ['['] } }, { node: 'P8S3' });
  assert.deepEqual(result, { ok: false, missing: ['['] });
});

test('check: nullish ответ нормализуется и отсутствующий узел даёт position', () => {
  const result = check(null, { output: { final_requires: [] } }, {});
  assert.deepEqual(result, {
    ok: false,
    missing: ['position: не входит в terminal/pause_nodes'],
  });
});

test('lastAssistantText: assistant message с не-массивным content даёт пустой текст', () => {
  withTmpDir((dir) => {
    const file = join(dir, 'transcript-non-array-content.jsonl');
    writeFileSync(file, JSON.stringify({ type: 'assistant', message: { content: 'not an array' } }), 'utf8');
    assert.equal(lastAssistantText(file), '');
  });
});

test('lastAssistantText: берёт текст последней assistant-записи', () => {
  withTmpDir((dir) => {
    const file = join(dir, 'transcript.jsonl');
    const lines = [
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'привет' }] } }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'первый ответ' }] },
      }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'ещё' }] } }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'RAILS: P8S3\n' },
            { type: 'text', text: 'verdict=pass' },
          ],
        },
      }),
    ];
    writeFileSync(file, lines.join('\n') + '\n', 'utf8');
    const text = lastAssistantText(file);
    assert.equal(text, 'RAILS: P8S3\nverdict=pass');
  });
});

test('lastAssistantText: несколько строк одного message.id — text-блоки склеиваются по порядку файла', () => {
  withTmpDir((dir) => {
    const file = join(dir, 'transcript-split.jsonl');
    const lines = [
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'привет' }] } }),
      JSON.stringify({
        type: 'assistant',
        message: { id: 'msg_1', content: [{ type: 'text', text: 'первый блок ' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { id: 'msg_1', content: [{ type: 'text', text: 'второй блок ' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { id: 'msg_1', content: [{ type: 'text', text: 'третий блок' }] },
      }),
    ];
    writeFileSync(file, lines.join('\n') + '\n', 'utf8');
    assert.equal(lastAssistantText(file), 'первый блок второй блок третий блок');
  });
});

test('lastAssistantText: строка с другим message.id не подмешивается', () => {
  withTmpDir((dir) => {
    const file = join(dir, 'transcript-two-messages.jsonl');
    const lines = [
      JSON.stringify({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'старое сообщение' }] } }),
      JSON.stringify({ type: 'assistant', message: { id: 'msg_2', content: [{ type: 'text', text: 'новое сообщение' }] } }),
    ];
    writeFileSync(file, lines.join('\n') + '\n', 'utf8');
    assert.equal(lastAssistantText(file), 'новое сообщение');
  });
});

test('lastAssistantText: без message.id — берётся только последняя запись (без склейки)', () => {
  withTmpDir((dir) => {
    const file = join(dir, 'transcript-no-id.jsonl');
    const lines = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'первое' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'второе' }] } }),
    ];
    writeFileSync(file, lines.join('\n') + '\n', 'utf8');
    assert.equal(lastAssistantText(file), 'второе');
  });
});

test('lastAssistantText: пропускает поломанные строки', () => {
  withTmpDir((dir) => {
    const file = join(dir, 'transcript-broken.jsonl');
    const lines = [
      '{not json',
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }),
      '',
      '{"also broken"',
    ];
    writeFileSync(file, lines.join('\n') + '\n', 'utf8');
    assert.equal(lastAssistantText(file), 'ok');
  });
});

test('lastAssistantText: файла нет -> пустая строка', () => {
  withTmpDir((dir) => {
    assert.equal(lastAssistantText(join(dir, 'nope.jsonl')), '');
  });
});

test('lastAssistantText: нет assistant-записей -> пустая строка', () => {
  withTmpDir((dir) => {
    const file = join(dir, 'no-assistant.jsonl');
    writeFileSync(
      file,
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } }) + '\n',
      'utf8'
    );
    assert.equal(lastAssistantText(file), '');
  });
});

test('lastAssistantText: malformed content and non-text blocks are ignored', () => {
  withTmpDir((dir) => {
    const file = join(dir, 'malformed-content.jsonl');
    const entries = [
      { type: 'assistant', message: { content: { type: 'text', text: 'not an array' } } },
      { type: 'assistant', message: { content: [null, { type: 'image' }, { type: 'text', text: 42 }] } },
    ];
    writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
    assert.equal(lastAssistantText(file), '');
  });
});
test('приостановка: дописанный RESULT со status: pass не превращает её в успех (ревью 2026-10-05)', () => {
  const base = 'RAILS_OUTCOME: needs_user\nACTION: решение владельца\nREASON: жду разрешения\nDONE: правки внесены\nREMAINING: выбор варианта\n';
  const ok = check(base, null, { node: 'P3S5' });
  assert.equal(ok.ok, true);
  assert.equal(ok.outcome, 'needs_user');
  const forged = check(base + '---RESULT---\nstatus: pass\n---RESULT---\n', null, { node: 'P3S5' });
  assert.equal(forged.ok, false);
  assert.ok(forged.missing.includes('suspension:result-pass'));
  const withPassVerdict = check(base + 'verdict = pass\n', null, { node: 'P3S5' });
  assert.equal(withPassVerdict.ok, false);
});
