#!/usr/bin/env node

/**
 * Судья на kilo-модели с инструментами — пункты DoD со скриншотами в стадии ревью.
 * Аналог claude-judge.js для моделей, у которых kilo-агент читает изображения сам:
 * картинки не конвертируются в base64-блоки — из промпта CLI-судьи берутся пути
 * после строки «Изображения:» (раннер, _askCommandAgent), проверяются (внутри
 * корня проекта, PNG/JPEG/WebP), копируются в пустой временный каталог, и kilo
 * запускается там: модель видит только evidence — копии изображений и текст
 * вопроса, ни тикета, ни Result, ни репозитория. '@' текста заменяется на '＠':
 * kilo прикладывает файл по упоминанию '@путь' — строка '@файл' из диффа или
 * пункта DoD отдала бы файл, которого нет в evidence; во временном каталоге его
 * нет и по другой причине.
 *
 *   node kilo-judge.js --model <kilo-модель> [--agent code] [--timeout <с>]
 *     [--kilo <путь к bin/kilo>]   промпт — из stdin (агент с prompt_stdin: true)
 *     или последним аргументом
 *
 * kilo вызывается напрямую нодой: путь к bin/@kilocode/cli/bin/kilo ищется по
 * PATH — рядом с килo-лаунчером (kilo.cmd/kilo.ps1/kilo) лежит каталог
 * node_modules с пакетом; это то же правило, по которому работают его
 * собственные лаунчеры. Перекрывается переменной KILO_BIN. Нода — соседняя с
 * лаунчером (node.exe в том же каталоге npm-global), иначе process.execPath.
 *
 * Ответ — блок ---RESULT--- как у claude-judge.js:
 *   score/reason/model/cost_usd/images; ошибка — status: error, error_class,
 *   error и код выхода 1: usage, bad_prompt, bad_request, unparsed, timeout,
 *   agent_error. Балл ищется по ПОСЛЕДНЕМУ вхождению «score» в выводе: kilo с
 *   --print-logs может эхом повторить текст промпта, где слово тоже встречается.
 *   Транскрипт kilo идёт в stderr, ответ бывает и строкой «score: 5», и JSON —
 *   парсер читает оба потока и обе формы.
 */

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_TIMEOUT_S = 240;
const PROMPT_SECTIONS = /## Rubric\s*\n[\s\S]*?\n## Target Agent Output\s*\n([\s\S]*)\n## Task\s*\n[\s\S]*?\n\s*Please evaluate the output/;
// Строка перед путями: `Изображения:`, у вопроса по частям — с пометкой части
// `Изображения (часть 1 из 2: …):` (раннер, _askCommandAgent). `Images:` — для
// локальных проверок обёртки вне канона.
const IMAGES_HEADER = /^(?:Изображения|Images)(?: \(.*\))?:$/;
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

class JudgeError extends Error {
  constructor(errorClass, message) {
    super(message);
    this.class = errorClass;
  }
}

function parseArgs(argv) {
  const opts = { agent: 'code', timeout: DEFAULT_TIMEOUT_S };
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
    else if (arg === '--agent') opts.agent = take();
    else if (arg === '--timeout') opts.timeout = Number(take());
    else if (arg === '--kilo') opts.kilo = take();
    else rest.push(arg);
  }
  if (!opts.model) throw new JudgeError('usage', '--model is required');
  if (!(Number.isFinite(opts.timeout) && opts.timeout > 0)) {
    throw new JudgeError('usage', '--timeout must be a number > 0');
  }
  opts.prompt = rest.length > 0 ? rest[rest.length - 1] : null;
  return opts;
}

function promptImages(prompt) {
  const match = String(prompt ?? '').replace(/\r\n/g, '\n').match(PROMPT_SECTIONS);
  if (!match) {
    throw new JudgeError('bad_prompt', 'prompt has no "## Rubric", "## Target Agent Output", "## Task" sections of the judge prompt');
  }
  const lines = match[1].split('\n');
  const header = lines.findLastIndex((line) => IMAGES_HEADER.test(line));
  if (header === -1) return [];
  return lines.slice(header + 1).map((line) => line.trim()).filter(Boolean);
}

/**
 * Пути изображений промпта: существуют, внутри корня проекта, PNG/JPEG/WebP.
 * Возвращает пары «упоминание в промпте → файл», дубликаты схлопнуты.
 */
function checkedImages(images, root) {
  const realRoot = fs.realpathSync(root);
  const out = new Map();
  for (const image of images) {
    if (out.has(image)) continue;
    const file = path.resolve(root, image);
    let real;
    try {
      real = fs.realpathSync(file);
    } catch {
      throw new JudgeError('bad_request', `Image file not found: ${image}`);
    }
    const rel = path.relative(realRoot, real);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new JudgeError('bad_request', `Image outside the agent directory: ${image}`);
    }
    if (!IMAGE_EXT.test(real)) {
      throw new JudgeError('bad_request', `Image is not PNG/JPEG/WebP: ${image}`);
    }
    out.set(image, real);
  }
  return out;
}

/**
 * Копии изображений во временном каталоге: упоминание в промпте → имя копии.
 * Имя копии — базовое имя файла; при коллизии вперёд добавляется индекс.
 */
function copyImages(resolved, tempDir) {
  const used = new Map();
  const copies = [];
  for (const [mention, real] of resolved) {
    let name = path.basename(real);
    if (used.has(name)) name = `${used.size}-${name}`;
    used.set(name, true);
    fs.copyFileSync(real, path.join(tempDir, name));
    copies.push([mention, name]);
  }
  return copies;
}

/** Промпт для kilo: оригинал с обезвреженными '@', пути картинок — на копии. */
function buildKiloPrompt(prompt, copies) {
  let text = String(prompt).split('@').join('＠');
  if (!copies.length) return text;
  // Длинные пути первыми: упоминание бывает подстрокой другого («1.png» в «21.png»).
  const ordered = [...copies].sort((a, b) => b[0].length - a[0].length);
  for (const [mention, name] of ordered) {
    text = text.split(mention).join(name);
  }
  const list = copies.map(([, name]) => `- ${name}`).join('\n');
  return `${text}\n\n## Изображения для оценки\nОткрой каждый файл ниже инструментом чтения файлов (это изображения) и оцени содержимое каждого при вынесении вердикта:\n${list}`;
}

/**
 * Путь к bin/@kilocode/cli/bin/kilo: рядом с лаунчером kilo.cmd/kilo.ps1/kilo из
 * PATH лежит каталог node_modules пакета (правило самих лаунчеров kilo). Перекрывается
 * --kilo и KILO_BIN. Нода — соседняя с лаунчером (npm-global), иначе process.execPath.
 */
function resolveKilo(env = process.env) {
  const override = env.KILO_BIN;
  if (override) return { node: process.execPath, bin: override };
  const dirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of ['kilo.cmd', 'kilo.ps1', 'kilo']) {
      if (!fs.existsSync(path.join(dir, name))) continue;
      const bin = path.join(dir, 'node_modules', '@kilocode', 'cli', 'bin', 'kilo');
      if (!fs.existsSync(bin)) continue;
      const node = fs.existsSync(path.join(dir, 'node.exe')) ? path.join(dir, 'node.exe') : process.execPath;
      return { node, bin };
    }
  }
  throw new JudgeError('agent_error', 'kilo not found on PATH (no launcher with node_modules/@kilocode/cli/bin/kilo nearby); set KILO_BIN');
}

function runKilo(opts, cwd, prompt) {
  const { node, bin } = resolveKilo(process.env);
  const args = [
    bin,
    '-m', opts.model,
    '--agent', opts.agent,
    '--print-logs', '--log-level', 'ERROR',
    'run', '--auto',
  ];
  const child = spawn(node, args, { cwd, windowsHide: true });
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid && process.platform === 'win32') {
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
      reject(new JudgeError('agent_error', `cannot start kilo: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new JudgeError('timeout', `kilo did not answer in ${opts.timeout}s`));
        return;
      }
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(prompt);
  });
}

function oneLine(text) {
  return String(text).replace(/\s+/g, ' ').trim().slice(0, 500);
}

function lastMatch(text, re) {
  const matches = [...String(text ?? '').matchAll(re)];
  return matches.length ? matches[matches.length - 1] : null;
}

async function judge(opts, prompt) {
  const resolved = checkedImages(promptImages(prompt), process.cwd());
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-judge-'));
  try {
    const copies = copyImages(resolved, tempDir);
    const run = await runKilo(opts, tempDir, buildKiloPrompt(prompt, copies));
    // kilo печатает весь транскрипт (включая ответ) в stderr, stdout пустой —
    // ищем по обоим потокам; ответ модели бывает и строкой «score: 5», и JSON.
    const combined = `${run.stdout}\n${run.stderr}`;
    const scoreMatch = lastMatch(combined, /"?score"?\s*[:=]\s*(\d+)/gi);
    const score = scoreMatch ? Number.parseInt(scoreMatch[1], 10) : null;
    if (score === null || score < 1 || score > 5) {
      const detail = `exit ${run.code} stderr=[${oneLine(run.stderr)}] stdout=[${oneLine(run.stdout.slice(-400))}]`;
      throw new JudgeError('unparsed', `kilo answer has no score 1..5: ${detail}`);
    }
    const reasonMatch = lastMatch(combined, /"?reason"?\s*[:=]\s*(?:"([^"]+)"|(.+))/gi);
    const reason = reasonMatch ? (reasonMatch[1] ?? reasonMatch[2]) : combined;
    return {
      score,
      reason: oneLine(String(reason).split('\x1b')[0]),
      model: opts.model,
      cost_usd: 'null',
      images: copies.length,
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
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
// argv[1] и import.meta.url различаются, и main не запустился бы (как claude-judge.js).
main().then((code) => process.exit(code));
