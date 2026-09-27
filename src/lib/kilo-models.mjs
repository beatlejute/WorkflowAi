/**
 * Фактическая модель kilo-агента.
 *
 * Роутеры kilo выбирают модель сами: `kilo/kilo-auto/free` — одну на сессию, и от
 * сессии к сессии разную; `kilo/openrouter/free` — заново почти на каждом шаге.
 * Проверено по базе kilo 2026-09-25: у execute-task PulseProxy через openrouter/free
 * в одной сессии отвечали 11 разных моделей, через kilo-auto/free — одна
 * (dots-3-note-preview). В логе раннера до этого был виден только роутер.
 *
 * kilo 7.7.9 записывает ответившую модель роутера в каждую часть `step-finish` своей
 * базы SQLite (`part.data.model.modelID`); у сессии с фиксированной моделью шаги без
 * модели, и модель шага — модель сессии (`session.model.id`). Чтобы найти сессию
 * запуска, раннер передаёт `kilo run --title <метка>`; сессии субагентов
 * (`session.parent_id`) считаются вместе с корневой. За запуск отвечает модель
 * последнего шага корневой сессии (readKiloRun, поле `last`).
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

/**
 * Ключ модели, как её хранит kilo: `session.model.id` — без провайдера из `-m`
 * (`openai/<модель>` → `<модель>`, `kilo/<роутер>/free` → `<роутер>/free`).
 */
export function kiloModelKey(requested) {
  if (typeof requested !== 'string' || !requested) return null;
  const slash = requested.indexOf('/');
  return slash === -1 ? requested : requested.slice(slash + 1);
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

// Модель сессии — `session.model.id` (JSON `{"id", "providerID", …}`, как хранит kilo:
// без провайдера из `-m`). Шаг `step-finish` без `model.modelID` отвечает моделью своей
// сессии: у сессии с фиксированной моделью kilo 7.7.9 модель в шаг не пишет (запрос к
// базе PulseProxy 2026-09-26: gpt-5.6-luna — 976 шагов, ни одного с моделью), у
// роутерной — пишет в каждый шаг. Субагент без своей модели (`session.model` = null)
// получает модель корневой сессии.
const SESSION_MODEL = "CASE WHEN json_valid(%s) THEN json_extract(%s, '$.id') END";
const sessionModel = (column) => SESSION_MODEL.replaceAll('%s', column);

const MODELS_SQL = `
WITH RECURSIVE tree(id, model) AS (
  SELECT id, ${sessionModel('model')} FROM session WHERE title = ?
  UNION SELECT s.id, COALESCE(${sessionModel('s.model')}, t.model) FROM session s JOIN tree t ON s.parent_id = t.id
)
SELECT COALESCE(json_extract(p.data, '$.model.modelID'), t.model) AS model, count(*) AS steps
FROM part p JOIN tree t ON p.session_id = t.id
WHERE json_valid(p.data) AND json_extract(p.data, '$.type') = 'step-finish'
GROUP BY 1
ORDER BY steps DESC, model`;

// Последний шаг корневой сессии: наибольший `part.time_created`, при равенстве —
// наибольший `part.id`. Шаги субагентов не учитываются: за запуск отвечает модель,
// на которой закончила корневая сессия (решение стейкхолдера 2026-09-25,
// PLAN-003: «openrouter/free последняя — ответственна за все предыдущие»).
const LAST_MODEL_SQL = `
SELECT COALESCE(json_extract(p.data, '$.model.modelID'), ${sessionModel('s.model')}) AS model
FROM session s JOIN part p ON p.session_id = s.id
WHERE s.title = ? AND s.parent_id IS NULL
  AND json_valid(p.data) AND json_extract(p.data, '$.type') = 'step-finish'
ORDER BY p.time_created DESC, p.id DESC
LIMIT 1`;

/**
 * Модели запуска kilo с меткой `title`: ответившие в корневой сессии и её субагентах
 * и модель последнего шага корневой сессии.
 * @returns {Promise<{models: Array<{model: string, steps: number}>, last: string|null}|null>}
 *   null — сессии нет или база не читается; `models: []`, `last: null` — сессия есть,
 *   шагов с моделью нет.
 */
export async function readKiloRun(dbPath, title) {
  if (!dbPath || !title) return null;
  const sqlite = await loadSqlite();
  if (!sqlite?.DatabaseSync) return null;
  let db;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const found = db.prepare('SELECT 1 FROM session WHERE title = ? LIMIT 1').get(title);
    if (!found) return null;
    const models = db.prepare(MODELS_SQL).all(title)
      .filter((r) => r.model)
      .map((r) => ({ model: String(r.model), steps: Number(r.steps) }));
    const last = db.prepare(LAST_MODEL_SQL).get(title)?.model;
    return { models, last: last ? String(last) : null };
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch {}
  }
}

/**
 * Модели, ответившие в сессии с меткой `title` и её субагентах.
 * @returns {Promise<Array<{model: string, steps: number}>|null>} null — сессии нет
 *   или база не читается; [] — сессия есть, шагов с моделью нет.
 */
export async function readKiloModels(dbPath, title) {
  return (await readKiloRun(dbPath, title))?.models ?? null;
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
