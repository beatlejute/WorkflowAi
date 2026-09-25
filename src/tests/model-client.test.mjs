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
  TEST_KEY, startModelServer, startConnectProxy, sendJson, closedPort, decisionsResponse, chatResponse,
} from './_model-server.mjs';
import { makeSelfSignedCert } from './_test-cert.mjs';

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

  // Windows: имена переменных не зависят от регистра, а копия { ...process.env }
  // эту особенность теряет — клиент ищет имя сам.
  it('win32: переменная ключа находится без учёта регистра имени', async () => {
    const server = await startModelServer((req, res) => sendJson(res, 200, chatResponse('ok')));
    try {
      await chat(chatAgent(server.url('/chat')), { message: 'm' },
        { retryDelaysMs: [1, 1], env: { Test_Model_Key: TEST_KEY }, platform: 'win32' });
      assert.equal(server.requests[0].headers.authorization, `Bearer ${TEST_KEY}`);
    } finally {
      await server.close();
    }
  });

  it('не win32: имя переменной ключа сравнивается точно', async () => {
    await rejectsWithClass(chat(chatAgent('http://127.0.0.1:9/chat'), { message: 'm' },
      { env: { Test_Model_Key: TEST_KEY }, platform: 'linux' }), 'no_key');
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

  for (const url of ['http://openrouter.ai/api/v1/chat/completions', 'http://10.0.0.5:8080/chat', 'ftp://127.0.0.1/chat']) {
    it(`${url} — bad_request до вызова: ключ не уходит открытым текстом`, async () => {
      const err = await rejectsWithClass(chat(chatAgent(url), { message: 'm' }, FAST), 'bad_request');
      assert.match(err.message, /https:\/\//);
    });
  }

  it('signal прерывает запрос — aborted без ожидания таймаута', async () => {
    const controller = new AbortController();
    const server = await startModelServer(() => setImmediate(() => controller.abort()));
    try {
      const started = Date.now();
      await rejectsWithClass(chat(chatAgent(server.url('/chat'), { timeout_s: 30 }), { message: 'm' },
        { ...FAST, signal: controller.signal }), 'aborted');
      assert.ok(Date.now() - started < 5000, 'запрос снят сразу, а не по timeout_s');
      assert.equal(server.requests.length, 1);
    } finally {
      await server.close();
    }
  });

  it('signal прерывает паузу повтора', async () => {
    const controller = new AbortController();
    const server = await startModelServer((req, res) => {
      sendJson(res, 503, { error: 'busy' });
      setTimeout(() => controller.abort(), 50);
    });
    try {
      const started = Date.now();
      await rejectsWithClass(chat(chatAgent(server.url('/chat')), { message: 'm' },
        { env: ENV, retryDelaysMs: [60_000, 60_000], signal: controller.signal }), 'aborted');
      assert.ok(Date.now() - started < 5000, 'пауза 60 с снята прерыванием');
      assert.equal(server.requests.length, 1);
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

// ---------------------------------------------------------------------------
// Прокси: туннель CONNECT до https-адреса
// ---------------------------------------------------------------------------

// Боевой путь на машине, где провайдер доступен только через прокси
// (lib/agent-env.mjs): CONNECT → TLS внутри туннеля → POST. Сервер модели —
// локальный HTTPS с самоподписанным сертификатом (_test-cert.mjs), клиенту он
// передан доверенным через options.ca.
describe('model-client: прокси', () => {
  let tlsOptions;
  before(() => {
    tlsOptions = makeSelfSignedCert('localhost');
  });

  function proxyOptions(proxyUrl, extra = {}) {
    return { retryDelaysMs: [1, 1], env: { TEST_MODEL_KEY: TEST_KEY, HTTPS_PROXY: proxyUrl }, ca: tlsOptions.cert, ...extra };
  }

  it('https через прокси: CONNECT на host:port с Proxy-Authorization, ответ модели прочитан', async () => {
    const server = await startModelServer((req, res) => sendJson(res, 200, chatResponse('через туннель')), { tls: tlsOptions });
    const proxy = await startConnectProxy();
    try {
      const result = await chat(chatAgent(server.url('/api/v1/chat/completions')), { message: 'm' }, proxyOptions(proxy.url));

      assert.equal(result.text, 'через туннель');
      assert.equal(proxy.connects.length, 1);
      assert.equal(proxy.connects[0].url, `localhost:${server.port}`);
      assert.equal(proxy.connects[0].headers['proxy-authorization'],
        `Basic ${Buffer.from('user:pa@ss').toString('base64')}`);
      assert.equal(server.requests[0].headers.authorization, `Bearer ${TEST_KEY}`);
      assert.equal(server.requests[0].url, '/api/v1/chat/completions');
    } finally {
      await proxy.close();
      await server.close();
    }
  });

  it('win32: переменная прокси находится без учёта регистра имени', async () => {
    const server = await startModelServer((req, res) => sendJson(res, 200, chatResponse('ok')), { tls: tlsOptions });
    const proxy = await startConnectProxy();
    try {
      await chat(chatAgent(server.url('/chat')), { message: 'm' }, {
        retryDelaysMs: [1, 1],
        env: { TEST_MODEL_KEY: TEST_KEY, Https_Proxy: proxy.url },
        platform: 'win32',
        ca: tlsOptions.cert,
      });
      assert.equal(proxy.connects.length, 1);
    } finally {
      await proxy.close();
      await server.close();
    }
  });

  it('прокси отказывает в туннеле (407) — два повтора, затем network', async () => {
    const proxy = await startConnectProxy({ status: 407 });
    try {
      const err = await rejectsWithClass(chat(chatAgent('https://localhost:9/chat'), { message: 'm' }, proxyOptions(proxy.url)), 'network');
      assert.match(err.message, /407/);
      assert.equal(proxy.connects.length, 3);
    } finally {
      await proxy.close();
    }
  });

  it('таймаут внутри туннеля — timeout, туннель закрыт', async () => {
    const server = await startModelServer(() => { /* не отвечает */ }, { tls: tlsOptions });
    const proxy = await startConnectProxy();
    try {
      await rejectsWithClass(chat(chatAgent(server.url('/chat'), { timeout_s: 0.5 }), { message: 'm' }, proxyOptions(proxy.url)), 'timeout');
      for (let i = 0; i < 50 && proxy.openTunnels() > 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(proxy.openTunnels(), 0, 'сокет туннеля снят вместе с запросом');
    } finally {
      await proxy.close();
      await server.close();
    }
  });

  it('сертификат сервера не доверен — network, ключ не уходит', async () => {
    const server = await startModelServer((req, res) => sendJson(res, 200, chatResponse('ok')), { tls: tlsOptions });
    const proxy = await startConnectProxy();
    try {
      await rejectsWithClass(chat(chatAgent(server.url('/chat')), { message: 'm' },
        proxyOptions(proxy.url, { ca: undefined })), 'network');
      assert.equal(server.requests.length, 0);
    } finally {
      await proxy.close();
      await server.close();
    }
  });
});

describe('model-client: уже прерванный signal и IPv6 через прокси', () => {
  it('уже прерванный signal — aborted, запрос не отправляется', async () => {
    const server = await startModelServer((req, res) => sendJson(res, 200, chatResponse('ok')));
    try {
      const controller = new AbortController();
      controller.abort();
      await rejectsWithClass(chat(chatAgent(server.url('/chat')), { message: 'm' },
        { ...FAST, signal: controller.signal }), 'aborted');
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(server.requests.length, 0);
    } finally {
      await server.close();
    }
  });

  it('IPv6-литерал в CONNECT — в скобках: [::1]:порт', async () => {
    const proxy = await startConnectProxy({ status: 407 });
    try {
      await rejectsWithClass(chat(chatAgent('https://[::1]:9/chat'), { message: 'm' },
        { retryDelaysMs: [], env: { TEST_MODEL_KEY: TEST_KEY, HTTPS_PROXY: proxy.url } }), 'network');
      assert.equal(proxy.connects[0].url, '[::1]:9');
      assert.equal(proxy.connects[0].headers.host, '[::1]:9');
    } finally {
      await proxy.close();
    }
  });
});
