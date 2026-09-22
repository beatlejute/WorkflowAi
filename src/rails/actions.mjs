/**
 * Rails — нормализация действий (спецификация §6).
 *
 * Приводит вызов инструмента (Claude Code hook input / Kilo plugin
 * input+output) к единой форме `{ tool, kind, command?, path?, server?,
 * mcpTool?, shell? }`, `kind ∈ shell | edit | write | read | agent | mcp | other`.
 * Неизвестные имена инструментов — `other`, никогда не ошибка (§6).
 *
 * `writesTo` (§6, детерминированно распознаваемые пути записи из shell-
 * команды) в объект действия не встроен — таблица API отдельно перечисляет
 * `detectShellWrites(command, opts?)` как самостоятельную функцию; вызывающий
 * код (`core.mjs`) вызывает её сам для `kind === "shell"`, если ему нужен
 * `writesTo`.
 *
 * `shell: 'posix' | 'powershell'` (ЗАДАЧА C, 2026-09-22: инструмент
 * PowerShell маппился в kind 'other' — вся shell-защита его не видела) —
 * диалект команды; `core.collectWriteTargets` передаёт его в `detectShellWrites`.
 * Строку команды разбирает только shell-scan.mjs (ЗАДАЧА C2, 2026-09-22).
 */

import { homedir } from 'node:os';
import { dirname, join, parse as parsePath, resolve as resolvePath } from 'node:path';
import { realpathDeep } from './paths.mjs';
import { expandWord, nestedScripts, scanCommand, splitRedirects, wordAfterPrefix } from './shell-scan.mjs';

const READ_TOOLS_CLAUDE = new Set(['Read', 'Glob', 'Grep', 'LS']);
const READ_TOOLS_KILO = new Set(['read', 'glob', 'grep', 'list']);
const EDIT_TOOLS_CLAUDE = new Set(['Edit', 'MultiEdit', 'NotebookEdit']);
const EDIT_TOOLS_KILO = new Set(['edit', 'patch', 'multiedit']);
const AGENT_TOOLS_CLAUDE = new Set(['Agent', 'Task']);

const MCP_NAME_RE = /^mcp__(.+?)__(.+)$/;

/**
 * Действие из входа хука Claude Code (`PreToolUse`/`PostToolUse`):
 * `{ tool_name, tool_input }`.
 *
 * @param {{tool_name?: string, tool_input?: object}} hookInput
 * @returns {{tool: string, kind: string, command?: string, path?: string, server?: string, mcpTool?: string}}
 */
export function fromClaude(hookInput) {
  const toolName = hookInput?.tool_name ?? '';
  const input = hookInput?.tool_input ?? {};

  if (toolName === 'Bash') {
    return { tool: toolName, kind: 'shell', command: input.command, shell: 'posix' };
  }
  // ЗАДАЧА C (2026-09-22): инструмент PowerShell маппился в kind 'other' —
  // канарейка/deny_shell/stage_actions/write_scope его не видели (обход рельс).
  if (toolName === 'PowerShell') {
    return { tool: toolName, kind: 'shell', command: input.command, shell: 'powershell' };
  }
  if (EDIT_TOOLS_CLAUDE.has(toolName)) {
    return {
      tool: toolName,
      kind: 'edit',
      path: input.file_path ?? input.notebook_path ?? input.filePath,
    };
  }
  if (toolName === 'Write') {
    return { tool: toolName, kind: 'write', path: input.file_path ?? input.filePath };
  }
  if (READ_TOOLS_CLAUDE.has(toolName)) {
    return { tool: toolName, kind: 'read' };
  }
  if (AGENT_TOOLS_CLAUDE.has(toolName)) {
    return { tool: toolName, kind: 'agent' };
  }
  const mcpMatch = MCP_NAME_RE.exec(toolName);
  if (mcpMatch) {
    return { tool: toolName, kind: 'mcp', server: mcpMatch[1], mcpTool: mcpMatch[2] };
  }
  return { tool: toolName, kind: 'other' };
}

/**
 * Действие из плагина Kilo (`tool.execute.before`/`after`):
 * `input = { tool, sessionID, callID }`, `output.args` — аргументы вызова.
 *
 * Открытый вопрос: спецификация даёт для Kilo mcp-имя только форму
 * `<server>_<tool>` (одно подчёркивание, без примера) — если имя сервера
 * само содержит `_`, разбор неоднозначен. Выбрано простое детерминированное
 * решение: делить по первому `_`.
 *
 * @param {{tool?: string}} input
 * @param {{args?: object}} [output]
 * @returns {{tool: string, kind: string, command?: string, path?: string, server?: string, mcpTool?: string}}
 */
export function fromKilo(input, output) {
  const tool = String(input?.tool ?? '');
  const args = output?.args ?? {};

  if (tool === 'bash') {
    return { tool, kind: 'shell', command: args.command, shell: 'posix' };
  }
  if (EDIT_TOOLS_KILO.has(tool)) {
    return { tool, kind: 'edit', path: args.filePath ?? args.file_path ?? args.notebook_path };
  }
  if (tool === 'write') {
    return { tool, kind: 'write', path: args.filePath ?? args.file_path };
  }
  if (READ_TOOLS_KILO.has(tool)) {
    return { tool, kind: 'read' };
  }
  if (tool === 'task') {
    return { tool, kind: 'agent' };
  }
  const underscoreIdx = tool.indexOf('_');
  if (underscoreIdx > 0 && underscoreIdx < tool.length - 1) {
    return {
      tool,
      kind: 'mcp',
      server: tool.slice(0, underscoreIdx),
      mcpTool: tool.slice(underscoreIdx + 1),
    };
  }
  return { tool, kind: 'other' };
}

// --- detectShellWrites: консервативный разбор записи через shell --------------------------
//
// ЗАДАЧА C2, 2026-09-22. Первая версия (ЗАДАЧА C) отклонена обоими ревью — регрессии
// deny→allow: свой сплиттер/трекер кавычек (`\"` в "…" прятал редирект после `;`), сегмент-
// присваивание целиком «съедал» команду (`X=$(touch …)`, `FOO=bar > f`, `$x = (Remove-Item …)`),
// cd брал весь остаток сегмента (`cd X & touch …`), popd и `cd -` не знала, нераскрытый `$`
// оставался буквой пути. Теперь разбор строки — только shell-scan.mjs, а всё, что нельзя
// вычислить однозначно, даёт маркер '?' (ложный отказ допустим, ложное разрешение — нет).
//
// Модель — «миры»: возможные состояния shell'а перед очередным сегментом (каталог, переменные,
// статус последней команды S/F/?). Каталог: абсолютный путь; '' — cwd вызывающего (путь цели
// остаётся относительным, как до ЗАДАЧИ C); null — неизвестен (относительная запись → '?').
// cd может не удаться, а bash и PowerShell после `;`/перевода строки/`||` продолжают в прежнем
// каталоге (проверено запуском), поэтому трекаемый cd даёт два мира — успех и неудачу, а
// `&&`/`||` выбирают, в каких мирах выполняется следующий сегмент. Цель записи проверяется
// во всех мирах, где сегмент может выполниться.
//
// Два прохода. Первый собирает имена переменных, которые где-либо в команде меняются не
// трекаемым присваиванием (read/for/local/`((x++))`/`${x:=…}`/-OutVariable/`[ref]$x`/…), и
// признак «каталог меняется где-то в команде» для циклов; второй вычисляет цели. Переменная из
// первого списка неизвестна везде: в цикле присваивание ниже по тексту действует раньше.

const IS_WIN32 = process.platform === 'win32';
const MARK = '?';
const MARKER_ITEM = Object.freeze({ marker: true });
const EMPTY_WORD = Object.freeze({ kind: 'word', parts: [], value: '', text: '', quote: 'none', hasSubstitution: false, hasExpansion: false });
// Предохранители: миров больше — всё неизвестно; вложенность подстановок и общий объём работы
// ограничены (патологическая команда не должна уронить хук или съесть бюджет решения, §7).
const MAX_WORLDS = 16;
const MAX_NESTED = 8;
const WALK_BUDGET = 4000;
const MAX_NESTED_RUNS = 64; // вложенных интерпретаторов (`bash -c` …) на всю команду

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ASSIGN_WORD_RE = /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=/;
// Имя, которому присваивают внутри слова: `S=`, `S+=`, `a[S=1]`, `((x=S=5))`, `S++`, `--S`.
// Ревью C2 r3 (2026-09-22, HIGH): без `(?<![A-Za-z0-9_])` сопоставление начиналось с КАЖДОЙ
// позиции пробега букв, и жадный класс имени откатывался до конца — O(n^2): слово из 24 000
// букв разбиралось 4 с, из 96 000 — 64 с (HEAD — 14 мс). Хук на каждый вызов инструмента
// висел секунды-минуты, а убитый по таймауту хук = allow. Внутри пробега имя начаться не
// может (для bash имя считается от границы), так что запрет старта в середине ничего не меняет.
const ASSIGNISH_RE = /(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*)\s*(?:[-+*/%&|^]|<<|>>)?=(?!=)|(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*)\s*(?:\+\+|--)|(?:\+\+|--)\s*(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*)/g;
const DOT_DOT_RE = /(?:^|[\\/])\.\.(?:[\\/]|$)/;
// Раунд 2 ревью C2 (2026-09-22). `NAME[i]=…` — присваивание элементу массива: `$S` — это
// `${S[0]}`, а перед командой bash считает такое слово префиксом-присваиванием и команду
// выполняет (`S[0]=x touch f` создаёт f, проверено запуском).
const ARRAY_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*\[[^\]]*\]\+?=/;
const ARRAY_REF_RE = /(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*)\[/g;
// Присваивание с динамическим именем: `(( $n = 5 ))`, `$(( x=1, $n=5 ))`, `let "$n=1"`,
// `declare "$n=…"` — bash присваивает переменной, имя которой лежит в $n (проверено запуском).
const DYN_ASSIGN_RE = /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\s*(?:[-+*/%&|^]|<<|>>)?=(?!=)|(?:\+\+|--)\$\{?[A-Za-z_]|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?(?:\+\+|--)(?![A-Za-z0-9_-])/;
// PowerShell: префикс параметра — `-` и тире – — ― (U+2013–U+2015): `Set-Content –Path f` пишет
// в f (проверено запуском PS 5.1; U+2012 параметром не считается).
const PS_DASHES_RE = /^[-–—―]{1,2}/;

const CHAIN_SEPS = new Set(['&&', '||', ';', '\n']);
const STRUCTURAL_SEPS = new Set(['(', ')', '&']);

// Составные команды: внутри них cd/присваивание не трекаются (условие, цикл, группа).
const POSIX_KEYWORDS = new Set(['if', 'then', 'elif', 'else', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'select', 'function', '{', '}', 'coproc', 'alias']);
const POSIX_LOOP_START = new Set(['for', 'while', 'until', 'select', 'function', '{']);
const PS_KEYWORDS = new Set(['if', 'elseif', 'else', 'switch', 'foreach', 'for', 'while', 'do', 'until', 'function', 'filter', 'workflow', 'try', 'catch', 'finally', 'trap', 'begin', 'process', 'end', 'dynamicparam', 'param', 'class', 'enum', 'data', 'set-alias', 'sal', 'new-alias', 'nal']);
const PS_LOOP_START = new Set(['foreach', 'for', 'while', 'do', 'until', 'function', 'filter', 'workflow', 'trap']);

// Трекаемая смена каталога (ровно `cd <каталог>`) и всё, что меняет каталог иначе.
const CD_POSIX = new Set(['cd', 'pushd']);
const CD_PS = new Set(['cd', 'chdir', 'sl', 'set-location', 'pushd', 'push-location']);
const DIR_CHANGERS_POSIX = new Set(['cd', 'pushd', 'popd']);
const DIR_CHANGERS_PS = new Set([...CD_PS, 'popd', 'pop-location']);
// Меняют каталог и переменные непредсказуемо (исполняют чужой код в текущем shell'е).
const OPAQUE_POSIX = new Set(['eval', 'source', '.', 'trap', 'alias']);
const OPAQUE_PS = new Set(['invoke-expression', 'iex', '.', 'import-module', 'ipmo', 'set-alias', 'sal', 'new-alias', 'nal', 'set-variable', 'sv', 'new-variable', 'nv', 'clear-variable', 'clv', 'remove-variable', 'rv', 'get-variable', 'gv', 'invoke-command', 'icm']);
const EVAL_NAMES = new Set(['eval', 'invoke-expression', 'iex']);

// POSIX-встроенные, чьи аргументы — имена переменных (все идентификаторы аргументов — taint).
const POSIX_ASSIGNING = new Set(['read', 'mapfile', 'readarray', 'printf', 'getopts', 'wait', 'declare', 'typeset', 'local', 'export', 'readonly', 'unset', 'let', 'compgen']);
const POSIX_DECLARERS = new Set(['declare', 'typeset', 'local', 'export', 'readonly']);
// bash меняет сам или не даёт присвоить (readonly по умолчанию — `readonly -p`, проверено запуском).
const POSIX_DYNAMIC = new Set(['OLDPWD', 'RANDOM', 'SRANDOM', 'SECONDS', 'LINENO', 'BASHPID', 'EPOCHSECONDS', 'EPOCHREALTIME', 'BASH_COMMAND', 'FUNCNAME', 'GROUPS', 'HISTCMD', 'PIPESTATUS', '_', 'BASHOPTS', 'SHELLOPTS', 'BASH_VERSINFO', 'EUID', 'UID', 'PPID', 'DIRSTACK', 'BASH_SUBSHELL', 'BASH_ARGV0', 'REPLY', 'OPTARG', 'OPTIND']);
// Не трекаются: их присваивание меняет смысл `~`, деления слов, cd.
const POSIX_NEVER_TRACK = new Set([...POSIX_DYNAMIC, 'PWD', 'HOME', 'IFS', 'CDPATH']);
// Автоматические переменные PowerShell ($HOME — только чтение, проверено запуском).
const PS_NEVER_TRACK = new Set(['home', 'pwd', 'null', 'true', 'false', '_', 'psitem', 'args', 'input', 'this', 'ofs', 'error', 'matches', 'lastexitcode', 'host', 'executioncontext', 'myinvocation', 'pscmdlet', 'psscriptroot', 'pscommandpath', 'psboundparameters', 'stacktrace', 'pshome', 'profile', 'pid', 'foreach', 'switch', 'event', 'eventargs', 'sender']);
const PS_OUTVAR_PARAMS = new Set(['outvariable', 'ov', 'errorvariable', 'ev', 'warningvariable', 'wv', 'informationvariable', 'iv', 'pipelinevariable', 'pv', 'variable']);
// Имя параметра PowerShell принимает однозначный префикс (`-OutVar S`) — сверяем префиксы полных имён.
const PS_OUTVAR_FULL = ['outvariable', 'errorvariable', 'warningvariable', 'informationvariable', 'pipelinevariable', 'variable'];
// Проверки, где `$a = b` — сравнение, а не присваивание.
const POSIX_TESTS = new Set(['[', '[[', 'test']);

// Обёртки POSIX: следующее за ними слово — команда. value — флаги со значением отдельным словом,
// chdir — флаги смены каталога для обёрнутой команды (её относительные цели неизвестны).
// Ключевые слова, после которых идёт команда (`then rm …`, `do rm …`), — тоже обёртки
// (ревью ЗАДАЧИ C: `for …; do rm /outside; done` HEAD не видел — `rm` не в позиции команды).
const WRAPPERS = {
  sudo: { value: ['-u', '-g', '-p', '-C', '-D', '-r', '-t', '-U', '-T', '-h'], chdir: ['-D', '--chdir'] },
  doas: { value: ['-u', '-C'] },
  command: {},
  builtin: {},
  exec: { value: ['-a'] },
  nohup: {},
  stdbuf: {},
  time: {},
  '!': {},
  // env: присваивание — любое слово с `=` (`env ./x=y touch f` создаёт f, проверено запуском)
  env: { value: ['-u', '-C'], chdir: ['-C', '--chdir'], assigns: true },
  nice: { value: ['-n'] },
  // Обёртки того же вида, что coproc (раунд 3 ревью C2): следующее слово (у flock — после
  // файла блокировки) команда. В Git Bash на этой машине обеих утилит нет (проверено
  // `command -v` — not found), поведение взято из их документированной формы; правило только
  // расширяет детект записи, ложного разрешения из него не возникает.
  setsid: { value: ['-c'] },
  flock: { value: ['-w', '--wait', '--timeout', '-E', '--conflict-exit-code'], positional: 1 },
  timeout: { value: ['-s', '-k'], positional: 1 },
  xargs: { value: ['-I', '-L', '-n', '-P', '-d', '-E', '-s', '-a'], appends: true },
  git: { value: ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'], chdir: ['-C', '--git-dir', '--work-tree'] },
  if: {},
  then: {},
  elif: {},
  else: {},
  while: {},
  until: {},
  do: {},
  '{': {},
  // Раунд 3 ревью C2 (2026-09-22): `coproc touch f` и `function f { touch f; }` записи не
  // показывали — coproc не был обёрткой, `function` считался именем команды (проверено
  // запуском bash 5.2: оба создают файл; тело функции — `{…}`, `(…)`, if/while/for).
  // skipName: 'always' — следующее слово — имя функции; 'compound' — имя корутины, но только
  // перед составной командой (`coproc NAME { … }`; в `coproc touch f` слово — сама команда).
  coproc: { skipName: 'compound' },
  function: { skipName: 'always' },
};

// Слова, с которых начинается составная команда (тело функции, корутины).
const POSIX_COMPOUND_START = new Set(['{', 'if', 'while', 'until', 'for', 'case', 'select', '[[', '((']);

// Команды записи. POSIX: удаление — все позиционные; создание — все позиционные (без значений
// флагов); cp/mv — назначение (`-t DIR` или последний аргумент), у mv и источники (удаляются).
const POSIX_DELETE = new Set(['rm', 'rmdir', 'unlink', 'del']);
const POSIX_CREATE = new Set(['touch', 'mkdir', 'tee', 'truncate']);
// Назначение — последний позиционный или -t DIR (как cp); install -d — все позиционные.
const POSIX_LINKERS = new Set(['cp', 'mv', 'ln', 'install']);
// Длинные флаги GNU принимают однозначный префикс (`cp --t DIR`, `--targ=DIR`, `mkdir --m 700`,
// `sed --in` — проверено запуском Git Bash): флаг-префикс длинного флага со значением считается
// им (неоднозначный префикс getopt отвергает — команда не выполняется).
const POSIX_VALUE_FLAGS = {
  touch: ['-d', '-r', '-t', '--date', '--reference', '--time'],
  mkdir: ['-m', '--mode'],
  cp: ['-t', '-S', '--target-directory', '--suffix', '--sparse', '--no-preserve'],
  mv: ['-t', '-S', '--target-directory', '--suffix'],
  truncate: ['-s', '-r', '--size', '--reference'],
  ln: ['-t', '-S', '--target-directory', '--suffix'],
  install: ['-t', '-S', '-m', '-o', '-g', '--target-directory', '--suffix', '--mode', '--owner', '--group', '--strip-program'],
};
// PowerShell: командлет → вид цели; алиасы PowerShell 5.1.
const PS_CMDLETS = { 'remove-item': 'delete', 'set-content': 'path', 'add-content': 'path', 'clear-content': 'path', 'out-file': 'path', 'tee-object': 'path', 'export-csv': 'path', 'new-item': 'new', 'copy-item': 'copy', 'move-item': 'move' };
const PS_ALIASES = { ri: 'remove-item', rm: 'remove-item', rmdir: 'remove-item', rd: 'remove-item', del: 'remove-item', erase: 'remove-item', sc: 'set-content', ac: 'add-content', clc: 'clear-content', ni: 'new-item', mkdir: 'new-item', md: 'new-item', cp: 'copy-item', copy: 'copy-item', cpi: 'copy-item', mv: 'move-item', move: 'move-item', mi: 'move-item', tee: 'tee-object', epcsv: 'export-csv' };
const PS_PATH_PARAMS = ['path', 'literalpath', 'pspath', 'lp', 'filepath'];
const PS_DEST_PARAMS = ['destination', 'destinationpath'];
const PS_SWITCHES = new Set(['force', 'recurse', 'whatif', 'confirm', 'passthru', 'nonewline', 'append', 'noclobber', 'verbose', 'debug', 'container', 'notypeinformation', 'includetypeinformation', 'useculture', 'asbytestream', 'wait', 'raw', 'usetransaction']);
// Параметры со значением у командлетов записи и общие (-ErrorAction, -OutVariable …).
const PS_VALUE_PARAMS = ['value', 'encoding', 'filter', 'include', 'exclude', 'credential', 'delimiter', 'itemtype', 'type', 'stream', 'width', 'inputobject', 'name', 'target', 'quotefields', 'usequotes', 'erroraction', 'ea', 'warningaction', 'wa', 'informationaction', 'infa', 'outbuffer', 'ob', ...PS_OUTVAR_PARAMS];
// Имя параметра — точное или однозначный префикс (PowerShell принимает `-Rec`, `-Fo`, `-Pat`).
const PS_PARAM_CLASS = new Map([
  ...PS_PATH_PARAMS.map((n) => [n, 'path']),
  ...PS_DEST_PARAMS.map((n) => [n, 'dest']),
  ...[...PS_SWITCHES].map((n) => [n, 'switch']),
  ...PS_VALUE_PARAMS.map((n) => [n, 'value']),
]);

// Трекаемое присваивание PowerShell `$x = '…'` и любое присваивание-инструкция.
const PS_TRACK_ASSIGN_RE = /^\$(?:(env|global|script|local|private):)?([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)\s*/i;
const PS_VAR_REF = String.raw`(?:\[[^\]]*\]\s*)*\$(?:\{[^}]*\}|(?:\w+:)?\w+)`;
const PS_ASSIGN_STMT_RE = new RegExp(String.raw`^${PS_VAR_REF}(?:\s*,\s*${PS_VAR_REF})*\s*(?:[-+*/%]|\?\?)?=(?!=)`);

// --- контекст и миры ---------------------------------------------------------------------

function makeContext(dialect, env) {
  const scans = new Map();
  const infos = new Map();
  const splits = new WeakMap();
  return {
    dialect,
    ps: dialect === 'powershell',
    env,
    out: new Set(),
    marker: false,
    taint: new Set(),
    taintAll: false,
    shopt: false, // в команде есть `shopt`/`set` — cdable_vars и т.п. могли включиться
    tracked: new Map(),
    readonlyNames: new Set(),
    taintPass: true,
    budget: WALK_BUDGET,
    scan(text) {
      let s = scans.get(text);
      if (!s) {
        s = scanCommand(text, dialect);
        scans.set(text, s);
      }
      return s;
    },
    info(text) {
      let i = infos.get(text);
      if (!i) {
        i = { dirChange: false };
        infos.set(text, i);
      }
      return i;
    },
    split(cmd) {
      let r = splits.get(cmd);
      if (!r) {
        r = splitRedirects(cmd, dialect);
        // PowerShell: тире – — ― в начале слова — префикс параметра, как `-` (раунд 2 ревью C2,
        // 2026-09-22: `Set-Content –Path <вне области>` считался позиционным путём `–Path`).
        if (dialect === 'powershell') r = { ...r, words: r.words.map(psWord) };
        splits.set(cmd, r);
      }
      return r;
    },
  };
}

// PowerShell-параметр — только незакавыченное слово с тире и буквой после него, без кавычек в
// имени: `'-Path'`, `-'Path'`, `-Pa'th'`, `--Path` и `-5` — позиционные значения, `--` — конец
// параметров, дальше всё позиционное (проверено запуском PS 5.1: `Set-Content '-Path' x`,
// `Set-Content -Pa'th' y`, `Set-Content -- -Path x` создают файл `-Path`, `Set-Content --Path x` —
// файл `--Path`, `Remove-Item -- sub/f` удаляет sub/f). Тире – — ― приводятся к `-`.
function psWord(w) {
  const p0 = w.parts[0];
  const m = p0 && p0.kind === 'bare' ? PS_DASHES_RE.exec(p0.raw) : null;
  if (!m) return w;
  const dashes = '-'.repeat(m[0].length);
  const norm = (s) => (s === null ? null : dashes + s.slice(m[0].length));
  const raw0 = norm(p0.raw);
  const psEnd = w.parts.length === 1 && raw0 === '--';
  const psParam = !psEnd && /^-[A-Za-z_?]/.test(raw0) && (w.parts.length === 1 || raw0.includes(':'));
  // orig — слово как есть: внешней программе (touch.exe, sed.exe) PowerShell передаёт текст, не параметр
  return { ...w, text: norm(w.text), value: norm(w.value), psParam, psEnd, orig: w };
}

function taintName(ctx, name, env = false) {
  if (!name) return;
  if (!ctx.ps) ctx.taint.add(name);
  else ctx.taint.add(env ? `env:${name.toLowerCase()}` : name.toLowerCase());
}

function newWorld(dir) {
  return { dir, vars: new Map(), envv: new Map(), st: '?', lost: false };
}

function mergeWorlds(list) {
  const seen = new Map();
  for (const w of list) seen.set(JSON.stringify([w.dir, w.st, w.lost, [...w.vars], [...w.envv]]), w);
  const out = [...seen.values()];
  return out.length > MAX_WORLDS ? [{ dir: null, vars: new Map(), envv: new Map(), st: '?', lost: true }] : out;
}

function isFullAbs(p) {
  if (typeof p !== 'string') return false;
  return IS_WIN32 ? /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p) : p.startsWith('/');
}

function fullDir(dir) {
  return isFullAbs(dir) ? dir : null;
}

// Переменная окружения: POSIX — точное имя (bash различает регистр; `$temp` при TEMP пуст),
// PowerShell `$env:X` — без учёта регистра.
function envValue(env, name, ci) {
  const keys = Object.keys(env);
  let key = keys.find((k) => k === name);
  if (key === undefined && ci) {
    const lower = name.toLowerCase();
    key = keys.find((k) => k.toLowerCase() === lower);
  }
  if (key === undefined) return null;
  return typeof env[key] === 'string' ? env[key] : null;
}

// Значение переменной в мире: сначала присвоенные этой же командой, затем окружение;
// неизвестно — null (цель записи станет '?'). PowerShell `$X` — не `$env:X`: неприсвоенная
// `$ZZ` пуста, даже если есть переменная окружения ZZ (проверено запуском PS 5.1).
function lookupFor(w, ctx) {
  return (ref) => {
    if (ctx.taintAll || w.lost) return null;
    if (ctx.ps) {
      if (ref.tilde) return homedir();
      const key = ref.name.toLowerCase();
      if (ref.env) {
        if (ctx.taint.has(`env:${key}`)) return null;
        if (w.envv.has(key)) return w.envv.get(key);
        return envValue(ctx.env, ref.name, true);
      }
      if (ctx.taint.has(key)) return null;
      if (key === 'home') return homedir();
      if (key === 'pwd') return fullDir(w.dir);
      return w.vars.has(key) ? w.vars.get(key) : null;
    }
    if (ref.tilde) {
      if (ref.tilde === '~+') return fullDir(w.dir);
      return ctx.taint.has('HOME') ? null : homedir();
    }
    const { name } = ref;
    if (ctx.taint.has(name) || (!ref.quoted && ctx.taint.has('IFS'))) return null;
    if (name === 'PWD') return fullDir(w.dir);
    if (POSIX_DYNAMIC.has(name)) return null;
    if (w.vars.has(name)) return w.vars.get(name);
    if (name === 'HOME') return envValue(ctx.env, 'HOME', false) ?? homedir();
    return envValue(ctx.env, name, false);
  };
}

// --- пути ---------------------------------------------------------------------------------

// Абсолютная форма значения: строка — путь; null — не вычислить; undefined — относительный.
// Git Bash (msys, POSIX под win32): `/c/…` — диск C:, прочие `/…` — каталоги самого Git
// (`/tmp` → %TEMP%, `/usr` → Program Files\Git\usr — проверено `cygpath -w`), `/c/..` — корень
// Git (ревью B3). PowerShell: `\x` — от корня диска текущего каталога. `C:x` (относительно
// каталога диска), `env:`/`HKLM:` (провайдеры) — не путь файла.
function absoluteForm(value, dir, ctx) {
  if (IS_WIN32) {
    if (/^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]/.test(value)) return value;
    if (/^[A-Za-z]:/.test(value)) return null;
    if (/^[\\/]/.test(value)) {
      if (ctx.ps) return isFullAbs(dir) ? resolvePath(dir, value) : null;
      const m = /^\/([A-Za-z])(\/.*)?$/.exec(value);
      if (!m || DOT_DOT_RE.test(value)) return null;
      return `${m[1].toUpperCase()}:${m[2] ?? '/'}`;
    }
    if (value.includes(':')) return null;
    return undefined;
  }
  if (value.startsWith('/')) return value;
  if (ctx.ps && value.includes(':')) return null;
  return undefined;
}

// Пути, в которые может уйти запись `value` из каталога `dir`; null — не вычислить.
// `..` после cd в junction/symlink: Git Bash разрешает физически (touch ../x и > ../x пишут
// рядом с ЦЕЛЬЮ ссылки), PowerShell — логически от строки каталога (проверено запуском) —
// для POSIX отдаются оба пути, ядро проверит каждый.
function resolveTarget(dir, value, ctx) {
  if (!value || /[\0\r\n]/.test(value)) return null;
  const abs = absoluteForm(value, dir, ctx);
  if (abs === null) return null;
  if (abs !== undefined) return [abs];
  if (dir === null) return null;
  if (dir === '') return [value];
  if (!isFullAbs(dir)) return [join(dir, value)];
  const logical = resolvePath(dir, value);
  if (ctx.ps || !DOT_DOT_RE.test(value)) return [logical];
  let physical;
  try {
    physical = resolvePath(realpathDeep(dir), value);
  } catch {
    return null;
  }
  return physical === logical ? [logical] : [logical, physical];
}

// Возможные каталоги после `cd <value>`; null — неизвестен. Не литерал (ревью B3, проверено
// запуском): `*?[]{}` (шаблон/brace; Set-Location — wildcard даже в '…'), бэктик, `-` в начале
// (`cd -`, опции), `~` из кавычек (POSIX).
//
// POSIX-относительный каталог без `./`/`../` bash ищет по CDPATH, а при `shopt -s cdable_vars`
// несуществующий каталог берёт из одноимённой переменной. Раунд 2 ревью C2 (2026-09-22):
// безусловный '?' отклонял частое `cd skills/coach && sed -i …` — теперь каталог неизвестен,
// только если CDPATH задан в окружении или присваивается в команде, в BASHOPTS есть
// cdable_vars или в команде есть shopt (проверено запуском: без CDPATH и при CDPATH=
// `cd sub` идёт в ./sub, при CDPATH=<dir> — в <dir>/sub; snapshot оболочки Claude Code на этой
// машине CDPATH и shopt пользователя не содержит).
//
// `..`: bash по умолчанию разрешает логически, а после `set -P`/`set -o physical` — физически
// (`cd ./lnk/..` уводит к родителю ЦЕЛИ ссылки, проверено запуском Git Bash). Если варианты
// различаются, возвращаются оба — запись проверяется в каждом (раунд 2 ревью C2, low).
// Раунд 3 ревью C2 (2026-09-22): аргумент с `+`/`-` в начале — не каталог, а запись стека
// (`pushd +1` вращает стек и уходит в каталог, который в нём лежал; после `pushd <область> &&
// pushd +1` bash стоит в исходном cwd, а трекер считал каталогом `<область>/+1` — регресс
// deny→allow). Проверено запуском bash 5.2: `pushd w && pushd +1` печатает исходный каталог,
// `pushd -- +1` — каталог `+1`; различать их трекер не будет, каталог неизвестен в обоих.
function cdTargets(dir, value, ctx) {
  if (!value || /[\0\r\n*?[\]{}`]/.test(value) || /^[-+]/.test(value)) return null;
  if (!ctx.ps && value.startsWith('~')) return null;
  const abs = absoluteForm(value, dir, ctx);
  if (abs === null) return null;
  if (abs === undefined) {
    if (!ctx.ps && !/^\.\.?(?:[\\/]|$)/.test(value) && cdSearchMayApply(ctx)) return null;
    if (dir === null) return null;
    if (!isFullAbs(dir)) return [join(dir, value)];
  }
  const logical = abs !== undefined ? resolvePath(abs) : resolvePath(dir, value);
  if (ctx.ps || !DOT_DOT_RE.test(value)) return [logical];
  try {
    let base = abs !== undefined ? parsePath(abs).root : dir;
    const rest = abs !== undefined ? abs.slice(base.length) : value;
    base = realpathDeep(base);
    for (const c of rest.split(/[\\/]+/)) {
      if (!c || c === '.') continue;
      base = c === '..' ? dirname(base) : realpathDeep(join(base, c));
    }
    const same = (a, b) => (IS_WIN32 ? a.toLowerCase() === b.toLowerCase() : a === b);
    return same(realpathDeep(logical), base) ? [logical] : [logical, base];
  } catch {
    return null;
  }
}

function cdSearchMayApply(ctx) {
  if (ctx.cdSearch || ctx.taintAll || ctx.shopt || ctx.taint.has('CDPATH')) return true;
  if ((envValue(ctx.env, 'CDPATH', false) ?? '') !== '') return true;
  return /(?:^|:)cdable_vars(?::|$)/.test(envValue(ctx.env, 'BASHOPTS', false) ?? '');
}

// Шаблон в пути записи: в каталоге — нет (может пройти через ссылку наружу); в последнем
// компоненте — только у удаления и не с `.`/`[` в начале (`.*` старые bash сводили к `..`).
// rm -rf и Remove-Item -Recurse -Force по шаблону удаляют саму junction, не содержимое цели
// (проверено запуском Git Bash и PowerShell 5.1).
function globOk(value, del) {
  const comps = value.split(/[\\/]+/).filter(Boolean);
  const last = comps[comps.length - 1] ?? '';
  const hasGlob = (c) => /[*?[]/.test(c);
  if (comps.slice(0, -1).some(hasGlob)) return false;
  if (!hasGlob(last)) return true;
  return Boolean(del) && !/^[.[]/.test(last);
}

// Цель записи: слово (раскрывается в мире) или литерал значения флага (`-tDIR`, `-Path:X`).
function addTarget(ctx, world, item) {
  if (!item || item.marker) {
    ctx.marker = true;
    return;
  }
  const w = item.world ?? world;
  let value;
  let glob = false;
  let brace = false;
  if (item.literal !== undefined) {
    value = item.literal;
    if (/[~$`]/.test(value)) {
      ctx.marker = true;
      return;
    }
    glob = /[*?[]/.test(value);
    brace = !ctx.ps && /[{}]/.test(value);
  } else {
    const r = expandWord(item.word, ctx.dialect, lookupFor(w, ctx));
    if (!r) {
      ctx.marker = true;
      return;
    }
    ({ value, glob, brace } = r);
  }
  if (!value || brace || (glob && !globOk(value, item.del))) {
    ctx.marker = true;
    return;
  }
  const paths = resolveTarget(w.dir, value, ctx);
  if (!paths) {
    ctx.marker = true;
    return;
  }
  for (const p of paths) ctx.out.add(p);
}

// --- классификация сегментов --------------------------------------------------------------

// «Плоская» команда: без подоболочек, фона, групп, условий, циклов, функций и алиасов — только
// в ней cd и присваивание трекаются (внутри `(…)`, `{…}`, if/for/while они условны или
// повторяются; ревью ЗАДАЧИ C: `(cd X && touch y)`, `for …; do cd …`).
function isFlat(scan, ctx) {
  if (STRUCTURAL_SEPS.has(scan.trailingSep)) return false;
  for (const seg of scan.segments) {
    if (STRUCTURAL_SEPS.has(seg.sepBefore)) return false;
    for (const cmd of seg.commands) {
      const v = cmd.tokens[0]?.value;
      if (ctx.ps) {
        if (v != null && PS_KEYWORDS.has(v.toLowerCase())) return false;
        if (cmd.tokens.some((t) => t.parts.some((p) => p.kind === 'subst' && /^@?\{/.test(p.raw)))) return false;
      } else if (v != null && POSIX_KEYWORDS.has(v)) {
        return false;
      }
    }
  }
  return true;
}

function startsLoop(seg, ctx) {
  return seg.commands.some((cmd) => {
    const v = cmd.tokens[0]?.value;
    if (!ctx.ps) return v != null && POSIX_LOOP_START.has(v);
    if (v != null && PS_LOOP_START.has(v.toLowerCase())) return true;
    return cmd.tokens.some((t) => t.parts.some((p) => p.kind === 'subst' && /^@?\{/.test(p.raw)));
  });
}

// Ровно `cd|pushd <каталог>` (POSIX, допустим `--`) или `cd|chdir|sl|Set-Location|pushd|
// Push-Location [-Path|-LiteralPath] <каталог>` (PowerShell), без редиректов.
function cdForm(words, redirects, ctx) {
  if (redirects.length > 0 || words.length < 2 || words.length > 3) return null;
  const name = words[0].value;
  if (name === null) return null;
  if (ctx.ps) {
    if (!CD_PS.has(name.toLowerCase())) return null;
    if (words.length === 3 && (!words[1].psParam || !['-path', '-literalpath'].includes((words[1].value ?? '').toLowerCase()))) return null;
    // `cd @p` — сплаттинг: каталог из хэш-таблицы (раунд 2 ревью C2)
    if (words[words.length - 1].psParam || /^[@,]/.test(words[words.length - 1].text)) return null;
  } else {
    if (!CD_POSIX.has(name)) return null;
    if (words.length === 3 && words[1].value !== '--') return null;
  }
  const arg = words[words.length - 1];
  if (words.length === 2 && arg.value !== null && arg.value.startsWith('-')) return null;
  return arg;
}

// `NAME=value …` целиком или `export|declare|typeset|readonly NAME=value|NAME …` (без флагов).
// `local` вне функции — ошибка bash без присваивания (проверено запуском) — не трекается.
function posixAssignForm(cmd, words) {
  if (words.length === 0) return null;
  const first = words[0].value;
  const declarer = first === 'export' || first === 'declare' || first === 'typeset' || first === 'readonly';
  if (declarer && words.length === 1) return null;
  const pairs = [];
  for (let i = declarer ? 1 : 0; i < words.length; i += 1) {
    const w = words[i];
    const p0 = w.parts[0];
    const m = p0 && p0.kind === 'bare' ? ASSIGN_WORD_RE.exec(p0.raw) : null;
    if (m) {
      if (m[2] || POSIX_NEVER_TRACK.has(m[1])) return null;
      pairs.push({ name: m[1], env: false, word: wordAfterPrefix(w, m[0].length, cmd) ?? EMPTY_WORD });
      continue;
    }
    if (declarer && w.value !== null && NAME_RE.test(w.value) && !POSIX_NEVER_TRACK.has(w.value)) {
      pairs.push({ name: w.value, env: false, word: null });
      continue;
    }
    return null;
  }
  return { pairs, readonly: first === 'readonly' };
}

// `$NAME = '<литерал>'` / `"…"` (раскрытие известных переменных допустимо) целиком.
function psAssignForm(cmd, redirects) {
  if (redirects.length > 0) return null;
  const m = PS_TRACK_ASSIGN_RE.exec(cmd.text);
  if (!m) return null;
  const scope = (m[1] ?? '').toLowerCase();
  const name = m[2].toLowerCase();
  if (scope !== 'env' && PS_NEVER_TRACK.has(name)) return null;
  const rhs = scanCommand(cmd.text.slice(m[0].length), 'powershell');
  if (!rhs.ok || rhs.segments.length !== 1 || rhs.segments[0].commands.length !== 1) return null;
  const rc = rhs.segments[0].commands[0];
  if (rc.tokens.length !== 1 || rc.heredocs.length > 0) return null;
  const t = rc.tokens[0];
  if (t.parts.length !== 1 || (t.parts[0].kind !== 'single' && t.parts[0].kind !== 'double')) return null;
  return { pairs: [{ name, env: scope === 'env', word: t }], readonly: false };
}

const OTHER = Object.freeze({ kind: 'other' });

function classify(seg, ctx, { flat, afterHeredoc, nextSep, top }) {
  // cd после heredoc — каталог неизвестен (ЗАДАЧА C2): граница тела heredoc — место, где
  // разбор чаще всего расходится с shell'ом.
  if (!flat || afterHeredoc || seg.commands.length !== 1) return OTHER;
  if (nextSep !== null && !CHAIN_SEPS.has(nextSep)) return OTHER;
  const cmd = seg.commands[0];
  if (cmd.heredocs.length > 0) return OTHER;
  const { words, redirects } = ctx.split(cmd);
  const dirWord = cdForm(words, redirects, ctx);
  if (dirWord) return { kind: 'cd', cmd, dirWord };
  if (!top) return OTHER; // вложенный скрипт: POSIX — подоболочка, PowerShell — консервативно
  const a = ctx.ps ? psAssignForm(cmd, redirects) : posixAssignForm(cmd, words);
  return a ? { kind: 'assign', cmd, ...a } : OTHER;
}

// --- обход --------------------------------------------------------------------------------

function unknownResult(ctx, worlds) {
  ctx.marker = true;
  return { worlds: worlds.map((w) => ({ ...w, dir: null })), dirChanged: true };
}

function walk(text, ctx, worlds, depth) {
  ctx.budget -= 1;
  if (depth > MAX_NESTED || ctx.budget < 0) return unknownResult(ctx, worlds);
  const scan = ctx.scan(text);
  // Сканер не разобрал (незакрытые кавычки/подстановки/heredoc) — shell мог выполнить что угодно.
  if (!scan.ok) return unknownResult(ctx, worlds);
  const info = ctx.info(text);
  const flat = isFlat(scan, ctx);
  const segs = scan.segments;
  let afterHeredoc = false;
  let dirChanged = false;
  for (let idx = 0; idx < segs.length; idx += 1) {
    const seg = segs[idx];
    const nextSep = idx + 1 < segs.length ? segs[idx + 1].sepBefore : scan.trailingSep;
    // Цикл/функция/scriptblock: тело выполняется повторно или позже — смена каталога в нём
    // действует и на записи, стоящие в тексте раньше неё.
    if (!flat && info.dirChange && startsLoop(seg, ctx)) worlds = worlds.map((w) => ({ ...w, dir: null }));
    const cls = classify(seg, ctx, { flat, afterHeredoc, nextSep, top: depth === 0 });
    let running = worlds;
    let skipped = [];
    if (flat && seg.sepBefore === '&&') {
      running = worlds.filter((w) => w.st !== 'F');
      skipped = worlds.filter((w) => w.st !== 'S').map((w) => ({ ...w, st: 'F' }));
    } else if (flat && seg.sepBefore === '||') {
      running = worlds.filter((w) => w.st !== 'S');
      skipped = worlds.filter((w) => w.st !== 'F').map((w) => ({ ...w, st: 'S' }));
    }
    const outcomes = [];
    for (const w of running) {
      const r = runSegment(seg, cls, w, ctx, depth);
      if (r.dirChanged) dirChanged = true;
      outcomes.push(...r.worlds);
    }
    worlds = mergeWorlds([...outcomes, ...skipped]);
    if (seg.commands.some((c) => c.heredocs.length > 0)) afterHeredoc = true;
  }
  if (ctx.taintPass && dirChanged) info.dirChange = true;
  return { worlds, dirChanged };
}

function runSegment(seg, cls, w, ctx, depth) {
  if (cls.kind === 'cd') {
    const io = commandIO(cls.cmd, w, ctx, depth);
    if (ctx.taintPass) return { worlds: [{ ...io.world, st: '?' }], dirChanged: true };
    const r = expandWord(cls.dirWord, ctx.dialect, lookupFor(io.world, ctx));
    const dirs = (r && !r.glob && !r.brace ? cdTargets(io.world.dir, r.value, ctx) : null) ?? [null];
    return { worlds: [...dirs.map((dir) => ({ ...io.world, dir, st: 'S' })), { ...io.world, st: 'F' }], dirChanged: true };
  }
  if (cls.kind === 'assign') {
    const io = commandIO(cls.cmd, w, ctx, depth);
    if (ctx.taintPass) {
      for (const p of cls.pairs) {
        const key = ctx.ps && p.env ? `env:${p.name}` : p.name;
        ctx.tracked.set(key, (ctx.tracked.get(key) ?? 0) + 1);
        if (cls.readonly) ctx.readonlyNames.add(key);
      }
      return { worlds: [{ ...io.world, st: '?' }], dirChanged: io.changed };
    }
    const next = { ...io.world, vars: new Map(io.world.vars), envv: new Map(io.world.envv) };
    let st = 'S';
    for (const p of cls.pairs) {
      if (!p.word) continue; // `export NAME` — значение не меняется
      const r = expandWord(p.word, ctx.dialect, lookupFor(next, ctx), { assignment: true });
      if (p.word.hasSubstitution) st = '?'; // статус присваивания — статус подстановки
      (p.env ? next.envv : next.vars).set(p.name, r ? r.value : null);
    }
    return { worlds: [{ ...next, st }], dirChanged: io.changed };
  }
  let world = w;
  let changed = false;
  for (const cmd of seg.commands) {
    const r = analyzeCommand(cmd, world, ctx, depth, seg);
    world = r.world;
    if (r.dirChanged) changed = true;
  }
  return { worlds: [{ ...world, st: '?' }], dirChanged: changed };
}

// Вложенные скрипты (подстановки, тела heredoc) и редиректы простой команды.
function commandIO(cmd, w, ctx, depth) {
  const { words, redirects } = ctx.split(cmd);
  let world = w;
  let changed = false;
  const sources = [...words, ...redirects.map((r) => r.target).filter(Boolean), ...cmd.heredocs];
  for (const src of sources) {
    const nested = nestedScripts(src, ctx.dialect);
    if (nested.opaque) ctx.marker = true;
    if (ctx.taintPass) {
      for (const b of nested.braces) for (const m of b.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) taintName(ctx, m[0]);
    }
    for (const script of nested.scripts) {
      const r = walk(script, ctx, [world], depth + 1);
      // POSIX $(…) — подоболочка, но смену каталога в ней считаем неизвестностью (консервативно);
      // PowerShell $(…)/(…)/& {…} меняют каталог сессии (проверено запуском).
      if (r.dirChanged) {
        world = { ...world, dir: null };
        changed = true;
      }
    }
  }
  if (!ctx.taintPass) for (const r of redirects) redirectWrite(r, world, ctx);
  return { world, changed, words, redirects };
}

function redirectWrite(r, world, ctx) {
  const { op } = r;
  // `<<<` — here-string: ввод из слова, не запись (раунд 3 ревью C2, 2026-09-22)
  if (op === '<' || op === '<&' || op === '<<' || op === '<<-' || op === '<<<') return;
  if (!r.target) {
    ctx.marker = true;
    return;
  }
  if (op === '>&') {
    // `>&2`, `2>&1`, `>&-` — дескриптор; иное слово — файл (bash: `>&f` и `1>&f` создают f,
    // проверено запуском; ревью B2 round 3: `status >&<root>/PWNED.txt` проходил как allow).
    const x = expandWord(r.target, ctx.dialect, lookupFor(world, ctx));
    if (x && /^(?:\d+|-)$/.test(x.value)) return;
  }
  if (isNullTarget(r.target, world, ctx)) return;
  addTarget(ctx, world, { word: r.target });
}

// Псевдоустройства — не запись: /dev/null, /dev/stdout, /dev/stderr, NUL (POSIX, как в HEAD);
// PowerShell — $null и NUL (там `/dev/null` — обычный путь от корня диска).
function isNullTarget(word, world, ctx) {
  if (ctx.ps) return word.text.toLowerCase() === '$null' || (word.value ?? '').toLowerCase() === 'nul';
  const x = expandWord(word, 'posix', lookupFor(world, ctx));
  if (!x) return false;
  return x.value === '/dev/null' || x.value === '/dev/stdout' || x.value === '/dev/stderr' || x.value.toLowerCase() === 'nul';
}

function commandName(v, ctx) {
  let n = v.replace(/^.*[\\/]/, '');
  // Windows: регистр имени и расширение не важны (`TOUCH x`, `Touch.exe x` в Git Bash создают
  // файл — проверено запуском).
  if (ctx.ps || IS_WIN32) n = n.toLowerCase().replace(/\.(?:exe|com|cmd|bat)$/, '');
  return n;
}

function isAssignWord(w) {
  const p0 = w.parts[0];
  return Boolean(p0 && p0.kind === 'bare' && (ASSIGN_WORD_RE.test(p0.raw) || ARRAY_ASSIGN_RE.test(w.text)));
}

// Имя команды и её аргументы. kind: 'cmd' | 'none' (только присваивания/редиректы/выражение) |
// 'unknown' (имя — не литерал: `$CMD x`, `"$(which rm)" x`, `& $script`) | 'ps-assign'.
function commandInfo(words, cmd, seg, ctx) {
  if (ctx.ps) return psCommandInfo(words, cmd, seg, ctx);
  let i = 0;
  while (i < words.length && isAssignWord(words[i])) i += 1;
  let chdir = false;
  let appends = false;
  while (i < words.length) {
    const v = words[i].value;
    if (v === null) return { kind: 'unknown' };
    const name = commandName(v, ctx);
    const wr = Object.hasOwn(WRAPPERS, name) ? WRAPPERS[name] : null;
    if (!wr) return { kind: 'cmd', name, args: words.slice(i + 1), chdir, appends };
    if (wr.appends) appends = true;
    i += 1;
    if (wr.skipName && i < words.length) {
      // `function f { … }` — `f` любое слово (bash допускает дефисы); `coproc NAME { … }` —
      // имя корутины только перед составной командой
      if (words[i].value === null) return { kind: 'unknown' };
      const next = words[i + 1]?.value ?? null;
      if (wr.skipName === 'always' ? !POSIX_COMPOUND_START.has(words[i].value) : next !== null && POSIX_COMPOUND_START.has(next)) i += 1;
    }
    let positional = wr.positional ?? 0;
    while (i < words.length) {
      const a = words[i].value;
      if (a === null) break;
      if (a === '--') {
        i += 1;
        break;
      }
      if (a.startsWith('-') && a.length > 1) {
        const eq = a.indexOf('=');
        const flag = eq === -1 ? a : a.slice(0, eq);
        const short = !a.startsWith('--') && a.length > 2 ? a.slice(0, 2) : null;
        if (wr.chdir && (wr.chdir.includes(flag) || (short && wr.chdir.includes(short)))) chdir = true;
        if (name === 'env' && (flag === '-S' || flag === '--split-string' || short === '-S')) return { kind: 'unknown' };
        if (eq === -1 && !short && wr.value?.includes(flag)) i += 1;
        i += 1;
        continue;
      }
      if (wr.assigns && a.includes('=')) {
        i += 1;
        continue;
      }
      if (positional > 0) {
        positional -= 1;
        i += 1;
        continue;
      }
      break;
    }
  }
  return { kind: 'none' };
}

function psCommandInfo(words, cmd, seg, ctx) {
  const m = PS_ASSIGN_STMT_RE.exec(cmd.text);
  if (m) {
    const names = [...m[0].matchAll(/\$(?:\{(?:(\w+):)?([^}]*)\}|(?:(\w+):)?(\w+))/g)].map((x) => ({
      name: x[2] ?? x[4],
      env: (x[1] ?? x[3] ?? '').toLowerCase() === 'env',
    }));
    return { kind: 'ps-assign', names, rhs: cmd.text.slice(m[0].length) };
  }
  const first = words[0];
  if (!first) return { kind: 'none' };
  const p0 = first.parts[0];
  if (p0.kind !== 'bare' || /^[$[(@\d]/.test(p0.raw)) {
    // выражение (`$x.Delete()`, `'a' > f`, `(…)`) — не вызов; `& $x …` — вызов неизвестного
    if (seg.sepBefore === '&' && seg.commands[0] === cmd) return { kind: 'unknown' };
    return { kind: 'none' };
  }
  if (first.value === null) return { kind: 'unknown' };
  const name = commandName(first.value, ctx);
  // Скрипт .ps1 и программа по пути: скрипт выполняется в этой же сессии и может сменить
  // каталог и глобальные переменные.
  const script = /[\\/]/.test(first.value) || /\.ps1$/i.test(first.value);
  return { kind: 'cmd', name: PS_ALIASES[name] ?? name, args: words.slice(1), chdir: false, appends: false, script };
}

// Первый проход: имена, которым команда присваивает не трекаемо.
function taintWords(ctx, words, name, args, arithText) {
  for (const w of words) {
    const raw = w.parts.map((p) => p.raw).join(' ');
    if (ctx.ps) {
      for (const m of raw.matchAll(/\[ref\]\s*\$(?:(\w+):)?(\w+)/gi)) taintName(ctx, m[2], (m[1] ?? '').toLowerCase() === 'env');
      for (const m of raw.matchAll(/(?:\+\+|--)\s*\$(?:(\w+):)?(\w+)|\$(?:(\w+):)?(\w+)\s*(?:\+\+|--)/g)) {
        taintName(ctx, m[2] ?? m[4], (m[1] ?? m[3] ?? '').toLowerCase() === 'env');
      }
      // `foreach ($S in …)` — переменная цикла остаётся после цикла (проверено запуском PS 5.1)
      for (const m of raw.matchAll(/\$(?:(\w+):)?(\w+)\s+in\b/gi)) taintName(ctx, m[2], (m[1] ?? '').toLowerCase() === 'env');
      // Присваивание через провайдер/API или умолчания параметров (`*:OutVariable`) — всё неизвестно
      if (/variable:|psvariable|sessionstate|executioncontext|psdefaultparametervalues/i.test(raw)) ctx.taintAll = true;
      continue;
    }
    const lead = w.value ?? (w.parts[0]?.kind === 'bare' ? w.parts[0].raw : '');
    if (NAME_RE.test(lead)) ctx.taint.add(lead); // read S, for S in, unset S, (( S = 1 ))
    for (const m of raw.matchAll(ASSIGNISH_RE)) ctx.taint.add(m[1] ?? m[2] ?? m[3]);
    // `S[0]=…`, `(( S[i] = 1 ))` — элемент массива: `$S` — это `${S[0]}` (раунд 2 ревью C2)
    for (const m of raw.matchAll(ARRAY_REF_RE)) ctx.taint.add(m[1]);
  }
  if (ctx.ps) {
    // -OutVariable x, -ov:x, -Variable x (Tee-Object) — присваивают переменной
    for (let i = 0; i < words.length; i += 1) {
      const w = words[i];
      if (!w.psParam) continue;
      const colon = w.text.indexOf(':');
      const pname = (colon === -1 ? w.text.slice(1) : w.text.slice(1, colon)).toLowerCase();
      if (!PS_OUTVAR_PARAMS.has(pname) && !PS_OUTVAR_FULL.some((n) => n.startsWith(pname))) continue;
      const val = colon === -1 ? words[i + 1]?.value : w.value?.slice(w.value.indexOf(':') + 1);
      if (typeof val !== 'string' || !val) ctx.taintAll = true;
      else taintName(ctx, val.replace(/^\+/, ''));
    }
    return;
  }
  // Имя присваивания из подстановки в арифметике — `(( $n = 5 ))`, `$(( x=1, $n=5 ))`,
  // `let "x=1, $n=1"`: bash присваивает переменной, имя которой в $n (раунд 2 ревью C2,
  // проверено запуском) — неизвестны все. arithText — текст команды в `(…)` или `let`.
  if (!POSIX_TESTS.has(name ?? '') && DYN_ASSIGN_RE.test(arithText ?? '')) ctx.taintAll = true;
  if (!name) return;
  if (name === 'shopt') ctx.shopt = true; // cdable_vars и т.п. — см. cdTargets
  if (POSIX_ASSIGNING.has(name)) {
    for (const w of args) {
      const raw = w.parts.map((p) => p.raw).join(' ');
      for (const m of raw.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
        for (let k = 0; k < m[0].length; k += 1) if (/[A-Za-z_]/.test(m[0][k])) ctx.taint.add(m[0].slice(k)); // printf -vS
      }
    }
    if (dynamicAssignName(name, args)) ctx.taintAll = true;
  }
  // declare -n / local -n — ссылка на имя: присваивание ей меняет другую переменную
  if (POSIX_DECLARERS.has(name) && args.some((w) => /^-[A-Za-z]*n/.test(w.value ?? ''))) ctx.taintAll = true;
}

// Имя переменной, которой присваивает встроенная, — из подстановки: `declare|export "$n=…"`,
// `read -r "$n"`, `printf -v "$n"`, `unset "$n"` (раунд 2 ревью C2: трекер считал `$S`
// прежним, bash уже переписал её — проверено запуском). Имя — текст до `=` (declare/let) или
// всё слово; для printf — значение -v, для wait — только с -p, compgen — только с -V.
function dynamicAssignName(name, args) {
  const dyn = (t) => t === undefined || /[$`]/.test(t);
  if (name === 'printf') {
    return args.some((w, i) => w.text.startsWith('-v') && dyn(w.text === '-v' ? args[i + 1]?.text : w.text.slice(2)));
  }
  if (name === 'wait' && !args.some((w) => /^-[A-Za-z]*p/.test(w.text))) return false;
  if (name === 'compgen' && !args.some((w) => /^-[A-Za-z]*V/.test(w.text))) return false;
  const byEq = POSIX_DECLARERS.has(name) || name === 'let';
  return args.some((w) => {
    const eq = byEq ? w.text.indexOf('=') : -1;
    return dyn(eq === -1 ? w.text : w.text.slice(0, eq));
  });
}

function analyzeCommand(cmd, w, ctx, depth, seg) {
  const io = commandIO(cmd, w, ctx, depth);
  let world = io.world;
  let changed = io.changed;
  const ci = commandInfo(io.words, cmd, seg, ctx);
  if (ctx.taintPass) {
    // `((…))`/`$((…))` сканер отдаёт сегментом после `(` — арифметика или подоболочка
    const arith = (seg?.sepBefore === '(' && seg.commands[0] === cmd) || ci.name === 'let';
    taintWords(ctx, io.words, ci.kind === 'cmd' ? ci.name : null, ci.args ?? [], arith ? cmd.text : null);
  }
  if (!ctx.taintPass && ctx.ps && PS_DOTNET_WRITE_RE.test(cmd.text)) ctx.marker = true;
  if (ci.kind === 'none') return { world, dirChanged: changed };
  if (ci.kind === 'unknown') {
    if (ctx.taintPass) ctx.taintAll = true;
    else ctx.marker = true;
    return { world: { ...world, dir: null }, dirChanged: true };
  }
  if (ci.kind === 'ps-assign') {
    // `$x = <команда>` — правая часть выполняется как команда; $x — неизвестна
    if (ctx.taintPass) for (const n of ci.names) taintName(ctx, n.name, n.env);
    const r = walk(ci.rhs, ctx, [world], depth + 1);
    if (r.dirChanged) {
      world = { ...world, dir: null };
      changed = true;
    }
    return { world, dirChanged: changed };
  }
  const { name } = ci;
  if (EVAL_NAMES.has(name) && (name === 'eval') !== ctx.ps) {
    // eval/iex строки-литерала — та же команда, разбираем её; иначе — неизвестно что
    const args = ctx.ps && /^-c/i.test(ci.args[0]?.value ?? '') ? ci.args.slice(1) : ci.args;
    if (args.length > 0 && args.every((a) => a.value !== null)) walk(args.map((a) => a.value).join(' '), ctx, [world], depth + 1);
    else if (!ctx.taintPass) ctx.marker = true;
  }
  // `trap '<скрипт>' SIG` — скрипт выполнится позже (EXIT — в конце, DEBUG — перед каждой
  // командой), в неизвестном каталоге и с неизвестными значениями переменных. Раунд 3 ревью C2
  // (2026-09-22): текст скрипта не разбирался вовсе, и `trap 'touch <вне области>' EXIT`
  // проходил как allow (проверено запуском bash 5.2: файл создаётся).
  if (!ctx.ps && name === 'trap') {
    const later = { ...world, dir: null, lost: true };
    for (const a of ci.args) {
      if (a.value === null) {
        if (!ctx.taintPass) ctx.marker = true;
        continue;
      }
      walk(a.value, ctx, [later], depth + 1);
    }
  }
  const opaque = (ctx.ps ? OPAQUE_PS : OPAQUE_POSIX).has(name) || ci.script === true;
  if (opaque && ctx.taintPass) ctx.taintAll = true;
  if (opaque || (ctx.ps ? DIR_CHANGERS_PS : DIR_CHANGERS_POSIX).has(name)) {
    world = { ...world, dir: null };
    changed = true;
  }
  if (!ctx.taintPass) {
    const w2 = ci.chdir ? { ...world, dir: null } : world;
    commandWrites(name, ci, w2, ctx);
    // текст скрипта — после раскрытия внешним shell'ом (`bash -c "touch $D/f"`)
    nestedShellWrites(name, resolveArgs(ctx.ps ? ci.args.map((a) => a.orig ?? a) : ci.args, w2, ctx), w2, ctx, cmd);
  }
  return { world, dirChanged: changed };
}

// --- цели команд записи -------------------------------------------------------------------

// Длинный флаг GNU: точное имя или однозначный префикс имени из `names` (`--t` → `--target-directory`).
function longFlag(flag, names) {
  if (names.includes(flag)) return flag;
  const hits = flag.length > 2 ? names.filter((n) => n.startsWith('--') && n.startsWith(flag)) : [];
  return hits.length === 1 ? hits[0] : null;
}

// Позиционные аргументы POSIX-команды и значения её флагов со значением (`-t DIR`, `-tDIR`,
// `-vt DIR`, `--target-directory=DIR`).
function posixArgs(args, valueFlags) {
  const pos = [];
  const vals = [];
  const afterEnd = new Set(); // позиционные после `--` — флагом стать не могут
  let end = false;
  for (let i = 0; i < args.length; i += 1) {
    const w = args[i];
    const v = w.value;
    if (!end && v === '--') {
      end = true;
      continue;
    }
    if (end || v === null || !v.startsWith('-') || v.length === 1) {
      pos.push(w);
      if (end) afterEnd.add(w);
      continue;
    }
    if (v.startsWith('--')) {
      const eq = v.indexOf('=');
      const flag = longFlag(eq === -1 ? v : v.slice(0, eq), valueFlags);
      if (!flag) continue;
      if (eq !== -1) vals.push({ flag, item: { literal: v.slice(eq + 1) } });
      else {
        vals.push({ flag, item: args[i + 1] ? { word: args[i + 1] } : MARKER_ITEM });
        i += 1;
      }
      continue;
    }
    for (let k = 1; k < v.length; k += 1) {
      const flag = `-${v[k]}`;
      if (!valueFlags.includes(flag)) continue;
      if (k + 1 < v.length) vals.push({ flag, item: { literal: v.slice(k + 1) } });
      else {
        vals.push({ flag, item: args[i + 1] ? { word: args[i + 1] } : MARKER_ITEM });
        i += 1;
      }
      break;
    }
  }
  return { pos, vals, afterEnd };
}

const SED_LONG = ['--in-place', '--expression', '--file', '--line-length'];

// Слово, которое после раскрытия может оказаться флагом или распасться на несколько слов:
// значение не вычислено, и начало не литерал либо есть незакавыченное раскрытие/подстановка
// (`cp "$o" a b` при o=--target-directory=/x копирует в /x). Раунд 2 ревью C2, 2026-09-22.
function mayBeFlag(w) {
  if (w.value !== null) return w.value.startsWith('-');
  if (w.parts.some((p) => (p.kind === 'bare' && p.hasExpansion) || p.kind === 'subst')) return true;
  const p0 = w.parts[0];
  const lead = p0.kind === 'double' || p0.kind === 'bare' ? p0.raw : p0.value;
  return !lead || /^[-$`\\]/.test(lead);
}

// Файлы `sed -i`: `-i[SUF]`/`--in-place[=SUF]` в любом кластере коротких флагов (`-ni`);
// скрипт — `-e X`/`-f X`/`--expression`/`--file` или первый позиционный. Без -i — не запись;
// невычисленное слово, которое может быть флагом (`sed "$o" s/a/b/ f`), — '?'.
function sedFiles(args) {
  let inPlace = false;
  let script = false;
  let end = false;
  let unknown = false;
  const files = [];
  for (let i = 0; i < args.length; i += 1) {
    const w = args[i];
    const v = w.value;
    if (!end && v === '--') {
      end = true;
      continue;
    }
    if (!end && v === null && mayBeFlag(w)) unknown = true;
    if (!end && v !== null && v.startsWith('--')) {
      // `sed --in s/a/b/ f` правит f (раунд 2 ревью C2: префиксы длинных флагов, проверено запуском)
      const flag = longFlag(v.split('=')[0], SED_LONG) ?? v;
      if (flag === '--in-place') inPlace = true;
      else if (flag === '--expression' || flag === '--file') {
        script = true;
        if (!v.includes('=')) i += 1;
      } else if (flag === '--line-length' && !v.includes('=')) i += 1;
      continue;
    }
    if (!end && v !== null && v.startsWith('-') && v.length > 1) {
      for (let k = 1; k < v.length; k += 1) {
        const c = v[k];
        if (c === 'i') {
          inPlace = true;
          break;
        }
        if (c === 'e' || c === 'f' || c === 'l') {
          if (c !== 'l') script = true;
          if (k === v.length - 1) i += 1;
          break;
        }
      }
      continue;
    }
    if (!script) {
      script = true;
      continue;
    }
    files.push(w);
  }
  if (!inPlace) return unknown ? [] : null;
  return files;
}

// Тесты find со значением: следующее слово — их аргумент, не действие (`-name -delete` не удаляет).
const FIND_VALUE_TESTS = new Set(['-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex', '-lname', '-ilname', '-type', '-xtype', '-user', '-group', '-uid', '-gid', '-perm', '-size', '-links', '-inum', '-samefile', '-newer', '-anewer', '-cnewer', '-used', '-mtime', '-mmin', '-atime', '-amin', '-ctime', '-cmin', '-maxdepth', '-mindepth', '-fstype', '-context', '-printf', '-regextype', '-files0-from']);

// find: `-delete` удаляет под стартовыми точками; `-fprint* FILE` пишет FILE; `-exec[dir]/-ok[dir]
// CMD … ;|+` — команда, `{}` — найденный путь (лежит под стартовой точкой). Невычисленное слово,
// которое может быть флагом (`find "$X"` при X=-delete), — '?' (раунд 2 ревью C2).
function findTargets(args, world, ctx) {
  let i = 0;
  while (i < args.length) {
    const v = args[i].value;
    if (v === '-H' || v === '-L' || v === '-P' || (v !== null && /^-O\d*$/.test(v))) i += 1;
    else if (v === '-D') i += 2;
    else break;
  }
  const items = [];
  const starts = [];
  while (i < args.length) {
    const v = args[i].value;
    if (v !== null && (v.startsWith('-') || v === '(' || v === '!' || v === ')' || v === ',')) break;
    if (v === null && mayBeFlag(args[i])) items.push(MARKER_ITEM);
    starts.push(args[i]);
    i += 1;
  }
  const startItems = starts.length > 0 ? starts.map((w) => ({ word: w, del: true })) : [{ literal: '.', del: true }];
  for (; i < args.length; i += 1) {
    const v = args[i].value;
    if (v === null) {
      if (mayBeFlag(args[i])) items.push(MARKER_ITEM);
    } else if (FIND_VALUE_TESTS.has(v)) i += 1;
    else if (v === '-delete') items.push(...startItems);
    else if (v === '-fprint' || v === '-fprint0' || v === '-fls' || v === '-fprintf') {
      items.push(args[i + 1] ? { word: args[i + 1] } : MARKER_ITEM);
      i += v === '-fprintf' ? 2 : 1;
    } else if (v === '-exec' || v === '-execdir' || v === '-ok' || v === '-okdir') {
      const sub = [];
      let j = i + 1;
      while (j < args.length && args[j].value !== ';' && args[j].value !== '+') sub.push(args[j++]);
      i = j;
      const ci = commandInfo(sub, null, null, ctx);
      if (ci.kind === 'unknown') {
        items.push(MARKER_ITEM);
        continue;
      }
      if (ci.kind !== 'cmd') continue;
      nestedShellWrites(ci.name, ci.args, v.endsWith('dir') ? { ...world, dir: null } : world, ctx, null);
      const inner = commandTargets(ci.name, ci.args, world, ctx) ?? [];
      if (inner.length > 0 && ci.appends) items.push(MARKER_ITEM);
      for (const it of inner) {
        if (it.marker || !it.word) items.push(it);
        else if (it.word.value === '{}') items.push(...startItems);
        else if (it.word.text.includes('{}')) items.push(MARKER_ITEM);
        // -execdir: команда выполняется в каталоге найденного файла — относительный путь неизвестен
        else items.push(v.endsWith('dir') ? { ...it, world: { ...world, dir: null } } : it);
      }
    }
  }
  return items;
}

// dd: `of=FILE` — запись; операнды — только `ключ=значение`, невычисленный операнд может
// оказаться `of=…` — '?'.
function ddTargets(args) {
  const items = [];
  for (const w of args) {
    const v = w.value;
    if (v !== null) {
      if (v.startsWith('of=')) items.push(v.length > 3 ? { literal: v.slice(3) } : MARKER_ITEM);
      continue;
    }
    const p0 = w.parts[0];
    const lead = p0 && p0.kind === 'bare' && !p0.hasExpansion ? /^([a-z]+)=/.exec(p0.raw) : null;
    if (!lead || lead[1] === 'of') items.push(MARKER_ITEM);
  }
  return items.length > 0 ? items : null;
}

// Вложенный интерпретатор (low из ревью раунда 2 C2, 2026-09-22: HEAD и первая версия записи
// внутри не видели): `bash|sh -c '<скрипт>'`, `powershell|pwsh -Command <скрипт>`,
// `-EncodedCommand <base64>`, `cmd /c …`. Это отдельный процесс: каталог — текущий,
// переменные — только экспортированные, поэтому скрипт разбирается тем же detectShellWrites с
// пустым окружением (любая переменная окружения — неизвестна, '?'). Не литерал — '?'.
const POSIX_SHELLS = new Set(['bash', 'sh', 'dash', 'zsh', 'ksh']);
const PS_SHELLS = new Set(['powershell', 'pwsh']);
const PS_HOST_SWITCHES = ['noprofile', 'nologo', 'noninteractive', 'noexit', 'sta', 'mta', 'login', 'nop'];
const PS_HOST_VALUES = ['executionpolicy', 'windowstyle', 'outputformat', 'inputformat', 'configurationname', 'psconsolefile', 'version', 'ep'];
const CMD_WRITE_RE = /[<>]|(?:^|[\s&|(@])(?:del|erase|rd|rmdir|copy|xcopy|robocopy|move|ren|rename|md|mkdir|mklink|replace|attrib|icacls|takeown|format|powershell|pwsh|bash|sh|start|call)(?:\.exe)?(?=$|[\s&|)"'])/i;

function nestedShellWrites(name, args, world, ctx, cmd) {
  const run = (script, dialect) => {
    const dir = world.dir;
    // окружение дочернего процесса — окружение хука без имён, которые команда присваивает
    // (экспортированы ли они — неизвестно); cdSearch — CDPATH/cdable_vars могли измениться
    const drop = (k) => [k, k.toLowerCase(), `env:${k.toLowerCase()}`].some((n) => ctx.tracked.has(n) || ctx.taint.has(n));
    const env = ctx.taintAll ? {} : Object.fromEntries(Object.entries(ctx.env).filter(([k]) => !drop(k)));
    ctx.shared.runs += 1;
    if (ctx.shared.runs > MAX_NESTED_RUNS) {
      ctx.marker = true;
      return;
    }
    const res = detectAt(script, { cwd: dir ?? '', env, dialect }, ctx.level + 1, cdSearchMayApply(ctx), ctx.shared);
    for (const r of res) {
      if (r === MARK || (dir === null && !isFullAbs(r))) ctx.marker = true;
      else ctx.out.add(r);
    }
  };
  if (POSIX_SHELLS.has(name)) {
    let c = false;
    let stdin = false;
    let end = false;
    for (let i = 0; i < args.length; i += 1) {
      const v = args[i].value;
      if (v === null) {
        if (c || (!end && mayBeFlag(args[i]))) ctx.marker = true;
        return;
      }
      if (!end && (v === '--' || v === '-')) {
        end = true;
        continue;
      }
      if (!end && /^[-+]/.test(v)) {
        if (v.startsWith('--')) {
          if (v === '--version' || v === '--help') return;
          if (v === '--rcfile' || v === '--init-file') i += 1;
          continue;
        }
        if (v.slice(1).includes('c')) c = true;
        if (v.slice(1).includes('s')) stdin = true;
        if (/[oO]$/.test(v)) i += 1;
        continue;
      }
      if (c) {
        run(v, 'posix');
        return;
      }
      if (stdin) break; // `bash -s арг…` — скрипт из stdin, операнды — его аргументы
      return; // иначе — файл скрипта: содержимое не разбирается (как и до ЗАДАЧИ C2)
    }
    if (c) return; // -c без скрипта — ошибка bash
    // Скрипт из stdin: тело heredoc разбирается; пайп, `< файл` — неизвестно что
    const docs = cmd?.heredocs ?? [];
    if (docs.length === 0) ctx.marker = true;
    for (const d of docs) {
      if (d.value === null) ctx.marker = true;
      else run(d.value, 'posix');
    }
    return;
  }
  if (PS_SHELLS.has(name)) {
    for (let i = 0; i < args.length; i += 1) {
      const v = args[i].value;
      if (v === null) {
        ctx.marker = true;
        return;
      }
      const m = /^[-/\u2013\u2014\u2015]([A-Za-z]+)(?::(.*))?$/.exec(v);
      if (!m) {
        // позиционный: powershell.exe — это -Command, pwsh — файл скрипта
        if (name === 'powershell') run(args.slice(i).map((a) => a.value).join(' '), 'powershell');
        return;
      }
      const p = m[1].toLowerCase();
      if ('command'.startsWith(p)) {
        const rest = args.slice(i + 1);
        // `-Command -` и `-Command` без текста — команды из stdin
        if (rest.length === 0 || rest[0].value === '-' || rest.some((a) => a.value === null)) ctx.marker = true;
        else run(rest.map((a) => a.value).join(' '), 'powershell');
        return;
      }
      if (p === 'e' || (p.length >= 2 && 'encodedcommand'.startsWith(p))) {
        const b64 = args[i + 1]?.value;
        let script = null;
        try {
          script = typeof b64 === 'string' && /^[A-Za-z0-9+/=]+$/.test(b64) ? Buffer.from(b64, 'base64').toString('utf16le') : null;
        } catch {
          script = null;
        }
        if (script === null) ctx.marker = true;
        else run(script, 'powershell');
        return;
      }
      if ('file'.startsWith(p)) return;
      if (PS_HOST_SWITCHES.some((n) => n.startsWith(p))) continue;
      if (PS_HOST_VALUES.some((n) => n.startsWith(p)) && m[2] === undefined) {
        i += 1;
        continue;
      }
      ctx.marker = true; // неизвестный параметр хоста (-WorkingDirectory меняет каталог …)
      return;
    }
    ctx.marker = true; // ни -Command, ни -File — команды из stdin
    return;
  }
  if (name === 'cmd') {
    const k = args.findIndex((a) => /^\/{1,2}[ckr]$/i.test(a.value ?? ''));
    if (k === -1) return;
    const rest = args.slice(k + 1);
    if (rest.some((a) => a.value === null) || CMD_WRITE_RE.test(rest.map((a) => a.text).join(' '))) ctx.marker = true;
  }
}

// PowerShell/.NET: запись в обход командлетов (`[IO.File]::WriteAllText`, `(Get-Item x).Delete()`,
// `New-Object IO.StreamWriter`) — '?'.
const PS_DOTNET_WRITE_RE = /\[(?:System\.)?IO\.(?:File|Directory|FileInfo|DirectoryInfo)\]::(?!(?:Exists|GetAttributes|GetCreationTime|GetLastWriteTime|GetLastAccessTime|GetFiles|GetDirectories|GetFileSystemEntries|ReadAllText|ReadAllLines|ReadAllBytes|ReadLines|OpenRead|OpenText|Enumerate\w*)\b)\w|(?:New-Object\s+(?:-TypeName\s+)?(?:System\.)?IO\.(?:StreamWriter|FileStream|BinaryWriter|FileInfo|DirectoryInfo))|\[(?:System\.)?IO\.(?:StreamWriter|FileStream|BinaryWriter)\]::new|\.(?:Delete|MoveTo|CopyTo|Create|CreateText|AppendText|CreateSubdirectory|Encrypt|Decrypt|Replace|SetAccessControl)\s*\(/i;

// Цели записи команды `name` с аргументами `args`; null — команда не пишет.
function commandTargets(name, args, world, ctx) {
  const cmdlet = PS_CMDLETS[name.toLowerCase()];
  // командлет в Bash (HEAD распознавал и его): параметры размечаются по правилам PowerShell
  if (cmdlet) return psCmdletTargets(cmdlet, ctx.ps ? args : args.map(psWord));
  if (POSIX_DELETE.has(name)) {
    const { pos } = posixArgs(args, []);
    return pos.length > 0 ? pos.map((w) => ({ word: w, del: true })) : [MARKER_ITEM];
  }
  if (POSIX_CREATE.has(name)) {
    const { pos } = posixArgs(args, POSIX_VALUE_FLAGS[name] ?? []);
    return pos.length > 0 ? pos.map((w) => ({ word: w })) : [MARKER_ITEM];
  }
  if (name === 'dd') return ddTargets(args);
  if (name === 'install' && args.some((w) => w.value === '-d' || (w.value ?? '').startsWith('--dir') || /^-[A-Za-z]*d/.test(w.value ?? ''))) {
    const { pos } = posixArgs(args, POSIX_VALUE_FLAGS.install);
    return pos.length > 0 ? pos.map((w) => ({ word: w })) : [MARKER_ITEM];
  }
  if (POSIX_LINKERS.has(name)) {
    const { pos, vals, afterEnd } = posixArgs(args, POSIX_VALUE_FLAGS[name]);
    // `ln TARGET` без имени ссылки создаёт её в текущем каталоге под именем цели
    if (name === 'ln' && pos.length === 1 && !vals.some((x) => x.flag === '-t' || x.flag === '--target-directory')) return [MARKER_ITEM];
    const tdir = vals.filter((x) => x.flag === '-t' || x.flag === '--target-directory').map((x) => x.item);
    const items = [];
    let sources = pos;
    if (tdir.length > 0) items.push(...tdir);
    else if (pos.length === 0) return [MARKER_ITEM];
    else {
      items.push({ word: pos[pos.length - 1] });
      sources = pos.slice(0, -1);
    }
    // невычисленный источник может оказаться `-t DIR`/`--target-directory=DIR`
    if (sources.some((w) => w.value === null && !afterEnd.has(w) && mayBeFlag(w))) items.push(MARKER_ITEM);
    // mv удаляет источник — это тоже запись (`mv /outside/f <scope>/f` уносит файл извне)
    if (name === 'mv') items.push(...sources.map((w) => ({ word: w, del: true })));
    return items;
  }
  if (name === 'sed') {
    const files = sedFiles(args);
    if (files === null) return null;
    return files.length > 0 ? files.map((w) => ({ word: w })) : [MARKER_ITEM];
  }
  if (name === 'find' && !ctx.ps) {
    const items = findTargets(args, world, ctx);
    return items.length > 0 ? items : null;
  }
  return null;
}

function psParamClass(pname) {
  if (PS_PARAM_CLASS.has(pname)) return PS_PARAM_CLASS.get(pname);
  const classes = new Set();
  for (const [n, c] of PS_PARAM_CLASS) if (n.startsWith(pname)) classes.add(c);
  return classes.size === 1 ? [...classes][0] : null;
}

function endsWithComma(w) {
  const last = w?.parts[w.parts.length - 1];
  return Boolean(last && last.kind === 'bare' && last.raw.endsWith(','));
}

// PowerShell-командлет: путь — -Path/-LiteralPath/-FilePath (и их префиксы) или первый
// позиционный; назначение Copy/Move — -Destination или следующий позиционный.
// Раунд 2 ревью C2 (2026-09-22): массив через запятую отдельным словом (`a ,b`, `a , b`) и
// сплаттинг `@p` — '?' (PowerShell 5.1 удаляет и второй элемент, и путь из хэш-таблицы —
// проверено запуском); `-Path:a,b` — '?'; параметр не из известных классов (или неоднозначный
// префикс) может быть и переключателем, и параметром со значением — раскладку позиционных
// тогда не вычислить, и целью считается каждое позиционное слово.
function psCmdletTargets(kind, args) {
  const paths = [];
  const dests = [];
  const pos = [];
  let marker = false;
  let named = false;
  let loose = false;
  let end = false;
  for (let i = 0; i < args.length; i += 1) {
    const w = args[i];
    if (w.value === '--%') {
      marker = true;
      break;
    }
    if (w.parts[0]?.kind === 'bare' && /^[,@]/.test(w.text)) {
      marker = true;
      continue;
    }
    if (!end && w.psEnd) {
      end = true;
      continue;
    }
    if (end || !w.psParam) {
      pos.push({ word: w });
      continue;
    }
    const colon = w.text.indexOf(':');
    const pname = (colon === -1 ? w.text.slice(1) : w.text.slice(1, colon)).toLowerCase();
    if (!/^[A-Za-z_?][A-Za-z0-9_?-]*$/.test(pname)) {
      marker = true;
      continue;
    }
    if ('name'.startsWith(pname)) named = true;
    const cls = psParamClass(pname);
    if (cls === null) {
      loose = true;
      continue;
    }
    if (colon !== -1) {
      if (cls !== 'path' && cls !== 'dest') continue;
      const glued = w.value === null ? null : w.value.slice(w.value.indexOf(':') + 1);
      (cls === 'path' ? paths : dests).push(glued && !glued.includes(',') ? { literal: glued } : MARKER_ITEM);
      continue;
    }
    if (cls === 'switch') continue;
    if (i + 1 >= args.length) {
      marker = true;
      continue;
    }
    i += 1;
    if (cls === 'path') paths.push({ word: args[i] });
    else if (cls === 'dest') dests.push({ word: args[i] });
    // `-Include a, b` — массив значения продолжается следующим словом
    else while (endsWithComma(args[i]) && i + 1 < args.length) i += 1;
  }
  const items = marker ? [MARKER_ITEM] : [];
  const del = kind === 'delete' || kind === 'move';
  const withDel = (x) => (x.marker ? x : { ...x, del });
  if (loose) {
    items.push(...paths.map(withDel), ...dests, ...pos.map(withDel));
    if (paths.length + dests.length + pos.length === 0 || (kind === 'new' && named)) items.push(MARKER_ITEM);
    return items;
  }
  const src = (paths.length > 0 ? paths : pos.slice(0, 1)).map(withDel);
  if (kind === 'copy' || kind === 'move') {
    const dest = dests.length > 0 ? dests : paths.length > 0 ? pos.slice(0, 1) : pos.slice(1, 2);
    items.push(...(dest.length > 0 ? dest : [MARKER_ITEM]));
    if (kind === 'move') items.push(...src);
    return items;
  }
  items.push(...(src.length > 0 ? src : [MARKER_ITEM]));
  if (kind === 'new' && (named || pos.length > (paths.length > 0 ? 0 : 1))) items.push(MARKER_ITEM);
  return items;
}

// Слово с раскрытием, которое в мире вычисляется однозначно, получает литеральное значение —
// флаги классифицируются по нему, как их увидит команда (`o=-t; cp $o /x a`).
function resolveArgs(args, world, ctx) {
  const lookup = lookupFor(world, ctx);
  return args.map((w) => {
    if (w.value !== null || w.hasSubstitution) return w;
    const r = expandWord(w, ctx.dialect, lookup);
    return r && !r.glob && !r.brace ? { ...w, value: r.value } : w;
  });
}

function commandWrites(name, ci, world, ctx) {
  let args = ci.args;
  // PowerShell: внешней программе (touch.exe, sed.exe) слова уходят как текст — без приведения тире
  if (ctx.ps && !PS_CMDLETS[name.toLowerCase()]) args = args.map((a) => a.orig ?? a);
  const items = commandTargets(name, resolveArgs(args, world, ctx), world, ctx);
  if (!items) return;
  if (ci.appends) ctx.marker = true; // xargs допишет аргументы из stdin
  for (const it of items) addTarget(ctx, world, it);
}

/**
 * Цели записи shell-команды (§6): редиректы в файл (`>`, `>>`, `>|`, `&>`, `&>>`, `<>`,
 * `>&файл`, `N>`, `N>>`, `N>&файл`; PowerShell `>`, `>>`, `N>`, `*>`), `sed -i`, `tee`, `rm`,
 * `rmdir`, `unlink`, `mv` (назначение и источники), `cp`, `mkdir`, `touch`, `del`, `find -delete/
 * -exec/-fprint`, командлеты Remove-Item/Set-Content/Add-Content/Clear-Content/Out-File/Tee-Object/
 * Export-Csv/New-Item/Copy-Item/Move-Item и их алиасы — в том числе внутри `$(…)`, `` `…` ``,
 * `<(…)`, `>(…)`, тел heredoc с незакавыченным разделителем, PowerShell `(…)`, `$(…)`, `{…}`.
 * Раунд 2 ревью C2 (2026-09-22): ещё `truncate`, `ln`, `install`, `dd of=`, вложенные
 * интерпретаторы (`bash|sh -c`, скрипт bash из heredoc, `powershell|pwsh -Command`,
 * `-EncodedCommand`) — разбираются этой же функцией; `cmd /c` с записью, .NET-запись в
 * PowerShell (`[IO.File]::Write…`, `.Delete()`), stdin-скрипт из пайпа — `"?"`.
 *
 * `opts.cwd` — каталог сессии: пути возвращаются абсолютными, с учётом `cd` в команде; без
 * него — относительными (как написаны; разрешает вызывающий). `opts.env` — окружение для
 * `$NAME` (по умолчанию `process.env`), `opts.dialect` — 'posix' (Bash) | 'powershell'.
 *
 * Маркер `"?"` — признак записи есть, а путь однозначно не вычислить (ядро отказывает): сканер
 * не разобрал команду, подстановка или неизвестная переменная в пути, шаблон, каталог после
 * нетрекаемой смены (`cd -`, popd, cd в `(…)`/цикле/после heredoc, `cd $(…)`), команда с
 * нелитеральным именем, массив/сплаттинг PowerShell (`a ,b`, `@p`), невычисленное слово, которое
 * может оказаться флагом у cp/mv/sed/find, присваивание с динамическим именем (`declare
 * "$n=…"`, `(( $n = 1 ))` — тогда неизвестны все переменные). Исключение внутри разбора — тоже `["?"]`: decide превращает
 * исключение в allow, а ложное разрешение хуже ложного отказа.
 *
 * @param {string} command
 * @param {{cwd?: string, env?: object, dialect?: 'posix'|'powershell'}} [opts]
 * @returns {string[]}
 */
export function detectShellWrites(command, opts) {
  return detectAt(command, opts, 0);
}

function detectAt(command, opts, level, cdSearch = false, shared = { runs: 0 }) {
  if (level > MAX_NESTED) return [MARK];
  const text = String(command ?? '');
  if (!text.trim()) return [];
  const dialect = opts?.dialect === 'powershell' ? 'powershell' : 'posix';
  const env = opts?.env && typeof opts.env === 'object' ? opts.env : process.env;
  const cwd = typeof opts?.cwd === 'string' && opts.cwd ? resolvePath(opts.cwd) : '';
  try {
    const ctx = makeContext(dialect, env);
    ctx.level = level;
    ctx.cdSearch = cdSearch;
    ctx.shared = shared;
    walk(text, ctx, [newWorld(cwd)], 0);
    for (const name of ctx.readonlyNames) {
      if ((ctx.tracked.get(name) ?? 0) > 1) ctx.taint.add(name); // `readonly S; S=/x` — второе не присвоится
    }
    ctx.taintPass = false;
    ctx.budget = WALK_BUDGET;
    walk(text, ctx, [newWorld(cwd)], 0);
    const result = [...ctx.out];
    if (ctx.marker) result.push(MARK);
    return result;
  } catch {
    return [MARK];
  }
}
