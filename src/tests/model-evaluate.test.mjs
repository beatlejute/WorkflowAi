/**
 * Слой оценки (src/lib/model-evaluate.mjs): один вход и выход для протоколов
 * decisions и chat.
 *
 * Модель — локальный HTTP-сервер на 127.0.0.1 (_model-server.mjs); сеть наружу
 * не используется. Изображение — во временном корне в os.tmpdir(), он снимается
 * в after().
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluate, extractFirstJsonObject } from '../lib/model-evaluate.mjs';
import { ModelClientError } from '../lib/model-client.mjs';
import { TEST_KEY, startModelServer, sendJson, decisionsResponse, chatResponse } from './_model-server.mjs';

const OPTIONS = Object.freeze({ env: { TEST_MODEL_KEY: TEST_KEY }, retryDelaysMs: [1, 1] });
const FIVE_LEVELS = Object.freeze(['не выполнено', 'почти нет', 'частично', 'в основном', 'полностью']);

let root;
before(() => {
  root = mkdtempSync(join(tmpdir(), 'wf-model-evaluate-'));
  writeFileSync(join(root, 'shot.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
});
after(() => {
  rmSync(root, { recursive: true, force: true });
});

function agent(protocol, url) {
  return { kind: 'http', protocol, url, model: `test/${protocol}`, auth: { env: 'TEST_MODEL_KEY' } };
}

function question(id, levels = FIVE_LEVELS) {
  return { id, text: `Вопрос ${id}`, levels: [...levels] };
}

/** Ответ decisions на вопросы с заданными вероятностями: { id: probabilities }. */
function decisionsFor(byId, confidence = 0.9) {
  const answers = {};
  for (const [id, probabilities] of Object.entries(byId)) {
    answers[id] = { type: 'score', score: 0, legend: {}, probabilities, confidence };
  }
  return decisionsResponse(answers);
}

async function withServer(handler, fn) {
  const server = await startModelServer(handler);
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

async function rejectsWithClass(promise, errorClass) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof ModelClientError, `ожидалась ModelClientError, получено ${err}`);
    assert.equal(err.class, errorClass, err.message);
    return true;
  });
}

describe('model-evaluate: decisions', () => {
  it('{"3": 0.9, "4": 0.1} — level 4, confidence 0.9', async () => {
    await withServer((req, res) => sendJson(res, 200, decisionsFor({ q1: { 3: 0.9, 4: 0.1 } }, 0.9)), async (server) => {
      const result = await evaluate(agent('decisions', server.url('/d')), { data: 'вывод', questions: [question('q1')] }, OPTIONS);

      assert.deepEqual(result.answers.q1, {
        level: 4,
        confidence: 0.9,
        probabilities: { 3: 0.9, 4: 0.1 },
        reason: null,
      });
      assert.equal(result.model, 'typesafe/jev-1.13-20260917');
      assert.equal(result.cost_usd, 0.000126672);
      assert.equal(typeof result.duration_ms, 'number');
      // raw — answers провайдера как есть, с его score и legend
      assert.deepEqual(result.raw, {
        q1: { type: 'score', score: 0, legend: {}, probabilities: { 3: 0.9, 4: 0.1 }, confidence: 0.9 },
      });
    });
  });

  it('равные вероятности уровней 3 и 4 — level 3 (меньший)', async () => {
    await withServer((req, res) => sendJson(res, 200, decisionsFor({ q1: { 2: 0.5, 3: 0.5 } })), async (server) => {
      const result = await evaluate(agent('decisions', server.url('/d')), { data: 'x', questions: [question('q1')] }, OPTIONS);
      assert.equal(result.answers.q1.level, 3);
    });
  });

  it('несколько вопросов с разным числом уровней — одним запросом под своими id', async () => {
    const handler = (req, res) => sendJson(res, 200, decisionsFor({ 'dod-1': { 0: 0.2, 1: 0.8 }, 'dod-2': { 4: 1 } }));
    await withServer(handler, async (server) => {
      const result = await evaluate(agent('decisions', server.url('/d')), {
        data: { report: 'отчёт' },
        questions: [question('dod-1', ['нет', 'да']), question('dod-2')],
      }, OPTIONS);

      assert.equal(server.requests.length, 1);
      assert.deepEqual(server.requests[0].json.state, { report: 'отчёт' });
      assert.deepEqual(server.requests[0].json.questions['dod-1'], {
        type: 'score', instructions: 'Вопрос dod-1', criteria: ['нет', 'да'],
      });
      assert.equal(result.answers['dod-1'].level, 2);
      assert.equal(result.answers['dod-2'].level, 5);
    });
  });

  it('нет ответа на вопрос — bad_response', async () => {
    await withServer((req, res) => sendJson(res, 200, decisionsFor({ q1: { 0: 1 } })), async (server) => {
      await rejectsWithClass(evaluate(agent('decisions', server.url('/d')),
        { data: 'x', questions: [question('q1'), question('q2')] }, OPTIONS), 'bad_response');
    });
  });

  it('уровень вне 1..n — bad_response', async () => {
    await withServer((req, res) => sendJson(res, 200, decisionsFor({ q1: { 2: 1 } })), async (server) => {
      await rejectsWithClass(evaluate(agent('decisions', server.url('/d')),
        { data: 'x', questions: [question('q1', ['нет', 'да'])] }, OPTIONS), 'bad_response');
    });
  });

  it('изображения — bad_request без запроса', async () => {
    await withServer((req, res) => sendJson(res, 200, decisionsFor({ q1: { 0: 1 } })), async (server) => {
      await rejectsWithClass(evaluate(agent('decisions', server.url('/d')),
        { data: 'x', images: [join(root, 'shot.png')], questions: [question('q1')] }, OPTIONS), 'bad_request');
      assert.equal(server.requests.length, 0);
    });
  });
});

describe('model-evaluate: chat', () => {
  it('{"answers":[{"id":"q1","level":2,"reason":"…"}]} — level 2, confidence null', async () => {
    const reply = JSON.stringify({ answers: [{ id: 'q1', level: 2, reason: 'Нет тестов' }] });
    await withServer((req, res) => sendJson(res, 200, chatResponse(reply, { usage: { cost: 0.002 } })), async (server) => {
      const result = await evaluate(agent('chat', server.url('/c')), { data: 'вывод', questions: [question('q1')] }, OPTIONS);

      assert.deepEqual(result.answers.q1, { level: 2, confidence: null, probabilities: null, reason: 'Нет тестов' });
      assert.equal(result.cost_usd, 0.002);
      assert.equal(result.raw, reply, 'raw — текст ответа модели как есть');

      const { messages } = server.requests[0].json;
      assert.equal(messages[0].role, 'system');
      assert.match(messages[0].content, /JSON/);
      assert.match(messages[1].content, /вывод/);
      assert.match(messages[1].content, /id: q1/);
      assert.match(messages[1].content, /2\. почти нет/);
    });
  });

  it('JSON внутри текста — берётся первый JSON-объект', async () => {
    const reply = 'Разбор:\n```json\n{"answers":[{"id":"q1","level":5,"reason":"строка со скобкой }"}]}\n```\nИ ещё {"answers":[]}';
    await withServer((req, res) => sendJson(res, 200, chatResponse(reply)), async (server) => {
      const result = await evaluate(agent('chat', server.url('/c')), { data: 'x', questions: [question('q1')] }, OPTIONS);
      assert.equal(result.answers.q1.level, 5);
      assert.equal(result.answers.q1.reason, 'строка со скобкой }');
    });
  });

  it('ответ без JSON — bad_response', async () => {
    await withServer((req, res) => sendJson(res, 200, chatResponse('Уровень 4, всё хорошо.')), async (server) => {
      await rejectsWithClass(evaluate(agent('chat', server.url('/c')),
        { data: 'x', questions: [question('q1')] }, OPTIONS), 'bad_response');
    });
  });

  it('пропущенный ответ — bad_response', async () => {
    const reply = JSON.stringify({ answers: [{ id: 'q1', level: 1 }] });
    await withServer((req, res) => sendJson(res, 200, chatResponse(reply)), async (server) => {
      await rejectsWithClass(evaluate(agent('chat', server.url('/c')),
        { data: 'x', questions: [question('q1'), question('q2')] }, OPTIONS), 'bad_response');
    });
  });

  // true, [3] и null не уровень: Number() превратил бы true в молчаливый уровень 1.
  for (const level of [0, 6, 2.5, 'четыре', true, [3], null, '2.0']) {
    it(`уровень ${JSON.stringify(level)} не из 1..5 — bad_response`, async () => {
      const reply = JSON.stringify({ answers: [{ id: 'q1', level }] });
      await withServer((req, res) => sendJson(res, 200, chatResponse(reply)), async (server) => {
        await rejectsWithClass(evaluate(agent('chat', server.url('/c')),
          { data: 'x', questions: [question('q1')] }, OPTIONS), 'bad_response');
      });
    });
  }

  it('уровень строкой из цифр ("2") принимается', async () => {
    const reply = JSON.stringify({ answers: [{ id: 'q1', level: '2' }] });
    await withServer((req, res) => sendJson(res, 200, chatResponse(reply)), async (server) => {
      const result = await evaluate(agent('chat', server.url('/c')), { data: 'x', questions: [question('q1')] }, OPTIONS);
      assert.equal(result.answers.q1.level, 2);
    });
  });

  it('объект без answers перед ответом (цитата данных) пропускается', async () => {
    const reply = 'Данные: {"report": "отчёт", "id": "q1"}\nОтвет: {"answers":[{"id":"q1","level":4}]}';
    await withServer((req, res) => sendJson(res, 200, chatResponse(reply)), async (server) => {
      const result = await evaluate(agent('chat', server.url('/c')), { data: 'x', questions: [question('q1')] }, OPTIONS);
      assert.equal(result.answers.q1.level, 4);
    });
  });

  it('изображения передаются частями image_url', async () => {
    const reply = JSON.stringify({ answers: [{ id: 'q1', level: 3 }] });
    await withServer((req, res) => sendJson(res, 200, chatResponse(reply)), async (server) => {
      await evaluate(agent('chat', server.url('/c')),
        { data: 'x', images: [join(root, 'shot.png')], questions: [question('q1')] }, OPTIONS);
      const content = server.requests[0].json.messages[1].content;
      assert.equal(content[1].type, 'image_url');
      assert.ok(content[1].image_url.url.startsWith('data:image/png;base64,'));
    });
  });
});

describe('model-evaluate: проверка входа', () => {
  const cases = [
    ['пустой список вопросов', { data: 'x', questions: [] }],
    ['вопросы не список', { data: 'x', questions: { q1: 'x' } }],
    ['один уровень', { data: 'x', questions: [question('q1', ['только'])] }],
    ['одиннадцать уровней', { data: 'x', questions: [question('q1', Array.from({ length: 11 }, (_, i) => `у${i}`))] }],
    ['повтор id', { data: 'x', questions: [question('q1'), question('q1')] }],
    ['вопрос без текста', { data: 'x', questions: [{ id: 'q1', text: '', levels: ['a', 'b'] }] }],
  ];
  for (const [label, input] of cases) {
    it(`${label} — bad_request без запроса`, async () => {
      await withServer((req, res) => sendJson(res, 200, chatResponse('{}')), async (server) => {
        await rejectsWithClass(evaluate(agent('chat', server.url('/c')), input, OPTIONS), 'bad_request');
        assert.equal(server.requests.length, 0);
      });
    });
  }

  it('extractFirstJsonObject пропускает битый объект и берёт следующий', () => {
    assert.deepEqual(extractFirstJsonObject('{не json} потом {"a":1}'), { a: 1 });
    assert.equal(extractFirstJsonObject('без объекта'), null);
  });
});
