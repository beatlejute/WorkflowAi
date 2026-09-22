/**
 * Rails — журнал отказов и событий (спецификация §2, §7 шаг 5, §10).
 *
 * Один файл на проект: `<root>/.workflow/logs/rails-denials.jsonl`,
 * только дописывание. Каждая строка — независимый JSON-объект (jsonl),
 * побитые/незавершённые строки при чтении молча пропускаются (писал их,
 * возможно, оборванный на середине процесс — вечная ошибка чтения хуже
 * пропущенной строки, тот же принцип, что у `pause-request.mjs`).
 *
 * Открытый вопрос: `rails.yaml`/`core.mjs`/`cli.mjs` (не в этом пакете
 * работ) должны использовать один и тот же словарь `type` при записи через
 * `appendEvent`, иначе `summarize()` не сможет их сгруппировать. Здесь
 * зафиксирован минимальный набор: `"denial"` (пишет `appendDenial`),
 * `"reset"`, `"error"`, `"stop_block"`, `"cycle_limit"`, `"action_limit"`.
 */

import fs from 'node:fs';
import path from 'node:path';

const JOURNAL_REL_PATH = path.join('.workflow', 'logs', 'rails-denials.jsonl');

function journalPath(root) {
  return path.join(root, JOURNAL_REL_PATH);
}

function nowIso() {
  return new Date().toISOString();
}

function appendLine(root, obj) {
  const file = journalPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
}

/**
 * Запись отказа. Дополняет `entry` полями `t` (если не задано) и
 * `type: "denial"`.
 *
 * Ожидаемые поля `entry` (не проверяются строго — журнал терпим к форме):
 * `session`, `skill`, `node`, `run?`, `reason`, `tool?`, `path?`, `command?`.
 *
 * @param {string} root
 * @param {object} entry
 */
export function appendDenial(root, entry) {
  appendLine(root, { t: nowIso(), ...entry, type: 'denial' });
}

/**
 * Запись произвольного события журнала (сброс, ошибка хука, Stop-блок,
 * срабатывание потолка …). `entry.type` обязателен и не переопределяется
 * (в отличие от `appendDenial`).
 *
 * @param {string} root
 * @param {object} entry должен содержать `type`
 */
export function appendEvent(root, entry) {
  appendLine(root, { t: nowIso(), ...entry });
}

/**
 * Записи журнала за последние `days` дней (если задано) для скила `skill`
 * (если задан). Повреждённые строки пропускаются молча.
 *
 * @param {string} root
 * @param {{days?: number, skill?: string}} [filter]
 * @returns {object[]}
 */
export function readJournal(root, { days, skill } = {}) {
  return readJournalFile(journalPath(root), { days, skill });
}

/**
 * Записи из произвольного jsonl-файла журнала (например, `rails-trial-N.jsonl`,
 * сохранённого раннером тестов из изолированного workdir). Формат и фильтры —
 * как у `readJournal`.
 *
 * @param {string} file
 * @param {{days?: number, skill?: string}} [opts]
 * @returns {object[]}
 */
export function readJournalFile(file, { days, skill } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }

  const cutoff = typeof days === 'number' ? Date.now() - days * 86400000 : null;
  const out = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    // Валидный JSON, но не объект (`null`, число, строка, массив) — не
    // запись журнала, а мусор/обрывок; пропускаем, как и битые строки.
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    if (cutoff !== null) {
      const t = Date.parse(entry.t);
      if (Number.isNaN(t) || t < cutoff) continue;
    }
    // Записи без поля skill (например, reset/error/stop_block, записанные
    // до того, как вызывающий код стал его проставлять) не исключаются по
    // фильтру — исключаются только те, у кого skill задан и не совпадает
    // (minor-находка ревью: раньше запись без skill молча пропадала из
    // отчёта по конкретному скилу).
    if (skill && entry.skill != null && entry.skill !== skill) continue;
    out.push(entry);
  }
  return out;
}

/**
 * Сводка по записям журнала для отчёта (§10: `rails report`).
 *
 * @param {object[]} entries результат `readJournal`
 * @returns {{
 *   total: number,
 *   denialsByNode: Record<string, number>,
 *   repeatedNodes: Array<{node: string, session: string, count: number}>,
 *   cycleLimitHits: Record<string, number>,
 *   actionLimitHits: Record<string, number>,
 *   resets: number,
 *   stopBlocks: {total: number, byNode: Record<string, number>},
 *   errors: number
 * }}
 */
export function summarize(entries) {
  // Терпимо к плохому входу целиком (не массив, включая null/undefined) —
  // не падаем на `for...of`, а трактуем как пустой журнал.
  const list = Array.isArray(entries) ? entries : [];

  const denialsByNode = {};
  // session -> (node -> count); нагляднее и надёжнее, чем склейка ключа
  // строкой (была через NUL-байт, в листинге неотличима от пробела).
  const denialsBySessionNode = new Map();
  const cycleLimitHits = {};
  const actionLimitHits = {};
  const stopBlocksByNode = {};
  let resets = 0;
  let errors = 0;
  let stopBlocksTotal = 0;
  let total = 0;

  for (const e of list) {
    // Терпимо к мусору в entries (readJournal уже фильтрует, но summarize
    // — отдельно экспортируемая функция, вызывающий код может передать ей
    // что угодно): не объект — пропускаем, а не падаем на `e.type`, и не
    // засчитываем в `total` (иначе мусорные элементы раздували бы счётчик
    // записей, которые дальше фактически не обработаны).
    if (!e || typeof e !== 'object') continue;
    total++;
    switch (e.type) {
      case 'denial': {
        if (e.node) {
          denialsByNode[e.node] = (denialsByNode[e.node] || 0) + 1;
          const session = e.session ?? '';
          if (!denialsBySessionNode.has(session)) denialsBySessionNode.set(session, new Map());
          const byNode = denialsBySessionNode.get(session);
          byNode.set(e.node, (byNode.get(e.node) || 0) + 1);
        }
        break;
      }
      case 'reset':
        resets++;
        break;
      case 'error':
        errors++;
        break;
      case 'stop_block':
        stopBlocksTotal++;
        if (e.node) stopBlocksByNode[e.node] = (stopBlocksByNode[e.node] || 0) + 1;
        break;
      case 'cycle_limit':
        if (e.key) cycleLimitHits[e.key] = (cycleLimitHits[e.key] || 0) + 1;
        break;
      case 'action_limit':
        if (e.key) actionLimitHits[e.key] = (actionLimitHits[e.key] || 0) + 1;
        break;
      default:
        break;
    }
  }

  const repeatedNodes = [];
  for (const [session, byNode] of denialsBySessionNode) {
    for (const [node, count] of byNode) {
      if (count >= 3) repeatedNodes.push({ node, session, count });
    }
  }
  repeatedNodes.sort((a, b) => b.count - a.count);

  return {
    total,
    denialsByNode,
    repeatedNodes,
    cycleLimitHits,
    actionLimitHits,
    resets,
    stopBlocks: { total: stopBlocksTotal, byNode: stopBlocksByNode },
    errors,
  };
}
