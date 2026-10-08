/**
 * Срок подключения к HTTP-прокси и число попыток в тексте ошибки клиента
 * безынструментного агента (src/lib/model-client.mjs, openProxyTunnel и postJson).
 *
 * 2026-09-29/30 PulseProxy: селектор jev-place и ревью jev падали с «proxy connection
 * timeout» ровно за ~21,3 с — три попытки по 5 с и паузы 2 и 4 с, хотя объявлено 30 с
 * (PROXY_CONNECT_TIMEOUT_MS). CONNECT шёл через http.globalAgent, у которого в Node ≥ 19
 * timeout 5000, а req.setTimeout действует только после установки TCP.
 *
 * Что охраняется:
 *  - TCP до прокси не устанавливается (разрешение имени прокси не отвечает — фаза
 *    подключения без сети наружу): ошибка приходит по заданному сроку, а не через 5 с,
 *    и сообщение говорит, что TCP не установлен;
 *  - прокси принял соединение и молчит: ошибка по заданному сроку, сообщение — нет
 *    ответа на CONNECT;
 *  - таймер срока снимается вместе с запросом: попытка, снятая своим timeout_s раньше
 *    срока подключения, не держит процесс до конца этого срока;
 *  - в тексте сетевой ошибки после повторов и ошибки таймаута — число попыток.
 *
 * Первая проверка зависшего TCP использует запрос-заглушку без события `socket`, чтобы
 * проверять собственный таймер CONNECT независимо от системного DNS. Отдельный тест отмены
 * срока попытки оставляет `proxy-hang.test` с подменённым dns.lookup.
 *
 * Запуск: node --test src/tests/model-client-proxy-timeout.test.mjs
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chat, ModelClientError } from '../lib/model-client.mjs';
import { TEST_KEY, startModelServer, closedPort } from './_model-server.mjs';

const HANG_HOST = 'proxy-hang.test';
const CLIENT_URL = new URL('../lib/model-client.mjs', import.meta.url).href;

function chatAgent(url, extra = {}) {
  return { kind: 'http', protocol: 'chat', url, model: 'vendor/chat-model', auth: { env: 'TEST_MODEL_KEY' }, ...extra };
}

async function caught(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  assert.fail('ожидалась ошибка клиента');
}

/** Прокси, который принимает TCP и ничего не отвечает на CONNECT. */
async function startSilentProxy() {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    connections: () => sockets.size,
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(resolve);
    }),
  };
}

describe('model-client: срок подключения к прокси', () => {
  it('TCP до прокси не установлен — network по заданному сроку, не через 5 с', async () => {
    const request = new EventEmitter();
    let destroyed = false;
    request.end = () => {};
    request.destroy = (error) => {
      if (destroyed) return request;
      destroyed = true;
      if (error) request.emit('error', error);
      request.emit('close');
      return request;
    };
    const probe = mock.method(http, 'request', () => request);
    try {
      const started = performance.now();
      const err = await caught(chat(chatAgent('https://model.invalid/chat', { timeout_s: 30 }), { message: 'm' }, {
        env: { TEST_MODEL_KEY: TEST_KEY, HTTPS_PROXY: `http://${HANG_HOST}:3128` },
        retryDelaysMs: [],
        proxyConnectTimeoutMs: 7000,
      }));
      const elapsed = performance.now() - started;
      assert.equal(destroyed, true);
      assert.ok(err instanceof ModelClientError, String(err));
      assert.equal(err.class, 'network', err.message);
      assert.ok(elapsed >= 6800, `ошибка через ${elapsed} мс — срок 7 с не действует`);
      assert.ok(elapsed < 12000, `ошибка через ${elapsed} мс — срок подключения не сработал`);
      assert.match(err.message, /proxy connection timeout: TCP connection not established in 7s/);
      assert.match(err.message, /after 1 attempt:/);
    } finally {
      probe.mock.restore();
    }
  });

  it('прокси принял соединение и молчит — network по заданному сроку, нет ответа на CONNECT', async () => {
    const proxy = await startSilentProxy();
    try {
      const started = performance.now();
      const err = await caught(chat(chatAgent('https://model.invalid/chat', { timeout_s: 30 }), { message: 'm' }, {
        env: { TEST_MODEL_KEY: TEST_KEY, HTTPS_PROXY: proxy.url },
        retryDelaysMs: [1],
        proxyConnectTimeoutMs: 1500,
      }));
      const elapsed = performance.now() - started;
      assert.equal(err.class, 'network', err.message);
      assert.ok(elapsed >= 2900 && elapsed < 10000, `две попытки по 1,5 с, а прошло ${elapsed} мс`);
      assert.match(err.message, /proxy connection timeout: no CONNECT response in 1\.5s/);
      assert.match(err.message, /after 2 attempts:/);
      assert.equal(err.attempts, 2);
    } finally {
      await proxy.close();
    }
  });

  it('попытка снята своим timeout_s раньше срока подключения — таймер не держит процесс', async () => {
    // Отдельный процесс: время его выхода показывает, не остался ли таймер срока 30 с.
    const script = `
      import dns from 'node:dns';
      const original = dns.lookup;
      dns.lookup = function (host, ...rest) { return host === ${JSON.stringify(HANG_HOST)} ? {} : original.call(this, host, ...rest); };
      const { chat } = await import(${JSON.stringify(CLIENT_URL)});
      try {
        await chat({ kind: 'http', protocol: 'chat', url: 'https://model.invalid/chat', model: 'm', auth: { env: 'K' }, timeout_s: 1 },
          { message: 'm' }, { env: { K: 'k', HTTPS_PROXY: 'http://${HANG_HOST}:3128' }, retryDelaysMs: [] });
      } catch (err) {
        console.log(JSON.stringify({ class: err.class, message: err.message }));
      }
    `;
    const started = performance.now();
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    const code = await new Promise((resolve) => {
      const guard = setTimeout(() => { child.kill(); resolve('killed'); }, 20000);
      child.on('exit', (c) => { clearTimeout(guard); resolve(c); });
    });
    const elapsed = performance.now() - started;
    assert.equal(code, 0, out);
    const result = JSON.parse(out.trim().split('\n').pop());
    assert.equal(result.class, 'timeout', out);
    assert.match(result.message, /timed out after 1s \(attempt 1 of 1\)/);
    assert.ok(elapsed < 10000, `процесс вышел через ${elapsed} мс — таймер подключения остался`);
  });
});

describe('model-client: число попыток в тексте ошибки', () => {
  it('никто не слушает порт — «after 3 attempts» в сообщении network', async () => {
    const port = await closedPort();
    const err = await caught(chat(chatAgent(`http://127.0.0.1:${port}/chat`), { message: 'm' },
      { env: { TEST_MODEL_KEY: TEST_KEY }, retryDelaysMs: [1, 1] }));
    assert.equal(err.class, 'network', err.message);
    assert.match(err.message, /^Model request failed after 3 attempts: /);
    assert.equal(err.attempts, 3);
  });

  it('сервер молчит дольше timeout_s — номер попытки в сообщении timeout', async () => {
    const server = await startModelServer(() => {});
    try {
      const err = await caught(chat(chatAgent(server.url('/chat'), { timeout_s: 0.3 }), { message: 'm' },
        { env: { TEST_MODEL_KEY: TEST_KEY }, retryDelaysMs: [1, 1] }));
      assert.equal(err.class, 'timeout', err.message);
      assert.match(err.message, /^Model request timed out after 0\.3s \(attempt 1 of 3\)$/);
    } finally {
      await server.close();
    }
  });
});
