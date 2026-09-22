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

// --- lastAssistantText -------------------------------------------------------

function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rails-output-check-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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
