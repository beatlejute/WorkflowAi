/**
 * Rails — состояние сессии (спецификация §5).
 *
 * Файл `<root>/.workflow/state/rails/<sessionId>.json` — снимок, не
 * событийный лог. Запись атомарная (tmp + rename). Модуль не читает граф
 * сам: функции, которым нужен граф (`applyGoto`, `allowedTransitions`),
 * получают уже загруженный `Graph` параметром.
 *
 * Контракт `Graph` — настоящий, из `graph.mjs` (класс `Graph`):
 *   `graph.node(id) -> { id, stage, type, num, label, shape, source } | undefined`
 *   `graph.outgoing(id) -> [{ to, label: string|null }]`
 * Нормализация лейбла для сверки цитат (§3) — тоже оттуда (`normalizeLabel`),
 * не дублируется здесь.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { normalizeLabel } from './graph.mjs';

export { normalizeLabel };

const NODE_ID_RE = /^P(\d+)([ERSGQ])(\d+)$/;

function parseNodeId(id) {
  const m = NODE_ID_RE.exec(String(id));
  if (!m) return null;
  return { stage: Number(m[1]), type: m[2], num: Number(m[3]) };
}

// Порядок узлов внутри этапа по грамматике §3 (E → R → S → G/Q), внутри типа — по номеру.
const TYPE_RANK = { E: 0, R: 1, S: 2, G: 3, Q: 3 };
function nodeRank(info) {
  return (TYPE_RANK[info.type] ?? 9) * 1000 + info.num;
}

/**
 * Тип и этап текущего узла состояния, и «прозрачен» ли он (E-узел — §5:
 * «пока текущий узел E, действия этапа запрещены»). Узел с некорректным
 * (не по грамматике §3) id — `stage`/`type` равны `null`, `isEntry` — `false`.
 *
 * @param {object} state
 * @returns {{stage: number|null, type: string|null, isEntry: boolean}}
 */
export function currentNodeInfo(state) {
  const info = parseNodeId(state?.node);
  if (!info) return { stage: null, type: null, isEntry: false };
  return { stage: info.stage, type: info.type, isEntry: info.type === 'E' };
}

// Нормализация плохого/отсутствующего state (§7: хук оборачивает всё в
// try/catch и при исключении молча снимает рельсы — `allow` без деталей;
// каждый экспорт этого модуля обязан не падать сам по себе на `null`/не-
// объекте, а не полагаться только на внешний catch).
function normalizeState(state) {
  return state && typeof state === 'object' ? state : {};
}

function sanitizeSessionId(sessionId) {
  const s = String(sessionId ?? '');
  if (!s || s === '.' || s === '..' || /[\\/]/.test(s)) {
    throw new Error(`rails: некорректный sessionId: ${JSON.stringify(sessionId)}`);
  }
  return s;
}

function stateDir(root) {
  return path.join(root, '.workflow', 'state', 'rails');
}

function statePath(root, sessionId) {
  return path.join(stateDir(root), `${sanitizeSessionId(sessionId)}.json`);
}

/**
 * Состояние сессии с диска, или `null`, если файла нет / он повреждён.
 *
 * @param {string} root
 * @param {string} sessionId
 * @returns {object|null}
 */
export function loadState(root, sessionId) {
  try {
    const raw = fs.readFileSync(statePath(root, sessionId), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Атомарная запись состояния (tmp + rename).
 *
 * @param {string} root
 * @param {object} state
 */
export function saveState(root, state) {
  const dir = stateDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const target = statePath(root, state.session);
  const tmp = path.join(dir, `.${state.session}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, target);
}

/**
 * Удаляет файл состояния. Тихо, если его и так не было — запись факта
 * сброса в журнал (§5: «reset удаляет файл; факт сброса пишется в журнал»)
 * — забота вызывающего кода (`cli.mjs`), у него есть доступ к `journal.mjs`.
 *
 * @param {string} root
 * @param {string} sessionId
 */
export function deleteState(root, sessionId) {
  try {
    fs.unlinkSync(statePath(root, sessionId));
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err;
  }
}

/**
 * Создаёт состояние сессии в `entry` и сразу сохраняет его на диск.
 *
 * Открытый вопрос: спецификация (§5) отдаёт `start <skill>` проверку «уже
 * есть состояние для другого скила → отказ, если не `--force`» на откуп
 * CLI — здесь принято простое решение: `startState` ничего не проверяет и
 * просто создаёт/перезаписывает состояние, а решение «можно ли стартовать»
 * принимает `cli.mjs` (читает `loadState` до вызова).
 *
 * @param {{root: string, sessionId: string, skill: string, entry: string, run?: string|null}} args
 * @returns {object} созданное состояние
 */
export function startState({ root, sessionId, skill, entry, run = null }) {
  const now = new Date().toISOString();
  const state = {
    version: 1,
    session: sanitizeSessionId(sessionId),
    run: run ?? null,
    skill,
    node: entry,
    started: now,
    updated: now,
    history: [],
    counters: {},
    denials: {},
    flags: { correction_pending: false },
  };
  saveState(root, state);
  return state;
}

/**
 * Увеличивает счётчик `state.counters[key]` на 1 и обновляет `updated`.
 * Состояние мутируется на месте (сохранение на диск — забота вызывающего).
 *
 * @param {object} state
 * @param {string} key
 * @returns {number} новое значение счётчика
 */
export function bumpCounter(state, key) {
  const s = normalizeState(state);
  s.counters ??= {};
  const next = (s.counters[key] || 0) + 1;
  s.counters[key] = next;
  s.updated = new Date().toISOString();
  return next;
}

function bumpDenialCounter(state, node) {
  state.denials ??= {};
  state.denials[node] = (state.denials[node] || 0) + 1;
  state.updated = new Date().toISOString();
}

/**
 * Допустимые переходы из текущего узла: рёбра из графа, лейбл цели обрезан
 * до 60 символов (§5: «id: первые 60 символов лейбла»).
 *
 * @param {object} state
 * @param {{ node(id: string): object|undefined, outgoing(id: string): Array<{to: string, label: string|null}> }} graph
 * @returns {Array<{id: string, label: string}>}
 */
export function allowedTransitions(state, graph) {
  const s = normalizeState(state);
  const edges = graph?.outgoing(s.node) || [];
  return edges.map((e) => {
    const target = graph.node(e.to);
    const label = target ? String(target.label) : '';
    return { id: e.to, label: label.slice(0, 60) };
  });
}

/**
 * Потолок действия (`stage_actions.<rule>.max_per_session`, §4/§5): счётчик
 * `action:<ruleName>` в `state.counters`. Инкремент — только при успехе
 * (действие разрешено и «потрачено»); при превышении счётчик не растёт.
 *
 * Открытый вопрос: увеличивать ли заодно `state.denials[текущий узел]` при
 * превышении потолка действия — §7 отдаёт «инкремент denials[node]» отказам
 * `core.decide` в целом, а `core.mjs` (не в этом пакете работ) пока не
 * существует и решает, из какого узла и с каким текстом писать в журнал.
 * Здесь — простое решение: `checkActionLimit` только считает и отвечает,
 * денежный след (`denials`, журнал) — забота вызывающего кода.
 *
 * @param {object} state
 * @param {string} ruleName имя правила из `rails.yaml.stage_actions`
 * @param {number} max `max_per_session` этого правила
 * @returns {{ok: boolean, code?: string, key: string, reason?: string, count: number}}
 */
export function checkActionLimit(state, ruleName, max) {
  const s = normalizeState(state);
  s.counters ??= {};
  const key = `action:${ruleName}`;
  const count = s.counters[key] || 0;
  if (typeof max === 'number' && count >= max) {
    return {
      ok: false,
      code: 'action_limit',
      key,
      reason: `потолок действия «${ruleName}»: ${max} за сессию исчерпан — выход к человеку`,
      count,
    };
  }
  const next = bumpCounter(s, key);
  return { ok: true, key, count: next };
}

/**
 * Где цитата разошлась с лейблом: самый длинный префикс нормализованной цитаты,
 * который есть в нормализованном лейбле, и по ~30 символов после него у цитаты
 * и у лейбла. Отказ с одним текстом цитаты, обрезанным до 80 символов, не
 * показывал точку расхождения: по журналам прогонов 2026-09-22 нельзя было
 * отличить пересказ от раскрытого shell'ом `$X` (лейблы P3Q1/P3S5 коуча).
 * Префикс ищется бинарным поиском: если префикс длины k — подстрока лейбла,
 * то и любой более короткий тоже.
 *
 * @param {string} normQuote нормализованная цитата
 * @param {string} normLabel нормализованный лейбл цели
 * @param {string} [rawLabel] СЫРОЙ (не нормализованный) лейбл цели — normalizeLabel
 *   (graph.mjs) снимает бэктики, поэтому подсказку про `` ` `` по normLabel дать
 *   нельзя (2026-09-22: лейблы коуча содержат `` `.workflow/reports/` ``, порча
 *   цитаты shell'ом через бэктики оставалась без подсказки); ищем в сыром.
 * @returns {string} фрагмент причины отказа, оканчивается на "; " или пустой
 */
function describeQuoteMismatch(normQuote, normLabel, rawLabel) {
  if (!normLabel) return '';
  let lo = 0;
  let hi = normQuote.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (normLabel.includes(normQuote.slice(0, mid))) lo = mid;
    else hi = mid - 1;
  }
  // Один общий признак вместо отдельных проверок на "`" и "$" — иначе при обоих
  // символах сразу в сыром лейбле подсказка задваивалась бы. Подсказка идёт и на ветку
  // «не совпадает даже начало» (ревью 2026-09-22): когда `$X`/бэктик стоит в первых
  // ~10 символах лейбла, порча shell'ом даёт расхождение сразу в начале.
  const hint = /[`$]/.test(String(rawLabel ?? ''))
    ? ' (в лейбле цели есть ` или $: shell раскрывает их в двойных кавычках — возьми цитату в одинарные кавычки)'
    : '';
  if (lo < 10) return `с лейблом не совпадает даже начало цитаты${hint}; `;
  const pos = normLabel.indexOf(normQuote.slice(0, lo)) + lo;
  const matchedTail = normQuote.slice(Math.max(0, lo - 30), lo);
  const quoteNext = normQuote.slice(lo, lo + 30);
  const labelNext = normLabel.slice(pos, pos + 30);
  return `совпадает до «…${matchedTail}», дальше в цитате «${quoteNext}», в лейбле «${labelNext}»${hint}; `;
}

/**
 * Переход `goto <node> --quote "<текст>"` (§5).
 *
 * Условия допустимости, первая нарушенная — отказ:
 *  1. есть ребро из текущего узла в целевой (`code: "no-edge"`);
 *  2. цитата не короче `config.quote_min`, по умолчанию 25 (`code: "short-quote"`);
 *  3. нормализованная цитата — подстрока нормализованного лейбла цели
 *     (`code: "quote-mismatch"`);
 *  4. потолок цикла (`config.cycles`), если пара (текущий этап → этап цели)
 *     в нём числится, не превышен (`code: "cycle_limit"`, есть `key`).
 *
 * При отказе — инкремент `state.denials[текущий узел]`. При успехе —
 * запись в `history`, перевод `state.node`, инкремент счётчика цикла, если
 * применим. Состояние мутируется на месте; сохранение на диск (`saveState`)
 * — забота вызывающего кода (эта функция не получает `root`).
 * `state.counters`/`state.denials`/`state.history` инициализируются, если их
 * нет (повреждённый или собранный вручную JSON).
 *
 * E-прозрачность (§5 — «пока текущий узел E, действия этапа запрещены»)
 * касается гейта `stage_actions`, которого здесь нет — она реализуется в
 * `core.mjs` через `currentNodeInfo(state).isEntry`. `applyGoto` её не
 * проверяет: переход *в* E-узел спецификацией разрешён явно.
 *
 * @param {object} state
 * @param {{ node(id: string): object|undefined, outgoing(id: string): Array<{to: string, label: string|null}> }} graph
 * @param {object} config распарсенный `rails.yaml`
 * @param {{node: string, quote: string}} params
 * @returns {{ok: boolean, code?: string, key?: string, reason?: string, allowed: Array<{id: string, label: string}>}}
 */
export function applyGoto(state, graph, config, { node, quote } = {}) {
  const s = normalizeState(state);
  s.counters ??= {};
  s.denials ??= {};
  s.history ??= [];

  const current = s.node;
  const deny = (code, reason, key) => {
    bumpDenialCounter(s, current);
    const result = { ok: false, code, reason, allowed: allowedTransitions(s, graph) };
    if (key) result.key = key;
    return result;
  };

  const edges = graph?.outgoing(current) || [];
  const edge = edges.find((e) => e.to === node);
  if (!edge) {
    return deny('no-edge', `нет ребра из ${current} в ${node}`);
  }

  const quoteMin = config?.quote_min ?? 25;
  const normQuote = normalizeLabel(quote || '');
  // Текст цитаты попадает в отказ (и в журнал): без него по журналу не понять,
  // что именно агент цитировал не так (прогоны 2026-09-22, ×20 «цитата не найдена»).
  const shownQuote = String(quote || '').replace(/\s+/g, ' ').slice(0, 80);
  if (normQuote.length < quoteMin) {
    return deny('short-quote', `цитата «${shownQuote}» короче ${quoteMin} символов`);
  }

  const targetNode = graph?.node(node);
  const targetLabel = targetNode ? normalizeLabel(targetNode.label) : '';
  if (!targetNode || !targetLabel.includes(normQuote)) {
    return deny('quote-mismatch', `цитата «${shownQuote}» не найдена в лейбле узла ${node} — ${describeQuoteMismatch(normQuote, targetLabel, targetNode?.label)}нужна дословная подстрока лейбла`);
  }

  const fromInfo = parseNodeId(current);
  const toInfo = parseNodeId(node);
  let cycleKey = null;
  if (fromInfo && toInfo && Array.isArray(config?.cycles)) {
    const cyc = config.cycles.find((c) => c.from === fromInfo.stage && c.to === toInfo.stage);
    // Запись `from == to` — потолок на ВОЗВРАТ внутри этапа (гейт → шаг), а не на
    // любой переход по цепочке E → R → S → G: первый прогон коуча 2026-09-22 упёрся в
    // «cycle_limit» на P1R3 после трёх штатных шагов вперёд. Возврат = целевой узел
    // раньше текущего по порядку типов E < R < S < G/Q, при равном типе — по номеру.
    const sameStage = fromInfo.stage === toInfo.stage;
    const isBackward = !sameStage || nodeRank(toInfo) < nodeRank(fromInfo);
    if (cyc && isBackward) {
      const key = `cycle:${fromInfo.stage}>${toInfo.stage}`;
      const projected = (s.counters[key] || 0) + 1;
      if (projected > cyc.max) {
        // `rails.yaml` уже пишет «выход к человеку» в текст `reason` (см.
        // пример §4) — суффикс не дублируется, только дефолт на случай
        // отсутствия reason в конфиге.
        return deny('cycle_limit', cyc.reason || `потолок цикла ${key} превышен — выход к человеку`, key);
      }
      cycleKey = key;
    }
  }

  const now = new Date().toISOString();
  s.history.push({ t: now, from: current, to: node });
  s.node = node;
  s.updated = now;
  if (cycleKey) bumpCounter(s, cycleKey);

  return { ok: true, allowed: allowedTransitions(s, graph) };
}

/**
 * Самый свежий по mtime файл состояния проекта, или `null`, если состояний
 * нет. CLI использует это как последний вариант резолва sessionId (после
 * `--session` и `WORKFLOW_RAILS_SESSION`); предупреждение в stderr о том,
 * что sessionId угадан — забота CLI, не этой функции.
 *
 * @param {string} root
 * @returns {string|null}
 */
export function newestSessionId(root) {
  let dir;
  try {
    dir = stateDir(root);
  } catch {
    return null;
  }
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  let best = null;
  let bestMtime = -Infinity;
  for (const name of entries) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    const mtime = stat.mtimeMs;
    if (mtime > bestMtime) {
      bestMtime = mtime;
      best = name.slice(0, -'.json'.length);
    }
  }
  return best;
}
