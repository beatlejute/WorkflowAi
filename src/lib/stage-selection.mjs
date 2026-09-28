/**
 * Выбор модели стадии (README, «Выбор модели стадии»; workflow-ai 1.17.0): стадия с
 * полем `selection` выбирает исполнителя не курсором попытки, а по силе моделей и
 * сложности тикета. Правила стейкхолдера:
 *  1. самая СЛАБАЯ модель, которой ещё ДОСТАТОЧНО для тикета;
 *  2. селектор видит только кандидатов, прошедших все фильтры (способности, здоровье
 *     и шлагбаум пула, запреты, пробованные в попытке, max_per_attempt пула, нижняя
 *     граница); отсеянных не видит и не запускает ни один порядок обхода;
 *  3. никаких данных моделей в коде и конфиге: ни уровней агентов, ни соответствия
 *     агент → оценка, ни порогов — уровни считаются по оценкам из данных;
 *  4. приоритет у бесплатных; бесплатность — по данным поставщика (флаг kilo), затем
 *     по каталогу OpenRouter; неизвестно — платная.
 *
 * Здесь — чистая логика (уровни, нижняя граница, порядок обхода, промпт селектора,
 * разбор ответа) и хранилище фактов процесса: команда `selection.scores` запускается
 * один раз на процесс раннера, после раскрытия пулов (PipelineRunner.run), и её ответ
 * держится в памяти (FACTS_STATE), как состояние пулов в model-pools.mjs. Вызов
 * селектора, шлагбаумы и запуск агентов — StageExecutor.executeWithFallback.
 *
 * Уровни — относительные: полосы равной ширины между самой слабой и самой сильной
 * оценкой выживших кандидатов попытки, N = числу текстов `selection.levels`
 * (рубрика сложности тикета, от слабого к сильному). Без оценки — уровень 1 (низ,
 * наверх не поднимается). Полосы замораживаются на попытку: требуемый уровень,
 * нижняя граница и эскалация говорят на одной шкале.
 */

import fs from 'node:fs';
import { parseFrontmatter } from './utils.mjs';
import { DOD_HEADING } from './check-runner.mjs';
import { requestedModel } from './agent-runs.mjs';
import { railsHost } from './rails-run-state.mjs';
import { isModelPool, poolMembers, runPoolCommand, selectorTicket, POOL_COMMAND_TIMEOUT_MS } from './model-pools.mjs';

/** Градации запусков исполнителя, поднимающие нижнюю границу тикета (решение 4). */
export const FLOOR_GRADES = Object.freeze(['refused', 'empty', 'artifacts_failed', 'review_failed']);

/** Пределы полей тикета в промпте селектора (цена вызова растёт с объёмом промпта). */
export const DESCRIPTION_LIMIT = 2000;
export const NOTES_LIMIT = 1000;

// Сколько строк stderr команды фактов попадает в лог.
const STDERR_LOG_LINES = 20;

// Факты процесса: config.pipeline → Map<id стадии, {reason, as_of, citation, facts:
// Map<id\0хост, факт>, candidates: string[]}>. Ключ — объект pipeline, как у POOL_STATE.
const FACTS_STATE = new WeakMap();

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

// Значение для строки лога в кавычках: без кавычек и переводов строк, нет строки — `-`.
function logText(value) {
  return typeof value === 'string' ? value.replace(/["\r\n]+/g, ' ') : '-';
}

/**
 * Стадия под выбором модели для типа тикета: у стадии есть `selection`, а запись типа
 * `agents_by_type.<тип>` не говорит `selection: false`.
 */
export function isGoverned(stage, taskType) {
  if (!isPlainObject(stage?.selection)) return false;
  const byType = taskType && isPlainObject(stage.agents_by_type) ? stage.agents_by_type[taskType] : null;
  return !(isPlainObject(byType) && byType.selection === false);
}

/**
 * Списки агентов стадии под выбором: `stage.agents` (без него — `default_agents`) и
 * списки `agents_by_type`, не отказавшиеся от выбора.
 */
export function governedLists(pipeline, stage) {
  if (!isPlainObject(stage?.selection)) return [];
  const lists = [];
  if (Array.isArray(stage.agents)) lists.push(stage.agents);
  else if (Array.isArray(pipeline?.default_agents)) lists.push(pipeline.default_agents);
  for (const entry of Object.values(isPlainObject(stage.agents_by_type) ? stage.agents_by_type : {})) {
    if (isPlainObject(entry) && entry.selection !== false && Array.isArray(entry.agents)) lists.push(entry.agents);
  }
  return lists;
}

/**
 * Кандидаты мест списка: место-пул заменяется своими участниками (`membersOf(id)` —
 * участники, прошедшие фильтры, в порядке маски), пул в списке дважды даёт участников
 * один раз, на первой позиции.
 * @returns {Array<{id: string, pool: string|null}>} в порядке списка
 */
export function flattenSurvivors(places, { isPool, membersOf }) {
  const out = [];
  const seen = new Set();
  for (const place of places) {
    const ids = isPool(place) ? membersOf(place).map((id) => ({ id, pool: place })) : [{ id: place, pool: null }];
    for (const entry of ids) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      out.push(entry);
    }
  }
  return out;
}

/** Полосы уровней по оценкам выживших: `{min, max, N, w}`; оценок нет — min/max null. */
export function computeBands(scores, N) {
  const numbers = scores.filter(isNumber);
  if (numbers.length === 0) return { min: null, max: null, N, w: 0 };
  const min = Math.min(...numbers);
  const max = Math.max(...numbers);
  return { min, max, N, w: (max - min) / N };
}

/**
 * Уровень оценки в полосах: без оценки — 1 (низ); ниже min — 0 (только для нижней
 * границы: такая модель слабее всех выживших); полосы нулевой ширины — N; иначе
 * floor((s − min) / w) + 1, не больше N.
 */
export function levelOf(bands, score) {
  if (!isNumber(score) || bands.min === null) return 1;
  if (score < bands.min) return 0;
  if (bands.w === 0) return bands.N;
  return Math.min(bands.N, Math.floor((score - bands.min) / bands.w) + 1);
}

/**
 * Нижняя граница тикета: наибольший уровень (в замороженных полосах) среди его
 * запусков исполнителя с градациями FLOOR_GRADES; сбой после работы
 * (`crashed_after_work`) не считается — работу оборвал сбой, а не бессилие модели.
 * `scoreOf(run)` — `{ known: true, score }` или `{ known: false }` (запуск пропускается).
 * @param {Array<object>} gradedRuns — gradeRuns журнала (reset уже учтён)
 * @returns {{floor: number, history: Array<{level: number, outcome: string}>, executorRuns: number, skipped: string[]}}
 */
export function ticketFloor(gradedRuns, ticket, scoreOf, bands) {
  let floor = 0;
  const history = [];
  const skipped = [];
  let executorRuns = 0;
  for (const run of gradedRuns) {
    if (!ticket || run.ticket !== ticket) continue;
    executorRuns += 1;
    if (!FLOOR_GRADES.includes(run.grade) || run.crashed_after_work) continue;
    const known = scoreOf(run);
    if (!known.known) {
      skipped.push(run.agent ?? null);
      continue;
    }
    const level = levelOf(bands, known.score);
    history.push({ level, outcome: run.grade });
    floor = Math.max(floor, level);
  }
  return { floor, history, executorRuns, skipped };
}

/** Граница не выше `maxLevel − 1`: самый сильный уровень выживших остаётся всегда (решение 6). */
export function capFloor(floor, maxLevel) {
  return Math.max(0, Math.min(floor, maxLevel - 1));
}

/**
 * Порядок обхода выживших над нижней границей (R' = max(R, floor + 1)):
 *   1. бесплатные с уровнем ≥ R' — по возрастанию уровня;
 *   2. платные с уровнем ≥ R' — по возрастанию уровня;
 *   3. хвост floor < уровень < R' — по убыванию уровня, в уровне бесплатные раньше.
 * Внутри уровня — не запускавшиеся на тикете раньше, затем место в ранжире селектора,
 * затем порядок списка. Выход — перестановка выживших с уровнем > floor: отсеянного id
 * в нём нет (правило 2).
 * @param {{survivors: string[], levelOf: (id) => number, freeOf: (id) => boolean, R: number|null,
 *   floor: number, ranking?: string[], notRun?: Set<string>, listIndex?: Map<string, number>}} input
 */
export function walkOrder({ survivors, levelOf: level, freeOf, R, floor, ranking = [], notRun = null, listIndex = null }) {
  const lowest = floor + 1;
  const required = Math.max(Number.isInteger(R) ? R : lowest, lowest);
  const rank = new Map(ranking.map((id, i) => [id, i]));
  const position = (id) => listIndex?.get(id) ?? survivors.indexOf(id);
  const key = (id) => {
    const l = level(id);
    const free = freeOf(id) === true;
    const group = l >= required ? (free ? 0 : 1) : 2;
    return [
      group,
      group === 2 ? -l : l,
      group === 2 ? Number(!free) : 0,
      notRun && !notRun.has(id) ? 1 : 0,
      rank.has(id) ? rank.get(id) : Infinity,
      position(id),
    ];
  };
  const keys = new Map(survivors.map((id) => [id, key(id)]));
  const compare = (a, b) => {
    const ka = keys.get(a);
    const kb = keys.get(b);
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    }
    return 0;
  };
  return survivors.filter((id) => level(id) > floor).sort(compare);
}

/** Требуемый уровень ответа селектора: целое 1..N, иначе null (`unknown_level`). */
export function parseRequiredLevel(value, N) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  const level = Number(text);
  return level >= 1 && level <= N ? level : null;
}

// Текст до заголовка DoD — описание и детали задачи; комментарии шаблона выброшены.
function descriptionOf(body) {
  const heading = DOD_HEADING.exec(body);
  const text = (heading ? body.slice(0, heading.index) : body).replace(/<!--[\s\S]*?-->/g, '').trim();
  return text;
}

function cut(text, limit) {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

const stringList = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === 'string') : []);

/**
 * Тикет для промпта селектора модели стадии. Заголовок и DoD — selectorTicket
 * (model-pools.mjs); из frontmatter — `priority`, `complexity` (по умолчанию `medium`,
 * как tickets.mjs), `required_capabilities`, `tags`, заметки и число файлов и ссылок
 * `context` (шаблон тикета держит их во frontmatter, а не в теле); описание — текст тела
 * до секции DoD (разделы «Описание» и «Детали задачи» шаблона). Нет файла — пустые поля.
 */
export function selectionTicket(ticketPath, { id, type, executorRuns = 0, floorLevel = 0, history = [] }) {
  const base = selectorTicket(ticketPath, { id, type });
  let content = '';
  try {
    if (ticketPath) content = fs.readFileSync(ticketPath, 'utf8');
  } catch {
    // нет файла — пустые поля
  }
  let frontmatter = {};
  let body = content;
  try {
    ({ frontmatter, body } = parseFrontmatter(content));
  } catch {
    // битый frontmatter — поля frontmatter пустые, описание по всему тексту
  }
  const fm = isPlainObject(frontmatter) ? frontmatter : {};
  const context = isPlainObject(fm.context) ? fm.context : {};
  return {
    id,
    type,
    title: base.title,
    priority: fm.priority ?? null,
    complexity: typeof fm.complexity === 'string' && fm.complexity ? fm.complexity : 'medium',
    required_capabilities: stringList(fm.required_capabilities),
    tags: stringList(fm.tags),
    description: cut(descriptionOf(body), DESCRIPTION_LIMIT),
    dod: base.dod,
    notes: cut(typeof context.notes === 'string' ? context.notes.trim() : '', NOTES_LIMIT),
    files: Array.isArray(context.files) ? context.files.length : 0,
    references: Array.isArray(context.references) ? context.references.length : 0,
    executor_runs: executorRuns,
    floor_level: floorLevel,
    history,
  };
}

/**
 * Промпт селектора модели стадии: инструкция и JSON-блок (README, «Контракт
 * селектора»). В блоке — только выжившие кандидаты: id, вид, бесплатность, уровень и
 * оценки (`null` без оценки). Цен, причин отсева и долей успеха журнала нет.
 */
export function buildSelectionPrompt({ stage, ticket, levels, candidates, citation = null }) {
  const data = { mode: 'models', stage, ticket, levels, candidates, scores_citation: citation };
  return [
    'Выбери для тикета самый низкий достаточный уровень кандидатов (1 — самые слабые) и упорядочи кандидатов — '
      + 'от самого подходящего. Ответь блоком `---RESULT---` с полями `required_level: <1..N>` и '
      + '`ranking: <id>, <id>, …` из id candidates.',
    '',
    '```json',
    JSON.stringify(data, null, 2),
    '```',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Факты процесса
// ---------------------------------------------------------------------------

/** Ключ факта: id модели, как её вызывает агент, и хост рельс. */
export function factKey(id, host) {
  return `${id}\u0000${host ?? ''}`;
}

/**
 * Разбор stdout команды фактов: один JSON `{as_of, citation, models: [...]}`.
 * @returns {{facts: Map<string, object>, as_of: string|null, citation: string|null} | {reason: string}}
 */
export function parseFactsOutput(stdout) {
  let data = null;
  try {
    data = JSON.parse(String(stdout).trim());
  } catch {
    // data остаётся null — причина ниже
  }
  if (!isPlainObject(data) || !Array.isArray(data.models)) return { reason: 'output is not JSON with "models" array' };
  const facts = new Map();
  for (const entry of data.models) {
    if (!isPlainObject(entry) || typeof entry.id !== 'string' || !entry.id) continue;
    const host = typeof entry.host === 'string' ? entry.host : null;
    const key = factKey(entry.id, host);
    if (facts.has(key)) continue;
    facts.set(key, {
      id: entry.id,
      host,
      resolved: typeof entry.resolved === 'string' ? entry.resolved : null,
      intelligence: isNumber(entry.intelligence) ? entry.intelligence : null,
      coding: isNumber(entry.coding) ? entry.coding : null,
      agentic: isNumber(entry.agentic) ? entry.agentic : null,
      free: entry.free === true,
      free_source: typeof entry.free_source === 'string' ? entry.free_source : 'unknown',
    });
  }
  return {
    facts,
    as_of: typeof data.as_of === 'string' ? data.as_of : null,
    citation: typeof data.citation === 'string' ? data.citation : null,
  };
}

/** Кандидаты стадии для фактов: агенты governedLists, пулы — все участники. */
export function stageCandidates(pipeline, stage) {
  const agents = pipeline?.agents || {};
  const out = [];
  const seen = new Set();
  for (const list of governedLists(pipeline, stage)) {
    for (const id of list) {
      const ids = isModelPool(agents[id]) ? poolMembers(agents, id) : [id];
      for (const agentId of ids) {
        if (seen.has(agentId) || !agents[agentId]) continue;
        seen.add(agentId);
        out.push(agentId);
      }
    }
  }
  return out;
}

/** Строка входа команды фактов для агента: `{id, host}` или null (у агента нет id модели). */
export function factLine(agent) {
  const id = requestedModel(agent);
  return id ? { id, host: railsHost(agent) } : null;
}

function logStderr(stderr, logger, stageId) {
  const text = String(stderr || '').trim();
  if (!text) return;
  for (const line of text.split(/\r?\n/).slice(-STDERR_LOG_LINES)) logger?.warn(`selection.scores stderr: ${line}`, stageId);
}

/**
 * Факты стадий под выбором: команда `selection.scores` — на stdin строка `{id, host}`
 * на каждую модель кандидатов, на stdout — факты (scripts/model-scores.js, режим
 * фактов). Равные команды нескольких стадий — один запуск на объединение их моделей.
 * Запуск — по правилам команд пула (runPoolCommand): корень проекта, buildAgentEnv,
 * таймаут 60 с, остановка пайплайна. Стадии, уже загруженные в этом процессе, не
 * перезапускаются. Сбой — строка `FACTS … scored=0/<n> free=0 (<причина>)` и WARN:
 * кандидаты без оценок, бесплатны только id с `:free` на конце; без оценок раннер ведёт
 * попытку прежним курсором по местам (StageExecutor._resolveGoverned).
 */
export async function loadStageFacts(pipeline, {
  projectRoot, logger = null, stageId = null, timeoutMs = POOL_COMMAND_TIMEOUT_MS, signal = null, stages: only = null,
} = {}) {
  // `stages` — свои стадии вместо pipeline.stages: исполнитель стадии, которой нет в
  // конфиге (executeWithFallback со stageOverride), грузит факты только её.
  const stages = isPlainObject(only) ? only : (isPlainObject(pipeline?.stages) ? pipeline.stages : {});
  let state = FACTS_STATE.get(pipeline);
  if (!state) {
    state = new Map();
    FACTS_STATE.set(pipeline, state);
  }
  const agents = pipeline?.agents || {};
  const groups = new Map();
  for (const [id, stage] of Object.entries(stages)) {
    if (!isPlainObject(stage?.selection) || state.has(id)) continue;
    const argv = stage.selection.scores;
    const key = JSON.stringify(argv);
    if (!groups.has(key)) groups.set(key, { argv, stages: [] });
    groups.get(key).stages.push({ id, candidates: stageCandidates(pipeline, stage) });
  }
  for (const { argv, stages: members } of groups.values()) {
    const lines = new Map();
    for (const { candidates } of members) {
      for (const agentId of candidates) {
        const line = factLine(agents[agentId]);
        if (line) lines.set(factKey(line.id, line.host), line);
      }
    }
    let parsed;
    if (!Array.isArray(argv) || argv.length === 0) {
      parsed = { reason: 'no selection.scores command' };
    } else if (lines.size === 0) {
      // Ни у одного кандидата нет id модели (CLI-агент без `-m`/`--model`): спрашивать
      // нечего. Пустой stdin model-scores.js принял бы за прежний режим пула, и ответ без
      // `models` выглядел бы сбоем команды (ревью 2026-09-28, третий раунд).
      parsed = { facts: new Map(), as_of: null, citation: null };
    } else {
      const input = [...lines.values()].map((line) => JSON.stringify(line)).join('\n');
      const run = await runPoolCommand(argv, { cwd: projectRoot, timeoutMs, input: `${input}\n`, logger, stageId, signal });
      logStderr(run.stderr, logger, stageId);
      parsed = run.ok ? parseFactsOutput(run.stdout) : { reason: run.reason };
    }
    for (const { id, candidates } of members) {
      const entry = parsed.reason
        ? { reason: parsed.reason, as_of: null, citation: null, facts: new Map(), candidates }
        : { reason: null, as_of: parsed.as_of, citation: parsed.citation, facts: parsed.facts, candidates };
      state.set(id, entry);
      logFacts(pipeline, id, entry, logger, stageId);
    }
  }
  return state;
}

function logFacts(pipeline, stage, entry, logger, stageId) {
  if (!logger) return;
  const total = entry.candidates.length;
  if (entry.reason) {
    logger.info(`FACTS stage="${stage}" scored=0/${total} free=0 (${entry.reason})`, stageId);
    logger.warn(`stage "${stage}": selection.scores failed (${entry.reason}) — every candidate unscored and paid unless its id ends with :free, attempt cursor over places`, stageId);
    return;
  }
  let scored = 0;
  let free = 0;
  const items = entry.candidates.map((agentId) => {
    const fact = factsOf(pipeline, stage, agentId);
    if (fact?.intelligence !== null && fact?.intelligence !== undefined) scored += 1;
    if (fact?.free) free += 1;
    const score = isNumber(fact?.intelligence) ? String(fact.intelligence) : 'n/a';
    const how = `${fact?.free ? 'free' : 'paid'}(${fact?.free_source ?? 'unknown'})`;
    return `${agentId}=${score}/${how}${fact?.resolved ? `~${fact.resolved}` : ''}`;
  });
  logger.info(
    `FACTS stage="${stage}" candidates=${total} scored=${scored} free=${free} as_of="${logText(entry.as_of)}" `
      + `citation="${logText(entry.citation)}" [${items.join(', ')}]`,
    stageId,
  );
}

/** Загружены ли факты стадии в этом процессе. */
export function hasStageFacts(pipeline, stageId) {
  return Boolean(FACTS_STATE.get(pipeline)?.has(stageId));
}

/** Состояние фактов стадии: `{reason, as_of, citation}` или null. */
export function stageFactsInfo(pipeline, stageId) {
  const entry = FACTS_STATE.get(pipeline)?.get(stageId);
  return entry ? { reason: entry.reason, as_of: entry.as_of, citation: entry.citation } : null;
}

/**
 * Факт агента стадии: `{intelligence, coding, agentic, free, free_source, resolved}` или
 * null — фактов нет (сбой команды, у агента нет id модели, агента нет в конфиге):
 * такой кандидат без оценки; бесплатность раннер берёт тогда по `:free` на конце id.
 */
export function factsOf(pipeline, stageId, agentId) {
  const entry = FACTS_STATE.get(pipeline)?.get(stageId);
  const agent = pipeline?.agents?.[agentId];
  if (!entry || !agent) return null;
  const line = factLine(agent);
  return line ? entry.facts.get(factKey(line.id, line.host)) ?? null : null;
}
