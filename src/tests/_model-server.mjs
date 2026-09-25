// Локальный HTTP-сервер для тестов клиента безынструментного агента
// (model-client, model-evaluate, runner-model-io). Слушает 127.0.0.1 на
// свободном порту; сеть наружу тесты не используют.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

export const TEST_KEY = 'local-test-key-123';

/**
 * handler(request, res, n) — request: { method, url, headers, body, json }, n — номер
 * запроса с 1. `tls: { key, cert }` — HTTPS-сервер (сертификат — _test-cert.mjs).
 * Возвращает { url(path), requests, close() }.
 */
export async function startModelServer(handler, { tls } = {}) {
  const requests = [];
  const listener = (req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      let json = null;
      try { json = JSON.parse(body); } catch { /* не JSON */ }
      const record = { method: req.method, url: req.url, headers: req.headers, body, json };
      requests.push(record);
      handler(record, res, requests.length);
    });
  };
  const server = tls ? https.createServer(tls, listener) : http.createServer(listener);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    requests,
    url: (path = '/') => (tls ? `https://localhost:${port}${path}` : `http://127.0.0.1:${port}${path}`),
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

export function sendJson(res, status, payload) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

/** Порт, на котором никто не слушает: сервер поднимается и сразу закрывается. */
export async function closedPort() {
  const server = await startModelServer(() => {});
  await server.close();
  return server.port;
}

/** Ответ decisions по форме пилота Jev (jev_output.jsonl); тексты уровней — синтетика. */
export function decisionsResponse(answers, { cost = 0.000126672 } = {}) {
  return {
    model: 'typesafe/jev-1.13-20260917',
    answers,
    usage: { input_tokens: 3016, output_tokens: 18, cost },
  };
}

export function chatResponse(content, { annotations, usage } = {}) {
  const message = { role: 'assistant', content };
  if (annotations) message.annotations = annotations;
  return {
    model: 'vendor/chat-model-20260901',
    choices: [{ index: 0, message }],
    ...(usage ? { usage } : {}),
  };
}

/**
 * HTTP-прокси с методом CONNECT. Запрошенный хост не резолвится: туннель всегда
 * идёт на 127.0.0.1 и запрошенный порт — `localhost` мог бы уйти в ::1, где
 * тестовый сервер не слушает. `status` ≠ 200 — прокси отказывает в туннеле.
 * Возвращает { url, connects, openTunnels(), close() }; в url — логин и пароль.
 */
export async function startConnectProxy({ status = 200 } = {}) {
  const connects = [];
  const tunnels = new Set();
  const server = http.createServer((req, res) => {
    res.writeHead(405);
    res.end();
  });
  server.on('connect', (req, clientSocket, head) => {
    connects.push({ url: req.url, headers: req.headers });
    tunnels.add(clientSocket);
    clientSocket.on('close', () => tunnels.delete(clientSocket));
    clientSocket.on('error', () => {});
    if (status !== 200) {
      clientSocket.end(`HTTP/1.1 ${status} Proxy Refused\r\n\r\n`);
      return;
    }
    const port = Number(req.url.split(':').pop());
    const upstream = net.connect(port, '127.0.0.1', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('close', () => upstream.destroy());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    connects,
    url: `http://user:pa%40ss@127.0.0.1:${port}`,
    openTunnels: () => tunnels.size,
    close: () => new Promise((resolve) => {
      for (const socket of tunnels) socket.destroy();
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}
