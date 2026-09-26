#!/usr/bin/env node

/**
 * Судья тестов скилов на модели решений (OpenRouter decisions) — обычный CLI-агент.
 *
 * Система знает только агента с командой: этот скрипт получает тот же промпт
 * CLI-судьи, что и любой другой судья (src/lib/skill-judge.mjs, buildCliJudgePrompt),
 * и отвечает тем же блоком `---RESULT---` с `score:` — плюс уверенностью модели.
 * Какая модель и где её ключ — параметры агента в pipeline.yaml, а не код системы.
 *
 *   node decisions-judge.js --model <id> --url <https://…/decisions> --key-file <путь>
 *     [--timeout <с>]   промпт — из stdin (агент с `prompt_stdin: true`) или последним аргументом
 *
 * Из промпта берутся три секции: `## Rubric` (уровни 1..5 — строки таблицы,
 * src/lib/rubric-levels.mjs), `## Target Agent Output` (данные) и `## Task`
 * (вопрос). Модель отвечает вероятностями уровней; балл — самый вероятный
 * уровень (при равенстве — меньший), уверенность — из ответа.
 *
 * Ключ — файл `--key-file` (`~` — домашний каталог), как у claude и kilo: в
 * окружении, которое наследуют все процессы, его нет. В вывод ключ не попадает.
 *
 * Ответ:
 *   ---RESULT---
 *   score: <1-5>
 *   confidence: <0..1>
 *   probabilities: <JSON по индексам уровней 0..4>
 *   model: <модель из ответа>
 *   cost_usd: <цена или null>
 *   raw: <answers провайдера, JSON>
 *   reason: <строка>
 *   ---RESULT---
 * Ошибка (нет ключа, отказ сети или модели, рубрика без таблицы, промпт не по
 * формату) — `status: error`, `error_class`, `error` и код выхода 1: судья без
 * балла, и раннер отдаёт оценку агенту `escalate_to`, если он задан.
 */

import fs from 'node:fs';
import { evaluate } from '../lib/model-evaluate.mjs';
import { ModelClientError, redactNetworkDetail } from '../lib/model-client.mjs';
import { rubricLevels } from '../lib/rubric-levels.mjs';

// Секции промпта CLI-судьи. Вывод исполнителя — жадно, до ПОСЛЕДНЕГО `## Task`
// перед постоянным хвостом промпта: вывод или файл тикета со своим заголовком
// `## Task` иначе обрезал бы данные и попадал бы в вопрос. Разбор пилота
// 2026-09-24 брал первый `## Task`; в 284 записях перемера это не встречалось.
const PROMPT_SECTIONS = /## Rubric\s*\n([\s\S]*?)\n## Target Agent Output\s*\n([\s\S]*)\n## Task\s*\n([\s\S]*?)\n\s*Please evaluate the output/;
const QUESTION_ID = 'verdict';

class JudgeError extends Error {
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
      if (value === undefined) throw new JudgeError('usage', `${arg} needs a value`);
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
    if (!value) throw new JudgeError('usage', `${flag} is required`);
  }
  if (opts.timeout !== undefined && !(Number.isFinite(opts.timeout) && opts.timeout > 0)) {
    throw new JudgeError('usage', '--timeout must be a number > 0');
  }
  opts.prompt = rest.length > 0 ? rest[rest.length - 1] : null;
  return opts;
}

/** Секции промпта CLI-судьи: { rubric, agentOutput, task }. */
function splitJudgePrompt(prompt) {
  const match = String(prompt ?? '').replace(/\r\n/g, '\n').match(PROMPT_SECTIONS);
  if (!match) {
    throw new JudgeError('bad_prompt', 'prompt has no "## Rubric", "## Target Agent Output", "## Task" sections of the judge prompt');
  }
  const [, rubric, agentOutput, task] = match.map((part) => (part ?? '').trim());
  return { rubric, agentOutput, task };
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

async function judge(opts, prompt) {
  const { rubric, agentOutput, task } = splitJudgePrompt(prompt);
  let levels;
  try {
    levels = rubricLevels(rubric, 'rubric');
  } catch (err) {
    throw new JudgeError('rubric_unparsed', err.message);
  }
  const agent = {
    id: 'decisions-judge',
    kind: 'http',
    protocol: 'decisions',
    url: opts.url,
    model: opts.model,
    auth: { file: opts.keyFile },
    ...(opts.timeout ? { timeout_s: opts.timeout } : {}),
  };
  const evaluation = await evaluate(agent, {
    data: { agent_output: agentOutput },
    questions: [{ id: QUESTION_ID, text: task, levels }],
  });
  const answer = evaluation.answers[QUESTION_ID];
  return {
    score: answer.level,
    confidence: answer.confidence,
    probabilities: JSON.stringify(answer.probabilities),
    model: evaluation.model,
    cost_usd: evaluation.cost_usd ?? 'null',
    raw: JSON.stringify(evaluation.raw ?? null),
    reason: `level ${answer.level} of ${levels.length} by decisions model`,
  };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
    const prompt = opts.prompt ?? readStdin();
    printResult(await judge(opts, prompt));
    return 0;
  } catch (err) {
    const errorClass = err instanceof JudgeError || err instanceof ModelClientError ? err.class : 'judge_error';
    printResult({
      status: 'error',
      error_class: errorClass,
      error: redactNetworkDetail(err.message).replace(/\s+/g, ' ').trim(),
    });
    return 1;
  }
}

main().then((code) => process.exit(code));
