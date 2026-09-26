/**
 * Судья тестов скилов (PLAN-001): любой агент с командой из pipeline.yaml.
 *
 * Судья получает текстовый промпт (buildCliJudgePrompt — рубрика, вывод
 * исполнителя с файлами тикета, критерий кейса) и отвечает блоком `---RESULT---`
 * со строкой `score: <1-5>`. Кроме балла судья может сообщить уверенность
 * (`confidence: <0..1>`) и цену ответа (`cost_usd:`). Модель, которой нужен
 * другой протокол (модель решений по HTTP), подключается скриптом-обёрткой с тем
 * же входом и выходом (src/scripts/decisions-judge.js) — у системы нет отдельной
 * ветки ни для протокола, ни для конкретной модели, ни для её ключа.
 *
 * Переоценка — полями записи агента-судьи в pipeline.yaml:
 *   - `escalate_to` — судья, который переоценивает; без него переоценки нет;
 *   - `escalate_below` — уверенность ниже порога (или её отсутствие в ответе) —
 *     попытку переоценивает `escalate_to`, итог — его балл;
 *   - ответ без балла (ошибка судьи, `status: error` с `error_class`) — тоже
 *     `escalate_to`, с пометкой `fallback: <класс>`: сбой одного судьи не обнуляет
 *     прогон, который идёт десятки минут.
 *
 * Результат — запись вызова судьи (README, «Судья тестов скилов»): её пишет раннер
 * в `current/<agent>/trial-<N>.judge.json`, по ней перемеряется согласие судей
 * (src/scripts/compare-judges.js). Неразобранный ответ и балл вне 1..5 — ошибка
 * (`error`), а не балл 3: прежде сломанный ответ судьи был неотличим от честной
 * тройки.
 */

import { spawnAgent } from './agent-spawner.mjs';
import { redactNetworkDetail } from './model-client.mjs';

export const JUDGE_PASS_SCORE = 4;
// Цена вызова судьи без `cost_per_call` в записи агента — прежняя константа оценки.
export const DEFAULT_JUDGE_CALL_COST = 0.02;

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

/** Балл из ответа судьи: первое `score: <число>`; null — нет строки или балл вне 1..5. */
export function parseJudgeScore(output) {
  const match = String(output ?? '').match(/score:\s*(\d+)/i);
  if (!match) return null;
  const score = Number.parseInt(match[1], 10);
  return score >= 1 && score <= 5 ? score : null;
}

function field(output, name) {
  const match = String(output ?? '').match(new RegExp(`^${name}:\\s*(.+?)\\s*$`, 'mi'));
  return match ? match[1] : null;
}

/**
 * Необязательные поля ответа судьи сверх балла. Нет поля или значение не того
 * вида — null: судья, который уверенности не сообщает, не ломает разбор.
 */
export function parseJudgeExtras(output) {
  const confidenceText = field(output, 'confidence');
  const confidence = confidenceText !== null && /^(0(\.\d+)?|1(\.0+)?)$/.test(confidenceText)
    ? Number(confidenceText) : null;
  const costText = field(output, 'cost_usd');
  const cost = costText !== null && /^\d+(\.\d+)?(e-?\d+)?$/i.test(costText) ? Number(costText) : null;
  let probabilities = null;
  const probabilitiesText = field(output, 'probabilities');
  if (probabilitiesText) {
    try {
      const parsed = JSON.parse(probabilitiesText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) probabilities = parsed;
    } catch { /* не JSON — нет поля */ }
  }
  return {
    confidence,
    probabilities,
    cost_usd: cost,
    model: field(output, 'model'),
    error_class: field(output, 'error_class'),
    error: field(output, 'error'),
  };
}

/**
 * Проверка записи судьи до прогона.
 * @returns {string[]} ошибки
 */
export function judgeAgentErrors(judgeId, agents) {
  const agent = agents?.[judgeId];
  if (!agent) return [`Judge agent '${judgeId}' not found in pipeline.yaml → agents[]`];
  const errors = [];
  const isCli = (a) => (a.kind ?? 'cli') === 'cli';
  const inUnit = (value) => typeof value === 'number' && value >= 0 && value <= 1;
  if (!isCli(agent)) {
    errors.push(`Judge agent '${judgeId}' must be an agent with a command (kind: cli), got kind: ${agent.kind}; a model with another protocol joins as a CLI wrapper (src/scripts/decisions-judge.js)`);
  }
  if (agent.cost_per_call !== undefined && !(typeof agent.cost_per_call === 'number' && Number.isFinite(agent.cost_per_call) && agent.cost_per_call >= 0)) {
    errors.push(`Judge agent '${judgeId}': cost_per_call must be a number >= 0`);
  }
  if (agent.escalate_below !== undefined && !inUnit(agent.escalate_below)) {
    errors.push(`Judge agent '${judgeId}': escalate_below must be a number in 0..1`);
  }
  if (agent.escalation_share !== undefined && !inUnit(agent.escalation_share)) {
    errors.push(`Judge agent '${judgeId}': escalation_share must be a number in 0..1`);
  }
  const target = agent.escalate_to;
  if (target !== undefined) {
    if (typeof target !== 'string' || target === '') {
      errors.push(`Judge agent '${judgeId}': escalate_to must be an agent id`);
    } else if (target === judgeId) {
      errors.push(`Judge agent '${judgeId}': escalate_to must be another agent`);
    } else if (!agents[target]) {
      errors.push(`Judge agent '${judgeId}': escalate_to '${target}' not found in pipeline.yaml → agents[]`);
    } else if (!isCli(agents[target])) {
      errors.push(`Judge agent '${judgeId}': escalate_to '${target}' must be an agent with a command (kind: cli), got kind: ${agents[target].kind}`);
    }
  } else if (agent.escalate_below !== undefined || agent.escalation_share !== undefined) {
    errors.push(`Judge agent '${judgeId}': escalate_below and escalation_share need escalate_to`);
  }
  return errors;
}

/**
 * Ожидаемая цена одной оценки: `cost_per_call` судьи плюс, если задан
 * `escalate_to`, `escalation_share` × `cost_per_call` судьи эскалации (доля
 * переоценённых оценок — замер, а не константа кода).
 * `worst` — цена, если судья не даст балла ни разу (нет ключа, сбой, всегда
 * неуверен): каждую оценку тогда даёт ещё и `escalate_to`.
 * @returns {{ cost: number, worst: number, missing: string[] }} missing — чего нет в записях
 */
export function judgeCallCost(judgeId, agents) {
  const missing = [];
  const priceOf = (id) => {
    const value = agents?.[id]?.cost_per_call;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    missing.push(`${id}.cost_per_call`);
    return DEFAULT_JUDGE_CALL_COST;
  };
  const agent = agents?.[judgeId] || {};
  const own = priceOf(judgeId);
  if (!agent.escalate_to) return { cost: own, worst: own, missing };
  const target = priceOf(agent.escalate_to);
  let share = agent.escalation_share;
  if (typeof share !== 'number') {
    missing.push(`${judgeId}.escalation_share`);
    share = 1; // без замера — худший случай: переоценивается каждая оценка
  }
  return { cost: own + share * target, worst: own + target, missing };
}

/** Состояние одного прогона: предупреждение о сбое судьи печатается один раз на класс. */
export function createJudgeRunState() {
  return { warned: new Set() };
}

function newRecord(judgeId, input) {
  return {
    judge_agent: judgeId,
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
    // own_score — балл этого судьи; score и passed — итог попытки (после переоценки).
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
    error_class: null,
  };
}

async function askJudge(judgeId, agent, input, ctx) {
  const record = newRecord(judgeId, input);
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
    const extras = parseJudgeExtras(record.raw_output);
    Object.assign(record, {
      model: extras.model,
      confidence: extras.confidence,
      probabilities: extras.probabilities,
      cost_usd: extras.cost_usd,
    });
    const score = parseJudgeScore(record.raw_output);
    if (score === null) {
      record.error_class = extras.error_class || 'unparsed';
      record.error = extras.error_class
        ? `${extras.error_class}: ${redactNetworkDetail(extras.error || '')}`
        : 'judge output unparsed';
    } else {
      record.own_score = score;
      record.score = score;
      record.passed = score >= JUDGE_PASS_SCORE;
    }
  } catch (err) {
    record.error_class = 'judge_error';
    record.error = redactNetworkDetail(err.message);
  }
  record.duration_ms = Date.now() - started;
  return record;
}

/**
 * Одна оценка судьёй `judgeId` с переоценкой по полям его записи.
 *
 * @param {string} judgeId
 * @param {object} input - { rubric_file, rubric, criterion, agent_output, ticket_files }
 * @param {object} ctx
 * @param {object} ctx.agents - реестр агентов pipeline.yaml
 * @param {number} ctx.timeoutS - таймаут судьи на один вызов, с
 * @param {string} [ctx.stageId]
 * @param {object} [ctx.env] - доплата к окружению судьи
 * @param {object} [ctx.state] - createJudgeRunState() прогона
 * @param {boolean} [ctx.noEscalation] - только оценка самого судьи, без переоценки
 *   и без фоллбека (для сравнения судей)
 * @param {Function} [ctx.log]
 * @returns {Promise<object>} запись вызова судьи
 */
export async function runJudge(judgeId, input, ctx) {
  const agent = ctx.agents?.[judgeId];
  if (!agent) throw new Error(`Judge agent not found: ${judgeId}`);
  const started = Date.now();
  const record = await askJudge(judgeId, agent, input, ctx);
  const targetId = agent.escalate_to;
  if (ctx.noEscalation || !targetId) return record;

  const log = ctx.log || (() => {});
  if (record.error) {
    record.fallback = record.error_class;
    record.fallback_detail = record.error;
    const key = `${judgeId}:${record.error_class}`;
    if (!ctx.state?.warned?.has(key)) {
      ctx.state?.warned?.add(key);
      log(`[Runner] ⚠ judge ${judgeId}: нет балла (${record.error_class}) — оценку даёт ${targetId}; ${record.error}`);
    }
  } else if (typeof agent.escalate_below === 'number'
    && (record.confidence === null || record.confidence < agent.escalate_below)) {
    record.escalated = true;
  } else {
    return record;
  }

  // Итог попытки берётся у escalate_to; ответ судьи остаётся в записи.
  const target = await askJudge(targetId, ctx.agents[targetId], input, ctx);
  record.escalation = target;
  record.score = target.score;
  record.passed = target.passed;
  // error и error_class — итог попытки: сбой судьи, давший фоллбек, — в `fallback`.
  record.error = target.error ? `${targetId}: ${target.error}` : null;
  record.error_class = target.error ? target.error_class : null;
  record.duration_ms = Date.now() - started;
  return record;
}
