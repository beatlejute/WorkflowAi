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

// Режим models — выбор модели стадии: блок с `levels` (рубрика), тикетом и кандидатами
// стадии. Два вопроса одним запросом: `level` (score по рубрике) и `pick` (choice).
describe('decisions-select: режим models — уровень и порядок кандидатов стадии', () => {
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
    root = mkdtempSync(join(tmpdir(), 'wf-decisions-models-'));
    keyFile = join(root, 'service.key');
    writeFileSync(keyFile, `${TEST_KEY}\n`);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const LEVELS = ['l1 mechanical', 'l2 routine', 'l3 checks', 'l4 unknown cause', 'l5 architecture'];
  const stageCandidate = (id, level, free = false) => ({ id, kind: 'agent', free, level, scores: { intelligence: 10 * level, coding: null, agentic: null } });
  const CANDIDATES_M = [stageCandidate('agent-a', 1), stageCandidate('pool-x@vendor-a/m-1:free', 2, true), stageCandidate('agent-c', 5)];
  const modelsPrompt = ({ levels = LEVELS, candidates = CANDIDATES_M } = {}) => [
    'Выбери уровень.',
    '',
    '```json',
    JSON.stringify({ mode: 'models', stage: 'stage-a', ticket: { id: 'IMPL-7', type: 'impl', title: 't', history: [] }, levels, candidates, scores_citation: 'c' }, null, 2),
    '```',
    '',
  ].join('\n');
  const args = (extra = []) => ['--model', 'vendor/decider', '--url', server.url('/decisions'), '--key-file', keyFile, '--timeout', '5', ...extra];
  const select = async (prompt, extra) => {
    const seen = server.requests.length;
    const result = await run(args(extra), prompt);
    return { ...result, requests: server.requests.slice(seen) };
  };
  // Ответ на все вопросы запроса: level — levelProbs, pick — pickProbs.
  const answer = (levelProbs, pickProbs = { 0: 0.2, 1: 0.5, 2: 0.3 }) => (req, res) => {
    const answers = {};
    for (const [id, q] of Object.entries(req.json.questions)) {
      answers[id] = q.type === 'choice'
        ? { type: 'choice', choice: '0', confidence: 0.5, probabilities: pickProbs }
        : { type: 'score', score: 0, legend: {}, confidence: 0.7, probabilities: levelProbs };
    }
    sendJson(res, 200, { model: 'vendor/decider-20260901', answers, usage: { input_tokens: 10, output_tokens: 2, cost: 0.0004 } });
  };

  it('один запрос: вопрос score по рубрике и вопрос choice по кандидатам; ответ required_level, ranking', async () => {
    respond = answer({ 0: 0.1, 1: 0.5, 2: 0.2, 3: 0.1, 4: 0.1 });
    const { stdout, exitCode, requests } = await select(modelsPrompt());
    assert.equal(exitCode, 0, stdout);
    assert.equal(requests.length, 1);
    const { questions } = requests[0].json;
    assert.deepEqual(Object.keys(questions), ['level', 'pick']);
    assert.equal(questions.level.type, 'score');
    assert.deepEqual(questions.level.criteria, LEVELS);
    assert.match(questions.level.instructions, /LOWEST level/);
    assert.equal(questions.pick.type, 'choice');
    assert.deepEqual(Object.keys(questions.pick.criteria), ['0', '1', '2']);
    assert.match(questions.pick.criteria[1], /^pool-x@vendor-a\/m-1:free \| level 2 \| free \| scores: intelligence 20/);
    assert.equal(requests[0].json.state.ticket.id, 'IMPL-7');
    assert.equal(field(stdout, 'required_level'), '2');
    assert.equal(field(stdout, 'level_confidence'), '0.7');
    assert.equal(field(stdout, 'ranking'), 'pool-x@vendor-a/m-1:free, agent-c, agent-a');
    assert.equal(field(stdout, 'cost_usd'), '0.0004');
  });

  it('квантиль: 0.5 — наименьший уровень с суммой ≥ 0.5, 0.8 — выше; сумма не набралась — наибольшая вероятность', async () => {
    respond = answer({ 0: 0.3, 1: 0.2, 2: 0.1, 3: 0.3, 4: 0.1 });
    assert.equal(field((await select(modelsPrompt())).stdout, 'required_level'), '2');
    assert.equal(field((await select(modelsPrompt(), ['--level-quantile', '0.8'])).stdout, 'required_level'), '4');
    respond = answer({ 0: 0.1, 3: 0.2 });
    assert.equal(field((await select(modelsPrompt(), ['--level-quantile', '1'])).stdout, 'required_level'), '4');
  });

  it('--level-quantile вне (0, 1] — ошибка usage без запроса', async () => {
    respond = answer({ 0: 1 });
    for (const bad of ['0', '1.5', 'x']) {
      const { stdout, exitCode, requests } = await select(modelsPrompt(), ['--level-quantile', bad]);
      assert.equal(exitCode, 1);
      assert.equal(field(stdout, 'error_class'), 'usage');
      assert.equal(requests.length, 0);
    }
  });

  it('один кандидат — только вопрос уровня', async () => {
    respond = answer({ 0: 0.9, 1: 0.1 });
    const { stdout, exitCode, requests } = await select(modelsPrompt({ candidates: [CANDIDATES_M[0]] }));
    assert.equal(exitCode, 0, stdout);
    assert.deepEqual(Object.keys(requests[0].json.questions), ['level']);
    assert.equal(field(stdout, 'ranking'), 'agent-a');
    assert.equal(field(stdout, 'required_level'), '1');
  });

  it('уровней меньше двух или больше десяти, нет кандидатов, повтор id — bad_prompt без запроса', async () => {
    respond = answer({ 0: 1 });
    const prompts = [
      modelsPrompt({ levels: ['one'] }),
      modelsPrompt({ levels: Array.from({ length: 11 }, (_, i) => `l${i}`) }),
      modelsPrompt({ levels: ['a', ''] }),
      modelsPrompt({ candidates: [] }),
      modelsPrompt({ candidates: [CANDIDATES_M[0], CANDIDATES_M[0]] }),
    ];
    for (const prompt of prompts) {
      const { stdout, exitCode, requests } = await select(prompt);
      assert.equal(exitCode, 1);
      assert.equal(field(stdout, 'error_class'), 'bad_prompt');
      assert.equal(requests.length, 0);
    }
  });

  it('выбор из 35 кандидатов принимается', async () => {
    const many = Array.from({ length: 35 }, (_, i) => stageCandidate(`agent-${i}`, 1 + (i % 5)));
    respond = answer({ 0: 1 }, Object.fromEntries(many.map((_, i) => [i, i === 34 ? 0.5 : 0.01])));
    const { stdout, exitCode, requests } = await select(modelsPrompt({ candidates: many }));
    assert.equal(exitCode, 0, stdout);
    assert.equal(Object.keys(requests[0].json.questions.pick.criteria).length, 35);
    const ranking = field(stdout, 'ranking').split(', ');
    assert.equal(ranking.length, 35);
    assert.equal(ranking[0], 'agent-34');
  });
});
