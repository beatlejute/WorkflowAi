#!/usr/bin/env node

/**
 * perplexity-research.js — обёртка для вызова Perplexity через kilo proxy без tool use.
 *
 * Проблема: kilo CLI всегда отправляет tool definitions → Perplexity через OpenRouter
 * не поддерживает tool use и возвращает ошибку.
 *
 * Решение: вызываем OpenRouter API через kilo proxy напрямую (без tools),
 * получаем текстовый ответ и выводим в stdout.
 *
 * Использование:
 *   node perplexity-research.js "тема исследования"
 *   node perplexity-research.js --model perplexity/sonar "тема"
 *   node perplexity-research.js --system "Ты исследователь..." "тема"
 *
 * Результат (markdown) выводится в stdout.
 * Прогресс и ошибки — в stderr.
 */

import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';
import { findProjectRoot } from '../../../lib/find-root.mjs';
import { createLogger } from '../../../lib/logger.mjs';

const logger = createLogger();

const AUTH_FILE = path.join(
  process.env.HOME || process.env.USERPROFILE,
  '.local', 'share', 'kilo', 'auth.json'
);

const API_URL = 'https://api.kilo.ai/api/openrouter/chat/completions';
const DEFAULT_MODEL = 'perplexity/sonar-deep-research';

const DEFAULT_SYSTEM_PROMPT = `Ты — опытный исследователь-аналитик. Проводи глубокие исследования по заданным темам.

Принципы:
- Каждый факт подкреплён ссылкой на источник. Нет источника = нет факта.
- Ключевые данные подтверждай минимум 2 независимыми источниками. Если не удалось — помечай [SINGLE SOURCE].
- Помечай уровень уверенности: [HIGH], [MEDIUM], [LOW].
- Всегда указывай дату данных.
- Отделяй факты от прогнозов и мнений.

Формат ответа:
1. Executive Summary (3-5 предложений)
2. Ключевые находки (с уровнями уверенности)
3. Детальный анализ (данные, таблицы, сравнения)
4. Выводы и рекомендации
5. Пробелы и ограничения
6. Источники (полный список с URL)

Язык: русский. Формат: markdown.`;

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = {
    model: DEFAULT_MODEL,
    system: DEFAULT_SYSTEM_PROMPT,
    message: null,
  };

  let i = 0;
  const messageParts = [];

  while (i < args.length) {
    if (args[i] === '--model' && i + 1 < args.length) {
      result.model = args[++i];
    } else if (args[i] === '--system' && i + 1 < args.length) {
      result.system = args[++i];
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Использование: node perplexity-research.js [опции] "тема исследования"

Результат (markdown) выводится в stdout.

Опции:
  --model <id>     Модель Perplexity (по умолчанию: ${DEFAULT_MODEL})
  --system <text>  Системный промпт (по умолчанию: встроенный промпт исследователя)
  -h, --help       Показать справку
`);
      process.exit(0);
    } else {
      messageParts.push(args[i]);
    }
    i++;
  }

  result.message = messageParts.join(' ');
  return result;
}

function loadKiloToken() {
  if (!fs.existsSync(AUTH_FILE)) {
    throw new Error(`Kilo auth file not found: ${AUTH_FILE}\nRun 'kilo auth login' first.`);
  }

  const auth = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'));
  const kiloAuth = auth.kilo;

  if (!kiloAuth || !kiloAuth.access) {
    throw new Error('Kilo OAuth token not found in auth.json. Run "kilo auth login" first.');
  }

  if (kiloAuth.expires && Date.now() > kiloAuth.expires) {
    throw new Error('Kilo OAuth token expired. Run "kilo auth login" to refresh.');
  }

  return kiloAuth.access;
}

function loadEnvFile() {
  const PROJECT_DIR = findProjectRoot();
  const envPath = path.join(PROJECT_DIR, '.workflow', 'config', '.env');
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

function getProxyUrl() {
  return process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy
    || process.env.ALL_PROXY || process.env.all_proxy
    || null;
}

function callPerplexityAPI(token, model, systemPrompt, userMessage) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    });

    const targetUrl = new URL(API_URL);
    const proxyUrl = getProxyUrl();

    const requestHeaders = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'Content-Length': Buffer.byteLength(payload),
    };

    function handleResponse(res) {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`API error ${res.statusCode}: ${data}`));
          return;
        }
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (e) {
          reject(new Error(`Failed to parse API response: ${e.message}\n${data}`));
        }
      });
    }

    let req;

    if (proxyUrl) {
      const proxy = new URL(proxyUrl);
      const proxyAuth = proxy.username && proxy.password
        ? `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`
        : null;

      const connectOptions = {
        hostname: proxy.hostname,
        port: parseInt(proxy.port) || 8080,
        method: 'CONNECT',
        path: `${targetUrl.hostname}:443`,
        headers: {
          'Host': `${targetUrl.hostname}:443`,
        },
      };

      if (proxyAuth) {
        connectOptions.headers['Proxy-Authorization'] =
          'Basic ' + Buffer.from(proxyAuth).toString('base64');
      }

      logger.info(`Using proxy: ${proxy.hostname}:${proxy.port}`);

      const proxyReq = http.request(connectOptions);

      proxyReq.on('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Proxy CONNECT failed: ${res.statusCode}`));
          socket.destroy();
          return;
        }

        const tlsOptions = {
          hostname: targetUrl.hostname,
          path: targetUrl.pathname,
          method: 'POST',
          headers: requestHeaders,
          socket,
          agent: false,
        };

        req = https.request(tlsOptions, handleResponse);
        req.on('error', (e) => reject(new Error(`Request failed: ${e.message}`)));
        req.setTimeout(600000, () => {
          req.destroy();
          reject(new Error('Request timeout (10 minutes)'));
        });
        req.write(payload);
        req.end();
      });

      proxyReq.on('error', (e) => reject(new Error(`Proxy connection failed: ${e.message}`)));
      proxyReq.setTimeout(30000, () => {
        proxyReq.destroy();
        reject(new Error('Proxy connection timeout'));
      });
      proxyReq.end();

    } else {
      const options = {
        hostname: targetUrl.hostname,
        port: 443,
        path: targetUrl.pathname,
        method: 'POST',
        headers: requestHeaders,
      };

      req = https.request(options, handleResponse);
      req.on('error', (e) => reject(new Error(`Request failed: ${e.message}`)));
      req.setTimeout(600000, () => {
        req.destroy();
        reject(new Error('Request timeout (10 minutes)'));
      });
      req.write(payload);
      req.end();
    }
  });
}

function formatOutput(apiResponse, model, userMessage) {
  const choice = apiResponse.choices?.[0];
  if (!choice) throw new Error('No response from API');

  const content = choice.message?.content || '';
  const annotations = choice.message?.annotations || [];

  let output = content;

  if (annotations.length > 0) {
    const urlCitations = annotations.filter(a => a.type === 'url_citation' && a.url_citation?.url);
    const uniqueUrls = [...new Set(urlCitations.map(a => a.url_citation.url))];

    if (uniqueUrls.length > 0) {
      output += '\n\n---\n\n## Источники (автоматические цитаты)\n\n';
      uniqueUrls.forEach((url, i) => {
        const citation = urlCitations.find(a => a.url_citation.url === url);
        const title = citation.url_citation.title || url;
        output += `${i + 1}. [${title}](${url})\n`;
      });
    }
  }

  return output;
}

async function main() {
  loadEnvFile();
  const args = parseArgs(process.argv);

  if (!args.message) {
    console.error('Ошибка: не указана тема исследования');
    console.error('Использование: node perplexity-research.js "тема исследования"');
    process.exit(1);
  }

  logger.info(`Research query: ${args.message}`);
  logger.info(`Model: ${args.model}`);

  const token = loadKiloToken();

  console.error(`Запуск исследования через ${args.model}...`);
  console.error(`Ожидание ответа (deep research может занять до 5-10 минут)...`);

  const response = await callPerplexityAPI(token, args.model, args.system, args.message);
  const output = formatOutput(response, args.model, args.message);
  const usage = response.usage || {};

  // Результат — в stdout
  console.log(output);

  // Метаданные — в stderr
  console.error(`Готово. Токены: ${usage.total_tokens || 'N/A'}, стоимость: $${usage.cost || 'N/A'}`);
}

main().catch((err) => {
  console.error(`Ошибка: ${err.message}`);
  process.exit(1);
});
