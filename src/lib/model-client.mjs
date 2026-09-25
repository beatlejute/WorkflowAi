/**
 * Клиент безынструментного агента (`kind: http`, README — «Безынструментные агенты»).
 *
 * Модель вызывается по HTTP без инструментов и без работы с файлами. Два протокола:
 *   - `chat` — текстовый ответ по формату OpenAI chat completions, в том числе на
 *     изображения; поле `tools` не отправляется. Форма запроса и разбор ответа —
 *     как у скрипта исследования (skills/deep-research/scripts/perplexity-research.js).
 *   - `decisions` — типизированная оценка OpenRouter (`POST …/api/alpha/decisions`):
 *     тело `{ model, state, questions }`, ответ `{ answers, usage }`; форма взята из
 *     пилота судьи Jev 2026-09-24 (201 вызов). Изображений протокол не принимает.
 *
 * Общее у протоколов: ключ, прокси, повторы и классы ошибок.
 *   - Ключ — `auth: { env: <ИМЯ> }` (только переменная окружения, файл `.env` не
 *     читается) или `auth: { kilo_oauth: true }` (`~/.local/share/kilo/auth.json`,
 *     поле `kilo.access`). В вывод и в сообщения ошибок ключ не попадает.
 *   - Прокси — первая заданная из HTTPS_PROXY, https_proxy, HTTP_PROXY, http_proxy,
 *     ALL_PROXY, all_proxy; только для `https:`-адресов, туннелем CONNECT.
 *   - Повторы — при HTTP 429, 500, 502, 503 и сетевой ошибке, до двух, с паузами
 *     2 и 4 с. Таймаут одной попытки — `timeout_s` агента, по умолчанию 120 с.
 *   - Ошибка — ModelClientError с полем `class` (MODEL_ERROR_CLASSES).
 */

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import path from 'node:path';

export const MODEL_ERROR_CLASSES = Object.freeze([
  'no_key',       // переменная из auth.env пуста; файла kilo нет; токен kilo истёк
  'auth',         // HTTP 401, 403
  'rate_limit',   // HTTP 429 после повторов
  'server',       // HTTP 5xx после повторов
  'timeout',      // истёк timeout_s
  'network',      // соединение не установлено (сервер, прокси) после повторов
  'bad_request',  // прочие HTTP 4xx; изображения для decisions; вложение сверх ограничений
  'bad_response', // ответ не JSON; нет обязательных полей протокола
]);

export class ModelClientError extends Error {
  constructor(errorClass, message, extra = {}) {
    super(message);
    this.name = 'ModelClientError';
    this.class = errorClass;
    Object.assign(this, extra);
  }
}

export const DEFAULT_TIMEOUT_S = 120;
export const DEFAULT_RETRY_DELAYS_MS = Object.freeze([2000, 4000]);
export const DEFAULT_IMAGE_LIMITS = Object.freeze({
  maxBytes: 5 * 1024 * 1024,
  maxCount: 8,
});

const RETRY_STATUSES = new Set([429, 500, 502, 503]);
const PROXY_CONNECT_TIMEOUT_MS = 30000;
const PROXY_ENV_NAMES = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
const IMAGE_MIME_BY_EXT = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
});
const BODY_EXCERPT_LIMIT = 300;

// ---------------------------------------------------------------------------
// Ключ
// ---------------------------------------------------------------------------

export function kiloAuthPath(env = process.env) {
  return path.join(env.HOME || env.USERPROFILE || '', '.local', 'share', 'kilo', 'auth.json');
}

export function resolveModelKey(agent, env = process.env, now = Date.now()) {
  const auth = agent.auth || {};
  if (typeof auth.env === 'string') {
    const key = env[auth.env];
    if (!key) {
      throw new ModelClientError('no_key', `Agent "${agent.id || agent.model}": environment variable ${auth.env} is empty`);
    }
    return key;
  }
  if (auth.kilo_oauth === true) {
    const file = kiloAuthPath(env);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (err) {
      throw new ModelClientError('no_key', `kilo auth file is missing or unreadable: ${file} (${err.code || err.message}). Run "kilo auth login"`);
    }
    const kilo = parsed?.kilo;
    if (!kilo?.access) {
      throw new ModelClientError('no_key', `kilo OAuth token not found in ${file}. Run "kilo auth login"`);
    }
    if (kilo.expires && now > kilo.expires) {
      throw new ModelClientError('no_key', 'kilo OAuth token expired. Run "kilo auth login"');
    }
    return kilo.access;
  }
  throw new ModelClientError('no_key', `Agent "${agent.id || agent.model}": auth must be { env: <NAME> } or { kilo_oauth: true }`);
}

// ---------------------------------------------------------------------------
// Изображения
// ---------------------------------------------------------------------------

/** Части `image_url` с data URL. Ограничения проверяются до вызова модели. */
export function buildImageParts(images, { cwd = process.cwd(), limits = DEFAULT_IMAGE_LIMITS } = {}) {
  const maxBytes = limits.maxBytes ?? DEFAULT_IMAGE_LIMITS.maxBytes;
  const maxCount = limits.maxCount ?? DEFAULT_IMAGE_LIMITS.maxCount;
  if (images.length > maxCount) {
    throw new ModelClientError('bad_request', `Too many images: ${images.length} (limit ${maxCount})`);
  }
  return images.map((image) => {
    const file = path.resolve(cwd, image);
    const mime = IMAGE_MIME_BY_EXT[path.extname(file).toLowerCase()];
    if (!mime) {
      throw new ModelClientError('bad_request', `Unsupported image format: ${image} (expected PNG, JPEG or WebP)`);
    }
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      throw new ModelClientError('bad_request', `Image not found: ${image}`);
    }
    if (!stat.isFile()) {
      throw new ModelClientError('bad_request', `Image is not a file: ${image}`);
    }
    if (stat.size > maxBytes) {
      throw new ModelClientError('bad_request', `Image too large: ${image} (${stat.size} bytes, limit ${maxBytes})`);
    }
    const data = fs.readFileSync(file).toString('base64');
    return { type: 'image_url', image_url: { url: `data:${mime};base64,${data}` } };
  });
}

// ---------------------------------------------------------------------------
// Транспорт
// ---------------------------------------------------------------------------

function proxyUrlFrom(env) {
  for (const name of PROXY_ENV_NAMES) {
    if (env[name]) return env[name];
  }
  return null;
}

function scrub(text, secret) {
  const value = String(text ?? '');
  return secret ? value.split(secret).join('***') : value;
}

function excerpt(body, secret) {
  const clean = scrub(body, secret).replace(/\s+/g, ' ').trim();
  return clean.length > BODY_EXCERPT_LIMIT ? `${clean.slice(0, BODY_EXCERPT_LIMIT)}…` : clean;
}

/** Туннель CONNECT через HTTP-прокси; возвращает сокет до `host:port`. */
function openProxyTunnel(proxyUrl, host, port) {
  return new Promise((resolve, reject) => {
    let proxy;
    try {
      proxy = new URL(proxyUrl);
    } catch {
      reject(Object.assign(new Error('invalid proxy URL in environment'), { network: true }));
      return;
    }
    const headers = { Host: `${host}:${port}` };
    if (proxy.username) {
      const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
      headers['Proxy-Authorization'] = `Basic ${Buffer.from(credentials).toString('base64')}`;
    }
    const req = http.request({
      hostname: proxy.hostname,
      port: Number(proxy.port) || 8080,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers,
    });
    req.setTimeout(PROXY_CONNECT_TIMEOUT_MS, () => {
      req.destroy(Object.assign(new Error('proxy connection timeout'), { network: true }));
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(Object.assign(new Error(`proxy CONNECT failed: ${res.statusCode}`), { network: true }));
        return;
      }
      resolve(socket);
    });
    req.on('error', (err) => reject(Object.assign(err, { network: true })));
    req.end();
  });
}

/**
 * Одна попытка POST. Возвращает `{ status, body }`; сетевой сбой — исключение с
 * `network: true`, таймаут — с `timedOut: true`.
 */
async function postOnce(url, headers, payload, { timeoutMs, env }) {
  const target = new URL(url);
  const isHttps = target.protocol === 'https:';
  const port = Number(target.port) || (isHttps ? 443 : 80);
  const proxyUrl = isHttps ? proxyUrlFrom(env) : null;

  let timer;
  let req = null;
  let timedOut = false;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      if (req) req.destroy();
      reject(Object.assign(new Error(`request timed out after ${timeoutMs} ms`), { timedOut: true }));
    }, timeoutMs);
  });

  const attempt = (async () => {
    const socket = proxyUrl ? await openProxyTunnel(proxyUrl, target.hostname, port) : null;
    if (timedOut) {
      socket?.destroy();
      return null;
    }
    return new Promise((resolve, reject) => {
      const options = {
        hostname: target.hostname,
        port,
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(payload) },
      };
      if (socket) {
        options.createConnection = () => tls.connect({ socket, servername: target.hostname });
      }
      req = (isHttps ? https : http).request(options, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf-8') }));
        res.on('error', (err) => reject(Object.assign(err, { network: true })));
      });
      req.on('error', (err) => reject(Object.assign(err, { network: true })));
      req.end(payload);
    });
  })();

  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    clearTimeout(timer);
    attempt.catch(() => {});
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** POST JSON с повторами; возвращает разобранный JSON успешного ответа. */
async function postJson(agent, body, options) {
  const env = options.env || process.env;
  const key = resolveModelKey(agent, env);
  const retryDelays = options.retryDelaysMs || DEFAULT_RETRY_DELAYS_MS;
  const timeoutMs = Math.round((agent.timeout_s || DEFAULT_TIMEOUT_S) * 1000);
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
  const payload = JSON.stringify(body);

  for (let attempt = 0; ; attempt++) {
    const canRetry = attempt < retryDelays.length;
    let response;
    try {
      response = await postOnce(agent.url, headers, payload, { timeoutMs, env });
    } catch (err) {
      if (err.timedOut) {
        throw new ModelClientError('timeout', `Model request timed out after ${timeoutMs / 1000}s`);
      }
      if (canRetry) {
        await sleep(retryDelays[attempt]);
        continue;
      }
      throw new ModelClientError('network', `Model request failed: ${scrub(err.message, key)}`, { attempts: attempt + 1 });
    }

    const { status, body: text } = response;
    if (status >= 200 && status < 300) {
      try {
        return JSON.parse(text);
      } catch {
        throw new ModelClientError('bad_response', `Model response is not JSON: ${excerpt(text, key)}`);
      }
    }
    if (RETRY_STATUSES.has(status) && canRetry) {
      await sleep(retryDelays[attempt]);
      continue;
    }
    const detail = `HTTP ${status}: ${excerpt(text, key)}`;
    const extra = { status, attempts: attempt + 1 };
    if (status === 401 || status === 403) throw new ModelClientError('auth', `Model auth failed, ${detail}`, extra);
    if (status === 429) throw new ModelClientError('rate_limit', `Model rate limit, ${detail}`, extra);
    if (status >= 500) throw new ModelClientError('server', `Model server error, ${detail}`, extra);
    throw new ModelClientError('bad_request', `Model rejected request, ${detail}`, extra);
  }
}

function usageCost(usage) {
  return typeof usage?.cost === 'number' ? usage.cost : null;
}

// ---------------------------------------------------------------------------
// Протоколы
// ---------------------------------------------------------------------------

/**
 * Протокол chat. request: `{ system?, message, images? }`.
 * @returns {Promise<{text: string, citations: {url: string, title: string|null}[], usage: object|null, cost_usd: number|null, model: string, duration_ms: number}>}
 */
export async function chat(agent, request, options = {}) {
  const started = Date.now();
  const images = request.images || [];
  const imageParts = images.length > 0
    ? buildImageParts(images, { cwd: options.cwd, limits: options.imageLimits })
    : [];

  const messages = [];
  if (request.system) messages.push({ role: 'system', content: request.system });
  messages.push({
    role: 'user',
    content: imageParts.length > 0
      ? [{ type: 'text', text: request.message }, ...imageParts]
      : request.message,
  });

  const json = await postJson(agent, { model: agent.model, messages }, options);

  const message = Array.isArray(json?.choices) ? json.choices[0]?.message : undefined;
  if (!message) {
    throw new ModelClientError('bad_response', 'Model response has no choices[0].message');
  }
  let text = message.content;
  if (Array.isArray(text)) {
    text = text.filter((part) => part?.type === 'text').map((part) => part.text).join('');
  }
  if (typeof text !== 'string') {
    throw new ModelClientError('bad_response', 'Model response has no text in choices[0].message.content');
  }

  const citations = [];
  const seen = new Set();
  for (const annotation of Array.isArray(message.annotations) ? message.annotations : []) {
    const url = annotation?.type === 'url_citation' ? annotation.url_citation?.url : null;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    citations.push({ url, title: annotation.url_citation.title || null });
  }

  return {
    text,
    citations,
    usage: json.usage ?? null,
    cost_usd: usageCost(json.usage),
    model: json.model || agent.model,
    duration_ms: Date.now() - started,
  };
}

/**
 * Протокол decisions. request: `{ state, questions, images? }`; `answers` отдаётся
 * как в ответе провайдера, толкование — в слое оценки (model-evaluate.mjs).
 * @returns {Promise<{answers: object, usage: object|null, cost_usd: number|null, model: string, duration_ms: number}>}
 */
export async function decide(agent, request, options = {}) {
  const started = Date.now();
  if (Array.isArray(request.images) && request.images.length > 0) {
    throw new ModelClientError('bad_request', 'Protocol decisions does not accept images');
  }
  const json = await postJson(agent, {
    model: agent.model,
    state: request.state,
    questions: request.questions,
  }, options);

  if (json === null || typeof json.answers !== 'object' || Array.isArray(json.answers) || json.answers === null) {
    throw new ModelClientError('bad_response', 'Model response has no answers object');
  }
  return {
    answers: json.answers,
    usage: json.usage ?? null,
    cost_usd: usageCost(json.usage),
    model: json.model || agent.model,
    duration_ms: Date.now() - started,
  };
}
