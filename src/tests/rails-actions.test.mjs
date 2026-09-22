import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { fromClaude, fromKilo, detectShellWrites } from '../rails/actions.mjs';

// --- fromClaude (таблица §6) ------------------------------------------------

test('fromClaude: Bash -> shell с command', () => {
  const a = fromClaude({ tool_name: 'Bash', tool_input: { command: 'ls -la' } });
  assert.deepEqual(a, { tool: 'Bash', kind: 'shell', command: 'ls -la' });
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

test('fromKilo: bash -> shell', () => {
  const a = fromKilo({ tool: 'bash' }, { args: { command: 'echo hi' } });
  assert.deepEqual(a, { tool: 'bash', kind: 'shell', command: 'echo hi' });
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

test('detectShellWrites: mv/cp — путь записи только последний аргумент (назначение), не источник', () => {
  assert.deepEqual(detectShellWrites('mv a.txt b.txt'), ['b.txt']);
  assert.deepEqual(detectShellWrites('cp a.txt b.txt c.txt dest.txt'), ['dest.txt']);
});

test('detectShellWrites: cp с источником вне scope не ловит источник как запись (regression)', () => {
  // Раньше `cp /etc/x <scope>/y` давал ложный отказ «запись вне области»
  // из-за источника /etc/x — писать нужно только в <scope>/y.
  assert.deepEqual(detectShellWrites('cp /etc/x /scope/y'), ['/scope/y']);
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

test('detectShellWrites: редирект в псевдоустройство (/dev/null, NUL) — не запись и не маркер "?"', () => {
  assert.deepEqual(detectShellWrites('node cli.mjs report --skill coach 2>/dev/null | head -14'), []);
  assert.deepEqual(detectShellWrites('dir > NUL'), []);
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
  const r = detectShellWrites('touch /scope/a; rm -rf');
  assert.ok(r.includes('/scope/a'));
  assert.ok(r.includes('?'));
});
