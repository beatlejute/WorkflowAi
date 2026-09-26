/**
 * Судья на модели решений — CLI-обёртка (src/scripts/decisions-judge.js).
 *
 * Скрипт получает промпт CLI-судьи (buildCliJudgePrompt) через stdin или
 * последним аргументом, берёт уровни из таблицы рубрики и отвечает блоком
 * ---RESULT--- с баллом и уверенностью. Модель — локальный сервер
 * (_model-server.mjs), ключ — файл во временном каталоге ОС; сеть наружу не
 * используется, каталог снимается в after().
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildCliJudgePrompt } from '../lib/skill-judge.mjs';
import { TEST_KEY, startModelServer, sendJson, decisionsResponse, closedPort } from './_model-server.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(PROJECT_ROOT, 'src', 'scripts', 'decisions-judge.js');

const RUBRIC = [
  '## Шкала оценки', '| Балл | Описание |', '|---|---|',
  '| **5** | полностью |', '| 4 | в основном |', '| 3 | частично |', '| 2 | почти нет |', '| 1 | нет |',
].join('\n');

const PROMPT = buildCliJudgePrompt({
  rubric: RUBRIC,
  agent_output: 'вывод исполнителя',
  ticket_files: '\n## Ticket File After Execution — T-1 (in-progress/)\n\nтело тикета\n',
  criterion: 'Критерий кейса',
});

function run(args, { stdin = null } = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (exitCode) => done({ stdout, stderr, exitCode }));
    if (stdin !== null) child.stdin.write(stdin);
    child.stdin.end();
  });
}

function field(stdout, name) {
  return (stdout.match(new RegExp(`^${name}: (.*)$`, 'm')) || [])[1];
}

describe('decisions-judge: CLI-судья на модели решений', () => {
  let root;
  let keyFile;
  let server;
  let respond;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'wf-decisions-judge-'));
    keyFile = join(root, 'model.key');
    writeFileSync(keyFile, `${TEST_KEY}\n`);
    server = await startModelServer((req, res) => respond(req, res));
  });
  after(async () => {
    await server?.close();
    rmSync(root, { recursive: true, force: true });
  });

  const args = (extra = []) => ['--model', 'vendor/decider', '--url', server.url('/decisions'), '--key-file', keyFile, ...extra];
  const decisions = (probabilities, confidence) => (req, res) => sendJson(res, 200, decisionsResponse({
    verdict: { type: 'score', score: 0, legend: {}, probabilities, confidence },
  }));

  it('промпт из stdin: балл — самый вероятный уровень, уверенность, вероятности, модель, цена', async () => {
    respond = decisions({ 3: 0.9, 4: 0.1 }, 0.93);
    const seen = server.requests.length;
    const { stdout, exitCode } = await run(args(), { stdin: PROMPT });

    assert.equal(exitCode, 0, stdout);
    assert.equal(field(stdout, 'score'), '4');
    assert.equal(field(stdout, 'confidence'), '0.93');
    assert.deepEqual(JSON.parse(field(stdout, 'probabilities')), { 3: 0.9, 4: 0.1 });
    assert.equal(field(stdout, 'model'), 'typesafe/jev-1.13-20260917');
    assert.equal(field(stdout, 'cost_usd'), '0.000126672');

    const request = server.requests[seen];
    assert.equal(request.headers.authorization, `Bearer ${TEST_KEY}`);
    assert.equal(request.json.model, 'vendor/decider');
    assert.equal(request.json.questions.verdict.type, 'score');
    assert.equal(request.json.questions.verdict.instructions, 'Критерий кейса');
    assert.deepEqual(request.json.questions.verdict.criteria, ['нет', 'почти нет', 'частично', 'в основном', 'полностью']);
    assert.equal(request.json.state.agent_output,
      'вывод исполнителя\n\n## Ticket File After Execution — T-1 (in-progress/)\n\nтело тикета');
    assert.ok(!stdout.includes(TEST_KEY), 'ключ не печатается');
  });

  it('промпт последним аргументом — тот же ответ; равные вероятности — меньший уровень', async () => {
    respond = decisions({ 2: 0.5, 3: 0.5 }, 0.6);
    const { stdout, exitCode } = await run(args([PROMPT]));

    assert.equal(exitCode, 0, stdout);
    assert.equal(field(stdout, 'score'), '3');
  });

  it('вывод исполнителя со своим «## Task» — данные целиком, вопрос — только критерий', async () => {
    respond = decisions({ 4: 1 }, 0.9);
    const seen = server.requests.length;
    const prompt = buildCliJudgePrompt({
      rubric: RUBRIC,
      agent_output: 'Ticket echo:\n## Task\nImplement login\n\n## Result\ndone',
      ticket_files: '\n## Ticket File After Execution — T-2 (in-progress/)\n\n```markdown\n## Task\nбез ответа\n```\n',
      criterion: 'Критерий кейса',
    });
    const { stdout, exitCode } = await run(args(), { stdin: prompt });

    assert.equal(exitCode, 0, stdout);
    const request = server.requests[seen].json;
    assert.equal(request.questions.verdict.instructions, 'Критерий кейса');
    assert.match(request.state.agent_output, /^Ticket echo:\n## Task\nImplement login\n\n## Result\ndone\n/);
    assert.match(request.state.agent_output, /## Task\nбез ответа\n```$/);
  });

  it('нет файла ключа — status: error, error_class: no_key, код 1, запроса нет', async () => {
    const seen = server.requests.length;
    const { stdout, exitCode } = await run(['--model', 'm', '--url', server.url('/d'), '--key-file', join(root, 'none.key')], { stdin: PROMPT });

    assert.equal(exitCode, 1);
    assert.equal(field(stdout, 'status'), 'error');
    assert.equal(field(stdout, 'error_class'), 'no_key');
    assert.equal(field(stdout, 'score'), undefined);
    assert.equal(server.requests.length, seen);
  });

  it('HTTP 401 — error_class: auth', async () => {
    respond = (req, res) => sendJson(res, 401, { error: 'bad key' });
    const { stdout, exitCode } = await run(args(), { stdin: PROMPT });

    assert.equal(exitCode, 1);
    assert.equal(field(stdout, 'error_class'), 'auth');
  });

  it('модель молчит дольше --timeout — error_class: timeout', async () => {
    respond = () => {};
    const { stdout } = await run(args(['--timeout', '1']), { stdin: PROMPT });

    assert.equal(field(stdout, 'error_class'), 'timeout');
  });

  it('сеть недоступна — error_class: network, адреса в тексте нет', async () => {
    const port = await closedPort();
    const { stdout } = await run(['--model', 'm', '--url', `http://127.0.0.1:${port}/d`, '--key-file', keyFile], { stdin: PROMPT });

    assert.equal(field(stdout, 'error_class'), 'network');
    assert.ok(!stdout.includes(String(port)), stdout);
  });

  it('рубрика без таблицы уровней — rubric_unparsed, запроса нет', async () => {
    const seen = server.requests.length;
    const prompt = buildCliJudgePrompt({ rubric: '## Проходной балл\n\n- **5** — всё', agent_output: 'x', criterion: 'c' });
    const { stdout } = await run(args(), { stdin: prompt });

    assert.equal(field(stdout, 'error_class'), 'rubric_unparsed');
    assert.equal(server.requests.length, seen);
  });

  it('промпт не по формату судьи — bad_prompt', async () => {
    const { stdout } = await run(args(), { stdin: 'просто текст' });

    assert.equal(field(stdout, 'error_class'), 'bad_prompt');
  });

  it('нет --model — usage', async () => {
    const { stdout, exitCode } = await run(['--url', 'https://x/d', '--key-file', keyFile], { stdin: PROMPT });

    assert.equal(exitCode, 1);
    assert.equal(field(stdout, 'error_class'), 'usage');
  });
});
