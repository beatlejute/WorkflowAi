/**
 * Фактическая модель kilo-агента.
 *
 * Роутеры kilo выбирают модель сами: `kilo/kilo-auto/free` — одну на сессию, и от
 * сессии к сессии разную; `kilo/openrouter/free` — заново почти на каждом шаге.
 * Проверено по базе kilo 2026-09-25: у execute-task PulseProxy через openrouter/free
 * в одной сессии отвечали 11 разных моделей, через kilo-auto/free — одна
 * (dots-3-note-preview). В логе раннера до этого был виден только роутер.
 *
 * kilo 7.7.9 записывает ответившую модель в каждую часть `step-finish` своей базы
 * SQLite (`part.data.model.modelID`; запрошенная — в `session.model`). Чтобы найти
 * сессию запуска, раннер передаёт `kilo run --title <метка>`; сессии субагентов
 * (`session.parent_id`) считаются вместе с корневой.
 *
 * Пока агент работает, раннер опрашивает базу и пишет строку `AGENT_MODELS`, когда
 * набор моделей меняется, и финальную — после выхода. По ней панель pipeline в
 * расширении показывает агента как `openrouter-free(nemotron, ling)`; та же подпись
 * встаёт в столбец «Агент» истории работы тикета (kiloAgentLabel).
 *
 * Путь базы отдаёт сам kilo (`kilo db path`): он зависит от канала сборки и
 * переменной KILO_DB, повторять эту логику здесь — значит разойтись с kilo при
 * обновлении. Вызов стоит ~5 с (старт kilo), поэтому один раз на процесс. Чтение —
 * встроенным `node:sqlite` (Node ≥ 22.5), только чтение: база в режиме WAL, kilo
 * пишет в неё параллельно. Нет модуля, нет базы, нет сессии — результат null, запуск
 * агента от этого не зависит.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const KILO_COMMAND_RE = /^kilo(\.cmd|\.exe|\.ps1)?$/i;

/** kilo-агент в режиме `run` — у других подкоманд сессии с моделью нет. */
export function isKiloRun(agent) {
  if (!agent || typeof agent.command !== 'string' || !Array.isArray(agent.args)) return false;
  return KILO_COMMAND_RE.test(path.basename(agent.command)) && agent.args.includes('run');
}

/**
 * Метка сессии kilo для одного запуска агента. Только [A-Za-z0-9._-]: на Windows
 * аргументы идут через cmd.exe без кавычек (shell: true).
 */
export function kiloRunTitle(runId) {
  return `workflow-${String(runId).replace(/[^A-Za-z0-9._-]/g, '-')}`;
}

/** Аргументы с `--title` сразу после `run`; заданный в конфиге `--title` не трогается. */
export function withKiloTitle(args, title) {
  if (args.includes('--title')) return [...args];
  const i = args.indexOf('run');
  return [...args.slice(0, i + 1), '--title', title, ...args.slice(i + 1)];
}

/** Модель из `-m` / `--model` аргументов агента (то, что запросил конфиг). */
export function requestedKiloModel(args) {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '-m' || args[i] === '--model') return args[i + 1];
  }
  return null;
}

let dbPathPromise = null;

/**
 * Путь базы kilo — `kilo db path`, последняя непустая строка stdout. Кэш на процесс;
 * неудача тоже кэшируется (null), чтобы не платить 5 с на каждом запуске агента.
 */
export function kiloDbPath(command = 'kilo', { timeoutMs = 30000 } = {}) {
  if (dbPathPromise) return dbPathPromise;
  dbPathPromise = new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(command, ['db', 'path'], {
        shell: process.platform === 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(null); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => {
      clearTimeout(timer);
      const last = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
      resolve(last && /\.db$/i.test(last) && fs.existsSync(last) ? last : null);
    });
  });
  return dbPathPromise;
}

/** Для тестов: без аргумента — сброс кэша пути, с аргументом — подмена (путь или null). */
export function setKiloDbPathCache(...value) {
  dbPathPromise = value.length ? Promise.resolve(value[0]) : null;
}

let sqlitePromise = null;

// node:sqlite печатает ExperimentalWarning при загрузке. Раннер работает в фоне, строка
// в его stderr — шум без действия; глушится только это предупреждение и только на
// время загрузки модуля.
function loadSqlite() {
  if (sqlitePromise) return sqlitePromise;
  const original = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
    if (type === 'ExperimentalWarning' && /sqlite/i.test(String(warning?.message ?? warning))) return;
    return original.call(this, warning, ...rest);
  };
  sqlitePromise = import('node:sqlite')
    .catch(() => null)
    .finally(() => { process.emitWarning = original; });
  return sqlitePromise;
}

const MODELS_SQL = `
WITH RECURSIVE tree(id) AS (
  SELECT id FROM session WHERE title = ?
  UNION SELECT s.id FROM session s JOIN tree t ON s.parent_id = t.id
)
SELECT json_extract(p.data, '$.model.modelID') AS model, count(*) AS steps
FROM part p JOIN tree t ON p.session_id = t.id
WHERE json_valid(p.data) AND json_extract(p.data, '$.type') = 'step-finish'
GROUP BY model
ORDER BY steps DESC, model`;

/**
 * Модели, ответившие в сессии с меткой `title` и её субагентах.
 * @returns {Promise<Array<{model: string, steps: number}>|null>} null — сессии нет
 *   или база не читается; [] — сессия есть, шагов с моделью нет.
 */
export async function readKiloModels(dbPath, title) {
  if (!dbPath || !title) return null;
  const sqlite = await loadSqlite();
  if (!sqlite?.DatabaseSync) return null;
  let db;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const found = db.prepare('SELECT 1 FROM session WHERE title = ? LIMIT 1').get(title);
    if (!found) return null;
    return db.prepare(MODELS_SQL).all(title)
      .filter((r) => r.model)
      .map((r) => ({ model: String(r.model), steps: Number(r.steps) }));
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch {}
  }
}

/** «модель ×шаги» через запятую — полный вид для лога. */
export function formatKiloModels(models) {
  return models.map(({ model, steps }) => `${model} ×${steps}`).join(', ');
}

// `nvidia/nemotron-3-ultra-550b-a55b:free` → `nemotron-3-ultra-550b-a55b`
function modelName(id) {
  return String(id).slice(String(id).lastIndexOf('/') + 1).replace(/:free$/, '');
}

/**
 * Подпись агента для истории работы тикета и панели pipeline:
 *  - модель одна и совпадает с запрошенной (openai/gpt-5.6-luna) — просто `gpt-luna`;
 *  - одна другая (роутер выбрал) — `kilo-free(dots-3-note-preview)`;
 *  - несколько — семейства по убыванию шагов: `openrouter-free(nemotron, ling, nex)`.
 *    Семейство — имя модели до первого дефиса (`ling-3.0-flash-fin` → `ling`).
 */
export function kiloAgentLabel(agentId, requested, models) {
  if (!models || models.length === 0) return agentId;
  const names = models.map((m) => modelName(m.model));
  if (names.length === 1) {
    return requested && names[0] === modelName(requested) ? agentId : `${agentId}(${names[0]})`;
  }
  const families = [...new Set(names.map((n) => n.split('-')[0]))];
  return `${agentId}(${families.join(', ')})`;
}
