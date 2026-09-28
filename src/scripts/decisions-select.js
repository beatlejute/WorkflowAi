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
 *     [--timeout <с>] [--level-quantile <q>]
 *     промпт — из stdin (агент с `prompt_stdin: true`) или последним аргументом
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
 *
 * Режим models — выбор модели стадии (README, «Выбор модели стадии»; агент
 * `selection.selector`, в поставляемом конфиге jev-place). Его признак — поле `levels`
 * JSON-блока: рубрика сложности тикета, 2..10 текстов от слабого уровня к сильному.
 * Блок без `levels` — режим пула выше, без изменений. В блоке ещё тикет и кандидаты
 * стадии (`id`, `kind`, `free`, `level`, `scores`). Один вызов evaluate, два вопроса:
 *   - `level` (score, уровни — тексты рубрики) — самый НИЗКИЙ достаточный уровень;
 *   - `pick` (choice, варианты — кандидаты; только при двух и больше, первые 255 в
 *     порядке промпта) — порядок кандидатов внутри одного уровня.
 * `required_level` — наименьший уровень k, у которого сумма вероятностей уровней 1..k
 * не меньше `--level-quantile` (по умолчанию 0.5, в (0, 1]); сумма не набралась —
 * уровень наибольшей вероятности. Правило берёт наименьший достаточный уровень, а не
 * самый вероятный (правило стейкхолдера «самая слабая достаточная модель»): у ответа
 * «уровень 2 — 0.5, уровень 4 — 0.5» это 2. Ответ:
 *   ---RESULT---
 *   required_level: <1..N>
 *   level_confidence: <0..1 или null>
 *   ranking: <id>, <id>, …   все кандидаты по вероятности pick
 *   cost_usd, model, reason
 *   ---RESULT---
 * Уровней меньше двух или больше десяти, нет кандидатов или повтор id — bad_prompt,
 * запроса нет.
 */

import fs from 'node:fs';
import { evaluate, MIN_LEVELS, MAX_LEVELS, MAX_CHOICE_LEVELS } from '../lib/model-evaluate.mjs';
import { ModelClientError, redactNetworkDetail } from '../lib/model-client.mjs';

const JSON_BLOCK = /```json[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/;
const QUESTION_ID = 'member';
const INSTRUCTIONS = [
  'Which candidate model is the best fit to carry out this ticket as an autonomous coding agent?',
  'Weigh the ticket type, title and definition of done against each candidate\'s capabilities and benchmark scores',
  '(intelligence, coding, agentic: higher is better; n/a means no data).',
].join(' ');

const LEVEL_QUESTION = 'level';
const PICK_QUESTION = 'pick';
const DEFAULT_LEVEL_QUANTILE = 0.5;
const LEVEL_INSTRUCTIONS = [
  'Which is the LOWEST level whose models can reliably complete this ticket end to end?',
  'Levels are strength bands of the listed candidates (1 = weakest). Do not pick higher than needed;',
  'weigh type, complexity, DoD, description, required capabilities and history of failed levels.',
].join(' ');
const PICK_INSTRUCTIONS = 'Which candidate fits this ticket best? Used only to order candidates inside one level.';

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
    else if (arg === '--level-quantile') opts.levelQuantile = Number(take());
    else rest.push(arg);
  }
  for (const [flag, value] of [['--model', opts.model], ['--url', opts.url], ['--key-file', opts.keyFile]]) {
    if (!value) throw new SelectError('usage', `${flag} is required`);
  }
  if (opts.timeout !== undefined && !(Number.isFinite(opts.timeout) && opts.timeout > 0)) {
    throw new SelectError('usage', '--timeout must be a number > 0');
  }
  if (opts.levelQuantile !== undefined
    && !(Number.isFinite(opts.levelQuantile) && opts.levelQuantile > 0 && opts.levelQuantile <= 1)) {
    throw new SelectError('usage', '--level-quantile must be a number in (0, 1]');
  }
  opts.levelQuantile ??= DEFAULT_LEVEL_QUANTILE;
  opts.prompt = rest.length > 0 ? rest[rest.length - 1] : null;
  return opts;
}

/** JSON-блок промпта — объект из ограждения ```json. */
function promptBlock(prompt) {
  const match = String(prompt ?? '').match(JSON_BLOCK);
  if (!match) throw new SelectError('bad_prompt', 'prompt has no ```json block');
  try {
    return JSON.parse(match[1]);
  } catch (err) {
    throw new SelectError('bad_prompt', `prompt json block is not JSON: ${err.message}`);
  }
}

function checkCandidateIds(candidates) {
  const ids = new Set();
  for (const candidate of candidates) {
    const id = candidate?.id;
    if (typeof id !== 'string' || id.trim() === '') throw new SelectError('bad_prompt', 'every candidate needs a non-empty string id');
    if (ids.has(id)) throw new SelectError('bad_prompt', `duplicate candidate id: ${id}`);
    ids.add(id);
  }
}

/** JSON-блок промпта селектора пула: { pool, ticket, candidates }. */
function parseSelectorPrompt(block) {
  const candidates = block?.candidates;
  if (!Array.isArray(candidates) || candidates.length < MIN_LEVELS || candidates.length > MAX_LEVELS) {
    throw new SelectError('bad_prompt', `prompt needs ${MIN_LEVELS}..${MAX_LEVELS} candidates, got ${Array.isArray(candidates) ? candidates.length : 'none'}`);
  }
  checkCandidateIds(candidates);
  return { pool: block.pool ?? null, ticket: block.ticket ?? null, candidates };
}

/** JSON-блок промпта выбора модели стадии: { stage, ticket, levels, candidates, scores_citation }. */
function parseModelsPrompt(block) {
  const { levels, candidates } = block;
  if (!Array.isArray(levels) || levels.length < MIN_LEVELS || levels.length > MAX_LEVELS
    || levels.some((level) => typeof level !== 'string' || level.trim() === '')) {
    throw new SelectError('bad_prompt', `prompt needs ${MIN_LEVELS}..${MAX_LEVELS} non-empty levels, got ${Array.isArray(levels) ? levels.length : 'none'}`);
  }
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new SelectError('bad_prompt', 'prompt has no candidates');
  }
  checkCandidateIds(candidates);
  return { stage: block.stage ?? null, ticket: block.ticket ?? null, levels, candidates, citation: block.scores_citation ?? null };
}

const scoreText = (value) => (typeof value === 'number' ? String(value) : 'n/a');

function scoresText(scores) {
  return scores && typeof scores === 'object'
    ? `scores: intelligence ${scoreText(scores.intelligence)}, coding ${scoreText(scores.coding)}, agentic ${scoreText(scores.agentic)}`
    : 'scores: n/a';
}

/** Текст варианта: id, способности, оценки, note. */
function candidateText(candidate) {
  const parts = [candidate.id];
  if (Array.isArray(candidate.capabilities) && candidate.capabilities.length > 0) {
    parts.push(`capabilities: ${candidate.capabilities.join(', ')}`);
  }
  parts.push(scoresText(candidate.scores));
  if (typeof candidate.note === 'string' && candidate.note.trim() !== '') parts.push(`note: ${candidate.note.trim()}`);
  return parts.join(' | ');
}

/** Текст варианта кандидата стадии: id, уровень, бесплатный или платный, оценки. */
function modelCandidateText(candidate) {
  return [
    candidate.id,
    `level ${Number.isInteger(candidate.level) ? candidate.level : 'n/a'}`,
    candidate.free === true ? 'free' : 'paid',
    scoresText(candidate.scores),
  ].join(' | ');
}

/**
 * Требуемый уровень 1..count по вероятностям ответа (ключи — индексы 0..count-1):
 * наименьший k, у которого сумма вероятностей уровней 1..k не меньше quantile; сумма
 * не набралась — `fallback` (уровень наибольшей вероятности).
 */
function quantileLevel(count, probabilities, quantile, fallback) {
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const value = probabilities?.[String(i)];
    if (typeof value === 'number' && !Number.isNaN(value)) sum += value;
    // Погрешность сложения с плавающей точкой: 0.1 + 0.2 + 0.2 в double меньше 0.5.
    if (sum >= quantile - 1e-9) return i + 1;
  }
  return fallback;
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

function decisionsAgent(opts) {
  return {
    id: 'decisions-select',
    kind: 'http',
    protocol: 'decisions',
    url: opts.url,
    model: opts.model,
    auth: { file: opts.keyFile },
    ...(opts.timeout ? { timeout_s: opts.timeout } : {}),
  };
}

async function selectModel(opts, block) {
  const { stage, ticket, levels, candidates, citation } = parseModelsPrompt(block);
  // Выбор — среди первых MAX_CHOICE_LEVELS кандидатов в порядке промпта (раннер кладёт
  // их в порядке обхода); остальные идут в ранжир после них, по порядку промпта.
  const choice = candidates.slice(0, MAX_CHOICE_LEVELS);
  const questions = [{ id: LEVEL_QUESTION, type: 'score', text: LEVEL_INSTRUCTIONS, levels }];
  if (choice.length >= MIN_LEVELS) {
    questions.push({ id: PICK_QUESTION, type: 'choice', text: PICK_INSTRUCTIONS, levels: choice.map(modelCandidateText) });
  }
  const evaluation = await evaluate(decisionsAgent(opts), {
    data: { stage, ticket, candidates, scores_citation: citation },
    questions,
  });
  const level = evaluation.answers[LEVEL_QUESTION];
  const requiredLevel = quantileLevel(levels.length, level.probabilities, opts.levelQuantile, level.level);
  const pick = evaluation.answers[PICK_QUESTION];
  const ranked = pick ? rankIndices(choice.length, pick.probabilities).map((i) => choice[i].id) : choice.map((c) => c.id);
  return {
    required_level: requiredLevel,
    level_confidence: level.confidence ?? 'null',
    ranking: [...ranked, ...candidates.slice(choice.length).map((c) => c.id)].join(', '),
    cost_usd: evaluation.cost_usd ?? 'null',
    model: evaluation.model,
    reason: `level ${requiredLevel} of ${levels.length} at quantile ${opts.levelQuantile}, pick of ${pick ? choice.length : 0} candidates by decisions model`,
  };
}

async function select(opts, prompt) {
  const block = promptBlock(prompt);
  if (block && typeof block === 'object' && !Array.isArray(block) && block.levels !== undefined) {
    return selectModel(opts, block);
  }
  const { pool, ticket, candidates } = parseSelectorPrompt(block);
  const evaluation = await evaluate(decisionsAgent(opts), {
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
