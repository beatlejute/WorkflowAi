import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';

import { expandWord, nestedScripts, scanCommand, splitRedirects, toSingleQuoted } from '../rails/shell-scan.mjs';

// ЗАДАЧА B2 (2026-09-22): единый разбор строки shell-команды для ядра рельс.
// Поведение bash/PowerShell, на которое опираются ожидания ниже, проверено запуском
// (см. шапку shell-scan.mjs); последний блок тестов сверяет разбор с настоящим shell'ом.

// Токены первой команды первого сегмента: [text, value, quote].
function toks(command, dialect = 'posix', seg = 0, cmd = 0) {
  const r = scanCommand(command, dialect);
  assert.equal(r.ok, true, `ожидался ok=true для ${JSON.stringify(command)}: ${r.error}`);
  return r.segments[seg].commands[cmd].tokens.map((t) => [t.text, t.value, t.quote]);
}

function seps(command, dialect = 'posix') {
  const r = scanCommand(command, dialect);
  assert.equal(r.ok, true, r.error);
  return r.segments.map((s) => [s.sepBefore, s.commands.map((c) => c.tokens.map((t) => t.text))]);
}

// --- POSIX: токены, кавычки, позиции -------------------------------------------------

test('scan posix: типы кавычек и позиции токенов сохраняются', () => {
  const cmd = `node cli.mjs goto P --quote "a b" 'c' $'d\\n' e"f"g`;
  const r = scanCommand(cmd, 'posix');
  assert.equal(r.ok, true);
  const t = r.segments[0].commands[0].tokens;
  assert.deepEqual(t.map((x) => x.quote), ['none', 'none', 'none', 'none', 'none', 'double', 'single', 'ansi', 'mixed']);
  assert.deepEqual(t.map((x) => x.value), ['node', 'cli.mjs', 'goto', 'P', '--quote', 'a b', 'c', 'd\n', 'efg']);
  for (const x of t) assert.equal(cmd.slice(x.start, x.end), x.text, 'text = исходная строка [start, end)');
  assert.equal(r.segments[0].commands[0].end, cmd.length);
});

test('scan posix: в "…" бэкслеш снимается только перед $ ` " \\ и переводом строки', () => {
  const [[, value]] = toks(`"\\$X \\\`y\\\` \\\\ \\a \\"q\\" tail"`);
  assert.equal(value, '$X `y` \\ \\a "q" tail');
  const [[, joined]] = toks('"ab\\\ncd"');
  assert.equal(joined, 'abcd');
});

test('scan posix: неэкранированные ` и $ в "…" — hasUnescapedSpecial, экранированные — нет', () => {
  const clean = scanCommand('x "cost \\$X and \\`y\\`"').segments[0].commands[0].tokens[1];
  assert.equal(clean.parts[0].hasUnescapedSpecial, false);
  assert.equal(clean.value, 'cost $X and `y`');
  const dirty = scanCommand('x "cost $X"').segments[0].commands[0].tokens[1];
  assert.equal(dirty.parts[0].hasUnescapedSpecial, true);
  assert.equal(dirty.hasExpansion, true);
  assert.equal(dirty.value, null, 'значение с раскрытием — не литерал');
  const sub = scanCommand('x "a `date` b $(id) c"').segments[0].commands[0].tokens[1];
  assert.equal(sub.hasSubstitution, true);
  assert.equal(sub.parts[0].value, 'a `date` b $(id) c', 'подстановки копируются как текст');
});

test('scan posix: `\\"` внутри "…" не закрывает кавычку — `;` после неё виден как разделитель (pre-existing дефект старых трекеров)', () => {
  const s = seps('node cli.mjs goto P --quote "a \\" b" ; touch PWNED ; echo "x"');
  assert.equal(s.length, 3);
  assert.deepEqual(s.map((x) => x[0]), [null, ';', ';']);
  assert.deepEqual(s[1][1][0], ['touch', 'PWNED']);
  assert.equal(toks('node cli.mjs goto P --quote "a \\" b" ; touch PWNED')[5][1], 'a " b');
});

test("scan posix: апостроф через '\\'' и '\"'\"' — один токен с буквальным апострофом", () => {
  assert.deepEqual(toks("x 'it'\\''s' tail")[1], ["'it'\\''s'", "it's", 'mixed']);
  assert.deepEqual(toks(`x 'it'"'"'s' tail`)[1], [`'it'"'"'s'`, "it's", 'mixed']);
  assert.deepEqual(toks("x 'a'\\''b'\\''c' | head")[1][1], "a'b'c");
});

test('scan posix: $\'…\' — ANSI-C escape-последовательности', () => {
  assert.deepEqual(toks(`x $'it\\'s \\\\ \\"q\\" \\x41\\n\\q'`)[1], [`$'it\\'s \\\\ \\"q\\" \\x41\\n\\q'`, "it's \\ \"q\" A\n\\q", 'ansi']);
  assert.equal(toks(`x "a $'b' c"`)[1][1], "a $'b' c", "$'…' внутри \"…\" — обычный текст");
});

// --- POSIX: разделители, пайпы, редиректы --------------------------------------------

test('scan posix: разделители верхнего уровня && || ; & и перевод строки, `|` делит команды внутри сегмента', () => {
  const s = seps('a && b || c ; d | e |& f & g\nh');
  assert.deepEqual(s.map((x) => x[0]), [null, '&&', '||', ';', '&', '\n']);
  assert.deepEqual(s[3][1], [['d'], ['e'], ['f']]);
});

test('scan posix: разделители внутри кавычек и подстановок не делят', () => {
  assert.equal(seps(`a "x ; y | z && w" 'p & q' $'r\\n;s' $(echo "a;b") \`echo c;d\``).length, 1);
});

test('scan posix: 2>&1, >&2, &>/dev/null — редиректы, не разделители', () => {
  const s = seps('node cli.mjs status 2>&1 >&2 &>/dev/null && node cli.mjs status');
  assert.equal(s.length, 2);
  const t = scanCommand('node cli.mjs status 2>&1 > out.txt').segments[0].commands[0].tokens;
  assert.deepEqual(t.map((x) => [x.text, x.redirect]), [['node', false], ['cli.mjs', false], ['status', false], ['2>&1', true], ['>', true], ['out.txt', false]]);
});

test('scan posix: ( и ) — разделители сегментов; при пустом сегменте структурный разделитель ( ) & не теряется за соседним ;/&&', () => {
  assert.deepEqual(seps('(a; b) && c').map((x) => x[0]), ['(', ';', ')']);
  assert.deepEqual(seps('a && b) ; c').map((x) => x[0]), [null, '&&', ')']);
  assert.deepEqual(seps('a && (b)').map((x) => x[0]), [null, '(']);
  assert.deepEqual(seps('\n\na ;; b').map((x) => x[0]), [null, ';'], 'ведущие переводы строки ничего не значат');
});

test('scan posix: пустые сегменты (;; хвостовой перевод строки) опускаются', () => {
  assert.equal(seps('a ;; b\n\n').length, 2);
  assert.deepEqual(seps('a\n')[0][1], [['a']]);
});

test('scan posix: комментарий # в начале слова — до конца строки; внутри слова — не комментарий', () => {
  assert.deepEqual(seps('a # b ; c\nd'), [[null, [['a']]], ['\n', [['d']]]]);
  assert.deepEqual(toks('a#b c')[0], ['a#b', 'a#b', 'none']);
});

test('scan posix: бэкслеш-перевод строки склеивает токен, бэкслеш вне кавычек экранирует символ', () => {
  assert.deepEqual(toks('a\\\nb c')[0], ['a\\\nb', 'ab', 'none']);
  assert.equal(toks('a \\\nb').length, 2);
  assert.deepEqual(toks('a\\ b \\$X \\;')[0], ['a\\ b', 'a b', 'none']);
  assert.equal(seps('a\\ b \\$X \\;').length, 1, 'экранированный ; не разделитель');
});

// --- POSIX: подстановки и heredoc -----------------------------------------------------

test('scan posix: $(…) `…` <(…) ${…} — подстановки, $NAME — только раскрытие', () => {
  const t = scanCommand('node cli.mjs status $(touch P) `touch Q` <(touch R) ${X:-y} $HOME "$(id)"').segments[0].commands[0].tokens;
  assert.deepEqual(t.slice(3).map((x) => [x.hasSubstitution, x.hasExpansion, x.value]), [
    [true, false, null],
    [true, false, null],
    [true, false, null],
    [true, true, null],
    [false, true, null],
    [true, false, null],
  ]);
});

test('scan posix: "…" внутри $(…) внутри "…" не закрывает внешние кавычки', () => {
  const t = toks('x "pre $(echo "in ; side") post" ; y');
  assert.equal(t[1][0], '"pre $(echo "in ; side") post"');
  assert.equal(seps('x "pre $(echo "in ; side") post" ; y').length, 2);
});

test('scan posix: heredoc — тело непрозрачно (разделители и кавычки внутри не делят), незакавыченный разделитель даёт подстановку', () => {
  const r = scanCommand("cat <<EOF | grep x\nline1 ; touch M && it's\n$(touch P)\nEOF\nnode cli.mjs status");
  assert.equal(r.ok, true, r.error);
  assert.equal(r.segments.length, 2);
  assert.deepEqual(r.segments[0].commands.map((c) => c.tokens.map((t) => t.text)), [['cat', '<<EOF'], ['grep', 'x']]);
  const h = r.segments[0].commands[0].heredocs[0];
  assert.equal(h.text, "line1 ; touch M && it's\n$(touch P)\n");
  assert.equal(h.hasSubstitution, true);
  assert.equal(r.segments[0].commands[0].tokens[1].redirect, true);
  assert.deepEqual(r.segments[1].commands[0].tokens.map((t) => t.text), ['node', 'cli.mjs', 'status']);

  const quoted = scanCommand("cat <<'EOF'\n$(touch P) `x`\nEOF");
  assert.equal(quoted.segments[0].commands[0].heredocs[0].hasSubstitution, false);
  const dash = scanCommand('cat <<-EOF\n\t\tbody\n\tEOF\necho done');
  assert.equal(dash.ok, true);
  assert.equal(dash.segments[0].commands[0].heredocs[0].text, '\t\tbody\n');
  assert.equal(scanCommand("cat <<<'here-string' ; b").segments.length, 2, '<<< — не heredoc');
});

test('scan posix: незакрытые кавычки/подстановки/heredoc -> ok=false', () => {
  for (const c of ['"open', "'open", "$'open", 'a $(open', 'a `open', 'a ${open', 'a <(open', 'cat <<EOF\nbody', 'a "x\\']) {
    assert.equal(scanCommand(c).ok, false, JSON.stringify(c));
  }
});

// --- PowerShell -----------------------------------------------------------------------

test("scan powershell: '' внутри '…' и \"\" внутри \"…\" — литеральная кавычка", () => {
  assert.deepEqual(toks("node x 'it''s' tail", 'powershell')[2], ["'it''s'", "it's", 'single']);
  assert.deepEqual(toks('node x "a ""b"" c" tail', 'powershell')[2], ['"a ""b"" c"', 'a "b" c', 'double']);
  assert.equal(scanCommand("node x '''", 'powershell').ok, false);
  assert.equal(scanCommand('node x """', 'powershell').ok, false);
});

test('scan powershell: в "…" снимаются только `" `$ ``; прочие `X сохраняются и помечаются', () => {
  const t = scanCommand('x "a`"b`$X`` z"', 'powershell').segments[0].commands[0].tokens[1];
  assert.equal(t.value, 'a"b$X` z');
  assert.equal(t.parts[0].hasUnescapedSpecial, false);
  const dot = scanCommand('x "из `.workflow/reports/`, оценку"', 'powershell').segments[0].commands[0].tokens[1];
  assert.equal(dot.value, 'из `.workflow/reports/`, оценку');
  assert.equal(dot.parts[0].hasUnescapedSpecial, true, 'PowerShell съел бы эти бэктики');
  assert.equal(dot.parts[0].ambiguous, false);
  // Ревью B2, раунд 3 (2026-09-22): буквенные escape'ы (`n `t `r …) — не неоднозначность:
  // агент написал именно эти два символа (лейблы `` `rails.yaml` ``, `` `tests/` ``).
  const nl = scanCommand('x "l`nm $X"', 'powershell').segments[0].commands[0].tokens[1];
  assert.equal(nl.parts[0].ambiguous, false, '`n — буквальные два символа, значение однозначно');
  assert.equal(nl.parts[0].value, 'l`nm $X');
  assert.equal(nl.parts[0].hasUnescapedSpecial, true, 'PowerShell превратил бы `n в перевод строки');
  assert.equal(nl.hasExpansion, true);
  const braces = scanCommand('x "v ${env:X}"', 'powershell').segments[0].commands[0].tokens[1];
  assert.equal(braces.parts[0].ambiguous, true, '${…} — неоднозначно');
  assert.equal(scanCommand('x "a`\nb"', 'powershell').segments[0].commands[0].tokens[1].parts[0].ambiguous, true, 'бэктик перед переводом строки — неоднозначно');
});

test('scan powershell: $(…) в "…", (…), @(…), {…}, ${…} — подстановки; $X — раскрытие', () => {
  const t = scanCommand('node x "v=$(1+1)" (ni M) @(x) {ni M} ${env:X} $Y', 'powershell').segments[0].commands[0].tokens;
  assert.deepEqual(t.slice(2).map((x) => [x.text, x.hasSubstitution, x.hasExpansion]), [
    ['"v=$(1+1)"', true, false],
    ['(ni M)', true, false],
    ['@(x)', true, false],
    ['{ni M}', true, false],
    ['${env:X}', true, true],
    ['$Y', false, true],
  ]);
  assert.equal(scanCommand("node x '$(ni M)'", 'powershell').segments[0].commands[0].tokens[2].hasSubstitution, false);
});

test('scan powershell: разделители ; | && || и перевод строки; бэктик вне кавычек экранирует; 2>$null — редирект', () => {
  const s = seps('a ; b | Select-Object -First 1 && c || d\ne', 'powershell');
  assert.deepEqual(s.map((x) => x[0]), [null, ';', '&&', '||', '\n']);
  assert.deepEqual(s[1][1], [['b'], ['Select-Object', '-First', '1']]);
  assert.deepEqual(toks('node x a`;b', 'powershell')[2], ['a`;b', 'a;b', 'none']);
  assert.equal(seps('node x a`;b', 'powershell').length, 1);
  const t = scanCommand('node x 2>$null', 'powershell').segments[0].commands[0].tokens[2];
  assert.equal(t.redirect, true);
  assert.deepEqual(toks('node a `\n b', 'powershell').map((x) => x[0]), ['node', 'a', 'b']);
});

// --- toSingleQuoted -------------------------------------------------------------------

test('toSingleQuoted: posix — \'\\\'\', powershell — \'\'; результат разбирается сканером в тот же литерал', () => {
  const v = "it's `x` $y \"q\"";
  assert.equal(toSingleQuoted(v), `'it'\\''s \`x\` $y "q"'`);
  assert.equal(toSingleQuoted(v, 'powershell'), `'it''s \`x\` $y "q"'`);
  for (const d of ['posix', 'powershell']) {
    const t = scanCommand(`x ${toSingleQuoted(v, d)}`, d).segments[0].commands[0].tokens[1];
    assert.equal(t.value, v, d);
    assert.equal(t.hasSubstitution, false);
  }
});

// --- сверка с настоящим shell: argv, который получает процесс, = value токенов ----------

const STUB_DIR = mkdtempSync(join(tmpdir(), 'rails-shell-scan-'));
const STUB = join(STUB_DIR, 'argv.mjs').replace(/\\/g, '/');
writeFileSync(STUB, 'console.log(JSON.stringify(process.argv.slice(2)));\n', 'utf8');
process.on('exit', () => rmSync(STUB_DIR, { recursive: true, force: true }));

test('scan posix + bash: буквальные значения токенов совпадают с argv настоящего bash', () => {
  const cases = [
    `'a'\\''b' "c \\" d" $'x\\ty' e\\ f "C:\\Users\\x" --quote="p q"'r' 'it'"'"'s' "cost \\$X" 'lit $X \`y\`' "" ''`,
    'a\\\nb "l1\nl2" c',
    "x --quote 'x --quote \"$X; touch PWNED; echo \"' $'y --quote \"$(z) w\"'",
  ];
  for (const args of cases) {
    const argv = JSON.parse(execSync(`node ${STUB} ${args}`, { shell: 'bash', encoding: 'utf8' }));
    const values = toks(`node ${STUB} ${args}`).slice(2).map((t) => t[1]);
    assert.deepEqual(values, argv, args);
  }
});

test('scan powershell + powershell.exe: буквальные значения токенов совпадают с argv', { skip: process.platform !== 'win32' ? 'PowerShell-специфичный тест' : false }, () => {
  // Без символа " внутри значений: Windows PowerShell 5.1 искажает его при передаче
  // в native exe независимо от нашего разбора (проверено запуском, см. отчёт B).
  const cases = [
    "'it''s' \"a`$X`` z\" a`;b 'lit $X `n' \"из `.workflow/reports/`, оценку\" --quote='p q'",
  ];
  for (const args of cases) {
    const argv = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', `node ${STUB} ${args}`], { encoding: 'utf8' }));
    const values = toks(`node ${STUB} ${args}`, 'powershell').slice(2).map((t) => t[1]);
    // Бэктики, которые PowerShell «съедает» (`. → .), сканер сохраняет намеренно
    // (см. shell-scan.mjs: hasUnescapedSpecial) — сравниваем без этого случая.
    assert.deepEqual(values.slice(0, 4), argv.slice(0, 4), args);
    assert.equal(argv[4], 'из .workflow/reports/, оценку', 'PowerShell съедает бэктики в "…"');
    assert.equal(values[4], 'из `.workflow/reports/`, оценку', 'сканер сохраняет их как написал агент');
    assert.equal(values[5], argv[5]);
  }
});

// --- ревью B2, раунд 2 (2026-09-22) -----------------------------------------------------

// HIGH: PowerShell считает кавычками и типографские ‘ ’ ‚ ‛ / “ ” „ (проверено запуском
// powershell.exe 5.1, см. шапку shell-scan.mjs). Сканер их не знал — `'a’; ni PWNED; echo ‘b'`
// был одним закавыченным токеном, команда — cli-вызовом, PowerShell выполнял `ni`.
const PS_SINGLE = ["'", '‘', '’', '‚', '‛'];
const PS_DOUBLE = ['"', '“', '”', '„'];

test('scan powershell (B2 r2, HIGH): любая типографская одинарная кавычка закрывает \'…\' — `;` после неё виден как разделитель', () => {
  for (const q of PS_SINGLE) {
    const s = seps(`node cli.mjs goto P1 --quote 'a${q}; ni PWNED; echo ‘b'`, 'powershell');
    assert.equal(s.length, 3, `кавычка U+${q.codePointAt(0).toString(16)}`);
    assert.deepEqual(s[1][1][0], ['ni', 'PWNED']);
  }
  for (const q of PS_DOUBLE) {
    const s = seps(`node cli.mjs goto P1 --quote "a${q}; ni PWNED; echo “b"`, 'powershell');
    assert.equal(s.length, 3, `кавычка U+${q.codePointAt(0).toString(16)}`);
  }
  // Класс кавычек не смешивается: ” внутри '…' и ’ внутри "…" — литералы (контроль).
  assert.equal(seps("node x 'a”; ni PWNED; echo b'", 'powershell').length, 1);
  assert.equal(seps('node x "a’; ni PWNED; echo b"', 'powershell').length, 1);
  // ‟ (U+201F) кавычкой не является.
  assert.deepEqual(toks('node x ‟a b‟ c', 'powershell').slice(2).map((t) => t[1]), ['‟a', 'b‟', 'c']);
});

test('scan powershell (B2 r2, HIGH): типографская кавычка открывает строку вне кавычек; пара подряд — литерал (второй символ пары)', () => {
  assert.deepEqual(toks('node x ’a; ni PWNED; echo b’ c', 'powershell').slice(2), [['’a; ni PWNED; echo b’', 'a; ni PWNED; echo b', 'single'], ['c', 'c', 'none']]);
  assert.deepEqual(toks('node x “a b” c', 'powershell')[2], ['“a b”', 'a b', 'double']);
  assert.equal(toks("node x 'a‘'b'", 'powershell')[2][1], "a'b");
  assert.equal(toks("node x 'a’’b'", 'powershell')[2][1], 'a’b');
  assert.equal(toks("node x 'a'‘b'", 'powershell')[2][1], 'a‘b');
  assert.equal(toks('node x "a”„b"', 'powershell')[2][1], 'a„b');
  // Бэктик перед типографской ДВОЙНОЙ кавычкой снимается (как `"), перед одинарной —
  // сохраняется и помечается hasUnescapedSpecial (как любой `X, который PowerShell съел бы).
  const bt = scanCommand('node x "a`’b `“c"', 'powershell').segments[0].commands[0].tokens[2];
  assert.equal(bt.value, 'a`’b “c');
  assert.equal(bt.parts[0].hasUnescapedSpecial, true);
  assert.equal(scanCommand("node x 'a’b'", 'powershell').ok, false, "’ закрывает 'a, следующая ' открывает и не закрыта (PS: ошибка парсера, проверено)");
  assert.equal(scanCommand('node x $(‘echo’)', 'powershell').segments[0].commands[0].tokens[2].hasSubstitution, true, 'внутри $(…) те же кавычки');
});

test('toSingleQuoted powershell (B2 r2): типографские одинарные кавычки удваиваются — иначе ’ из лейбла закрыл бы литерал', () => {
  const v = 'Переход ’ к ‘этапу’ it\'s $X `y`';
  const lit = toSingleQuoted(v, 'powershell');
  assert.equal(lit, "'Переход ’’ к ‘‘этапу’’ it''s $X `y`'");
  const t = scanCommand(`x ${lit}`, 'powershell').segments[0].commands[0].tokens[1];
  assert.equal(t.value, v);
  assert.equal(t.quote, 'single');
});

test('scan powershell + powershell.exe (B2 r2): типографские кавычки — argv совпадает с разбором', { skip: process.platform !== 'win32' ? 'PowerShell-специфичный тест' : false }, () => {
  const args = "'a‘'b' 'c’’d' ’e f’ “g h” \"i”„j\" 'k”l' \"m’n\" ‟o " + toSingleQuoted('Переход ’ к $X', 'powershell');
  const argv = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', `node ${STUB} ${args}`], { encoding: 'utf8' }));
  const values = toks(`node ${STUB} ${args}`, 'powershell').slice(2).map((t) => t[1]);
  assert.deepEqual(values, argv);
  assert.equal(argv[argv.length - 1], 'Переход ’ к $X');
});

// MEDIUM: сканер рекурсивен ("…" → $(…) → "…"), строка из тысяч `"$(` давала RangeError,
// а catch-all в decide() превращал исключение в allow. Теперь — лимит вложенности, ok: false.
test('scan (B2 r2, MEDIUM): тысячи вложенных `"$(` — ok: false без исключения, разумная вложенность разбирается', () => {
  for (const d of ['posix', 'powershell']) {
    for (const s of ['"$('.repeat(6000), '"$('.repeat(5000) + ')"'.repeat(5000), 'x --quote ' + '"$('.repeat(20000)]) {
      const r = scanCommand(`node cli.mjs goto P1 --quote ${s}`, d);
      assert.equal(r.ok, false, d);
      assert.match(r.error, /вложенност/, d);
    }
    const okDeep = scanCommand(`node cli.mjs goto P1 --quote ${'"$('.repeat(8)}x${')"'.repeat(8)}`, d);
    assert.equal(okDeep.ok, true, `${d}: ${okDeep.error}`);
    assert.equal(okDeep.segments[0].commands[0].tokens[5].hasSubstitution, true);
  }
  assert.equal(scanCommand('x ' + '$('.repeat(20000)).ok, false, 'незакрытые $( без кавычек — ok: false, без исключения');
});

// LOW: `(` после `&&`/`;` терялся (у пустого сегмента сохранялся первый разделитель),
// хвостовой `&` не был виден вовсе — `status &` и `status && (status)` считались cli.
test('scan (B2 r2, LOW): структурный разделитель ( ) & не теряется за &&/;, хвостовой разделитель — trailingSep', () => {
  assert.deepEqual(seps('a && (b)').map((x) => x[0]), [null, '(']);
  assert.deepEqual(seps('a ; (b) ; c').map((x) => x[0]), [null, '(', ')']);
  assert.deepEqual(seps('(a; b) && c').map((x) => x[0]), ['(', ';', ')']);
  assert.deepEqual(seps('a &\nb').map((x) => x[0]), [null, '&']);
  assert.equal(scanCommand('a &').trailingSep, '&');
  assert.equal(scanCommand('a & ').trailingSep, '&');
  assert.equal(scanCommand('a && (b)').trailingSep, ')');
  assert.equal(scanCommand('a ;').trailingSep, ';');
  assert.equal(scanCommand('a\n').trailingSep, '\n');
  assert.equal(scanCommand('a').trailingSep, null);
  assert.equal(scanCommand('a 2>&1').trailingSep, null, '2>&1 — редирект, не хвостовой &');
  assert.equal(scanCommand('a ; b', 'powershell').trailingSep, null);
});

// --- ревью B2, раунд 3 (2026-09-22): CR (\r) ----------------------------------------------
//
// HIGH: сканер считал `\r` пробелом в обоих диалектах. Windows PowerShell 5.1 трактует
// одиночный CR вне кавычек как перевод строки — разделитель statement'ов (проверено
// запуском: `status<CR>Write-Output INJECTED` печатает INJECTED), и команда
// `status<CR>git commit -m x<CR>ni PWNED` была одним cli-сегментом с «лишними аргументами».
test("scan powershell (B2 r3, HIGH): одиночный CR вне кавычек — разделитель statement'ов; CRLF — один разделитель; в кавычках — литерал", () => {
  assert.deepEqual(seps('node cli.mjs status\rgit commit -m x\rni PWNED', 'powershell'), [
    [null, [['node', 'cli.mjs', 'status']]],
    ['\n', [['git', 'commit', '-m', 'x']]],
    ['\n', [['ni', 'PWNED']]],
  ]);
  assert.equal(seps('node cli.mjs status\r\nni PWNED', 'powershell').length, 2, 'CRLF — не два разделителя, пустой сегмент опущен');
  assert.deepEqual(seps('node cli.mjs status\r', 'powershell'), [[null, [['node', 'cli.mjs', 'status']]]]);
  assert.deepEqual(toks("node x \"a\rb\" 'c\rd'", 'powershell').slice(2).map((t) => t[1]), ['a\rb', 'c\rd'], 'внутри кавычек CR — литерал (проверено)');
  // Комментарий кончается на CR: PowerShell выполняет команду после него (проверено).
  assert.deepEqual(seps('node x #c\rni PWNED', 'powershell').map((s) => s[1][0]), [['node', 'x'], ['ni', 'PWNED']]);
});

// MEDIUM: под bash CR — символ слова, не пробел: `>&1<CR>PWNED` — редирект `>&word` с
// нечисловым word (то же, что `&>файл`), файл создаётся. Сканер резал по CR — `>&1`
// проходил как безвредный редирект. Модель — Linux-bash (CR в слове); msys-bash удаляет CR
// из текста команды (`>&1PWNED` — тот же файл), см. core.mjs commandTextVariants.
test('scan posix (B2 r3, MEDIUM): CR — символ слова, не пробел и не разделитель', () => {
  const t = scanCommand('node cli.mjs status >&1\rPWNED.txt').segments[0].commands[0].tokens;
  assert.deepEqual([t[3].text, t[3].value, t[3].redirect], ['>&1\rPWNED.txt', '>&1\rPWNED.txt', true], 'один токен-редирект, а не `>&1` + аргумент');
  assert.deepEqual(toks('node cli.mjs status\rgit commit')[2], ['status\rgit', 'status\rgit', 'none']);
  assert.equal(seps('node cli.mjs status\rgit commit').length, 1);
  assert.deepEqual(seps('a\r\nb'), [[null, [['a\r']]], ['\n', [['b']]]], 'CRLF: LF делит, CR остаётся в слове');
  assert.deepEqual(toks('a \\\r\nb')[1], ['\\\r', '\r', 'none'], 'бэкслеш+CR — буквальный CR в слове, LF после него — разделитель');
  assert.equal(seps('a \\\r\nb').length, 2);
  assert.deepEqual(seps('a #c\rb'), [[null, [['a']]]], 'CR — часть комментария до LF');
  const h = scanCommand('cat <<EOF\rX\nbody\nEOF\nEOF\rX\necho after');
  assert.equal(h.ok, true, h.error);
  assert.equal(h.segments[0].commands[0].tokens[1].text, '<<EOF\rX', 'разделитель heredoc — слово с CR');
  assert.equal(h.segments[0].commands[0].heredocs[0].text, 'body\nEOF\n');
});

// PowerShell, бэктик перед CR/LF (проверено запуском powershell.exe 5.1): приклеенный к
// слову — буквальный символ в слове (`--x`<CR>ni` → один аргумент `--x\rni`;
// `--x`<CR><LF>ni PWNED` — два statement'а, ni выполняется); отдельно стоящий —
// продолжение строки (`a `<CR><LF>b` → аргументы a, b — LF после `<CR> не делит).
test('scan powershell (B2 r3): бэктик+CR/LF — буквальный символ в слове либо продолжение строки', () => {
  assert.deepEqual(toks('node x --x`\rni PWNED', 'powershell').slice(2), [['--x`\rni', '--x\rni', 'none'], ['PWNED', 'PWNED', 'none']]);
  assert.deepEqual(seps('node x --x`\r\nni PWNED', 'powershell').map((s) => s[1][0]), [['node', 'x', '--x`\r'], ['ni', 'PWNED']]);
  assert.deepEqual(toks('node x a`\nb', 'powershell')[2], ['a`\nb', 'a\nb', 'none']);
  for (const c of ['node x `\r\nni PWNED', 'node x `\rni PWNED', 'node x `\nni PWNED']) {
    assert.deepEqual(seps(c, 'powershell'), [[null, [['node', 'x', 'ni', 'PWNED']]]], JSON.stringify(c));
  }
});

test('scan powershell + powershell.exe (B2 r3): CR делит statement\'ы; бэктик+CR — argv совпадает с разбором', { skip: process.platform !== 'win32' ? 'PowerShell-специфичный тест' : false }, () => {
  const ps = (cmd) => execFileSync('powershell.exe', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' });
  const split = `node ${STUB} status\rWrite-Output INJECTED`;
  assert.match(ps(split), /\["status"\][\r\n]+INJECTED/, 'два statement\'а: argv стаба, затем вывод Write-Output');
  assert.equal(scanCommand(split, 'powershell').segments.length, 2);
  for (const args of ['status --x`\rni PWNED', 'status `\r\nni PWNED', 'a`\nb c', "\"a\rb\" 'c\rd'"]) {
    const argv = JSON.parse(ps(`node ${STUB} ${args}`));
    assert.deepEqual(toks(`node ${STUB} ${args}`, 'powershell').slice(2).map((t) => t[1]), argv, JSON.stringify(args));
  }
});

// --- ЗАДАЧА C2 (2026-09-22): редиректы, раскрытие, вложенные скрипты (для detectShellWrites) ---

const cmd0 = (command, dialect = 'posix') => {
  const r = scanCommand(command, dialect);
  assert.equal(r.ok, true, r.error);
  return r.segments[0].commands[0];
};
const redirs = (command, dialect = 'posix') => splitRedirects(cmd0(command, dialect), dialect);

test('scan posix (C2): `\\>&` — литерал `>` и фоновый `&`, не редирект; bash выполняет команду после `&`', () => {
  // Сканер считал `&` редиректом по предыдущему символу `>`, даже экранированному:
  // `echo \>& touch X` был одной командой echo (запись не видна), bash же запускает touch.
  assert.deepEqual(seps('echo \\>& touch X'), [[null, [['echo', '\\>']]], ['&', [['touch', 'X']]]]);
  assert.deepEqual(seps('echo \\<& touch X'), [[null, [['echo', '\\<']]], ['&', [['touch', 'X']]]]);
  // неэкранированные формы — по-прежнему редиректы
  assert.deepEqual(seps('a 2>&1 >&2 &>f'), [[null, [['a', '2>&1', '>&2', '&>f']]]]);
});

test('scan posix (C2): `>|` — редирект с перезаписью, не пайп', () => {
  assert.deepEqual(seps('echo a >| f'), [[null, [['echo', 'a', '>|', 'f']]]]);
  assert.deepEqual(seps('echo a 2>|f'), [[null, [['echo', 'a', '2>|f']]]]);
  assert.deepEqual(seps('echo a | f'), [[null, [['echo', 'a'], ['f']]]], 'обычный пайп');
  assert.deepEqual(seps('echo \\>| f'), [[null, [['echo', '\\>'], ['f']]]], '`\\>` — литерал, `|` — пайп');
});

test('bash (C2): `\\>&` и `>|` — поведение, на которое опирается сканер', { skip: process.platform !== 'win32' ? 'Git Bash — только win32' : false }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'rails-c2-scan-'));
  try {
    execSync('echo \\>& touch amp.txt; wait; echo a >| clob.txt', { cwd: dir, shell: 'bash' });
    assert.equal(existsSync(join(dir, 'amp.txt')), true);
    assert.equal(existsSync(join(dir, 'clob.txt')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('splitRedirects (C2): слова и редиректы — оператор внутри слова, дескриптор, цель в следующем токене', () => {
  const r = redirs('echo x>f 2> "e r" &>>g >&h <in 3<>rw');
  assert.deepEqual(r.words.map((w) => w.value), ['echo', 'x']);
  assert.deepEqual(r.redirects.map((x) => [x.fd, x.op, x.target?.value]), [
    [null, '>', 'f'], ['2', '>', 'e r'], [null, '&>>', 'g'], [null, '>&', 'h'], [null, '<', 'in'], ['3', '<>', 'rw'],
  ]);
  const h = redirs("cat <<'EOF' > out\nbody\nEOF");
  assert.deepEqual(h.redirects.map((x) => [x.op, x.target?.value ?? null]), [['<<', null], ['>', 'out']]);
  assert.deepEqual(redirs('a >').redirects.map((x) => x.target), [null], 'оператор без цели');
  const ps = redirs('Write-Output a *> f 2>&1 3>>g', 'powershell');
  assert.deepEqual(ps.redirects.map((x) => [x.fd, x.op, x.target?.value]), [['*', '>', 'f'], ['2', '>&', '1'], ['3', '>>', 'g']]);
  assert.deepEqual(redirs('a \\>f').redirects, [], 'экранированный `>` — не оператор');
});

test('expandWord (C2): кавычки, переменные, тильда, спецпараметры, шаблоны', () => {
  const vars = { S: '/abs dir', E: '' };
  const lookup = (ref) => (ref.tilde ? '/home/u' : Object.hasOwn(vars, ref.name) ? vars[ref.name] : null);
  const w = (s, d = 'posix') => splitRedirects(cmd0(`x ${s}`, d), d).words[1];
  const ex = (s, d = 'posix') => expandWord(w(s, d), d, lookup);
  assert.equal(ex('"$S/f"').value, '/abs dir/f');
  assert.equal(ex('"${S}/f"').value, '/abs dir/f');
  assert.equal(ex("'$S/f'").value, '$S/f', "'…' — литерал");
  assert.equal(ex('"\\$S"').value, '$S', 'экранированный $');
  assert.equal(ex('$S/f'), null, 'без кавычек значение с пробелом делится — не литерал');
  assert.equal(ex('"$NOPE/f"'), null, 'неизвестная переменная');
  assert.equal(ex('"$1/f"'), null, 'спецпараметр');
  assert.equal(ex('"$(pwd)/f"'), null, 'подстановка');
  assert.equal(ex('"${S:-x}/f"'), null, 'сложное ${…}');
  assert.equal(ex('~/f').value, '/home/u/f');
  assert.equal(ex('"~/f"').value, '~/f', 'тильда в кавычках — литерал');
  assert.equal(ex('~u/f'), null);
  assert.equal(ex('a=~/f'), null, 'bash раскрывает ~ после =');
  assert.equal(ex('*.txt').glob, true);
  assert.equal(ex('"*.txt"').glob, false);
  assert.equal(ex('{a,b}').brace, true);
  // PowerShell
  const psVars = { d: 'C:\\x' };
  const psLookup = (ref) => (ref.tilde ? 'C:\\Users\\u' : ref.env ? (ref.name === 'T' ? 'C:\\t' : null) : psVars[ref.name.toLowerCase()] ?? null);
  const pex = (s) => expandWord(w(s, 'powershell'), 'powershell', psLookup);
  assert.equal(pex('"$D\\f"').value, 'C:\\x\\f');
  assert.equal(pex('"$env:T\\f"').value, 'C:\\t\\f');
  assert.equal(pex('"${env:T}\\f"').value, 'C:\\t\\f');
  assert.equal(pex('$D\\f').value, 'C:\\x\\f');
  assert.equal(pex('$D.Path'), null, 'доступ к члену вне кавычек');
  assert.equal(pex('"$D.txt"').value, 'C:\\x.txt', 'в "…" точка — текст');
  assert.equal(pex('"a`nb"'), null, 'бэктик-escape в пути неоднозначен');
  assert.equal(pex('a,b'), null, 'массив');
  assert.equal(pex("'~\\f'").value, 'C:\\Users\\u\\f', 'PowerShell раскрывает ~ и в кавычках');
  assert.equal(pex("'*.txt'").glob, true, 'wildcard -Path и в кавычках');
});

test('nestedScripts (C2): подстановки в частях слова, в "…", в теле heredoc; PowerShell (…) {…} $(…)', () => {
  const w = (s, d = 'posix') => splitRedirects(cmd0(`x ${s}`, d), d).words[1];
  assert.deepEqual(nestedScripts(w('$(touch a)'), 'posix').scripts, ['touch a']);
  assert.deepEqual(nestedScripts(w('"pre $(touch a) `rm b` post"'), 'posix').scripts, ['touch a', 'rm b']);
  assert.deepEqual(nestedScripts(w('>(tee f)'), 'posix').scripts, ['tee f']);
  const b = nestedScripts(w('"${X:-$(touch c)}"'), 'posix');
  assert.deepEqual([b.scripts, b.braces], [['touch c'], ['X:-$(touch c)']]);
  assert.deepEqual(nestedScripts(w('${X}'), 'posix').scripts, []);
  const heredoc = cmd0('cat <<EOF\n$(touch h)\nEOF').heredocs[0];
  assert.deepEqual(nestedScripts(heredoc, 'posix').scripts, ['touch h']);
  const quoted = cmd0("cat <<'EOF'\n$(touch h)\nEOF").heredocs[0];
  assert.deepEqual(nestedScripts(quoted, 'posix').scripts, [], 'закавыченный разделитель — тело не раскрывается');
  assert.deepEqual(nestedScripts(w('(Remove-Item a)', 'powershell'), 'powershell').scripts, ['Remove-Item a']);
  assert.deepEqual(nestedScripts(w('"$(ni b)"', 'powershell'), 'powershell').scripts, ['ni b']);
  assert.deepEqual(nestedScripts(w('{ Set-Location c }', 'powershell'), 'powershell').scripts, [' Set-Location c ']);
});

// Раунд 3 ревью C2 (2026-09-22): разбор конца тела heredoc расходился с bash — команды после
// настоящего конца тела попадали в тело и пропадали из разбора записи (ложное разрешение).
// Поведение bash 5.2 проверено запуском (см. последний тест файла).
test('scan posix (C2 r3, HIGH): разделитель heredoc — слово со снятием кавычек по частям', () => {
  for (const [command, body] of [
    ['cat <<E"O"F\nbody\nEOF\ntouch x\nE"O"F', 'body\n'],
    ['cat <<E\\OF\nbody\nEOF\ntouch x\nE\\OF', 'body\n'],
    ['cat <<"EO"F\nbody\nEOF\ntouch x', 'body\n'],
    ["cat <<E'OF'\nbody\nEOF\ntouch x", 'body\n'],
  ]) {
    const r = scanCommand(command);
    assert.equal(r.ok, true, `${JSON.stringify(command)}: ${r.error}`);
    assert.equal(r.segments[0].commands[0].heredocs[0].text, body, JSON.stringify(command));
    assert.deepEqual(r.segments[1].commands[0].tokens.map((t) => t.text), ['touch', 'x'], 'команда после тела видна');
    assert.equal(r.segments[0].commands[0].heredocs[0].hasSubstitution, false, 'закавычена часть — тело не раскрывается');
  }
  // Разделитель, который сканер не воспроизводит буквально, — ok: false (вызывающий даст '?')
  for (const command of ['cat <<$X\nbody\n$X', "cat <<$'E'\nbody\nE", 'cat <<`x`\nbody\nx', 'cat <<E"OF\nbody\nEOF']) {
    assert.equal(scanCommand(command).ok, false, JSON.stringify(command));
  }
});

test('scan posix (C2 r3, HIGH): `<<<` — here-string (ввод из слова), не heredoc', () => {
  const r = scanCommand('cat <<< EOF\ntouch x\nEOF');
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.segments.map((s) => s.commands[0].tokens.map((t) => t.text)), [['cat', '<<<', 'EOF'], ['touch', 'x'], ['EOF']]);
  assert.deepEqual(r.segments[0].commands[0].heredocs, [], 'тела у here-string нет');
  const rd = redirs('cat <<<word > out');
  assert.deepEqual(rd.redirects.map((x) => [x.op, x.target?.value ?? null]), [['<<<', 'word'], ['>', 'out']]);
  assert.deepEqual(redirs('cat <<< "$v"').redirects.map((x) => [x.op, x.target?.text]), [['<<<', '"$v"']]);
});

test('scan posix (C2 r3, HIGH): `<<` внутри `(( … ))` — сдвиг, не heredoc: разбор отказывается (ok: false)', () => {
  assert.equal(scanCommand('(( x = 1 << 2 ))\ntouch x\n2').ok, false);
  assert.equal(scanCommand('for (( i=0; i < 1<<1; i++ )); do :; done\ntouch x\n1').ok, false);
  // контроль: heredoc в подоболочке `( … )` разбирается как раньше
  const sub = scanCommand('(cat <<EOF > f\nbody\nEOF\n)');
  assert.equal(sub.ok, true, sub.error);
  assert.equal(sub.segments[0].commands[0].heredocs[0].text, 'body\n');
});

test('bash (C2 r3): поведение, на которое опирается разбор heredoc и here-string', () => {
  if (process.platform !== 'win32') return;
  const base = mkdtempSync(join(tmpdir(), 'rails-scan-c2r3-'));
  const sh = (script) => {
    try {
      execFileSync('bash', ['-c', script], { cwd: base, stdio: 'ignore' });
    } catch {
      /* команда после тела может вернуть ненулевой код (`EOF: command not found`) */
    }
  };
  try {
    sh('cat <<E"O"F >/dev/null\nbody\nEOF\ntouch hd1.txt\nE"O"F');
    sh('cat <<E\\OF >/dev/null\nbody\nEOF\ntouch hd2.txt\nE\\OF');
    sh('cat <<< EOF >/dev/null\ntouch hs.txt\nEOF');
    sh('(( x = 1 << 2 ))\ntouch ar.txt\n2');
    for (const f of ['hd1.txt', 'hd2.txt', 'hs.txt', 'ar.txt']) {
      assert.equal(existsSync(join(base, f)), true, `bash выполнил команду после тела heredoc: ${f}`);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// Раунд 4 (ревью раунда 3 C2, 2026-09-22, HIGH): `(` сразу после `=` открывает список
// присваивания массива, и heredoc в нём bash отвергает как синтаксическую ошибку —
// следующие строки он выполняет, а не читает телом. Разбор расходится с shell → ok: false.
test('scan posix (C2 r4, HIGH): heredoc в списке массива `a=( … )` — разбор отказывается (ok: false)', () => {
  for (const command of ['a=(<<E)\ntouch x\nE', 'a+=(<<E)\ntouch x\nE', 'declare -a a=(<<E)\ntouch x\nE', "arr=(x <<'E')\ntouch x\nE", 'a[0]=(<<E)\ntouch x\nE']) {
    assert.equal(scanCommand(command).ok, false, JSON.stringify(command));
  }
  // контроль: подоболочка и подстановка со скобкой heredoc по-прежнему разбираются
  const sub = scanCommand('( cat <<EOF > f\nbody\nEOF\n)');
  assert.equal(sub.ok, true, sub.error);
  assert.equal(sub.segments[0].commands[0].heredocs[0].text, 'body\n');
  const cmd = scanCommand('a=$(cat <<EOF\nbody\nEOF\n)');
  assert.equal(cmd.ok, true, cmd.error);
});

// Раунд 5 (2026-09-22, LOW-4). Арифметику от вложенных подоболочек `((cmd) && cmd)` bash
// различает СИНТАКСИЧЕСКИ, и сканер повторяет это правило: `((` — арифметика, только если
// пара, открытая второй скобкой, закрывается непосредственно перед `)` (parse_arith_cmd);
// `$((` — если содержимое `$( … )` начинается с `(`, кончается `)` и скобки между ними
// сбалансированы (chk_arithsub). Поведение bash 5.2 msys проверено запуском (см. последний
// тест файла): `((touch f))` — арифметическая ошибка, файла нет, а `((echo x) > b)`,
// `(((a)) > b)`, `((cd x) && (touch y))`, `echo $((ls) > c)` bash ВЫПОЛНЯЕТ.
test('scan posix (C2 r5): сегменты `(( … ))` помечены arith, вложенные подоболочки — нет', () => {
  const ariths = (command) => {
    const r = scanCommand(command, 'posix');
    assert.equal(r.ok, true, r.error);
    return r.segments.map((s) => [s.commands.map((c) => c.text).join(' | '), s.arith]);
  };
  assert.deepEqual(ariths('(( n > 0 ))'), [['n > 0', true]]);
  assert.deepEqual(ariths('(( (a+b) * c ))'), [['a+b', true], ['* c', true]]);
  assert.deepEqual(ariths('((touch f))'), [['touch f', true]]);
  assert.deepEqual(ariths('((echo x) > b)'), [['echo x', false], ['> b', false]]);
  // `(((a)) > b)` — подоболочка, внутри которой арифметическая команда `((a))` с редиректом
  // `> b`: редирект вне арифметики и остаётся записью (bash создаёт b, проверено запуском)
  assert.deepEqual(ariths('(((a)) > b)'), [['a', true], ['> b', false]]);
  assert.deepEqual(ariths('(((a) > b))'), [['a', true], ['> b', true]], 'а это уже арифметика целиком');
  assert.deepEqual(ariths('((cd x) && (touch y))'), [['cd x', false], ['touch y', false]]);
  assert.deepEqual(ariths('(cd x) && touch y'), [['cd x', false], ['touch y', false]]);
  // редирект ПОСЛЕ `))` — уже вне арифметики
  assert.deepEqual(ariths('(( n > 0 )) 2>err'), [['n > 0', true], ['2>err', false]]);
  // PowerShell своих `(( ))` не имеет — arith всегда false
  const ps = scanCommand('(Get-Item a) > b', 'powershell');
  assert.equal(ps.segments.every((s) => s.arith === false), true);
});

test('nestedScripts (C2 r5): `$(( … ))` — арифметика (обёрнута назад в `(( … ))`), `$((cmd) …)` — подстановка команды', () => {
  const w = (s, d = 'posix') => splitRedirects(cmd0(`x ${s}`, d), d).words[1];
  const sc = (s) => nestedScripts(w(s), 'posix').scripts;
  assert.deepEqual(sc('$(( 5 > 3 ))'), ['(( 5 > 3 ))']);
  assert.deepEqual(sc('$(( (a+b) > c ))'), ['(( (a+b) > c ))']);
  assert.deepEqual(sc('$(())'), ['(())']);
  assert.deepEqual(sc('$(( $(touch f) + 1 ))'), ['(( $(touch f) + 1 ))'], 'подстановка внутри арифметики остаётся в разборе');
  // не арифметика: скобки внутри не сбалансированы после снятия внешней пары
  assert.deepEqual(sc('$((ls) > c)'), ['(ls) > c']);
  assert.deepEqual(sc('$((cd x) && (touch y))'), ['(cd x) && (touch y)']);
  assert.deepEqual(sc('$((a) > (b))'), ['(a) > (b)']);
  assert.deepEqual(sc('$((ls) | cat)'), ['(ls) | cat']);
  assert.deepEqual(sc('$( (touch t) )'), [' (touch t) '], 'пробел перед `(` — обычная подстановка команды');
  assert.deepEqual(sc('$(touch t)'), ['touch t']);
  // кавычки внутри пропускаются целиком, как в chk_arithsub
  assert.deepEqual(sc('$(( "a)b" ))'), ['(( "a)b" ))']);
  assert.deepEqual(sc(`$(( 'a)b' ))`), [`(( 'a)b' ))`]);
  // в "…" — тот же разбор
  assert.deepEqual(nestedScripts(w('"$(( 5 > 3 ))"'), 'posix').scripts, ['(( 5 > 3 ))']);
  assert.deepEqual(nestedScripts(w('"$((ls) > c)"'), 'posix').scripts, ['(ls) > c']);
});

// Ревью C2 r5 (2026-09-22, HIGH). Признак arith хранился СТЕКОМ, который выталкивался только
// в ветке `)`. `#` внутри `(( … ))` перематывал разбор до конца строки, `))` до этой ветки не
// доходили, стек оставался с true — и ВСЕ следующие сегменты получали arith:true (в actions.mjs
// это молча выбрасывает их редиректы, то есть ложное РАЗРЕШЕНИЕ). Две правки: (1) внутри
// `(( … ))` `#` не комментарий — так же, как у bash (проверено запуском, см. тест в конце
// файла); (2) признак — ГРАНИЦА ПО ПОЗИЦИИ, а не стек: конец области известен в момент входа
// в неё, поэтому «протечь» за `))` он не может, как бы токенайзер ни прошёл текст.
test('scan posix (ревью C2 r5, HIGH): признак arith не уходит за `))` — `#` внутри `(( … ))`', () => {
  const NL = String.fromCharCode(10);
  const ariths = (command) => {
    const r = scanCommand(command, 'posix');
    assert.equal(r.ok, true, r.error);
    return r.segments.map((x) => [x.commands.map((c) => c.text).join(' | '), x.arith]);
  };
  // `#` — часть арифметического выражения, `))` закрывают область, вторая команда вне её
  assert.deepEqual(ariths(`(( a # ))${NL}echo x > out.txt`), [['a #', true], ['echo x > out.txt', false]]);
  assert.deepEqual(ariths('(( a # )); echo x > out.txt'), [['a #', true], ['echo x > out.txt', false]]);
  assert.deepEqual(ariths(`((#))${NL}echo x > out.txt`), [['#', true], ['echo x > out.txt', false]]);
  assert.deepEqual(ariths('(( a # b ))'), [['a # b', true]]);
  // вне скобок `#` остаётся комментарием
  assert.deepEqual(ariths('echo ok # > out.txt'), [['echo ok', false]]);
  assert.deepEqual(ariths(`(( 1 )) # c${NL}echo x > out.txt`), [['1', true], ['echo x > out.txt', false]]);
  // граница по позиции: в подоболочке `((cmd) …)` флага нет и комментарий там разбирается как
  // слова (для bash это комментарий — расхождение в сторону ложного отказа, не разрешения)
  assert.deepEqual(ariths('((echo A) # c)'), [['echo A', false], ['# c', false]]);
  // контроль LOW-4 не изменился
  assert.deepEqual(ariths('(( n > 0 ))'), [['n > 0', true]]);
  assert.deepEqual(ariths('((echo x) > b)'), [['echo x', false], ['> b', false]]);
  assert.deepEqual(ariths('(( n > 0 )) 2>err'), [['n > 0', true], ['2>err', false]]);
});

test('bash (C2 r5): правило `((` — арифметика только при `))`, иначе вложенные подоболочки', () => {
  if (process.platform !== 'win32') return;
  const base = mkdtempSync(join(tmpdir(), 'rails-scan-r5-'));
  const sh = (script) => {
    try {
      execFileSync('bash', ['-c', script], { cwd: base, stdio: 'ignore' });
    } catch {
      /* арифметическая ошибка даёт ненулевой код — важно, что файла нет */
    }
  };
  try {
    for (const [script, file, created] of [
      ['((touch arith.txt))', 'arith.txt', false],
      ['echo $((touch arith2.txt))', 'arith2.txt', false],
      ['n=1; (( n > 0 ))', '0', false],
      ['echo $(( 5 > 3 ))', '3', false],
      ['((echo x) > sub1.txt)', 'sub1.txt', true],
      ['(((a)) > sub2.txt)', 'sub2.txt', true],
      ['((cd /tmp) && (touch sub3.txt))', 'sub3.txt', true],
      ['echo $((ls) > sub4.txt)', 'sub4.txt', true],
      ['echo $((cd /tmp) && (touch sub5.txt))', 'sub5.txt', true],
      ['(( n > 0 )) 2>sub6.txt', 'sub6.txt', true],
    ]) {
      sh(script);
      assert.equal(existsSync(join(base, file)), created, `${script} -> ${file}`);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
