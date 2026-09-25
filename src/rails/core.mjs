/**
 * Rails — ядро принуждения (спецификация §7: `core.decide`).
 *
 * `decide({ action, ctx })` — единственная точка входа: получает нормализованное
 * действие (`actions.mjs`: `{ tool, kind, command?, path?, server?, mcpTool? }`)
 * и контекст вызова (`{ cwd, sessionId, role, event, run? }`), решает
 * `allow` / `deny`. Модуль не имеет побочных эффектов при импорте — весь ввод-вывод
 * (чтение состояния/конфига/графа, запись состояния и журнала) происходит только
 * внутри `decide()`.
 *
 * Хук никогда не падает (§7, последний абзац): `decide()` сама себя оборачивает
 * в try/catch и на любое исключение отвечает `{ decision: "allow" }`, строкой в
 * stderr и (если корень проекта уже известен) записью `type: "error"` в журнал.
 */

import { existsSync, lstatSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, parse as parsePath, relative as relativePath, resolve as resolvePathAbs } from 'node:path';

import { findProjectRoot } from '../lib/find-root.mjs';
import { rememberSessionRoot, recallSessionRoot } from './session-memo.mjs';
import { loadRailsConfig } from './rails-config.mjs';
import { loadSkillGraph } from './graph.mjs';
import {
  loadState,
  saveState,
  startState,
  currentNodeInfo,
  checkActionLimit,
  describeTransitions,
} from './state.mjs';
import { appendDenial, appendEvent } from './journal.mjs';
import { realpathDeep, isInside, matchesGlob } from './paths.mjs';
import { detectShellWrites, shellAbsolutePath } from './actions.mjs';
import { scanCommand, toSingleQuoted } from './shell-scan.mjs';

// --- cli.mjs: узнаём вызов служебной команды (§7.4.1) -----------------------
//
// Разбор строки команды — только через shell-scan.mjs (2026-09-22, ЗАДАЧА B2): три
// наивных трекера кавычек и регулярка для `--quote` не знали `\"` внутри "…", `'\''`
// и подстановок — ревью показало ложный allow, при котором хук сам создавал инъекцию
// (`--quote '… --quote "$(touch PWNED)"'` переписывался так, что shell выполнял $(…)).
//
// «Команда — вызов cli.mjs» — это ВСЯ команда целиком, не подстрока: каждый сегмент
// (между `&&`, `||`, `;`, переводом строки) — простая команда
// `[ИМЯ=литерал …] [node] …rails/cli.mjs <подкоманда> …`, не более одного пайпа на сегмент
// и только в фильтр-читатель (`| head -3`), с необязательным первым сегментом `cd <dir>`
// с литеральным каталогом и `&&`/`;`/переводом строки после него (раннер и агенты
// префиксуют `cd "<workdir>" &&`, а цитата P0R4 содержит «git commit» — без этого вызов
// уходил в deny_shell по тексту цитаты). Путь cli.mjs и каталог cd — литералы
// (literalPath), интерпретатор — `node` без каталога, под PowerShell в команде нет `--%`
// (ЗАДАЧА B3, 2026-09-22); если после cd есть не только `&&`, путь обязан вести к cli.mjs
// проекта и от каталога cd, и от ctx.cwd (cliBaseDirs); `..` под POSIX — только если логический
// и физический подъём ведут в один каталог (dotDotClimbsReal). Иначе `cli.mjs status && git commit`
// проходил бы коротким замыканием мимо deny_shell. Всё, что shell выполнил бы помимо
// cli.mjs — подстановки $(…) `…` <(…) ${…}, heredoc, редиректы в файл, `&` (в том числе
// хвостовой), `(…)` (в том числе после `&&`), незакрытые кавычки, слишком глубокая
// вложенность — делает команду НЕ cli-вызовом: она идёт по общим правилам
// (canary/deny_shell/write_scope/stage_actions). Ложный отказ здесь допустим, ложное
// разрешение — нет. Под PowerShell кавычками считаются и типографские ‘ ’ ‚ ‛ “ ” „
// (ревью B2, раунд 2: `--quote 'лейбл с ’; git commit …'` проходил одним токеном).
// CR (ревью B2, раунд 3, 2026-09-22): сканер считал `\r` пробелом — `status<CR>git commit
// <CR>ni PWNED` под PowerShell был одним cli-сегментом, а PowerShell выполнял все четыре
// statement'а; под bash `>&1<CR>PWNED` проходил как безвредный `>&1`, а bash создавал
// файл. Теперь CR под PowerShell — разделитель, под bash — символ слова, и любой токен
// с CR/LF вне кавычек не инертен (см. tokenIsInert).

const CLI_SUBCOMMANDS = ['start', 'goto', 'status', 'reset', 'report', 'check', 'coverage', 'selfcheck'];
// Якорь — `rails/cli.mjs` (`rails\cli.mjs` на Windows), а не любой `cli.mjs`: в
// репозитории есть свой `src/cli.mjs`, не имеющий отношения к рельсам.
const CLI_PATH_RE = /(?:^|[\\/])rails[\\/]cli\.mjs$/;
// Интерпретатор перед путём — только node: `rm rails/cli.mjs status` — тоже «путь +
// подкоманда», но это rm. Только имя без каталога (поиск по PATH): ЗАДАЧА B3, 2026-09-22 —
// якорь `…/node` пропускал `.workflow/work/node .workflow/src/rails/cli.mjs status`, и bash
// запускал скрипт агента из write_scope коротким замыканием (проверено запуском).
const NODE_NAME_RE = /^node(?:\.exe)?$/i;
// Префикс присваивания окружения перед node (POSIX; ЗАДАЧА B3, 2026-09-22): только переменные,
// которые читает cli.mjs и которые не меняют, какой код выполнится и куда он пишет (не
// NODE_OPTIONS/PATH/WORKFLOW_HOME), значение — литерал без `/`, `~`, шаблонов.
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const CLI_ENV_NAMES = new Set(['WORKFLOW_RAILS_SKILL', 'WORKFLOW_RAILS_SESSION', 'WORKFLOW_RAILS_RUN']);
const CLI_ENV_VALUE_RE = /^[A-Za-z0-9._:-]*$/;
// Файл cli.mjs — только из этого проекта (ревью B2, раунд 3, 2026-09-22, pre-existing):
// якорь `rails/cli.mjs` принимал любой каталог, и `node .workflow/work/rails/cli.mjs
// status` — файл, который агент вправе создать внутри write_scope, — получал allow как
// cli-вызов (произвольный JS в обход всех правил). Путь (от cwd или от каталога
// `cd`-префикса) обязан лексически указывать на `<root>/.workflow/src/rails/cli.mjs`
// либо совпадать с ним по realpath (junction-цепочка `.workflow/src/rails` → `~/.workflow/rails`).
// Без `root` (прямой вызов analyzeCliCommand из тестов) остаётся только лексический якорь.
// `<root>/src/rails/cli.mjs` больше не канон (ревью B3, раунд 1, 2026-09-22): он принимался
// лексически в любом проекте и без проверки существования, а у analyze-report write_scope "**" —
// агент кладёт свой src/rails/cli.mjs и получает короткое замыкание. В самом workflowAi
// `.workflow/src/rails` — junction на `src/rails`, и `node src/rails/cli.mjs` проходит по realpath.
const CLI_CANONICAL = [['.workflow', 'src', 'rails', 'cli.mjs']];
// Компонент `..` в пути (оба разделителя).
const DOT_DOT_RE = /(^|[\\/])\.\.(?:[\\/]|$)/;

// Регистр на win32 сворачивается только у ASCII (ревью B3 r2, 2026-09-22, проверено запуском):
// JS toLowerCase сводит KELVIN SIGN U+212A к `k`, а NTFS считает `.wor\u212Aflow` отдельным
// именем — копия cli.mjs в `.wor\u212Aflow/src/rails` лексически совпадала с каноном и
// запускалась коротким замыканием. Прочие совпадения имён, которые знает NTFS, сверяются по
// realpath (он возвращает имя с диска).
function samePathText(a, b) {
  const norm = (p) => {
    const s = String(p).replace(/\\/g, '/').replace(/\/+$/, '');
    return process.platform === 'win32' ? s.replace(/[A-Z]+/g, (c) => c.toLowerCase()) : s;
  };
  return norm(a) === norm(b);
}

const PATH_PARTS_RE = process.platform === 'win32' ? /[\\/]+/ : /\/+/;

// true — каждый `..` в rels (по очереди от start) ведёт в один каталог и логически (текст пути),
// и физически: каталог, из которого поднимаемся, сам не ссылка (lstat), и родитель его realpath —
// realpath его текстового родителя. Ревью B3 r2 (2026-09-22, MEDIUM, проверено запуском Git
// Bash): после `cd` в junction msys отдаёт node.exe ФИЗИЧЕСКИЙ каталог (цель ссылки; `pwd` — lnk,
// `pwd -P` и process.cwd() — цель), node сворачивает `..` от него, и `cd ./.workflow/work/lnk &&
// node ../../../.workflow/src/rails/cli.mjs status` запускал копию из цели, а хук сворачивал `..`
// от логического lnk. Linux-ядро тоже даёт физический cwd (не проверено: Linux не запускался).
// Не текстовое «realpath(cur) === cur»: короткие имена 8.3 (TEMP раннера GitHub) и /var →
// /private/var (macOS) не ссылки на пути подъёма, а realpath их переписывает — был бы ложный отказ.
// Ревью B3 r3 (2026-09-22, MEDIUM, проверено запуском): msys-ссылка Git Bash для Windows не
// симлинк — при MSYS=winsymlinks:sys это обычный файл с атрибутом System, при winsymlinks:lnk —
// файл `.lnk`. lstat видит файл, а bash через такую ссылку переходит, и `..` ведёт в родителя
// ЦЕЛИ. Поэтому «не каталог» (stat) тоже считается ссылкой. Любая ошибка lstat/stat, включая
// ENOENT несуществующего компонента, — неизвестность: подъём не подтверждён, команда не
// cli-вызов (ложный отказ; bash на `cd nope/../..` и сам отказывает).
function isLinkOrUnknown(p) {
  try {
    return lstatSync(p).isSymbolicLink() || !statSync(p).isDirectory();
  } catch {
    return true;
  }
}

function dotDotClimbsReal(start, rels) {
  let cur = resolvePathAbs(start);
  for (const rel of rels) {
    if (!rel) continue;
    let rest = rel;
    if (isAbsolute(rel)) {
      const { root } = parsePath(rel);
      cur = resolvePathAbs(cur, root);
      rest = rel.slice(root.length);
    }
    for (const part of rest.split(PATH_PARTS_RE)) {
      if (part === '' || part === '.') continue;
      if (part !== '..') {
        cur = join(cur, part);
        continue;
      }
      const parent = dirname(cur);
      const real = safeRealpath(cur);
      const realParent = safeRealpath(parent);
      if (isLinkOrUnknown(cur) || real === null || realParent === null || !samePathText(dirname(real), realParent)) return false;
      cur = parent;
    }
  }
  return true;
}

// Проверка «путь — это cli.mjs проекта» для classifyCli: (pathValue, cdDir) → boolean.
// Под PowerShell на win32 Set-Location и запущенный из него node поднимаются по `..` логически
// (проверено запуском ревью B3 r2: node получает каталог junction, не цель) — там `..`
// проверяется только по realpath свёрнутого пути; под POSIX — ещё и dotDotClimbsReal. pwsh вне
// Windows (дочерний процесс получает каталог через chdir) не проверен — как POSIX (2026-09-22).
function makeCliPathCheck(scope, dialect) {
  if (!scope || !scope.root) return () => true;
  const cwd = scope.cwd || scope.root;
  const canonical = CLI_CANONICAL.map((parts) => join(scope.root, ...parts));
  const logicalDotDot = dialect === 'powershell' && process.platform === 'win32';
  return (pathValue, cdDir) => {
    const base = cdDir ? resolvePathAbs(cwd, cdDir) : cwd;
    const abs = resolvePathAbs(base, pathValue);
    // `..` лексически не сворачиваем: за junction'ом внутри write_scope `link/../x` ведёт
    // не туда, куда указывает текст — такой путь принимается только по realpath.
    const hasDotDot = [pathValue, cdDir ?? ''].some((p) => DOT_DOT_RE.test(p));
    if (hasDotDot && !logicalDotDot && !dotDotClimbsReal(cwd, [cdDir, pathValue])) return false;
    if (!hasDotDot && canonical.some((c) => samePathText(c, abs))) return true;
    const real = safeRealpath(abs);
    if (real === null) return false;
    return canonical.some((c) => {
      const r = safeRealpath(c);
      return r !== null && samePathText(r, real);
    });
  };
}
// Справа от `|` в cli-сегменте допустимы только фильтры, которые читают stdout и ни при
// каких аргументах не пишут в файл и не выполняют команд (tee/sed/awk/xargs/
// ForEach-Object — не сюда). Ревью B2, раунд 2 (2026-09-22): `sort -o FILE`, `uniq IN OUT`
// и `less -o FILE` создают файл по любому пути — короткое замыкание обходило write_scope
// (проверено запуском: маркер создавался); исключены. Под PowerShell `sort` — Sort-Object,
// но uniq.exe из Git — писатель; в PS-список — только Sort-Object по полному имени.
const PIPE_FILTERS = new Set(['head', 'tail', 'cat', 'grep', 'wc', 'cut', 'tr', 'more', 'findstr']);
const PIPE_FILTERS_PS = new Set(['select-object', 'select-string', 'sort-object', 'out-string', 'format-table', 'format-list', 'out-host']);
// Редиректы, безвредные в cli-сегменте: дублирование дескрипторов (`2>&1`, `>&2`) и
// сброс в /dev/null ($null в PowerShell). Запись в файл — по общим правилам (write_scope).
const SAFE_REDIRECT_RE = /^(?:\d*|&|\*)>>?(?:&\d+|\/dev\/null|\$null)$|^\d*<(?:&\d+|\/dev\/null)$/;
const BARE_REDIRECT_RE = /^(?:\d*|&|\*)>>?$|^\d*<$/;
const NULL_TARGETS = new Set(['/dev/null', '$null']);
const SEGMENT_SEPARATORS = new Set(['&&', '||', ';', '\n']);
// Кавычки PowerShell (ASCII и типографские, как в shell-scan.mjs) и бэктик — снимаются перед
// поиском `--%` в тексте команды (analyzeCliCommand).
const PS_STOP_PARSING_STRIP_RE = /['"‘’‚‛“”„`]/g;
// Идентификатор сессии вставляется в команду как есть — только если он не может ничего
// сломать или добавить в shell (uuid Claude, `ses_…` Kilo, `sess-1` тестов).
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

// Путь (каталог `cd` или путь к cli.mjs), который shell передаст как написано, — или null.
// ЗАДАЧА B3, 2026-09-22 (ревью B2 r3, MEDIUM): `cd $PWD/.workflow/work/copy && node
// .workflow/src/rails/cli.mjs status` давал cdDir = null, путь резолвился от ctx.cwd, а shell
// запускал копию cli.mjs из write_scope. Не литерал (проверено запуском bash 5.2 msys и
// powershell.exe 5.1): раскрытия и подстановки; `~` в начале (bash — $HOME, `~+` — $PWD;
// Set-Location — домашний каталог даже для '~'); `~` после `=`/`:` в незакавыченном тексте
// (bash раскрывает в словах вида `a=~`, `a=x:~/y`); `*?[]` (bash — шаблон без кавычек,
// Set-Location — wildcard даже в '…': `cd 'cop?'`, `cd '[c]opy'` переходят в copy) и `{}`
// (brace expansion); `-` в начале (`cd -` — $OLDPWD, опции); `:` не после буквы диска
// (`env:`, диско-относительное `C:x` — у PowerShell свой текущий каталог на каждом диске).
// msys-путь Git Bash `/c/…` на win32 под POSIX — только каталог cd (cdDir): его переводит в
// `C:/…` сам msys (builtin cd). Аргумент node.exe msys переводит, лишь пока не заданы
// MSYS_NO_PATHCONV/MSYS2_ARG_CONV_EXCL (ревью B3 r2, 2026-09-22, проверено запуском: с
// MSYS_NO_PATHCONV=1 node получает `/c/Windows` и открывает `C:\c\Windows`, а `cd /c/Windows`
// по-прежнему в C:/Windows) — путь cli.mjs вида `/…` неоднозначен. Прочие `/…` под msys
// (`/tmp`, `/usr` — каталоги Git) неоднозначны. Под PowerShell `/c/…` не переводится — путь от
// корня диска.
// Ревью B3, раунд 1 (2026-09-22, проверено запуском): бэктик — escape-символ wildcard'ов
// Set-Location даже в '…' (`cd 'j``k'` переходит в j`k, а хук резолвил j``k — junction на
// .workflow/src — и признавал копию cli.mjs «своей»), поэтому бэктик в пути не литерал (в обоих
// диалектах, для каталога cd и пути cli.mjs). msys-путь с `..` — не литерал: Git Bash
// понимает `/c/..` как корень Git, а `/c/../tmp` — как %TEMP% (`pwd -W`), path.win32 — как C:\tmp.
function literalPath(token, dialect, { cdDir = false } = {}) {
  if (!token || token.kind !== 'word' || token.redirect || token.value === null || token.value === '') return null;
  const v = token.value;
  if (/[\r\n*?[\]{}`]/.test(v) || v.startsWith('~') || v.startsWith('-')) return null;
  const posix = dialect !== 'powershell';
  if (posix && token.parts.some((p) => p.kind === 'bare' && /[=:]~/.test(p.raw))) return null;
  const drive = /^[A-Za-z]:[\\/]/.test(v);
  if ((drive ? v.slice(2) : v).includes(':')) return null;
  if (posix && process.platform === 'win32' && /^[\\/]/.test(v)) {
    if (!cdDir) return null;
    const m = /^\/([A-Za-z])(\/.*)?$/.exec(v);
    if (!m || DOT_DOT_RE.test(v)) return null;
    return `${m[1].toUpperCase()}:${m[2] ?? '/'}`;
  }
  return v;
}

// Префикс `ИМЯ=значение` перед командой (POSIX): true — допустимый (CLI_ENV_NAMES,
// литерал); false — присваивание, но не допустимое; null — не присваивание.
function cliAssignment(token) {
  if (!token || token.kind !== 'word' || token.parts.length === 0 || token.parts[0].kind !== 'bare') return null;
  const m = ASSIGNMENT_RE.exec(token.parts[0].raw);
  if (!m) return null;
  const name = m[0].slice(0, -1);
  if (!CLI_ENV_NAMES.has(name) || token.value === null) return false;
  return CLI_ENV_VALUE_RE.test(token.value.slice(m[0].length));
}

// Индекс токена-пути cli.mjs в простой команде (`node <путь> <подкоманда>` → 1,
// `<путь> <подкоманда>` → 0, со сдвигом на префиксы присваивания под POSIX); -1 — не вызов
// cli.mjs. `pathOk(path)` — путь ведёт к cli.mjs проекта из каждого каталога, где shell может
// его запустить (classifyCli).
function cliPathIndex(command, pathOk, dialect) {
  const t = command.tokens;
  let a = 0;
  if (dialect !== 'powershell') {
    for (let ok = cliAssignment(t[a]); ok !== null; ok = cliAssignment(t[a])) {
      if (!ok) return -1;
      a += 1;
    }
  }
  for (let k = a; k <= a + 1 && k + 1 < t.length; k += 1) {
    const path = literalPath(t[k], dialect);
    if (path === null || !CLI_PATH_RE.test(path)) continue;
    if (t[k + 1].value === null || !CLI_SUBCOMMANDS.includes(t[k + 1].value)) return -1;
    if (k === a + 1 && (t[a].value === null || !NODE_NAME_RE.test(t[a].value))) return -1;
    if (!pathOk(path)) return -1;
    return k;
  }
  return -1;
}

// Токен не даёт shell'у сделать ничего, кроме передачи аргумента cli.mjs: без
// подстановок, не heredoc, редирект — только из безвредного списка. CR/LF в
// незакавыченной части (ревью B2, раунд 3): под PowerShell приклеенный `\`<CR>` —
// буквальный CR в слове, а LF за ним — новый statement; под msys-bash CR удаляется
// (`>&1<CR>X` → `>&1X`, файл). Что shell сделает с таким словом — зависит от сборки
// shell'а, поэтому оно не инертно: ложный отказ допустим, ложное разрешение — нет.
function tokenIsInert(token, next) {
  if (token.kind !== 'word' || token.hasSubstitution) return false;
  if (token.parts.some((p) => p.kind === 'bare' && /[\r\n]/.test(p.raw))) return false;
  if (!token.redirect) return true;
  if (token.quote !== 'none') return false;
  if (BARE_REDIRECT_RE.test(token.text)) return Boolean(next) && NULL_TARGETS.has(next.text);
  return SAFE_REDIRECT_RE.test(token.text);
}

function isPipeFilter(token, dialect) {
  if (!token || token.value === null) return false;
  if (PIPE_FILTERS.has(token.value)) return true;
  return dialect === 'powershell' && PIPE_FILTERS_PS.has(token.value.toLowerCase());
}

// Каталог первого сегмента `cd <dir>` или null: ровно два токена, каталог — литерал
// (literalPath; ЗАДАЧА B3, 2026-09-22 — раньше годился любой инертный токен, в том числе
// `$PWD/…`, и путь cli.mjs резолвился не от того каталога, куда перейдёт shell).
// POSIX: относительный каталог, не начинающийся с `./`/`../`, bash ищет по CDPATH (ревью B3,
// раунд 1, 2026-09-22, проверено запуском: `CDPATH=../other bash -c 'cd src'` переходит в
// ../other/src) — CDPATH shell'а агента хуку не известен, такой каталог не литерал.
function cdTarget(segment, dialect) {
  if (segment.commands.length !== 1) return null;
  const c = segment.commands[0];
  if (c.tokens.length !== 2 || c.tokens[0].value !== 'cd' || c.heredocs.length !== 0) return null;
  if (!tokenIsInert(c.tokens[0]) || !tokenIsInert(c.tokens[1])) return null;
  const dir = literalPath(c.tokens[1], dialect, { cdDir: true });
  if (dir !== null && dialect !== 'powershell' && !isAbsolute(dir) && !/^\.\.?(?:[\\/]|$)/.test(dir)) return null;
  return dir;
}

// После cd-префикса — только `&&`, `;` или перевод строки: за `||` следующий сегмент
// выполняется, лишь если cd НЕ удался, то есть в прежнем каталоге (ЗАДАЧА B3, 2026-09-22).
const CD_SEPARATORS = new Set(['&&', ';', '\n']);

// Каталоги, от которых резолвится путь cli.mjs (null — ctx.cwd). cd может не удаться, а
// следующий сегмент — выполниться в прежнем каталоге: после `;`/перевода строки (bash и
// PowerShell) и за `||` дальше по цепочке (`cd X && A || B`: B — в прежнем каталоге, если cd
// упал). Ревью B3, раунд 1 (2026-09-22, проверено запуском): `cd nope/../..; node
// src/rails/cli.mjs status` — хук резолвил путь от свёрнутого `nope/../..`, bash же отказывал
// в cd («No such file or directory») и запускал копию из write_scope в прежнем каталоге;
// PowerShell `cd src; …` без src/ — то же (Set-Location PathNotFound). Поэтому каталог cd
// один — только если все разделители после cd `&&` (cd упал — не выполнится ничего); иначе
// путь обязан вести к cli.mjs проекта и от каталога cd, и от ctx.cwd.
function cliBaseDirs(segs, cdDir) {
  if (cdDir === null) return [null];
  return segs.slice(1).every((s) => s.sepBefore === '&&') ? [cdDir] : [cdDir, null];
}

// Cli-сегменты команды (`{ segment, main, k, hasSession }`) или null, если команда —
// не «просто вызов cli.mjs». strict=false — только структура (пути, подкоманды,
// разделители, cd-префикс): так ищутся сегменты для переписывания `--quote`, чьи
// подстановки ещё предстоит нейтрализовать. strict=true — плюс ни одного токена,
// дающего shell'у что-то выполнить, и допустимый фильтр справа от пайпа.
// scope — `{ root, cwd }` для проверки, что путь ведёт к cli.mjs проекта (makeCliPathCheck).
function classifyCli(scan, dialect, { strict, scope }) {
  if (!scan.ok || scan.segments.length === 0) return null;
  const segs = scan.segments;
  if (segs[0].sepBefore !== null) return null;
  for (let i = 1; i < segs.length; i += 1) {
    if (!SEGMENT_SEPARATORS.has(segs[i].sepBefore)) return null;
  }
  // Хвостовой `&` (фон), `)` — не «просто список cli-вызовов» (ревью B2, раунд 2).
  if (scan.trailingSep !== null && !SEGMENT_SEPARATORS.has(scan.trailingSep)) return null;
  // Первый сегмент `cd …` без литерального каталога не пропускается: он проверяется как
  // cli-сегмент и отклоняет команду целиком.
  const cdDir = segs.length > 1 && CD_SEPARATORS.has(segs[1].sepBefore) ? cdTarget(segs[0], dialect) : null;
  const first = cdDir === null ? 0 : 1;
  const check = makeCliPathCheck(scope, dialect);
  const bases = cliBaseDirs(segs, cdDir);
  const pathOk = (p) => bases.every((b) => check(p, b));
  const out = [];
  for (let i = first; i < segs.length; i += 1) {
    const seg = segs[i];
    if (seg.commands.length < 1 || seg.commands.length > 2) return null;
    const main = seg.commands[0];
    const k = cliPathIndex(main, pathOk, dialect);
    if (k < 0) return null;
    if (strict) {
      for (const c of seg.commands) {
        if (c.heredocs.length > 0) return null;
        for (let j = 0; j < c.tokens.length; j += 1) {
          if (!tokenIsInert(c.tokens[j], c.tokens[j + 1])) return null;
        }
      }
      if (seg.commands[1] && !isPipeFilter(seg.commands[1].tokens[0], dialect)) return null;
    }
    const hasSession = main.tokens.slice(k + 2).some((t) => t.value === '--session' || (t.quote === 'none' && t.text.startsWith('--session=')));
    out.push({ segment: seg, main, k, hasSession });
  }
  return out;
}

// Одинаковая структура двух разборов: сегменты, разделители, команды, heredoc'и и
// попарно токены (сравнение токенов — через `tokenEq(old, new)`).
function sameShape(a, b, tokenEq) {
  if (!a.ok || !b.ok || a.segments.length !== b.segments.length) return false;
  for (let i = 0; i < a.segments.length; i += 1) {
    const sa = a.segments[i];
    const sb = b.segments[i];
    if (sa.sepBefore !== sb.sepBefore || sa.commands.length !== sb.commands.length) return false;
    for (let j = 0; j < sa.commands.length; j += 1) {
      const ca = sa.commands[j];
      const cb = sb.commands[j];
      if (ca.tokens.length !== cb.tokens.length || ca.heredocs.length !== cb.heredocs.length) return false;
      for (let k = 0; k < ca.tokens.length; k += 1) {
        if (!tokenEq(ca.tokens[k], cb.tokens[k])) return false;
      }
    }
  }
  return true;
}

// Инъекция `--session` в каждый cli-сегмент без него — в конец его первой простой
// команды, то есть перед `|` (иначе флаг уезжает в хвост пайпа и ломает `head`/`tail`).
// Результат проверяется повторным разбором: те же сегменты и команды, в каждом
// дополненном сегменте — ровно два новых токена в конце первой команды, и команда
// по-прежнему cli-вызов; иначе команда остаётся без инъекции (cli.mjs возьмёт
// самую свежую сессию по своей эвристике).
function injectSession(command, scan, cli, sessionId, dialect, scope) {
  const id = String(sessionId);
  if (!SESSION_ID_RE.test(id)) return command;
  const targets = cli.filter((e) => !e.hasSession);
  if (targets.length === 0) return command;
  const injected = new Set(targets.map((e) => e.main));
  let out = command;
  for (const pos of targets.map((e) => e.main.end).sort((x, y) => y - x)) {
    out = `${out.slice(0, pos)} --session ${id}${out.slice(pos)}`;
  }
  const rescanned = scanCommand(out, dialect);
  if (!rescanned.ok || rescanned.segments.length !== scan.segments.length) return command;
  for (let i = 0; i < scan.segments.length; i += 1) {
    const sa = scan.segments[i];
    const sb = rescanned.segments[i];
    if (sa.sepBefore !== sb.sepBefore || sa.commands.length !== sb.commands.length) return command;
    for (let j = 0; j < sa.commands.length; j += 1) {
      const ca = sa.commands[j];
      const cb = sb.commands[j];
      const extra = injected.has(ca) ? 2 : 0;
      if (cb.tokens.length !== ca.tokens.length + extra || ca.heredocs.length !== cb.heredocs.length) return command;
      for (let k = 0; k < ca.tokens.length; k += 1) {
        if (ca.tokens[k].text !== cb.tokens[k].text) return command;
      }
      if (extra && (cb.tokens[ca.tokens.length].text !== '--session' || cb.tokens[ca.tokens.length + 1].text !== id)) return command;
    }
  }
  if (!classifyCli(rescanned, dialect, { strict: true, scope })) return command;
  return out;
}

// --- переписывание `--quote "…"` при бэктиках/$ в ДВОЙНЫХ кавычках (инцидент 2026-09-22) --
//
// Лейблы узлов содержат бэктики (`` `.workflow/reports/` ``) и «$X». Агент печатает
// `--quote "…из `.workflow/reports/`, оценку…"` — в bash ` … ` внутри двойных кавычек
// выполняется как подкоманда, а `$X` раскрывается в пустоту: до cli.mjs долетает
// испорченная цитата, goto отклоняется quote-mismatch. Хук видит команду ДО shell
// (PreToolUse/tool.execute.before) — переписывает такие аргументы в одинарные кавычки
// с тем же буквальным текстом, какой агент напечатал. Условия (ЗАДАЧА B2, 2026-09-22,
// после ревью первой версии — она искала `--quote` регуляркой без контекста кавычек и
// переписывала совпадение ВНУТРИ '…', открывая внешнюю кавычку и отдавая shell'у $(…)):
//  - только токен `--quote "…"` / `--quote="…"` ВЕРХНЕГО уровня cli-сегмента (не внутри
//    '…', $'…', подстановок — там это текст, его не трогаем);
//  - значение — одна часть в двойных кавычках с неэкранированными ` или $ (POSIX);
//    PowerShell — с неэкранированным $ либо бэктик-escape, который PowerShell съел бы
//    (`x → x); известные escape'ы (`n `t …) и ${…} неоднозначны — не переписываем;
//  - снимаются только экранирования, допустимые в "…" (POSIX: \$ \` \" \\ и перевод
//    строки; PowerShell: `" `$ `` и "" → "), подстановки копируются как текст;
//  - переписанная команда обязана разбираться тем же сканером так же, как исходная
//    (сегменты, команды, токены — кроме заменённых, чьё буквальное значение равно
//    задуманному), и оставаться cli-вызовом; иначе команда остаётся как была (goto
//    откажет с подсказкой про одинарные кавычки).
// Диалект — `action.shell` ('posix' | 'powershell'); отсутствует — 'posix'.
function rewriteQuoteArgs(command, scan, dialect, scope) {
  const cli = classifyCli(scan, dialect, { strict: false, scope });
  if (!cli) return { command, scan };
  const edits = [];
  for (const { main, k } of cli) {
    const t = main.tokens;
    for (let j = k + 2; j < t.length; j += 1) {
      let target = null;
      let part = null;
      let expected = null;
      if (t[j].value === '--quote' && t[j + 1] && t[j + 1].quote === 'double') {
        target = t[j + 1];
        part = target.parts[0];
        expected = part.value;
      } else if (t[j].parts.length === 2 && t[j].parts[0].kind === 'bare' && t[j].parts[0].value === '--quote=' && t[j].parts[1].kind === 'double') {
        target = t[j];
        part = target.parts[1];
        expected = `--quote=${part.value}`;
      }
      if (!part || !part.hasUnescapedSpecial || part.ambiguous) continue;
      edits.push({ start: part.start, end: part.end, replacement: toSingleQuoted(part.value, dialect), target, expected });
    }
  }
  if (edits.length === 0) return { command, scan };
  let out = command;
  for (const e of [...edits].sort((x, y) => y.start - x.start)) {
    out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
  }
  const rescanned = scanCommand(out, dialect);
  const expectedByToken = new Map(edits.map((e) => [e.target, e.expected]));
  const same = sameShape(scan, rescanned, (oldTok, newTok) => (
    expectedByToken.has(oldTok)
      ? !newTok.hasSubstitution && !newTok.hasExpansion && newTok.value === expectedByToken.get(oldTok)
      : oldTok.text === newTok.text
  ));
  if (!same || !classifyCli(rescanned, dialect, { strict: true, scope })) return { command, scan };
  return { command: out, scan: rescanned };
}

/**
 * Разбор shell-команды как вызова cli.mjs (§7.4.1). Возвращает `isCli` и команду к
 * выполнению: с переписанными `--quote "…"` (бэктики/$ → одинарные кавычки) и
 * вставленным `--session <id>` (если `sessionId` задан и безопасен для shell).
 * Не cli — `command` возвращается как есть. Экспортируется ради тестов.
 *
 * @param {string} command
 * @param {'posix'|'powershell'|undefined} shell диалект (`action.shell`); отсутствует — posix
 * @param {string} [sessionId]
 * @param {{root?: string, cwd?: string}} [scope] корень проекта и cwd вызова: с `root`
 *   путь cli.mjs обязан вести к файлу этого проекта (см. CLI_CANONICAL); без него —
 *   только лексический якорь `rails/cli.mjs`
 * @returns {{isCli: boolean, command: string}}
 */
export function analyzeCliCommand(command, shell, sessionId, scope) {
  if (typeof command !== 'string') return { isCli: false, command };
  const dialect = shell === 'powershell' ? 'powershell' : 'posix';
  // PowerShell `--%` (stop-parsing; ЗАДАЧА B3, 2026-09-22, проверено запуском powershell.exe
  // 5.1): дальше PowerShell не разбирает кавычки ('…' уходят в argv буквально — переписанная
  // --quote рассыпалась), но `|` внутри '…' делит конвейер, а бэктик вне кавычек экранирует:
  // `--% --quote 'a | ni PWNED | echo `'` сканер видит одним литералом, PowerShell выполняет
  // `ni`. `'--%'`, `"--%"` и `` `--% `` 5.1 тоже обрабатывает особо. Сканер этой модели не
  // знает — любой `--%` в тексте команды под PowerShell делает её не cli-вызовом.
  // Ревью B3, раунд 1 (2026-09-22, HIGH, проверено запуском powershell.exe 5.1): stop-parsing
  // включают и токены, чей текст не содержит `--%`, — -'-%', -"-%", -`-%, --`%, --'%', -"-"%,
  // `-`-%, -''-%, -""-% (значение токена после снятия кавычек и бэктиков равно `--%`); сканер
  // видел в них инертные слова, и `status -'-%' 'x | ni PWNED | echo `'` проходил коротким
  // замыканием. Проверяем текст без кавычек (и типографских) и бэктиков — ложный отказ для
  // цитаты с `--%` допустим. Значение `--%` из переменной ($x) stop-parsing не включает, а
  // лишь склеивает argv (проверено: `$x='--%'; node argv.js a $x 'b | c'` → a, b, |, c) —
  // ничего не выполняется. `` `u{…} `` (escape PowerShell 7 в "…", 5.1 его не знает) мог бы дать
  // `-` внутри токена — pwsh 7 на машине нет, не проверено: консервативно не cli.
  if (dialect === 'powershell' && (command.replace(PS_STOP_PARSING_STRIP_RE, '').includes('--%') || /`u\{/i.test(command))) {
    return { isCli: false, command };
  }
  try {
    const rewritten = rewriteQuoteArgs(command, scanCommand(command, dialect), dialect, scope);
    const cli = classifyCli(rewritten.scan, dialect, { strict: true, scope });
    if (!cli) return { isCli: false, command };
    const out = sessionId ? injectSession(rewritten.command, rewritten.scan, cli, sessionId, dialect, scope) : rewritten.command;
    return { isCli: true, command: out };
  } catch (err) {
    // Ревью B2, раунд 2 (2026-09-22): исключение разбора (RangeError на строке из тысяч
    // `"$(`) доезжало до catch-all в decide() и превращалось в allow всей команды —
    // вместе с `git commit` в её начале. Не разобрали — значит не cli: общие правила.
    try {
      process.stderr.write(`rails: разбор команды как cli-вызова не удался, идёт по общим правилам: ${err && err.message ? err.message : err}\n`);
    } catch {
      // stderr недоступен — не наша забота.
    }
    return { isCli: false, command };
  }
}

// --- loadSkillRuntime: кэш графа/конфига по mtime (§7.4, "хук никогда не падает" не
// применяется здесь — ошибки чтения/парсинга сознательно не глотаются, их ловит
// внешний try/catch в decide()) ------------------------------------------------

// Открытый вопрос: спецификация не уточняет, mtime каких именно файлов участвует
// в инвалидации кэша графа. Реализовано простое детерминированное решение —
// отслеживаются `rails.yaml` и `SKILL.md` (два файла, определяющихконфиг и вход
// графа). Правка ТОЛЬКО файла-фрагмента (`workflows/*.md`) без изменения этих
// двух в течение жизни процесса кэш не инвалидирует — на практике одно
// hook-обращение живёт один процесс, так что для реального использования это не
// имеет значения; риск есть только внутри процесса, который вызывает `decide()`
// многократно (тесты, `cli.mjs`).
const RUNTIME_CACHE = new Map();

function mtimeOf(p) {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Конфиг и граф скила, с кэшем по mtime `rails.yaml`/`SKILL.md` в памяти
 * процесса (§1 «модули без побочных эффектов при импорте» — кэш лежит здесь,
 * а не на уровне модуля, потому что первый вызов происходит только из
 * `decide()`).
 *
 * @param {string} root
 * @param {string} skill
 * @returns {{config: object, graph: import('./graph.mjs').Graph}}
 */
export function loadSkillRuntime(root, skill) {
  const skillDir = join(root, '.workflow', 'src', 'skills', skill);
  const configMtime = mtimeOf(join(skillDir, 'rails.yaml'));
  const skillMdMtime = mtimeOf(join(skillDir, 'SKILL.md'));

  const cached = RUNTIME_CACHE.get(skillDir);
  if (cached && cached.configMtime === configMtime && cached.skillMdMtime === skillMdMtime) {
    return { config: cached.config, graph: cached.graph };
  }

  const config = loadRailsConfig(skillDir);
  const graph = loadSkillGraph(skillDir, config);
  RUNTIME_CACHE.set(skillDir, { configMtime, skillMdMtime, config, graph });
  return { config, graph };
}

// --- текст отказа из трёх частей (§7.5) --------------------------------------

/**
 * Собирает текст отказа из трёх частей: что отклонено, почему, что доступно
 * взамен (§7.5).
 *
 * @param {{what: string, why: string, allowed: string}} parts
 * @returns {string}
 */
export function buildDenyReason({ what, why, allowed } = {}) {
  const whatText = what ?? '';
  const whyText = why ?? '';
  const allowedText = Array.isArray(allowed) ? allowed.join('; ') : (allowed ?? '');
  return `Отклонено: ${whatText}\nПочему: ${whyText}\nДоступно: ${allowedText}`;
}

// --- вспомогательные функции ---------------------------------------------------

function truncate(s, max) {
  const t = String(s ?? '');
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function resolveMaybeRelative(p, cwd) {
  if (typeof p !== 'string' || p.length === 0) return p;
  return isAbsolute(p) ? p : resolvePathAbs(cwd || process.cwd(), p);
}

function safeRealpath(p) {
  if (typeof p !== 'string' || p.length === 0) return null;
  try {
    return realpathDeep(p);
  } catch {
    return null;
  }
}

// Каталог, в котором исполнитель запустит shell-команду: `workdir` действия (Kilo bash,
// fromKilo), разрешённый от ctx.cwd, иначе ctx.cwd. `workdir` не строкой — undefined
// (вызывающий превращает это в маркер: каталог запуска неизвестен).
function shellCwd(action, ctx) {
  if (action?.workdir === undefined) return ctx?.cwd;
  if (typeof action.workdir !== 'string' || action.workdir.length === 0) return undefined;
  // Kilo принимает workdir и в записи Git Bash (`/d/Dev/x`): как путь Windows он дал бы
  // `C:\d\Dev\x` — не тот каталог (ревью 2026-09-24). Прочие `/…` не вычислить — undefined.
  const abs = shellAbsolutePath(action.workdir);
  if (abs === null) return undefined;
  return abs === undefined ? resolveMaybeRelative(action.workdir, ctx?.cwd) : resolvePathAbs(abs);
}

// Цели записи действия: одна для edit/write (по `action.path`), несколько для
// shell (по `detectShellWrites`, §6). Маркер `"?"` (путь не удалось извлечь) —
// отдельный элемент `{ marker: true }`, без realpath (его негде взять).
function collectWriteTargets(action, ctx) {
  if (!action) return [];
  if (action.kind === 'edit' || action.kind === 'write') {
    // apply_patch Kilo правит несколько файлов: `paths` — все пути патча, null — патч не разобран.
    if (action.paths === null) return [{ marker: true, display: `${action.tool ?? 'patch'}: пути патча не разобраны` }];
    const paths = Array.isArray(action.paths) ? action.paths : (action.path ? [action.path] : []);
    return paths.map((p) => {
      const real = safeRealpath(resolveMaybeRelative(p, ctx?.cwd));
      return real === null ? { marker: true, display: p } : { real, display: p };
    });
  }
  if (action.kind === 'shell') {
    // ЗАДАЧА C2 (2026-09-22): cwd/dialect — detectShellWrites сама отслеживает cd,
    // переменные и диалект и отдаёт пути абсолютными (от каталога после cd); без
    // ctx.cwd — относительными, их разрешает resolveMaybeRelative ниже.
    // Объединение по вариантам текста (с CR и без — commandTextVariants): цели только
    // добавляются, отказов от этого больше, разрешений — нет.
    // Каталог запуска — shellCwd: у Kilo bash он задаётся аргументом workdir (2026-09-24).
    // opaque — команду исполнитель берёт не из вызова (background_process restart Kilo).
    if (action.opaque) return [{ marker: true, display: `${action.tool ?? 'shell'}: команда не видна хуку` }];
    const cwd = shellCwd(action, ctx);
    if (action.workdir !== undefined && cwd === undefined) {
      return [{ marker: true, display: `workdir ${JSON.stringify(action.workdir)}` }];
    }
    // dialects — если shell исполнителя неизвестен (Kilo на Windows), цели по каждому диалекту.
    const dialects = Array.isArray(action.dialects) && action.dialects.length > 0 ? action.dialects : [action.shell];
    const writes = [];
    for (const text of commandTextVariants(action.command)) {
      for (const dialect of dialects) {
        for (const w of detectShellWrites(text, { cwd, dialect })) {
          if (!writes.includes(w)) writes.push(w);
        }
      }
    }
    return writes.map((w) => {
      if (w === '?') return { marker: true, display: '?' };
      const real = safeRealpath(resolveMaybeRelative(w, cwd));
      if (real === null) return { marker: true, display: w };
      return { real, display: w };
    });
  }
  return [];
}

function describeWhat(action) {
  const tool = action?.tool ?? '(неизвестный инструмент)';
  if (action?.kind === 'shell') return `${tool}: ${action.command ?? ''}`;
  if (action?.kind === 'edit' || action?.kind === 'write') return `${tool}: ${action.path ?? ''}`;
  if (action?.kind === 'mcp') return `${tool} (mcp ${action.server ?? '?'}/${action.mcpTool ?? '?'})`;
  return `${tool}`;
}

// «Что доступно» (§7.5): допустимые переходы из текущего узла + действия
// текущего этапа (stage_actions, чей rule.stages включает текущий этап). На
// E-узле сами действия этапа ещё запрещены (E-прозрачность, §5) — перечислять
// их как «доступные» противоречило бы причине отказа, поэтому на E-узле эта
// часть подсказки либо опускается, либо помечается «после перехода».
function describeAllowed(state, graph, config) {
  const info = currentNodeInfo(state);
  const transitions = describeTransitions(state, graph, config);

  const parts = [];
  if (transitions.length > 0) parts.push(`переходы: ${transitions.join('; ')}`);
  if (!info.isEntry) {
    const actions = Object.entries(config?.stage_actions || {})
      .filter(([, rule]) => Array.isArray(rule.stages) && rule.stages.includes(info.stage))
      .map(([name]) => name);
    if (actions.length > 0) parts.push(`действия этапа: ${actions.join(', ')}`);
  }
  return parts.length > 0 ? parts.join(' | ') : 'переходов и действий этапа нет';
}

// Лейбл текущего узла для «почему» (§7.5: «цитата лейбла узла или правило
// rails.yaml с incident») — используется там, где отказ вызван самим узлом
// (этап/E-прозрачность), а не отдельным правилом rails.yaml с incident.
function currentNodeLabel(state, graph) {
  const node = graph?.node(state?.node);
  return node ? truncate(node.label, 80) : '';
}

// Канарейка живости: команда считается канарейкой, если она И ЕСТЬ канарейка, либо если
// канарейка стоит отдельной простой командой внутри составной. Инцидент 2026-09-23 (коуч,
// узел P0S1): сравнивалась вся строка целиком, поэтому `echo RAILS_CANARY 2>&1 | tail -2;
// node …` выполнился — проба живости молча прошла, а узел графа велит по этому признаку
// остановиться и сообщить человеку «рельсы выключены». Сверяются токены начала простой
// команды, поэтому дописанный редирект канарейку не прячет, а текст канарейки внутри цитаты
// (`--quote "echo RAILS_CANARY"`) отказа не вызывает: там это один токен-слово.
function canaryTokens(text, dialect) {
  const scan = scanCommand(String(text ?? ''), dialect);
  if (!scan || !scan.ok) return null;
  const out = [];
  for (const seg of scan.segments ?? []) {
    for (const cmd of seg.commands ?? []) out.push((cmd.tokens ?? []).map((t) => String(t.text ?? '')));
  }
  return out;
}

function sameCanary(command, canary, dialect) {
  const target = String(canary ?? '').trim();
  if (!target) return false;
  if (String(command ?? '').trim() === target) return true;

  const targetCommands = canaryTokens(target, dialect);
  const wanted = targetCommands && targetCommands.length === 1 ? targetCommands[0] : null;
  if (!wanted || wanted.length === 0) return false;
  const scan = scanCommand(String(command ?? ''), dialect);
  if (!scan || !scan.ok) return false;
  for (const seg of scan.segments ?? []) {
    for (const cmd of seg.commands ?? []) {
      const tokens = (cmd.tokens ?? []).map((t) => String(t.text ?? ''));
      if (tokens.length >= wanted.length && wanted.every((w, i) => tokens[i] === w)) return true;
      // Вложенный интерпретатор: `bash -c "<канарейка>"`, `eval '<канарейка>'`. Слово, чьё
      // значение после снятия кавычек РАВНО канарейке, считается её запуском. Цитата лейбла
      // канарейку не прячет и отказа не вызывает: там значение слова длиннее (quote_min 25).
      for (const t of cmd.tokens ?? []) {
        if (typeof t.value === 'string' && t.value.trim() === target) return true;
      }
    }
  }
  return false;
}

// Тексты команды для общих правил (canary, deny_shell, stage_actions, detectShellWrites):
// как написано и без CR. Ревью B2, раунд 3 (2026-09-22): msys-bash (Git for Windows)
// молча удаляет CR из текста `-c` — `gi<CR>t commit` выполняет `git commit`, `tou<CR>ch X`
// создаёт файл (проверено запуском обоих бинарников), а регулярки по сырому тексту этого
// не видят. Под Linux-bash CR — символ слова (`gi<CR>t` — «команда не найдена»), под
// PowerShell — перевод строки; там вариант без CR может дать только лишний отказ.
function commandTextVariants(command) {
  const raw = String(command ?? '');
  const stripped = raw.replace(/\r/g, '');
  return stripped === raw ? [raw] : [raw, stripped];
}

function matchesDenyShell(command, rule) {
  if (!rule || typeof rule.pattern !== 'string') return false;
  let re;
  try {
    re = new RegExp(rule.pattern);
  } catch {
    return false;
  }
  return re.test(String(command ?? ''));
}

// Правило `stage_actions` применимо к действию: kind совпадает, match —
// регулярка по тексту команды (shell) или glob по realpath (edit/write); §4/§6.
// Для read/agent/mcp/other форма `match` спецификацией не описана (примеры §4
// только для shell/edit/write) — открытый вопрос, детерминированное решение:
// правило для таких kind никогда не матчится (нет данных для сравнения, а
// значит нет права ни разрешать, ни запрещать по догадке).
function ruleMatches(action, rule, root, editRealPath) {
  if (!Array.isArray(rule?.kind) || !rule.kind.includes(action?.kind)) return false;
  if (typeof rule.match !== 'string') return false;
  if (action.kind === 'shell') {
    let re;
    try {
      re = new RegExp(rule.match);
    } catch {
      return false;
    }
    return commandTextVariants(action.command).some((text) => re.test(text));
  }
  if (action.kind === 'edit' || action.kind === 'write') {
    if (!editRealPath) return false;
    return matchesGlob(editRealPath, rule.match, root);
  }
  return false;
}

// --- G0: режим без скила (§7.3) ------------------------------------------------

function decideNoSkillMode(root, action, ctx) {
  if (action?.kind === 'edit' || action?.kind === 'write') {
    // apply_patch Kilo правит несколько файлов — проверяется каждый путь, а не первый (ревью 2026-09-24).
    const paths = Array.isArray(action.paths) ? action.paths : (action.path ? [action.path] : []);
    const skillsDir = join(root, '.workflow', 'src', 'skills');
    const real = paths
      .map((p) => safeRealpath(resolveMaybeRelative(p, ctx?.cwd)))
      .find((r) => r && isInside(r, skillsDir));
    if (real) {
      const reason = 'правки скилов только через коуча на рельсах: `node .workflow/src/rails/cli.mjs start coach`';
      try {
        appendDenial(root, {
          session: ctx?.sessionId ?? null,
          skill: null,
          node: null,
          run: ctx?.run ?? null,
          reason,
          tool: action.tool,
          path: action.path,
        });
      } catch {
        // журнал не должен ронять decide()
      }
      return { decision: 'deny', reason };
    }
  }
  return { decision: 'allow' };
}

// --- запись отказа: журнал + счётчик denials[node] (§7.5) -------------------

function denyAndLog({ root, ctx, state, action, what, why, allowedText }) {
  const node = state?.node ?? null;
  let count = null;
  if (node) {
    state.denials ??= {};
    count = (state.denials[node] || 0) + 1;
    state.denials[node] = count;
    state.updated = new Date().toISOString();
  }
  const fullWhy = node ? `${why}; по ${node} это ${count}-й отказ за сессию` : why;
  const reason = buildDenyReason({ what, why: fullWhy, allowed: allowedText });

  try {
    appendDenial(root, {
      session: ctx?.sessionId ?? null,
      skill: state?.skill ?? null,
      node,
      run: ctx?.run ?? null,
      reason,
      tool: action?.tool,
      path: action?.path,
      command: action?.command,
    });
  } catch {
    // журнал не должен ронять decide()
  }
  try {
    if (state) saveState(root, state);
  } catch {
    // сохранение состояния не должно ронять decide()
  }
  return { decision: 'deny', reason };
}

// --- режим скила (§7.4) --------------------------------------------------------

function decideSkillMode({ root, action, ctx, state, config, graph }) {
  // 1. cli.mjs — служебная команда: allow; испорченные shell'ом ` / $ в `--quote "…"`
  // переписаны в одинарные кавычки (2026-09-22), при отсутствии --session он вставлен —
  // обе правки в одном updatedCommand (analyzeCliCommand, разбор — shell-scan.mjs).
  if (action?.kind === 'shell') {
    const cli = analyzeCliCommand(action.command, action.shell, ctx?.sessionId, { root, cwd: shellCwd(action, ctx) });
    if (cli.isCli) {
      const result = { decision: 'allow' };
      if (cli.command !== action.command) result.updatedCommand = cli.command;
      return result;
    }
  }

  const deny = (what, why) =>
    denyAndLog({ root, ctx, state, action, what, why, allowedText: describeAllowed(state, graph, config) });
  const shellTexts = action?.kind === 'shell' ? commandTextVariants(action.command) : [];

  // 2. Канарейка.
  if (action?.kind === 'shell' && config.canary && shellTexts.some((text) => sameCanary(text, config.canary, action.shell))) {
    return deny(describeWhat(action), `RAILS_CANARY: рельсы активны, узел ${state.node}`);
  }

  // 3. deny_shell.
  if (action?.kind === 'shell' && Array.isArray(config.deny_shell)) {
    for (const rule of config.deny_shell) {
      if (shellTexts.some((text) => matchesDenyShell(text, rule))) {
        const why = rule.incident ? `${rule.reason ?? 'запрещённая команда'} (${rule.incident})` : (rule.reason ?? 'запрещённая команда');
        return deny(describeWhat(action), why);
      }
    }
  }

  // 4. deny_mcp.
  if (action?.kind === 'mcp' && Array.isArray(config.deny_mcp) && config.deny_mcp.includes(action.mcpTool)) {
    return deny(describeWhat(action), `MCP-инструмент «${action.mcpTool}» запрещён правилом deny_mcp`);
  }

  const targets = collectWriteTargets(action, ctx);

  // 5. write_deny.
  if (Array.isArray(config.write_deny) && config.write_deny.length > 0) {
    for (const t of targets) {
      if (t.marker) continue; // маркер "?" разбирается на шаге 6, не здесь.
      for (const pattern of config.write_deny) {
        if (matchesGlob(t.real, pattern, root)) {
          return deny(describeWhat(action), `путь «${t.display}» запрещён явным правилом write_deny`);
        }
      }
    }
  }

  // 6. write_scope (+ allow_temp).
  for (const t of targets) {
    if (t.marker) {
      return deny(
        describeWhat(action),
        'команда похожа на запись, но путь не удалось определить — используй Edit/Write или укажи путь явно'
      );
    }
    const inScope = (config.write_scope || []).some((pattern) => matchesGlob(t.real, pattern, root));
    // followLinks: false — ссылки внутри os.tmpdir() не нужны, а обход %TEMP% стоил до 9 с (2026-09-22).
    // Внутри корня проекта allow_temp не действует: изолированные workdir тестов живут в %TEMP%,
    // и без этого исключения вся песочница (тикеты, планы) становилась бы записываемой.
    const inTemp = Boolean(config.allow_temp)
      && isInside(t.real, tmpdir(), { followLinks: false })
      && !isInside(t.real, root, { followLinks: false });
    if (!inScope && !inTemp) {
      return deny(describeWhat(action), `путь «${t.display}» вне write_scope`);
    }
  }

  // 7. stage_actions.
  // Все цели правки: apply_patch Kilo меняет несколько файлов, правило этапа срабатывает,
  // если под него попадает любой из них (ревью 2026-09-24; прежде смотрели только первый).
  const editRealPaths = (action?.kind === 'edit' || action?.kind === 'write')
    ? targets.filter((t) => !t.marker).map((t) => t.real)
    : [];
  const matchesRule = (rule) => (editRealPaths.length > 0
    ? editRealPaths.some((real) => ruleMatches(action, rule, root, real))
    : ruleMatches(action, rule, root, null));
  const info = currentNodeInfo(state);

  // Два прохода: сначала проверяем ВСЕ совпавшие правила (этап/E-прозрачность/
  // потолок) без побочных эффектов, и только если ни одно не отказало —
  // тратим потолки (checkActionLimit). Иначе правило A (совпало и прошло)
  // успевает инкрементировать и сохранить свой счётчик, хотя итоговое решение —
  // deny от следующего правила B: отклонённое действие «съедает» потолок.
  const nodeLabel = currentNodeLabel(state, graph);
  const matchedRuleNames = [];
  for (const [name, rule] of Object.entries(config.stage_actions || {})) {
    if (!matchesRule(rule)) continue;

    if (!Array.isArray(rule.stages) || !rule.stages.includes(info.stage)) {
      return deny(
        describeWhat(action),
        `действие «${name}» разрешено только на этапах ${JSON.stringify(rule.stages ?? [])}, текущий этап ${info.stage} (узел ${state.node} «${nodeLabel}»)`
      );
    }
    if (info.isEntry) {
      return deny(
        describeWhat(action),
        `узел ${state.node} — вход этапа «${nodeLabel}»; сначала перейди в правило/шаг/гейт этапа (goto), действия этапа с входа запрещены`
      );
    }
    const key = `action:${name}`;
    const count = (state.counters && state.counters[key]) || 0;
    if (typeof rule.max_per_session === 'number' && count >= rule.max_per_session) {
      return deny(
        describeWhat(action),
        `потолок действия «${name}»: ${rule.max_per_session} за сессию исчерпан — выход к человеку`
      );
    }
    matchedRuleNames.push(name);
  }
  for (const name of matchedRuleNames) {
    checkActionLimit(state, name, config.stage_actions[name].max_per_session);
  }

  // 8. allow.
  try {
    saveState(root, state); // могли измениться counters (checkActionLimit) или это только что созданное состояние.
  } catch {
    // сохранение состояния не должно ронять decide()
  }
  const node = state.node;
  const label = graph.node(node)?.label ?? '';
  return { decision: 'allow', context: `RAILS: числится ${node} «${truncate(label, 80)}»` };
}

// Корень проекта от пути цели: ближайший предок с `.workflow/src/skills`, а не любой
// `.workflow/` (в каноне встречался бродячий `src/.workflow/logs`, из-за которого
// findProjectRoot принимал `src/` за проект). Глубина подъёма — как у find-root.
function projectRootFromPath(absPath) {
  let current = dirname(absPath);
  for (let i = 0; i < 20; i += 1) {
    if (existsSync(join(current, '.workflow', 'src', 'skills'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

// --- decide: точка входа (§7) ---------------------------------------------------

function decideInProject(root, action, ctx) {
  const role = ctx?.role ?? process.env.WORKFLOW_RAILS_ROLE;
  if (role === 'executor') return { decision: 'allow' };

  const sessionId = ctx?.sessionId;
  let state = sessionId ? loadState(root, sessionId) : null;

  if (!state) {
    const skillEnv = process.env.WORKFLOW_RAILS_SKILL;
    if (!skillEnv) {
      return decideNoSkillMode(root, action, ctx);
    }
    if (!sessionId) {
      // Открытый вопрос спецификации: §5 отдаёт создание состояния при
      // WORKFLOW_RAILS_SKILL на откуп «первому действию», не уточняя случай
      // «адаптер не передал sessionId». Без sessionId состояние ни создать,
      // ни загрузить (state.mjs требует непустой sessionId) — если это не
      // перехватить явно, `startState` бросает исключение, его ловит внешний
      // catch в `decide()` и результат неотличим от обычной ошибки хука
      // (`type: "error"` в журнале), хотя по сути это «рельсы сейчас никого
      // не ведут» — другой класс события. Простое детерминированное решение:
      // явно предупредить в stderr и вести себя как G0 (единственный гард —
      // правки `.workflow/src/skills/**`), не как ошибка.
      try {
        process.stderr.write(
          'rails: WORKFLOW_RAILS_SKILL задан, но ctx.sessionId отсутствует — состояние сессии недоступно, включён режим G0\n'
        );
      } catch {
        // stderr недоступен — не наша забота.
      }
      return decideNoSkillMode(root, action, ctx);
    }
    // §5: «если состояния нет, но задан WORKFLOW_RAILS_SKILL... хук создаёт
    // состояние сам при первом действии».
    const { config } = loadSkillRuntime(root, skillEnv);
    state = startState({ root, sessionId, skill: skillEnv, entry: config.entry, run: ctx?.run ?? null });
  }

  const { config, graph } = loadSkillRuntime(root, state.skill);

  // Дедупликация по идентификатору вызова инструмента (Claude tool_use_id, Kilo callID):
  // хуки могут быть зарегистрированы и у пользователя, и в проекте — один вызов
  // приходит дважды, а счётчики (denials, max_per_session, cycle) должны расти один раз.
  const dedupeKey = ctx?.toolUseId ? `${ctx.event || 'PreToolUse'}:${ctx.toolUseId}` : null;
  if (dedupeKey && state.dedupe && state.dedupe[dedupeKey]) {
    return { ...state.dedupe[dedupeKey], deduped: true };
  }
  const result = decideSkillMode({ root, action, ctx, state, config, graph });
  if (dedupeKey) {
    try {
      const fresh = loadState(root, state.session || ctx?.sessionId) || state;
      fresh.dedupe ??= {};
      const keys = Object.keys(fresh.dedupe);
      for (const k of keys.slice(0, Math.max(0, keys.length - 7))) delete fresh.dedupe[k];
      fresh.dedupe[dedupeKey] = { decision: result.decision, reason: result.reason, context: result.context, updatedCommand: result.updatedCommand };
      saveState(root, fresh);
    } catch {
      // дедупликация — удобство, не гард: её сбой не должен ронять decide()
    }
  }
  return result;
}

// --- песочница тестов скилов ------------------------------------------------------
//
// run-skill-tests кладёт агентам кейса (исполнителю и судье) WORKFLOW_SANDBOX_ROOT —
// корень их изолированного workdir. 2026-09-23 агенты тестов create-plan и
// decompose-plan записали планы и тикеты в настоящий проект (PLAN-003/004/007,
// IMPL-41, QA-18): у этих скилов ещё не было rails.yaml, а режим без скила запись
// не ограничивает. Проверка песочницы не зависит ни от скила, ни от роли, ни от cwd
// агента и идёт до них. Запись внутри песочницы — дальше по обычным правилам.
//
// Разрешено писать: внутрь песочницы (по realpath — сквозь junction'ы
// .workflow/src/scripts, .workflow/src/rails и .workflow/config запись уходит в
// репозиторий и запрещена) и во временный каталог ОС, кроме чужих песочниц
// (wf-test-*). Путь записи, который не удалось определить, — отказ: в песочнице
// ошибаться в сторону разрешения нельзя.
//
// MCP-сервер workflow в песочнице — только чтение (get_*, list_* и два поисковых):
// инструменты с параметром project пишут в любой проект по его пути.
const SANDBOX_MCP_READONLY = new Set(['cross_project_search', 'aggregate_metrics']);
// Встроенные инструменты Kilo, которые запускают работу вне взгляда хука (другой агент,
// отложенный запуск): что и куда она запишет, проверить нельзя (ревью 2026-09-24).
const SANDBOX_DENY_OTHER = new Set(['agent_manager', 'cron_create', 'schedule_wakeup']);
// Создание ссылок в песочнице запрещено целиком: ссылка, созданная и использованная одной
// командой, на момент проверки ещё не существует, и realpath цели записи остаётся внутри
// песочницы (ревью 2026-09-24: `New-Item -ItemType Junction … ; Set-Content j\…` дописал
// файл в проект). Ложный отказ на слове в тексте команды допустим, ложное разрешение — нет.
const SANDBOX_LINK_RES = [
  /\bmklink\b/i,
  /\bfsutil\b/i,
  /\b(?:Junction|SymbolicLink|HardLink)\b/i,
  /Create(?:Symbolic|Hard)Link/i,
  /(?:^|[\s;&|(])(?:ln|link)(?:\.exe)?(?=\s)/i,
  /(?:^|[\s;&|(])cp(?:\.exe)?\s[^;&|\n]*(?:\s-[A-Za-z]*[ls][A-Za-z]*(?=\s|$)|--link\b|--symbolic-link\b)/i,
];

function sandboxDenyReason(sandbox, why) {
  return buildDenyReason({
    what: 'запись вне песочницы теста',
    why: `${why}; корень песочницы «${sandbox}»`,
    allowed: 'запись внутри рабочего каталога прогона и во временный каталог ОС',
  });
}

function decideSandbox(sandboxRoot, action, ctx) {
  if (action?.kind === 'mcp') {
    if (action.server !== 'workflow') return null;
    const name = String(action.mcpTool ?? '');
    if (name.startsWith('get_') || name.startsWith('list_') || SANDBOX_MCP_READONLY.has(name)) return null;
    return { decision: 'deny', reason: sandboxDenyReason(sandboxRoot, `MCP-инструмент «${name}» меняет проект, в песочнице он запрещён`) };
  }
  if (action?.kind === 'other' && SANDBOX_DENY_OTHER.has(action.tool)) {
    return { decision: 'deny', reason: sandboxDenyReason(sandboxRoot, `инструмент «${action.tool}» запускает работу, которую хук не видит`) };
  }
  if (action?.kind !== 'edit' && action?.kind !== 'write' && action?.kind !== 'shell') return null;

  if (action.kind === 'shell' && commandTextVariants(action.command).some((text) => SANDBOX_LINK_RES.some((re) => re.test(text)))) {
    return { decision: 'deny', reason: sandboxDenyReason(sandboxRoot, 'создание ссылок (junction, symlink, hardlink) в песочнице запрещено') };
  }

  const targets = collectWriteTargets(action, ctx);
  if (targets.length === 0) return null;

  // realpathDeep разрешает и несуществующий путь (по ближайшему предку), поэтому
  // существование каталога проверяется отдельно: без него граница бессмысленна.
  let sandboxReal;
  try {
    sandboxReal = realpathDeep(sandboxRoot);
    if (!existsSync(sandboxReal) || !statSync(sandboxReal).isDirectory()) sandboxReal = null;
  } catch {
    sandboxReal = null;
  }
  if (!sandboxReal) {
    return { decision: 'deny', reason: sandboxDenyReason(sandboxRoot, 'корня песочницы нет на диске') };
  }
  const tmpReal = safeRealpath(tmpdir());

  for (const t of targets) {
    if (t.marker) {
      return { decision: 'deny', reason: sandboxDenyReason(sandboxRoot, 'команда похожа на запись, но путь не удалось определить — в песочнице пиши явным путём') };
    }
    // Жёсткая ссылка неотличима от файла по realpath: запись в неё меняет и файл вне
    // песочницы (ревью 2026-09-24). Существующий файл с несколькими именами — отказ.
    try {
      const st = statSync(t.real);
      if (st.isFile() && st.nlink > 1) {
        return { decision: 'deny', reason: sandboxDenyReason(sandboxRoot, `файл «${t.display}» — жёсткая ссылка (имён: ${st.nlink})`) };
      }
    } catch {
      // файла ещё нет — жёсткой ссылкой он быть не может
    }
    if (isInside(t.real, sandboxReal, { followLinks: false })) continue;
    if (tmpReal && isInside(t.real, tmpReal, { followLinks: false })) {
      const first = relativePath(tmpReal, t.real).split(/[\\/]/).filter(Boolean)[0] ?? '';
      if (!first.toLowerCase().startsWith('wf-test-')) continue;
      return { decision: 'deny', reason: sandboxDenyReason(sandboxRoot, `путь «${t.display}» ведёт в чужую песочницу`) };
    }
    return { decision: 'deny', reason: sandboxDenyReason(sandboxRoot, `путь «${t.display}» (${t.real}) вне песочницы`) };
  }
  return null;
}

/**
 * Единая логика решений (§7). Никогда не бросает исключений — любая ошибка
 * (включая «нет корня проекта», что не ошибка, а штатный silent-allow) в
 * худшем случае превращается в `{ decision: "allow" }` плюс строка в stderr и
 * запись `type: "error"` в журнал (если корень проекта уже был найден).
 *
 * @param {{action: object, ctx: {cwd: string, sessionId?: string, role?: string, event?: string, run?: string|null}}} args
 * @returns {{decision: 'allow'|'deny', reason?: string, context?: string, updatedCommand?: string}}
 */
export function decide({ action, ctx } = {}) {
  // Песочница тестов — до всего остального: и до поиска корня проекта по cwd, который
  // агент может сменить, и до роли executor, которой рельсы разрешают всё.
  const sandboxRoot = ctx?.sandboxRoot ?? process.env.WORKFLOW_SANDBOX_ROOT;
  if (sandboxRoot) {
    let verdict;
    try {
      verdict = decideSandbox(sandboxRoot, action, ctx);
    } catch (err) {
      // Ошибка проверки — не повод снять защиту: запись в песочнице без проверки не проходит.
      const writes = ['edit', 'write', 'shell', 'mcp'].includes(action?.kind);
      verdict = writes
        ? { decision: 'deny', reason: sandboxDenyReason(sandboxRoot, `проверка песочницы упала: ${err && err.message ? err.message : err}`) }
        : null;
    }
    if (verdict) {
      // Журнал — только в существующую песочницу: appendDenial создал бы каталоги и тем
      // самым «вернул» отсутствующий корень, после чего следующая запись прошла бы.
      try {
        if (!existsSync(sandboxRoot)) throw new Error('sandbox root missing');
        appendDenial(sandboxRoot, {
          session: ctx?.sessionId ?? null,
          skill: null,
          node: null,
          run: ctx?.run ?? null,
          reason: verdict.reason,
          tool: action?.tool,
          path: action?.path,
          command: action?.command,
        });
      } catch {
        // журнал не должен ронять decide()
      }
      return verdict;
    }
  }

  let root;
  try {
    root = findProjectRoot(ctx?.cwd);
  } catch {
    // §7.1: нет корня проекта по cwd. Сессия могла стартовать из каталога-зонтика
    // (D:\Dev) над проектами — тогда корень берётся от пути цели edit/write
    // (регистрация хука на уровне зонтика, 2026-09-22). Нет и его — allow без текста.
    root = null;
    if (action?.kind === 'edit' || action?.kind === 'write') {
      // Корень — от первого пути, ведущего в проект (у apply_patch путей несколько).
      const paths = Array.isArray(action.paths) ? action.paths : [action.path];
      for (const p of paths) {
        if (typeof p !== 'string' || !p) continue;
        root = projectRootFromPath(resolveMaybeRelative(p, ctx?.cwd));
        if (root) break;
      }
      if (root) rememberSessionRoot(ctx?.sessionId, root);
    }
    // Команда без пути (shell, mcp, read): корень — из памяти «сессия → корень»,
    // заполненной `rails start --session` из каталога проекта или прошлым edit/write.
    if (!root) root = recallSessionRoot(ctx?.sessionId);
    if (!root) return { decision: 'allow' };
  }

  try {
    return decideInProject(root, action, ctx);
  } catch (err) {
    try {
      process.stderr.write(`rails: decide() поймала исключение, снимаю рельсы: ${err && err.stack ? err.stack : err}\n`);
    } catch {
      // stderr недоступен — не наша забота, decide() всё равно не должна падать.
    }
    try {
      appendEvent(root, {
        type: 'error',
        session: ctx?.sessionId ?? null,
        message: String(err && err.message ? err.message : err),
      });
    } catch {
      // журнал недоступен — тоже не должен ронять decide().
    }
    return { decision: 'allow' };
  }
}
