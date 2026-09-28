#!/usr/bin/env node

/**
 * Селектор участника пула моделей на модели решений (OpenRouter decisions) —
 * обычный CLI-агент для `models.selector` пула.
 *
 * Раннер отдаёт агенту-селектору промпт: инструкцию и JSON-блок в ограждении
 * ```json с тикетом (`ticket.id/type/title/dod`) и кандидатами
 * (`candidates[].id/capabilities/note/scores`). Скрипт берёт JSON-блок, задаёт
 * модели один вопрос `type: choice` — варианты кандидаты, текст варианта: id,
 * способности, оценки и note — и отвечает ранжиром всех кандидатов из одного
 * вызова: следующий участник того же места пула в попытке — следующий по
 * ранжиру, без нового вызова. Какая модель и где её ключ — параметры агента в
 * pipeline.yaml, а не код системы.
 *
 *   node decisions-select.js --model <id> --url <https://…/decisions> --key-file <путь>
 *     [--timeout <с>]   промпт — из stdin (агент с `prompt_stdin: true`) или последним аргументом
 *
 * Тип вопроса — `choice`: по документации Decisions API это выбор одного из
 * вариантов без порядка между ними, с вероятностью по каждому варианту и до 255
 * вариантов; `score` — упорядоченная шкала до 10 уровней. Кандидатов 2..10:
 * раннер передаёт не больше 10, больше — bad_prompt.
 *
 * Ранжир — кандидаты по убыванию вероятности ответа, при равенстве — меньший
 * индекс (как levelIndexFromProbabilities, lib/model-evaluate.mjs); кандидат без
 * вероятности — после остальных, по индексу.
 *
 * Ключ — файл `--key-file` (`~` — домашний каталог): в окружении, которое
 * наследуют все процессы, его нет. В вывод ключ не попадает.
 *
 * Ответ:
 *   ---RESULT---
 *   ranking: <id>, <id>, …
 *   confidence: <0..1 или null>
 *   cost_usd: <цена или null>
 *   model: <модель из ответа>
 *   reason: <строка>
 *   ---RESULT---
 * Ошибка (нет ключа, отказ сети или модели, ответ без вероятностей, промпт без
 * JSON-блока, кандидатов меньше двух или больше десяти) — `status: error`,
 * `error_class`, `error` и код выхода 1: раннер берёт порядок маски.
 */

import fs from 'node:fs';
import { evaluate, MIN_LEVELS, MAX_LEVELS } from '../lib/model-evaluate.mjs';
import { ModelClientError, redactNetworkDetail } from '../lib/model-client.mjs';

const JSON_BLOCK = /```json[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/;
const QUESTION_ID = 'member';
const INSTRUCTIONS = [
  'Which candidate model is the best fit to carry out this ticket as an autonomous coding agent?',
  'Weigh the ticket type, title and definition of done against each candidate\'s capabilities and benchmark scores',
  '(intelligence, coding, agentic: higher is better; n/a means no data).',
].join(' ');

class SelectError extends Error {
  constructor(errorClass, message) {
    super(message);
    this.class = errorClass;
  }
}

function parseArgs(argv) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const take = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new SelectError('usage', `${arg} needs a value`);
      i++;
      return value;
    };
    if (arg === '--model') opts.model = take();
    else if (arg === '--url') opts.url = take();
    else if (arg === '--key-file') opts.keyFile = take();
    else if (arg === '--timeout') opts.timeout = Number(take());
    else rest.push(arg);
  }
  for (const [flag, value] of [['--model', opts.model], ['--url', opts.url], ['--key-file', opts.keyFile]]) {
    if (!value) throw new SelectError('usage', `${flag} is required`);
  }
  if (opts.timeout !== undefined && !(Number.isFinite(opts.timeout) && opts.timeout > 0)) {
    throw new SelectError('usage', '--timeout must be a number > 0');
  }
  opts.prompt = rest.length > 0 ? rest[rest.length - 1] : null;
  return opts;
}

/** JSON-блок промпта селектора: { pool, ticket, candidates }. */
function parseSelectorPrompt(prompt) {
  const match = String(prompt ?? '').match(JSON_BLOCK);
  if (!match) throw new SelectError('bad_prompt', 'prompt has no ```json block');
  let block;
  try {
    block = JSON.parse(match[1]);
  } catch (err) {
    throw new SelectError('bad_prompt', `prompt json block is not JSON: ${err.message}`);
  }
  const candidates = block?.candidates;
  if (!Array.isArray(candidates) || candidates.length < MIN_LEVELS || candidates.length > MAX_LEVELS) {
    throw new SelectError('bad_prompt', `prompt needs ${MIN_LEVELS}..${MAX_LEVELS} candidates, got ${Array.isArray(candidates) ? candidates.length : 'none'}`);
  }
  const ids = new Set();
  for (const candidate of candidates) {
    const id = candidate?.id;
    if (typeof id !== 'string' || id.trim() === '') throw new SelectError('bad_prompt', 'every candidate needs a non-empty string id');
    if (ids.has(id)) throw new SelectError('bad_prompt', `duplicate candidate id: ${id}`);
    ids.add(id);
  }
  return { pool: block.pool ?? null, ticket: block.ticket ?? null, candidates };
}

const scoreText = (value) => (typeof value === 'number' ? String(value) : 'n/a');

/** Текст варианта: id, способности, оценки, note. */
function candidateText(candidate) {
  const parts = [candidate.id];
  if (Array.isArray(candidate.capabilities) && candidate.capabilities.length > 0) {
    parts.push(`capabilities: ${candidate.capabilities.join(', ')}`);
  }
  const scores = candidate.scores;
  parts.push(scores && typeof scores === 'object'
    ? `scores: intelligence ${scoreText(scores.intelligence)}, coding ${scoreText(scores.coding)}, agentic ${scoreText(scores.agentic)}`
    : 'scores: n/a');
  if (typeof candidate.note === 'string' && candidate.note.trim() !== '') parts.push(`note: ${candidate.note.trim()}`);
  return parts.join(' | ');
}

/** Индексы кандидатов по убыванию вероятности; при равенстве — меньший индекс. */
function rankIndices(count, probabilities) {
  const probabilityOf = (i) => {
    const value = probabilities?.[String(i)];
    return typeof value === 'number' && !Number.isNaN(value) ? value : -Infinity;
  };
  return Array.from({ length: count }, (_, i) => i)
    .sort((a, b) => (probabilityOf(b) - probabilityOf(a)) || (a - b));
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf-8');
  } catch {
    return '';
  }
}

function printResult(fields) {
  const lines = ['---RESULT---'];
  for (const [key, value] of Object.entries(fields)) lines.push(`${key}: ${value}`);
  lines.push('---RESULT---');
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function select(opts, prompt) {
  const { pool, ticket, candidates } = parseSelectorPrompt(prompt);
  const agent = {
    id: 'decisions-select',
    kind: 'http',
    protocol: 'decisions',
    url: opts.url,
    model: opts.model,
    auth: { file: opts.keyFile },
    ...(opts.timeout ? { timeout_s: opts.timeout } : {}),
  };
  const evaluation = await evaluate(agent, {
    data: { pool, ticket },
    questions: [{ id: QUESTION_ID, type: 'choice', text: INSTRUCTIONS, levels: candidates.map(candidateText) }],
  });
  const answer = evaluation.answers[QUESTION_ID];
  const ranking = rankIndices(candidates.length, answer.probabilities).map((i) => candidates[i].id);
  return {
    ranking: ranking.join(', '),
    confidence: answer.confidence ?? 'null',
    cost_usd: evaluation.cost_usd ?? 'null',
    model: evaluation.model,
    reason: `choice of ${candidates.length} candidates by decisions model`,
  };
}

async function main() {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const prompt = opts.prompt ?? readStdin();
    printResult(await select(opts, prompt));
    return 0;
  } catch (err) {
    const errorClass = err instanceof SelectError || err instanceof ModelClientError ? err.class : 'select_error';
    printResult({
      status: 'error',
      error_class: errorClass,
      error: redactNetworkDetail(err.message).replace(/\s+/g, ' ').trim(),
    });
    return 1;
  }
}

// Код выхода — process.exitCode, а не process.exit: на POSIX запись в трубу асинхронна,
// и process.exit сразу после печати обрезал бы вывод сверх буфера трубы.
main().then((code) => { process.exitCode = code; });
