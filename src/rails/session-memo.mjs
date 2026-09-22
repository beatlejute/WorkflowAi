/**
 * Rails — память «сессия → корень проекта» (2026-09-22).
 *
 * Сессия Claude Code, запущенная из каталога-зонтика (например, D:\Dev), в каждом
 * вызове хука несёт `cwd` зонтика, а не проекта: корень по `cwd` не находится, и для
 * shell-команд (git, runner, канарейка) рельсы молчат. Корень при этом известен из
 * других источников: `rails start <skill> --session <id>` из каталога проекта
 * и edit/write с путём внутри проекта. Здесь он запоминается по идентификатору
 * сессии в глобальном каталоге (`<WORKFLOW_HOME|~/.workflow>/state/rails-sessions.json`)
 * и отдаётся хуку как запасной корень для команд без пути. Файл — снимок, ≤ 50
 * последних сессий, запись атомарная (tmp + rename). Ошибки чтения/записи
 * глотаются: память — удобство, не гард.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { getGlobalDir } from '../global-dir.mjs';

const MAX_ENTRIES = 50;

function memoPath() {
  return join(getGlobalDir(), 'state', 'rails-sessions.json');
}

function readMemo() {
  try {
    const parsed = JSON.parse(readFileSync(memoPath(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * @param {string} sessionId
 * @param {string} root абсолютный путь корня проекта (с `.workflow/`)
 */
export function rememberSessionRoot(sessionId, root) {
  if (!sessionId || !root) return;
  try {
    const memo = readMemo();
    if (memo[sessionId] && memo[sessionId].root === root) return;
    memo[sessionId] = { root, t: new Date().toISOString() };
    // Сначала уходят записи, чей корень уже не существует (временные проекты
    // тестов/раннера), и только потом — самые старые живые: иначе поток
    // одноразовых корней вытесняет память реальных сессий.
    for (const k of Object.keys(memo)) {
      if (k === sessionId) continue;
      const r = memo[k] && memo[k].root;
      if (typeof r !== 'string' || !existsSync(join(r, '.workflow'))) delete memo[k];
    }
    const keys = Object.keys(memo).sort((a, b) => String(memo[a].t).localeCompare(String(memo[b].t)));
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete memo[k];
    const file = memoPath();
    mkdirSync(join(file, '..'), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(memo, null, 2), 'utf8');
    renameSync(tmp, file);
  } catch {
    // память — удобство, не гард
  }
}

/**
 * @param {string} sessionId
 * @returns {string|null} корень проекта, если он ещё существует
 */
export function recallSessionRoot(sessionId) {
  if (!sessionId) return null;
  const entry = readMemo()[sessionId];
  if (!entry || typeof entry.root !== 'string') return null;
  return existsSync(join(entry.root, '.workflow')) ? entry.root : null;
}
