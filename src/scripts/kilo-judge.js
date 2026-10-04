#!/usr/bin/env node

/**
 * Судья на kilo-модели с инструментами — пункты DoD со скриншотами в стадии ревью.
 * Аналог claude-judge.js для моделей, у которых kilo-агент читает изображения сам:
 * картинки не конвертируются в base64-блоки — из промпта CLI-судьи берутся пути
 * после строки «Изображения:» (раннер, _askCommandAgent), проверяются (внутри
 * корня проекта, PNG/JPEG/WebP), копируются в пустой временный каталог, и kilo
 * запускается там. Изоляция неполная: инструменты агента кодом не ограничены
 * временным каталогом — чтение абсолютных путей технически возможно, модель
 * удерживается в evidence инструкцией, а не песочницей. '@' текста заменяется
 * на '＠': kilo прикладывает файл по упоминанию '@путь' — строка '@файл' из диффа
 * или пункта DoD отдала бы файл, которого нет в evidence.
 *
 *   node kilo-judge.js --model <kilo-модель> [--agent code] [--timeout <с>]
 *     [--kilo <путь к bin/kilo>]   промпт — из stdin (агент с prompt_stdin: true)
 *     или последним аргументом
 *
 * kilo вызывается напрямую нодой: путь к bin/@kilocode/cli/bin/kilo ищется по
 * PATH — рядом с килo-лаунчером (kilo.cmd/kilo.ps1/kilo) лежит каталог
 * node_modules с пакетом; это то же правило, по которому работают его
 * собственные лаунчеры. Перекрывается --kilo и переменной KILO_BIN. Нода —
 * соседняя с лаунчером (node.exe в том же каталоге npm-global), иначе
 * process.execPath.
 *
 * Вердикт. Ненулевой код выхода kilo — отказ (agent_error), что бы ни было
 * напечатано. Успешный ответ модели обязан закончиться строкой
 * `VERDICT: <число 1-5> / <маркер>` (требование с одноразовым маркером запуска
 * дописывается в конец промпта); балл берётся из последней такой строки обоих
 * потоков вывода. Эхо промпта, логи, примеры «score:» и чужие вердикты в
 * транскрипте не совпадают со свежим маркером. Ограничение: источник строки не
 * доказывается — модель способна напечатать маркер и в промежуточном сообщении
 * или вызове инструмента; от умышленной подделки парсинг вывода не защищает
 * (случайное совпадение 48-битного маркера крайне маловероятно). Нет строки —
 * unparsed.
 *
 * Ответ — блок ---RESULT--- как у claude-judge.js:
 *   score/reason/model/cost_usd/images; ошибка — status: error, error_class,
 *   error и код выхода 1: usage, bad_prompt, bad_request, unparsed, timeout,
 *   agent_error.
 */

import { spawn, execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_TIMEOUT_S = 240;
const PROMPT_SECTIONS = /## Rubric\s*\n[\s\S]*?\n## Target Agent Output\s*\n([\s\S]*)\n## Task\s*\n[\s\S]*?\n\s*Please evaluate the output/;
// Строка перед путями: `Изображения:`, у вопроса по частям — с пометкой части
// `Изображения (часть 1 из 2: …):` (раннер, _askCommandAgent). `Images:` — для
// локальных проверок обёртки вне канона.
const IMAGES_HEADER = /^(?:Изображения|Images)(?: \(.*\))?:$/;
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
const ANSI = /\x1b\[[0-9;]*m/g;

// Одноразовый маркер вердикта: генерируется на каждый запуск, в evidence его нет —
// строка «VERDICT: <балл> / <маркер>» в выводе может быть только ответом модели.
function verdictToken() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

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

/** Пути изображений: существуют, внутри корня проекта, PNG/JPEG/WebP. */
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
 * Имя копии — базовое имя файла; коллизия (в том числе с уже префиксованным
 * именем) разрешается первым свободным префиксом — перезаписи копий нет.
 */
function copyImages(resolved, tempDir) {
  const used = new Set();
  const copies = [];
  for (const [mention, real] of resolved) {
    let name = path.basename(real);
    for (let i = 1; used.has(name); i++) name = `${i}-${name}`;
    used.add(name);
    fs.copyFileSync(real, path.join(tempDir, name));
    copies.push([mention, name]);
  }
  return copies;
}

/** Промпт для kilo: оригинал с обезвреженными '@', пути картинок — на копии. */
function buildKiloPrompt(prompt, copies, token) {
  let text = String(prompt).split('@').join('＠');
  if (copies.length) {
    // Длинные пути первыми: упоминание бывает подстрокой другого («1.png» в «21.png»).
    const ordered = [...copies].sort((a, b) => b[0].length - a[0].length);
    for (const [mention, name] of ordered) {
      text = text.split(mention).join(name);
    }
    const list = copies.map(([, name]) => `- ${name}`).join('\n');
    text = `${text}\n\n## Изображения для оценки\nОткрой каждый файл ниже инструментом чтения файлов (это изображения) и оцени содержимое каждого при вынесении вердикта:\n${list}`;
  }
  return `${text}\n\nЗакончи ответ строкой ровно вида: VERDICT: <итоговый балл от 1 до 5> / ${token}`;
}

/**
 * Путь к bin/@kilocode/cli/bin/kilo: рядом с лаунчером kilo.cmd/kilo.ps1/kilo из
 * PATH лежит каталог node_modules пакета (правило самих лаунчеров kilo). Перекрывается
 * --kilo и KILO_BIN. Нода — соседняя с лаунчером (npm-global), иначе process.execPath.
 */
function resolveKilo(env = process.env, override = undefined) {
  if (override) return { node: process.execPath, bin: override };
  if (env.KILO_BIN) return { node: process.execPath, bin: env.KILO_BIN };
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
  const { node, bin } = resolveKilo(process.env, opts.kilo);
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

/** Строка «VERDICT: <1-5> / <маркер>» именно этого запуска (без ANSI); нет — null. */
function extractVerdict(combined, token) {
  const clean = String(combined ?? '').replace(ANSI, '');
  const re = new RegExp(`^[ \\t]*VERDICT:[ \\t]*([1-5])[ \\t]*/[ \\t]*${token}[ \\t]*$`, 'gim');
  const matches = [...clean.matchAll(re)];
  return matches.length ? Number.parseInt(matches[matches.length - 1][1], 10) : null;
}

async function judge(opts, prompt, run = runKilo) {
  const images = checkedImages(promptImages(prompt), process.cwd());
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-judge-'));
  try {
    const token = verdictToken();
    const copies = copyImages(images, tempDir);
    const result = await run(opts, tempDir, buildKiloPrompt(prompt, copies, token));
    if (result.code !== 0) {
      const detail = result.stderr || result.stdout || `exit ${result.code}`;
      throw new JudgeError('agent_error', `kilo exited ${result.code}: ${oneLine(detail)}`);
    }
    const combined = `${result.stdout}\n${result.stderr}`;
    const score = extractVerdict(combined, token);
    if (score === null) {
      const tail = oneLine(combined.replace(ANSI, '').slice(-400));
      throw new JudgeError('unparsed', `kilo answer has no "VERDICT: <1-5> / ${token}" line: ${tail}`);
    }
    return {
      score,
      reason: oneLine(combined.replace(ANSI, '').slice(-300)),
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

// main() — только для запуска как скрипта: импорт из тестов не должен выполнять
// судью. Сравниваются realpath: через junction .workflow/src/scripts argv[1] и
// import.meta.url текстово различаются, но указывают на один файл.
const thisFile = fs.realpathSync(fileURLToPath(import.meta.url));
const launchedFile = process.argv[1] ? fs.realpathSync(path.resolve(process.argv[1])) : null;
if (launchedFile === thisFile) {
  main().then((code) => process.exit(code));
}

export { judge, extractVerdict, checkedImages, copyImages, buildKiloPrompt, resolveKilo };
