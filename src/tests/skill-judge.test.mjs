/**
 * Контракт судьи тестов скилов (src/lib/skill-judge.mjs, PLAN-001).
 *
 * Промпт CLI-судьи сверяется с эталонной строкой — формат до выноса в адаптер
 * (run-skill-tests.js до PLAN-001): его вердикты и цифры согласия пилота Jev
 * посчитаны на этом тексте. Jev — локальный HTTP-сервер (_model-server.mjs),
 * CLI-судья — мок из fixtures; сеть наружу не используется.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCliJudgePrompt,
  parseJudgeScore,
  jevAgentOutput,
  judgeAgentErrors,
  judgeCallCost,
  judgeKeyMissing,
  runJudge,
  createJudgeRunState,
} from '../lib/skill-judge.mjs';
import { TEST_KEY, startModelServer, sendJson, decisionsResponse, closedPort } from './_model-server.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MOCK_RAW = join(PROJECT_ROOT, 'src', 'tests', 'fixtures', 'mock-judge-raw.js');

const RUBRIC = [
  '| Балл | Описание |',
  '|---|---|',
  '| 5 | полностью |',
  '| 4 | в основном |',
  '| 3 | частично |',
  '| 2 | почти нет |',
  '| 1 | нет |',
].join('\n');

const INPUT = Object.freeze({
  rubric_file: 'skill/tests/rubrics/r.md',
  rubric: RUBRIC,
  criterion: 'Критерий кейса',
  agent_output: 'вывод агента',
  ticket_files: '',
});

describe('skill-judge: промпт CLI-судьи', () => {
  it('байт в байт прежний формат L2 с секцией файлов тикета', () => {
    const prompt = buildCliJudgePrompt({
      rubric: 'RUBRIC',
      agent_output: 'OUTPUT',
      ticket_files: '\n## Ticket File After Execution — T-1 (in-progress/)\n\nBODY\n',
      criterion: 'TASK',
    });

    assert.equal(prompt, [
      'You are a judge evaluating the output of an AI agent.',
      '',
      '## Rubric',
      'RUBRIC',
      '',
      '## Target Agent Output',
      'OUTPUT',
      '',
      '## Ticket File After Execution — T-1 (in-progress/)',
      '',
      'BODY',
      '',
      '## Task',
      'TASK',
      '',
      'Please evaluate the output according to the rubric and provide a score from 1 to 5.',
      'Output format:',
      '---RESULT---',
      'score: <number 1-5>',
      'reason: <brief explanation>',
      '---RESULT---',
    ].join('\n'));
  });

  it('без файлов тикета — формат калибровки: пустая строка перед ## Task', () => {
    const prompt = buildCliJudgePrompt({ rubric: 'R', agent_output: 'O', criterion: 'T' });

    assert.ok(prompt.includes('## Target Agent Output\nO\n\n## Task\nT\n\nPlease evaluate'), prompt);
  });
});

describe('skill-judge: разбор балла CLI-судьи', () => {
  it('первое score: в 1..5 — балл; нет строки, 0, 7 — null', () => {
    assert.equal(parseJudgeScore('---RESULT---\nscore: 4\nreason: ok'), 4);
    assert.equal(parseJudgeScore('Score: 5'), 5);
    assert.equal(parseJudgeScore('оценки нет'), null);
    assert.equal(parseJudgeScore('score: 0'), null);
    assert.equal(parseJudgeScore('score: 7'), null);
    assert.equal(parseJudgeScore(''), null);
    assert.equal(parseJudgeScore(undefined), null);
  });
});

describe('skill-judge: вход Jev', () => {
  it('agent_output — вывод и файлы тикета, как текст между секциями промпта пилота', () => {
    assert.equal(jevAgentOutput({ agent_output: 'OUT', ticket_files: '\n## Ticket File\n\nX\n' }), 'OUT\n\n## Ticket File\n\nX');
    assert.equal(jevAgentOutput({ agent_output: '\nOUT\n' }), 'OUT');
  });
});

describe('skill-judge: проверка записи судьи', () => {
  const URL = 'https://openrouter.ai/api/alpha/decisions';
  const http = (extra) => ({ kind: 'http', protocol: 'decisions', url: URL, auth: { env: 'JUDGE_KEY' }, ...extra });
  const agents = {
    opus: { command: 'claude' },
    'opus-priced': { command: 'claude', cost_per_call: 0.222 },
    jev: http({ escalate_to: 'opus', cost_per_call: 0.0001 }),
    'jev-priced': http({ escalate_to: 'opus-priced', cost_per_call: 0.0001 }),
    'jev-alone': http({}),
    'jev-chat': http({ protocol: 'chat', escalate_to: 'opus' }),
    'jev-to-http': http({ escalate_to: 'jev' }),
    'jev-missing': http({ escalate_to: 'нет-такого' }),
    'jev-below': http({ escalate_to: 'opus', escalate_below: 1.5 }),
    'jev-plain-http': http({ escalate_to: 'opus', url: 'http://openrouter.ai/api/alpha/decisions' }),
    'bad-cost': { command: 'claude', cost_per_call: -1 },
  };

  it('CLI-судья и Jev с escalate_to на CLI — без ошибок', () => {
    assert.deepEqual(judgeAgentErrors('opus', agents), []);
    assert.deepEqual(judgeAgentErrors('jev', agents), []);
  });

  it('каждое нарушение называет агента и поле', () => {
    assert.match(judgeAgentErrors('jev-alone', agents).join(), /jev-alone.*escalate_to/);
    assert.match(judgeAgentErrors('jev-chat', agents).join(), /jev-chat.*protocol decisions/);
    assert.match(judgeAgentErrors('jev-to-http', agents).join(), /escalate_to 'jev' must be a CLI agent/);
    assert.match(judgeAgentErrors('jev-missing', agents).join(), /escalate_to 'нет-такого' not found/);
    assert.match(judgeAgentErrors('jev-below', agents).join(), /escalate_below must be a number in 0\.\.1/);
    assert.match(judgeAgentErrors('bad-cost', agents).join(), /cost_per_call/);
    assert.match(judgeAgentErrors('jev-plain-http', agents).join(), /jev-plain-http.*https:\/\//);
    assert.match(judgeAgentErrors('нет-такого', agents).join(), /not found/);
  });

  it('цена: cost_per_call; у Jev — плюс 0.284 × цена escalate_to; без цены — $0.02 и имя в missing', () => {
    assert.deepEqual(judgeCallCost('opus-priced', agents), { cost: 0.222, missing: [] });
    assert.deepEqual(judgeCallCost('opus', agents), { cost: 0.02, missing: ['opus'] });
    const jev = judgeCallCost('jev-priced', agents);
    assert.ok(Math.abs(jev.cost - (0.0001 + 0.284 * 0.222)) < 1e-12, String(jev.cost));
    assert.deepEqual(jev.missing, []);
    assert.deepEqual(judgeCallCost('jev', agents).missing, ['opus']);
    // HTTP-судья не ответит ни разу (нет ключа) — каждую оценку даёт escalate_to
    assert.deepEqual(judgeCallCost('jev-priced', agents, { allEscalate: true }), { cost: 0.222, missing: [] });
  });

  it('judgeKeyMissing: текст no_key без ключа, null с ключом и у CLI-судьи', () => {
    assert.match(judgeKeyMissing('jev', agents, {}), /JUDGE_KEY is empty/);
    assert.equal(judgeKeyMissing('jev', agents, { JUDGE_KEY: 'k' }), null);
    assert.equal(judgeKeyMissing('opus', agents, {}), null);
  });
});

describe('skill-judge: runJudge', () => {
  let server;
  let respond;
  before(async () => {
    server = await startModelServer((req, res) => respond(req, res));
  });
  after(async () => {
    await server.close();
  });

  const CLIENT = Object.freeze({ env: { TEST_MODEL_KEY: TEST_KEY }, retryDelaysMs: [1, 1] });
  const agents = () => ({
    'cli-two': { command: 'node', args: [MOCK_RAW, 'score: 2'] },
    jev: {
      kind: 'http', protocol: 'decisions', url: server.url('/d'), model: 'typesafe/jev-1.13',
      auth: { env: 'TEST_MODEL_KEY' }, escalate_to: 'cli-two',
    },
  });
  const decisions = (probabilities, confidence) => (req, res) => sendJson(res, 200, decisionsResponse({
    verdict: { type: 'score', score: 0, legend: {}, probabilities, confidence },
  }));
  const ctx = (extra = {}) => ({
    agents: agents(), timeoutS: 30, clientOptions: CLIENT, state: createJudgeRunState(), ...extra,
  });

  it('CLI-судья: запись с промптом, сырым ответом и баллом', async () => {
    const record = await runJudge('cli-two', INPUT, ctx());

    assert.equal(record.judge_kind, 'cli');
    assert.equal(record.prompt, buildCliJudgePrompt(INPUT));
    assert.match(record.raw_output, /score: 2/);
    assert.equal(record.score, 2);
    assert.equal(record.own_score, 2);
    assert.equal(record.passed, false);
    assert.equal(record.confidence, null);
    assert.equal(record.cost_usd, null);
    assert.equal(record.error, null);
  });

  it('noEscalation: неуверенный Jev не переоценивается, итог — его собственный балл', async () => {
    respond = decisions({ 4: 1 }, 0.3);
    const record = await runJudge('jev', INPUT, ctx({ noEscalation: true }));

    assert.equal(record.score, 5);
    assert.equal(record.confidence, 0.3);
    assert.equal(record.escalated, false);
    assert.equal(record.escalation, null);
  });

  it('noEscalation: отказ HTTP — ошибка записи, без фоллбека', async () => {
    respond = (req, res) => sendJson(res, 401, { error: 'no' });
    const record = await runJudge('jev', INPUT, ctx({ noEscalation: true }));

    assert.match(record.error, /^auth: /);
    assert.equal(record.fallback, null);
    assert.equal(record.escalation, null);
    assert.equal(record.score, null);
  });

  it('таймаут HTTP-судьи — ctx.timeoutS, а не timeout_s записи', async () => {
    respond = () => {};
    const slow = agents();
    slow.jev.timeout_s = 120;
    const started = Date.now();
    const record = await runJudge('jev', INPUT, ctx({ agents: slow, timeoutS: 1 }));

    assert.equal(record.fallback, 'timeout');
    assert.match(record.fallback_detail, /timed out after 1s/);
    assert.ok(Date.now() - started < 30000);
  });

  it('адрес сервера в тексте ошибки не пишется в запись', async () => {
    const closed = await closedPort();
    const offline = agents();
    offline.jev.url = `http://127.0.0.1:${closed}/d`;
    const record = await runJudge('jev', INPUT, ctx({ agents: offline }));

    assert.equal(record.fallback, 'network');
    assert.ok(!record.fallback_detail.includes(String(closed)), record.fallback_detail);
    assert.match(record.fallback_detail, /\[host:port\]/);
  });

  it('без ключа: одно предупреждение на состояние прогона, дальше — сразу escalate_to', async () => {
    const lines = [];
    const state = createJudgeRunState();
    const shared = ctx({ state, clientOptions: { env: {} }, log: (line) => lines.push(line) });
    const seen = server.requests.length;

    const first = await runJudge('jev', INPUT, shared);
    const second = await runJudge('jev', INPUT, shared);

    assert.equal(first.fallback, 'no_key');
    assert.equal(second.fallback, 'no_key');
    assert.equal(second.score, 2);
    assert.equal(lines.filter((line) => line.includes('no_key')).length, 1, lines.join('\n'));
    assert.equal(server.requests.length, seen);
  });
});
