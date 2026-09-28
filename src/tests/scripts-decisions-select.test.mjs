/**
 * Обёртка-селектор участника пула на модели решений (src/scripts/decisions-select.js).
 *
 * Скрипт получает промпт селектора через stdin, берёт из него JSON-блок
 * (```json … ```) с тикетом и кандидатами, задаёт модели один вопрос типа
 * `choice` (варианты — кандидаты, имена вариантов — индексы 0..n-1) и отвечает
 * блоком ---RESULT--- с `ranking:` — все кандидаты по убыванию вероятности, при
 * равенстве — меньший индекс раньше. Модель — локальный сервер
 * (_model-server.mjs), ключ — файл во временном каталоге ОС; сеть наружу не
 * используется, каталог снимается в afterEach.
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TEST_KEY, startModelServer, sendJson } from './_model-server.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(PROJECT_ROOT, 'src', 'scripts', 'decisions-select.js');

const ID1 = 'route-x/vendor-a/model-one:free';
const ID2 = 'route-x/vendor-b/model-two:free';
const ID3 = 'route-x/vendor-c/model-three';

const candidate = (id, extra = {}) => ({
  id,
  capabilities: ['text'],
  note: 'in=0 out=0 tools=true free=true',
  scores: null,
  ...extra,
});
const CANDIDATES = [
  candidate(ID1, { scores: { intelligence: 30.5, coding: 60.1, agentic: 40.2 } }),
  candidate(ID2, { capabilities: ['text', 'multimodal'], scores: { intelligence: null, coding: 12.5, agentic: null } }),
  candidate(ID3),
];

function selectorPrompt(candidates = CANDIDATES) {
  const block = {
    pool: 'pool-a',
    ticket: { id: 'IMPL-7', type: 'impl', title: 'Добавить экспорт отчёта', dod: '- [ ] экспорт в CSV\n- [ ] тест' },
    candidates,
    scores_citation: 'Source: Bench Lab via Test Hub.',
  };
  return [
    'Упорядочи участников пула для тикета по его типу, заголовку и DoD, способностям и оценкам кандидатов — от самого подходящего.',
    'Ответь блоком `---RESULT---` с полем `ranking: <id>, <id>, …` из id candidates.',
    '',
    '```json',
    JSON.stringify(block, null, 2),
    '```',
    '',
  ].join('\n');
}

function run(args, stdin) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (exitCode) => done({ stdout, stderr, exitCode }));
    child.stdin.end(stdin);
  });
}

function field(stdout, name) {
  return (stdout.match(new RegExp(`^${name}: (.*)$`, 'm')) || [])[1];
}

/** Ответ decisions на вопрос-выбор; имя вопроса — любое, берётся из запроса. */
function choiceResponse(request, answer, { cost = 0.000031 } = {}) {
  const [questionId] = Object.keys(request.json?.questions || { member: null });
  return {
    id: 'gen-dec-1',
    model: 'vendor/decider-20260901',
    answers: { [questionId]: { type: 'choice', ...answer } },
    usage: { input_tokens: 812, output_tokens: 20, cost },
  };
}

describe('decisions-select: ранжир участников пула моделью решений', () => {
  let server;
  let respond;
  let root;
  let keyFile;

  before(async () => {
    server = await startModelServer((req, res) => respond(req, res));
  });
  after(async () => {
    await server?.close();
  });
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wf-decisions-select-'));
    keyFile = join(root, 'service.key');
    writeFileSync(keyFile, `${TEST_KEY}\n`);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const args = () => ['--model', 'vendor/decider', '--url', server.url('/decisions'), '--key-file', keyFile, '--timeout', '5'];
  const select = async (prompt = selectorPrompt()) => {
    const seen = server.requests.length;
    const result = await run(args(), prompt);
    assert.ok(!result.stdout.includes(TEST_KEY) && !result.stderr.includes(TEST_KEY), 'ключ не печатается');
    return { ...result, requests: server.requests.slice(seen) };
  };
  const answer = (probabilities, confidence = 0.62) => (req, res) => sendJson(res, 200, choiceResponse(req, {
    choice: '1', confidence, probabilities,
  }));

  it('ранжир по убыванию вероятности, уверенность, цена из usage.cost, модель', async () => {
    respond = answer({ 0: 0.1, 1: 0.7, 2: 0.2 });
    const { stdout, exitCode, requests } = await select();

    assert.equal(exitCode, 0, stdout);
    assert.equal(field(stdout, 'ranking'), `${ID2}, ${ID3}, ${ID1}`);
    assert.equal(field(stdout, 'confidence'), '0.62');
    assert.equal(field(stdout, 'cost_usd'), '0.000031');
    assert.equal(field(stdout, 'model'), 'vendor/decider-20260901');
    assert.equal(field(stdout, 'status'), undefined);
    assert.equal(requests.length, 1);
  });

  it('тело запроса: один вопрос choice, все кандидаты вариантами 0..n-1, тикет в state', async () => {
    respond = answer({ 0: 0.5, 1: 0.3, 2: 0.2 });
    const { exitCode, requests } = await select();

    assert.equal(exitCode, 0);
    const [request] = requests;
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.authorization, `Bearer ${TEST_KEY}`);
    assert.equal(request.json.model, 'vendor/decider');
    const questions = Object.values(request.json.questions);
    assert.equal(questions.length, 1);
    const [question] = questions;
    assert.equal(question.type, 'choice');
    assert.equal(typeof question.instructions, 'string');
    assert.deepEqual(Object.keys(question.criteria), ['0', '1', '2']);
    [ID1, ID2, ID3].forEach((id, i) => assert.ok(String(question.criteria[i]).includes(id), `вариант ${i} — ${id}`));
    assert.match(String(question.criteria[0]), /60\.1/, 'оценки кандидата в тексте варианта');
    assert.match(String(question.criteria[1]), /multimodal/, 'способности кандидата в тексте варианта');
    assert.equal(request.json.state.ticket.title, 'Добавить экспорт отчёта');
    assert.equal(request.json.state.ticket.type, 'impl');
    assert.match(request.json.state.ticket.dod, /экспорт в CSV/);
  });

  it('равные вероятности — меньший индекс раньше; кандидат без вероятности — в конце', async () => {
    respond = answer({ 0: 0.4, 1: 0.2, 2: 0.4 });
    const tie = await select();
    assert.equal(field(tie.stdout, 'ranking'), `${ID1}, ${ID3}, ${ID2}`);

    respond = answer({ 0: 0.3, 2: 0.7 });
    const missing = await select();
    assert.equal(field(missing.stdout, 'ranking'), `${ID3}, ${ID1}, ${ID2}`);
  });

  it('ответ без вероятностей — status: error, error_class: bad_response, выход 1', async () => {
    respond = (req, res) => sendJson(res, 200, choiceResponse(req, { choice: '0', confidence: 0.9 }));
    const { stdout, exitCode } = await select();

    assert.equal(exitCode, 1);
    assert.equal(field(stdout, 'status'), 'error');
    assert.equal(field(stdout, 'error_class'), 'bad_response');
    assert.equal(field(stdout, 'ranking'), undefined);
  });

  it('HTTP 401 — error_class: auth', async () => {
    respond = (req, res) => sendJson(res, 401, { error: { code: 401, message: 'Missing Authentication header' } });
    const { stdout, exitCode } = await select();

    assert.equal(exitCode, 1);
    assert.equal(field(stdout, 'status'), 'error');
    assert.equal(field(stdout, 'error_class'), 'auth');
  });

  it('промпт без JSON-блока, с одним кандидатом или сверх предела — bad_prompt, запроса нет', async () => {
    respond = answer({ 0: 1 });
    const prompts = [
      'просто текст без блока',
      selectorPrompt([CANDIDATES[0]]),
      selectorPrompt(Array.from({ length: 11 }, (_, i) => candidate(`route-x/vendor-a/model-${i}`))),
      '```json\n{ не json\n```\n',
    ];
    for (const prompt of prompts) {
      const { stdout, exitCode, requests } = await select(prompt);
      assert.equal(exitCode, 1, prompt.slice(0, 40));
      assert.equal(field(stdout, 'status'), 'error');
      assert.equal(field(stdout, 'error_class'), 'bad_prompt');
      assert.equal(requests.length, 0);
    }
  });

  it('десять кандидатов — в пределе', async () => {
    const ten = Array.from({ length: 10 }, (_, i) => candidate(`route-x/vendor-a/model-${i}`));
    respond = answer(Object.fromEntries(ten.map((_, i) => [i, i === 9 ? 0.55 : 0.05])));
    const { stdout, exitCode } = await select(selectorPrompt(ten));

    assert.equal(exitCode, 0, stdout);
    assert.equal(field(stdout, 'ranking').split(', ')[0], 'route-x/vendor-a/model-9');
    assert.equal(field(stdout, 'ranking').split(', ').length, 10);
  });
});
