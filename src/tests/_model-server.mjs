// Локальный HTTP-сервер для тестов клиента безынструментного агента
// (model-client, model-evaluate, runner-model-io). Слушает 127.0.0.1 на
// свободном порту; сеть наружу тесты не используют.
import http from 'node:http';

export const TEST_KEY = 'local-test-key-123';

/**
 * handler(request, res, n) — request: { method, url, headers, body, json }, n — номер
 * запроса с 1. Возвращает { url(path), requests, close() }.
 */
export async function startModelServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
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
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    requests,
    url: (path = '/') => `http://127.0.0.1:${port}${path}`,
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
