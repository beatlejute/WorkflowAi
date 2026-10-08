import { test, mock } from 'node:test';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleHookInput } from '../rails/claude-hook.mjs';
import assert from 'node:assert/strict';
import { classifyLaunch, sameLaunch, splitWindowsCommand, processSnapshot, launchOrigin, bindHostSession } from '../rails/launch-origin.mjs';
import { loadSkillRuntime } from '../rails/core.mjs';
import { check } from '../rails/output-check.mjs';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';

test('coach and create-plan accept their real handoff nodes without success requirements', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const answer = 'RAILS_OUTCOME: out_of_scope\nREQUEST: original task\nREASON: outside competence\nDONE: scope checked\nREMAINING: task';
  for (const skill of ['coach', 'create-plan']) {
    const { config, graph } = loadSkillRuntime(root, skill);
    assert.deepEqual(config.handoff.nodes, ['P0H1']);
    assert.deepEqual(graph.validate(config).errors, []);
    assert.equal(check(answer, config, { node: 'P0H1' }).outcome, 'out_of_scope');
  }
});

const session = '11111111-1111-1111-1111-111111111111';
const executable = 'C:\\Users\\owner\\.vscode-oss\\extensions\\anthropic.claude-code\\native-binary\\claude.exe';
const ide = { pid: 20, ppid: 30, birth: '2026-10-08T10:00:00Z', executable,
  argv: [executable, '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json',
    '--permission-prompt-tool', 'stdio', `--resume=${session}`, '--replay-user-messages'] };
const caller = { pid: 10, ppid: 20, executable: '/usr/bin/node', argv: ['node', 'cli.mjs'], birth: 'caller' };
const classify = (host = ide, registered) => classifyLaunch([caller, host,
  { pid: 30, ppid: 0, executable: '/usr/bin/node', birth: 'runner', argv: ['node', 'runner.mjs'] }], 10, session, registered);

test('Linux host session binds once and launchOrigin verifies the binding', { skip: process.platform !== 'linux' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rails-linux-host-binding-'));
  fs.mkdirSync(path.join(root, '.workflow'));
  const hook = fileURLToPath(new URL('../rails/claude-hook.mjs', import.meta.url));
  const session = 'linux-host-session';
  const hostPid = process.pid + 1;
  const runnerPid = process.pid + 2;
  const executable = '/home/owner/.vscode-oss/extensions/anthropic.claude-code/native-binary/claude.exe';
  const processes = new Map([
    [String(process.pid), { ppid: hostPid, executable: process.execPath,
      argv: [process.execPath, hook], start: '100' }],
    [String(hostPid), { ppid: runnerPid, executable, argv: [executable, '--output-format', 'stream-json',
      '--input-format', 'stream-json', '--permission-prompt-tool', 'stdio', `--resume=${session}`,
      '--replay-user-messages'], start: '200' }],
    [String(runnerPid), { ppid: 0, executable: '/usr/bin/node', argv: ['node', 'runner.mjs'], start: '300' }],
  ]);
  const originals = {
    readdirSync: fs.readdirSync,
    readFileSync: fs.readFileSync,
    readlinkSync: fs.readlinkSync,
  };
  const probes = [
    mock.method(fs, 'readdirSync', (dir, ...args) => String(dir) === '/proc'
      ? [...processes.keys()] : originals.readdirSync.call(fs, dir, ...args)),
    mock.method(fs, 'readFileSync', (file, ...args) => {
      const value = String(file);
      if (value === '/proc/sys/kernel/random/boot_id') return '12345678-1234-1234-1234-123456789abc\n';
      const match = /^\/proc\/(\d+)\/(stat|cmdline)$/.exec(value);
      if (!match) return originals.readFileSync.call(fs, file, ...args);
      const row = processes.get(match[1]);
      if (match[2] === 'cmdline') return row.argv.join('\0') + '\0';
      return `(${path.basename(row.executable)}) S ${row.ppid} ${Array(17).fill('0').join(' ')} ${row.start}`;
    }),
    mock.method(fs, 'readlinkSync', (file, ...args) => {
      const match = /^\/proc\/(\d+)\/exe$/.exec(String(file));
      return match ? processes.get(match[1]).executable : originals.readlinkSync.call(fs, file, ...args);
    }),
  ];
  syncBuiltinESMExports();
  try {
    assert.equal(bindHostSession(root, session), true);
    assert.equal(bindHostSession(root, session), true, 'replaying SessionStart accepts the same binding');
    const launch = launchOrigin(root, session);
    assert.equal(launch.origin, 'interactive');
    assert.equal(launch.callback, 'stop-hook');

    const bindingPath = path.join(root, '.workflow', 'state', 'rails', `.host-session-${session}.json`);
    const binding = JSON.parse(fs.readFileSync(bindingPath, 'utf8'));
    binding.host.argv_sha256 = 'tampered';
    fs.writeFileSync(bindingPath, JSON.stringify(binding));
    assert.equal(bindHostSession(root, session), false, 'a conflicting existing binding is immutable');
  } finally {
    for (const probe of probes) probe.mock.restore();
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('only the OS desktop shell anchors Windows ancestry; gaps before it refuse', { skip: process.platform !== 'win32' }, () => {
  const rows = [caller, ide, { pid: 30, ppid: 8772, executable: 'C:\\Windows\\explorer.exe',
    argv: ['C:\\Windows\\explorer.exe'], birth: 'desktop' }].map(p => ({
      ProcessId: p.pid, ParentProcessId: p.ppid, ExecutablePath: p.executable,
      Birth: p.birth, CommandLine: p.argv.map(a => `"${a}"`).join(' '), DesktopShell: p.pid === 30,
    }));
  const probe = mock.method(childProcess, 'execFileSync', () => JSON.stringify(rows));
  try {
    const snapshot = processSnapshot();
    assert.equal(snapshot.find(p => p.pid === 30).desktopShell, true);
    assert.equal(snapshot.find(p => p.pid === 30).ppid, 8772);
    assert.equal(classifyLaunch(snapshot, 10, session).origin, 'interactive');
    rows[2].DesktopShell = false;
    assert.equal(classifyLaunch(processSnapshot(), 10, session).origin, 'unknown');
    rows[2].DesktopShell = true;
    rows[1].ParentProcessId = 999;
    assert.equal(classifyLaunch(processSnapshot(), 10, session).origin, 'unknown');
  } finally { probe.mock.restore(); }
});

test('Windows snapshot skips malformed unrelated rows and fails closed on a missing ancestor', { skip: process.platform !== 'win32' }, () => {
  const rows = [caller, ide, { pid: 30, ppid: 0, executable: 'Code.exe', birth: 'editor', argv: ['Code.exe'] }]
    .map(p => ({ ProcessId: p.pid, ParentProcessId: p.ppid, ExecutablePath: p.executable,
      Birth: p.birth, CommandLine: p.argv.map(a => `"${a}"`).join(' ') }));
  rows.push({ ProcessId: 99, ParentProcessId: 0, CommandLine: '"unfinished' });
  const probe = mock.method(childProcess, 'execFileSync', () => JSON.stringify(rows));
  try {
    const snapshot = processSnapshot();
    assert.equal(snapshot.length, 3);
    assert.equal(classifyLaunch(snapshot, 10, session).origin, 'interactive');
    rows[1].CommandLine = '"unfinished';
    assert.equal(classifyLaunch(processSnapshot(), 10, session).origin, 'unknown');
    rows[1].CommandLine = ide.argv.map(a => `"${a}"`).join(' ');
    rows[0].ParentProcessId = 99;
    assert.equal(classifyLaunch(processSnapshot(), 10, session).origin, 'unknown');
    assert.throws(() => splitWindowsCommand('"unfinished'));
  } finally { probe.mock.restore(); }
});

test('first IDE SessionStart binds a flagless host, without upgrading legacy state', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rails-host-session-'));
  fs.mkdirSync(path.join(root, '.workflow'));
  const rows = [
    { ProcessId: process.pid, ParentProcessId: ide.pid, ExecutablePath: process.execPath, Birth: 'callback',
      CommandLine: `"${process.execPath}" "${fileURLToPath(new URL('../rails/claude-hook.mjs', import.meta.url))}"` },
    { ProcessId: ide.pid, ParentProcessId: 0, ExecutablePath: executable, Birth: ide.birth,
      CommandLine: ide.argv.filter(a => !a.startsWith('--resume=')).map(a => `"${a}"`).join(' ') },
  ];
  const probe = mock.method(childProcess, 'execFileSync', () => JSON.stringify(rows));
  try {
    assert.equal(launchOrigin(root, session).origin, 'unknown');
    handleHookInput({ hook_event_name: 'SessionStart', cwd: root, session_id: session }, {});
    assert.equal(launchOrigin(root, session).origin, 'interactive');
    rows[1].Birth = 'reused-pid';
    assert.equal(launchOrigin(root, session).origin, 'unknown');
    handleHookInput({ hook_event_name: 'SessionStart', cwd: root, session_id: session }, {});
    assert.equal(launchOrigin(root, session).origin, 'unknown');
    rows[1].Birth = ide.birth;
    const legacy = 'legacy-session';
    const dir = path.join(root, '.workflow', 'state', 'rails');
    const state = { version: 1, session: legacy, run: null, skill: 'example', node: 'P0E1',
      started: '2026-10-08T10:00:00Z', updated: '2026-10-08T10:00:00Z', history: [], counters: {}, denials: {}, flags: {} };
    fs.writeFileSync(path.join(dir, `${legacy}.json`), JSON.stringify(state));
    handleHookInput({ hook_event_name: 'SessionStart', cwd: root, session_id: legacy }, {});
    assert.equal(launchOrigin(root, legacy).origin, 'unknown');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, `${legacy}.json`), 'utf8')), state);
  } finally {
    probe.mock.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('incomplete IDE ancestry never becomes interactive or admits a host binding', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rails-incomplete-ancestry-'));
  const callback = { ...caller, pid: process.pid, ppid: ide.pid, executable: process.execPath,
    argv: [process.execPath, fileURLToPath(new URL('../rails/claude-hook.mjs', import.meta.url))] };
  const editor = { pid: 30, ppid: 0, executable: 'Code.exe', birth: 'editor', argv: ['Code.exe'] };
  const cases = [
    [callback, ide], // IDE keys are present, but its parent is missing.
    [callback, ide, { ...editor, ppid: ide.pid }], // cycle
    [callback, ide, ...Array.from({ length: 63 }, (_, i) => ({ ...editor,
      pid: 30 + i, ppid: i === 62 ? 0 : 31 + i }))], // root lies beyond the limit
  ];
  let current;
  const probe = mock.method(childProcess, 'execFileSync', () => JSON.stringify(current.map(p => ({
    ProcessId: p.pid, ParentProcessId: p.ppid, ExecutablePath: p.executable,
    Birth: p.birth, CommandLine: p.argv.map(a => `"${a}"`).join(' '),
  }))));
  try {
    assert.equal(classifyLaunch([callback, ide, editor], process.pid, session).origin, 'interactive');
    for (current of cases) {
      assert.equal(classifyLaunch(current, process.pid, session).origin, 'unknown');
      assert.equal(bindHostSession(root, session), false);
      assert.equal(fs.existsSync(path.join(root, '.workflow')), false);
      assert.equal(classifyLaunch(current.map(p => p.pid === ide.pid
        ? { ...p, argv: [...p.argv, '--print'] } : p), process.pid, session).origin, 'managed');
    }
  } finally {
    probe.mock.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Windows argv preserves quoted paths and equals-form session flags', () => {
  assert.deepEqual(splitWindowsCommand('"C:\\Program Files\\claude.exe" --resume=abc --permission-prompt-tool stdio'),
    ['C:\\Program Files\\claude.exe', '--resume=abc', '--permission-prompt-tool', 'stdio']);
  assert.throws(() => splitWindowsCommand('"unfinished'));
});

test('only known positive IDE launch is interactive, never stream-json alone', () => {
  assert.equal(classify().origin, 'interactive');
  assert.equal(classify({ ...ide, argv: [executable, '--output-format', 'stream-json'] }).origin, 'unknown');
  assert.equal(classify({ ...ide, executable: 'C:\\fake\\claude.exe' }).origin, 'unknown');
  assert.equal(classify({ ...ide, argv: [...ide.argv, '-p'] }).origin, 'managed');
  assert.equal(classify(ide, (p) => p.pid === 30 && p.birth === 'runner').origin, 'managed');
  assert.equal(classify({ ...ide, argv: ide.argv.map((a) => a.startsWith('--resume=') ? '--resume=foreign' : a) }).origin, 'unknown');
});

test('pinned host identity rejects pid reuse, session changes and argv spoofing', () => {
  const pinned = classify();
  assert.equal(sameLaunch(pinned, classify()), true);
  assert.equal(sameLaunch(pinned, classify({ ...ide, birth: 'reused-pid' })), false);
  assert.equal(sameLaunch(pinned, classify({ ...ide, argv: [...ide.argv, '--print'] })), false);
  assert.equal(sameLaunch({ origin: 'unknown' }, { origin: 'unknown' }), false);
  assert.equal(classifyLaunch([caller], 10, session).origin, 'unknown');
  assert.equal(sameLaunch(undefined, undefined), false);
  const spoof = { ...ide, pid: 15, ppid: 20 };
  assert.equal(classifyLaunch([{ ...caller, ppid: 15 }, spoof, ide], 10, session).origin, 'unknown');
  const nested = { ...ide, pid: 15, ppid: 20, executable: '/usr/bin/claude', argv: ['claude', '-p'] };
  assert.equal(classifyLaunch([{ ...caller, ppid: 15 }, nested, ide], 10, session).origin, 'managed');
});
