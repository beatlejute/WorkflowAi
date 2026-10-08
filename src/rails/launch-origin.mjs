// Происхождение берётся из ОС, не из роли, окружения или аргументов инструмента.
import childProcess from 'node:child_process';
import { readFileSync, readlinkSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { realpathDeep } from './paths.mjs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function processSnapshot() {
  if (process.platform === 'win32') {
    const raw = childProcess.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public static class DesktopShell { [DllImport("user32.dll")] public static extern IntPtr GetShellWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId); }\'; '
      + '$shellPid = [uint32]0; $window = [DesktopShell]::GetShellWindow(); '
      + 'if ($window -ne [IntPtr]::Zero) { [void][DesktopShell]::GetWindowThreadProcessId($window, [ref]$shellPid) }; '
      + 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,@{n="Birth";e={$_.CreationDate.ToUniversalTime().ToString("o")}},@{n="DesktopShell";e={$shellPid -ne 0 -and $_.ProcessId -eq $shellPid}} | ConvertTo-Json -Compress'],
    { encoding: 'utf8', timeout: 15000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    return [].concat(JSON.parse(raw)).flatMap((p) => {
      try {
        return [{ pid: p.ProcessId, ppid: p.ParentProcessId,
          executable: p.ExecutablePath, argv: splitWindowsCommand(p.CommandLine || ''), birth: p.Birth,
          desktopShell: p.DesktopShell === true }];
      } catch { return []; } // Нечитаемый процесс не даёт обходить разрыв цепочки.
    });
  }
  if (process.platform !== 'linux') throw new Error('ОС не поддерживает проверку запуска');
  const result = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const argv = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').filter(Boolean);
      result.push({ pid: Number(name), ppid: Number(fields[1]), argv, executable: readlinkSync(`/proc/${name}/exe`),
        birth: `${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${fields[19]}` });
    } catch { /* процесс мог завершиться */ }
  }
  return result;
}

export function splitWindowsCommand(command) {
  const args = [];
  let value = '', quoted = false, present = false;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (char === '\\') {
      let end = i;
      while (command[end] === '\\') end += 1;
      const count = end - i;
      if (command[end] === '"') {
        value += '\\'.repeat(Math.floor(count / 2));
        if (count % 2) value += '"'; else quoted = !quoted;
        i = end;
      } else { value += '\\'.repeat(count); i = end - 1; }
      present = true;
    } else if (char === '"') { quoted = !quoted; present = true; }
    else if (/\s/.test(char) && !quoted) {
      if (present) args.push(value);
      value = ''; present = false;
    } else { value += char; present = true; }
  }
  if (quoted) throw new Error('незакрытая кавычка запуска');
  if (present) args.push(value);
  return args;
}

function flag(args, name) {
  const index = args.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (index < 0) return null;
  return args[index].includes('=') ? args[index].slice(name.length + 1) : args[index + 1];
}

function identity(p) {
  return { pid: p.pid, birth: p.birth, executable: p.executable, argv_sha256: hash(p.argv) };
}

function registryPath(root, pid) {
  return join(root, '.workflow', 'state', 'rails', `.managed-launch-${pid}.json`);
}

// ОС-личность текущего процесса неизменна до его завершения. Повторные spawn
// не требуют нового полного снимка процессов (CIM на Windows дорогой).
let launcherIdentity;

// Раннер регистрирует собственную неизменяемую ОС-личность ДО spawn.
export function registerManagedLauncher(root) {
  try {
    if (!launcherIdentity) {
      const p = processSnapshot().find((item) => item.pid === process.pid);
      if (!p?.birth || !p.executable) return false;
      launcherIdentity = identity(p);
    }
    mkdirSync(join(root, '.workflow', 'state', 'rails'), { recursive: true });
    writeFileSync(registryPath(root, launcherIdentity.pid), JSON.stringify(launcherIdentity));
    return true;
  } catch { return false; }
}

export function classifyLaunch(snapshot, pid, session, registered = () => false, boundSession = () => false) {
  const chain = [], seen = new Set();
  let complete = false;
  while (pid && !seen.has(pid) && chain.length < 64) {
    seen.add(pid);
    const p = snapshot.find((item) => item.pid === pid);
    if (!p) break;
    chain.push(p);
    if (p.ppid === 0 || p.desktopShell === true) { complete = true; break; }
    pid = p.ppid;
  }
  // Первый хост, а не внешний IDE-предок вложенного агента.
  const isHost = (p) => /(?:^|[\\/])claude(?:\.exe)?$/i.test(p.executable || '')
    || /(?:^|[\\/])kilo(?:\.exe)?$/i.test(p.executable || '')
    || p.argv?.slice(0, 2).some((a) => /(?:^|[\\/])kilo(?:\.js|\.mjs)?$/i.test(a));
  const index = chain.findIndex(isHost);
  if (index < 0) return { origin: 'unknown' };
  const host = chain[index], args = host.argv || [];
  if (!host.birth || !host.executable) return { origin: 'unknown' };
  const hostSession = flag(args, '--resume') || flag(args, '--session-id') || flag(args, '--session');
  if (hostSession && hostSession !== session) return { origin: 'unknown' };
  const managed = args.some((a) => a === '-p' || a === '--print' || a.startsWith('--print='))
    || (args.includes('run') && !/(?:^|[\\/])claude(?:\.exe)?$/i.test(host.executable));
  const registeredAncestor = chain.slice(index + 1).some((p) => registered(identity(p)));
  const interactive = complete && !managed && !registeredAncestor && !chain.slice(index + 1).some(isHost)
    && (hostSession === session || (!hostSession && boundSession(identity(host))))
    && /[\\/]\.vscode(?:-oss)?[\\/]extensions[\\/].*[\\/]native-binary[\\/]claude\.exe$/i.test(host.executable)
    && flag(args, '--permission-prompt-tool') === 'stdio'
    && args.includes('--replay-user-messages')
    && flag(args, '--input-format') === 'stream-json'
    && flag(args, '--output-format') === 'stream-json';
  return { origin: managed || registeredAncestor ? 'managed' : interactive ? 'interactive' : 'unknown',
    host: identity(host), session };
}

function hostCallback(snapshot) {
  const script = snapshot.find((p) => p.pid === process.pid)?.argv?.[1];
  const hook = fileURLToPath(new URL('./claude-hook.mjs', import.meta.url));
  return Boolean(script && realpathDeep(script) === realpathDeep(hook));
}

function sessionBindingPath(root, session) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(session))) throw new Error('недопустимая host session');
  return join(root, '.workflow', 'state', 'rails', `.host-session-${session}.json`);
}

// Вызывается только SessionStart хостового адаптера, до появления состояния скила.
export function bindHostSession(root, session) {
  try {
    const snapshot = processSnapshot();
    if (!hostCallback(snapshot)) return false;
    const launch = classifyLaunch(snapshot, process.pid, session, () => false, () => true);
    if (launch.origin !== 'interactive') return false;
    const binding = { root: realpathDeep(root), session, host: launch.host };
    mkdirSync(join(root, '.workflow', 'state', 'rails'), { recursive: true });
    const path = sessionBindingPath(root, session);
    try { writeFileSync(path, JSON.stringify(binding), { flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST' || hash(JSON.parse(readFileSync(path, 'utf8'))) !== hash(binding)) return false;
    }
    return true;
  } catch { return false; }
}

export function launchOrigin(root, session) {
  try {
    const snapshot = processSnapshot();
    const launch = classifyLaunch(snapshot, process.pid, session, (p) => {
      try { return hash(JSON.parse(readFileSync(registryPath(root, p.pid), 'utf8'))) === hash(p); }
      catch { return false; }
    }, (host) => {
      try {
        const binding = JSON.parse(readFileSync(sessionBindingPath(root, session), 'utf8'));
        return binding.root === realpathDeep(root) && binding.session === session
          && hash(binding.host) === hash(host);
      } catch { return false; }
    });
    if (hostCallback(snapshot)) launch.callback = 'stop-hook';
    return launch;
  } catch { return { origin: 'unknown' }; }
}

export function sameLaunch(pinned, current) {
  return ['interactive', 'managed'].includes(pinned?.origin)
    && Boolean(pinned?.host?.birth && pinned.host.executable && pinned.host.argv_sha256)
    && pinned?.session === current?.session && pinned?.origin === current?.origin
    && hash(pinned.host) === hash(current?.host);
}
