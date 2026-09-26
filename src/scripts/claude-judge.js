#!/usr/bin/env node

/**
 * Судья на модели Claude без инструментов — обычный CLI-агент с изображениями.
 *
 * Получает промпт CLI-судьи (src/lib/skill-judge.mjs, buildCliJudgePrompt) — тот же,
 * что у любого судьи и у стадии с `model_io` для агента с командой. Если в секции
 * `## Target Agent Output` есть строка `Изображения:` с путями (так их дописывает
 * раннер, _askCommandAgent), файлы уходят модели блоками изображений base64, а не
 * путями: модели не нужен доступ к файлам проекта.
 *
 *   node claude-judge.js --model <id> [--command <исполняемый файл claude>] [--arg <аргумент>]…
 *     [--timeout <с>]   промпт — из stdin (агент с `prompt_stdin: true`) или последним аргументом
 *
 * Изоляция модели (проверено запуском claude 2026-09-26):
 *  - `--tools ""` и `--strict-mcp-config` — у модели нет ни одного инструмента
 *    (init отдаёт `tools: []`);
 *  - `--setting-sources project` в пустом временном каталоге — без пользовательских
 *    настроек и хуков;
 *  - каждый `@` текста заменяется на `＠` (U+FF20): Claude Code прикладывает к запросу
 *    файл, упомянутый как `@путь`, и в текстовом промпте, и в блоке stream-json —
 *    строка `@файл` из диффа или пункта DoD отдала бы модели файл, которого нет в
 *    evidence. `＠путь` файл не прикладывает.
 * Изображения — только внутри рабочего каталога агента (корень проекта), PNG, JPEG
 * или WebP, ограничения и проверки — buildImageParts (src/lib/model-client.mjs).
 *
 * Ответ:
 *   ---RESULT---
 *   score: <1-5>
 *   reason: <строка>
 *   model: <модель из init>
 *   cost_usd: <цена или null>
 *   images: <число приложенных изображений>
 *   ---RESULT---
 * Ошибка — `status: error`, `error_class`, `error` и код выхода 1:
 *   usage — аргументы; bad_prompt — промпт не по формату судьи; bad_request —
 *   изображение вне каталога, не того формата, нет файла, сверх ограничений;
 *   unparsed — в ответе модели нет балла 1..5; timeout; agent_error — claude
 *   завершился с ошибкой или ответ не разобран.
 */

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildImageParts, ModelClientError } from '../lib/model-client.mjs';
import { parseJudgeScore } from '../lib/skill-judge.mjs';

const DEFAULT_TIMEOUT_S = 180;
// Секции промпта CLI-судьи — как в decisions-judge.js: данные до ПОСЛЕДНЕГО `## Task`
// перед постоянным хвостом промпта.
const PROMPT_SECTIONS = /## Rubric\s*\n[\s\S]*?\n## Target Agent Output\s*\n([\s\S]*)\n## Task\s*\n[\s\S]*?\n\s*Please evaluate the output/;
const IMAGES_HEADER = 'Изображения:';
const NEUTRAL_AT = '＠';

class JudgeError extends Error {
  constructor(errorClass, message) {
    super(message);
    this.class = errorClass;
  }
}

function parseArgs(argv) {
  const opts = { command: 'claude', prefix: [], timeout: DEFAULT_TIMEOUT_S };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const take = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new JudgeError('usage', `${arg} needs a value`);
      i++;
      return value;
    };
    if (arg === '--model') opts.model = take();
    else if (arg === '--command') opts.command = take();
    else if (arg === '--arg') opts.prefix.push(take());
    else if (arg === '--timeout') opts.timeout = Number(take());
    else rest.push(arg);
  }
  if (!opts.model) throw new JudgeError('usage', '--model is required');
  if (!(Number.isFinite(opts.timeout) && opts.timeout > 0)) {
    throw new JudgeError('usage', '--timeout must be a number > 0');
  }
  opts.prompt = rest.length > 0 ? rest[rest.length - 1] : null;
  return opts;
}

/**
 * Пути изображений промпта: строки после последнего `Изображения:` в секции
 * `## Target Agent Output` — раннер дописывает их в конец данных.
 */
function promptImages(prompt) {
  const match = String(prompt ?? '').replace(/\r\n/g, '\n').match(PROMPT_SECTIONS);
  if (!match) {
    throw new JudgeError('bad_prompt', 'prompt has no "## Rubric", "## Target Agent Output", "## Task" sections of the judge prompt');
  }
  const lines = match[1].split('\n');
  const header = lines.lastIndexOf(IMAGES_HEADER);
  if (header === -1) return [];
  return lines.slice(header + 1).map((line) => line.trim()).filter(Boolean);
}

/** Блоки изображений Claude из файлов внутри `root`. */
function imageBlocks(images, root) {
  const realRoot = fs.realpathSync(root);
  for (const image of images) {
    const file = path.resolve(root, image);
    let real;
    try {
      real = fs.realpathSync(file);
    } catch {
      continue; // нет файла — ошибку с именем даст buildImageParts
    }
    const rel = path.relative(realRoot, real);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new JudgeError('bad_request', `Image outside the agent directory: ${image}`);
    }
  }
  let parts;
  try {
    parts = buildImageParts(images, { cwd: root });
  } catch (err) {
    if (err instanceof ModelClientError) throw new JudgeError(err.class, err.message);
    throw err;
  }
  return parts.map((part) => {
    const [, mediaType, data] = part.image_url.url.match(/^data:([^;]+);base64,(.*)$/s);
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
  });
}

/** Сообщение stream-json: изображения, затем текст промпта с обезвреженными `@`. */
function buildMessage(prompt, blocks) {
  const text = String(prompt).split('@').join(NEUTRAL_AT);
  return { type: 'user', message: { role: 'user', content: [...blocks, { type: 'text', text }] } };
}

function claudeArgs(opts) {
  return [
    ...opts.prefix,
    '--model', opts.model,
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--tools', '',
    '--strict-mcp-config',
    '--setting-sources', 'project',
  ];
}

// Windows: claude — это claude.cmd, его запускает только оболочка. Команда
// собирается одной строкой: пустой аргумент `--tools ""` и пути с пробелами —
// в кавычках.
function quoteForCmd(arg) {
  return arg === '' || /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

function runClaude(opts, message) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-judge-'));
  const args = claudeArgs(opts);
  const win = process.platform === 'win32';
  const child = win
    ? spawn([opts.command, ...args].map(quoteForCmd).join(' '), { cwd, shell: true, windowsHide: true })
    : spawn(opts.command, args, { cwd });
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (win && child.pid) {
        try { execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* уже вышел */ }
      } else {
        child.kill('SIGKILL');
      }
    }, opts.timeout * 1000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.on('error', () => {});
    child.on('error', (err) => {
      clearTimeout(timer);
      fs.rmSync(cwd, { recursive: true, force: true });
      reject(new JudgeError('agent_error', `cannot start ${opts.command}: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      if (timedOut) {
        reject(new JudgeError('timeout', `${opts.command} did not answer in ${opts.timeout}s`));
        return;
      }
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(`${JSON.stringify(message)}\n`);
  });
}

/** Итог stream-json: { text, model, cost, isError }. */
function parseStream(stdout) {
  let model = null;
  let result = null;
  for (const line of String(stdout).split('\n')) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'system' && event.subtype === 'init' && event.model) model = event.model;
    if (event.type === 'result') result = event;
  }
  if (!result) return null;
  return {
    text: typeof result.result === 'string' ? result.result : '',
    model,
    cost: typeof result.total_cost_usd === 'number' ? result.total_cost_usd : null,
    isError: result.is_error === true,
  };
}

function oneLine(text) {
  return String(text).replace(/\s+/g, ' ').trim().slice(0, 500);
}

async function judge(opts, prompt) {
  const images = promptImages(prompt);
  const blocks = imageBlocks(images, process.cwd());
  const run = await runClaude(opts, buildMessage(prompt, blocks));
  const answer = parseStream(run.stdout);
  if (!answer || answer.isError || run.code !== 0) {
    const detail = answer?.text || run.stderr || `exit ${run.code}`;
    throw new JudgeError('agent_error', `${opts.command}: ${oneLine(detail)}`);
  }
  const score = parseJudgeScore(answer.text);
  if (score === null) {
    throw new JudgeError('unparsed', `model answer has no score 1..5: ${oneLine(answer.text)}`);
  }
  const reason = answer.text.match(/reason:\s*(.+)/i);
  return {
    score,
    reason: oneLine(reason ? reason[1] : answer.text),
    model: answer.model ?? opts.model,
    cost_usd: answer.cost ?? 'null',
    images: blocks.length,
  };
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf-8');
  } catch {
    return '';
  }
}

function printResult(fields) {
  const lines = ['---RESULT---'];
  for (const [key, value] of Object.entries(fields)) lines.push(`${key}: ${value}`);
  lines.push('---RESULT---');
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function main() {
  try {
    const opts = parseArgs(process.argv.slice(2));
    printResult(await judge(opts, opts.prompt ?? readStdin()));
    return 0;
  } catch (err) {
    printResult({
      status: 'error',
      error_class: err instanceof JudgeError ? err.class : 'agent_error',
      error: oneLine(err.message),
    });
    return 1;
  }
}

// Без проверки «запущен ли модуль напрямую»: через junction .workflow/src/scripts путь
// argv[1] и import.meta.url различаются, и main не запустился бы (как decisions-judge.js).
main().then((code) => process.exit(code));
