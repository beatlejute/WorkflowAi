/**
 * Rails — нормализация действий (спецификация §6).
 *
 * Приводит вызов инструмента (Claude Code hook input / Kilo plugin
 * input+output) к единой форме `{ tool, kind, command?, path?, server?,
 * mcpTool? }`, `kind ∈ shell | edit | write | read | agent | mcp | other`.
 * Неизвестные имена инструментов — `other`, никогда не ошибка (§6).
 *
 * `writesTo` (§6, детерминированно распознаваемые пути записи из shell-
 * команды) в объект действия не встроен — таблица API отдельно перечисляет
 * `detectShellWrites(command)` как самостоятельную функцию; вызывающий код
 * (`core.mjs`) вызывает её сам для `kind === "shell"`, если ему нужен
 * `writesTo`.
 */

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
    return { tool: toolName, kind: 'shell', command: input.command };
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
    return { tool, kind: 'shell', command: args.command };
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

// --- detectShellWrites -----------------------------------------------------

function stripQuotes(s) {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

const SHELL_OPERATOR_CHARS = new Set([';', '&', '|', '(', ')']);

// Обёртки: сами не команда записи, но СЛЕДУЮЩЕЕ за ними токен — тоже
// командное слово (`sudo rm …`, `xargs rm …`, `command touch …`).
const COMMAND_WRAPPERS = new Set(['sudo', 'xargs', 'command', 'git']);

/**
 * Разбивает команду на токены по пробелам и по операторам shell
 * (`;`, `&`, `|`, `(`, `)`, каждый — отдельный токен), вне простых кавычек.
 */
function tokenize(command) {
  const tokens = [];
  let current = '';
  let quote = null;
  const flush = () => {
    if (current) {
      tokens.push(current);
      current = '';
    }
  };
  for (const ch of command) {
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    if (SHELL_OPERATOR_CHARS.has(ch)) {
      flush();
      tokens.push(ch);
      continue;
    }
    current += ch;
  }
  flush();
  return tokens;
}

// Команды, у которых КАЖДЫЙ не-флаговый аргумент — путь записи (могут быть
// множественными: `rm a b`, `mkdir a b`, …).
const POSITIONAL_WRITE_COMMANDS = new Set(['rm', 'mkdir', 'touch', 'del', 'tee']);

// cp/mv: путь записи — только ПОСЛЕДНИЙ позиционный аргумент (назначение);
// предыдущие — источники (чтение), не запись. `cp /etc/x <scope>/y` иначе
// ловится как «запись в /etc/x вне области», хотя пишет только в <scope>/y.
const LAST_ARG_WRITE_COMMANDS = new Set(['cp', 'mv']);

// PowerShell-командлеты: путь — именованный параметр (-Path/-LiteralPath/
// -FilePath) либо, если его нет, первый позиционный аргумент; остальные
// позиционные аргументы (например, -Value у Set-Content) путём не считаются.
const PS_WRITE_CMDLETS = new Set(['remove-item', 'set-content', 'out-file']);
const PS_PATH_PARAMS = new Set(['-path', '-literalpath', '-filepath']);

const WRITE_COMMANDS = new Set([...POSITIONAL_WRITE_COMMANDS, ...LAST_ARG_WRITE_COMMANDS, ...PS_WRITE_CMDLETS]);

function extractPsPath(seg) {
  for (let i = 0; i < seg.length; i++) {
    if (PS_PATH_PARAMS.has(seg[i].toLowerCase()) && i + 1 < seg.length) {
      return stripQuotes(seg[i + 1]);
    }
  }
  // Позиционный путь — только когда сегмент СРАЗУ начинается с него (первый
  // аргумент командлета не флаг): `Remove-Item file.txt`. Если сегмент
  // начинается с именованного параметра (`Set-Content -Value hi`), значение
  // этого параметра — не путь, угадывать его как позиционный нельзя, иначе
  // `-Value hi` без -Path даёт ложный путь "hi".
  if (seg.length > 0 && !seg[0].startsWith('-')) {
    return stripQuotes(seg[0]);
  }
  return null;
}

/**
 * Индексы токенов, стоящих в ПОЗИЦИИ командного слова: начало команды (0),
 * сразу после оператора shell (`;`/`&`/`|`/`(`/`)`), либо сразу после
 * известной обёртки (`sudo`, `xargs`, `command`, `git`, `-exec` у `find`).
 * Без этого любой токен, случайно совпавший с именем команды записи
 * (`grep -rn "touch" src/`, `echo rm`), ложно считался вызовом этой команды.
 *
 * @param {string[]} tokens
 * @returns {Set<number>}
 */
function commandWordIndices(tokens) {
  const positions = new Set();
  let expectCommand = true;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (SHELL_OPERATOR_CHARS.has(t)) {
      expectCommand = true;
      continue;
    }
    if (expectCommand) {
      positions.add(i);
      expectCommand = COMMAND_WRAPPERS.has(t.toLowerCase());
    } else {
      expectCommand = false;
    }
  }
  // `find … -exec rm {} \;`: `-exec` сам не в командной позиции (это флаг
  // find), но СЛЕДУЮЩИЙ за ним токен — командное слово.
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].toLowerCase() === '-exec' && i + 1 < tokens.length) {
      positions.add(i + 1);
    }
  }
  return positions;
}

// Префикс перед `>`/`>>`: начало строки, пробел, оператор shell, либо
// цифра дескриптора (`2>err.txt`, `2>>err.txt` — стандартный синтаксис
// fd-редиректа). `(?!&)` после стрелки исключает `>&1`/`2>&1` (редирект в
// другой fd, не в файл) — цель файловая запись, не перенаправление потока.
const REDIRECT_RE = /(^|[\s;&|(]|\d)(>{1,2})(?!&)\s*([^\s;&|)<>]+)/g;

/**
 * Заменяет содержимое кавычек (без самих кавычек) символом-заглушкой той же
 * длины: строка остаётся той же длины (индексы совпадений не съезжают), но
 * операторы shell (`>`, `;`, …) внутри кавычек больше не распознаются как
 * операторы. Используется только для поиска редиректов по regex — реальный
 * текст цели редиректа (с кавычками) берётся из исходной строки по тем же
 * индексам, чтобы `stripQuotes` отработал на настоящих кавычках.
 *
 * @param {string} s
 * @returns {string}
 */
function maskQuotedRegions(s) {
  let out = '';
  let quote = null;
  for (const ch of s) {
    if (quote) {
      out += ch === quote ? ch : 'x';
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Детерминированно распознаваемые цели записи в shell-команде: `sed -i`,
 * `>`/`>>` (включая `N>`/`N>>` fd-редирект в файл), `tee`, `rm`, `mv`, `cp`,
 * `mkdir`, `touch`, `del`, `Remove-Item`, `Set-Content`, `Out-File`. Если
 * признак записи есть, а путь извлечь не удалось — в результат добавляется
 * маркер `"?"` (core должен трактовать это как запись вне области, см. §6).
 *
 * Лучшее из возможного без парсера shell — эвристика, а не точный разбор
 * (см. §14 «Границы»): обходится косвенностью (переменные, alias). Кавычки
 * учитываются (`grep "a > b" file.txt` не даёт ложного редиректа), но не
 * произвольная вложенность/экранирование внутри них.
 *
 * @param {string} command
 * @returns {string[]}
 */
export function detectShellWrites(command) {
  const cmd = String(command ?? '');
  if (!cmd.trim()) return [];

  const found = new Set();
  let sawWriteIntent = false;
  let sawUnresolved = false;

  // 1. Редиректы: > / >> — ищем по маскированной (без спецсимволов в
  // кавычках) копии, а сам текст цели берём из оригинала по тем же
  // индексам, чтобы сохранить настоящие кавычки для stripQuotes.
  const masked = maskQuotedRegions(cmd);
  let m;
  REDIRECT_RE.lastIndex = 0;
  while ((m = REDIRECT_RE.exec(masked))) {
    const groupStart = m.index + m[0].length - m[3].length;
    const rawTarget = cmd.slice(groupStart, groupStart + m[3].length);
    const target = stripQuotes(rawTarget);
    // Псевдоустройства — не запись и не «намерение записи»: `2>/dev/null`, `>NUL`
    // (первый проход коуча 2026-09-22: `2>/dev/null` в отчётной команде отклонён как запись вне scope).
    if (target && /^(\/dev\/(null|stdout|stderr)|nul)$/i.test(target)) continue;
    sawWriteIntent = true;
    if (target && !/^&/.test(target)) {
      found.add(target);
    } else {
      sawUnresolved = true;
    }
  }

  const tokens = tokenize(cmd);

  /** Токены вызова, начинающегося с индекса i (командное слово), до конца
   * его сегмента (до `;`/`&`/`|`/`(`/`)` или конца команды). */
  const segmentAfter = (i) => {
    const seg = [];
    for (let j = i + 1; j < tokens.length; j++) {
      const t = tokens[j];
      if (SHELL_OPERATOR_CHARS.has(t)) break;
      seg.push(t);
    }
    return seg;
  };

  const cmdPositions = commandWordIndices(tokens);

  // 2. sed -i (in-place)
  for (let i = 0; i < tokens.length; i++) {
    if (!cmdPositions.has(i)) continue;
    if (tokens[i].toLowerCase() !== 'sed') continue;
    const seg = segmentAfter(i);
    if (!seg.some((t) => t === '-i' || /^-i\S*$/.test(t))) continue;
    sawWriteIntent = true;
    const candidates = seg.filter((t) => !t.startsWith('-'));
    // candidates[0] — сам sed-скрипт (`s/a/b/`), не файл; цель — то, что
    // идёт ПОСЛЕ него. Без отдельного файлового аргумента (`sed -i 's/…/'`
    // без файла) считать скрипт путём нельзя — это маркер "?", а не мнимый
    // путь.
    const target = candidates.slice(1).pop();
    if (target) {
      found.add(stripQuotes(target));
    } else {
      sawUnresolved = true;
    }
  }

  // 3. Именованные команды записи: rm/mv/cp/mkdir/touch/del/tee/PS-cmdlets —
  // только в позиции командного слова (см. commandWordIndices), иначе
  // read-only команда с этим словом в аргументах (`grep -rn "touch" src/`,
  // `echo rm`) ложно ловится как запись.
  for (let i = 0; i < tokens.length; i++) {
    if (!cmdPositions.has(i)) continue;
    const word = tokens[i].toLowerCase();
    if (!WRITE_COMMANDS.has(word)) continue;
    sawWriteIntent = true;
    const seg = segmentAfter(i);
    if (PS_WRITE_CMDLETS.has(word)) {
      const p = extractPsPath(seg);
      if (p) found.add(p);
      else sawUnresolved = true;
      continue;
    }
    const args = seg.filter((t) => !t.startsWith('-')).map(stripQuotes);
    if (args.length === 0) {
      sawUnresolved = true;
    } else if (LAST_ARG_WRITE_COMMANDS.has(word)) {
      found.add(args[args.length - 1]);
    } else {
      for (const a of args) found.add(a);
    }
  }

  const result = [...found];
  // Маркер добавляется всегда, когда встретился нераспознанный признак
  // записи, — не только при пустом found: `touch /scope/a; rm -rf` иначе
  // теряет сигнал по нераспознанному `rm -rf` за счёт того, что `touch`
  // уже что-то нашёл (регресс: смешанная команда «молчала» про вторую,
  // core её не видел).
  if (sawUnresolved || (sawWriteIntent && result.length === 0)) {
    result.push('?');
  }
  return result;
}
