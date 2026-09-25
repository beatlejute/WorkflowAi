/**
 * Слой оценки поверх клиента безынструментного агента (model-client.mjs).
 *
 * Один вход и один выход для обоих протоколов — судье тестов скилов и скриптам
 * стадий с обменом `model_io` не нужно знать, какой протокол у выбранной модели.
 *
 * Вход:  { data, images?, questions: [{ id, text, levels: [уровень 1, …, уровень n] }] }
 * Выход: { answers: { <id>: { level, confidence, probabilities, reason } },
 *          model, usage, cost_usd, duration_ms }
 *
 * `level` — номер уровня 1..n.
 *   - decisions: индекс наибольшей вероятности + 1, при равенстве — меньший (правило
 *     пилота Jev); `confidence` и `probabilities` — из ответа.
 *   - chat: из JSON-ответа модели `{"answers":[{"id","level","reason"}]}`;
 *     `confidence` и `probabilities` — null.
 * Нет ответа на вопрос или уровень вне 1..n — `bad_response`: молчаливого уровня
 * по умолчанию нет. Порог прохода и порог уверенности решает потребитель.
 */

import { chat, decide, ModelClientError } from './model-client.mjs';

export const MIN_LEVELS = 2;
export const MAX_LEVELS = 10;

function validateInput(input) {
  if (input === null || typeof input !== 'object') {
    throw new ModelClientError('bad_request', 'Evaluation input must be an object');
  }
  const { questions, images } = input;
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new ModelClientError('bad_request', 'Evaluation input has no questions');
  }
  if (images !== undefined && !Array.isArray(images)) {
    throw new ModelClientError('bad_request', 'Evaluation input images must be an array of paths');
  }
  const ids = new Set();
  for (const question of questions) {
    const id = question?.id;
    if (typeof id !== 'string' || id.trim() === '') {
      throw new ModelClientError('bad_request', 'Every question needs a non-empty string id');
    }
    if (ids.has(id)) {
      throw new ModelClientError('bad_request', `Duplicate question id: ${id}`);
    }
    ids.add(id);
    if (typeof question.text !== 'string' || question.text.trim() === '') {
      throw new ModelClientError('bad_request', `Question ${id} has no text`);
    }
    const levels = question.levels;
    if (!Array.isArray(levels) || levels.length < MIN_LEVELS || levels.length > MAX_LEVELS
      || levels.some((level) => typeof level !== 'string' || level.trim() === '')) {
      throw new ModelClientError('bad_request', `Question ${id} needs ${MIN_LEVELS}..${MAX_LEVELS} non-empty levels`);
    }
  }
}

// ---------------------------------------------------------------------------
// decisions
// ---------------------------------------------------------------------------

/** Индекс наибольшей вероятности; при равенстве — меньший. null — вероятностей нет. */
export function levelIndexFromProbabilities(probabilities) {
  if (probabilities === null || typeof probabilities !== 'object') return null;
  let best = null;
  let bestProbability = -Infinity;
  for (const [key, value] of Object.entries(probabilities)) {
    const index = Number(key);
    if (!Number.isInteger(index) || typeof value !== 'number' || Number.isNaN(value)) continue;
    if (value > bestProbability || (value === bestProbability && index < best)) {
      best = index;
      bestProbability = value;
    }
  }
  return best;
}

async function evaluateDecisions(agent, input, options) {
  if (Array.isArray(input.images) && input.images.length > 0) {
    throw new ModelClientError('bad_request', 'Protocol decisions does not accept images');
  }
  const questions = {};
  for (const question of input.questions) {
    questions[question.id] = { type: 'score', instructions: question.text, criteria: question.levels };
  }
  const response = await decide(agent, { state: input.data, questions }, options);

  const answers = {};
  for (const question of input.questions) {
    const answer = response.answers[question.id];
    if (!answer || typeof answer !== 'object') {
      throw new ModelClientError('bad_response', `Model gave no answer to question ${question.id}`);
    }
    const index = levelIndexFromProbabilities(answer.probabilities);
    if (index === null) {
      throw new ModelClientError('bad_response', `Answer to question ${question.id} has no probabilities`);
    }
    const level = index + 1;
    if (level < 1 || level > question.levels.length) {
      throw new ModelClientError('bad_response', `Answer to question ${question.id} has level ${level} outside 1..${question.levels.length}`);
    }
    answers[question.id] = {
      level,
      confidence: typeof answer.confidence === 'number' ? answer.confidence : null,
      probabilities: answer.probabilities,
      reason: null,
    };
  }
  return { answers, response };
}

// ---------------------------------------------------------------------------
// chat
// ---------------------------------------------------------------------------

export const CHAT_EVALUATION_SYSTEM = [
  'Ты оцениваешь данные по вопросам. Для каждого вопроса выбери ровно один уровень из перечисленных и укажи его номер.',
  'Ответь одним JSON-объектом без другого текста:',
  '{"answers":[{"id":"<id вопроса>","level":<номер уровня>,"reason":"<коротко, почему>"}]}',
  'Ответ нужен на каждый вопрос.',
].join('\n');

function formatData(data) {
  if (typeof data === 'string') return data;
  return JSON.stringify(data ?? null, null, 2);
}

export function buildChatEvaluationMessage(input) {
  const lines = ['Данные:', formatData(input.data), '', 'Вопросы:'];
  for (const question of input.questions) {
    lines.push('', `id: ${question.id}`, question.text);
    question.levels.forEach((level, i) => lines.push(`  ${i + 1}. ${level}`));
  }
  return lines.join('\n');
}

/**
 * Первый JSON-объект в тексте: от первой `{`, для которой нашлась парная `}` и
 * JSON.parse прошёл. Строки в кавычках учитываются — скобки внутри них не считаются.
 */
export function extractFirstJsonObject(text) {
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

async function evaluateChat(agent, input, options) {
  const response = await chat(agent, {
    system: CHAT_EVALUATION_SYSTEM,
    message: buildChatEvaluationMessage(input),
    images: input.images || [],
  }, options);

  const parsed = extractFirstJsonObject(response.text);
  if (!parsed || !Array.isArray(parsed.answers)) {
    throw new ModelClientError('bad_response', 'Model reply has no JSON object with an answers array');
  }
  const byId = new Map();
  for (const answer of parsed.answers) {
    if (answer && typeof answer.id === 'string' && !byId.has(answer.id)) byId.set(answer.id, answer);
  }

  const answers = {};
  for (const question of input.questions) {
    const answer = byId.get(question.id);
    if (!answer) {
      throw new ModelClientError('bad_response', `Model gave no answer to question ${question.id}`);
    }
    const level = Number(answer.level);
    if (!Number.isInteger(level) || level < 1 || level > question.levels.length) {
      throw new ModelClientError('bad_response', `Answer to question ${question.id} has level ${answer.level} outside 1..${question.levels.length}`);
    }
    answers[question.id] = {
      level,
      confidence: null,
      probabilities: null,
      reason: typeof answer.reason === 'string' ? answer.reason : null,
    };
  }
  return { answers, response };
}

// ---------------------------------------------------------------------------

/**
 * @param {object} agent - запись агента `kind: http` из pipeline.yaml
 * @param {object} input - вход слоя оценки
 * @param {object} [options] - параметры клиента: env, cwd, retryDelaysMs, imageLimits
 */
export async function evaluate(agent, input, options = {}) {
  validateInput(input);
  const started = Date.now();
  let result;
  if (agent.protocol === 'decisions') {
    result = await evaluateDecisions(agent, input, options);
  } else if (agent.protocol === 'chat') {
    result = await evaluateChat(agent, input, options);
  } else {
    throw new ModelClientError('bad_request', `Unknown protocol: ${agent.protocol}`);
  }
  return {
    answers: result.answers,
    model: result.response.model,
    usage: result.response.usage,
    cost_usd: result.response.cost_usd,
    duration_ms: Date.now() - started,
  };
}
