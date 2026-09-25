import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { homedir, tmpdir } from 'node:os';
import { join, resolve as resolvePathAbs } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fromClaude, fromKilo, detectShellWrites } from '../rails/actions.mjs';

// --- fromClaude (таблица §6) ------------------------------------------------

test('fromClaude: Bash -> shell с command, shell: posix', () => {
  const a = fromClaude({ tool_name: 'Bash', tool_input: { command: 'ls -la' } });
  assert.deepEqual(a, { tool: 'Bash', kind: 'shell', command: 'ls -la', shell: 'posix' });
});

// ЗАДАЧА C (2026-09-22): PowerShell раньше маппился в kind 'other' — вся
// shell-защита (канарейка/deny_shell/stage_actions/write_scope) его не видела.
test('fromClaude: PowerShell -> shell с command, shell: powershell', () => {
  const a = fromClaude({ tool_name: 'PowerShell', tool_input: { command: 'git commit -m x' } });
  assert.deepEqual(a, { tool: 'PowerShell', kind: 'shell', command: 'git commit -m x', shell: 'powershell' });
});

test('fromClaude: Edit -> edit с path из file_path', () => {
  const a = fromClaude({ tool_name: 'Edit', tool_input: { file_path: '/a/b.js' } });
  assert.equal(a.kind, 'edit');
  assert.equal(a.path, '/a/b.js');
});

test('fromClaude: MultiEdit -> edit', () => {
  const a = fromClaude({ tool_name: 'MultiEdit', tool_input: { file_path: '/a/b.js' } });
  assert.equal(a.kind, 'edit');
});

test('fromClaude: NotebookEdit -> edit с path из notebook_path', () => {
  const a = fromClaude({ tool_name: 'NotebookEdit', tool_input: { notebook_path: '/a/b.ipynb' } });
  assert.equal(a.kind, 'edit');
  assert.equal(a.path, '/a/b.ipynb');
});

test('fromClaude: Write -> write', () => {
  const a = fromClaude({ tool_name: 'Write', tool_input: { file_path: '/a/c.js' } });
  assert.equal(a.kind, 'write');
  assert.equal(a.path, '/a/c.js');
});

test('fromClaude: Read/Glob/Grep/LS -> read', () => {
  for (const tool_name of ['Read', 'Glob', 'Grep', 'LS']) {
    const a = fromClaude({ tool_name, tool_input: {} });
    assert.equal(a.kind, 'read', tool_name);
  }
});

test('fromClaude: Agent/Task -> agent', () => {
  assert.equal(fromClaude({ tool_name: 'Agent' }).kind, 'agent');
  assert.equal(fromClaude({ tool_name: 'Task' }).kind, 'agent');
});

test('fromClaude: mcp__<server>__<tool> -> mcp c server/mcpTool', () => {
  const a = fromClaude({ tool_name: 'mcp__workflow__git_commit', tool_input: {} });
  assert.equal(a.kind, 'mcp');
  assert.equal(a.server, 'workflow');
  assert.equal(a.mcpTool, 'git_commit');
});

test('fromClaude: mcp с составным именем сервера (несколько "_")', () => {
  const a = fromClaude({ tool_name: 'mcp__claude_ai_Claude_Docs__batch', tool_input: {} });
  assert.equal(a.kind, 'mcp');
  assert.equal(a.server, 'claude_ai_Claude_Docs');
  assert.equal(a.mcpTool, 'batch');
});

test('fromClaude: неизвестный инструмент -> other, без ошибки', () => {
  const a = fromClaude({ tool_name: 'SomethingWeird', tool_input: {} });
  assert.equal(a.kind, 'other');
});

test('fromClaude: пустой вход не падает', () => {
  const a = fromClaude({});
  assert.equal(a.kind, 'other');
});

// --- fromKilo ----------------------------------------------------------------

// Kilo на Windows сам выбирает shell: `shell` из ~/.config/kilo/kilo.jsonc, затем SHELL, затем
// pwsh → powershell → Git Bash (kilo.exe). Хук повторяет этот выбор; домашний каталог и SHELL
// подменяются на время теста, конфиг пользователя не читается.
function withKiloEnv({ shell, config }, fn) {
  const home = mkdtempSync(join(tmpdir(), 'rails-kilo-home-'));
  const saved = { SHELL: process.env.SHELL, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  try {
    if (config !== undefined) {
      mkdirSync(join(home, '.config', 'kilo'), { recursive: true });
      writeFileSync(join(home, '.config', 'kilo', 'kilo.jsonc'), config, 'utf8');
    }
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    if (shell === undefined) delete process.env.SHELL; else process.env.SHELL = shell;
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

test('fromKilo: bash -> shell; диалект — как выберет Kilo', () => {
  const bash = () => fromKilo({ tool: 'bash' }, { args: { command: 'echo hi' } });
  if (process.platform !== 'win32') {
    assert.deepEqual(bash(), { tool: 'bash', kind: 'shell', command: 'echo hi', shell: 'posix' });
    return;
  }
  withKiloEnv({}, () => assert.deepEqual(bash(), { tool: 'bash', kind: 'shell', command: 'echo hi', shell: 'powershell' }));
  withKiloEnv({ shell: '/bin/bash.exe' }, () => assert.equal(bash().shell, 'posix'));
  withKiloEnv({ shell: '/bin/bash.exe', config: '{\n  // shell\n  "shell": "pwsh",\n}' }, () => assert.equal(bash().shell, 'powershell'));
  withKiloEnv({ config: '{ broken' }, () => assert.deepEqual(bash().dialects, ['posix', 'powershell']));
});

// Kilo bash запускает команду в workdir (вместо cd): без него в действии хук считал цели
// записи от каталога проекта и пропускал запись в чужой каталог (ревью 2026-09-24).
test('fromKilo: bash с workdir — каталог запуска сохраняется в действии, пустой отбрасывается', () => {
  const a = fromKilo({ tool: 'bash' }, { args: { command: 'echo x > f', workdir: 'D:/elsewhere' } });
  assert.equal(a.workdir, 'D:/elsewhere');
  const b = fromKilo({ tool: 'bash' }, { args: { command: 'echo hi', workdir: '' } });
  assert.equal('workdir' in b, false);
});

test('fromKilo: edit/patch/multiedit -> edit c filePath', () => {
  for (const tool of ['edit', 'patch', 'multiedit']) {
    const a = fromKilo({ tool }, { args: { filePath: '/x/y.js' } });
    assert.equal(a.kind, 'edit', tool);
    assert.equal(a.path, '/x/y.js');
  }
});

test('fromKilo: write -> write', () => {
  const a = fromKilo({ tool: 'write' }, { args: { filePath: '/x/z.js' } });
  assert.equal(a.kind, 'write');
  assert.equal(a.path, '/x/z.js');
});

test('fromKilo: read/glob/grep/list -> read', () => {
  for (const tool of ['read', 'glob', 'grep', 'list']) {
    assert.equal(fromKilo({ tool }, {}).kind, 'read', tool);
  }
});

test('fromKilo: task -> agent', () => {
  assert.equal(fromKilo({ tool: 'task' }, {}).kind, 'agent');
});

test('fromKilo: <server>_<tool> -> mcp (деление по первому "_")', () => {
  const a = fromKilo({ tool: 'workflow_git_commit' }, {});
  assert.equal(a.kind, 'mcp');
  assert.equal(a.server, 'workflow');
  assert.equal(a.mcpTool, 'git_commit');
});

test('fromKilo: неизвестное имя без "_" -> other', () => {
  const a = fromKilo({ tool: 'somethingweird' }, {});
  assert.equal(a.kind, 'other');
});

test('fromKilo: без output -> не падает', () => {
  const a = fromKilo({ tool: 'bash' });
  assert.equal(a.kind, 'shell');
  assert.equal(a.command, undefined);
});

// --- detectShellWrites --------------------------------------------------------

test('detectShellWrites: редирект > извлекает путь', () => {
  assert.deepEqual(detectShellWrites('echo hi > out.txt'), ['out.txt']);
});

test('detectShellWrites: редирект >> извлекает путь', () => {
  assert.deepEqual(detectShellWrites('echo hi >> log.txt'), ['log.txt']);
});

test('detectShellWrites: fd-редирект 2>&1 не считается записью в файл', () => {
  assert.deepEqual(detectShellWrites('cmd 2>&1'), []);
});

test('detectShellWrites: sed -i извлекает путь файла', () => {
  const r = detectShellWrites(`sed -i 's/a/b/' file.txt`);
  assert.deepEqual(r, ['file.txt']);
});

test('detectShellWrites: sed без -i не считается записью', () => {
  assert.deepEqual(detectShellWrites(`sed 's/a/b/' file.txt`), []);
});

test('detectShellWrites: tee извлекает путь', () => {
  assert.deepEqual(detectShellWrites('echo hi | tee out.log'), ['out.log']);
});

test('detectShellWrites: rm извлекает путь(и)', () => {
  const r = detectShellWrites('rm -f a.txt b.txt');
  assert.deepEqual(new Set(r), new Set(['a.txt', 'b.txt']));
});

test('detectShellWrites: cp — путь записи только последний аргумент (назначение); mv — назначение и источник (удаляется)', () => {
  // ЗАДАЧА C2 (2026-09-22): `mv <вне>/f <scope>/f` уносит файл извне — источник mv тоже запись.
  assert.deepEqual(detectShellWrites('mv a.txt b.txt'), ['b.txt', 'a.txt']);
  assert.deepEqual(detectShellWrites('cp a.txt b.txt c.txt dest.txt'), ['dest.txt']);
});

test('detectShellWrites: cp с источником вне scope не ловит источник как запись (regression)', () => {
  // Раньше `cp /etc/x <scope>/y` давал ложный отказ «запись вне области»
  // из-за источника /etc/x — писать нужно только в <scope>/y. (ЗАДАЧА C2: назначение
  // относительное — `/scope/y` под Git Bash неоднозначен, это каталог Git, не корень диска.)
  assert.deepEqual(detectShellWrites('cp /etc/x scope/y'), ['scope/y']);
});

test('detectShellWrites: mkdir/touch извлекают путь', () => {
  assert.deepEqual(detectShellWrites('mkdir -p some/dir'), ['some/dir']);
  assert.deepEqual(detectShellWrites('touch some/file.txt'), ['some/file.txt']);
});

test('detectShellWrites: del (cmd.exe) извлекает путь', () => {
  assert.deepEqual(detectShellWrites('del file.txt'), ['file.txt']);
});

test('detectShellWrites: PowerShell Remove-Item/Set-Content/Out-File', () => {
  assert.deepEqual(detectShellWrites('Remove-Item file.txt'), ['file.txt']);
  assert.deepEqual(detectShellWrites('Set-Content -Path a.txt -Value hi'), ['a.txt']);
  assert.deepEqual(detectShellWrites('Out-File -FilePath b.txt'), ['b.txt']);
});

test('detectShellWrites: признак записи без пути даёт маркер "?"', () => {
  // rm без аргументов (после отбрасывания флагов) — команда есть, путь нет.
  assert.deepEqual(detectShellWrites('rm -rf'), ['?']);
});

test('detectShellWrites: команда без признаков записи -> []', () => {
  assert.deepEqual(detectShellWrites('ls -la /tmp'), []);
  assert.deepEqual(detectShellWrites('git status'), []);
});

test('detectShellWrites: несколько независимых команд через ; учитываются раздельно', () => {
  const r = detectShellWrites('touch a.txt; echo done');
  assert.deepEqual(r, ['a.txt']);
});

test('detectShellWrites: sed -i в цепочке с последующей командой не захватывает чужой токен', () => {
  const r = detectShellWrites(`sed -i 's/a/b/' file.txt; echo done`);
  assert.deepEqual(r, ['file.txt']);
});

// --- detectShellWrites: кавычки не путают редирект (blocker-регресс) ---------

test('detectShellWrites: ">" внутри кавычек — не редирект, ложного отказа нет', () => {
  assert.deepEqual(detectShellWrites('grep "a > b" file.txt'), []);
  assert.deepEqual(detectShellWrites('git commit -m "fix > bug"'), []);
});

test('detectShellWrites: редирект в путь с пробелом в кавычках, вплотную к ">"', () => {
  assert.deepEqual(detectShellWrites('echo hi >"a b.txt"'), ['a b.txt']);
});

test('detectShellWrites: fd-редирект в файл (N>/N>>) распознаётся', () => {
  assert.deepEqual(detectShellWrites('cmd 2> err.txt'), ['err.txt']);
  assert.deepEqual(detectShellWrites('cmd 2>> err.log'), ['err.log']);
});

// --- detectShellWrites: командное слово только в позиции команды (major/minor-регресс) ---

test('detectShellWrites: слово команды записи в аргументе read-only команды не ловится (grep/echo)', () => {
  assert.deepEqual(detectShellWrites('grep -rn "touch" src/'), []);
  assert.deepEqual(detectShellWrites('echo rm'), []);
});

test('detectShellWrites: sudo/xargs/command — обёртки, следующее слово — командное', () => {
  assert.deepEqual(detectShellWrites('sudo rm -f a.txt'), ['a.txt']);
  assert.deepEqual(detectShellWrites('xargs rm'), ['?']);
});

test('detectShellWrites: find -exec rm {} — "rm" после "-exec" всё ещё распознаётся', () => {
  const r = detectShellWrites('find . -exec rm {} \\;');
  assert.ok(r.length > 0, 'запись должна быть замечена, а не потеряна');
});

test('detectShellWrites: git — обёртка позиции, но не команда записи сама по себе', () => {
  assert.deepEqual(detectShellWrites('git commit -m "touch a"'), []);
});

test('detectShellWrites: редирект в псевдоустройство (/dev/null) — не запись и не маркер "?"', () => {
  assert.deepEqual(detectShellWrites('node cli.mjs report --skill coach 2>/dev/null | head -14'), []);
  // раунд 5: в POSIX `NUL` — обычный файл (Git Bash создаёт его, проверено запуском),
  // псевдоустройство только в PowerShell
  assert.deepEqual(detectShellWrites('dir > NUL'), ['NUL']);
  assert.deepEqual(detectShellWrites('dir > NUL', { dialect: 'powershell' }), []);
  assert.deepEqual(detectShellWrites('cmd 2>/dev/null > out.txt'), ['out.txt']);
});

test('detectShellWrites: sed -i без отдельного файлового аргумента — маркер "?", не сам скрипт', () => {
  const r = detectShellWrites(`sed -i "s/a/b/"; touch a`);
  assert.ok(r.includes('?'), 'скрипт sed не должен восприниматься как путь');
  assert.ok(!r.includes('s/a/b/'));
  assert.ok(r.includes('a')); // touch a после ";" — отдельная, реальная запись
});

test('detectShellWrites: PowerShell-командлет без -Path и без позиционного пути (значение именованного параметра) — маркер "?"', () => {
  assert.deepEqual(detectShellWrites('Set-Content -Value hi'), ['?']);
});

test('detectShellWrites: маркер "?" не теряется, когда в смешанной команде уже есть распознанный путь', () => {
  // Раньше `?` добавлялся только при пустом found — здесь found уже
  // содержит "/scope/a" (от touch), а вторая, нераспознанная запись (rm без
  // аргумента после отбрасывания флагов) молча терялась.
  const r = detectShellWrites('touch scope/a; rm -rf');
  assert.ok(r.includes('scope/a'));
  assert.ok(r.includes('?'));
});

// --- detectShellWrites(command, {cwd, env, dialect}) — ЗАДАЧА C2 (2026-09-22) -----------
// Инциденты коуча на рельсах: `cd <skillDir> && sed -i … SKILL.md` проверялся от cwd сессии,
// `S="…"; sed -i … "$S/файл"` брался буквально. Первая версия исправления (ЗАДАЧА C)
// отклонена ревью — ложные разрешения; ниже — repro каждого high/medium замечания
// (round1-shell-writes.json, round3-writes-routed.json): ожидается '?' или путь вне области.
// Пути фикстуры на диске не создаются (кроме теста с junction).

// Полная форма временного каталога: на раннере GitHub Windows он короткий (`RUNNER~1`), а `~`
// в литерале значения флага (`--t=…`, `-Path:…`, `of=…`) детектор честно считает неизвестным.
const BASE = join(realpathSync.native(tmpdir()), 'rails-c2-probe');
const SCOPE = join(BASE, 'scope');
const OUT = join(BASE, 'outside');
const ROOT = join(BASE, 'root');
const fwd = (p) => p.replace(/\\/g, '/');
const S = fwd(SCOPE);
const O = fwd(OUT);
const writes = (command, opts = {}) => detectShellWrites(command, { cwd: SCOPE, env: {}, ...opts });
const psWrites = (command, opts = {}) => writes(command, { dialect: 'powershell', ...opts });
// Путь PowerShell с `\`: на Windows — как есть, на POSIX `\` — разделитель (pwsh 7.6 на Linux).
const psPath = (p) => (process.platform === 'win32' ? p : p.replace(/\\/g, '/'));
const at = (...p) => resolvePathAbs(...p);

// «Поймано»: запись вне области видна ядру — путь снаружи или маркер '?'.
function assertCaught(result, outsidePath, label) {
  const caught = result.includes('?') || result.some((p) => p !== '?' && resolvePathAbs(p).toLowerCase() === resolvePathAbs(outsidePath).toLowerCase());
  assert.ok(caught, `${label}: запись вне области не видна — ${JSON.stringify(result)}`);
}

test('detectShellWrites (C2, bypass HIGH #1): присваивание не прячет команду и редирект — X=$(touch …), FOO=bar > f, $x = (Remove-Item …)', () => {
  assert.deepEqual(writes(`X=$(touch ${O}/x.txt)`), [`${O}/x.txt`]);
  assert.deepEqual(writes(`FOO=bar > ${O}/x.txt`), [`${O}/x.txt`]);
  assert.deepEqual(psWrites(`$x = (Remove-Item ${O}/x.txt)`), [`${O}/x.txt`]);
  assert.deepEqual(psWrites(`$null = Remove-Item ${O}/x.txt`), [`${O}/x.txt`]);
});

test('detectShellWrites (C2, correctness HIGH #1): env-префикс `NAME=v cmd > f` и `$x = cmd > f` — редирект виден', () => {
  assert.deepEqual(writes(`X=1 cat a > ${O}/file`), [`${O}/file`]);
  assert.deepEqual(psWrites(`$x = Get-Content a > ${O}/f`), [`${O}/f`]);
  assert.deepEqual(writes(`X=1 touch ${O}/x.txt`), [`${O}/x.txt`], 'LOW: команда после env-префикса');
});

test('detectShellWrites (C2, bypass HIGH #2): cd не съедает остаток сегмента — `&`, `|`, $(…) после каталога', () => {
  assertCaught(writes(`cd ${S} & touch ${O}/x.txt`), `${O}/x.txt`, 'cd X & touch');
  assertCaught(writes(`cd ${S} | tee ${O}/x.txt`), `${O}/x.txt`, 'cd X | tee');
  assertCaught(writes(`cd ${S} $(touch ${O}/x.txt)`), `${O}/x.txt`, 'cd X $(touch)');
});

test('detectShellWrites (C2, bypass HIGH #3 / correctness #5): popd и `cd -` — каталог неизвестен, относительная запись → "?"', () => {
  const o = { cwd: ROOT };
  assert.deepEqual(writes(`pushd ${S} && popd && touch x.txt`, o), ['?']);
  assert.deepEqual(writes(`cd ${S}/inner && cd - && touch x.txt`, o), ['?']);
  assert.deepEqual(writes(`pushd ${O} && touch x && popd && touch y`), [at(OUT, 'x'), '?']);
});

test('detectShellWrites (C2, bypass MEDIUM #4): PowerShell Push-Location, chdir, Set-Location -Path/-LiteralPath меняют каталог', () => {
  for (const form of ['Push-Location', 'chdir', 'Set-Location -Path', 'Set-Location -LiteralPath', 'sl', 'cd']) {
    const r = psWrites(`${form} ${O}; Remove-Item x.txt`);
    // после `;` запись выполнится и при неудачной смене каталога — в прежнем (проверено запуском PS 5.1)
    assert.deepEqual(r, [at(OUT, 'x.txt'), at(SCOPE, 'x.txt')], form);
  }
});

test('detectShellWrites (C2, bypass MEDIUM #5): cd с флагами — не трекается (кроме `--`); редирект — только в псевдоустройство', () => {
  assert.deepEqual(writes(`cd -- ${O} && touch x.txt`), [at(OUT, 'x.txt')]);
  assert.deepEqual(writes(`cd -P ${O} && touch x.txt`), ['?']);
  assert.deepEqual(writes(`cd "${O}" 2>&1 && touch x.txt`), ['?'], 'дубль дескриптора — не псевдоустройство');
  // раунд 5, LOW-1: `cd … 2>/dev/null` в каталог переходит (проверено запуском) — не отказ
  assert.deepEqual(writes(`cd ${O} 2>/dev/null && touch x.txt`), [at(OUT, 'x.txt')]);
});

test('detectShellWrites (C2, bypass MEDIUM #6 / correctness #3): нераскрываемый аргумент cd — каталог неизвестен', () => {
  assert.deepEqual(writes('cd $UNSET_VAR_XYZ_123 && touch x.txt'), ['?']);
  assert.deepEqual(writes('cd "$(dirname "$PWD")" && touch x.txt'), ['?']);
  assert.deepEqual(writes('cd "$MISSING" && touch x'), ['?']);
  assert.deepEqual(writes('cd $(mktemp -d) && touch x'), ['?']);
  // $PWD — отслеживаемый каталог, не переменная окружения процесса хука
  assert.deepEqual(writes('cd "$PWD/.." && touch outside.txt'), [at(SCOPE, '..', 'outside.txt')]);
  assert.deepEqual(writes('touch "$PWD/../outside.txt"'), [`${SCOPE}/../outside.txt`]);
});

test('detectShellWrites (C2, bypass MEDIUM #7): остаточные $, ${env:…}, бэктики, $x.Path в пути — не буква пути', () => {
  assert.deepEqual(psWrites('Remove-Item "${env:ZZ_T}/x.txt"', { env: { ZZ_T: O } }), [`${O}/x.txt`]);
  assert.deepEqual(writes('touch `pwd`/../x.txt'), ['?']);
  assert.deepEqual(writes('S=$(dirname "$PWD"); touch "$S/x.txt"'), ['?']);
  assert.deepEqual(psWrites('Remove-Item "$x.Path/x.txt"', { env: { x: O } }), ['?']);
  assert.deepEqual(psWrites('Remove-Item $x.Path'), ['?']);
});

test('detectShellWrites (C2, correctness HIGH #2): значение переменной с нераскрываемой частью — "?"', () => {
  assert.deepEqual(writes('S="$NOPE/outside"; touch "$S/x"'), ['?']);
  assert.deepEqual(writes('S=$(pwd); touch "$S/x"'), ['?']);
});

test('detectShellWrites (C2, correctness MEDIUM #6): тело heredoc не исполняется — cd/mkdir в нём не считаются', () => {
  assert.deepEqual(writes(`cat > ${S}/a.md <<'EOF'\n# notes\nmkdir build\nEOF`), [`${S}/a.md`]);
  assert.deepEqual(writes(`cat > ${S}/s.sh <<'EOF'\ncd ${S}\nEOF\ntouch after.txt`, { cwd: OUT }), [`${S}/s.sh`, at(OUT, 'after.txt')]);
  // незакавыченный разделитель: $(…) в теле выполняется
  assert.deepEqual(writes(`cat > f <<EOF\n$(touch ${O}/h.txt)\nEOF`), [`${O}/h.txt`, at(SCOPE, 'f')]);
  // cd после heredoc — каталог неизвестен
  assert.deepEqual(writes(`cat <<'EOF'\nx\nEOF\ncd ${S} && touch y`), ['?']);
});

test('detectShellWrites (C2, LOW): cd внутри (…), for, if — каталог неизвестен; `\\"` в "…" не прячет запись', () => {
  assert.deepEqual(writes(`(cd ${O} && touch x.txt)`), ['?']);
  assert.deepEqual(writes(`for d in ${O}; do cd $d; touch x.txt; done`), ['?']);
  assert.deepEqual(writes(`if true; then cd ${O}; touch x.txt; fi`), ['?']);
  assert.deepEqual(writes(`echo \\" ; cd ${O}; touch ${O}/x.txt`), [`${O}/x.txt`]);
  // цикл: смена каталога ниже по тексту действует на запись выше (вторая итерация)
  assert.deepEqual(writes(`while true; do touch x.txt; cd ${O}; done`), ['?']);
});

test('detectShellWrites (C2, round3 MEDIUM a): `\\"` внутри "…" не открывает кавычку — редирект после `;` виден', () => {
  const r = writes(`node .workflow/src/rails/cli.mjs goto P5E1 --quote "a \\" b" ; echo INJECTED > ${fwd(ROOT)}/PWNED.txt ; echo "x"`);
  assert.deepEqual(r, [`${fwd(ROOT)}/PWNED.txt`]);
});

test('detectShellWrites (C2, round3 MEDIUM b): `>&файл` (не число и не -) — запись stdout+stderr в файл', () => {
  assert.deepEqual(writes(`node .workflow/src/rails/cli.mjs status >&${fwd(ROOT)}/PWNED.txt`), [`${fwd(ROOT)}/PWNED.txt`]);
  assert.deepEqual(writes(`echo x 1>&${O}/f6.txt`), [`${O}/f6.txt`], 'N>&файл — bash тоже создаёт файл (проверено запуском)');
  assert.deepEqual(writes('cmd >&2 2>&1 >&-'), [], 'дескрипторы — не запись');
});

test('detectShellWrites (C2): все формы редиректа в файл — >|, &>, &>>, <>, оператор внутри слова; PowerShell *>, N>', () => {
  assert.deepEqual(writes(`echo a >| ${O}/c.txt`), [`${O}/c.txt`]);
  assert.deepEqual(writes(`echo a &> ${O}/c.txt`), [`${O}/c.txt`]);
  assert.deepEqual(writes(`echo a &>> ${O}/c.txt`), [`${O}/c.txt`]);
  assert.deepEqual(writes(`exec 3<>${O}/rw.txt`), [`${O}/rw.txt`]);
  assert.deepEqual(writes(`echo x>${O}/mid.txt`), [`${O}/mid.txt`], 'bash делит слово на `>` (проверено запуском)');
  assert.deepEqual(writes(`echo \\>& touch ${O}/amp.txt`), [`${O}/amp.txt`], '`\\>` — литерал, `&` — фон: touch выполняется');
  assert.deepEqual(psWrites(`Write-Output x *> ${O}/s.txt`), [`${O}/s.txt`]);
  assert.deepEqual(psWrites(`Write-Output x 3>> ${O}/s.txt`), [`${O}/s.txt`]);
  assert.deepEqual(psWrites('Write-Output x 2>$null > $null'), []);
  assert.deepEqual(writes('cmd 2>/dev/null >NUL'), [at(SCOPE, 'NUL')], 'раунд 5: NUL в POSIX — обычный файл');
});

test('detectShellWrites (C2): сканер не разобрал команду (незакрытая кавычка/heredoc) — "?"', () => {
  assert.deepEqual(writes('echo "unclosed'), ['?']);
  assert.deepEqual(writes('cat <<EOF\nno end'), ['?']);
  assert.deepEqual(psWrites("Write-Output 'open"), ['?']);
});

test('detectShellWrites (C2, инцидент): cd <skillDir> && sed -i … SKILL.md — путь от каталога после cd', () => {
  const skillDir = join(ROOT, 'src', 'skills', 'analyze-report');
  assert.deepEqual(writes(`cd ${fwd(skillDir)} && sed -i 's/a/b/' SKILL.md`, { cwd: ROOT }), [at(skillDir, 'SKILL.md')]);
  // относительный cd без ./ — от каталога, если CDPATH не задан (раунд 2: см. тест ниже)
  assert.deepEqual(writes('cd ./a && cd ./b && touch c.txt'), [at(SCOPE, 'a', 'b', 'c.txt')]);
  assert.deepEqual(writes('cd a && touch c.txt'), [at(SCOPE, 'a', 'c.txt')]);
  assert.deepEqual(psWrites('Set-Location src\\skills; Remove-Item plan.md'), [at(SCOPE, 'src', 'skills', 'plan.md'), at(SCOPE, 'plan.md')]);
  // `\` — разделитель PowerShell и на POSIX (pwsh 7.6 на Linux удаляет файл двумя каталогами
  // выше, проверено запуском 2026-09-25): выход из области не выглядит именем файла внутри
  assert.deepEqual(psWrites('Remove-Item ..\\..\\x.txt'), [at(SCOPE, '..', '..', 'x.txt')]);
});

test('detectShellWrites (C2, инцидент): S=<abs>; sed -i … "$S/f" — переменная раскрывается; одинарные кавычки — литерал', () => {
  assert.deepEqual(writes(`S="${S}"; sed -i "s/a/b/" "$S/rails-trials-report.mjs"`), [`${S}/rails-trials-report.mjs`]);
  assert.deepEqual(writes(`export S="${S}"; touch "\${S}/a.txt"`), [`${S}/a.txt`]);
  assert.deepEqual(writes(`declare A=${O} B="${S}"; touch "$B/x"`), [`${S}/x`]);
  assert.deepEqual(writes(`touch '$FOO/x'`, { env: { FOO: O } }), [at(SCOPE, '$FOO', 'x')]);
  assert.deepEqual(writes('touch "$FOO/x"', { env: { FOO: O } }), [`${O}/x`]);
  assert.deepEqual(writes('touch "$MISSING/file.txt"'), ['?']);
  // `local` вне функции — ошибка bash, присваивания нет (проверено запуском)
  assert.deepEqual(writes(`local S=${O}; touch "$S/x.txt"`), ['?']);
});

test('detectShellWrites (C2): PowerShell — $x = \'…\', $env:X, $HOME; $X без присваивания — не переменная окружения', () => {
  assert.deepEqual(psWrites(`$D = '${S}'; Remove-Item "$D\\a.txt"`), [psPath(`${S}\\a.txt`)]);
  assert.deepEqual(psWrites(`$env:D = '${S}'; Remove-Item "$env:D\\a.txt"`), [psPath(`${S}\\a.txt`)]);
  assert.deepEqual(psWrites('Remove-Item "$env:MYROOT\\a.txt"', { env: { MYROOT: S } }), [psPath(`${S}\\a.txt`)]);
  assert.deepEqual(psWrites('Remove-Item "$HOME\\a"'), [psPath(`${homedir()}\\a`)]);
  assert.deepEqual(psWrites('Remove-Item "$MYROOT\\a.txt"', { env: { MYROOT: S } }), ['?'], '$MYROOT в PowerShell пуста (проверено запуском)');
  assert.deepEqual(psWrites('Remove-Item "$env:MISSING\\a.txt"'), ['?']);
});

test('detectShellWrites (C2): переменная, которой где-либо присваивают нетрекаемо, неизвестна везде', () => {
  assert.deepEqual(writes(`S=${S}; read S; touch "$S/f"`), ['?']);
  assert.deepEqual(writes(`S=${S}; for S in ${O}; do :; done; touch "$S/f"`), ['?']);
  assert.deepEqual(writes(`echo $((S=5)); S=${S}; touch "$S/f"`), ['?']);
  assert.deepEqual(writes(`S=${S}; : \${S:=x}; touch "$S/f"`), ['?']);
  assert.deepEqual(writes(`readonly S=${S}; S=${O}; touch "$S/f"`), ['?']);
  assert.deepEqual(writes(`S=${S}; eval "S=${O}"; touch "$S/f"`), ['?']);
  assert.deepEqual(psWrites(`$S = '${S}'; foreach ($S in '${O}') {}; Remove-Item "$S\\f"`), ['?'], 'переменная foreach сохраняется (проверено запуском)');
  assert.deepEqual(psWrites(`$S = '${S}'; Get-Item x -OutVariable S; Remove-Item "$S\\f"`), ['?']);
  // верхний уровень плоский, цикл — внутри $(…): переменная цикла всё равно неизвестна
  assert.deepEqual(psWrites(`$S = '${S}'; $null = $(foreach ($S in '${O}') {}); Remove-Item "$S\\f"`), ['?']);
  assert.deepEqual(psWrites(`$S = '${S}'; $PSDefaultParameterValues['*:OutVariable'] = 'S'; Get-Item x; Remove-Item "$S\\f"`), ['?']);
});

test('detectShellWrites (C2): "~" — домашний каталог (POSIX вне кавычек, PowerShell в любых кавычках)', () => {
  // раунд 5, LOW-2: в POSIX `~` берётся из env HOME (тот же источник, что у `$HOME`)
  const home = { env: { HOME: homedir() } };
  assert.deepEqual(writes('touch ~/scratch.txt', home), [`${homedir()}/scratch.txt`]);
  assert.deepEqual(writes('cd ~/proj && touch a.txt', home), [at(homedir(), 'proj', 'a.txt')]);
  assert.deepEqual(writes('touch "~/x"', home), [at(SCOPE, '~', 'x')], 'в кавычках bash не раскрывает ~ (проверено запуском)');
  assert.deepEqual(psWrites("Set-Content -LiteralPath '~\\x' -Value 1"), [psPath(`${homedir()}\\x`)], 'PowerShell: $HOME — автоматическая переменная, не env:HOME (проверено запуском PS 5.1)');
  assert.deepEqual(writes('touch ~other/x', home), ['?']);
});

test('detectShellWrites (C2): `;`/`||` после cd — запись и в прежнем каталоге; `&&` — только в новом', () => {
  const o = { cwd: ROOT };
  assert.deepEqual(writes(`cd ${S}/sub; touch x`, o), [at(SCOPE, 'sub', 'x'), at(ROOT, 'x')]);
  assert.deepEqual(writes(`cd ${S}/sub || touch x`, o), [at(ROOT, 'x')]);
  assert.deepEqual(writes(`cd ${S}/sub && touch x`, o), [at(SCOPE, 'sub', 'x')]);
  assert.deepEqual(writes(`cd ${S}/sub && touch a; touch b`, o), [at(SCOPE, 'sub', 'a'), at(SCOPE, 'sub', 'b'), at(ROOT, 'b')]);
});

test('detectShellWrites (C2): команды записи — mv (источник), cp -t, sed -i нескольких файлов, find -delete/-exec, xargs, имя в другом регистре', () => {
  assert.deepEqual(writes(`mv ${O}/secret ${S}/x`), [`${S}/x`, `${O}/secret`]);
  assert.deepEqual(writes(`cp -t ${O} a b`), [O]);
  assert.deepEqual(writes(`cp -vt ${O} a b`), [O]);
  assert.deepEqual(writes('sed -i s/a/b/ f1 f2'), [at(SCOPE, 'f1'), at(SCOPE, 'f2')]);
  assert.deepEqual(writes('sed -ni -e s/a/b/ f1'), [at(SCOPE, 'f1')]);
  assert.deepEqual(writes(`find ${O} -delete`), [O]);
  assert.deepEqual(writes('find . -name "*.tmp" -exec rm {} \\;'), [SCOPE]);
  assert.deepEqual(writes(`find . -exec mv {} ${O} \\;`), [O, SCOPE]);
  assert.deepEqual(writes(`ls | xargs rm ${S}/a`), [`${S}/a`, '?']);
  assert.deepEqual(writes(`for f in a; do rm ${O}/x; done`), [`${O}/x`], 'команда после do');
  assert.deepEqual(writes(`git -C ${O} rm x`), ['?']);
  assert.deepEqual(writes(`eval "touch ${O}/e.txt"`), [`${O}/e.txt`]);
  assert.deepEqual(writes('$CMD x'), ['?'], 'имя команды не литерал');
  if (process.platform === 'win32') {
    assert.deepEqual(writes(`TOUCH ${O}/u.txt`), [`${O}/u.txt`], 'Git Bash: TOUCH/Touch.exe создают файл (проверено запуском)');
  }
});

test('detectShellWrites (C2): PowerShell-командлеты и алиасы — New-Item/ni, Copy-Item, Move-Item, Add-Content, iex', () => {
  assert.deepEqual(psWrites(`New-Item -ItemType File ${O}/n.txt`), [`${O}/n.txt`]);
  assert.deepEqual(psWrites(`ni ${O}/n.txt`), [`${O}/n.txt`]);
  assert.deepEqual(psWrites(`Copy-Item a ${O}/c.txt`), [`${O}/c.txt`]);
  assert.deepEqual(psWrites(`Move-Item -Path ${O}/m.txt -Destination b`), [at(SCOPE, 'b'), `${O}/m.txt`]);
  assert.deepEqual(psWrites(`Add-Content -Path:${O}/a.txt -Value 1`), [`${O}/a.txt`]);
  assert.deepEqual(psWrites(`iex "Remove-Item ${O}/e.txt"`), [`${O}/e.txt`]);
  assert.deepEqual(psWrites(`touch ${O}/t.txt`), [`${O}/t.txt`], 'touch.exe из Git в PATH PowerShell (проверено запуском)');
  assert.deepEqual(psWrites(`Remove-Item ${O}/a,${O}/b`), ['?'], 'a,b — массив путей');
  assert.deepEqual(psWrites('Get-ChildItem | Select-Object Name'), []);
});

test('detectShellWrites (C2): шаблоны и brace expansion — "?" кроме удаления по шаблону в последнем компоненте', () => {
  assert.deepEqual(writes(`rm -rf ${S}/*.tmp`), [`${S}/*.tmp`]);
  assert.deepEqual(writes(`touch ${S}/*.tmp`), ['?'], 'запись по шаблону может пройти через ссылку');
  assert.deepEqual(writes(`rm -rf ${S}/*/x`), ['?']);
  assert.deepEqual(writes('rm -rf .*'), ['?']);
  assert.deepEqual(writes('touch {a,../../x}'), ['?']);
  assert.deepEqual(writes('touch "*.tmp"'), [at(SCOPE, '*.tmp')], 'в кавычках — литерал');
});

test('detectShellWrites (C2): без cwd пути остаются относительными, cd в абсолютный каталог — абсолютными', () => {
  assert.deepEqual(detectShellWrites('touch rel.txt', { env: {} }), ['rel.txt']);
  assert.deepEqual(detectShellWrites(`cd ${O} && touch rel.txt`, { env: {} }), [at(OUT, 'rel.txt')]);
  assert.deepEqual(detectShellWrites('cd ./a && touch rel.txt', { env: {} }), [join('a', 'rel.txt')]);
});

test('detectShellWrites (C2): исключение внутри разбора — "?", а не пустой результат', () => {
  // ctx.env с геттером-ловушкой: разбор падает, decide иначе превратил бы исключение в allow
  const env = new Proxy({}, { ownKeys() { throw new Error('boom'); } });
  assert.deepEqual(detectShellWrites('touch "$X/a"', { cwd: SCOPE, env }), ['?']);
});

test('detectShellWrites (C2): Git Bash — /c/… это диск C:, прочие /… (каталоги Git) — "?"', { skip: process.platform !== 'win32' ? 'msys-пути — только Git for Windows' : false }, () => {
  assert.deepEqual(writes('touch /d/tmp/x'), ['D:/tmp/x']);
  assert.deepEqual(writes('S=/d/abs; sed -i "s/a/b/" "$S/f"'), ['D:/abs/f']);
  // /tmp под Git Bash — %TEMP% (cygpath -w). До 2026-09-24 отдавался маркер «?», и песочница
  // тестов отказывала в записи во временный каталог, который сама разрешает.
  assert.deepEqual(writes('touch /tmp/x'), [join(tmpdir(), 'x')], '/tmp под Git Bash — %TEMP%, не корень диска');
  assert.deepEqual(writes('touch /tmp/../x'), ['?'], '`..` из /tmp не вычисляется');
  assert.deepEqual(writes('touch /c/../x'), ['?']);
  assert.deepEqual(psWrites('Remove-Item \\x'), [at(SCOPE, '\\x')], 'PowerShell: от корня диска текущего каталога');
});

test('detectShellWrites (C2): `..` после cd в junction — Git Bash пишет рядом с целью ссылки, путь проверяется в обоих вариантах', () => {
  const base = mkdtempSync(join(tmpdir(), 'rails-c2-junction-'));
  try {
    const scope = join(base, 'scope');
    const far = join(base, 'far');
    mkdirSync(scope, { recursive: true });
    mkdirSync(join(far, 'target'), { recursive: true });
    symlinkSync(join(far, 'target'), join(scope, 'lnk'), 'junction');
    const r = detectShellWrites(`cd ${fwd(join(scope, 'lnk'))} && touch ../x.txt`, { cwd: scope, env: {} });
    assert.deepEqual(r, [join(scope, 'x.txt'), join(realpathSync.native(far), 'x.txt')]);
    // PowerShell разрешает `..` от строки каталога (логически) — один путь
    const p = detectShellWrites(`Set-Location ${fwd(join(scope, 'lnk'))}; Remove-Item ..\\x.txt`, { cwd: scope, env: {}, dialect: 'powershell' });
    assert.deepEqual(p, [join(scope, 'x.txt'), join(base, 'x.txt')]);
    if (process.platform === 'win32') {
      // сверка с настоящим Git Bash: файл появляется рядом с целью junction
      execFileSync('bash', ['-c', `cd '${fwd(join(scope, 'lnk'))}' && touch ../x.txt`]);
      assert.equal(existsSync(join(far, 'x.txt')), true);
      assert.equal(existsSync(join(scope, 'x.txt')), false);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// --- ЗАДАЧА C2, раунд 2 (2026-09-22): дефекты ревью второй версии ------------------------------
// Каждый repro high/medium: для ложного разрешения — '?' или путь вне области; для ложного отказа
// (`cd skills/coach && …`) — путь в каталоге после cd. Поведение shell'ов проверено запуском.

test('detectShellWrites (C2 r2, MEDIUM): PowerShell — массив через запятую отдельным словом и сплаттинг @p дают "?"', () => {
  assertCaught(psWrites(`Remove-Item f1 ,${O}/f2`), `${O}/f2`, 'a ,b');
  assertCaught(psWrites(`Remove-Item f1 , ${O}/f2`), `${O}/f2`, 'a , b');
  assertCaught(psWrites(`$p = @{ LiteralPath = "${O}/f4" }; Remove-Item @p`), `${O}/f4`, 'Remove-Item @p');
  assertCaught(psWrites(`$p = @{ Path = "${O}/f" }; Set-Content @p -Value x`), `${O}/f`, 'Set-Content @p');
  // LOW: `-Path a ,b` — второй элемент массива
  assertCaught(psWrites(`Remove-Item -Path ${S}/a ,${O}/b`), `${O}/b`, '-Path a ,b');
  // `-Path:a,b` — массив (HEAD давал '?', первая версия раунда — литерал «a,b»)
  assert.deepEqual(psWrites(`Remove-Item -Path:${S}/a,${O}/b`), ['?']);
  assert.ok(psWrites('cd @p; Remove-Item x').includes('?'), 'cd @p — каталог из хэш-таблицы неизвестен');
});

test('detectShellWrites (C2 r2, MEDIUM): POSIX — присваивание с динамическим именем или элементу массива делает переменные неизвестными', () => {
  const env = { S }; // даже если одноимённая переменная есть в окружении хука
  for (const command of [
    `S=${S}; n=S; declare "$n=${O}"; touch "$S/x1"`,
    `S=${S}; S[0]=${O}; touch "$S/x2"`,
    `S=${S}; n=S; printf -v "$n" %s ${O}; touch "$S/x3"`,
    `S=${S}; n=S; export "$n=${O}"; touch "$S/x4"`,
    `S=${S}; n=S; read -r "$n" < <(echo ${O}); touch "$S/x5"`,
    `S=${S}; n=S; unset "$n"; touch "$S/x6"`,
    `S=${S}; n=S; (( x = 1, $n = 5 )); touch "$S/x7"`,
    `S=${S}; n=S; echo $(( x = 1, $n = 5 )); touch "$S/x8"`,
    `S=${S}; n=S; let "x=1, $n=2"; touch "$S/x9"`,
  ]) {
    assert.deepEqual(writes(command, { env }), ['?'], command);
  }
  // `NAME[i]=v cmd` — префикс-присваивание, команда выполняется (проверено запуском: bash пишет
  // «not a valid identifier», но touch создаёт файл); env: присваивание — любое слово с `=`
  assert.deepEqual(writes(`S[0]=x touch ${O}/f`), [`${O}/f`]);
  assert.deepEqual(writes(`env ./x=y touch ${O}/f`), [`${O}/f`]);
  // контроль: сравнение в [ ] и литеральные имена не делают неизвестными все переменные
  assert.deepEqual(writes(`S=${S}; [ $x = y ]; printf -v out '%s' "$x"; touch "$S/ok"`), [`${S}/ok`]);
});

test('detectShellWrites (C2 r2, MEDIUM): cp/mv/sed/touch/mkdir — однозначный префикс длинного флага GNU', () => {
  assert.deepEqual(writes(`cp --target ${O} ${S}/a.txt`), [O]);
  assert.deepEqual(writes(`cp --t=${O} a.txt`), [O]);
  assert.deepEqual(writes(`cp --targ ${O} a.txt`), [O]);
  assert.deepEqual(writes(`mv --t ${O} a.txt`), [O, at(SCOPE, 'a.txt')]);
  assert.deepEqual(writes(`sed --in s/a/b/ ${O}/f`), [`${O}/f`]);
  assert.deepEqual(writes(`sed --in-pl=.bak --expr=s/a/b/ ${O}/f`), [`${O}/f`]);
  assert.deepEqual(writes(`cp a ${O}/f --sparse always`), [`${O}/f`], '--sparse WHEN — значение, не назначение');
  assert.deepEqual(writes(`mkdir --m 700 ${O}/d`), [`${O}/d`]);
  assert.deepEqual(writes(`touch --d 2020-01-01 ${O}/t`), [`${O}/t`]);
});

test('detectShellWrites (C2 r2): невычисленное слово, которое может быть флагом, у cp/mv/sed/find — "?"', () => {
  assertCaught(writes(`cp "$o" a ${S}/b`), O, 'cp "$o" (o=--target-directory=…)');
  assert.deepEqual(writes('sed "$o" s/a/b/ f'), ['?'], 'sed "$o" (o=-i)');
  assert.deepEqual(writes('find "$X" -name y'), ['?'], 'find "$X" (X=-delete)');
  assert.deepEqual(writes(`o=-t; cp $o ${O} a`), [O], 'известное значение классифицируется как флаг');
  // контроль: литеральное начало слова — не флаг
  assert.deepEqual(writes('sed -n "s/$x/y/p" f'), []);
  assert.deepEqual(writes('find . -name "*.$ext"'), []);
  assert.deepEqual(writes('find . -name -delete'), [], 'значение -name — не действие');
});

test('detectShellWrites (C2 r2, MEDIUM): `cd <относительный без ./> && …` — от каталога, пока CDPATH/cdable_vars не могут вмешаться', () => {
  assert.deepEqual(writes('cd skills/coach && sed -i s/a/b/ SKILL.md'), [at(SCOPE, 'skills', 'coach', 'SKILL.md')]);
  assert.deepEqual(writes('set -e; cd skills && touch x'), [at(SCOPE, 'skills', 'x')]);
  assert.deepEqual(writes('cd skills/coach && touch x', { env: { CDPATH: O } }), ['?']);
  assert.deepEqual(writes(`CDPATH=${O}; cd skills && touch x`), ['?']);
  assert.deepEqual(writes(`export CDPATH=${O}; cd skills && touch x`), ['?']);
  assert.deepEqual(writes('shopt -s cdable_vars; cd skills && touch x'), ['?']);
  assert.deepEqual(writes('cd skills && touch x', { env: { BASHOPTS: 'cdable_vars:checkwinsize' } }), ['?']);
  assert.deepEqual(writes('cd skills && touch x', { env: { CDPATH: '' } }), [at(SCOPE, 'skills', 'x')], 'пустой CDPATH = не задан (проверено запуском)');
});

test('detectShellWrites (C2 r2, LOW): PowerShell — тире – — ― как префикс параметра, префиксы имён, `--`, кавычки', () => {
  assert.deepEqual(psWrites(`Set-Content –Path ${O}/en1.txt –Value x`), [`${O}/en1.txt`]);
  assert.deepEqual(psWrites(`Set-Content —Path ${O}/em.txt —Value x`), [`${O}/em.txt`]);
  assert.deepEqual(psWrites(`Set-Content ―Path ${O}/hb.txt`), [`${O}/hb.txt`]);
  assert.deepEqual(psWrites(`Remove-Item –Recurse ${O}/r`), [`${O}/r`]);
  // префикс переключателя (`-Fo` = -Force) не забирает следующий путь
  assert.deepEqual(psWrites(`Set-Content -Fo ${O}/x y`), [`${O}/x`]);
  // неизвестный параметр: значение или переключатель — целью считается каждое позиционное слово
  assertCaught(psWrites(`Set-Content -Foo x ${O}/b`), `${O}/b`, 'неизвестный параметр');
  // значение-массив параметра не сдвигает позиционный путь
  assert.deepEqual(psWrites(`Remove-Item -Include a, b ${O}/x`), [`${O}/x`]);
  // `--` — конец параметров; '-Path' в кавычках — позиционное значение (проверено запуском)
  assert.deepEqual(psWrites(`Remove-Item -- ${O}/x`), [`${O}/x`]);
  assert.deepEqual(psWrites("Set-Content '-Path' x"), [at(SCOPE, '-Path')]);
  assert.deepEqual(psWrites(`Set-Content -Pa'th' ${O}/v`), [at(SCOPE, '-Path')], "-Pa'th' — позиционное значение");
  assert.deepEqual(psWrites(`Set-Content --Path ${O}/v`), [at(SCOPE, '--Path')], '--Path — позиционное значение');
  // -OutVariable по префиксу имени присваивает переменной
  assert.deepEqual(psWrites(`$S = '${S}'; Get-Item x -OutVar S; Remove-Item "$S\\f"`), ['?']);
  // внешней программе PowerShell передаёт слово как есть: `–x` для touch.exe — имя файла
  assert.ok(psWrites(`touch –x ${S}/y`).includes(at(SCOPE, '–x')));
});

test('detectShellWrites (C2 r2, LOW): `..` в cd — логический и физический (`set -P`) каталоги, запись проверяется в обоих', () => {
  const base = mkdtempSync(join(tmpdir(), 'rails-c2r2-physical-'));
  try {
    const work = join(base, 'work');
    const outside = join(base, 'outside');
    mkdirSync(work, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(work, 'lnk'), 'junction');
    const realBase = realpathSync.native(base);
    const r = detectShellWrites('set -P; cd ./lnk/.. && touch x6', { cwd: work, env: {} });
    assert.deepEqual(r, [join(work, 'x6'), join(realBase, 'x6')]);
    // без ссылки варианты совпадают — один путь
    mkdirSync(join(work, 'sub'));
    assert.deepEqual(detectShellWrites('cd ./sub/.. && touch x7', { cwd: work, env: {} }), [join(work, 'x7')]);
    if (process.platform === 'win32') {
      // сверка с Git Bash: после set -P файл появляется у родителя ЦЕЛИ ссылки
      execFileSync('bash', ['-c', 'set -P; cd ./lnk/.. && touch x6'], { cwd: work });
      assert.equal(existsSync(join(base, 'x6')), true);
      assert.equal(existsSync(join(work, 'x6')), false);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('detectShellWrites (C2 r2, LOW): вложенный интерпретатор — bash -c, powershell -Command/-EncodedCommand, cmd /c, скрипт из stdin', () => {
  assert.deepEqual(writes(`bash -c 'rm -rf ${O}/x'`), [`${O}/x`]);
  assert.deepEqual(writes(`bash -o pipefail -lc 'cd ./sub && touch f'`), [at(SCOPE, 'sub', 'f')]);
  assert.deepEqual(writes(`find . -exec sh -c "rm ${O}/fx" \\;`), [`${O}/fx`]);
  assert.deepEqual(psWrites(`bash -c 'rm ${O}/q'`), [`${O}/q`]);
  assert.deepEqual(writes(`powershell.exe -NoProfile -Command "Remove-Item ${O}/z"`), [`${O}/z`]);
  // регистр имени .exe не важен и на POSIX: WSL запускает `PowerShell.EXE` (проверено запуском)
  assert.deepEqual(writes(`PowerShell.EXE -Command "Remove-Item ${O}/z2"`), [`${O}/z2`]);
  const b64 = Buffer.from(`Remove-Item ${O}/enc.txt`, 'utf16le').toString('base64');
  assert.deepEqual(writes(`powershell -e ${b64}`), [`${O}/enc.txt`]);
  assert.deepEqual(writes(`powershell -EncodedCommand ${b64}`), [`${O}/enc.txt`]);
  assert.deepEqual(writes(`bash <<'EOF'\nrm -rf ${O}/h\nEOF`), [`${O}/h`]);
  // дочернему процессу переменные родителя видны, только если экспортированы, — неизвестны
  assert.deepEqual(writes(`D=${S}; bash -c 'touch "$D/x"'`, { env: { D: S } }), ['?']);
  assert.deepEqual(writes('bash -c "touch $D/f"', { env: { D: O } }), [`${O}/f`], 'раскрыто внешним shell\'ом');
  assert.deepEqual(writes('cd skills && bash -c "cd sub && touch f"', { env: { CDPATH: O } }), ['?']);
  for (const command of ['sh -c "$CMD"', 'echo "rm x" | bash', 'powershell -Command -', 'powershell -NoProfile', `cmd //c del ${O.replace(/\//g, '\\\\')}\\\\x`, 'cmd //c mklink //J a b', 'cmd /c "echo x > f"']) {
    assert.deepEqual(writes(command), ['?'], command);
  }
  // контроль: без записи внутри — пусто; файл скрипта не разбирается (как до ЗАДАЧИ C2)
  for (const command of ['bash --version', "powershell -c 'Get-ChildItem'", 'cmd //c dir', 'bash script.sh', 'pwsh -File x.ps1']) {
    assert.deepEqual(writes(command), [], command);
  }
});

test('detectShellWrites (C2 r2, LOW): косвенные писатели — .NET в PowerShell, dd of=, truncate, ln, install', () => {
  assert.deepEqual(psWrites(`[IO.File]::WriteAllText('${O}/w.txt', 'x')`), ['?']);
  assert.deepEqual(psWrites(`(Get-Item ${O}/x).Delete()`), ['?']);
  assert.deepEqual(psWrites(`$w = New-Object System.IO.StreamWriter('${O}/s.txt')`), ['?']);
  assert.deepEqual(psWrites(`[IO.File]::ReadAllText('${O}/w.txt')`), []);
  assert.deepEqual(writes(`dd if=a of=${O}/dd.img`), [`${O}/dd.img`]);
  assert.deepEqual(writes('dd if="$src" of=out.img'), [at(SCOPE, 'out.img')]);
  assert.deepEqual(writes('dd "$x"'), ['?'], 'операнд из переменной может быть of=');
  assert.deepEqual(writes(`truncate -s 0 ${O}/t`), [`${O}/t`]);
  assert.deepEqual(writes(`ln -s a ${O}/l`), [`${O}/l`]);
  assert.deepEqual(writes(`ln -s ${O}/y`), ['?'], 'ссылка в текущем каталоге под именем цели');
  assert.deepEqual(writes(`install -m 644 a ${O}/i`), [`${O}/i`]);
  assert.deepEqual(writes(`install -d ${O}/d1 ${O}/d2`), [`${O}/d1`, `${O}/d2`]);
});

test('detectShellWrites (C2 r2): вложенные интерпретаторы — общий бюджет на команду; `cp -- "$f"` — источник после `--` не флаг', () => {
  let command = `touch ${O}/deep`;
  for (let i = 0; i < 12; i += 1) command = `cd ./a; cd ./b; cd ./c; cd ./d; bash -c ${JSON.stringify(command)}`;
  const started = Date.now();
  assert.deepEqual(writes(command), ['?']);
  assert.ok(Date.now() - started < 5000, 'миры × уровни вложенности не растут экспоненциально');
  assert.deepEqual(writes('cp -- "$f" dest/'), [at(SCOPE, 'dest')]);
  assert.ok(writes('cp "$f" dest/').includes('?'));
});

// --- раунд 3 ревью C2 (2026-09-22) ------------------------------------------------------

// bash 5.2 (проверено запуском): `pushd +N` не идёт в каталог с именем `+N`, а вращает стек
// каталогов — после `pushd <область> && pushd +1` shell снова в исходном cwd. Трекер считал
// каталогом `<область>/+1`, и относительная запись «попадала» в область — регресс deny→allow.
test('detectShellWrites (C2 r3, HIGH): `pushd +N`/`-N` — запись стека, а не каталог: каталог после неё неизвестен', () => {
  assert.deepEqual(writes(`pushd ${S}/sub && pushd +1 && echo hi > PWNED.txt`), ['?']);
  assert.deepEqual(writes('pushd sub && pushd +1 && touch p1.txt'), ['?']);
  assert.deepEqual(writes('pushd -- +1 && touch p2.txt'), ['?']);
  assert.deepEqual(writes('pushd sub && pushd -0 && touch p3.txt'), ['?']);
  assert.deepEqual(writes('X=+1; pushd $X && touch p4.txt'), ['?'], 'значение после раскрытия');
  assert.ok(psWrites('Push-Location +1; Set-Content p5.txt x').includes('?'), 'PowerShell: каталог после `Push-Location +1` тоже неизвестен');
  // контроль: обычный pushd в каталог трекается, как cd
  assert.deepEqual(writes('pushd sub && touch p6.txt'), [at(SCOPE, 'sub', 'p6.txt')]);
  assert.deepEqual(writes(`pushd ${S}/sub && touch p7.txt`), [at(SCOPE, 'sub', 'p7.txt')]);
});

// Разделитель heredoc bash берёт со снятием кавычек (`<<E"O"F` кончается на строке `EOF`), а
// `<<<` — here-string, не heredoc. Сканер расходился с bash: команды после настоящего конца
// тела попадали в тело и пропадали из разбора — ложное разрешение (обход области записи).
test('detectShellWrites (C2 r3, HIGH): разделитель heredoc с кавычками по частям, here-string `<<<`, `<<` в `(( ))`', () => {
  assert.deepEqual(writes(`cat <<E"O"F\nhello\nEOF\ntouch ${O}/h1.txt\nE"O"F`), [`${O}/h1.txt`]);
  assert.deepEqual(writes(`cat <<E\\OF\nhello\nEOF\ntouch ${O}/h2.txt\nE\\OF`), [`${O}/h2.txt`]);
  assert.deepEqual(writes(`cat <<< EOF\ntouch ${O}/h3.txt\nEOF`), [`${O}/h3.txt`]);
  assert.deepEqual(writes(`cat <<< $(touch ${O}/h4.txt)`), [`${O}/h4.txt`]);
  assert.deepEqual(writes(`cat <<< hi > ${O}/h5.txt`), [`${O}/h5.txt`]);
  // `(( … ))` — арифметика, `<<` в ней сдвиг: разбор с bash расходится, значит '?'
  assert.deepEqual(writes(`(( x = 1 << 2 ))\ntouch ${O}/h6.txt\n2`), ['?']);
  assert.deepEqual(writes(`for (( i=0; i < 1<<1; i++ )); do :; done\ntouch ${O}/h7.txt\n1`), ['?']);
  // контроль: обычные heredoc и here-string в области — не ложный отказ
  assert.deepEqual(writes(`cat <<'EOF' > note.md\ntouch ${O}/no.txt\nEOF`), [at(SCOPE, 'note.md')]);
  assert.deepEqual(writes('cat <<< hi'), []);
  assert.deepEqual(writes('grep x <<< "$var"'), []);
});

// coproc/function/trap: bash выполняет команду, а разбор её не видел (проверено запуском —
// файл создаётся во всех трёх формах).
test('detectShellWrites (C2 r3, MEDIUM): coproc, function и trap — запись в теле видна, cd в теле делает каталог неизвестным', () => {
  assert.deepEqual(writes(`coproc touch ${O}/c1.txt`), [`${O}/c1.txt`]);
  assert.deepEqual(writes(`coproc CO { touch ${O}/c2.txt; }`), [`${O}/c2.txt`]);
  assert.deepEqual(writes(`coproc CO ( touch ${O}/c3.txt )`), [`${O}/c3.txt`]);
  assert.deepEqual(writes(`coproc mkdir ${O}/c4`), [`${O}/c4`]);
  assert.deepEqual(writes(`coproc $x touch ${O}/c5.txt`), ['?'], 'имя корутины не литерал');
  assert.deepEqual(writes(`function f { touch ${O}/f1.txt; }; f`), [`${O}/f1.txt`]);
  assert.deepEqual(writes(`function my-fn { rm -rf ${O}/f2; }; my-fn`), [`${O}/f2`]);
  assert.deepEqual(writes(`function f() { touch ${O}/f3.txt; }; f`), [`${O}/f3.txt`]);
  assert.deepEqual(writes(`function f { cd ${O}; }; f; touch f4.txt`), ['?'], 'cd в теле функции — каталог неизвестен');
  assert.deepEqual(writes(`trap 'touch ${O}/t1.txt' EXIT`), [`${O}/t1.txt`]);
  assert.deepEqual(writes(`trap "touch ${O}/t2.txt" EXIT`), [`${O}/t2.txt`]);
  assert.deepEqual(writes(`trap 'cd ${O}' DEBUG; touch t3.txt`), ['?']);
  assert.deepEqual(writes('trap "$CMD" EXIT'), ['?'], 'текст ловушки не литерал');
  assert.deepEqual(writes("trap 'touch t4.txt' EXIT"), ['?'], 'ловушка срабатывает позже — каталог неизвестен');
  // того же вида обёртки (в Git Bash этой машины утилит нет — правило из их формы)
  assert.deepEqual(writes(`setsid touch ${O}/g1.txt`), [`${O}/g1.txt`]);
  assert.deepEqual(writes(`flock -n /tmp/l touch ${O}/g2.txt`), [`${O}/g2.txt`]);
  assert.deepEqual(writes(`flock -w 5 /tmp/l rm -rf ${O}/g3`), [`${O}/g3`]);
  // контроль: формы без записи не дают ни путей, ни маркера
  assert.deepEqual(writes('function f { echo hi; }; f'), []);
  assert.deepEqual(writes('trap - EXIT'), []);
  assert.deepEqual(writes('trap -p'), []);
  assert.deepEqual(writes('coproc cat'), []);
});

test('detectShellWrites (C2 r3): поведение bash, на которое опираются правила pushd/coproc/function/trap', () => {
  if (process.platform !== 'win32') return;
  const base = mkdtempSync(join(tmpdir(), 'rails-c2r3-'));
  const sh = (script) => {
    try {
      execFileSync('bash', ['-c', script], { cwd: base, stdio: 'ignore' });
    } catch {
      /* ненулевой код (`EOF: command not found`, coproc) не важен — важны созданные файлы */
    }
  };
  try {
    mkdirSync(join(base, 'w'));
    sh('pushd w >/dev/null && pushd +1 >/dev/null && touch stack.txt');
    assert.equal(existsSync(join(base, 'stack.txt')), true, 'pushd +1 вернул в исходный каталог');
    assert.equal(existsSync(join(base, 'w', 'stack.txt')), false, 'а не в w/+1');
    sh('coproc touch co.txt\nsleep 1');
    sh('function fn { touch fn.txt; }; fn');
    sh("trap 'touch tr.txt' EXIT");
    for (const f of ['co.txt', 'fn.txt', 'tr.txt']) assert.equal(existsSync(join(base, f)), true, `bash выполнил запись: ${f}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// --- раунд 4 (ревью раунда 3 C2, 2026-09-22) --------------------------------------------

// HIGH: `a=(<<E)` для bash — синтаксическая ошибка: heredoc в очередь НЕ ставится, bash
// ресинхронизируется на переводе строки и ВЫПОЛНЯЕТ следующие строки (проверено запуском).
// Сканер уводил их в тело heredoc, запись оттуда пропадала — регресс deny→allow против HEAD.
test('detectShellWrites (C2 r4, HIGH): heredoc в списке присваивания массива `a=( … )` — строки после него bash выполняет: "?"', () => {
  const tail = `\ntouch ${O}/arr.txt\nE`;
  for (const head of ['a=(<<E)', 'a+=(<<E)', 'a=(1<<E)', 'a=(x y <<E)', 'a=([0]=<<E)', 'a[0]=(<<E)', 'declare -a a=(<<E)', 'local a=(<<E)', 'export a=(<<E)', 'readonly a=(<<E)', 'typeset a=(<<E)', "arr=(x <<'E')", 'a=(<<-E)', 'time a=(<<E)', 'coproc a=(<<E)', '( a=(<<E) )', '{ a=(<<E); }', 'f() { a=(<<E); }', 'a=(<<E)&', 'a=(<<E) || true', 'if true; then a=(<<E); fi', 'while false; do a=(<<E); done']) {
    assert.deepEqual(writes(head + tail), ['?'], head);
  }
  // контроль: heredoc в подоболочке и обычное присваивание массива разбираются как раньше
  assert.deepEqual(writes(`( cat <<E > note.md\nbody\nE\n)`), [at(SCOPE, 'note.md')]);
  assert.deepEqual(writes(`a=(x y); touch ${O}/plain.txt`), [`${O}/plain.txt`]);
  assert.deepEqual(writes(`a=$(cat <<E\nbody\nE\n); touch ${O}/sub.txt`), [`${O}/sub.txt`]);
});

// HIGH: время разбора задаёт текст агента. ASSIGNISH_RE/ARRAY_REF_RE без границы имени давали
// O(n^2) на одном длинном слове (24 000 букв — 4 с, 96 000 — 64 с), хук висел на каждом вызове
// инструмента, а убитый по таймауту хук = allow. Порог с большим запасом: после правки — 30 мс.
test('detectShellWrites (C2 r4, HIGH): длинное слово разбирается линейно, а не за O(n^2)', () => {
  for (const word of ['a'.repeat(96000), 'a1'.repeat(48000), `_${'x'.repeat(95999)}`]) {
    const command = `echo hi > ${O}/perf.txt; : ${word}`;
    const started = Date.now();
    assert.deepEqual(writes(command), [`${O}/perf.txt`]);
    const spent = Date.now() - started;
    assert.ok(spent < 2000, `разбор слова из ${word.length} символов занял ${spent} мс`);
  }
  // граница имени сохранена: присваивание внутри слова по-прежнему делает значение неизвестным
  assert.deepEqual(writes('S=out; (( S = 1 )); touch "$S/f.txt"'), ['?']);
  assert.deepEqual(writes('S=out; S[0]=x; touch "$S/f.txt"'), ['?']);
  assert.deepEqual(writes('S=out; S++; touch "$S/f.txt"'), ['?']);
  assert.deepEqual(writes('S=out; a[S=1]=y; touch "$S/f.txt"'), ['?']);
  assert.deepEqual(writes('S=out; echo $((S++)); touch "$S/f.txt"'), ['?']);
  // литеральное значение известно и после правки — не ложный отказ
  assert.deepEqual(writes('S=out; touch "$S/f.txt"'), [at(SCOPE, 'out', 'f.txt')]);
});

test('bash (C2 r4): `a=(<<E)` — синтаксическая ошибка, heredoc не ставится, следующие строки выполняются', () => {
  if (process.platform !== 'win32') return;
  const base = mkdtempSync(join(tmpdir(), 'rails-c2r4-'));
  try {
    for (const [script, file] of [['a=(<<E)\ntouch arr1.txt\nE', 'arr1.txt'], ['arr=(1<<2)\ntouch arr2.txt\n2', 'arr2.txt']]) {
      try {
        execFileSync('bash', ['-c', script], { cwd: base, stdio: 'ignore' });
      } catch {
        /* syntax error — ненулевой код; важно, что следующая строка выполнена */
      }
      assert.equal(existsSync(join(base, file)), true, `bash выполнил строку после ошибочного heredoc: ${file}`);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// --- раунд 5: LOW-замечания ревью раунда 3 C2 (2026-09-22) -------------------------------

// LOW-1: cdForm требовал redirects.length === 0, и частая идиома `cd … >/dev/null` лишала
// трекера каталога (регресс allow→deny против HEAD). Проверено запуском bash 5.2 msys:
// `cd sub >/dev/null`, `pushd sub >/dev/null`, `cd sub 2>/dev/null` в каталог ПЕРЕХОДЯТ
// (pwd = …/sub); PowerShell 5.1 — `Set-Location sub > $null` тоже. Редирект в файл переход
// тоже не отменяет, но правило остаётся консервативным: неизвестность — только ложный отказ.
test('detectShellWrites (C2 r5, LOW-1): редирект в псевдоустройство рядом с cd/pushd не делает каталог неизвестным', () => {
  assert.deepEqual(writes('pushd sub >/dev/null && touch f.txt'), [at(SCOPE, 'sub', 'f.txt')]);
  assert.deepEqual(writes('pushd sub > /dev/null && touch f.txt && popd > /dev/null'), [at(SCOPE, 'sub', 'f.txt')]);
  assert.deepEqual(writes('cd sub 2>/dev/null && touch f.txt'), [at(SCOPE, 'sub', 'f.txt')]);
  assert.deepEqual(writes('cd sub 1>/dev/null 2>/dev/null && touch f.txt'), [at(SCOPE, 'sub', 'f.txt')]);
  assert.deepEqual(writes('cd -- sub >/dev/null && touch f.txt'), [at(SCOPE, 'sub', 'f.txt')]);
  // PowerShell 5.1: `&&` нет, `;` — запись и в прежнем каталоге (cd мог не удаться)
  assert.deepEqual(psWrites('Set-Location sub > $null; Set-Content a.txt 1'), [at(SCOPE, 'sub', 'a.txt'), at(SCOPE, 'a.txt')]);
  assert.deepEqual(psWrites('Push-Location -Path sub 2> $null; Set-Content a.txt 1'), [at(SCOPE, 'sub', 'a.txt'), at(SCOPE, 'a.txt')]);
  // Ревью раунда 5 (LOW, проверено запуском PS 5.1): `> NUL` — устройство, Out-File падает на
  // его открытии ДО выполнения команды, и `Set-Location sub > NUL` каталог не меняет.
  assert.deepEqual(psWrites('Set-Location sub > NUL; Set-Content a.txt 1'), ['?']);
  // любой другой редирект — каталог по-прежнему неизвестен (консервативно), а редирект — запись
  assert.deepEqual(writes(`cd sub > ${O}/out.log && touch f.txt`), [`${O}/out.log`, '?']);
  assert.deepEqual(writes('cd sub 2>err.log && touch f.txt'), [at(SCOPE, 'err.log'), '?']);
  // «псевдоустройство» — только литерал: подстановка в цели редиректа даёт неизвестность
  assert.deepEqual(writes('cd sub >$DEV && touch f.txt'), ['?']);
});

// LOW-2: ведущая `~` раскрывалась через os.homedir(), а `$HOME` — из env: два источника для
// одного значения. Проверено запуском bash 5.2: `~` следует $HOME (в том числе заданному в
// окружении вызова и переназначенному внутри команды), при unset HOME `~` берётся из passwd —
// детектор этого не знает, поэтому неизвестный HOME → '?'.
test('detectShellWrites (C2 r5, LOW-2): `~` и `$HOME` — один источник (env HOME); HOME неизвестен → "?"', () => {
  const home = fwd(join(BASE, 'home'));
  assert.deepEqual(writes('touch ~/a.txt', { env: { HOME: home } }), [`${home}/a.txt`]);
  assert.deepEqual(writes('touch $HOME/a.txt', { env: { HOME: home } }), [`${home}/a.txt`]);
  assert.deepEqual(writes('cd ~/proj && touch a.txt', { env: { HOME: home } }), [at(home, 'proj', 'a.txt')]);
  // Ревью C2 r5 (MEDIUM): без HOME `~` НЕ неизвестность — bash берёт каталог пользователя
  // (см. тест «поведение bash …»), а '?' в core.mjs — безусловный deny на каждую команду с `~`
  assert.deepEqual(writes('touch ~/a.txt'), [`${homedir()}/a.txt`], 'HOME нет — каталог пользователя');
  assert.deepEqual(writes('touch $HOME/a.txt'), ['?'], '$HOME без HOME у bash пуст — неизвестность');
  assert.deepEqual(writes(`HOME=${home} touch ~/a.txt`), ['?'], 'HOME переназначен в команде');
  assert.deepEqual(writes(`HOME=${home}; touch $HOME/a.txt`), ['?']);
});

// LOW-3: обёртки со строкой-скриптом. `flock файл -c '<скрипт>'` выполняет строку через
// шелл — флаг -c съедался общим разбором флагов, значение попадало в позицию имени команды
// (commandName давал 'x'), запись пропадала. У setsid `-c`/`--ctty` значения не имеет
// (переключатель) — он съедал имя обёрнутой команды. Обеих утилит в Git Bash на этой машине
// нет (`command -v` пусто) — форма взята из документации util-linux, правило только расширяет
// детект записи, ложного разрешения из него не возникает.
test('detectShellWrites (C2 r5, LOW-3): flock -c <строка-скрипт>, setsid -c — переключатель', () => {
  assert.deepEqual(writes(`flock /tmp/l -c 'touch ${O}/x.txt'`), [`${O}/x.txt`]);
  assert.deepEqual(writes(`flock /tmp/l -c "touch ${O}/x.txt"`), [`${O}/x.txt`]);
  assert.deepEqual(writes(`flock -w 5 /tmp/l --command 'touch ${O}/x.txt'`), [`${O}/x.txt`]);
  assert.deepEqual(writes(`flock /tmp/l --command='touch ${O}/x.txt'`), [`${O}/x.txt`]);
  assert.deepEqual(writes(`flock -e /tmp/l -c'touch ${O}/x.txt'`), [`${O}/x.txt`]);
  // Ревью раунда 5 (LOW): короткие флаги склеиваются, `-c` в группе не первый — раньше строка
  // уходила в позиционный аргумент, именем команды становился файл блокировки, список выходил
  // пустым (ложное разрешение того же класса).
  assert.deepEqual(writes(`flock -xc 'touch ${O}/x.txt' /tmp/l`), [`${O}/x.txt`]);
  assert.deepEqual(writes(`flock -nc 'rm -rf ${O}/x' /tmp/l`), [`${O}/x`]);
  assert.deepEqual(writes(`flock -nc'touch ${O}/x.txt' /tmp/l`), [`${O}/x.txt`]);
  assert.deepEqual(writes('flock -xc "$CMD" /tmp/l'), ['?'], 'строка-скрипт в группе не литерал — маркер');
  assert.deepEqual(writes('flock /tmp/l -c "$CMD"'), ['?'], 'строка-скрипт не литерал — маркер');
  assert.deepEqual(writes(`setsid -c touch ${O}/y.txt`), [`${O}/y.txt`]);
  assert.deepEqual(writes(`setsid -w -f touch ${O}/y.txt`), [`${O}/y.txt`]);
  // контроль: позиционная форма обёрток по-прежнему разбирается
  assert.deepEqual(writes(`flock /tmp/l touch ${O}/z.txt`), [`${O}/z.txt`]);
  assert.deepEqual(writes(`setsid touch ${O}/z.txt`), [`${O}/z.txt`]);
});

// LOW-4: `(( … ))` и `$(( … ))` разбирались как команда с редиректом — фантомная цель записи
// (`if (( n > 0 ))` → <cwd>/0). Отличить арифметику от вложенных подоболочек `((cmd) && cmd)`
// можно СИНТАКСИЧЕСКИ, это правило самого bash (проверено запуском bash 5.2 msys, см. тест
// «поведение bash …» ниже): `((` — арифметика, только если пара, открытая ВТОРОЙ скобкой,
// закрывается непосредственно перед `)`; `$((` — если содержимое `$( … )` начинается с `(`,
// кончается `)` и скобки между ними сбалансированы (правило chk_arithsub из bash).
test('detectShellWrites (C2 r5, LOW-4): арифметика (( )) / $(( )) — не команда с редиректом', () => {
  assert.deepEqual(writes('n=$(ls | wc -l); if (( n > 0 )); then echo many; fi'), []);
  assert.deepEqual(writes('echo $(( 5 > 3 ))'), []);
  assert.deepEqual(writes('(( i = 1 )); (( i > 0 )) && echo yes'), []);
  assert.deepEqual(writes('echo $(( (a+b) > c ))'), []);
  assert.deepEqual(writes('while (( i > 0 )); do echo x; done'), []);
  // вложенные подоболочки bash ВЫПОЛНЯЕТ — запись должна остаться видимой
  assert.deepEqual(writes(`((echo x) > ${O}/b.txt)`), [`${O}/b.txt`]);
  assert.deepEqual(writes(`(((a)) > ${O}/b.txt)`), [`${O}/b.txt`]);
  assert.deepEqual(writes(`echo $((ls) > ${O}/c.txt)`), [`${O}/c.txt`]);
  assert.deepEqual(writes(`((cd sub) && (touch ${O}/y.txt))`), [`${O}/y.txt`]);
  assert.deepEqual(writes(`echo $((cd sub) && (touch ${O}/y.txt))`), [`${O}/y.txt`]);
  // подстановка внутри арифметики выполняется
  assert.deepEqual(writes(`(( x = $(touch ${O}/t8.txt; echo 1) ))`), [`${O}/t8.txt`]);
  // пре-существующий ложный отказ (был и до раунда 5): первое слово арифметики — подстановка,
  // разбор считает его нелитеральным ИМЕНЕМ команды и добавляет '?'. Правка раунда 5 снимала
  // только фантомный редирект, командную позицию внутри `(( ))` не трогала.
  assert.deepEqual(writes(`echo $(( $(touch ${O}/t.txt; echo 1) + 1 ))`), [`${O}/t.txt`, '?']);
  // редирект ПОСЛЕ `))` — настоящий
  assert.deepEqual(writes(`(( n > 0 )) 2>${O}/err.txt`), [`${O}/err.txt`]);
  // heredoc внутри `(( ))` по-прежнему не разбирается (ревью r3, HIGH) — '?'
  assert.deepEqual(writes(`(( x = 1 << 2 ))\ntouch ${O}/h.txt`), ['?']);
});

// Ложное РАЗРЕШЕНИЕ того же класса, найденное по дороге (было и в HEAD): POSIX-ветка
// isNullTarget считала `NUL` псевдоустройством. В Git Bash (msys) `NUL` — ОБЫЧНЫЙ файл:
// `echo HELLOWORLD > NUL` создаёт файл NUL с содержимым (проверено запуском, см. тест
// поведения ниже). В PowerShell 5.1 `> NUL` — устройство: Out-File падает, файла нет.
test('detectShellWrites (C2 r5, ложное разрешение): `> NUL` в POSIX — обычный файл, не псевдоустройство', () => {
  assert.deepEqual(writes('echo x > NUL'), [at(SCOPE, 'NUL')]);
  assert.deepEqual(writes('cmd 2>/dev/null >NUL'), [at(SCOPE, 'NUL')]);
  assert.deepEqual(writes(`echo x > ${O}/NUL`), [`${O}/NUL`]);
  assert.deepEqual(writes('echo x > /dev/null'), [], '/dev/null — настоящее устройство msys');
  assert.deepEqual(psWrites('Write-Output x > NUL'), [], 'PowerShell 5.1: NUL — устройство, файла нет');
  assert.deepEqual(psWrites('Write-Output x > $null'), []);
});

// --- ревью раунда 5 (2026-09-22) -----------------------------------------------------------

// HIGH, ложное РАЗРЕШЕНИЕ (регресс раунда 5 против HEAD 3f0eb5a). Признак арифметики хранился
// стеком, а `#` внутри `(( … ))` перематывал разбор до конца строки и съедал закрывающие `))`:
// стек не выталкивался, ВСЕ следующие сегменты получали arith:true, и commandIO молча
// выбрасывал их редиректы — запись за пределами write_scope становилась не видна, decide давал
// allow. Расхождение с bash проверено запуском (см. тест «поведение bash (ревью C2 r5) …»):
// для bash `#` внутри `((` комментарием НЕ является, это часть арифметического выражения,
// ошибка разбирается в рантайме, а следующая команда ВЫПОЛНЯЕТСЯ.
test('detectShellWrites (ревью C2 r5, HIGH): `#` внутри `(( … ))` не уносит редиректы следующих команд', () => {
  const NL = String.fromCharCode(10);
  for (const prefix of ['(( a # ))', '((#))', '(( a #))', '((##))', '(( #))', '((;#))', '((#;))', '((#}))', '((# a ))', '(( # a ))', '((#1))']) {
    assert.deepEqual(writes(`${prefix}${NL}echo PWNED > ${O}/e.txt`), [`${O}/e.txt`], prefix);
  }
  // `<<` внутри `(( ))` — разбор отказывает (запрет heredoc из раунда 3): это '?', то есть
  // deny, а не обход; раньше тот же префикс давал пустой список, то есть allow
  assert.deepEqual(writes(`((#<<E))${NL}echo PWNED > ${O}/e.txt`), ['?']);
  // та же строка: после `(( … # … ))` идёт `;` — bash выполняет вторую команду
  assert.deepEqual(writes(`(( a # )); echo PWNED > ${O}/e.txt`), [`${O}/e.txt`]);
  assert.deepEqual(writes(`((# a )) | cat; echo PWNED > ${O}/e.txt`), [`${O}/e.txt`]);
  // несколько записей подряд и разные формы редиректа
  assert.deepEqual(
    writes(`(( a # ))${NL}echo one > ${O}/a.txt${NL}date >> ${O}/b.txt${NL}ls &> ${O}/c.txt${NL}cat 2> ${O}/d.txt`),
    [`${O}/a.txt`, `${O}/b.txt`, `${O}/c.txt`, `${O}/d.txt`],
  );
  // смена каталога после скобок — '?' и с `#`, и без него (пре-существующий ложный отказ:
  // сегмент за `)` теряет отслеживаемый каталог), важно лишь что это deny, а не пустой список
  assert.deepEqual(writes(`(( a # ))${NL}cd ${O} && echo PWNED > d.txt`), ['?']);
  assert.deepEqual(writes(`(( a ))${NL}cd ${O} && echo PWNED > d.txt`), ['?'], 'то же без `#`');
  // контроль: `#` ВНЕ скобок — по-прежнему комментарий (иначе правка была бы ложным отказом)
  assert.deepEqual(writes(`# echo PWNED > ${O}/no.txt`), []);
  assert.deepEqual(writes(`echo ok # > ${O}/no.txt`), []);
  assert.deepEqual(writes(`(( 1 )) # > ${O}/no.txt`), [], 'после `))` скобка закрыта — комментарий');
  assert.deepEqual(writes(`(( 1 )) # c${NL}echo x > ${O}/y.txt`), [`${O}/y.txt`]);
  // контроль LOW-4: настоящая арифметика фантомных целей по-прежнему не даёт
  assert.deepEqual(writes('n=$(ls | wc -l); if (( n > 0 )); then echo many; fi'), []);
  assert.deepEqual(writes('echo $(( 5 > 3 ))'), []);
});

// MEDIUM: раунд 5 свёл `~` и `$HOME` к одному источнику (env.HOME) и тем сломал рабочий случай
// хука — его процесс HOME не видит (node, порождённый из powershell.exe: process.env.HOME ===
// undefined, проверено в тесте поведения ниже), а detectShellWrites в core.mjs вызывается без
// env, то есть на process.env. ЛЮБОЙ путь с `~` давал '?', а '?' — безусловный deny. Разница
// `~` и `$HOME` при отсутствующем HOME — правило самого bash, а не второй источник: `~` берёт
// каталог пользователя, `$HOME` пуст.
test('detectShellWrites (ревью C2 r5, MEDIUM): `~` без HOME — каталог пользователя, а не "?"', () => {
  const home = homedir();
  assert.deepEqual(writes('echo x > ~/f.txt'), [`${home}/f.txt`]);
  assert.deepEqual(writes('mkdir -p ~/.workflow && echo x > ~/.workflow/log.txt'), [`${home}/.workflow`, `${home}/.workflow/log.txt`]);
  assert.deepEqual(writes('cd ~/proj && touch a.txt'), [at(homedir(), 'proj', 'a.txt')]);
  // env.HOME по-прежнему главнее запасного источника, и он же — источник для `$HOME`
  const alt = fwd(join(BASE, 'home'));
  assert.deepEqual(writes('touch ~/a.txt', { env: { HOME: alt } }), [`${alt}/a.txt`]);
  assert.deepEqual(writes('touch $HOME/a.txt', { env: { HOME: alt } }), [`${alt}/a.txt`]);
  // `$HOME` без HOME у bash пуст — запасного источника не получает
  assert.deepEqual(writes('touch $HOME/a.txt'), ['?']);
  // переназначение HOME в самой команде — по-прежнему неизвестность
  assert.deepEqual(writes(`HOME=${alt} touch ~/a.txt`), ['?']);
  assert.deepEqual(writes(`HOME=${alt}; touch ~/a.txt`), ['?']);
});

test('поведение bash (ревью C2 r5): `#` внутри `(( ))` не комментарий; `~` без HOME — каталог пользователя', () => {
  if (process.platform !== 'win32') return;
  const NL = String.fromCharCode(10);
  // диалект posix моделирует Git Bash (msys); если PATH ведёт к другому bash (например к
  // WSL `C:/WINDOWS/system32/bash.exe`, у которого свой /home/<user>), пробу не проводим
  if (execFileSync('bash', ['-c', 'echo $OSTYPE'], { encoding: 'utf8' }).trim() !== 'msys') return;
  const base = mkdtempSync(join(tmpdir(), 'rails-c2r5rev-'));
  const sh = (script, env) => {
    try {
      execFileSync('bash', ['-c', script], { cwd: base, stdio: 'ignore', env: env ?? process.env });
    } catch {
      /* арифметическая ошибка даёт ненулевой код — важно, что делает следующая команда */
    }
  };
  try {
    // HIGH: `(( … # … ))` — ОДНА арифметическая команда, следующая ВЫПОЛНЯЕТСЯ
    for (const [script, file] of [
      [`(( a # ))${NL}echo PWNED > hash1.txt`, 'hash1.txt'],
      ['(( a # )); echo PWNED > hash2.txt', 'hash2.txt'],
      [`((#))${NL}echo PWNED > hash3.txt`, 'hash3.txt'],
      [`(( a # ))${NL}cd . && echo PWNED > hash4.txt`, 'hash4.txt'],
      ['((# a )) | cat; echo PWNED > hash5.txt', 'hash5.txt'],
    ]) {
      sh(script);
      assert.equal(existsSync(join(base, file)), true, `bash выполнил команду после (( … # … )): ${script}`);
    }
    // а `#` ВНЕ скобок — комментарий: файла нет
    sh('# echo PWNED > nohash1.txt');
    sh('echo ok # > nohash2.txt');
    assert.equal(existsSync(join(base, 'nohash1.txt')), false);
    assert.equal(existsSync(join(base, 'nohash2.txt')), false);
    // MEDIUM: без HOME `~` не отказывает — это каталог пользователя, os.homedir() даёт его же
    const noHome = { ...process.env };
    delete noHome.HOME;
    const probe = join(homedir(), 'rails-c2r5-tilde-probe.txt');
    rmSync(probe, { force: true });
    sh('touch ~/rails-c2r5-tilde-probe.txt', noHome);
    assert.equal(existsSync(probe), true, '`~` при unset HOME = os.homedir()');
    rmSync(probe, { force: true });
    // и `$HOME`, и `~` у того же bash дают ровно os.homedir(): msys синтезирует HOME при
    // старте, если его нет в окружении (проверено запуском — поэтому «$HOME пуст без HOME»
    // утверждать нельзя; пустым он остаётся только под `env -u HOME` из msys-родителя)
    const seen = execFileSync('bash', ['-c', 'echo "[$HOME][$(echo ~)]"'], { cwd: base, env: noHome, encoding: 'utf8' }).trim();
    const posixHomedir = execFileSync('bash', ['-c', 'cd ~ && pwd'], { cwd: base, encoding: 'utf8' }).trim();
    assert.equal(seen, `[${posixHomedir}][${posixHomedir}]`, 'bash без HOME в окружении: $HOME и ~ — каталог пользователя');
    // node без HOME в окружении (так запускается процесс хука: `node claude-hook.mjs` из
    // окружения Claude Code, где HOME нет — проверено запуском вручную, в тесте это не
    // воспроизводится: powershell.exe наследует HOME теста) всё равно знает каталог
    // пользователя, и это ровно тот, куда пишет `~` у bash выше
    const nodeHome = execFileSync(
      process.execPath,
      ['-e', 'process.stdout.write(process.env.HOME + "|" + require("os").homedir())'],
      { env: noHome, encoding: 'utf8' },
    ).trim();
    assert.equal(nodeHome, `undefined|${homedir()}`, 'node без HOME: os.homedir() остаётся');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('detectShellWrites (C2 r5): поведение bash, на которое опираются правила раунда 5', () => {
  if (process.platform !== 'win32') return;
  const base = mkdtempSync(join(tmpdir(), 'rails-c2r5-'));
  const sh = (script) => {
    try {
      execFileSync('bash', ['-c', script], { cwd: base, stdio: 'ignore' });
    } catch {
      /* ненулевой код не важен — важны созданные файлы и каталог перехода */
    }
  };
  try {
    mkdirSync(join(base, 'sub'));
    // LOW-1: редирект рядом с cd/pushd переход не отменяет
    sh('cd sub >/dev/null && touch cd1.txt');
    sh('pushd sub >/dev/null && touch cd2.txt && popd >/dev/null');
    sh('cd sub 2>/dev/null && touch cd3.txt');
    for (const f of ['cd1.txt', 'cd2.txt', 'cd3.txt']) {
      assert.equal(existsSync(join(base, 'sub', f)), true, `cd с редиректом перешёл в sub: ${f}`);
    }
    // ложное разрешение: NUL в Git Bash — обычный файл
    sh('echo HELLOWORLD > NUL');
    assert.equal(existsSync(join(base, 'NUL')), true, 'Git Bash: `> NUL` создаёт обычный файл');
    // LOW-4: правило bash для `((` — арифметика только при `))`, иначе вложенные подоболочки
    sh('((echo x) > par1.txt)');
    sh('(((a)) > par2.txt)');
    sh('echo $((ls) > par3.txt)');
    sh('((cd sub) && (touch par4.txt))');
    sh('echo $((cd sub) && (touch par5.txt))');
    sh('(( n > 0 )) 2>par6.txt');
    for (const f of ['par1.txt', 'par2.txt', 'par3.txt', 'par4.txt', 'par5.txt', 'par6.txt']) {
      assert.equal(existsSync(join(base, f)), true, `bash выполнил подоболочку/редирект: ${f}`);
    }
    // а настоящая арифметика команд не выполняет и файлов не создаёт
    sh('((touch arith1.txt))');
    sh('echo $((touch arith2.txt))');
    sh('n=1; (( n > 0 )); echo $(( 5 > 3 ))');
    for (const f of ['arith1.txt', 'arith2.txt', '0', '3', 'n']) {
      assert.equal(existsSync(join(base, f)), false, `арифметика не создала файл: ${f}`);
    }
    // подстановка внутри арифметики выполняется
    sh('(( x = $(touch arith3.txt; echo 1) ))');
    sh('echo $(( $(touch arith4.txt; echo 1) + 1 ))');
    for (const f of ['arith3.txt', 'arith4.txt']) {
      assert.equal(existsSync(join(base, f)), true, `подстановка внутри арифметики выполнена: ${f}`);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
