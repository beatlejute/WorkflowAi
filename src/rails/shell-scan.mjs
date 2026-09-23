/**
 * Rails — единый разбор строки shell-команды для ядра (2026-09-22, ЗАДАЧА B2).
 *
 * До этого модуля у ядра было три наивных трекера кавычек (isCliCommand /
 * splitTopLevelSegments / injectSession) и регулярка для `--quote`: они не знали
 * `\"` внутри "…", `'\''`, подстановок `$(…)` — ревью показало ложный allow, при
 * котором хук сам создавал инъекцию (`--quote '… --quote "$(touch PWNED)"'`
 * переписывался так, что shell выполнял `$(…)`). Здесь — один посимвольный сканер
 * на оба диалекта. Всё, чего он не понимает до конца, он помечает (`ok: false`,
 * `hasSubstitution`, `ambiguous`), и по инварианту «ложный отказ допустим,
 * ложное разрешение — нет» вызывающий код такие команды cli-вызовом не считает.
 *
 * Поведение shell'ов проверено запуском (bash 5.2 msys, Windows PowerShell 5.1),
 * не по памяти:
 *  - bash: в "…" бэкслеш экранирует только $ ` " \ и перевод строки; `…` и $(…)
 *    внутри "…" выполняются; "…" внутри $(…) не закрывает внешние кавычки; тело
 *    heredoc не исполняется, но при незакавыченном разделителе в нём раскрываются
 *    $(…) и `…`; <(…) выполняется; 'a'\''b' и 'a'"'"'b' — оба дают a'b; `\`+перевод
 *    строки вне кавычек склеивает токены.
 *  - PowerShell: '' внутри '…' и "" внутри "…" — литеральная кавычка; в "…" бэктик
 *    экранирует следующий символ (`n → перевод строки, `x → x, `$ → $); $(…) внутри
 *    "…", (…) и @(…) как аргумент — выполняются; {…} не выполняется, но и не
 *    литерал; `;`, `|`, перевод строки — разделители; `&&`/`||` в 5.1 — ошибка
 *    парсера (в 7.x — операторы цепочки), считаем их разделителями.
 *  - PowerShell и типографские кавычки (ревью B2, раунд 2, 2026-09-22 — сканер их не
 *    знал, и `--quote 'лейбл с ’; git commit …'` проходил как один закавыченный токен):
 *    ‘ ’ ‚ ‛ (U+2018–U+201B) — одинарные, “ ” „ (U+201C–U+201E) — двойные; любая
 *    кавычка класса закрывает строку, открытую любой кавычкой того же класса, и
 *    открывает строку вне кавычек; пара подряд — литерал, равный ВТОРОМУ символу пары
 *    ('a‘'b' → a'b, 'a’’b' → a’b); бэктик перед любой из них — сам символ; ‟ (U+201F)
 *    кавычкой не является. Всё проверено запуском powershell.exe 5.1.
 *  - CR (\r) — НЕ пробел (ревью B2, раунд 3, 2026-09-22: сканер считал его пробелом, и
 *    `status<CR>ni PWNED` под PowerShell был одним cli-сегментом — PowerShell выполнял
 *    `ni`). Проверено запуском: PowerShell 5.1 — одиночный CR вне кавычек равен переводу
 *    строки (разделитель statement'ов), CRLF — один разделитель, внутри '…'/"…" — литерал,
 *    комментарий `#` кончается на CR; бэктик+CR/LF, приклеенный к слову, — буквальный
 *    символ в слове (`--x`<CR>ni` → один аргумент `--x\rni`; после него LF — разделитель),
 *    отдельно стоящий — продолжение строки (`a `<CR><LF>b` → аргументы a, b). bash (Linux)
 *    — CR обычный символ слова (`>&1<CR>PWNED` — редирект `>&word`, создаёт файл);
 *    msys-bash (Git for Windows, оба бинарника) молча УДАЛЯЕТ CR из текста `-c`
 *    (`gi<CR>t --version` печатает версию git, `tou<CR>ch X` создаёт файл). Модель здесь —
 *    Linux (CR в слове); ядро (core.mjs) дополнительно прогоняет общие правила по тексту
 *    без CR. NEL/LS/PS/FF/VT/NBSP под PowerShell — пробелы между аргументами, не
 *    разделители statement'ов (проверено); сканер считает их символами слова — это
 *    может дать лишь ложный отказ.
 *
 * Вложенность подстановок/кавычек ограничена (MAX_NESTING): сканер рекурсивен
 * ("…" → $(…) → "…" …), и строка из тысяч `"$(` роняла его RangeError'ом, который
 * catch-all в decide() превращал в allow (ревью B2, раунд 2). Глубже лимита — ok: false.
 *
 * Модуль без побочных эффектов и без ввода-вывода.
 */

/** @typedef {'posix'|'powershell'} Dialect */

/**
 * Часть токена: незакавыченный текст, '…', "…", $'…' или область подстановки.
 * @typedef {object} TokenPart
 * @property {'bare'|'single'|'double'|'ansi'|'subst'} kind
 * @property {number} start индекс в исходной строке (включая открывающую кавычку/`$(`)
 * @property {number} end индекс за концом части (включая закрывающую кавычку/`)`)
 * @property {string} raw сырой текст части без обрамляющих кавычек
 * @property {string} value буквальное значение после снятия экранирования; для
 *   областей подстановок и раскрытий — сырой текст как есть
 * @property {boolean} hasSubstitution есть выполнение: $(…), `…`, <(…), >(…), ${…}
 *   (${…} — консервативно: внутри могут быть вложенные $(…) и свои правила кавычек);
 *   PowerShell: $(…), (…), @(…), {…}, @{…}, ${…}
 * @property {boolean} hasExpansion есть раскрытие переменной ($имя, ${…})
 * @property {boolean} hasUnescapedSpecial только для double: shell изменил бы текст —
 *   POSIX: неэкранированные ` или $; PowerShell: неэкранированный $ или бэктик-escape,
 *   который PowerShell «съел» бы (любой, кроме `" `$ ``)
 * @property {boolean} ambiguous только для double, PowerShell: есть ${…} или бэктик
 *   перед переводом строки/CR — буквальное значение неоднозначно, переписывать нельзя.
 *   Буквенные escape'ы (`n `t `r …) неоднозначными НЕ считаются (ревью B2, раунд 3,
 *   2026-09-22): лейблы скилов содержат `` `rails.yaml` ``, `` `tests/` ``, и агент пишет
 *   именно эти символы — значение равно написанному тексту, PowerShell же превратил бы
 *   `r/`t в CR/TAB (проверено запуском)
 * @property {boolean} redirect в незакавыченной части есть < или >
 */

/**
 * Токен — слово команды (после разбиения по пробелам и операторам).
 * @typedef {object} Token
 * @property {'word'|'heredoc'} kind
 * @property {number} start
 * @property {number} end
 * @property {string} text исходный текст токена
 * @property {string|null} value буквальное значение, если в токене нет подстановок и
 *   раскрытий; иначе null
 * @property {'none'|'single'|'double'|'ansi'|'mixed'} quote тип кавычек: ровно одна
 *   закавыченная часть — её тип; только незакавыченный текст/подстановки — none;
 *   иначе mixed (например `--quote="…"` или `'a'\''b'`)
 * @property {TokenPart[]} parts
 * @property {boolean} hasSubstitution
 * @property {boolean} hasExpansion
 * @property {boolean} redirect в незакавыченной части есть < или > (редирект, heredoc)
 */

/**
 * Простая команда — между `|` внутри сегмента.
 * @typedef {object} Command
 * @property {number} start
 * @property {number} end конец последнего токена
 * @property {string} text
 * @property {Token[]} tokens
 * @property {Token[]} heredocs тела heredoc этой команды (POSIX); в `tokens` не входят,
 *   их `start`/`end` лежат за пределами сегмента
 */

/**
 * Сегмент — список простых команд между разделителями верхнего уровня.
 * @typedef {object} Segment
 * @property {number} start
 * @property {number} end
 * @property {string} text
 * @property {string|null} sepBefore разделитель перед сегментом: '&&' | '||' | ';' |
 *   '&' | '\n' | '(' | ')' | null (первый сегмент)
 * @property {Command[]} commands
 */

/**
 * @typedef {object} ScanResult
 * @property {boolean} ok false — разбор не завершён (незакрытая кавычка, скобка,
 *   подстановка или heredoc, слишком глубокая вложенность); структура при этом
 *   неполная, доверять ей нельзя
 * @property {string} [error]
 * @property {Dialect} dialect
 * @property {Segment[]} segments пустые сегменты и команды (двойные `;;`, хвостовой
 *   перевод строки) опущены; `sepBefore` следующего непустого сегмента — из подряд
 *   идущих разделителей структурный (`(`, `)`, `&`) имеет приоритет над `;`/`&&`/`||`/
 *   переводом строки (`a && (b)` → у `b` это `(`, `a && b) ; c` → у `c` это `)`),
 *   среди равных — первый; ведущие переводы строки не считаются
 * @property {string|null} trailingSep разделитель после последнего сегмента (`a &` →
 *   '&', `a ;` → ';', `a` → null) — по тому же правилу приоритета
 */

// PowerShell считает кавычками и типографские (см. шапку; проверено запуском PS 5.1).
const PS_SINGLE_QUOTES = new Set(["'", '‘', '’', '‚', '‛']);
const PS_DOUBLE_QUOTES = new Set(['"', '“', '”', '„']);
// Предел вложенности "…" → $(…) → "…" … (см. шапку). Реальные цитаты — глубина ≤ 3.
const MAX_NESTING = 32;
class NestingError extends Error {}
// Разделители, которые делают команду структурно не «просто списком команд»: не должны
// теряться за соседним `;`/переводом строки (ревью B2, раунд 2: `a && (b)` терял `(`).
const STRUCTURAL_SEPS = new Set(['(', ')', '&']);

function isSingleQuote(ch, ps) {
  return ch === "'" || (ps && PS_SINGLE_QUOTES.has(ch));
}

function isDoubleQuote(ch, ps) {
  return ch === '"' || (ps && PS_DOUBLE_QUOTES.has(ch));
}

// POSIX: что может стоять после `$`, чтобы это было раскрытие ($X $1 $@ $* $# $? $$ $! $-).
const POSIX_NAME_START = /[A-Za-z_0-9@*#?$!-]/;
// PowerShell: $x $_ $? $^ $$.
const PS_NAME_START = /[A-Za-z_0-9?^$]/;

/**
 * '…' от индекса сразу после открывающей кавычки. POSIX: до первой `'`, экранирования
 * нет. PowerShell: закрывает любая одинарная кавычка (включая типографские), пара
 * подряд — литерал (второй символ пары).
 * @param {string} s
 * @param {number} i
 * @param {Dialect} dialect
 * @returns {{end: number, value: string}|null} null — кавычка не закрыта
 */
function scanSingle(s, i, dialect) {
  if (dialect !== 'powershell') {
    const j = s.indexOf("'", i);
    return j === -1 ? null : { end: j + 1, value: s.slice(i, j) };
  }
  let value = '';
  while (i < s.length) {
    const ch = s[i];
    if (PS_SINGLE_QUOTES.has(ch)) {
      if (PS_SINGLE_QUOTES.has(s[i + 1])) {
        value += s[i + 1]; // 'a‘'b' → a'b, 'a’’b' → a’b (проверено запуском)
        i += 2;
        continue;
      }
      return { end: i + 1, value };
    }
    value += ch;
    i += 1;
  }
  return null;
}

/**
 * "…" от индекса сразу после открывающей кавычки.
 * @param {string} s
 * @param {number} i
 * @param {Dialect} dialect
 * @param {number} [depth=0] глубина вложенности (см. MAX_NESTING)
 * @returns {{end: number, value: string, hasSubstitution: boolean, hasExpansion: boolean,
 *   hasUnescapedSpecial: boolean, ambiguous: boolean}|null} null — кавычка не закрыта
 */
function scanDouble(s, i, dialect, depth = 0) {
  return dialect === 'powershell' ? scanDoublePs(s, i, depth) : scanDoublePosix(s, i, depth);
}

function scanDoublePosix(s, i, depth) {
  const n = s.length;
  let value = '';
  let hasSubstitution = false;
  let hasExpansion = false;
  let hasUnescapedSpecial = false;
  while (i < n) {
    const ch = s[i];
    if (ch === '\\') {
      if (i + 1 >= n) return null;
      const next = s[i + 1];
      if (next === '\n') {
        i += 2; // экранированный перевод строки исчезает целиком
        continue;
      }
      if (next === '$' || next === '`' || next === '"' || next === '\\') {
        value += next;
      } else {
        value += ch + next; // остальные бэкслеши в "…" буквальны (bash(1) QUOTING)
      }
      i += 2;
      continue;
    }
    if (ch === '"') {
      return { end: i + 1, value, hasSubstitution, hasExpansion, hasUnescapedSpecial, ambiguous: false };
    }
    if (ch === '$') {
      hasUnescapedSpecial = true;
      const next = s[i + 1];
      if (next === '(') {
        const j = findClosingParen(s, i + 2, 'posix', depth + 1);
        if (j < 0) return null;
        value += s.slice(i, j + 1);
        hasSubstitution = true;
        i = j + 1;
        continue;
      }
      if (next === '{') {
        const j = findClosingBrace(s, i + 2, 'posix', depth + 1);
        if (j < 0) return null;
        value += s.slice(i, j + 1);
        hasSubstitution = true; // ${…}: внутри свои правила кавычек и вложенные $(…) — консервативно
        hasExpansion = true;
        i = j + 1;
        continue;
      }
      if (next !== undefined && POSIX_NAME_START.test(next)) hasExpansion = true;
      value += '$';
      i += 1;
      continue;
    }
    if (ch === '`') {
      hasUnescapedSpecial = true;
      const j = findClosingBacktick(s, i + 1);
      if (j < 0) return null;
      value += s.slice(i, j + 1);
      hasSubstitution = true;
      i = j + 1;
      continue;
    }
    value += ch;
    i += 1;
  }
  return null;
}

function scanDoublePs(s, i, depth) {
  const n = s.length;
  let value = '';
  let hasSubstitution = false;
  let hasExpansion = false;
  let hasUnescapedSpecial = false;
  let ambiguous = false;
  while (i < n) {
    const ch = s[i];
    if (ch === '`') {
      if (i + 1 >= n) return null;
      const next = s[i + 1];
      if (PS_DOUBLE_QUOTES.has(next) || next === '$' || next === '`') {
        value += next; // снимаем только эти escape'ы — их смысл однозначен (`” → ”, проверено)
      } else {
        // Прочие `X PowerShell «съедает» (`x → x) или превращает в управляющий символ
        // (`n → перевод строки, `r → CR — проверено): оставляем оба символа как написал
        // агент. Неоднозначен только бэктик перед настоящим переводом строки/CR.
        value += ch + next;
        hasUnescapedSpecial = true;
        if (next === '\n' || next === '\r') ambiguous = true;
      }
      i += 2;
      continue;
    }
    if (PS_DOUBLE_QUOTES.has(ch)) {
      if (PS_DOUBLE_QUOTES.has(s[i + 1])) {
        value += s[i + 1]; // "" внутри "…" — литеральная кавычка; "a“"b" → a"b (второй символ пары)
        i += 2;
        continue;
      }
      return { end: i + 1, value, hasSubstitution, hasExpansion, hasUnescapedSpecial, ambiguous };
    }
    if (ch === '$') {
      hasUnescapedSpecial = true;
      const next = s[i + 1];
      if (next === '(') {
        const j = findClosingParen(s, i + 2, 'powershell', depth + 1);
        if (j < 0) return null;
        value += s.slice(i, j + 1);
        hasSubstitution = true;
        i = j + 1;
        continue;
      }
      if (next === '{') {
        const j = findClosingBrace(s, i + 2, 'powershell', depth + 1);
        if (j < 0) return null;
        value += s.slice(i, j + 1);
        hasSubstitution = true;
        hasExpansion = true;
        ambiguous = true;
        i = j + 1;
        continue;
      }
      if (next !== undefined && PS_NAME_START.test(next)) hasExpansion = true;
      value += '$';
      i += 1;
      continue;
    }
    value += ch;
    i += 1;
  }
  return null;
}

/**
 * $'…' (ANSI-C, только POSIX) от индекса сразу после `$'`.
 * @param {string} s
 * @param {number} i
 * @returns {{end: number, value: string}|null}
 */
function scanAnsi(s, i) {
  const n = s.length;
  const simple = { '\\': '\\', "'": "'", '"': '"', n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v' };
  let value = '';
  while (i < n) {
    const ch = s[i];
    if (ch === '\\') {
      if (i + 1 >= n) return null;
      const next = s[i + 1];
      if (next in simple) {
        value += simple[next];
        i += 2;
        continue;
      }
      let m;
      if ((m = /^x([0-9A-Fa-f]{1,2})/.exec(s.slice(i + 1, i + 4)))) {
        value += String.fromCharCode(parseInt(m[1], 16));
        i += 1 + m[0].length;
        continue;
      }
      if ((m = /^u([0-9A-Fa-f]{1,4})/.exec(s.slice(i + 1, i + 6))) || (m = /^U([0-9A-Fa-f]{1,8})/.exec(s.slice(i + 1, i + 10)))) {
        value += String.fromCodePoint(parseInt(m[1], 16));
        i += 1 + m[0].length;
        continue;
      }
      if ((m = /^[0-7]{1,3}/.exec(s.slice(i + 1, i + 4)))) {
        value += String.fromCharCode(parseInt(m[0], 8));
        i += 1 + m[0].length;
        continue;
      }
      value += ch + next; // неизвестный escape bash оставляет как есть (проверено: $'\q' → \q)
      i += 2;
      continue;
    }
    if (ch === "'") return { end: i + 1, value };
    value += ch;
    i += 1;
  }
  return null;
}

/**
 * Индекс закрывающей `)` для области, открытой перед `i` (глубина 1), с учётом
 * кавычек диалекта и вложенных скобок. -1 — не закрыта.
 * @param {string} s
 * @param {number} i
 * @param {Dialect} dialect
 * @param {number} [nesting=1] глубина вложенности областей; больше MAX_NESTING —
 *   NestingError (scanCommand превращает её в ok: false)
 * @returns {number}
 */
function findClosingParen(s, i, dialect, nesting = 1) {
  return findClosing(s, i, dialect, '(', ')', nesting);
}

function findClosingBrace(s, i, dialect, nesting = 1) {
  return findClosing(s, i, dialect, '{', '}', nesting);
}

function findClosing(s, i, dialect, open, close, nesting) {
  if (nesting > MAX_NESTING) throw new NestingError('слишком глубокая вложенность подстановок и кавычек');
  const ps = dialect === 'powershell';
  let depth = 1;
  while (i < s.length) {
    const ch = s[i];
    if (!ps && ch === '\\') {
      i += 2;
      continue;
    }
    if (ps && ch === '`') {
      i += 2;
      continue;
    }
    if (isSingleQuote(ch, ps)) {
      const r = scanSingle(s, i + 1, dialect);
      if (!r) return -1;
      i = r.end;
      continue;
    }
    if (isDoubleQuote(ch, ps)) {
      const r = scanDouble(s, i + 1, dialect, nesting);
      if (!r) return -1;
      i = r.end;
      continue;
    }
    if (!ps && ch === '`') {
      const j = findClosingBacktick(s, i + 1);
      if (j < 0) return -1;
      i = j + 1;
      continue;
    }
    if (!ps && ch === '$' && s[i + 1] === "'") {
      const r = scanAnsi(s, i + 2);
      if (!r) return -1;
      i = r.end;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

/**
 * Индекс закрывающего бэктика для `…` (POSIX): внутри бэкслеш экранирует только
 * ` \ $; кавычки бэктик не защищают. -1 — не закрыт.
 * @param {string} s
 * @param {number} i
 * @returns {number}
 */
function findClosingBacktick(s, i) {
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\' && (s[i + 1] === '`' || s[i + 1] === '\\' || s[i + 1] === '$')) {
      i += 2;
      continue;
    }
    if (ch === '`') return i;
    i += 1;
  }
  return -1;
}

/**
 * Разбирает строку команды на сегменты → простые команды → токены.
 *
 * Сканер не выполняет раскрытий: значение токена (`value`) — буквальный текст после
 * снятия экранирования; там, где shell что-то раскрыл бы или выполнил, `value`
 * равен null, а на токене стоят `hasExpansion`/`hasSubstitution`.
 *
 * @param {string} command
 * @param {Dialect} [dialect='posix']
 * @returns {ScanResult}
 */
export function scanCommand(command, dialect = 'posix') {
  const s = String(command ?? '');
  const ps = dialect === 'powershell';
  const n = s.length;
  /** @type {Segment[]} */
  const segments = [];
  let seg = null;
  let cmd = null;
  let tok = null;
  let sepBefore = null;
  let trailingSep = null;
  const pendingHeredocs = [];
  const parenStack = []; // открытые `(`; true — скобка арифметики `(( … ))` (см. heredoc ниже)
  // Раунд 5 (2026-09-22, LOW-4). Строгий признак арифметической команды — правило самого bash
  // (parse_arith_cmd): после `((` разбирается пара, открытая ВТОРОЙ скобкой, и это арифметика,
  // только если сразу за её `)` стоит ещё одна `)`. Иначе это вложенные подоболочки, которые
  // bash ВЫПОЛНЯЕТ. Проверено запуском bash 5.2 msys: `((touch f))` — «syntax error in
  // expression», файла нет; `((echo x) > b)`, `(((a)) > b)`, `((cd x) && (touch y))` — файлы
  // создаются. parenStack выше остаётся прежним, НЕстрогим: на нём держится запрет heredoc
  // внутри `(( ))` из раунда 3 (сузить его — снова спрятать команды за телом heredoc).
  //
  // Ревью C2 r5 (2026-09-22, HIGH): признак хранился СТЕКОМ (arithStack), и любой разбор,
  // проскочивший закрывающие `))` мимо ветки скобок, оставлял его невытолкнутым — arith:true
  // получали ВСЕ следующие сегменты команды, а commandIO молча выбрасывал их редиректы (ложное
  // РАЗРЕШЕНИЕ; найденный путь — `#` внутри `(( … ))`, он исправлен отдельно выше). Теперь
  // признак — ГРАНИЦА ПО ПОЗИЦИИ: конец арифметической области известен в тот же момент, что и
  // её начало (зонд всё равно ищет закрывающую скобку), поэтому «протечь» за `))` он не может
  // независимо от того, как токенайзер прошёл текст. Разбор идёт слева направо и arithUntil
  // только растёт, так что «позиция внутри области» = `pos <= arithUntil`.
  let arithUntil = -1;
  // Зонд на каждую `((` стоит O(n); бюджет держит суммарную работу линейной, а его исчерпание
  // трактуется как «подоболочка» (редиректы считаются записью — только ложный отказ).
  let arithBudget = 4 * n + 1024;
  function markArith(i) {
    if (i <= arithUntil) return; // внутри `(( ))` всё арифметика, граница уже стоит
    if (s[i + 1] !== '(' || arithBudget <= 0) return;
    let j;
    try {
      j = findClosingParen(s, i + 2, dialect);
    } catch {
      return; // слишком глубокая вложенность — разбор всё равно упадёт в ok: false
    }
    arithBudget -= (j < 0 ? n : j) - i;
    if (j >= 0 && s[j + 1] === ')') arithUntil = j + 1;
  }
  let ok = true;
  let error;
  // Конец последнего НЕэкранированного символа оператора редиректа (`<`, `>`, `&` в `&>`/`>&`,
  // `|` в `>|`). ЗАДАЧА C2, 2026-09-22: `&` считался редиректом по `s[i-1] === '>'`, и
  // `echo \>& touch X` был одной командой echo, а bash выполняет `touch X` (`\>` — литерал, `&` —
  // фон; проверено запуском bash 5.2 msys). `>|` (запись с перезаписью) резался на `>` и пайп.
  let lastOpEnd = -1;

  function ensureCmd(pos) {
    if (!seg) seg = { start: pos, end: pos, text: '', sepBefore, commands: [], arith: pos <= arithUntil };
    if (!cmd) cmd = { start: pos, end: pos, text: '', tokens: [], heredocs: [] };
  }
  function ensureTok(pos) {
    ensureCmd(pos);
    if (!tok) {
      tok = { kind: 'word', start: pos, end: pos, text: '', value: null, quote: 'none', parts: [], hasSubstitution: false, hasExpansion: false, redirect: false };
    }
  }
  function applyFlags(part) {
    tok.end = part.end;
    if (part.hasSubstitution) tok.hasSubstitution = true;
    if (part.hasExpansion) tok.hasExpansion = true;
    if (part.redirect) tok.redirect = true;
  }
  function addPart(part) {
    ensureTok(part.start);
    tok.parts.push({ hasSubstitution: false, hasExpansion: false, hasUnescapedSpecial: false, ambiguous: false, redirect: false, ...part });
    applyFlags(tok.parts[tok.parts.length - 1]);
  }
  // Незакавыченный текст: соседние символы сливаются в одну часть.
  function addBare(start, end, value, flags = {}) {
    ensureTok(start);
    const last = tok.parts[tok.parts.length - 1];
    if (last && last.kind === 'bare' && last.end === start) {
      last.end = end;
      last.raw = s.slice(last.start, end);
      last.value += value;
      if (flags.expansion) last.hasExpansion = true;
      if (flags.redirect) last.redirect = true;
      applyFlags(last);
      return;
    }
    addPart({ kind: 'bare', start, end, raw: s.slice(start, end), value, hasExpansion: Boolean(flags.expansion), redirect: Boolean(flags.redirect) });
  }
  function addRegion(start, end, flags) {
    addPart({ kind: 'subst', start, end, raw: s.slice(start, end), value: s.slice(start, end), hasSubstitution: Boolean(flags.substitution), hasExpansion: Boolean(flags.expansion), redirect: Boolean(flags.redirect) });
  }
  function endTok() {
    if (!tok) return;
    tok.text = s.slice(tok.start, tok.end);
    const quoted = tok.parts.filter((p) => p.kind === 'single' || p.kind === 'double' || p.kind === 'ansi');
    if (quoted.length === 0) tok.quote = 'none';
    else if (tok.parts.length === 1) tok.quote = quoted[0].kind;
    else tok.quote = 'mixed';
    tok.value = tok.hasSubstitution || tok.hasExpansion ? null : tok.parts.map((p) => p.value).join('');
    cmd.tokens.push(tok);
    cmd.end = tok.end;
    tok = null;
  }
  function endCmd() {
    endTok();
    if (!cmd) return;
    if (cmd.tokens.length > 0) {
      cmd.text = s.slice(cmd.start, cmd.end);
      seg.commands.push(cmd);
      seg.end = cmd.end;
    }
    cmd = null;
  }
  function endSeg(sep) {
    endCmd();
    if (seg && seg.commands.length > 0) {
      seg.text = s.slice(seg.start, seg.end);
      segments.push(seg);
      sepBefore = sep;
    } else if (segments.length === 0 && sepBefore === null && sep === '\n') {
      // ведущие переводы строки — ничего не значат
    } else if (sepBefore === null || (STRUCTURAL_SEPS.has(sep) && !STRUCTURAL_SEPS.has(sepBefore))) {
      // Пустой сегмент (`;;`, `a && (b)`, `a && b) ; c`): структурный разделитель
      // `(`/`)`/`&` не должен теряться ни за предыдущим `&&`/`;`, ни за последующим.
      sepBefore = sep;
    }
    seg = null;
  }
  function fail(message) {
    ok = false;
    error = message;
  }

  // Разделитель heredoc в двойных кавычках: bash снимает кавычки и `\` перед $ ` " \.
  // Раскрытий в разделителе нет, но `$`/`` ` `` внутри мы буквально не воспроизводим — -1.
  function heredocDquote(k) {
    let value = '';
    while (k < n) {
      const ch = s[k];
      if (ch === '"') return { value, end: k + 1 };
      if (ch === '$' || ch === '`' || ch === '\n') return null;
      if (ch === '\\') {
        const nx = s[k + 1];
        if (nx === undefined || nx === '\n') return null;
        if (nx === '$' || nx === '`' || nx === '"' || nx === '\\') {
          value += nx;
          k += 2;
          continue;
        }
      }
      value += ch;
      k += 1;
    }
    return null;
  }

  // `<<WORD` / `<<-WORD` / `<<'WORD'` / `<<"WORD"` / `<<\WORD`: оператор с разделителем —
  // один токен-редирект; тело придёт после ближайшего перевода строки.
  //
  // Раунд 3 ревью C2 (2026-09-22): разделитель — обычное слово, и bash снимает с него кавычки
  // ПОЧАСТЯМ: `<<E"O"F` и `<<E\OF` кончаются на строке `EOF` (проверено запуском bash 5.2;
  // закавычена хоть часть — в теле нет раскрытий). Сканер брал `E"O"F` буквально, тело не
  // кончалось там, где у bash, и команда после настоящего конца тела пропадала из разбора —
  // ложное разрешение. Чего разбор не воспроизводит буквально (`$…`, `` `…` ``, перенос
  // строки в разделителе), — -1 → ok: false → '?'.
  function parseHeredocOp(i) {
    let j = i + 2;
    let strip = false;
    if (s[j] === '-') {
      strip = true;
      j += 1;
    }
    while (s[j] === ' ' || s[j] === '\t') j += 1;
    let delim = '';
    let quoted = false;
    // CR — символ слова, не пробел (`<<EOF<CR>X` → разделитель `EOF<CR>X`).
    while (j < n && !/[ \t\n;&|<>()]/.test(s[j])) {
      const ch = s[j];
      if (ch === "'") {
        const k = s.indexOf("'", j + 1);
        if (k === -1 || s.slice(j + 1, k).includes('\n')) return -1;
        delim += s.slice(j + 1, k);
        quoted = true;
        j = k + 1;
        continue;
      }
      if (ch === '"') {
        const r = heredocDquote(j + 1);
        if (!r) return -1;
        delim += r.value;
        quoted = true;
        j = r.end;
        continue;
      }
      if (ch === '\\') {
        if (j + 1 >= n || s[j + 1] === '\n') return -1;
        delim += s[j + 1];
        quoted = true;
        j += 2;
        continue;
      }
      // `<<$X` — для bash разделитель `$X` буквально, `<<$'E'` — ANSI-C-кавычки: не моделируем
      if (ch === '$' || ch === '`') return -1;
      delim += ch;
      j += 1;
    }
    if (!delim) return -1;
    endTok();
    addBare(i, j, s.slice(i, j), { redirect: true });
    const owner = cmd;
    endTok();
    pendingHeredocs.push({ delim, strip, quoted, owner });
    return j;
  }

  // Тела heredoc после перевода строки — непрозрачны: разделители и кавычки внутри
  // не разбираются. Незакавыченный разделитель — в теле раскрываются $(…) и `…`
  // (проверено запуском) — помечаем как подстановку.
  function consumeHeredocs(i) {
    for (const h of pendingHeredocs) {
      const bodyStart = i;
      let found = false;
      while (i <= n) {
        const nl = s.indexOf('\n', i);
        const line = nl === -1 ? s.slice(i) : s.slice(i, nl);
        const cmp = h.strip ? line.replace(/^\t+/, '') : line;
        if (cmp === h.delim) {
          const body = s.slice(bodyStart, i);
          h.owner.heredocs.push({
            kind: 'heredoc',
            start: bodyStart,
            end: i,
            text: body,
            value: h.quoted ? body : null,
            quote: 'none',
            parts: [],
            hasSubstitution: !h.quoted && /[`$]/.test(body),
            hasExpansion: !h.quoted && body.includes('$'),
            redirect: true,
          });
          i = nl === -1 ? n : nl + 1;
          found = true;
          break;
        }
        if (nl === -1) break;
        i = nl + 1;
      }
      if (!found) return -1;
    }
    pendingHeredocs.length = 0;
    return i;
  }

  let i = 0;
  try {
    while (i < n) {
      const ch = s[i];

      if (ch === '\n') {
        endSeg('\n');
        i += 1;
        if (!ps && pendingHeredocs.length > 0) {
          i = consumeHeredocs(i);
          if (i < 0) {
            fail('heredoc не закрыт');
            break;
          }
        }
        continue;
      }
      // CR (ревью B2, раунд 3, 2026-09-22 — раньше считался пробелом): PowerShell —
      // разделитель statement'ов, как перевод строки (CRLF даёт пустой сегмент, он
      // опускается); bash — обычный символ слова, идёт в addBare ниже.
      if (ch === '\r' && ps) {
        endSeg('\n');
        i += 1;
        continue;
      }
      if (ch === ' ' || ch === '\t') {
        endTok();
        i += 1;
        continue;
      }
      // Комментарий: `#` в начале слова — до конца строки (bash и PowerShell; проверено).
      // PowerShell: одиночный CR тоже кончает комментарий (`#c<CR>Write-Output X` выполняет
      // Write-Output — проверено); bash: CR — часть комментария.
      // Ревью C2 r5 (2026-09-22, HIGH): внутри `(( … ))` `#` комментарием НЕ является — bash
      // разбирает его как часть арифметического выражения, ругается на неё в рантайме и идёт
      // дальше (проверено запуском bash 5.2 msys: строка `(( a # ))`, следом строка
      // `echo SECOND-RAN` — SECOND-RAN печатается; `(( a # )); echo AFTER-SEMI` печатает
      // AFTER-SEMI). Сканер же перематывал разбор до конца строки, съедая `))` вместе с её
      // остатком: скобки не выталкивались, а команды после `;` выпадали из разбора совсем —
      // ложное РАЗРЕШЕНИЕ (запись за пределами области была не видна). Признак берётся
      // НЕстрогий (parenStack), тот же, что у запрета heredoc: он шире настоящей арифметики,
      // и лишний разбор комментария в подоболочке `((cmd) # …)` даёт только ложный отказ.
      if (ch === '#' && !tok && !(!ps && parenStack.includes(true))) {
        const nl = s.indexOf('\n', i);
        const cr = ps ? s.indexOf('\r', i) : -1;
        const stop = [nl, cr].filter((k) => k !== -1);
        i = stop.length === 0 ? n : Math.min(...stop);
        continue;
      }

      // --- разделители и пайп ---
      if (ch === ';') {
        endSeg(';');
        i += 1;
        continue;
      }
      if (ch === '&') {
        if (s[i + 1] === '&') {
          endSeg('&&');
          i += 2;
          continue;
        }
        // `2>&1`, `>&2`, `&>file` — редиректы, не разделители (только после неэкранированного
        // `<`/`>`: `\>&` — литерал и фоновый `&`).
        if (lastOpEnd === i || s[i + 1] === '>') {
          addBare(i, i + 1, '&', { redirect: true });
          lastOpEnd = i + 1;
          i += 1;
          continue;
        }
        endSeg('&');
        i += 1;
        continue;
      }
      if (ch === '|') {
        // POSIX `>|file` / `2>|file` — редирект с перезаписью (проверено запуском bash), не пайп.
        if (!ps && lastOpEnd === i && s[i - 1] === '>') {
          addBare(i, i + 1, '|', { redirect: true });
          lastOpEnd = i + 1;
          i += 1;
          continue;
        }
        if (s[i + 1] === '|') {
          endSeg('||');
          i += 2;
          continue;
        }
        endCmd();
        i += !ps && s[i + 1] === '&' ? 2 : 1; // `|&` в bash — тоже пайп
        continue;
      }

      // --- кавычки (PowerShell: и типографские, см. шапку) ---
      if (isSingleQuote(ch, ps)) {
        const r = scanSingle(s, i + 1, dialect);
        if (!r) {
          fail('незакрытая одинарная кавычка');
          break;
        }
        addPart({ kind: 'single', start: i, end: r.end, raw: s.slice(i + 1, r.end - 1), value: r.value });
        i = r.end;
        continue;
      }
      if (isDoubleQuote(ch, ps)) {
        const r = scanDouble(s, i + 1, dialect);
        if (!r) {
          fail('незакрытая двойная кавычка');
          break;
        }
        addPart({ kind: 'double', start: i, end: r.end, raw: s.slice(i + 1, r.end - 1), value: r.value, hasSubstitution: r.hasSubstitution, hasExpansion: r.hasExpansion, hasUnescapedSpecial: r.hasUnescapedSpecial, ambiguous: r.ambiguous });
        i = r.end;
        continue;
      }

      // --- экранирование вне кавычек ---
      if ((!ps && ch === '\\') || (ps && ch === '`')) {
        if (i + 1 >= n) {
          addBare(i, i + 1, ch);
          i += 1;
          continue;
        }
        if (!ps && s[i + 1] === '\n') {
          i += 2; // продолжение строки — ничего не даёт, токен не рвётся
          continue;
        }
        // PowerShell, бэктик перед CR/LF (проверено запуском, ревью B2 раунд 3): отдельно
        // стоящий — продолжение строки, и LF после `<CR> тоже не разделитель
        // (`a `<CR><LF>b` → a, b); приклеенный к слову — буквальный символ в слове
        // (`--x`<CR>ni` → `--x\rni`), а LF после него — обычный разделитель
        // (`--x`<CR><LF>ni PWNED` — два statement'а, ni выполняется). bash: `\`+CR —
        // буквальный CR в слове (Linux); msys удаляет CR и склеивает строки — в обоих
        // случаях слово с CR не даёт cli-вызова (core.mjs: такой токен не инертен).
        if (ps && (s[i + 1] === '\n' || s[i + 1] === '\r')) {
          if (tok) {
            addBare(i, i + 2, s[i + 1]);
            i += 2;
            continue;
          }
          i += s[i + 1] === '\r' && s[i + 2] === '\n' ? 3 : 2;
          continue;
        }
        addBare(i, i + 2, s[i + 1]);
        i += 2;
        continue;
      }

      // --- $: раскрытия и подстановки ---
      if (ch === '$') {
        const next = s[i + 1];
        if (!ps && next === "'") {
          const r = scanAnsi(s, i + 2);
          if (!r) {
            fail("незакрытая $'…'");
            break;
          }
          addPart({ kind: 'ansi', start: i, end: r.end, raw: s.slice(i + 2, r.end - 1), value: r.value });
          i = r.end;
          continue;
        }
        if (!ps && next === '"') {
          const r = scanDouble(s, i + 2, dialect);
          if (!r) {
            fail('незакрытая двойная кавычка');
            break;
          }
          addPart({ kind: 'double', start: i, end: r.end, raw: s.slice(i + 2, r.end - 1), value: r.value, hasSubstitution: r.hasSubstitution, hasExpansion: r.hasExpansion, hasUnescapedSpecial: r.hasUnescapedSpecial, ambiguous: r.ambiguous });
          i = r.end;
          continue;
        }
        if (next === '(' || next === '{') {
          const j = next === '(' ? findClosingParen(s, i + 2, dialect) : findClosingBrace(s, i + 2, dialect);
          if (j < 0) {
            fail(next === '(' ? 'незакрытая подстановка $(…)' : 'незакрытая ${…}');
            break;
          }
          addRegion(i, j + 1, { substitution: true, expansion: next === '{' });
          i = j + 1;
          continue;
        }
        const nameStart = ps ? PS_NAME_START : POSIX_NAME_START;
        addBare(i, i + 1, '$', { expansion: next !== undefined && nameStart.test(next) });
        i += 1;
        continue;
      }

      // --- POSIX: `…`, скобки, редиректы, heredoc ---
      if (!ps) {
        if (ch === '`') {
          const j = findClosingBacktick(s, i + 1);
          if (j < 0) {
            fail('незакрытая подстановка `…`');
            break;
          }
          addRegion(i, j + 1, { substitution: true });
          i = j + 1;
          continue;
        }
        if (ch === '(' || ch === ')') {
          // Открытые скобки: true — скобка арифметики `((` (или её внутренняя пара), 'array' —
          // список присваивания массива `a=(…)`. Ревью C2 r3 (2026-09-22, HIGH): `a=(<<E)` для
          // bash синтаксическая ошибка, heredoc в очередь НЕ ставится, следующие строки bash
          // ВЫПОЛНЯЕТ, а сканер уводил их в тело — запись оттуда была не видна.
          if (ch === '(') {
            const arith = s[i + 1] === '(' || (parenStack[parenStack.length - 1] === true && s[i - 1] === '(');
            markArith(i);
            parenStack.push(arith ? true : (s[i - 1] === '=' ? 'array' : false));
          } else {
            parenStack.pop();
          }
          endSeg(ch);
          i += 1;
          continue;
        }
        if ((ch === '<' || ch === '>') && s[i + 1] === '(') {
          const j = findClosingParen(s, i + 2, dialect);
          if (j < 0) {
            fail('незакрытая подстановка процесса');
            break;
          }
          addRegion(i, j + 1, { substitution: true, redirect: true });
          i = j + 1;
          continue;
        }
        // `<<<` — here-string, не heredoc: оператор ввода, дальше обычное слово (раунд 3 ревью
        // C2, 2026-09-22 — сканер резал его на `<` + heredoc, телом становились следующие
        // строки, и `cat <<< EOF` прятал команду после строки со словом EOF).
        if (ch === '<' && s[i + 1] === '<' && s[i + 2] === '<') {
          addBare(i, i + 3, '<<<', { redirect: true });
          lastOpEnd = i + 3;
          i += 3;
          continue;
        }
        if (ch === '<' && s[i + 1] === '<') {
          // `(( … ))` — арифметика, там `<<` сдвиг, а не heredoc (проверено запуском bash 5.2:
          // `(( x = 1 << 2 ))` следующие строки телом не считает). Раунд 3 ревью C2: разбор
          // расходился с shell'ом и прятал команды — отказываемся разбирать.
          if (parenStack.includes(true) || parenStack.includes('array')) {
            fail(parenStack.includes(true) ? 'heredoc внутри (( ))' : 'heredoc внутри списка массива a=(…)');
            break;
          }
          const j = parseHeredocOp(i);
          if (j < 0) {
            fail('heredoc без разделителя');
            break;
          }
          i = j;
          continue;
        }
      }

      // --- PowerShell: (…) @(…) {…} @{…} выполняются/не литерал; `)` вне области — обрыв ---
      if (ps) {
        if (ch === '(' || ch === '{' || (ch === '@' && (s[i + 1] === '(' || s[i + 1] === '{'))) {
          const open = ch === '@' ? i + 1 : i;
          const j = s[open] === '(' ? findClosingParen(s, open + 1, dialect) : findClosingBrace(s, open + 1, dialect);
          if (j < 0) {
            fail('незакрытая скобка');
            break;
          }
          addRegion(i, j + 1, { substitution: true });
          i = j + 1;
          continue;
        }
        if (ch === ')') {
          endSeg(')');
          i += 1;
          continue;
        }
      }

      if (ch === '<' || ch === '>') {
        addBare(i, i + 1, ch, { redirect: true });
        lastOpEnd = i + 1;
        i += 1;
        continue;
      }

      addBare(i, i + 1, ch);
      i += 1;
    }
  } catch (err) {
    if (!(err instanceof NestingError)) throw err;
    fail(err.message);
  }

  if (ok) {
    endSeg(null);
    trailingSep = sepBefore; // после endSeg(null): null, если последний сегмент непустой
    if (pendingHeredocs.length > 0) fail('heredoc не закрыт');
  }
  const result = { ok, dialect, segments, trailingSep };
  if (error) result.error = error;
  return result;
}

/**
 * Литерал в одинарных кавычках с тем же буквальным значением. POSIX: апостроф —
 * `'\''` (закрыть-экранировать-открыть; сканер видит это как один токен с
 * `quote: 'mixed'`), PowerShell: удвоение — для `'` и для типографских ‘ ’ ‚ ‛, иначе
 * `’` из лейбла закрыл бы строку ('Переход ’’ к $X' → Переход ’ к $X, проверено).
 * @param {string} value
 * @param {Dialect} [dialect='posix']
 * @returns {string}
 */
export function toSingleQuoted(value, dialect = 'posix') {
  const v = String(value ?? '');
  return dialect === 'powershell'
    ? `'${v.replace(/['‘’‚‛]/g, (q) => q + q)}'`
    : `'${v.replace(/'/g, "'\\''")}'`;
}

// --- ЗАДАЧА C2 (2026-09-22): слова, редиректы, раскрытие, вложенные скрипты -------------
//
// Разбор записи через shell (actions.mjs detectShellWrites) раньше держал свой трекер кавычек
// (`maskQuotedRegions`): `\"` внутри "…" открывал для него незакрытую кавычку — редирект после
// `;` пропадал (ревью B2, round 3). Всё, что нужно разбору записи, строится здесь поверх
// scanCommand: без своего токенайзера, с тем же правилом «не понял — не литерал».

/**
 * Слово команды после отделения редиректов (части — как у Token).
 * @typedef {object} Word
 * @property {'word'} kind
 * @property {number} start
 * @property {number} end
 * @property {string} text
 * @property {TokenPart[]} parts
 * @property {string|null} value буквальное значение или null (есть раскрытие/подстановка)
 * @property {'none'|'single'|'double'|'ansi'|'mixed'} quote
 * @property {boolean} hasSubstitution
 * @property {boolean} hasExpansion
 */

/**
 * @typedef {object} Redirect
 * @property {string|null} fd дескриптор перед оператором (`2`, PowerShell `*`) или null
 * @property {string} op `>` `>>` `>|` `>&` `&>` `&>>` `<>` `<` `<&` `<<` `<<-`
 * @property {Word|null} target цель; null — у оператора цели нет (heredoc; синтаксическая
 *   ошибка вида `> >f` или `>` в конце команды)
 * @property {number} start
 */

// Порядок важен: длинные операторы раньше коротких. `<<<` — here-string: ввод из слова,
// не heredoc (раунд 3 ревью C2, 2026-09-22).
const POSIX_REDIRECT_OPS = ['&>>', '&>', '>>', '>|', '>&', '<<<', '<<-', '<<', '<>', '<&', '>', '<'];
// PowerShell: `>`, `>>`, `N>`, `*>`, `N>&1` (проверено запуском PS 5.1); `&>` в PowerShell нет,
// но сканер помечает `&` перед `>` как редирект — считаем записью (ложный отказ допустим).
const PS_REDIRECT_OPS = ['&>>', '&>', '>>', '>&', '>', '<'];

function barePiece(part, from, to, ps) {
  const raw = part.raw.slice(from, to);
  const esc = ps ? '`' : '\\';
  const nameStart = ps ? PS_NAME_START : POSIX_NAME_START;
  let value = '';
  let hasExpansion = false;
  for (let k = 0; k < raw.length; k += 1) {
    if (raw[k] === esc && k + 1 < raw.length) {
      value += raw[k + 1];
      k += 1;
      continue;
    }
    if (raw[k] === '$' && k + 1 < raw.length && nameStart.test(raw[k + 1])) hasExpansion = true;
    value += raw[k];
  }
  return { kind: 'bare', start: part.start + from, end: part.start + to, raw, value, hasSubstitution: false, hasExpansion, hasUnescapedSpecial: false, ambiguous: false, redirect: false };
}

function makeWord(parts, command) {
  const start = parts[0].start;
  const end = parts[parts.length - 1].end;
  const quoted = parts.filter((p) => p.kind === 'single' || p.kind === 'double' || p.kind === 'ansi');
  const hasSubstitution = parts.some((p) => p.hasSubstitution);
  const hasExpansion = parts.some((p) => p.hasExpansion);
  return {
    kind: 'word',
    start,
    end,
    text: command.text.slice(start - command.start, end - command.start),
    parts,
    quote: quoted.length === 0 ? 'none' : parts.length === 1 ? quoted[0].kind : 'mixed',
    value: hasSubstitution || hasExpansion ? null : parts.map((p) => p.value).join(''),
    hasSubstitution,
    hasExpansion,
  };
}

/**
 * Делит простую команду на слова и редиректы. Оператор может стоять внутри токена
 * (`echo x>f` — bash пишет «x» в f, проверено запуском): bash делит слово на
 * метасимволах `<` `>`. PowerShell `a>b` в середине слова — литерал (проверено), здесь
 * он всё равно считается редиректом: ложный отказ допустим, ложное разрешение — нет.
 * Цифры (PowerShell — и `*`) вплотную перед оператором в начале слова — дескриптор.
 *
 * @param {Command} command
 * @param {Dialect} [dialect='posix']
 * @returns {{words: Word[], redirects: Redirect[]}}
 */
export function splitRedirects(command, dialect = 'posix') {
  const ps = dialect === 'powershell';
  const ops = ps ? PS_REDIRECT_OPS : POSIX_REDIRECT_OPS;
  const esc = ps ? '`' : '\\';
  const fdRe = ps ? /^(?:\d+|\*)$/ : /^\d+$/;
  const words = [];
  const redirects = [];
  let parts = [];
  let pending = null;
  const flush = () => {
    if (parts.length === 0) return;
    const w = makeWord(parts, command);
    parts = [];
    if (pending) {
      pending.target = w;
      redirects.push(pending);
      pending = null;
    } else {
      words.push(w);
    }
  };
  for (const tok of command.tokens) {
    for (const part of tok.parts) {
      if (part.kind !== 'bare' || !part.redirect) {
        parts.push(part);
        continue;
      }
      const raw = part.raw;
      let from = 0;
      let k = 0;
      while (k < raw.length) {
        if (raw[k] === esc) {
          k += 2;
          continue;
        }
        const isOp = raw[k] === '<' || raw[k] === '>' || (raw[k] === '&' && raw[k + 1] === '>');
        const op = isOp ? ops.find((o) => raw.startsWith(o, k)) : undefined;
        if (!op) {
          k += 1;
          continue;
        }
        const lead = raw.slice(from, k);
        let fd = null;
        if (parts.length === 0 && lead && fdRe.test(lead)) fd = lead;
        else if (lead) parts.push(barePiece(part, from, k, ps));
        flush();
        if (pending) redirects.push(pending); // `> >f` — у первого оператора цели нет
        pending = { fd, op, target: null, start: part.start + (fd ? from : k) };
        k += op.length;
        from = k;
        if (op === '<<' || op === '<<-') {
          // heredoc: остаток части — разделитель (тело сканер уже отнёс к command.heredocs)
          redirects.push(pending);
          pending = null;
          k = raw.length;
          from = k;
        }
      }
      if (from < raw.length) parts.push(barePiece(part, from, raw.length, ps));
    }
    flush(); // граница токена; оператор без цели в этом токене ждёт следующий
  }
  if (pending) redirects.push(pending);
  return { words, redirects };
}

/**
 * Слово без первых `n` символов первой (незакавыченной) части — значение присваивания
 * `NAME=value` без `NAME=`. Префикс не должен содержать escape'ов (вызывающий проверяет).
 * @param {Word} word
 * @param {number} n
 * @param {Command} command
 * @returns {Word|null} null — значение пустое
 */
export function wordAfterPrefix(word, n, command) {
  const [first, ...rest] = word.parts;
  const parts = first.raw.length > n ? [barePiece(first, n, first.raw.length, false), ...rest] : rest;
  return parts.length === 0 ? null : makeWord(parts, command);
}

const SIMPLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PS_BRACED_VAR_RE = /^(?:(env|global|script|local|private):)?([A-Za-z_][A-Za-z0-9_]*)$/i;
const PS_SCOPES = new Set(['global', 'script', 'local', 'private']);

// Раскрытие текста части: "…" (quoted) или незакавыченного (bare) в acc. false — не вычислить.
function expandText(raw, ps, lookup, quoted, assignment, acc) {
  let k = 0;
  const n = raw.length;
  while (k < n) {
    const ch = raw[k];
    if (!ps && ch === '\\') {
      const next = raw[k + 1];
      if (next === undefined) {
        acc.value += ch;
        k += 1;
        continue;
      }
      if (!quoted) acc.value += next;
      else if (next === '\n') {
        // экранированный перевод строки исчезает
      } else if ('$`"\\'.includes(next)) acc.value += next;
      else acc.value += ch + next;
      k += 2;
      continue;
    }
    if (ps && ch === '`') {
      // Бэктик в пути — не литерал: вне кавычек он экранирует и wildcard'ы Set-Location/-Path
      // (ревью B3, проверено запуском), в "…" `n `t `r превращаются в управляющие символы.
      const next = raw[k + 1];
      if (quoted && next !== undefined && (next === '$' || next === '`' || PS_DOUBLE_QUOTES.has(next))) {
        acc.value += next;
        k += 2;
        continue;
      }
      return false;
    }
    if (ps && quoted && PS_DOUBLE_QUOTES.has(ch) && PS_DOUBLE_QUOTES.has(raw[k + 1])) {
      acc.value += raw[k + 1];
      k += 2;
      continue;
    }
    if (!ps && ch === '`') return false;
    if (ch === '$') {
      const next = raw[k + 1];
      if (next === '(') return false;
      let ref = null;
      let end = k + 1;
      if (next === '{') {
        const j = findClosing(raw, k + 2, ps ? 'powershell' : 'posix', '{', '}', 2);
        if (j < 0) return false;
        const inner = raw.slice(k + 2, j);
        if (ps) {
          const m = PS_BRACED_VAR_RE.exec(inner);
          if (!m) return false;
          ref = { name: m[2], env: (m[1] ?? '').toLowerCase() === 'env', quoted };
        } else {
          if (!SIMPLE_NAME_RE.test(inner)) return false;
          ref = { name: inner, env: false, quoted };
        }
        end = j + 1;
      } else if (next !== undefined && /[A-Za-z_]/.test(next)) {
        let j = k + 1;
        while (j < n && /[A-Za-z0-9_]/.test(raw[j])) j += 1;
        let name = raw.slice(k + 1, j);
        let env = false;
        if (ps && raw[j] === ':') {
          // $env:X, $script:X …; прочие квалификаторы (`$C:x` — путь провайдера) — не литерал
          const scope = name.toLowerCase();
          if (scope !== 'env' && !PS_SCOPES.has(scope)) return false;
          let q = j + 1;
          if (q >= n || !/[A-Za-z_]/.test(raw[q])) return false;
          while (q < n && /[A-Za-z0-9_]/.test(raw[q])) q += 1;
          name = raw.slice(j + 1, q);
          env = scope === 'env';
          j = q;
        }
        // PowerShell вне кавычек: `$x.Length`, `$x[0]` — доступ к члену/индексу (проверено запуском)
        if (ps && !quoted && (raw[j] === '.' || raw[j] === '[')) return false;
        ref = { name, env, quoted };
        end = j;
      } else if (next !== undefined && (ps ? /[?^$]/ : /[0-9@*#?$!-]/).test(next)) {
        return false; // спецпараметры ($1 $@ $? $$ …) — значение неизвестно
      } else {
        acc.value += '$';
        k += 1;
        continue;
      }
      const v = lookup(ref);
      if (typeof v !== 'string') return false;
      // POSIX вне кавычек: результат делится по IFS и раскрывается как шаблон
      if (!ps && !quoted && !assignment && /[\s*?[\]]/.test(v)) return false;
      if (ps && /[*?[]/.test(v)) acc.glob = true;
      acc.value += v;
      k = end;
      continue;
    }
    if (ps && !quoted && ch === ',') return false; // a,b — массив аргументов
    if (ps || !quoted) {
      if ('*?['.includes(ch)) acc.glob = true;
      if (!ps && (ch === '{' || ch === '}')) acc.brace = true;
    }
    acc.value += ch;
    k += 1;
  }
  return true;
}

/**
 * Значение слова после раскрытия переменных — или null, если shell получил бы что-то,
 * чего нельзя вычислить однозначно: подстановка команды, спецпараметр, сложное `${…}`,
 * переменная, которую lookup не знает, PowerShell-бэктик в пути, доступ к члену `$x.y`.
 * `lookup({ name, env, quoted, tilde })` возвращает строку или null.
 *
 * `glob`/`brace` — в тексте, который shell раскроет как шаблон, есть `*?[` / `{}` (POSIX —
 * только вне кавычек; PowerShell — wildcard'ы -Path в любых кавычках). Тильда: POSIX — `~`
 * и `~/…` вне кавычек в начале слова (и значения присваивания), `~+` — $PWD, прочие формы
 * (`~user`, `~-`, `a=~`, `a:~`) — не литерал; PowerShell — `~` в начале значения в любых
 * кавычках (Set-Content -Path/-LiteralPath '~\x' пишут в домашний каталог — проверено запуском).
 *
 * @param {Word|Token} word
 * @param {Dialect} dialect
 * @param {(ref: {name?: string, env?: boolean, quoted?: boolean, tilde?: string}) => string|null} lookup
 * @param {{assignment?: boolean}} [opts] assignment — значение `NAME=…`: без деления и шаблонов
 * @returns {{value: string, glob: boolean, brace: boolean}|null}
 */
export function expandWord(word, dialect, lookup, { assignment = false } = {}) {
  const ps = dialect === 'powershell';
  const acc = { value: '', glob: false, brace: false };
  const parts = word.parts ?? [];
  try {
    for (let pi = 0; pi < parts.length; pi += 1) {
      const p = parts[pi];
      if (p.kind === 'single' || p.kind === 'ansi') {
        if (ps && /[*?[]/.test(p.value)) acc.glob = true;
        acc.value += p.value;
        continue;
      }
      if (p.kind === 'double') {
        if (!expandText(p.raw, ps, lookup, true, assignment, acc)) return null;
        continue;
      }
      if (p.kind === 'bare') {
        let raw = p.raw;
        if (!ps) {
          if (/[=:]~/.test(raw)) return null; // bash раскрывает `~` после `=`/`:` (ревью B3)
          if (pi === 0 && raw.startsWith('~')) {
            const slash = raw.search(/[\\/]/);
            if (slash === -1 && parts.length > 1) return null; // часть префикса тильды в кавычках
            const prefix = slash === -1 ? raw : raw.slice(0, slash);
            if (prefix !== '~' && prefix !== '~+') return null;
            const home = lookup({ tilde: prefix });
            if (typeof home !== 'string') return null;
            acc.value += home;
            raw = raw.slice(prefix.length);
          }
        }
        if (!expandText(raw, ps, lookup, false, assignment, acc)) return null;
        continue;
      }
      // Область подстановки: раскрывается только ${NAME} (PowerShell — и ${env:NAME}).
      const raw = p.raw;
      if (!raw.startsWith('${') || !raw.endsWith('}')) return null;
      const inner = raw.slice(2, -1);
      let ref;
      if (ps) {
        const m = PS_BRACED_VAR_RE.exec(inner);
        if (!m) return null;
        ref = { name: m[2], env: (m[1] ?? '').toLowerCase() === 'env', quoted: false };
      } else {
        if (!SIMPLE_NAME_RE.test(inner)) return null;
        ref = { name: inner, env: false, quoted: false };
      }
      const v = lookup(ref);
      if (typeof v !== 'string') return null;
      if (!ps && !assignment && /[\s*?[\]]/.test(v)) return null;
      if (ps && /[*?[]/.test(v)) acc.glob = true;
      acc.value += v;
    }
  } catch (err) {
    if (err instanceof NestingError) return null;
    throw err;
  }
  if (ps && acc.value.startsWith('~')) {
    if (!/^~(?:[\\/]|$)/.test(acc.value)) return null;
    const home = lookup({ tilde: '~' });
    if (typeof home !== 'string') return null;
    acc.value = home + acc.value.slice(1);
  }
  return acc;
}

function unescapeBacktickBody(body) {
  return body.replace(/\\([`\\$])/g, '$1');
}

// Содержимое `$( … )` — это арифметическая подстановка `$(( … ))`, а не подстановка команды?
// Правило bash (chk_arithsub, subst.c): содержимое начинается с `(`, кончается `)`, и между
// ними скобки сбалансированы; кавычки и `\` пропускаются целиком. Раунд 5 (2026-09-22, LOW-4):
// проверено запуском bash 5.2 msys — `echo $(( 5 > 3 ))` печатает 1 и файла `3` не создаёт
// (детектор давал фантомную цель <cwd>/3), а `echo $((cd x) && (touch y))` и `echo $((ls) > c)`
// bash ВЫПОЛНЯЕТ как подстановку команды (y и c создаются) — их разбирать по-прежнему нужно.
function isArithSubst(inner) {
  if (!inner.startsWith('(') || !inner.endsWith(')') || inner.length < 2) return false;
  const body = inner.slice(1, -1);
  let count = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === "'") {
      const j = body.indexOf("'", i + 1);
      if (j < 0) return false;
      i = j;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < body.length && body[j] !== '"') j += body[j] === '\\' ? 2 : 1;
      if (j >= body.length) return false;
      i = j;
      continue;
    }
    if (ch === '(') count += 1;
    else if (ch === ')') {
      count -= 1;
      if (count < 0) return false;
    }
  }
  return count === 0;
}

// Содержимое `$( … )`: подстановка команды уходит в разбор как есть, арифметика — обёрнутой
// назад в `(( … ))`, чтобы сканер разметил её сегменты как арифметические (тогда `>` внутри
// не редирект), а остальной разбор не менялся: подстановки внутри арифметики выполняются
// (`$(( $(touch f; echo 1) + 1 ))` создаёт f, проверено запуском), и присваивание с
// динамическим именем (`$(( x = 1, $n = 5 ))`) по-прежнему делает переменные неизвестными.
function pushSubstScript(inner, ps, out) {
  out.scripts.push(!ps && isArithSubst(inner) ? `(${inner})` : inner);
}

// Подстановки внутри текста "…" или тела heredoc: $(…), `…` (POSIX), ${…}.
function collectFromText(raw, ps, out) {
  const dialect = ps ? 'powershell' : 'posix';
  let k = 0;
  while (k < raw.length) {
    const ch = raw[k];
    if ((!ps && ch === '\\') || (ps && ch === '`')) {
      k += 2;
      continue;
    }
    if (ch === '$' && raw[k + 1] === '(') {
      const j = findClosing(raw, k + 2, dialect, '(', ')', 2);
      if (j < 0) {
        out.opaque = true;
        return;
      }
      pushSubstScript(raw.slice(k + 2, j), ps, out);
      k = j + 1;
      continue;
    }
    if (ch === '$' && raw[k + 1] === '{') {
      const j = findClosing(raw, k + 2, dialect, '{', '}', 2);
      if (j < 0) {
        out.opaque = true;
        return;
      }
      collectFromRegion(raw.slice(k, j + 1), ps, out);
      k = j + 1;
      continue;
    }
    if (!ps && ch === '`') {
      const j = findClosingBacktick(raw, k + 1);
      if (j < 0) {
        out.opaque = true;
        return;
      }
      out.scripts.push(unescapeBacktickBody(raw.slice(k + 1, j)));
      k = j + 1;
      continue;
    }
    k += 1;
  }
}

function collectFromRegion(raw, ps, out) {
  if (raw.startsWith('${')) {
    const inner = raw.slice(2, -1);
    if (ps ? PS_BRACED_VAR_RE.test(inner) : SIMPLE_NAME_RE.test(inner)) return;
    if (ps) {
      out.opaque = true; // ${…} PowerShell — имя переменной/путь провайдера; иное — не разбираем
      return;
    }
    // POSIX ${X:-…}, ${X:=…}, ${a[i]} …: внутри могут быть $(…) — выполняются
    out.braces.push(inner);
    collectFromText(inner, ps, out);
    return;
  }
  if (!ps) {
    if (raw.startsWith('$(')) {
      pushSubstScript(raw.slice(2, -1), ps, out);
      return;
    }
    if (raw.startsWith('<(') || raw.startsWith('>(')) out.scripts.push(raw.slice(2, -1));
    else if (raw.startsWith('`')) out.scripts.push(unescapeBacktickBody(raw.slice(1, -1)));
    else out.opaque = true;
    return;
  }
  if (raw.startsWith('$(') || raw.startsWith('@(') || raw.startsWith('@{')) out.scripts.push(raw.slice(2, -1));
  else if (raw.startsWith('(') || raw.startsWith('{')) out.scripts.push(raw.slice(1, -1));
  else out.opaque = true;
}

/**
 * Тексты вложенных скриптов, которые shell выполнит при раскрытии слова: `$(…)`, `` `…` ``,
 * `<(…)`, `>(…)` (POSIX), `$(…)`, `(…)`, `@(…)`, `{…}`, `@{…}` (PowerShell) — в частях
 * слова и внутри "…"; для heredoc с незакавыченным разделителем — в его теле. `braces` —
 * содержимое POSIX `${…}` сложной формы (`${X:=v}` присваивает X). `opaque` — вложенность
 * разобрать не удалось.
 *
 * @param {Word|Token} word слово, токен или тело heredoc (`kind: 'heredoc'`)
 * @param {Dialect} [dialect='posix']
 * @returns {{scripts: string[], braces: string[], opaque: boolean}}
 */
export function nestedScripts(word, dialect = 'posix') {
  const ps = dialect === 'powershell';
  const out = { scripts: [], braces: [], opaque: false };
  try {
    if (word.kind === 'heredoc') {
      if (word.value === null) collectFromText(word.text, ps, out);
      return out;
    }
    for (const p of word.parts ?? []) {
      if (p.kind === 'subst') collectFromRegion(p.raw, ps, out);
      else if (p.kind === 'double') collectFromText(p.raw, ps, out);
    }
  } catch (err) {
    if (!(err instanceof NestingError)) throw err;
    out.opaque = true;
  }
  return out;
}
