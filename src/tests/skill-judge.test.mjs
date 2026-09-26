/**
 * Судья тестов скилов (src/lib/skill-judge.mjs, PLAN-001): любой агент с командой.
 *
 * Промпт CLI-судьи сверяется с эталонной строкой — формат до выноса в адаптер
 * (run-skill-tests.js до PLAN-001): его вердикты и цифры согласия посчитаны на
 * этом тексте. Судьи — мок из fixtures (mock-judge-raw.js печатает ответ из
 * аргумента) и `node -e`; сеть не используется.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCliJudgePrompt,
  parseJudgeScore,
  parseJudgeExtras,
  judgeAgentErrors,
  judgeCallCost,
  runJudge,
  createJudgeRunState,
} from '../lib/skill-judge.mjs';
import { redactNetworkDetail } from '../lib/model-client.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MOCK_RAW = join(PROJECT_ROOT, 'src', 'tests', 'fixtures', 'mock-judge-raw.js');

const INPUT = Object.freeze({
  rubric_file: 'skill/tests/rubrics/r.md',
  rubric: '| 5 | полностью |',
  criterion: 'Критерий кейса',
  agent_output: 'вывод агента',
  ticket_files: '',
});

/** Судья, который отвечает текстом `answer` между маркерами ---RESULT---. */
const answering = (answer, extra = {}) => ({ command: 'node', args: [MOCK_RAW, answer], ...extra });
const crashing = (extra = {}) => ({ command: 'node', args: ['-e', 'process.exit(3)'], ...extra });

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

describe('skill-judge: разбор ответа судьи', () => {
  it('балл — первое score: в 1..5; нет строки, 0, 7 — null', () => {
    assert.equal(parseJudgeScore('---RESULT---\nscore: 4\nreason: ok'), 4);
    assert.equal(parseJudgeScore('Score: 5'), 5);
    assert.equal(parseJudgeScore('оценки нет'), null);
    assert.equal(parseJudgeScore('score: 0'), null);
    assert.equal(parseJudgeScore('score: 7'), null);
    assert.equal(parseJudgeScore(undefined), null);
  });

  it('уверенность, вероятности, цена, модель и класс ошибки — необязательные поля', () => {
    const extras = parseJudgeExtras([
      '---RESULT---', 'score: 4', 'confidence: 0.93', 'probabilities: {"3":0.9,"4":0.1}',
      'model: vendor/m', 'cost_usd: 0.000126672', '---RESULT---',
    ].join('\n'));
    assert.deepEqual(extras, {
      confidence: 0.93, probabilities: { 3: 0.9, 4: 0.1 }, cost_usd: 0.000126672,
      model: 'vendor/m', error_class: null, error: null,
    });

    const bare = parseJudgeExtras('score: 5\nconfidence: высокая\nprobabilities: не json');
    assert.equal(bare.confidence, null, 'не число 0..1 — нет уверенности');
    assert.equal(bare.probabilities, null);
    assert.equal(parseJudgeExtras('confidence: 1.5').confidence, null);
    assert.equal(parseJudgeExtras('confidence: 1').confidence, 1);

    const failed = parseJudgeExtras('status: error\nerror_class: no_key\nerror: key file is missing');
    assert.equal(failed.error_class, 'no_key');
    assert.equal(failed.error, 'key file is missing');
  });

  it('адрес в тексте сетевой ошибки заменяется, класс и HTTP-статус остаются', () => {
    assert.equal(redactNetworkDetail('Model request failed: connect ECONNREFUSED 127.0.0.1:3128'),
      'Model request failed: connect ECONNREFUSED [address]');
    assert.equal(redactNetworkDetail('connect EADDRNOTAVAIL ff02::1:443'), 'connect EADDRNOTAVAIL [address]');
    assert.equal(redactNetworkDetail('getaddrinfo EAI_FAIL proxy.corp.local'), 'getaddrinfo EAI_FAIL [address]');
    assert.equal(
      redactNetworkDetail("Hostname/IP does not match certificate's altnames: Host: x. is not in the cert's altnames: DNS:proxy.corp.local"),
      "Hostname/IP does not match certificate's altnames: [redacted]");
    assert.equal(redactNetworkDetail('Model server error, HTTP 500: upstream down'), 'Model server error, HTTP 500: upstream down');
    assert.equal(redactNetworkDetail('proxy at gw.local:8080 refused'), 'proxy at [host:port] refused');
  });
});

describe('skill-judge: проверка записи судьи', () => {
  const agents = {
    opus: { command: 'claude' },
    'opus-priced': { command: 'claude', cost_per_call: 0.222 },
    decider: { command: 'node', escalate_to: 'opus-priced', escalate_below: 0.8, escalation_share: 0.3, cost_per_call: 0.0001 },
    'decider-no-share': { command: 'node', escalate_to: 'opus-priced', cost_per_call: 0.0001 },
    'tool-less': { kind: 'http', protocol: 'decisions', url: 'https://x/d', model: 'm', auth: { env: 'K' } },
    'to-self': { command: 'node', escalate_to: 'to-self' },
    'to-missing': { command: 'node', escalate_to: 'нет-такого' },
    'to-http': { command: 'node', escalate_to: 'tool-less' },
    'bad-below': { command: 'node', escalate_to: 'opus', escalate_below: 1.5 },
    'bad-share': { command: 'node', escalate_to: 'opus', escalation_share: -1 },
    'below-alone': { command: 'node', escalate_below: 0.8 },
    'bad-cost': { command: 'claude', cost_per_call: -1 },
  };

  it('агент с командой — с переоценкой и без — без ошибок', () => {
    assert.deepEqual(judgeAgentErrors('opus', agents), []);
    assert.deepEqual(judgeAgentErrors('decider', agents), []);
  });

  it('каждое нарушение называет агента и поле', () => {
    assert.match(judgeAgentErrors('tool-less', agents).join(), /tool-less.*kind: cli/);
    assert.match(judgeAgentErrors('to-self', agents).join(), /escalate_to must be another agent/);
    assert.match(judgeAgentErrors('to-missing', agents).join(), /escalate_to 'нет-такого' not found/);
    assert.match(judgeAgentErrors('to-http', agents).join(), /escalate_to 'tool-less' must be an agent with a command/);
    assert.match(judgeAgentErrors('bad-below', agents).join(), /escalate_below must be a number in 0\.\.1/);
    assert.match(judgeAgentErrors('bad-share', agents).join(), /escalation_share must be a number in 0\.\.1/);
    assert.match(judgeAgentErrors('below-alone', agents).join(), /need escalate_to/);
    assert.match(judgeAgentErrors('bad-cost', agents).join(), /cost_per_call/);
    assert.match(judgeAgentErrors('нет-такого', agents).join(), /not found/);
  });

  it('цена: cost_per_call; с escalate_to — плюс escalation_share × его цена; без поля — в missing', () => {
    assert.deepEqual(judgeCallCost('opus-priced', agents), { cost: 0.222, worst: 0.222, missing: [] });
    assert.deepEqual(judgeCallCost('opus', agents), { cost: 0.02, worst: 0.02, missing: ['opus.cost_per_call'] });
    const decider = judgeCallCost('decider', agents);
    assert.ok(Math.abs(decider.cost - (0.0001 + 0.3 * 0.222)) < 1e-12, String(decider.cost));
    assert.ok(Math.abs(decider.worst - (0.0001 + 0.222)) < 1e-12, 'худший случай — каждую оценку даёт и escalate_to');
    assert.deepEqual(decider.missing, []);
    const noShare = judgeCallCost('decider-no-share', agents);
    assert.ok(Math.abs(noShare.cost - (0.0001 + 0.222)) < 1e-12, 'без доли — переоценка каждой оценки');
    assert.deepEqual(noShare.missing, ['decider-no-share.escalation_share']);
  });
});

describe('skill-judge: runJudge', () => {
  const ctx = (agents, extra = {}) => ({ agents, timeoutS: 30, state: createJudgeRunState(), ...extra });

  it('судья без переоценки: запись с промптом, сырым ответом и баллом', async () => {
    const record = await runJudge('two', INPUT, ctx({ two: answering('score: 2') }));

    assert.equal(record.prompt, buildCliJudgePrompt(INPUT));
    assert.match(record.raw_output, /score: 2/);
    assert.equal(record.own_score, 2);
    assert.equal(record.score, 2);
    assert.equal(record.passed, false);
    assert.equal(record.confidence, null);
    assert.equal(record.escalated, false);
    assert.equal(record.error, null);
  });

  it('уверенность ниже escalate_below — итог от escalate_to, ответ судьи остаётся', async () => {
    const agents = {
      decider: answering('score: 5\nconfidence: 0.5\ncost_usd: 0.0001', { escalate_to: 'two', escalate_below: 0.8 }),
      two: answering('score: 2'),
    };
    const record = await runJudge('decider', INPUT, ctx(agents));

    assert.equal(record.own_score, 5);
    assert.equal(record.confidence, 0.5);
    assert.equal(record.cost_usd, 0.0001);
    assert.equal(record.escalated, true);
    assert.equal(record.escalation.judge_agent, 'two');
    assert.equal(record.score, 2);
    assert.equal(record.passed, false);
  });

  it('уверенность ровно на пороге — переоценки нет; без escalate_below — тоже нет', async () => {
    const atThreshold = await runJudge('decider', INPUT, ctx({
      decider: answering('score: 5\nconfidence: 0.8', { escalate_to: 'two', escalate_below: 0.8 }),
      two: answering('score: 2'),
    }));
    assert.equal(atThreshold.escalated, false);
    assert.equal(atThreshold.score, 5);

    const noThreshold = await runJudge('decider', INPUT, ctx({
      decider: answering('score: 5\nconfidence: 0.1', { escalate_to: 'two' }),
      two: answering('score: 2'),
    }));
    assert.equal(noThreshold.escalated, false);
    assert.equal(noThreshold.score, 5);
  });

  it('судья с escalate_below не сообщил уверенность — переоценка', async () => {
    const record = await runJudge('decider', INPUT, ctx({
      decider: answering('score: 5', { escalate_to: 'two', escalate_below: 0.8 }),
      two: answering('score: 2'),
    }));

    assert.equal(record.escalated, true);
    assert.equal(record.score, 2);
  });

  it('ответ без балла с error_class — фоллбек этого класса, предупреждение одно на прогон', async () => {
    const lines = [];
    const agents = {
      decider: answering('status: error\nerror_class: no_key\nerror: key file is missing', { escalate_to: 'two' }),
      two: answering('score: 2'),
    };
    const shared = ctx(agents, { log: (line) => lines.push(line) });

    const first = await runJudge('decider', INPUT, shared);
    const second = await runJudge('decider', INPUT, shared);

    for (const record of [first, second]) {
      assert.equal(record.fallback, 'no_key');
      assert.match(record.fallback_detail, /key file is missing/);
      assert.equal(record.score, 2);
      assert.equal(record.error, null, 'escalate_to дал балл — попытка не ошибочна');
      assert.equal(record.error_class, null, 'класс сбоя судьи — в fallback, не в итоге попытки');
    }
    assert.equal(lines.filter((line) => line.includes('no_key')).length, 1, lines.join('\n'));
  });

  it('судья упал — фоллбек judge_error; упал и escalate_to — ошибка попытки с обоими ответами', async () => {
    const fallback = await runJudge('decider', INPUT, ctx({ decider: crashing({ escalate_to: 'two' }), two: answering('score: 2') }));
    assert.equal(fallback.fallback, 'judge_error');
    assert.equal(fallback.score, 2);

    const both = await runJudge('decider', INPUT, ctx({
      decider: answering('score: 5\nconfidence: 0.1', { escalate_to: 'broken', escalate_below: 0.8 }),
      broken: crashing(),
    }));
    assert.equal(both.own_score, 5);
    assert.match(both.escalation.error, /exited with code 3/);
    assert.match(both.error, /broken/);
    assert.equal(both.error_class, 'judge_error');
    assert.equal(both.score, null);
  });

  it('без переоценки — ответ без балла ошибка; ответ unparsed без класса', async () => {
    const record = await runJudge('seven', INPUT, ctx({ seven: answering('score: 7') }));
    assert.equal(record.error, 'judge output unparsed');
    assert.equal(record.error_class, 'unparsed');
    assert.equal(record.score, null);
  });

  it('noEscalation: неуверенный судья не переоценивается, отказ — ошибка записи', async () => {
    const agents = {
      decider: answering('score: 5\nconfidence: 0.3', { escalate_to: 'two', escalate_below: 0.8 }),
      failing: answering('status: error\nerror_class: auth\nerror: HTTP 401', { escalate_to: 'two' }),
      two: answering('score: 2'),
    };
    const unsure = await runJudge('decider', INPUT, ctx(agents, { noEscalation: true }));
    assert.equal(unsure.score, 5);
    assert.equal(unsure.escalation, null);

    const failed = await runJudge('failing', INPUT, ctx(agents, { noEscalation: true }));
    assert.match(failed.error, /^auth: /);
    assert.equal(failed.fallback, null);
    assert.equal(failed.score, null);
  });
});
