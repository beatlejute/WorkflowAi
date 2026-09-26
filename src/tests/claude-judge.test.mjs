/**
 * Судья Claude без инструментов (src/scripts/claude-judge.js): промпт CLI-судьи со
 * строкой `Изображения:` → сообщение stream-json с блоками изображений base64.
 * Настоящий claude подменён моком (fixtures/mock-claude-stream.js) через `--command`
 * и `--arg`: тест проверяет, что уходит модели и как разбирается её ответ. Что
 * охраняется:
 *  - изображения — блоками base64 из файлов внутри рабочего каталога агента, а не
 *    путями; файл вне каталога, не того формата или отсутствующий — bad_request до
 *    запуска модели;
 *  - каждый `@` текста обезврежен (`＠`): Claude Code приложил бы файл `@путь`;
 *  - модель без инструментов, без MCP и пользовательских настроек, в пустом
 *    временном каталоге, который снимается после ответа;
 *  - ответ — блок `---RESULT---` со score, моделью и ценой; без балла — unparsed,
 *    ошибка claude — agent_error, зависание — timeout.
 *
 * Запуск: node --test --import ./src/tests/_rails-home.mjs src/tests/claude-judge.test.mjs
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildCliJudgePrompt } from '../lib/skill-judge.mjs';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(TESTS_DIR, '..', 'scripts', 'claude-judge.js');
const MOCK = path.join(TESTS_DIR, 'fixtures', 'mock-claude-stream.js');
const RUBRIC = [1, 2, 3, 4, 5].map((n) => `| ${n} | level ${n} |`).join('\n');
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001', 'hex');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-judge-test-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
fs.mkdirSync(path.join(root, 'shots'));
fs.writeFileSync(path.join(root, 'shots', 'a.png'), PNG);
fs.writeFileSync(path.join(root, 'shots', 'notes.txt'), 'not an image');
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-judge-outside-'));
after(() => fs.rmSync(outside, { recursive: true, force: true }));
fs.writeFileSync(path.join(outside, 'b.png'), PNG);

function prompt(data, images = []) {
  const suffix = images.length > 0 ? `\nИзображения:\n${images.join('\n')}` : '';
  return buildCliJudgePrompt({ rubric: RUBRIC, agent_output: data + suffix, criterion: 'Кнопка видна справа от поиска' });
}

let runNo = 0;
function run(promptText, { env = {}, args = ['--model', 'claude-test-model'] } = {}) {
  const log = path.join(root, `log-${++runNo}.json`);
  const r = spawnSync(process.execPath, [SCRIPT, ...args, '--command', process.execPath, '--arg', MOCK], {
    cwd: root,
    input: promptText,
    encoding: 'utf8',
    env: { ...process.env, MOCK_CLAUDE_LOG: log, ...env },
  });
  const block = (r.stdout.split('---RESULT---')[1] || '');
  const field = (name) => (block.match(new RegExp(`^${name}:\\s*(.*)$`, 'm')) || [])[1];
  const sent = fs.existsSync(log) ? JSON.parse(fs.readFileSync(log, 'utf8')) : null;
  return { code: r.status, out: r.stdout, err: r.stderr, field, sent };
}

test('изображение уходит блоком base64, текст — после него, ответ разобран', () => {
  const r = run(prompt('Результат исполнителя.', ['shots/a.png']));
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.field('score'), '4');
  assert.equal(r.field('reason'), 'evidence confirms the item');
  assert.equal(r.field('model'), 'mock-model');
  assert.equal(r.field('cost_usd'), '0.0123');
  assert.equal(r.field('images'), '1');
  const [image, text] = r.sent.message.message.content;
  assert.deepEqual(image, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } });
  assert.equal(text.type, 'text');
  assert.match(text.text, /## Rubric/);
  assert.match(text.text, /Кнопка видна справа от поиска/);
});

test('без строки «Изображения:» — только текст', () => {
  const r = run(prompt('Только текст.'));
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.field('images'), '0');
  assert.deepEqual(r.sent.message.message.content.map((part) => part.type), ['text']);
});

test('каждый @ текста обезврежен — Claude Code не приложит файл по упоминанию', () => {
  const r = run(prompt('diff: +см. @src/secret.md и user@example.org', ['shots/a.png']));
  assert.equal(r.code, 0, r.out + r.err);
  const text = r.sent.message.message.content.at(-1).text;
  assert.ok(!text.includes('@'), text);
  assert.match(text, /＠src\/secret\.md/);
});

test('модель без инструментов, MCP и пользовательских настроек, в пустом временном каталоге', () => {
  const r = run(prompt('Данные.'));
  assert.equal(r.code, 0, r.out + r.err);
  const argv = r.sent.argv;
  const valueOf = (flag) => argv[argv.indexOf(flag) + 1];
  assert.equal(valueOf('--model'), 'claude-test-model');
  assert.equal(valueOf('--tools'), '', 'пустой список — ни одного инструмента');
  assert.ok(argv.includes('--strict-mcp-config'));
  assert.equal(valueOf('--setting-sources'), 'project');
  assert.equal(valueOf('--input-format'), 'stream-json');
  assert.equal(valueOf('--output-format'), 'stream-json');
  assert.ok(argv.includes('-p'));
  assert.notEqual(path.resolve(r.sent.cwd), path.resolve(root), 'не каталог проекта');
  assert.match(path.basename(r.sent.cwd), /^claude-judge-/);
  assert.equal(fs.existsSync(r.sent.cwd), false, 'временный каталог снят после ответа');
});

test('изображение вне каталога агента — bad_request, модель не запускалась', () => {
  for (const image of [path.join(outside, 'b.png'), path.relative(root, path.join(outside, 'b.png'))]) {
    const r = run(prompt('Данные.', [image]));
    assert.equal(r.code, 1);
    assert.equal(r.field('status'), 'error');
    assert.equal(r.field('error_class'), 'bad_request');
    assert.match(r.field('error'), /outside the agent directory/);
    assert.equal(r.sent, null);
  }
});

test('не изображение и отсутствующий файл — bad_request с именем, модель не запускалась', () => {
  const format = run(prompt('Данные.', ['shots/notes.txt']));
  assert.equal(format.field('error_class'), 'bad_request');
  assert.match(format.field('error'), /Unsupported image format: shots\/notes\.txt/);
  assert.equal(format.sent, null);
  const missing = run(prompt('Данные.', ['shots/none.png']));
  assert.equal(missing.field('error_class'), 'bad_request');
  assert.match(missing.field('error'), /Image not found: shots\/none\.png/);
  assert.equal(missing.sent, null);
});

test('ответ модели без балла — unparsed', () => {
  const r = run(prompt('Данные.'), { env: { MOCK_CLAUDE_TEXT: 'I cannot decide.' } });
  assert.equal(r.code, 1);
  assert.equal(r.field('error_class'), 'unparsed');
  assert.match(r.field('error'), /I cannot decide/);
});

test('ошибка claude (is_error или ненулевой код) — agent_error', () => {
  const flagged = run(prompt('Данные.'), { env: { MOCK_CLAUDE_ERROR: '1', MOCK_CLAUDE_TEXT: 'Credit balance is too low' } });
  assert.equal(flagged.field('error_class'), 'agent_error');
  assert.match(flagged.field('error'), /Credit balance is too low/);
  const exited = run(prompt('Данные.'), { env: { MOCK_CLAUDE_EXIT: '2' } });
  assert.equal(exited.field('error_class'), 'agent_error');
});

test('claude не ответил за --timeout — timeout', () => {
  const r = run(prompt('Данные.'), { env: { MOCK_CLAUDE_SLEEP: '5000' }, args: ['--model', 'm', '--timeout', '1'] });
  assert.equal(r.code, 1);
  assert.equal(r.field('error_class'), 'timeout');
});

test('без --model и не по формату промпта — usage и bad_prompt', () => {
  const usage = run(prompt('Данные.'), { args: [] });
  assert.equal(usage.field('error_class'), 'usage');
  const bad = run('просто текст без секций судьи');
  assert.equal(bad.field('error_class'), 'bad_prompt');
  assert.equal(bad.sent, null);
});
