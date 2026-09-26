/**
 * Судья тестов скилов: один контракт для двух видов судьи (PLAN-001).
 *
 *   - CLI-агент (`claude-opus` и т. п.) — текстовый промпт, балл из строки
 *     `score: <1-5>` ответа. Промпт — байт в байт прежний (buildCliJudgePrompt).
 *   - Безынструментный агент `kind: http`, `protocol: decisions` (Jev) — один
 *     вопрос `verdict` через слой оценки (model-evaluate.mjs); уровни — из
 *     таблицы рубрики (rubric-levels.mjs). Состав входа — как в пилоте Jev
 *     2026-09-24: `state.agent_output` = вывод исполнителя с секциями файлов
 *     тикета, `instructions` = критерий кейса, `criteria` = пять уровней. Цифры
 *     согласия этапа 0 относятся к этому составу: меняешь его — перемеряешь
 *     (src/scripts/compare-judges.js).
 *
 * Уверенность Jev ниже `escalate_below` (по умолчанию 0.8) — попытку переоценивает
 * `escalate_to` (CLI-агент): на пилоте при 0.8 мимо эскалации прошли 2 расхождения
 * с Opus из 18. Любая ошибка клиента (нет ключа, сеть, 5xx, чужой ответ) и
 * нечитаемая рубрика — тоже `escalate_to`, с пометкой `fallback: <класс>`:
 * сетевой сбой не обнуляет прогон, который идёт десятки минут.
 *
 * Результат — запись вызова судьи (README, «Судья тестов скилов»): её пишет раннер
 * в `current/<agent>/trial-<N>.judge.json`, по ней перемеряется согласие судей.
 * Неразобранный ответ и балл вне 1..5 — ошибка (`error`), а не балл 3: прежде
 * сломанный ответ судьи был неотличим от честной тройки.
 */

import { spawnAgent } from './agent-spawner.mjs';
import { evaluate } from './model-evaluate.mjs';
import { ModelClientError, assertModelUrl, resolveModelKey } from './model-client.mjs';
import { buildAgentEnv } from './agent-env.mjs';
import { rubricLevels } from './rubric-levels.mjs';

export const JUDGE_PASS_SCORE = 4;
export const DEFAULT_ESCALATE_BELOW = 0.8;
// Цена вызова судьи без `cost_per_call` в записи агента — прежняя константа оценки.
export const DEFAULT_JUDGE_CALL_COST = 0.02;
// Доля оценок Jev, ушедших на эскалацию при пороге 0.8: пилот 2026-09-24, 57 из 201.
export const ESCALATION_SHARE = 0.284;
export const VERDICT_QUESTION_ID = 'verdict';

/** Промпт CLI-судьи. `ticket_files` пуст — строка та же, что у калибровки. */
export function buildCliJudgePrompt({ rubric, agent_output, ticket_files = '', criterion }) {
  return `You are a judge evaluating the output of an AI agent.

## Rubric
${rubric}

## Target Agent Output
${agent_output}
${ticket_files}
## Task
${criterion}

Please evaluate the output according to the rubric and provide a score from 1 to 5.
Output format:
---RESULT---
score: <number 1-5>
reason: <brief explanation>
---RESULT---`;
}

/** Балл из ответа CLI-судьи: первое `score: <число>`; null — нет строки или балл вне 1..5. */
export function parseJudgeScore(output) {
  const match = String(output ?? '').match(/score:\s*(\d+)/i);
  if (!match) return null;
  const score = Number.parseInt(match[1], 10);
  return score >= 1 && score <= 5 ? score : null;
}

/** Данные для Jev — текст между `## Target Agent Output` и `## Task` промпта CLI-судьи. */
export function jevAgentOutput({ agent_output, ticket_files = '' }) {
  return `${agent_output}\n${ticket_files}`.trim();
}

/**
 * Проверка записи судьи до прогона. CLI-агент — без условий. `kind: http` —
 * только `protocol: decisions` и `escalate_to` на CLI-агента из реестра: без
 * него неуверенную оценку и отказ HTTP некому переоценить.
 * @returns {string[]} ошибки
 */
export function judgeAgentErrors(judgeId, agents) {
  const agent = agents?.[judgeId];
  if (!agent) return [`Judge agent '${judgeId}' not found in pipeline.yaml → agents[]`];
  const errors = [];
  const costOk = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  if (agent.cost_per_call !== undefined && !costOk(agent.cost_per_call)) {
    errors.push(`Judge agent '${judgeId}': cost_per_call must be a number >= 0`);
  }
  if (agent.kind !== 'http') return errors;

  try {
    assertModelUrl(agent.url);
  } catch (err) {
    errors.push(`Judge agent '${judgeId}' (kind: http): ${err.message}`);
  }
  if (agent.protocol !== 'decisions') {
    errors.push(`Judge agent '${judgeId}' (kind: http) must use protocol decisions, got: ${agent.protocol}`);
  }
  const target = agent.escalate_to;
  if (typeof target !== 'string' || target === '') {
    errors.push(`Judge agent '${judgeId}' (kind: http) needs escalate_to — a CLI agent for low-confidence scores and HTTP failures`);
  } else if (!agents[target]) {
    errors.push(`Judge agent '${judgeId}': escalate_to '${target}' not found in pipeline.yaml → agents[]`);
  } else if ((agents[target].kind ?? 'cli') !== 'cli') {
    errors.push(`Judge agent '${judgeId}': escalate_to '${target}' must be a CLI agent (kind: cli), got kind: ${agents[target].kind}`);
  }
  const below = agent.escalate_below;
  if (below !== undefined && !(typeof below === 'number' && below >= 0 && below <= 1)) {
    errors.push(`Judge agent '${judgeId}': escalate_below must be a number in 0..1`);
  }
  return errors;
}

/**
 * Ожидаемая цена одной оценки: `cost_per_call` судьи; для `kind: http` с
 * эскалацией — плюс доля эскалации пилота × `cost_per_call` агента `escalate_to`.
 * `allEscalate` — HTTP-судья не ответит ни разу (нет ключа): каждую оценку даёт
 * `escalate_to` по полной цене.
 * @returns {{ cost: number, missing: string[] }} missing — агенты без цены
 */
export function judgeCallCost(judgeId, agents, { allEscalate = false } = {}) {
  const missing = [];
  const priceOf = (id) => {
    const value = agents?.[id]?.cost_per_call;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    missing.push(id);
    return DEFAULT_JUDGE_CALL_COST;
  };
  const agent = agents?.[judgeId] || {};
  if (agent.kind === 'http' && agent.escalate_to && allEscalate) {
    return { cost: priceOf(agent.escalate_to), missing };
  }
  let cost = priceOf(judgeId);
  if (agent.kind === 'http' && agent.escalate_to) {
    cost += ESCALATION_SHARE * priceOf(agent.escalate_to);
  }
  return { cost, missing };
}

/**
 * Окружение клиента HTTP-судьи: переданное или окружение процесса с машинным
 * слоем `~/.workflow/agent.env` (ключ, прокси) — как у стадий `model_io` раннера.
 */
export function judgeClientEnv(baseEnv = process.env, { stageId = 'judge', logger = null } = {}) {
  return buildAgentEnv(baseEnv, null, { stageId, ...(logger ? { logger } : {}) });
}

/** Ключ HTTP-судьи есть в окружении клиента? Ошибка — класс `no_key` клиента. */
export function judgeKeyMissing(judgeId, agents, env) {
  const agent = agents?.[judgeId];
  if (agent?.kind !== 'http') return null;
  try {
    resolveModelKey({ ...agent, id: judgeId }, env);
    return null;
  } catch (err) {
    return err.message;
  }
}

// Текст ошибки клиента пишется в запись судьи, а записи лежат в git вместе с
// выводами прогона: адрес прокси или сервера (`connect ECONNREFUSED host:port`) там
// не нужен. Ключ клиент вырезает сам (model-client.mjs, scrub).
function redactDetail(text) {
  return String(text ?? '').replace(/\b[\w.-]+:\d{2,5}\b/g, '[host:port]');
}

/** Состояние одного прогона: судьи без ключа — предупреждение печатается один раз. */
export function createJudgeRunState() {
  return { noKey: new Map() };
}

function newRecord(judgeId, kind, input) {
  return {
    judge_agent: judgeId,
    judge_kind: kind,
    input: {
      rubric_file: input.rubric_file ?? null,
      rubric: input.rubric,
      criterion: input.criterion,
      agent_output: input.agent_output,
      ticket_files: input.ticket_files ?? '',
    },
    prompt: null,
    raw_output: null,
    model: null,
    // own_score — балл этого судьи; score и passed — итог попытки (после эскалации).
    own_score: null,
    score: null,
    passed: false,
    confidence: null,
    probabilities: null,
    escalated: false,
    escalation: null,
    fallback: null,
    fallback_detail: null,
    duration_ms: null,
    cost_usd: null,
    error: null,
  };
}

async function runCliJudge(judgeId, agent, input, ctx) {
  const record = newRecord(judgeId, 'cli', input);
  record.prompt = buildCliJudgePrompt(input);
  const started = Date.now();
  try {
    const result = await spawnAgent(agent, record.prompt, {
      timeout: ctx.timeoutS,
      stageId: ctx.stageId,
      railsRole: 'executor',
      ...(ctx.env ? { env: ctx.env } : {}),
    });
    record.raw_output = result.output || '';
    const score = parseJudgeScore(record.raw_output);
    if (score === null) {
      record.error = 'judge output unparsed';
    } else {
      record.own_score = score;
      record.score = score;
      record.passed = score >= JUDGE_PASS_SCORE;
    }
  } catch (err) {
    record.error = err.message;
  }
  record.duration_ms = Date.now() - started;
  return record;
}

/** Итог попытки берётся у `escalate_to`; ответ Jev остаётся в записи. */
async function handOver(record, agent, input, ctx) {
  const targetId = agent.escalate_to;
  const cli = await runCliJudge(targetId, ctx.agents[targetId], input, ctx);
  record.escalation = cli;
  record.score = cli.score;
  record.passed = cli.passed;
  if (cli.error) record.error = `${targetId}: ${cli.error}`;
  return record;
}

async function runHttpJudge(judgeId, agent, input, ctx) {
  const record = newRecord(judgeId, 'http', input);
  const started = Date.now();
  const log = ctx.log || (() => {});
  const done = () => {
    record.duration_ms = Date.now() - started;
    return record;
  };
  // Без эскалации (сравнение судей) отказ — ошибка записи; иначе оценку даёт escalate_to.
  const fallback = async (errorClass, rawDetail) => {
    const detail = redactDetail(rawDetail);
    if (ctx.noEscalation) {
      record.error = `${errorClass}: ${detail}`;
      return done();
    }
    record.fallback = errorClass;
    record.fallback_detail = detail;
    await handOver(record, agent, input, ctx);
    return done();
  };

  let levels;
  try {
    levels = rubricLevels(input.rubric, input.rubric_file || 'rubric');
  } catch (err) {
    if (!ctx.noEscalation) log(`[Runner] judge ${judgeId}: ${err.message} — оценку даёт ${agent.escalate_to}`);
    return fallback('rubric_unparsed', err.message);
  }

  const noKey = ctx.state?.noKey;
  if (noKey?.has(judgeId)) return fallback('no_key', noKey.get(judgeId));

  // Таймаут судьи — `execution.judge_timeout_s` скила (ctx.timeoutS), как у CLI-судьи.
  const httpAgent = { ...agent, id: judgeId, ...(ctx.timeoutS ? { timeout_s: ctx.timeoutS } : {}) };
  const clientOptions = { ...(ctx.clientOptions || {}) };
  if (!clientOptions.env) clientOptions.env = judgeClientEnv(process.env, { stageId: ctx.stageId });

  let evaluation;
  try {
    evaluation = await evaluate(httpAgent, {
      data: { agent_output: jevAgentOutput(input) },
      questions: [{ id: VERDICT_QUESTION_ID, text: String(input.criterion).trim(), levels }],
    }, clientOptions);
  } catch (err) {
    if (!(err instanceof ModelClientError)) throw err;
    const handler = ctx.noEscalation ? 'оценки нет' : `оценку даёт ${agent.escalate_to}`;
    if (err.class === 'no_key' && noKey) {
      if (!noKey.has(judgeId)) {
        noKey.set(judgeId, err.message);
        log(`[Runner] ⚠ judge ${judgeId}: нет ключа (no_key) — ${err.message}. До конца прогона ${handler}`);
      }
    } else {
      log(`[Runner] judge ${judgeId}: HTTP-судья не ответил (${err.class}) — ${handler}`);
    }
    return fallback(err.class, err.message);
  }

  const answer = evaluation.answers[VERDICT_QUESTION_ID];
  Object.assign(record, {
    // Ответ модели как есть — форма тела decisions: model, answers провайдера, usage.
    raw_output: JSON.stringify({ model: evaluation.model, answers: evaluation.raw, usage: evaluation.usage }),
    model: evaluation.model ?? null,
    cost_usd: evaluation.cost_usd ?? null,
    own_score: answer.level,
    score: answer.level,
    passed: answer.level >= JUDGE_PASS_SCORE,
    confidence: answer.confidence,
    probabilities: answer.probabilities,
  });

  const below = typeof agent.escalate_below === 'number' ? agent.escalate_below : DEFAULT_ESCALATE_BELOW;
  if (!ctx.noEscalation && (answer.confidence === null || answer.confidence < below)) {
    record.escalated = true;
    await handOver(record, agent, input, ctx);
  }
  return done();
}

/**
 * Одна оценка судьёй `judgeId`.
 *
 * @param {string} judgeId
 * @param {object} input - { rubric_file, rubric, criterion, agent_output, ticket_files }
 * @param {object} ctx
 * @param {object} ctx.agents - реестр агентов pipeline.yaml
 * @param {number} ctx.timeoutS - таймаут судьи на один вызов, с (CLI и HTTP)
 * @param {string} [ctx.stageId]
 * @param {object} [ctx.env] - доплата к окружению CLI-судьи
 * @param {object} [ctx.clientOptions] - параметры клиента HTTP (env, retryDelaysMs);
 *   без env — окружение процесса с ~/.workflow/agent.env (judgeClientEnv)
 * @param {object} [ctx.state] - createJudgeRunState() прогона
 * @param {boolean} [ctx.noEscalation] - только оценка самого судьи: без эскалации
 *   и без фоллбека (ошибка клиента — `error`). Для сравнения судей.
 * @param {Function} [ctx.log]
 * @returns {Promise<object>} запись вызова судьи
 */
export async function runJudge(judgeId, input, ctx) {
  const agent = ctx.agents?.[judgeId];
  if (!agent) throw new Error(`Judge agent not found: ${judgeId}`);
  return agent.kind === 'http'
    ? runHttpJudge(judgeId, agent, input, ctx)
    : runCliJudge(judgeId, agent, input, ctx);
}
