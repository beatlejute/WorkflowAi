#!/usr/bin/env node

/**
 * check-report-needed.js — нужен ли новый отчёт, когда работы на доске нет.
 *
 * Стадия-скрипт check-report-needed перед create-report (configs/pipeline.yaml). Без неё
 * каждый запуск пайплайна без работы писал новый отчёт: 2026-09-28 PulseProxy — три
 * отчёта подряд (REPORT-024…026) и начатый четвёртый при доске, не менявшейся с 10:04.
 *
 * Доска — подпись колонок тикетов: `<колонка>/<id>:<updated_at>:<completed_at>` каждого
 * тикета. Эти поля пишут скрипты перемещения, а не агенты: время файла не годится —
 * раннер дописывает строки «Истории работы» тикету из контекста и на стадиях отчёта,
 * а `created_at` нового тикета агент пишет полуночью. Подпись и время запроса отчёта
 * лежат в `.workflow/state/report-gate.json`; скрипт пишет их, когда отправляет на
 * create-report.
 *
 * Исходы:
 *   needed    — доска изменилась со времени последнего отчёта или отчёта нет → create-report;
 *   analyze   — отчёт по этой доске есть, а разбора после него нет (удачного запуска
 *               analyze-report в журнале .workflow/metrics/agent-runs.jsonl) → analyze-report
 *               с `report_id`;
 *   unchanged — отчёт и разбор по этой доске уже есть → конец пайплайна.
 *
 * Файла состояния ещё нет (первый запуск версии) — отчёт считается сделанным по этой
 * доске, если он новее всех `updated_at`/`completed_at` тикетов.
 *
 * Вывод:
 *   ---RESULT---
 *   status: needed | analyze | unchanged
 *   report_id: REPORT-NNN
 *   reason: <почему>
 *   ---RESULT---
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { findProjectRoot } from 'workflow-ai/lib/find-root.mjs';
import { parseFrontmatter, printResult } from 'workflow-ai/lib/utils.mjs';
import { readRunEvents } from 'workflow-ai/lib/agent-runs.mjs';

export const STATE_FILE = '.workflow/state/report-gate.json';

/** Тикеты доски: колонка, id и время из frontmatter, по всем колонкам. */
export function boardTickets(ticketsDir) {
  let columns = [];
  try {
    columns = fs.readdirSync(ticketsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return [];
  }
  const tickets = [];
  for (const column of columns) {
    const dir = path.join(ticketsDir, column);
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
      let frontmatter = {};
      try {
        frontmatter = parseFrontmatter(fs.readFileSync(path.join(dir, file), 'utf8')).frontmatter || {};
      } catch {
        // Нечитаемый тикет — в подписи по имени файла.
      }
      tickets.push({
        column,
        id: String(frontmatter.id || path.basename(file, '.md')),
        updated_at: frontmatter.updated_at ? String(frontmatter.updated_at) : '',
        completed_at: frontmatter.completed_at ? String(frontmatter.completed_at) : '',
      });
    }
  }
  return tickets;
}

export function boardSignature(tickets) {
  const lines = tickets.map((t) => `${t.column}/${t.id}:${t.updated_at}:${t.completed_at}`);
  return crypto.createHash('sha1').update(lines.join('\n')).digest('hex');
}

/** Последний по времени файла отчёт `REPORT-*.md` или null. */
export function latestReport(reportsDir) {
  let files = [];
  try {
    files = fs.readdirSync(reportsDir).filter((f) => /^REPORT-\d+\.md$/.test(f));
  } catch {
    return null;
  }
  let latest = null;
  for (const file of files) {
    const mtimeMs = fs.statSync(path.join(reportsDir, file)).mtimeMs;
    if (!latest || mtimeMs > latest.mtimeMs) latest = { id: path.basename(file, '.md'), mtimeMs };
  }
  return latest;
}

/** Удачный запуск analyze-report, начатый после `sinceMs`, есть в журнале. */
export function analyzedAfter(events, sinceMs) {
  return events.some((e) => e.type === 'run'
    && (e.skill === 'analyze-report' || e.stage === 'analyze-report')
    && e.status === 'ok'
    && Date.parse(e.ts) > sinceMs);
}

/**
 * Решение по доске, отчёту, состоянию и журналу.
 * @returns {{status: 'needed'|'analyze'|'unchanged', report_id?: string, reason: string}}
 */
export function decide({ tickets, report, state, events }) {
  if (!report) return { status: 'needed', reason: 'отчётов нет' };
  const signature = boardSignature(tickets);
  let sameBoard;
  if (state && typeof state.signature === 'string') {
    sameBoard = state.signature === signature && report.mtimeMs > Date.parse(state.requested_at);
  } else {
    const lastMove = Math.max(0, ...tickets.flatMap((t) => [Date.parse(t.updated_at), Date.parse(t.completed_at)]).filter(Number.isFinite));
    sameBoard = report.mtimeMs > lastMove;
  }
  if (!sameBoard) return { status: 'needed', reason: `доска изменилась после ${report.id}` };
  if (analyzedAfter(events, report.mtimeMs)) {
    return { status: 'unchanged', report_id: report.id, reason: `доска не менялась с ${report.id}, разбор по нему есть` };
  }
  return { status: 'analyze', report_id: report.id, reason: `доска не менялась с ${report.id}, разбора по нему нет` };
}

function readState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function main() {
  const root = findProjectRoot();
  const tickets = boardTickets(path.join(root, '.workflow', 'tickets'));
  const report = latestReport(path.join(root, '.workflow', 'reports'));
  const stateFile = path.join(root, STATE_FILE);
  let events = [];
  try {
    events = readRunEvents(root);
  } catch (err) {
    console.error(`[WARN] журнал запусков не прочитан: ${err.message}`);
  }
  const state = readState(stateFile);
  const result = decide({ tickets, report, state, events });
  // needed — подпись доски, для которой сейчас пишется отчёт. Без состояния и с тем же
  // отчётом — подпись этой доски ко времени отчёта: дальше решает она, а не время тикетов.
  const requestedAt = result.status === 'needed' ? new Date()
    : !state ? new Date(report.mtimeMs - 1000) : null;
  if (requestedAt) {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({ signature: boardSignature(tickets), requested_at: requestedAt.toISOString() }, null, 2));
    } catch (err) {
      console.error(`[WARN] ${STATE_FILE} не записан: ${err.message}`);
    }
  }
  console.log(`[INFO] ${result.reason}`);
  printResult({ status: result.status, report_id: result.report_id || '', reason: result.reason });
}

// По имени файла, а не по import.meta.url: через junction .workflow/src/scripts пути
// argv[1] и модуля расходятся (как в check-plan-decomposed.js).
if (process.argv[1] && /check-report-needed(\.js)?$/.test(process.argv[1])) {
  main();
}
