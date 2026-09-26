/**
 * Исполнитель проверок пунктов DoD и разбор их записи в тикете (PLAN-002,
 * «Формат записи проверки», «Ограничения исполнителя проверок»).
 *
 * Проверка — вложенная строка под пунктом DoD тикета с `dod_format: 2`:
 *   - [ ] Текст критерия
 *     - check: `<команда>`, expect: `<ожидание>`[, regression: `true`]
 *     - prose: `<почему командой не проверить>`
 *     - visual: `<путь или маска изображений от корня проекта>`
 *
 * Ограничения исполнителя:
 *   - исполняемые файлы — только node, npm (test и run <скрипт>), git (status,
 *     diff, log, show, ls-files, rev-parse, grep), pytest, python, dotnet, rg, grep;
 *   - операторы оболочки вне кавычек (`;`, `&`, `|`, `<`, `>`) и подстановки
 *     (`` ` ``, `$(`) вне одинарных кавычек — отказ; команда разбирается в argv
 *     и запускается без оболочки;
 *   - рабочий каталог — корень проекта, таймаут — 120 с, stdout и stderr в
 *     результате — по 4000 символов, в памяти — не больше CHECK_CAPTURE_LIMIT
 *     байт каждого потока.
 * Нарушение даёт `denied`, процесс не запускается. Хуки Claude Code команды
 * исполнителя не видят: их запускает скрипт пайплайна через spawn, а не
 * инструмент Claude Code, — защита только в этом модуле.
 *
 * Модуль без побочных эффектов при импорте. Скрипты пакета импортируют его
 * относительным путём (`../lib/check-runner.mjs`), скрипты скилов — как
 * `workflow-ai/lib/check-runner.mjs` (`exports` package.json).
 */

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const CHECK_TIMEOUT_MS = 120_000;
export const CHECK_OUTPUT_LIMIT = 4000;
// Сколько байт каждого потока держится целиком для сверки ожидания. Без предела
// вывод длиннее предельной строки V8 (0x1fffffe8 символов) ронял вызывающий
// процесс: ERR_STRING_TOO_LONG из обработчика close шёл мимо промиса runCheck
// (проверено запуском на 600 МБ stdout).
export const CHECK_CAPTURE_LIMIT = 16 * 1024 * 1024;
// Сверх предела поток держит только хвост для evidence: символ UTF-16 занимает в
// UTF-8 не больше 3 байт, запас — на символ, разрезанный в начале хвоста.
const TAIL_BYTES = CHECK_OUTPUT_LIMIT * 4;

const ALLOWED_EXECUTABLES = new Set(['node', 'npm', 'git', 'pytest', 'python', 'dotnet', 'rg', 'grep']);
const GIT_SUBCOMMANDS = new Set(['status', 'diff', 'log', 'show', 'ls-files', 'rev-parse', 'grep']);

// Двухсимвольные операторы — первыми, чтобы причина называла `&&`, а не `&`.
const SHELL_OPERATORS = ['&&', '||', '$(', ';', '&', '|', '<', '>', '`'];
// Внутри двойных кавычек оболочка подставляет только их; `|` или `>` там —
// часть аргумента (регэксп rg, выражение node -e).
const SHELL_SUBSTITUTIONS = ['$(', '`'];

/**
 * Разбор команды в argv по правилам POSIX-оболочки без подстановок: слова через
 * пробелы, '…' — буквально, "…" — с экранированием `\"` и `\\`. Обратная косая
 * вне кавычек — обычный символ (пути Windows).
 *
 * @returns {{argv: string[]} | {error: string}}
 */
function splitCommand(command) {
  const argv = [];
  let token = null;
  let quote = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (quote === "'") {
      if (ch === "'") quote = null;
      else token += ch;
      continue;
    }

    if (quote === '"') {
      if (ch === '"') {
        quote = null;
        continue;
      }
      if (ch === '\\' && (command[i + 1] === '"' || command[i + 1] === '\\')) {
        token += command[++i];
        continue;
      }
      const substitution = SHELL_SUBSTITUTIONS.find(op => command.startsWith(op, i));
      if (substitution) return { error: `shell_operator: ${substitution}` };
      token += ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (token !== null) argv.push(token);
      token = null;
      continue;
    }
    const operator = SHELL_OPERATORS.find(op => command.startsWith(op, i));
    if (operator) return { error: `shell_operator: ${operator}` };
    if (ch === '"' || ch === "'") {
      quote = ch;
      token ??= '';
      continue;
    }
    token = (token ?? '') + ch;
  }

  if (quote) return { error: 'unbalanced_quotes' };
  if (token !== null) argv.push(token);
  return { argv };
}

// npm: только `test` и `run <скрипт>`; дальше — лишь аргументы скрипту после
// `--`. Собственные опции npm отсекаются целиком: `--script-shell=<файл>`
// запустил бы скрипт любым исполняемым файлом.
function npmViolation(args) {
  const [subcommand, ...rest] = args;
  let tail;
  if (subcommand === 'test') {
    tail = rest;
  } else if (subcommand === 'run') {
    if (!rest[0] || rest[0].startsWith('-')) return 'npm_run_without_script';
    tail = rest.slice(1);
  } else {
    return `npm_subcommand_not_allowed: ${subcommand ?? ''}`;
  }
  if (tail.length > 0 && tail[0] !== '--') return `option_not_allowed: npm ${tail[0]}`;
  return null;
}

// git: подкоманда — первым аргументом, поэтому глобальные опции (`-c`, `-C`)
// не проходят. `-O`/`--open-files-in-pager` у `git grep` запускает указанную
// программу через оболочку — это другой исполняемый файл. git принимает и
// однозначное начало длинной опции (`--open=`, `--op=`), и цифры перед `O` в
// связке коротких (`-3O`) — проверено запуском на git 2.52.
const GIT_PAGER_OPTION = '--open-files-in-pager';

function gitViolation(args) {
  const [subcommand, ...rest] = args;
  if (!GIT_SUBCOMMANDS.has(subcommand)) return `git_subcommand_not_allowed: ${subcommand ?? ''}`;
  const pager = rest.find(arg => {
    const name = arg.split('=')[0];
    return /^-[^-]*O/.test(arg) || (name.length >= 3 && GIT_PAGER_OPTION.startsWith(name));
  });
  return pager ? `option_not_allowed: git ${pager}` : null;
}

// rg: `--pre <программа>` прогоняет каждый файл через указанную программу,
// `--hostname-bin <программа>` запускает её за именем хоста для гиперссылок.
// Начало длинной опции rg 14.1.1 не принимает (проверено запуском).
const RG_PROGRAM_OPTIONS = ['--pre', '--hostname-bin'];

function commandViolation(argv) {
  const [executable, ...args] = argv;
  if (!executable) return 'empty_command';
  if (!ALLOWED_EXECUTABLES.has(executable)) return `executable_not_allowed: ${executable}`;
  if (executable === 'npm') return npmViolation(args);
  if (executable === 'git') return gitViolation(args);
  if (executable === 'rg') {
    const program = args.find(arg => RG_PROGRAM_OPTIONS.some(name => arg === name || arg.startsWith(`${name}=`)));
    if (program) return `option_not_allowed: rg ${program}`;
  }
  return null;
}

/**
 * Виды `expect`: `exit <N>`, `stdout contains <текст>`, `stdout not contains <текст>`,
 * `stdout matches /<регэксп>/`. Для видов stdout код возврата не сравнивается —
 * он остаётся в результате.
 *
 * @returns {{test: (run: {exitCode: number|null, stdout: string}) => string|null,
 *   readsStdout?: boolean} | {error: string}}
 *   test возвращает причину провала или null
 */
function parseExpect(expect) {
  const text = String(expect ?? '').trim();
  let match;

  if ((match = /^exit\s+(\d+)$/.exec(text))) {
    const code = Number(match[1]);
    return { test: run => (run.exitCode === code ? null : `exit_code: expected ${code}, got ${run.exitCode}`) };
  }
  if ((match = /^stdout\s+not\s+contains\s+(.+)$/.exec(text))) {
    const needle = match[1];
    return { readsStdout: true, test: run => (run.stdout.includes(needle) ? `stdout_contains: ${needle}` : null) };
  }
  if ((match = /^stdout\s+contains\s+(.+)$/.exec(text))) {
    const needle = match[1];
    return { readsStdout: true, test: run => (run.stdout.includes(needle) ? null : `stdout_lacks: ${needle}`) };
  }
  if ((match = /^stdout\s+matches\s+\/(.+)\/$/.exec(text))) {
    let regex;
    try {
      regex = new RegExp(match[1]);
    } catch (error) {
      return { error: `bad_regex: ${error.message}` };
    }
    return { readsStdout: true, test: run => (regex.test(run.stdout) ? null : `stdout_no_match: ${regex}`) };
  }
  return { error: `unknown_expect: ${text}` };
}

// npm на Windows — npm.cmd, а .cmd без оболочки не запускается (spawn бросает
// EINVAL, а имя `npm` без расширения даёт ENOENT — проверено запуском). Поэтому
// повторяется то, что делает сам npm.cmd: node.exe рядом с ним (иначе node из
// PATH) исполняет node_modules/npm/bin/npm-cli.js. Ветку npm.cmd с префиксом
// глобальной установки (npm-prefix.js) это не повторяет.
function resolveExecutable(argv) {
  const [executable, ...args] = argv;
  if (executable !== 'npm' || process.platform !== 'win32') return { file: executable, args };

  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir || !fs.existsSync(path.join(dir, 'npm.cmd'))) continue;
    const cli = path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (!fs.existsSync(cli)) continue;
    const localNode = path.join(dir, 'node.exe');
    return { file: fs.existsSync(localNode) ? localNode : 'node', args: [cli, ...args] };
  }
  return { file: executable, args };
}

// Дерево целиком: `npm test` запускает дочерний node, и без этого он пережил бы
// таймаут, держа открытыми трубы вывода (проверено запуском на Windows: после
// kill() одного npm close пришёл, лишь когда внук доработал).
function killTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
}

// Поток вывода: до captureLimit байт — целиком, сверх — только хвост TAIL_BYTES;
// остальное читается и отбрасывается, процесс дописывает вывод до конца или до
// таймаута.
function outputCollector(captureLimit) {
  const chunks = [];
  let kept = 0;
  let total = 0;
  return {
    push(chunk) {
      chunks.push(chunk);
      kept += chunk.length;
      total += chunk.length;
      if (total <= captureLimit) return;
      while (kept - chunks[0].length >= TAIL_BYTES) kept -= chunks.shift().length;
    },
    read() {
      return { text: Buffer.concat(chunks).toString('utf8'), totalBytes: total, overflow: total > captureLimit };
    }
  };
}

function spawnCheck(argv, projectRoot, timeoutMs, captureLimit) {
  const { file, args } = resolveExecutable(argv);
  return new Promise(resolve => {
    const started = Date.now();
    const stdout = outputCollector(captureLimit);
    const stderr = outputCollector(captureLimit);
    let timer = null;
    let settled = false;

    const finish = outcome => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: null,
        stdout: stdout.read(),
        stderr: stderr.read(),
        durationMs: Date.now() - started,
        ...outcome
      });
    };

    let child;
    try {
      // detached вне Windows — своя группа процессов, чтобы killTree снял её целиком;
      // на Windows detached открыл бы окно консоли, дерево снимает taskkill /T.
      child = spawn(file, args, {
        cwd: projectRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32'
      });
    } catch (error) {
      finish({ spawnError: error.code || error.message });
      return;
    }

    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    // ENOENT приходит событием error, за ним — close с отрицательным кодом
    // (проверено запуском); отчёт даёт первое из них.
    child.on('error', error => finish({ spawnError: error.code || error.message }));
    child.on('close', code => finish({ exitCode: code }));
    timer = setTimeout(() => {
      killTree(child);
      child.stdout.destroy();
      child.stderr.destroy();
      finish({ timedOut: true });
    }, timeoutMs);
  });
}

// Хвост, а не начало: итог прогона тестов и трасса ошибки печатаются в конце.
// Сверх предела хранения всего потока в символах нет — пометка называет байты.
function clip({ text, totalBytes, overflow }) {
  const tail = text.slice(-CHECK_OUTPUT_LIMIT);
  if (overflow) return `[усечено: последние ${CHECK_OUTPUT_LIMIT} символов из ${totalBytes} байт]\n${tail}`;
  if (text.length <= CHECK_OUTPUT_LIMIT) return text;
  return `[усечено: последние ${CHECK_OUTPUT_LIMIT} из ${text.length} символов]\n${tail}`;
}

/**
 * Исполняет проверку пункта DoD.
 *
 * @param {object} params
 * @param {string} params.check - команда
 * @param {string} params.expect - ожидание
 * @param {string} params.projectRoot - корень проекта, рабочий каталог команды
 * @param {number} [params.timeoutMs] - таймаут, по умолчанию CHECK_TIMEOUT_MS
 * @param {number} [params.captureLimit] - байт каждого потока в памяти, по умолчанию
 *   CHECK_CAPTURE_LIMIT
 * @returns {Promise<{status: 'passed'|'failed'|'timeout'|'denied', exit_code: number|null,
 *   stdout: string, stderr: string, duration_ms: number, reason: string|null}>}
 *   `denied` — нарушены ограничения, процесс не запускался; `failed` — ожидание не
 *   выполнено или процесс не стартовал (`reason: spawn_failed: <код>`). stdout и
 *   stderr усечены до CHECK_OUTPUT_LIMIT символов с пометкой; ожидание сверяется
 *   с полным выводом. stdout длиннее captureLimit байт целиком не хранится, и
 *   ожидание вида stdout даёт `failed` с причиной `stdout_too_large: <байт>`.
 */
export async function runCheck({ check, expect, projectRoot, timeoutMs = CHECK_TIMEOUT_MS, captureLimit = CHECK_CAPTURE_LIMIT }) {
  const denied = reason => ({ status: 'denied', exit_code: null, stdout: '', stderr: '', duration_ms: 0, reason });

  const parsed = splitCommand(String(check ?? '').trim());
  if (parsed.error) return denied(parsed.error);
  const violation = commandViolation(parsed.argv);
  if (violation) return denied(violation);
  const expectation = parseExpect(expect);
  if (expectation.error) return denied(expectation.error);

  const run = await spawnCheck(parsed.argv, projectRoot, timeoutMs, captureLimit);
  const report = {
    exit_code: run.exitCode,
    stdout: clip(run.stdout),
    stderr: clip(run.stderr),
    duration_ms: run.durationMs
  };
  if (run.timedOut) return { status: 'timeout', ...report, reason: `timeout_ms: ${timeoutMs}` };
  if (run.spawnError) return { status: 'failed', ...report, reason: `spawn_failed: ${run.spawnError}` };
  if (expectation.readsStdout && run.stdout.overflow) {
    return { status: 'failed', ...report, reason: `stdout_too_large: ${run.stdout.totalBytes}` };
  }
  const failure = expectation.test({ exitCode: run.exitCode, stdout: run.stdout.text });
  return { status: failure ? 'failed' : 'passed', ...report, reason: failure };
}

/** Тикет нового формата DoD: `dod_format: 2` во frontmatter (число или строка). */
export function isDodFormat2(frontmatter) {
  return String(frontmatter?.dod_format) === '2';
}

// Заголовок секции — как у parseDoDCompletion в verify-artifacts.js.
const DOD_HEADING = /^##\s*(?:Критерии готовности|Definition of Done)(?:\s*\([^)]*\))?\s*$/m;
const DOD_ITEM = /^[-*]\s+\[([ xX])\]\s?(.*)$/;
const NESTED_BULLET = /^\s+[-*]\s+(.*)$/;
const CHECK_KEYS = new Set(['check', 'expect', 'regression', 'prose', 'visual']);
const FORM_KEYS = new Set(['check', 'prose', 'visual']);
// Ключ латиницей, значение — в обратных кавычках сразу после двоеточия; ключ без
// такого значения остаётся с null. Как `pairRegex` implementation assertions в
// verify-artifacts.js, но пустое значение и ключ без значения тоже видны.
const KEY_VALUE = /(\w+)\s*:\s*(?:`([^`]*)`)?/g;

function readFormLine(content) {
  const forms = [];
  const values = {};
  for (const [, key, value] of content.matchAll(KEY_VALUE)) {
    if (!CHECK_KEYS.has(key)) continue;
    if (FORM_KEYS.has(key)) forms.push(key);
    values[key] = value === undefined ? null : value.trim();
  }
  return { forms, values };
}

// Строка проверки начинается с ключа записи; иначе это не проверка — null.
function readCheckLine(content) {
  const key = /^(\w+)\s*:/.exec(content);
  return key && CHECK_KEYS.has(key[1]) ? readFormLine(content) : null;
}

function describeForm(lines) {
  const forms = lines.flatMap(line => line.forms);
  if (forms.length === 0) return { kind: null, error: 'no_form' };
  if (forms.length > 1) return { kind: null, error: 'multiple_forms' };

  const values = Object.assign({}, ...lines.map(line => line.values));
  const kind = forms[0];
  if (kind === 'check') {
    let error = null;
    if (!values.check) error = 'check_without_command';
    else if (!values.expect) error = 'check_without_expect';
    else if ('regression' in values && values.regression !== 'true') error = 'bad_regression';
    return {
      kind,
      command: values.check || null,
      expect: values.expect || null,
      regression: values.regression === 'true',
      error
    };
  }
  const strayKeys = 'expect' in values || 'regression' in values;
  if (kind === 'prose') {
    return { kind, reason: values.prose || null, error: strayKeys ? 'keys_without_check' : values.prose ? null : 'prose_without_reason' };
  }
  return { kind, mask: values.visual || null, error: strayKeys ? 'keys_without_check' : values.visual ? null : 'visual_without_path' };
}

/**
 * Разбирает пункты секции «Критерии готовности (Definition of Done)» и их проверки.
 *
 * Пункт — строка `- [ ] …` / `- [x] …` без отступа. Строка проверки — вложенный
 * пункт с отступом, начинающийся с ключа `check`, `expect`, `regression`, `prose`
 * или `visual`; ключи нескольких таких строк одного пункта сливаются. Прочие
 * вложенные строки не учитываются.
 *
 * @param {string} ticketBody - тело тикета (после frontmatter)
 * @returns {Array<{
 *   index: number,                          // номер пункта с 1
 *   text: string,                           // текст пункта дословно
 *   checked: boolean,                       // отмечен [x]
 *   kind: 'check'|'prose'|'visual'|null,    // null — формы нет или их больше одной
 *   command?: string|null,                  // check: команда
 *   expect?: string|null,                   // check: ожидание
 *   regression?: boolean,                   // check: `regression: \`true\``
 *   reason?: string|null,                   // prose: причина
 *   mask?: string|null,                     // visual: путь или маска изображений
 *   error: null | 'no_form' | 'multiple_forms' | 'check_without_command'
 *     | 'check_without_expect' | 'bad_regression' | 'prose_without_reason'
 *     | 'visual_without_path' | 'keys_without_check'
 * }>} пустой массив, если секции нет. При `error` у формы kind сохраняется
 *   (`bad_regression` даёт regression: false), при no_form/multiple_forms — null.
 */
export function parseDodChecks(ticketBody) {
  const text = String(ticketBody ?? '');
  const heading = DOD_HEADING.exec(text);
  if (!heading) return [];

  const start = heading.index + heading[0].length;
  const nextH2 = text.indexOf('\n## ', start);
  const section = text.slice(start, nextH2 === -1 ? text.length : nextH2);

  const items = [];
  let current = null;
  for (const line of section.split(/\r?\n/)) {
    const item = DOD_ITEM.exec(line);
    if (item) {
      current = { index: items.length + 1, text: item[2].trim(), checked: item[1] !== ' ', lines: [] };
      items.push(current);
      continue;
    }
    const nested = current && NESTED_BULLET.exec(line);
    if (!nested) continue;
    const checkLine = readCheckLine(nested[1]);
    if (checkLine) current.lines.push(checkLine);
  }

  return items.map(({ lines, ...item }) => ({ ...item, ...describeForm(lines) }));
}

/**
 * Разбирает одну запись проверки без маркера пункта: `check: …, expect: …`,
 * `prose: …` или `visual: …`. Так проверка записана у критерия приёмки задачи
 * плана (строка `**Проверка:**`); при декомпозиции каждая запись становится
 * проверкой одного пункта DoD, поэтому правила и ошибки — те же, что у пункта в
 * parseDodChecks. Запись, которая не начинается с ключа проверки, даёт `no_form`:
 * в тикете такую вложенную строку parseDodChecks не читает.
 *
 * @param {string} text - запись проверки
 * @returns {{kind: 'check'|'prose'|'visual'|null, error: string|null}} и поля формы —
 *   как у пункта parseDodChecks, без index, text и checked
 */
export function parseCheckRecord(text) {
  const line = readCheckLine(String(text ?? '').trim());
  return describeForm(line ? [line] : []);
}
