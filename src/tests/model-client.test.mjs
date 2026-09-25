/**
 * Клиент безынструментного агента (src/lib/model-client.mjs): протоколы chat
 * (в том числе изображения) и decisions, ключ, повторы, классы ошибок.
 *
 * Модель — локальный HTTP-сервер на 127.0.0.1 (_model-server.mjs); сеть наружу
 * не используется. Файлы (изображения, файл авторизации kilo) — во временном
 * корне в os.tmpdir(), он снимается в after().
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chat, decide, ModelClientError } from '../lib/model-client.mjs';
import {
  TEST_KEY, startModelServer, sendJson, closedPort, decisionsResponse, chatResponse,
} from './_model-server.mjs';

const ENV = Object.freeze({ TEST_MODEL_KEY: TEST_KEY });
// Паузы повторов укорочены: у клиента по умолчанию 2 и 4 с.
const FAST = Object.freeze({ env: ENV, retryDelaysMs: [1, 1] });

let root;
before(() => {
  root = mkdtempSync(join(tmpdir(), 'wf-model-client-'));
});
after(() => {
  rmSync(root, { recursive: true, force: true });
});

function chatAgent(url, extra = {}) {
  return { kind: 'http', protocol: 'chat', url, model: 'vendor/chat-model', auth: { env: 'TEST_MODEL_KEY' }, ...extra };
}

function decisionsAgent(url, extra = {}) {
  return { kind: 'http', protocol: 'decisions', url, model: 'typesafe/jev-1.13', auth: { env: 'TEST_MODEL_KEY' }, ...extra };
}

/** Ошибка клиента заданного класса; сообщение не содержит ключа. */
async function rejectsWithClass(promise, errorClass) {
  let caught = null;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof ModelClientError, `ожидалась ModelClientError, получено ${caught}`);
  assert.equal(caught.class, errorClass, caught.message);
  assert.ok(!caught.message.includes(TEST_KEY), 'ключ не должен попадать в сообщение ошибки');
  return caught;
}

// ---------------------------------------------------------------------------
// chat
// ---------------------------------------------------------------------------

describe('model-client: протокол chat', () => {
  it('текст и источники из ответа, без tools, Bearer из auth.env', async () => {
    const server = await startModelServer((req, res) => sendJson(res, 200, chatResponse('Итог исследования', {
      annotations: [
        { type: 'url_citation', url_citation: { url: 'https://a.example/1', title: 'Источник A' } },
        { type: 'url_citation', url_citation: { url: 'https://a.example/1', title: 'Повтор' } },
        { type: 'url_citation', url_citation: { url: 'https://b.example/2' } },
        { type: 'file_citation', file_citation: { file_id: 'x' } },
      ],
      usage: { total_tokens: 42, cost: 0.0012 },
    })));
    try {
      const result = await chat(chatAgent(server.url('/api/v1/chat/completions')), {
        system: 'Системное правило',
        message: 'Вопрос',
      }, FAST);

      assert.equal(result.text, 'Итог исследования');
      assert.deepEqual(result.citations, [
        { url: 'https://a.example/1', title: 'Источник A' },
        { url: 'https://b.example/2', title: null },
      ]);
      assert.equal(result.cost_usd, 0.0012);
      assert.deepEqual(result.usage, { total_tokens: 42, cost: 0.0012 });
      assert.equal(result.model, 'vendor/chat-model-20260901');
      assert.equal(typeof result.duration_ms, 'number');

      assert.equal(server.requests.length, 1);
      const [request] = server.requests;
      assert.equal(request.url, '/api/v1/chat/completions');
      assert.equal(request.headers.authorization, `Bearer ${TEST_KEY}`);
      assert.equal(request.headers['content-type'], 'application/json');
      assert.ok(!('tools' in request.json), 'поле tools не отправляется');
      assert.deepEqual(request.json, {
        model: 'vendor/chat-model',
        messages: [
          { role: 'system', content: 'Системное правило' },
          { role: 'user', content: 'Вопрос' },
        ],
      });
    } finally {
      await server.close();
    }
  });

  it('ответ без annotations — пустые источники; без usage.cost — cost_usd null', async () => {
    const server = await startModelServer((req, res) => sendJson(res, 200, chatResponse('ok', { usage: { total_tokens: 3 } })));
    try {
      const result = await chat(chatAgent(server.url('/chat')), { message: 'm' }, FAST);
      assert.deepEqual(result.citations, []);
      assert.equal(result.cost_usd, null);
      assert.equal(server.requests[0].json.messages.length, 1, 'без system — только сообщение пользователя');
    } finally {
      await server.close();
    }
  });

  it('пустой choices — bad_response', async () => {
    const server = await startModelServer((req, res) => sendJson(res, 200, { choices: [] }));
    try {
      await rejectsWithClass(chat(chatAgent(server.url('/chat')), { message: 'm' }, FAST), 'bad_response');
    } finally {
      await server.close();
    }
  });

  it('ответ не JSON — bad_response', async () => {
    const server = await startModelServer((req, res) => { res.writeHead(200); res.end('<html>gateway</html>'); });
    try {
      await rejectsWithClass(chat(chatAgent(server.url('/chat')), { message: 'm' }, FAST), 'bad_response');
    } finally {
      await server.close();
    }
  });
});

describe('model-client: ключ', () => {
  it('пустая переменная из auth.env — no_key без запроса', async () => {
    const server = await startModelServer((req, res) => sendJson(res, 200, chatResponse('ok')));
    try {
      await rejectsWithClass(chat(chatAgent(server.url('/chat')), { message: 'm' }, { ...FAST, env: {} }), 'no_key');
      assert.equal(server.requests.length, 0);
    } finally {
      await server.close();
    }
  });

  function writeKiloAuth(home, kilo) {
    const dir = join(home, '.local', 'share', 'kilo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ kilo }));
  }

  it('kilo_oauth — Bearer из kilo.access', async () => {
    const home = mkdtempSync(join(root, 'home-'));
    writeKiloAuth(home, { access: 'kilo-access-token', expires: Date.now() + 3600_000 });
    const server = await startModelServer((req, res) => sendJson(res, 200, chatResponse('ok')));
    try {
      await chat(chatAgent(server.url('/chat'), { auth: { kilo_oauth: true } }), { message: 'm' },
        { retryDelaysMs: [1, 1], env: { HOME: home, USERPROFILE: home } });
      assert.equal(server.requests[0].headers.authorization, 'Bearer kilo-access-token');
    } finally {
      await server.close();
    }
  });

  it('kilo_oauth с истёкшим токеном — no_key без запроса', async () => {
    const home = mkdtempSync(join(root, 'home-'));
    writeKiloAuth(home, { access: 'kilo-access-token', expires: Date.now() - 1000 });
    const server = await startModelServer((req, res) => sendJson(res, 200, chatResponse('ok')));
    try {
      const err = await rejectsWithClass(chat(chatAgent(server.url('/chat'), { auth: { kilo_oauth: true } }),
        { message: 'm' }, { retryDelaysMs: [1, 1], env: { HOME: home, USERPROFILE: home } }), 'no_key');
      assert.match(err.message, /expired/);
      assert.equal(server.requests.length, 0);
    } finally {
      await server.close();
    }
  });

  it('kilo_oauth без файла авторизации — no_key', async () => {
    const home = mkdtempSync(join(root, 'home-'));
    await rejectsWithClass(chat(chatAgent('http://127.0.0.1:9/chat', { auth: { kilo_oauth: true } }),
      { message: 'm' }, { env: { HOME: home, USERPROFILE: home } }), 'no_key');
  });
});

describe('model-client: повторы и классы ошибок', () => {
  it('429 — два повтора, затем rate_limit', async () => {
    const server = await startModelServer((req, res) => sendJson(res, 429, { error: 'slow down' }));
    try {
      const err = await rejectsWithClass(chat(chatAgent(server.url('/chat')), { message: 'm' }, FAST), 'rate_limit');
      assert.equal(server.requests.length, 3, 'первая попытка и два повтора');
      assert.equal(err.status, 429);
    } finally {
      await server.close();
    }
  });

  for (const status of [401, 403]) {
    it(`${status} — auth без повторов, ключ не в сообщении`, async () => {
      // Сервер повторяет заголовок авторизации в теле — клиент обязан его вычистить.
      const server = await startModelServer((req, res) => sendJson(res, status, { error: `bad key ${req.headers.authorization}` }));
      try {
        await rejectsWithClass(chat(chatAgent(server.url('/chat')), { message: 'm' }, FAST), 'auth');
        assert.equal(server.requests.length, 1);
      } finally {
        await server.close();
      }
    });
  }

  for (const status of [500, 502, 503]) {
    it(`${status} — два повтора, затем server`, async () => {
      const server = await startModelServer((req, res) => sendJson(res, status, { error: 'down' }));
      try {
        await rejectsWithClass(chat(chatAgent(server.url('/chat')), { message: 'm' }, FAST), 'server');
        assert.equal(server.requests.length, 3);
      } finally {
        await server.close();
      }
    });
  }

  it('504 — server без повторов', async () => {
    const server = await startModelServer((req, res) => sendJson(res, 504, { error: 'gateway' }));
    try {
      await rejectsWithClass(chat(chatAgent(server.url('/chat')), { message: 'm' }, FAST), 'server');
      assert.equal(server.requests.length, 1);
    } finally {
      await server.close();
    }
  });

  it('503, затем 200 — успех со второй попытки', async () => {
    const server = await startModelServer((req, res, n) => (n === 1
      ? sendJson(res, 503, { error: 'busy' })
      : sendJson(res, 200, chatResponse('после повтора'))));
    try {
      const result = await chat(chatAgent(server.url('/chat')), { message: 'm' }, FAST);
      assert.equal(result.text, 'после повтора');
      assert.equal(server.requests.length, 2);
    } finally {
      await server.close();
    }
  });

  it('прочий 4xx (превышение контекста) — bad_request без повторов', async () => {
    const server = await startModelServer((req, res) => sendJson(res, 400, { error: 'context length exceeded' }));
    try {
      const err = await rejectsWithClass(chat(chatAgent(server.url('/chat')), { message: 'm' }, FAST), 'bad_request');
      assert.match(err.message, /context length exceeded/);
      assert.equal(server.requests.length, 1);
    } finally {
      await server.close();
    }
  });

  it('ответ дольше timeout_s — timeout', async () => {
    const server = await startModelServer(() => { /* не отвечает */ });
    try {
      await rejectsWithClass(chat(chatAgent(server.url('/chat'), { timeout_s: 0.3 }), { message: 'm' }, FAST), 'timeout');
    } finally {
      await server.close();
    }
  });

  it('никто не слушает порт — два повтора, затем network', async () => {
    const port = await closedPort();
    const err = await rejectsWithClass(chat(chatAgent(`http://127.0.0.1:${port}/chat`), { message: 'm' }, FAST), 'network');
    assert.equal(err.attempts, 3);
  });
});

// ---------------------------------------------------------------------------
// chat: изображения
// ---------------------------------------------------------------------------

// Сигнатура PNG и чанк IHDR 1×1: клиенту важны байты файла, не картинка.
const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');

describe('model-client: изображения в chat', () => {
  let imagesDir;
  before(() => {
    imagesDir = mkdtempSync(join(root, 'images-'));
    writeFileSync(join(imagesDir, 'shot.png'), PNG_BYTES);
    writeFileSync(join(imagesDir, 'photo.jpeg'), Buffer.from('ffd8ffe000104a464946', 'hex'));
    writeFileSync(join(imagesDir, 'big.png'), Buffer.alloc(6 * 1024 * 1024));
    writeFileSync(join(imagesDir, 'anim.gif'), Buffer.from('47494638396101000100', 'hex'));
  });

  it('изображение уходит частью image_url с data URL и тем же содержимым', async () => {
    const server = await startModelServer((req, res) => sendJson(res, 200, chatResponse('видно')));
    try {
      await chat(chatAgent(server.url('/chat')), {
        message: 'Что на скриншоте?',
        images: ['shot.png', 'photo.jpeg'],
      }, { ...FAST, cwd: imagesDir });

      const content = server.requests[0].json.messages[0].content;
      assert.ok(Array.isArray(content), 'content — массив частей');
      assert.deepEqual(content[0], { type: 'text', text: 'Что на скриншоте?' });
      assert.equal(content[1].type, 'image_url');
      const pngUrl = content[1].image_url.url;
      assert.ok(pngUrl.startsWith('data:image/png;base64,'));
      assert.deepEqual(Buffer.from(pngUrl.slice('data:image/png;base64,'.length), 'base64'),
        readFileSync(join(imagesDir, 'shot.png')));
      assert.ok(content[2].image_url.url.startsWith('data:image/jpeg;base64,'));
    } finally {
      await server.close();
    }
  });

  it('изображение 6 МБ — bad_request без запроса', async () => {
    const server = await startModelServer((req, res) => sendJson(res, 200, chatResponse('x')));
    try {
      const err = await rejectsWithClass(chat(chatAgent(server.url('/chat')), { message: 'm', images: ['big.png'] },
        { ...FAST, cwd: imagesDir }), 'bad_request');
      assert.match(err.message, /big\.png/);
      assert.equal(server.requests.length, 0);
    } finally {
      await server.close();
    }
  });

  it('изображений больше 8 — bad_request', async () => {
    const images = Array.from({ length: 9 }, () => 'shot.png');
    await rejectsWithClass(chat(chatAgent('http://127.0.0.1:9/chat'), { message: 'm', images },
      { ...FAST, cwd: imagesDir }), 'bad_request');
  });

  it('ограничения — параметры клиента', async () => {
    await rejectsWithClass(chat(chatAgent('http://127.0.0.1:9/chat'), { message: 'm', images: ['shot.png'] },
      { ...FAST, cwd: imagesDir, imageLimits: { maxBytes: 10 } }), 'bad_request');
  });

  it('неподдерживаемый формат — bad_request', async () => {
    await rejectsWithClass(chat(chatAgent('http://127.0.0.1:9/chat'), { message: 'm', images: ['anim.gif'] },
      { ...FAST, cwd: imagesDir }), 'bad_request');
  });

  it('файла нет — bad_request с путём', async () => {
    const err = await rejectsWithClass(chat(chatAgent('http://127.0.0.1:9/chat'), { message: 'm', images: ['missing.png'] },
      { ...FAST, cwd: imagesDir }), 'bad_request');
    assert.match(err.message, /missing\.png/);
  });
});

// ---------------------------------------------------------------------------
// decisions
// ---------------------------------------------------------------------------

const VERDICT_ANSWER = Object.freeze({
  type: 'score',
  score: 3.99,
  legend: { 0: 'уровень 1', 1: 'уровень 2', 2: 'уровень 3', 3: 'уровень 4', 4: 'уровень 5' },
  probabilities: { 0: 0, 1: 0, 2: 0, 3: 0.01, 4: 0.99 },
  confidence: 0.98,
});

const QUESTIONS = Object.freeze({
  verdict: {
    type: 'score',
    instructions: 'Насколько вывод соответствует критерию?',
    criteria: ['уровень 1', 'уровень 2', 'уровень 3', 'уровень 4', 'уровень 5'],
  },
});

describe('model-client: протокол decisions', () => {
  it('answers, probabilities и confidence — без изменений; cost_usd = usage.cost', async () => {
    const server = await startModelServer((req, res) => sendJson(res, 200, decisionsResponse({ verdict: VERDICT_ANSWER })));
    try {
      const result = await decide(decisionsAgent(server.url('/api/alpha/decisions')), {
        state: { agent_output: 'вывод агента' },
        questions: QUESTIONS,
      }, FAST);

      assert.deepEqual(result.answers.verdict.probabilities, VERDICT_ANSWER.probabilities);
      assert.equal(result.answers.verdict.confidence, 0.98);
      assert.equal(result.cost_usd, 0.000126672);
      assert.equal(result.model, 'typesafe/jev-1.13-20260917');

      const [request] = server.requests;
      assert.equal(request.headers.authorization, `Bearer ${TEST_KEY}`);
      assert.deepEqual(Object.keys(request.json).sort(), ['model', 'questions', 'state']);
      assert.equal(request.json.model, 'typesafe/jev-1.13');
      assert.deepEqual(request.json.state, { agent_output: 'вывод агента' });
      assert.deepEqual(request.json.questions, QUESTIONS);
    } finally {
      await server.close();
    }
  });

  it('ответ без answers — bad_response', async () => {
    const server = await startModelServer((req, res) => sendJson(res, 200, { model: 'x', usage: {} }));
    try {
      await rejectsWithClass(decide(decisionsAgent(server.url('/d')), { state: 's', questions: QUESTIONS }, FAST), 'bad_response');
    } finally {
      await server.close();
    }
  });

  it('401 — auth без повторов', async () => {
    const server = await startModelServer((req, res) => sendJson(res, 401, { error: 'no' }));
    try {
      await rejectsWithClass(decide(decisionsAgent(server.url('/d')), { state: 's', questions: QUESTIONS }, FAST), 'auth');
      assert.equal(server.requests.length, 1);
    } finally {
      await server.close();
    }
  });

  it('429 — два повтора, затем rate_limit', async () => {
    const server = await startModelServer((req, res) => sendJson(res, 429, { error: 'slow' }));
    try {
      await rejectsWithClass(decide(decisionsAgent(server.url('/d')), { state: 's', questions: QUESTIONS }, FAST), 'rate_limit');
      assert.equal(server.requests.length, 3);
    } finally {
      await server.close();
    }
  });

  it('изображения в запросе — bad_request без запроса', async () => {
    const server = await startModelServer((req, res) => sendJson(res, 200, decisionsResponse({ verdict: VERDICT_ANSWER })));
    try {
      await rejectsWithClass(decide(decisionsAgent(server.url('/d')),
        { state: 's', questions: QUESTIONS, images: ['shot.png'] }, FAST), 'bad_request');
      assert.equal(server.requests.length, 0);
    } finally {
      await server.close();
    }
  });
});
