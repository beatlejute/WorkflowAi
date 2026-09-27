/**
 * Сколько файлов проекта изменил запуск агента — для градации «пусто» журнала запусков
 * (src/lib/agent-runs.mjs, PLAN-003). «Ничего не сделал (вообще)» — ни одного
 * изменённого файла проекта, включая тикет.
 *
 * Снимок artifact-snapshot в executeWithFallback для этого не годится: его область —
 * `src` и `configs`, без тестов и тикета, а снимок «после» делается только в ветке ошибки.
 *
 * Область:
 *   - проект в git — файлы из `git status` (отслеживаемые изменённые и неотслеживаемые,
 *     не исключённые git) и файлы коммитов, сделанных за время запуска; файл,
 *     изменённый до запуска, считается, если его содержимое изменилось;
 *   - проект без git — все файлы корня, кроме `.git`, `node_modules` и `*.tmp`;
 *   - в обоих случаях — файл тикета: `.workflow/` в проектах обычно не хранится в git,
 *     и правку тикета git не увидит.
 * Не считаются файлы, которые пишет сам раннер: `.workflow/logs/`, `.workflow/state/`
 * (в том числе запись открытого запуска), `.workflow/metrics/` (журнал запусков) — и в
 * проекте, где `.workflow/` не игнорируется git.
 *
 * Не удалось снять снимок или сравнить — null: градация тогда только по контролю
 * артефактов.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const RUNNER_PATHS = ['.workflow/logs/', '.workflow/state/', '.workflow/metrics/'];
const WALK_SKIP_DIRS = new Set(['.git', 'node_modules']);
const HASH_MAX_SIZE = 4 * 1024 * 1024;
const NUL = String.fromCharCode(0);

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
    // Раннер из MCP живёт без консоли: без флага git.exe открывал бы окно.
    windowsHide: true,
  });
}

function isRunnerPath(key) {
  return RUNNER_PATHS.some((prefix) => key === prefix.slice(0, -1) || key.startsWith(prefix));
}

function isOutside(key) {
  return key === '..' || key.startsWith('../') || path.isAbsolute(key);
}

// Ключ файла — путь от корня проекта через «/».
function relativeKey(root, absolute) {
  return path.relative(root, absolute).split(path.sep).join('/');
}

// git отдаёт пути от корня репозитория без символических ссылок и коротких имён
// (macOS: /private/var/… вместо /var/…; Windows: длинные имена вместо RUNNER~1),
// поэтому корень проекта для его путей — realpath.
function realRoot(projectRoot) {
  try { return fs.realpathSync.native(projectRoot); } catch { return path.resolve(projectRoot); }
}

// Отпечаток содержимого: размер и sha1; большой файл — размер и время изменения.
function fingerprint(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return 'not-a-file';
    if (stat.size > HASH_MAX_SIZE) return `${stat.size}:${stat.mtimeMs}`;
    return `${stat.size}:${crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex')}`;
  } catch {
    return 'missing';
  }
}

// `git status --porcelain=v1 -z`: «XY путь», у переименования и копии — ещё запись со
// старым путём; записи разделены нулевым байтом.
function parseStatus(output) {
  const paths = [];
  const parts = output.split(NUL);
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (code.includes('R') || code.includes('C')) {
      if (parts[i + 1]) paths.push(parts[i + 1]);
      i++;
    }
  }
  return paths;
}

function gitSnapshot(projectRoot) {
  let top;
  try {
    top = git(projectRoot, ['rev-parse', '--show-toplevel']).trim();
  } catch {
    return null;
  }
  let head = null;
  try { head = git(projectRoot, ['rev-parse', 'HEAD']).trim(); } catch {}
  const status = git(projectRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']);
  const root = realRoot(projectRoot);
  const files = new Map();
  for (const repoPath of parseStatus(status)) {
    const absolute = path.resolve(top, repoPath);
    files.set(relativeKey(root, absolute), fingerprint(absolute));
  }
  return { mode: 'git', top, head, root, files };
}

function walkSnapshot(projectRoot) {
  const root = path.resolve(projectRoot);
  const files = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      const key = relativeKey(root, absolute);
      if (entry.isDirectory()) {
        if (!WALK_SKIP_DIRS.has(entry.name) && !isRunnerPath(`${key}/`)) walk(absolute);
      } else if (entry.isFile() && !entry.name.endsWith('.tmp')) {
        files.set(key, fingerprint(absolute));
      }
    }
  };
  walk(root);
  return { mode: 'walk', files };
}

function ticketKey(projectRoot, ticketPath) {
  return relativeKey(path.resolve(projectRoot), path.resolve(ticketPath));
}

/**
 * Снимок перед запуском агента. `ticketPath` — путь файла тикета или null.
 * @returns {object|null} null — снимок не снят.
 */
export function captureRunChanges(projectRoot, ticketPath = null) {
  try {
    const snapshot = gitSnapshot(projectRoot) ?? walkSnapshot(projectRoot);
    snapshot.ticket = ticketPath ? { key: ticketKey(projectRoot, ticketPath), fingerprint: fingerprint(ticketPath) } : null;
    return snapshot;
  } catch {
    return null;
  }
}

/**
 * Число файлов проекта, изменённых после снимка `before`. `ticketPath` — путь тикета
 * после запуска (агент мог его перенести) или null.
 * @returns {number|null} null — снимка нет или сравнить не удалось.
 */
export function countRunChanges(projectRoot, before, ticketPath = null) {
  if (!before) return null;
  try {
    const changed = new Set();
    if (before.mode === 'git') {
      const after = gitSnapshot(projectRoot);
      if (!after) return null;
      for (const key of new Set([...before.files.keys(), ...after.files.keys()])) {
        const was = before.files.get(key);
        const now = after.files.get(key);
        // Файл в выводе git только до или только после запуска изменён запуском
        // (правка, откат или коммит); в обоих — если изменилось содержимое.
        if (was === undefined || now === undefined || was !== now) changed.add(key);
      }
      if (before.head && after.head && before.head !== after.head) {
        const committed = git(projectRoot, ['diff', '--name-only', '-z', before.head, after.head, '--', '.']);
        for (const repoPath of committed.split(NUL).filter(Boolean)) {
          changed.add(relativeKey(after.root, path.resolve(after.top, repoPath)));
        }
      }
    } else {
      const after = walkSnapshot(projectRoot);
      for (const key of new Set([...before.files.keys(), ...after.files.keys()])) {
        if (before.files.get(key) !== after.files.get(key)) changed.add(key);
      }
    }
    if (before.ticket || ticketPath) {
      const afterKey = ticketPath ? ticketKey(projectRoot, ticketPath) : null;
      if (!before.ticket || !afterKey) {
        changed.add(afterKey ?? before.ticket.key);
      } else if (before.ticket.key !== afterKey || before.ticket.fingerprint !== fingerprint(ticketPath)) {
        changed.add(afterKey);
      }
    }
    let count = 0;
    for (const key of changed) {
      if (!isOutside(key) && !isRunnerPath(key)) count += 1;
    }
    return count;
  } catch {
    return null;
  }
}
