#!/usr/bin/env node

/**
 * apply-review.js — шаг apply стадии ревью с обменом `model_io`
 * (src/runner.mjs, StageExecutor.callModelAgent): вердикт по ответу модели, запись
 * ревью в тикет и в файл evidence.
 *
 * Вход:
 *   - WORKFLOW_MODEL_REQUEST — вход слоя оценки, который написал prepare-review.js;
 *   - WORKFLOW_MODEL_RESPONSE — ответ модели в форме слоя оценки
 *     (src/lib/model-evaluate.mjs): answers.<id>.{level, confidence, reason}, model,
 *     cost_usd — одной формы у агента с командой и у агента kind: http;
 *   - WORKFLOW_MODEL_IO_OPTIONS — pass_level и min_confidence из model_io.options стадии;
 *   - WORKFLOW_MODEL_AGENT — id агента, который отвечал;
 *   - промпт стадии последним аргументом: ticket_id и evidence_file из блока `Context:`.
 *
 * Пункт пройден, если level ≥ pass_level, а уверенность модели null (агент её не
 * сообщает) или ≥ min_confidence. Неуверенная оценка — провал, переоценки нет
 * (решение стейкхолдера 2026-09-24): следующая попытка по счётчику берёт следующего
 * агента списка стадии.
 *
 * Запись:
 *   - раздел review файла evidence: { agent, model, items: { <номер пункта>:
 *     { level, confidence, passed, reason } } };
 *   - строка `## Ревью` тикета через appendReviewEntry: статус, самари (номера
 *     непройденных пунктов, путь evidence, модель), агент.
 *
 * RESULT:
 *   status: passed | failed; failed_items — номера непройденных пунктов через запятую;
 *     agent; model и cost_usd (unknown — ответ их не назвал); review_written — строка
 *     `## Ревью` записана;
 *   status: error, reason — ничего не пишется:
 *     answer_missing — в ответе нет уровня на вопрос запроса;
 *     evidence_missing — в контексте нет evidence_file или файла нет на диске;
 *     ticket_missing — файла тикета нет ни в одном из статусов REVIEW_STATUSES.
 */

import fs from 'fs';
import path from 'path';
import { findProjectRoot } from 'workflow-ai/lib/find-root.mjs';
import { printResult, appendReviewEntry, replaceFileAtomicSync } from 'workflow-ai/lib/utils.mjs';

const PROJECT_DIR = findProjectRoot();
const TICKETS_DIR = path.join(PROJECT_DIR, '.workflow', 'tickets');
// Где искать тикет — как у verify-artifacts.js.
const REVIEW_STATUSES = ['review', 'in-progress', 'done', 'ready', 'backlog'];
// Проход шкалы knowledge/dod-evidence-scale.md: с уровня 4 пункт подтверждён целиком.
const DEFAULT_PASS_LEVEL = 4;
// Порог уверенности стадии review-result в PLAN-002 («Стадия ревью после плана»).
const DEFAULT_MIN_CONFIDENCE = 0.8;

class ApplyError extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

/**
 * Значение ключа из блока `Context:` промпта раннера — строки `  key: value`
 * (src/runner.mjs, PromptBuilder). Блок идёт сразу за именем стадии, раньше
 * `Counters:` и `Instructions:`, поэтому берётся первое совпадение.
 */
function contextValue(prompt, key) {
  const match = prompt.match(new RegExp(`^  ${key}: (.+)$`, 'm'));
  return match ? match[1].trim() : '';
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function findTicket(ticketId) {
  if (!ticketId) return null;
  for (const status of REVIEW_STATUSES) {
    const candidate = path.join(TICKETS_DIR, status, `${ticketId}.md`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function apply(prompt) {
  const request = readJson(process.env.WORKFLOW_MODEL_REQUEST);
  const response = readJson(process.env.WORKFLOW_MODEL_RESPONSE);
  const options = JSON.parse(process.env.WORKFLOW_MODEL_IO_OPTIONS || '{}');
  const passLevel = options.pass_level ?? DEFAULT_PASS_LEVEL;
  const minConfidence = options.min_confidence ?? DEFAULT_MIN_CONFIDENCE;
  const agent = process.env.WORKFLOW_MODEL_AGENT || 'unknown';

  const missing = request.questions
    .filter((question) => !Number.isInteger(response.answers?.[question.id]?.level))
    .map((question) => question.id);
  if (missing.length > 0) {
    throw new ApplyError('answer_missing', `model response has no level for ${missing.join(', ')}`);
  }

  const evidenceFile = contextValue(prompt, 'evidence_file');
  const evidencePath = evidenceFile ? path.resolve(PROJECT_DIR, evidenceFile) : null;
  if (!evidencePath || !fs.existsSync(evidencePath)) {
    throw new ApplyError('evidence_missing', `evidence file not found: ${evidenceFile || '(no evidence_file in stage context)'}`);
  }
  const ticketId = contextValue(prompt, 'ticket_id');
  const ticketPath = findTicket(ticketId);
  if (!ticketPath) {
    throw new ApplyError('ticket_missing', `ticket ${ticketId || '(no ticket_id in stage context)'} not found in ${REVIEW_STATUSES.join(', ')}`);
  }

  const items = {};
  const failed = [];
  for (const question of request.questions) {
    const answer = response.answers[question.id];
    const confidence = answer.confidence ?? null;
    const passed = answer.level >= passLevel && (confidence === null || confidence >= minConfidence);
    const number = question.id.replace(/^dod-/, '');
    items[number] = { level: answer.level, confidence, passed, reason: answer.reason ?? null };
    if (!passed) failed.push(number);
  }
  const model = response.model ?? null;

  const evidence = readJson(evidencePath);
  evidence.review = { agent, model, items };
  replaceFileAtomicSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

  const status = failed.length === 0 ? 'passed' : 'failed';
  const verdict = failed.length === 0
    ? `пункты DoD ${Object.keys(items).join(', ')} пройдены`
    : `не пройдены пункты DoD ${failed.join(', ')}`;
  // `|` в модели или пути разорвал бы строку таблицы; экранированный getLastReviewStatus пропускает.
  const summary = `review-result: ${verdict}; evidence ${evidenceFile}; модель ${model ?? 'неизвестна'}`.replace(/\|/g, '\\|');
  const written = appendReviewEntry(ticketPath, {
    date: new Date().toISOString().slice(0, 10),
    status,
    summary,
    agent,
  });
  if (!written.ok) console.error(`Warning: review entry not written to ${ticketPath}: ${written.error}`);

  return {
    status,
    failed_items: failed.join(','),
    agent,
    model: model ?? 'unknown',
    cost_usd: response.cost_usd ?? 'unknown',
    review_written: written.ok,
  };
}

function main() {
  const prompt = process.argv.slice(2).join(' ');
  try {
    printResult(apply(prompt));
  } catch (err) {
    if (!(err instanceof ApplyError)) throw err;
    printResult({ status: 'error', reason: err.reason, error: err.message });
  }
}

main();
