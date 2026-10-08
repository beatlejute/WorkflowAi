// Общий замок жизненного цикла. Имя прежнего exit-lock сохранено для
// совместимости; чужие клеймы никогда не удаляются и не перехватываются.
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { realpathDeep } from './paths.mjs';

const held = new Map();

function lockError(message) {
  const error = new Error(message);
  error.railsFailClosed = true;
  return error;
}

export function acquireLifecycleLock(root, session) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(session))) throw new Error('недопустимая сессия замка');
  const directory = join(realpathDeep(root), '.workflow', 'state', 'rails');
  const lockFile = join(directory, `.exit-lock-${session}`);
  mkdirSync(directory, { recursive: true });
  let fd;
  try { fd = openSync(lockFile, 'wx'); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (fd === undefined) {
    let owner;
    try {
      const pid = Number(readFileSync(lockFile, 'utf8').trim());
      if (Number.isInteger(pid) && pid > 0) owner = pid;
    } catch { /* неизвестный владелец — busy */ }
    return { busy: true, owner, lockFile };
  }
  try { writeSync(fd, String(process.pid), 0, 'utf8'); }
  finally { closeSync(fd); }
  const owns = () => {
    try { return readFileSync(lockFile, 'utf8') === String(process.pid); }
    catch { return false; }
  };
  const lock = {
    busy: false, lockFile, token: lockFile, owns,
    release() {
      held.delete(lockFile);
      try { if (owns()) unlinkSync(lockFile); }
      catch { /* чужой или недоступный клейм не удаляем */ }
    },
  };
  held.set(lockFile, lock);
  return lock;
}

export function heldLifecycleLock(root, session) {
  const key = join(realpathDeep(root), '.workflow', 'state', 'rails', `.exit-lock-${session}`);
  const lock = held.get(key);
  return lock?.owns() ? lock : null;
}

/** Синхронная транзакция; вложенная запись использует тот же живой клейм. */
export function withLifecycleLock(root, session, callback) {
  const key = join(realpathDeep(root), '.workflow', 'state', 'rails', `.exit-lock-${session}`);
  const current = held.get(key);
  if (current) {
    if (!current.owns()) throw lockError('замок жизненного цикла потерян');
    return callback(current);
  }
  let lock;
  try { lock = acquireLifecycleLock(root, session); }
  catch (error) {
    error.railsFailClosed = true;
    throw error;
  }
  if (lock.busy) throw lockError(`замок жизненного цикла занят (pid ${lock.owner ?? '?'}, ${lock.lockFile})`);
  try { return callback(lock); }
  finally { lock.release(); }
}
