/**
 * Пулы моделей по маске (PLAN-004): раскрытие пула в участников.
 *
 * Пул — запись агента в `pipeline.agents` с полем `models` и `{model}` в `args`.
 * Команда `models.list` печатает модели, по одной на строку; раннер знает только этот
 * интерфейс stdout, форматов kilo он не разбирает:
 *   - строка, начинающаяся с `{`, — JSON `{"id": "<provider/model>", "capabilities":
 *     ["multimodal"], "note": "<текст>"}`; обязателен только строковый `id`, `note`
 *     идёт только в строку `POOL`;
 *   - любая другая непустая строка — id без метаданных (поэтому командой списка может
 *     быть и `kilo models`);
 *   - испорченная строка (JSON не разбирается или нет строкового `id`) — WARN, пропуск;
 *     повтор id — первое вхождение.
 * Участник — модель, чей полный id совпал хотя бы с одним выражением `models.match`
 * (`new RegExp` без флагов). Порядок участников — по индексу первого совпавшего
 * выражения, при равенстве — порядок вывода команды. Id участника, не подходящий под
 * MEMBER_ID_RE, пропускается с WARN: на Windows аргументы агента идут через cmd.exe.
 *
 * Участник регистрируется в общем `pipeline.agents` под id `<пул>@<полный id>` —
 * копией записи пула с новыми массивами: `{model}` в `args` заменён полным id, поля
 * `models` нет, `pool` — id пула, способности — объединение способностей пула и строки
 * списка. `args` двух пулов может быть одним массивом (якорь YAML: js-yaml отдаёт
 * псевдониму тот же объект), поэтому массив пула на месте не правится. Запись пула
 * остаётся — это место в списке стадии, само оно не запускается (выбор участника —
 * StageExecutor.resolveAgent).
 *
 * Раскрытие — один раз на процесс раннера, до первой стадии (PipelineRunner.run):
 * resolveAgent синхронный, а StageExecutor создаётся на каждую стадию. Одинаковая
 * команда списка (равные массивы) запускается один раз (П7): у двух пулов обычно один
 * адаптер, а `kilo models` идёт 8–18 с. Сбой команды (выход ≠ 0, таймаут, не
 * запустилась, снята остановкой пайплайна) или пустое совпадение — пул без участников:
 * его место в списке не выбирается, стадия не падает. Строка `POOL` на каждый пул —
 * единственная защита от платной модели, случайно попавшей в маску (решение 3).
 *
 * Оценки (П8): у пула с `models.selector` и `models.scores` при раскрытии запускается
 * команда оценок — на stdin полные id участников, на stdout один JSON
 * `{"as_of", "citation", "scores": {"<полный id>": {...}}}`. Кэш и формат источника живут
 * в команде, раннер держит ответ в памяти процесса (POOL_STATE) только для промпта
 * селектора: оценки пул не режут и не переупорядочивают (решение 3). Одинаковая команда
 * оценок у нескольких пулов — один запуск на id всех их участников. Сбой — строка
 * `SCORES … scored=0/<N> (<причина>)`, кандидаты без оценок, селектор всё равно вызывается.
 *
 * Селектор (П1, П15) и шлагбаум (П14) вызывает StageExecutor.executeWithFallback: здесь —
 * данные промпта селектора (poolSelectorData, selectorTicket, buildSelectorPrompt), разбор
 * ранжира (selectorRanking) и их пределы. На стадии с выбором модели (`selection`,
 * lib/stage-selection.mjs) пул раскрывается в участников-кандидатов стадии, и селектор
 * пула там не вызывается: участников ранжирует селектор стадии.
 */

import fs from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import { buildAgentEnv } from './agent-env.mjs';
import { parseFrontmatter } from './utils.mjs';
import { DOD_HEADING } from './check-runner.mjs';

/** Место полного id участника в `args` пула. */
export const MODEL_PLACEHOLDER = '{model}';

/** Сколько участников пула пробовать за одну попытку тикета без `models.max_per_attempt` (В10). */
export const DEFAULT_MAX_PER_ATTEMPT = 3;

/** Таймаут команды пула (П6: замеры `kilo models` — 7,7–18,4 с, запас ×3). */
export const POOL_COMMAND_TIMEOUT_MS = 60_000;

/** Допустимый полный id участника: все id `kilo models` 7.7.9 под него подходят. */
export const MEMBER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/~-]*$/;

/** Таймаут вызова агента-селектора (П4: обёртка получает `--timeout 15`, 3 × 15 + 6 = 51 с < 60 с). */
export const SELECTOR_TIMEOUT_MS = 60_000;

/** Таймаут команды-шлагбаума (П14: скрипт делает один GET с `--timeout 10`). */
export const GATE_TIMEOUT_MS = 15_000;

/** Не больше кандидатов в вызове селектора (П3: MAX_LEVELS слоя оценки — обёртка отображает кандидатов на варианты). */
export const SELECTOR_MAX_CANDIDATES = 10;

/** Предел текста DoD в промпте селектора (П5: цена вызова растёт с объёмом промпта). */
export const SELECTOR_DOD_LIMIT = 4000;

// Сколько строк stderr команды пула попадает в лог.
const STDERR_LOG_LINES = 20;

// Сведения о пулах процесса для селектора: config.pipeline → Map<id пула, {members:
// Map<id участника, {id, note}>, scores: object|null, citation: string|null}>. Ключ —
// объект pipeline: его же получают все StageExecutor процесса (this.pipeline).
const POOL_STATE = new WeakMap();

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Хвост stderr команды пула — в лог WARN: без него сбой kilo или сети не виден.
function logCommandStderr(label, stderr, logger, stageId) {
  const text = String(stderr || '').trim();
  if (!text) return;
  for (const line of text.split(/\r?\n/).slice(-STDERR_LOG_LINES)) {
    logger?.warn(`${label} stderr: ${line}`, stageId);
  }
}

// Значение для строки лога в кавычках: без кавычек и переводов строк, нет строки — `-`.
function logText(value) {
  return typeof value === 'string' ? value.replace(/["\r\n]+/g, ' ') : '-';
}

/** Запись агента — пул моделей (поле `models`). */
export function isModelPool(agent) {
  return Boolean(agent && typeof agent === 'object' && agent.models && typeof agent.models === 'object');
}

/** Участников пула за одну попытку тикета: `models.max_per_attempt`, иначе 3. */
export function maxPerAttempt(pool) {
  const value = pool?.models?.max_per_attempt;
  return Number.isInteger(value) && value >= 1 ? value : DEFAULT_MAX_PER_ATTEMPT;
}

/**
 * Id агента в файле правил health: у участника пула — id пула (правила участников в
 * файле не описать: их состав известен только после раскрытия), иначе — свой id.
 * Пометка нездоровья и проверка здоровья — всё равно по id участника (маршрут).
 */
export function healthRulesId(agent, agentId) {
  return agent?.pool ?? agentId;
}

/** Id участников пула в порядке маски — порядке регистрации в `agents`. */
export function poolMembers(agents, poolId) {
  return Object.keys(agents || {}).filter((id) => agents[id]?.pool === poolId);
}

/** `60000` → `60s`, `700` → `700ms` — для причины `timeout …` в строке POOL. */
export function formatTimeout(ms) {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}

/**
 * Разбор stdout команды списка по интерфейсу из шапки модуля.
 * @returns {{models: Array<{id: string, capabilities: string[], note: string}>, warnings: string[]}}
 */
export function parseModelList(stdout) {
  const models = [];
  const warnings = [];
  const seen = new Set();
  for (const raw of String(stdout).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let entry;
    if (line.startsWith('{')) {
      let obj = null;
      try {
        obj = JSON.parse(line);
      } catch {
        // obj остаётся null — WARN ниже
      }
      if (!obj || typeof obj.id !== 'string' || !obj.id) {
        warnings.push(`models.list: line skipped (not JSON with string "id"): ${line}`);
        continue;
      }
      entry = {
        id: obj.id,
        capabilities: Array.isArray(obj.capabilities) ? obj.capabilities.filter((c) => typeof c === 'string') : [],
        note: typeof obj.note === 'string' ? obj.note : '',
      };
    } else {
      entry = { id: line, capabilities: [], note: '' };
    }
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    models.push(entry);
  }
  return { models, warnings };
}

/**
 * Участники пула: модели, совпавшие с `match`, по индексу первого совпавшего
 * выражения, при равенстве — в порядке вывода (сортировка устойчивая).
 */
export function matchPoolModels(models, match) {
  const expressions = match.map((source) => new RegExp(source));
  return models
    .map((model, index) => ({ model, index, rank: expressions.findIndex((re) => re.test(model.id)) }))
    .filter((item) => item.rank !== -1)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((item) => item.model);
}

/** Запись участника — копия записи пула с новыми массивами (см. шапку модуля). */
export function buildMemberAgent(poolId, pool, model) {
  const { models: _models, ...rest } = pool;
  const member = structuredClone(rest);
  member.args = (Array.isArray(pool.args) ? pool.args : [])
    .map((arg) => (typeof arg === 'string' ? arg.split(MODEL_PLACEHOLDER).join(model.id) : arg));
  const poolCaps = Array.isArray(pool.capabilities) ? pool.capabilities : [];
  member.capabilities = [...new Set([...poolCaps, ...model.capabilities])];
  member.pool = poolId;
  return member;
}

/**
 * Запуск команды пула (`models.list`, команды оценок и шлагбаума) по правилам
 * агентов (StageExecutor._callAgentOnce): рабочий каталог — корень проекта, окружение —
 * buildAgentEnv (прокси из agent.env), shell на Windows — кроме команды `node`
 * (иначе `kilo` не найдётся через `kilo.cmd`); по таймауту — снятие дерева процессов.
 * `signal` — остановка пайплайна (SIGINT/SIGTERM раннера): дерево снимается так же, как
 * по таймауту; при уже прерванном signal команда не запускается.
 * @returns {Promise<{ok: true, stdout: string, stderr: string} | {ok: false, reason: string, stdout: string, stderr: string}>}
 *   reason — `exit <код>`, `timeout <срок>`, `aborted` или `spawn error <текст>`
 */
export function runPoolCommand(argv, { cwd, timeoutMs = POOL_COMMAND_TIMEOUT_MS, input = null, logger = null, stageId = null, signal = null } = {}) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, reason: 'aborted', stdout: '', stderr: '' });
      return;
    }
    const [command, ...args] = argv;
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    let onAbort = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
      resolve({ stdout, stderr, ...result });
    };

    let child;
    try {
      child = spawn(command, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32' && command !== 'node',
        windowsHide: true,
        env: buildAgentEnv(process.env, null, { logger, stageId, cwd }),
      });
    } catch (err) {
      resolve({ ok: false, reason: `spawn error ${err.message}`, stdout, stderr });
      return;
    }

    const killTree = () => {
      if (process.platform === 'win32' && child.pid) {
        try { execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'pipe', windowsHide: true }); } catch {}
      } else {
        try { child.kill('SIGTERM'); } catch {}
      }
    };
    timer = setTimeout(() => {
      killTree();
      finish({ ok: false, reason: `timeout ${formatTimeout(timeoutMs)}` });
    }, timeoutMs);
    if (signal) {
      onAbort = () => {
        killTree();
        finish({ ok: false, reason: 'aborted' });
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    // Команда, вышедшая до чтения stdin, даёт EPIPE на записи — код выхода придёт в 'close'.
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? undefined);
    // После 'error' приходит и 'close' (код -4058 на Windows) — берётся первое событие.
    child.on('error', (err) => finish({ ok: false, reason: `spawn error ${err.message}` }));
    child.on('close', (code, signal) => {
      finish(code === 0 ? { ok: true } : { ok: false, reason: `exit ${code ?? signal}` });
    });
  });
}

/**
 * Раскрывает все пулы `pipeline.agents` и регистрирует участников там же; у пулов с
 * селектором и командой оценок — запускает команду оценок (шапка модуля). Id участника,
 * уже занятый агентом конфига (не участником этого пула), не перезаписывается: WARN, модель
 * пропускается. validateConfig такой id отклоняет; здесь — страховка для раннера,
 * созданного без проверки конфига.
 * @param {object} pipeline — `config.pipeline` (общий для всех StageExecutor процесса)
 * @param {{projectRoot: string, logger?: object, stageId?: string, timeoutMs?: number, signal?: AbortSignal}} options —
 *   timeoutMs — таймаут команд списка и оценок; signal — остановка пайплайна: команды
 *   снимаются, у пулов без участников причина `aborted`
 * @returns {Promise<Map<string, string[]>>} id пула → id участников в порядке маски
 */
export async function expandModelPools(pipeline, { projectRoot, logger = null, stageId = null, timeoutMs = POOL_COMMAND_TIMEOUT_MS, signal = null } = {}) {
  const agents = pipeline?.agents || {};
  const pools = Object.keys(agents).filter((id) => isModelPool(agents[id]));
  const result = new Map();
  if (pools.length === 0) return result;
  const state = new Map();
  POOL_STATE.set(pipeline, state);

  // Команда → обещание её разобранного вывода: равные массивы запускаются один раз,
  // WARN о строках вывода — тоже один раз на команду.
  const listed = new Map();
  const listOnce = (list) => {
    const key = JSON.stringify(list);
    if (!listed.has(key)) {
      listed.set(key, runPoolCommand(list, { cwd: projectRoot, timeoutMs, logger, stageId, signal }).then((run) => {
        logCommandStderr('models.list', run.stderr, logger, stageId);
        if (!run.ok) return { reason: run.reason };
        const parsed = parseModelList(run.stdout);
        for (const warning of parsed.warnings) logger?.warn(warning, stageId);
        return { models: parsed.models };
      }));
    }
    return listed.get(key);
  };

  for (const poolId of pools) {
    const pool = agents[poolId];
    const listing = await listOnce(pool.models.list);
    if (listing.reason) {
      logger?.info(`POOL agent="${poolId}" members=0 (${listing.reason})`, stageId);
      result.set(poolId, []);
      continue;
    }
    const members = [];
    for (const model of matchPoolModels(listing.models, pool.models.match)) {
      if (!MEMBER_ID_RE.test(model.id)) {
        logger?.warn(`pool "${poolId}": model id ${JSON.stringify(model.id)} has unsupported characters — skipped`, stageId);
        continue;
      }
      const memberId = `${poolId}@${model.id}`;
      if (Object.hasOwn(agents, memberId) && agents[memberId]?.pool !== poolId) {
        logger?.warn(`pool "${poolId}": agent id ${JSON.stringify(memberId)} is already a configured agent — model skipped`, stageId);
        continue;
      }
      members.push(model);
    }
    if (members.length === 0) {
      logger?.info(`POOL agent="${poolId}" members=0 (no match)`, stageId);
      result.set(poolId, []);
      continue;
    }
    const ids = [];
    const info = { members: new Map(), scores: null, citation: null };
    for (const model of members) {
      const id = `${poolId}@${model.id}`;
      agents[id] = buildMemberAgent(poolId, pool, model);
      info.members.set(id, { id: model.id, note: model.note });
      ids.push(id);
    }
    state.set(poolId, info);
    result.set(poolId, ids);
    const listText = members.map((m) => (m.note ? `${m.id} ${m.note}` : m.id)).join(', ');
    logger?.info(`POOL agent="${poolId}" members=${members.length} [${listText}]`, stageId);
  }

  await scorePools(pools.filter((id) => state.has(id)), agents, state, { projectRoot, logger, stageId, timeoutMs, signal });
  return result;
}

/**
 * Разбор stdout команды оценок: один JSON-объект с объектом `scores`.
 * @returns {{scores: object, as_of: string|null, citation: string|null} | {reason: string}}
 */
export function parseScoresOutput(stdout) {
  let data = null;
  try {
    data = JSON.parse(String(stdout).trim());
  } catch {
    // data остаётся null — причина ниже
  }
  if (!isPlainObject(data) || !isPlainObject(data.scores)) return { reason: 'output is not JSON with "scores" object' };
  return {
    scores: data.scores,
    as_of: typeof data.as_of === 'string' ? data.as_of : null,
    citation: typeof data.citation === 'string' ? data.citation : null,
  };
}

// Оценки участников пулов с селектором (шапка модуля): равные команды `models.scores` —
// один запуск на id участников всех их пулов; строка SCORES на каждый пул.
async function scorePools(poolIds, agents, state, { projectRoot, logger, stageId, timeoutMs, signal }) {
  const groups = new Map();
  for (const poolId of poolIds) {
    const { selector, scores } = agents[poolId].models;
    if (!selector || !scores) continue;
    const key = JSON.stringify(scores);
    if (!groups.has(key)) groups.set(key, { argv: scores, pools: [] });
    groups.get(key).pools.push(poolId);
  }
  for (const { argv, pools } of groups.values()) {
    const modelIds = [...new Set(pools.flatMap((poolId) => [...state.get(poolId).members.values()].map((m) => m.id)))];
    const run = await runPoolCommand(argv, { cwd: projectRoot, timeoutMs, input: `${modelIds.join('\n')}\n`, logger, stageId, signal });
    logCommandStderr('models.scores', run.stderr, logger, stageId);
    const parsed = run.ok ? parseScoresOutput(run.stdout) : { reason: run.reason };
    for (const poolId of pools) {
      const info = state.get(poolId);
      const total = info.members.size;
      if (parsed.reason) {
        logger?.info(`SCORES agent="${poolId}" scored=0/${total} (${parsed.reason})`, stageId);
        continue;
      }
      info.scores = parsed.scores;
      info.citation = parsed.citation;
      const scored = [...info.members.values()].filter((m) => isPlainObject(parsed.scores[m.id])).length;
      logger?.info(
        `SCORES agent="${poolId}" scored=${scored}/${total} as_of="${logText(parsed.as_of)}" citation="${logText(parsed.citation)}"`,
        stageId,
      );
    }
  }
}

/**
 * Кандидаты промпта селектора: полный id, способности участника, `note` команды списка и
 * оценки (`null` без оценки или при сбое команды оценок), и атрибуция оценок.
 * @param {object} pipeline — тот же объект, что раскрывал expandModelPools
 * @param {string} poolId
 * @param {string[]} memberIds — id участников `<пул>@<полный id>` в нужном порядке
 * @returns {{candidates: Array<{id: string, capabilities: string[], note: string, scores: object|null}>, citation: string|null}}
 */
export function poolSelectorData(pipeline, poolId, memberIds) {
  const info = POOL_STATE.get(pipeline)?.get(poolId) ?? null;
  const candidates = memberIds.map((memberId) => {
    const model = info?.members.get(memberId);
    const id = model?.id ?? memberId.slice(poolId.length + 1);
    const caps = pipeline?.agents?.[memberId]?.capabilities;
    const scores = info?.scores?.[id];
    return {
      id,
      capabilities: Array.isArray(caps) ? [...caps] : [],
      note: model?.note ?? '',
      scores: isPlainObject(scores) ? scores : null,
    };
  });
  return { candidates, citation: info?.citation ?? null };
}

// Текст секции DoD тела тикета — до следующего заголовка `## `; секции нет — пустая строка.
function dodSection(body) {
  const heading = DOD_HEADING.exec(body);
  if (!heading) return '';
  const start = heading.index + heading[0].length;
  const next = body.indexOf('\n## ', start);
  return body.slice(start, next === -1 ? body.length : next).trim();
}

/**
 * Тикет для промпта селектора: заголовок — `title` frontmatter, DoD — текст секции
 * «Критерии готовности (Definition of Done)», не длиннее SELECTOR_DOD_LIMIT (обрезка с
 * пометкой `…`). Нет файла, frontmatter или секции — пустые строки.
 * @param {string|null} ticketPath — файл тикета (findTicketPathForId раннера)
 * @param {{id: string, type: string|null}} ticket
 */
export function selectorTicket(ticketPath, { id, type }) {
  let content = '';
  try {
    if (ticketPath) content = fs.readFileSync(ticketPath, 'utf8');
  } catch {
    // нет файла — пустые заголовок и DoD
  }
  let frontmatter = {};
  let body = content;
  try {
    ({ frontmatter, body } = parseFrontmatter(content));
  } catch {
    // битый frontmatter: заголовка нет, DoD — по всему тексту
  }
  const title = frontmatter?.title == null ? '' : String(frontmatter.title);
  const dod = dodSection(body);
  return {
    id,
    type,
    title,
    dod: dod.length > SELECTOR_DOD_LIMIT ? `${dod.slice(0, SELECTOR_DOD_LIMIT - 1)}…` : dod,
  };
}

/** Промпт селектора: инструкция и JSON-блок (раздел плана «Селектор»). */
export function buildSelectorPrompt({ pool, ticket, candidates, citation = null }) {
  const data = { pool, ticket, candidates, scores_citation: citation };
  return [
    'Упорядочи участников пула для тикета по его типу, заголовку и DoD, способностям и оценкам кандидатов — '
      + 'от самого подходящего. Ответь блоком `---RESULT---` с полем `ranking: <id>, <id>, …` из id candidates.',
    '',
    '```json',
    JSON.stringify(data, null, 2),
    '```',
    '',
  ].join('\n');
}

/**
 * Ранжир ответа селектора: id из `ranking` через запятую, только из кандидатов, повтор —
 * первое вхождение. Кандидаты вне ранжира выбор берёт после него в порядке маски.
 * @param {unknown} ranking — значение поля `ranking` RESULT
 * @param {string[]} candidateIds — полные id кандидатов
 * @returns {string[]}
 */
export function selectorRanking(ranking, candidateIds) {
  if (typeof ranking !== 'string') return [];
  const allowed = new Set(candidateIds);
  const ranked = [];
  for (const id of ranking.split(',').map((s) => s.trim())) {
    if (allowed.has(id) && !ranked.includes(id)) ranked.push(id);
  }
  return ranked;
}
