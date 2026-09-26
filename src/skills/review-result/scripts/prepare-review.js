#!/usr/bin/env node

/**
 * prepare-review.js — шаг prepare стадии ревью с обменом `model_io`
 * (src/runner.mjs, StageExecutor.callModelAgent): вопросы модели по файлу evidence
 * тикета, который собрал verify-artifacts.js.
 *
 * Вход:
 *   - промпт стадии последним аргументом; из блока `Context:` берутся `evidence_file`
 *     и `ticket_id`;
 *   - WORKFLOW_MODEL_CAPABILITIES — способности выбранного агента, JSON-массив;
 *   - WORKFLOW_MODEL_AGENT — id агента, для сообщения об ошибке.
 *
 * Выход — вход слоя оценки (src/lib/model-evaluate.mjs) в файле рядом с evidence,
 * `<TICKET-ID>.review-request.json`:
 *   - data — пункты DoD со статусом, отличным от pending (проверки с выводом),
 *     source_refs, diff, пометка усечения diff_truncated и причина неполного диффа
 *     diff_error (verify-artifacts.js). Раздела Result тикета
 *     здесь нет: пилот судьи 2026-09-24 (PLAN-001, этап 0) показал, что модель
 *     принимает заявление исполнителя за факт;
 *   - images — изображения пунктов visual;
 *   - questions — по вопросу на пункт prose и visual: id `dod-<номер пункта>`, текст
 *     пункта (у visual — с путями его изображений), пять уровней шкалы
 *     knowledge/dod-evidence-scale.md.
 *
 * RESULT:
 *   status: ready, request_file: <путь от корня проекта> — вопросы есть, раннер
 *     спрашивает модель и запускает apply-review.js;
 *   status: passed — вопросов нет, стадия закрыта без модели;
 *   status: error, reason:
 *     evidence_missing — в контексте нет evidence_file или файла нет на диске;
 *     evidence_invalid — файл не JSON или в нём нет массива items;
 *     evidence_mismatch — ticket_id файла не равен ticket_id контекста: контекст
 *       раннера между тикетами не очищается (updateContext только присваивает
 *       ключи), и без сверки prepare прочёл бы evidence предыдущего тикета прогона;
 *     evidence_failed_items — в evidence есть пункт не зелёный и не ждущий модели
 *       (проваленная проверка, visual без изображений): такой тикет verify-artifacts
 *       закрывает статусом failed (PLAN-002, задача 14), а вердикт по одним вопросам
 *       модели его пропустил бы;
 *     agent_without_multimodal — есть изображения, а у агента нет способности
 *       multimodal.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { findProjectRoot } from 'workflow-ai/lib/find-root.mjs';
import { printResult } from 'workflow-ai/lib/utils.mjs';
import { rubricLevels } from 'workflow-ai/lib/rubric-levels.mjs';

const PROJECT_DIR = findProjectRoot();
const SCALE_FILE = fileURLToPath(new URL('../knowledge/dod-evidence-scale.md', import.meta.url));
const QUESTION_KINDS = new Set(['prose', 'visual']);

class PrepareError extends Error {
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

function readEvidence(evidenceFile) {
  const file = path.resolve(PROJECT_DIR, evidenceFile);
  if (!fs.existsSync(file)) {
    throw new PrepareError('evidence_missing', `evidence file not found: ${evidenceFile}`);
  }
  let evidence;
  try {
    evidence = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new PrepareError('evidence_invalid', `${evidenceFile}: ${err.message}`);
  }
  if (!Array.isArray(evidence?.items)) {
    throw new PrepareError('evidence_invalid', `${evidenceFile}: no items array`);
  }
  return { file, evidence };
}

function isQuestion(item) {
  return QUESTION_KINDS.has(item.kind) && item.status === 'pending';
}

function questionText(item) {
  return item.kind === 'visual'
    ? `${item.text} — по приложенным изображениям: ${(item.images || []).join(', ')}`
    : item.text;
}

function agentCapabilities() {
  try {
    const parsed = JSON.parse(process.env.WORKFLOW_MODEL_CAPABILITIES || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function prepare(prompt) {
  const evidenceFile = contextValue(prompt, 'evidence_file');
  if (!evidenceFile) {
    throw new PrepareError('evidence_missing', 'no evidence_file in stage context');
  }
  const { file, evidence } = readEvidence(evidenceFile);

  const ticketId = contextValue(prompt, 'ticket_id');
  if (evidence.ticket_id !== ticketId) {
    throw new PrepareError('evidence_mismatch',
      `${evidenceFile} is evidence of ${evidence.ticket_id}, stage context ticket_id is ${ticketId || '(none)'}`);
  }

  const unresolved = evidence.items.filter((item) => item.status !== 'passed' && !isQuestion(item));
  if (unresolved.length > 0) {
    throw new PrepareError('evidence_failed_items',
      `DoD items not passed in ${evidenceFile}: ${unresolved.map((item) => `${item.index} (${item.status})`).join(', ')}`);
  }

  const asked = evidence.items.filter(isQuestion);
  if (asked.length === 0) {
    return { status: 'passed', reason: 'no_questions' };
  }

  const images = [...new Set(asked.filter((item) => item.kind === 'visual').flatMap((item) => item.images || []))];
  if (images.length > 0 && !agentCapabilities().includes('multimodal')) {
    throw new PrepareError('agent_without_multimodal',
      `agent ${process.env.WORKFLOW_MODEL_AGENT || '(unknown)'} has no multimodal capability, evidence has ${images.length} image(s)`);
  }

  const levels = rubricLevels(fs.readFileSync(SCALE_FILE, 'utf8'), SCALE_FILE);
  const request = {
    data: {
      items: evidence.items.filter((item) => item.status !== 'pending'),
      source_refs: evidence.source_refs || [],
      diff: evidence.diff || '',
      ...(evidence.diff_truncated ? { diff_truncated: evidence.diff_truncated } : {}),
      ...(evidence.diff_error ? { diff_error: evidence.diff_error } : {}),
    },
    images,
    questions: asked.map((item) => ({ id: `dod-${item.index}`, text: questionText(item), levels })),
  };

  const requestFile = path.join(path.dirname(file), `${ticketId}.review-request.json`);
  fs.writeFileSync(requestFile, `${JSON.stringify(request, null, 2)}\n`, 'utf8');
  return {
    status: 'ready',
    request_file: path.relative(PROJECT_DIR, requestFile).split(path.sep).join('/'),
  };
}

function main() {
  const prompt = process.argv.slice(2).join(' ');
  try {
    printResult(prepare(prompt));
  } catch (err) {
    if (!(err instanceof PrepareError)) throw err;
    printResult({ status: 'error', reason: err.reason, error: err.message });
  }
}

main();
