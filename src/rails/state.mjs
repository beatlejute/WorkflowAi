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
import { isEdgeGuardPath, TICKET_PLACEHOLDER } from './rails-config.mjs';

export { normalizeLabel };

const NODE_ID_RE = /^P(\d+)([ERSGQ])(\d+)$/;

function parseNodeId(id) {
  const m = NODE_ID_RE.exec(String(id));
  if (!m) return null;
  return { stage: Number(m[1]), type: m[2], num: Number(m[3]) };
}

// Узлы, достижимые из `start`, не заходя в `avoid`; при `stage` — только по узлам этапа.
function reachableFrom(graph, start, { stage = null, avoid = null } = {}) {
  const seen = new Set();
  if (start === avoid) return seen;
  seen.add(start);
  const queue = [start];
  while (queue.length) {
    const id = queue.shift();
    for (const { to } of graph?.outgoing(id) || []) {
      if (to === avoid || seen.has(to)) continue;
      if (stage !== null && parseNodeId(to)?.stage !== stage) continue;
      seen.add(to);
      queue.push(to);
    }
  }
  return seen;
}

// Возврат внутри этапа — переход в узел, через который проходит любой путь от входа
// этапа к текущему узлу (цель доминирует над текущим внутри этапа). Узел, в который
// от входа внутри этапа не попасть (гейт валидации, куда приходят из другого этапа), —
// возврат, если переход замыкает петлю по графу целиком.
// Порядок типов E < R < S < G/Q для этого не годится: гейт стоит в конце цепочки,
// и его штатный переход «да» к следующему шагу выглядел возвратом. На этапе разбиения
// скила декомпозиции таких рёбер пять, потолок 3 — запись тикетов отклонялась на
// четвёртом шаге вперёд в каждом прогоне (2026-09-24).
function isReturnWithinStage(graph, stage, from, to) {
  const entry = `P${stage}E1`;
  if (graph?.node(entry) && reachableFrom(graph, entry, { stage }).has(from)) {
    return !reachableFrom(graph, entry, { stage, avoid: to }).has(from);
  }
  return reachableFrom(graph, to).has(from);
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
    throw new StateError(`rails: некорректный sessionId: ${JSON.stringify(sessionId)}`);
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
 * Повреждённое состояние — не «сессии нет», а fail closed: refuse-ошибка с
 * `railsFailClosed`, которую границы хуков/CLI не глотают в allow.
 */
export class StateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StateError';
    this.railsFailClosed = true;
  }
}

// Состояние нового ядра обязано быть целостным: версия, идентификаторы, счётчики.
// Состояние без привязки runtime (до внедрения) принимается — это не признак порчи.
function validateState(state, sessionId) {
  const bad = (why) => { throw new StateError(`состояние сессии повреждено: ${why}`); };
  if (!state || typeof state !== 'object' || Array.isArray(state)) bad('не объект');
  if (state.version !== 1) bad('неизвестная версия');
  if (state.session !== sessionId) bad('session не совпадает с именем файла');
  for (const field of ['skill', 'node']) {
    if (typeof state[field] !== 'string' || !state[field]) bad(`поле ${field}`);
  }
  for (const field of ['started', 'updated']) {
    if (typeof state[field] !== 'string' || Number.isNaN(Date.parse(state[field]))) bad(`время ${field}`);
  }
  if (!Array.isArray(state.history)) bad('история не массив');
  for (const field of ['counters', 'denials']) {
    const obj = state[field];
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) bad(`поле ${field} не объект`);
    for (const v of Object.values(obj)) {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) bad(`счётчик ${field}`);
    }
  }
  for (const field of ['run', 'ticket']) {
    if (state[field] != null && typeof state[field] !== 'string') bad(`поле ${field}`);
  }
  if (state.flags !== undefined && (!state.flags || typeof state.flags !== 'object' || Array.isArray(state.flags))) bad('flags не объект');
  if (state.dedupe !== undefined && (!state.dedupe || typeof state.dedupe !== 'object' || Array.isArray(state.dedupe))) bad('dedupe не объект');
  if (state.runtime !== undefined) {
    const r = state.runtime;
    if (!r || typeof r !== 'object' || Array.isArray(r)
      || r.version !== 1 || typeof r.id !== 'string' || !/^[a-f0-9]{64}$/.test(r.id)
      || typeof r.hash !== 'string' || !/^[a-f0-9]{64}$/.test(r.hash)) bad('привязка runtime');
  }
}

/**
 * Состояние сессии с диска: файл отсутствует — `null`; прочитано, но повреждено —
 * StateError (fail closed).
 *
 * @param {string} root
 * @param {string} sessionId
 * @returns {object|null}
 */
export function loadState(root, sessionId) {
  let raw;
  try {
    raw = fs.readFileSync(statePath(root, sessionId), 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw new StateError(`состояние сессии не прочитано: ${err.message}`);
  }
  let state;
  try {
    state = JSON.parse(raw);
  } catch {
    throw new StateError('состояние сессии повреждено: не JSON');
  }
  validateState(state, sessionId);
  return state;
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
 * `ticket` — id тикета запуска для `{ticket}` в стражах рёбер (§4): хук пишет его из
 * окружения хоста, и `goto` берёт тикет отсюда, а не из окружения CLI, которое команда
 * агента меняет (ревью стража 2026-09-27).
 *
 * @param {{root: string, sessionId: string, skill: string, entry: string, run?: string|null, ticket?: string|null}} args
 * @returns {object} созданное состояние
 */
export function startState({ root, sessionId, skill, entry, run = null, ticket = null }) {
  const now = new Date().toISOString();
  const state = {
    version: 1,
    session: sanitizeSessionId(sessionId),
    run: run ?? null,
    ticket: ticket || null,
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
 * Допустимые переходы из текущего узла: рёбра из графа, лейбл цели — до 60 символов
 * (§5: «id: первые 60 символов лейбла»), обрезка по слову с «…».
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
    return { id: e.to, label: shortLabel(label, 60) };
  });
}

// Начало лейбла не длиннее max символов, обрезанное по слову и помеченное «…». Инцидент
// 2026-09-30 (журнал отказов execute-task PulseProxy с 29.09: 65 отказов по цитате из 435):
// `slice(0, 60)` резал посреди слова («…а не типо», «…с DoD п»), и слабая модель дописывала
// оборванное слово своими словами вместо копирования готовой команды.
function shortLabel(label, max) {
  const s = String(label ?? '');
  if (s.length <= max) return s;
  const cut = s.lastIndexOf(' ', max - 1);
  return `${(cut > 0 ? s.slice(0, cut) : s.slice(0, max - 1)).replace(/[\s,.:;—–-]+$/, '')}…`;
}

/** Путь CLI рельс от корня проекта — так его вызывает агент (§10). */
export const RAILS_CLI = '.workflow/src/rails/cli.mjs';

/**
 * Цитата лейбла, которую `goto` примет как есть: подстрока лейбла без разметки и пиктограмм
 * (их normalizeLabel всё равно снимает), не короче `quoteMin` после нормализации, до ~60
 * символов с обрезкой по слову, без одиночных кавычек — команда кладёт цитату в '…', а `'`
 * закрыл бы строку и в bash, и в PowerShell. Не нашлось — null.
 *
 * Зачем: отказ и вывод CLI называли допустимые переходы, но не команду. Прогон deep-research
 * 2026-09-25: haiku после отказа писала «пройду граф правильно» и снова не делала ни одного
 * перехода — из текста рельс не было видно, какой командой двигаться.
 *
 * Длинный лейбл режется по границе фразы (перед «.», «:», «;», «,», «?», «!», « —», « (»),
 * по пробелу — только если фразы нужной длины в 60 символах нет. Инцидент 2026-09-30 (65
 * отказов по цитате у execute-task PulseProxy с 29.09): цитата, оборванная по слову, кончалась
 * висящим словом («…с более чем 5», «…тикета, а не»), и модель дописывала фразу своими словами.
 *
 * @param {string} label сырой лейбл узла
 * @param {number} [quoteMin]
 * @returns {string|null}
 */
export function readyQuote(label, quoteMin = 25) {
  const clean = String(label ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/[`*]/g, '')
    .replace(/(?!©)[\p{Extended_Pictographic}️‍]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  const target = normalizeLabel(label);
  // PowerShell закрывает '…' и типографскими одиночными кавычками U+2018–U+201B
  // (`'a’b c'` — ParserError в PowerShell 5.1 и pwsh 7.6, проверено запуском 2026-09-25)
  for (const chunk of clean.split(/['‘-‛]/)) {
    let q = chunk.replace(/^[\s-]+/, '').trimEnd();
    if (q.length > 60) q = quoteCut(q, quoteMin);
    const norm = normalizeLabel(q);
    if (norm.length >= quoteMin && target.includes(norm)) return q;
  }
  return null;
}

// Конец цитаты длинного куска: последняя граница фразы в пределах 60 символов, при которой
// цитата не короче quoteMin; иначе последний пробел; иначе 60 символов. «.» после сокращения —
// слова из частей в одну-две буквы через точку («т. е.», «т.д.», «и т. п.») — фразу не
// заканчивает. Ревью 2026-10-01: проверка «слово короче трёх букв» пропускала «т.д» (три символа
// с точкой внутри), и из «…и т.д. и тому…» выходило «…и т.д».
const PHRASE_END_RE = /[.:;,?!](?=\s)|\s(?=[—–(])/g;
const ABBREV_TAIL_RE = /(?:^|\s)(?:[^\s.]{1,2}\.)*[^\s.]{1,2}$/;
// Хвост «т.» / «т. е.» у запасной обрезки по пробелу.
const ABBREV_DOT_TAIL_RE = /(?:^|\s)(?:[^\s.]{1,2}\.)+$/;

function quoteCut(q, quoteMin) {
  const head = q.slice(0, 62);
  const long = (end) => end > 0 && normalizeLabel(q.slice(0, end)).length >= quoteMin;
  let best = -1;
  for (const m of head.matchAll(PHRASE_END_RE)) {
    const end = m.index;
    if (end > 60) continue;
    if (m[0] === '.' && ABBREV_TAIL_RE.test(q.slice(0, end))) continue;
    if (long(end)) best = end;
  }
  if (best > 0) return q.slice(0, best).trimEnd();
  let cut = q.lastIndexOf(' ', 60);
  if (!long(cut)) return q.slice(0, 60).trimEnd();
  // запасная обрезка не кончается сокращением («…, т. е.»): отступаем на слово назад, пока
  // цитата не короче quoteMin
  while (ABBREV_DOT_TAIL_RE.test(q.slice(0, cut))) {
    const prev = q.lastIndexOf(' ', cut - 1);
    if (!long(prev)) break;
    cut = prev;
  }
  return q.slice(0, cut).trimEnd();
}

/**
 * Готовая команда перехода в узел `id`. Без подходящей цитаты — шаблон с местом под неё.
 *
 * @param {string} id
 * @param {string} label сырой лейбл узла `id`
 * @param {number} [quoteMin]
 * @returns {string}
 */
export function gotoCommand(id, label, quoteMin = 25) {
  const q = readyQuote(label, quoteMin);
  return `node ${RAILS_CLI} goto ${id} --quote '${q ?? `<дословная цитата лейбла ${id}>`}'`;
}

/**
 * Допустимые переходы строками «id: лейбл → команда» для отказа и вывода CLI.
 *
 * Ребро, которое сейчас закрывает страж (`edgeGuardHit`), — строкой «id: лейбл — закрыто:
 * причина (есть путь)» без команды: слабые модели копируют готовую команду не читая, и
 * переход, который `goto` всё равно отклонит, рекламировать нельзя (ревью стража
 * 2026-09-27). `allowedTransitions` рёбра не фильтрует — это список рёбер графа.
 *
 * @param {object} state
 * @param {object} graph
 * @param {object} [config] rails.yaml (quote_min, edge_guards)
 * @param {{root?: string, ticket?: string|null}} [guardCtx] корень проекта и тикет запуска
 *   для стражей рёбер; без `root` стражи не проверяются
 * @returns {string[]}
 */
export function describeTransitions(state, graph, config, { root, ticket } = {}) {
  const quoteMin = config?.quote_min ?? 25;
  const from = normalizeState(state).node;
  return allowedTransitions(state, graph).map((t) => {
    const guard = edgeGuardHit(config, from, t.id, { root, ticket });
    if (guard) return `${t.id}: ${t.label} — закрыто: ${guard.reason} (есть ${guard.path})`;
    const full = graph.node(t.id)?.label ?? t.label;
    return `${t.id}: ${rowLabel(full, t.label, quoteMin)} → ${gotoCommand(t.id, full, quoteMin)}`;
  });
}

// Лейблом строки — та же цитата, что в команде: второй, иначе обрезанный текст лейбла, модель
// брала за цитату и дописывала (инцидент 2026-09-30, см. shortLabel). Но только если цитата —
// начало лейбла: после деления по апострофу она может оказаться куском из середины, и строка
// теряет тип и этап узла («B: — the real chunk…» вместо «П1 ШАГ: 'x' — …»; ревью 2026-10-01).
function rowLabel(full, short, quoteMin) {
  const q = readyQuote(full, quoteMin);
  return q !== null && normalizeLabel(full).startsWith(normalizeLabel(q)) ? q : short;
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

// Обычный файл (симлинк — по цели). Каталог по маске стража не считается: каталог
// `QA-001.md/` в in-progress/ — не тикет (ревью стража 2026-09-27).
function isRegularFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Первый существующий обычный файл по шаблону стража ребра (§4 `edge_guards`) или `null`.
 * Шаблон — от корня проекта, `*` только в последнем сегменте (`isEdgeGuardPath`):
 * перечисляется один каталог. На Windows имя сравнивается без учёта регистра.
 * Как в shell-glob, `*` не ловит точечные файлы, если маска сама не начинается с точки:
 * `.gitkeep.md` в каталоге тикетов служебный (так его отсекает и `utils.mjs`), иначе
 * страж `in-progress/*.md` закрывал бы ребро и при пустом in-progress/.
 * Возвращает путь от корня через `/` — он попадает в текст отказа.
 */
function firstExistingGuardPath(root, pattern) {
  if (!isEdgeGuardPath(pattern)) return null;
  const segs = pattern.split(/[\\/]/).filter((s) => s.length > 0);
  const last = segs.pop();
  const dir = path.join(root, ...segs);
  const rel = (name) => [...segs, name].join('/');
  if (!last.includes('*')) return isRegularFile(path.join(dir, last)) ? rel(last) : null;
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${last.split('*').map(escape).join('.*')}$`, process.platform === 'win32' ? 'i' : '');
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const skipDotted = !last.startsWith('.');
  const hit = entries
    .filter((e) => !(skipDotted && e.name.startsWith('.')) && re.test(e.name))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .find((e) => e.isFile() || (e.isSymbolicLink() && isRegularFile(path.join(dir, e.name))));
  return hit ? rel(hit.name) : null;
}

// id тикета для `{ticket}`: одно имя без разделителей и масок, не `.`/`..` — подстановка
// не выводит путь из каталога шаблона и не расширяет маску.
const TICKET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

// Шаблон стража с подставленным тикетом; null — страж пропускается (тикета нет или он не id).
function resolveGuardPattern(pattern, ticket) {
  if (typeof pattern !== 'string') return null;
  if (!pattern.includes(TICKET_PLACEHOLDER)) return pattern;
  if (typeof ticket !== 'string' || !TICKET_ID_RE.test(ticket)) return null;
  return pattern.split(TICKET_PLACEHOLDER).join(ticket);
}

/**
 * Страж, который сейчас закрывает ребро `from → to` (§4 `edge_guards`): первый страж этого
 * ребра, у которого по `deny_if_exists` в проекте есть обычный файл, — `{reason, path}`
 * (`path` — от корня через `/`), иначе `null`. Без `root` — `null`: стражи не проверяются.
 *
 * `{ticket}` в пути — id тикета этого запуска (`ticket`; раннер передаёт его агенту в
 * WORKFLOW_RAILS_TICKET). Инцидент 2026-09-27 и ревью стража: маска `in-progress/*.md`
 * закрывала ветку «тикет не найден» из-за ЛЮБОГО тикета в in-progress/, в том числе чужого.
 * Тикета нет или он не похож на id — страж с `{ticket}` пропускается (ребро открыто): вне
 * запуска раннера рельсы тикет не знают, а ложный отказ там закрыл бы честный выход.
 *
 * @param {object} config распарсенный `rails.yaml`
 * @param {string} from
 * @param {string} to
 * @param {{root?: string, ticket?: string|null}} [ctx]
 * @returns {{reason: string, path: string}|null}
 */
export function edgeGuardHit(config, from, to, { root, ticket } = {}) {
  if (!root || !Array.isArray(config?.edge_guards)) return null;
  for (const g of config.edge_guards) {
    if (!g || g.from !== from || g.to !== to) continue;
    const pattern = resolveGuardPattern(g.deny_if_exists, ticket);
    const hit = pattern === null ? null : firstExistingGuardPath(root, pattern);
    if (hit) return { reason: g.reason || `переход ${from} → ${to} закрыт`, path: hit };
  }
  return null;
}

// Подсказки к отказам перехода. Журнал отказов PulseProxy 2026-09-25…28: у исполнителя и
// ревью 964 отказа переходов в 142 сессиях — пачки одновременных goto (все проверяются от
// одного текущего узла), прыжки через узлы, текст лейбла или `next` вместо ID, цитаты,
// набранные по памяти. Голое «нет ребра» не говорит, что именно сделано не так.
const COPY_COMMAND_HINT = ' — возьми команду перехода целиком из «Доступно»';

function noEdgeHint(graph, current, node) {
  if (!graph?.node(node)) {
    return ' — узел указывается ID из «Доступно» (например P0R2), а не текстом лейбла и не next';
  }
  if (node === current) return ' — это текущий узел';
  if (reachableFrom(graph, current).has(node)) {
    return ` — в ${node} ведёт путь через другие узлы: переходы по одному, следующий goto — после ответа на предыдущий; одновременные goto проверяются от одного текущего узла`;
  }
  return '';
}

/**
 * Переход `goto <node> --quote "<текст>"` (§5).
 *
 * Условия допустимости, первая нарушенная — отказ:
 *  1. есть ребро из текущего узла в целевой (`code: "no-edge"`);
 *  2. цитата не короче `config.quote_min`, по умолчанию 25 (`code: "short-quote"`);
 *  3. нормализованная цитата — подстрока нормализованного лейбла цели
 *     (`code: "quote-mismatch"`);
 *  4. страж ребра (`config.edge_guards`, `edgeGuardHit`): если для ребра задан
 *     `deny_if_exists` и такой обычный файл в проекте есть — отказ (`code: "edge_guard"`).
 *     Нужен `root`, без него страж не проверяется; `{ticket}` в пути — `ticket`;
 *  5. потолок цикла (`config.cycles`), если пара (текущий этап → этап цели)
 *     в нём числится, не превышен (`code: "cycle_limit"`, есть `key`).
 *
 * При отказе — инкремент `state.denials[текущий узел]`. При успехе —
 * запись в `history`, перевод `state.node`, инкремент счётчика цикла, если
 * применим. Состояние мутируется на месте; сохранение на диск (`saveState`)
 * — забота вызывающего кода (`root` здесь только для чтения путей стража ребра).
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
 * @param {{node: string, quote: string, root?: string, ticket?: string|null}} params `root` —
 *   корень проекта, от которого считаются пути `edge_guards[].deny_if_exists`; `ticket` —
 *   id тикета запуска для `{ticket}` в этих путях (WORKFLOW_RAILS_TICKET)
 * @returns {{ok: boolean, code?: string, key?: string, reason?: string, allowed: Array<{id: string, label: string}>}}
 */
export function applyGoto(state, graph, config, { node, quote, root, ticket } = {}) {
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
    return deny('no-edge', `нет ребра из ${current} в ${node}${noEdgeHint(graph, current, node)}`);
  }

  const quoteMin = config?.quote_min ?? 25;
  const normQuote = normalizeLabel(quote || '');
  // Текст цитаты попадает в отказ (и в журнал): без него по журналу не понять,
  // что именно агент цитировал не так (прогоны 2026-09-22, ×20 «цитата не найдена»).
  const shownQuote = String(quote || '').replace(/\s+/g, ' ').slice(0, 80);
  if (normQuote.length < quoteMin) {
    return deny('short-quote', `цитата «${shownQuote}» короче ${quoteMin} символов${COPY_COMMAND_HINT}`);
  }

  const targetNode = graph?.node(node);
  const targetLabel = targetNode ? normalizeLabel(targetNode.label) : '';
  if (!targetNode || !targetLabel.includes(normQuote)) {
    return deny('quote-mismatch', `цитата «${shownQuote}» не найдена в лейбле узла ${node} — ${describeQuoteMismatch(normQuote, targetLabel, targetNode?.label)}нужна дословная подстрока лейбла${COPY_COMMAND_HINT}`);
  }

  // Страж ребра: ответ на выборе или гейте агент даёт сам, рельсы его не проверяют.
  // Там, где ответ проверяется файлом проекта, ребро закрывается фактом (инцидент
  // 2026-09-27: исполнитель ответил «тикет не найден» при тикете в in-progress/ и
  // ушёл к выводу со status blocked, минуя выполнение).
  const guard = edgeGuardHit(config, current, node, { root, ticket });
  if (guard) return deny('edge_guard', `${guard.reason} (есть ${guard.path})`);

  const fromInfo = parseNodeId(current);
  const toInfo = parseNodeId(node);
  let cycleKey = null;
  if (fromInfo && toInfo && Array.isArray(config?.cycles)) {
    const cyc = config.cycles.find((c) => c.from === fromInfo.stage && c.to === toInfo.stage);
    // Запись `from == to` — потолок на ВОЗВРАТ внутри этапа (гейт → шаг), а не на
    // любой переход внутри этапа: первый прогон коуча 2026-09-22 упёрся в «cycle_limit»
    // на P1R3 после трёх штатных шагов вперёд. Что считается возвратом —
    // isReturnWithinStage.
    const sameStage = fromInfo.stage === toInfo.stage;
    const isBackward = !sameStage || isReturnWithinStage(graph, fromInfo.stage, current, node);
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
  return listSessionIds(root)[0] ?? null;
}

/**
 * Сессии проекта по файлам состояния, от самой свежей к старым (mtime).
 * Инцидент 2026-09-23: CLI без `--session` брал самую свежую сессию проекта, и команда
 * из одной сессии писала отказ в журнал ЧУЖОЙ (две сессии коуча в одном проекте).
 * Резолв по одной сессии оставлен, при двух и более CLI обязан отказать.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function listSessionIds(root) {
  let dir;
  try {
    dir = stateDir(root);
  } catch {
    return [];
  }
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const found = [];
  for (const name of entries) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    let stat;
    try {
      stat = fs.statSync(path.join(dir, name));
    } catch {
      continue;
    }
    found.push({ sessionId: name.slice(0, -'.json'.length), mtimeMs: stat.mtimeMs });
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs || a.sessionId.localeCompare(b.sessionId));
  return found.map((x) => x.sessionId);
}
