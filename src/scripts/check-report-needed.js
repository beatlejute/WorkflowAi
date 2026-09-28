#!/usr/bin/env node

/**
 * check-report-needed.js — нужен ли новый отчёт, когда работы на доске нет.
 *
 * Стадия-скрипт check-report-needed перед create-report (configs/pipeline.yaml). Без неё
 * каждый запуск пайплайна без работы писал новый отчёт: 2026-09-28 PulseProxy — три
 * отчёта подряд (REPORT-024…026) и начатый четвёртый при доске, не менявшейся с 10:04.
 *
 * Доска — подпись тикетов: `<колонка>/<id>:<updated_at>:<completed_at>` каждого открытого
 * тикета и `final/<id>:<completed_at>` тикета в done/ или archive/. Эти поля пишут скрипты
 * перемещения, а не агенты: время файла не годится — раннер дописывает строки «Истории
 * работы» тикету из контекста и на стадиях отчёта, а `created_at` нового тикета агент
 * пишет полуночью. Готовый тикет — без колонки и updated_at: закрытие плана переносит его
 * в archive/ с новым updated_at, но работы на доске от этого не прибавляется.
 * Подпись и время запроса отчёта лежат в `.workflow/state/report-gate.json`; скрипт
 * пишет их, когда отправляет на create-report. Последний отчёт — `REPORT-NNN` с наибольшим
 * номером (ручная правка старого отчёта его не подменяет), его время — время файла.
 *
 * Исходы:
 *   needed    — доска изменилась со времени последнего отчёта или отчёта нет → create-report;
 *   analyze   — отчёт по этой доске есть, а удачного analyze-report после него в журнале
 *               .workflow/metrics/agent-runs.jsonl нет, или последний разбор нашёл пробелы
 *               (`result_status` не `completed`), а удачного decompose-gaps после него
 *               нет → analyze-report с `report_id`;
 *   close_plan — отчёт и разбор по этой доске есть, последний разбор `completed` →
 *               complete-plan: бесплатный скрипт, повтор ничего не меняет (нет плана —
 *               no_plan, открытые тикеты — not_ready). Так план закрывается, даже если
 *               прогон с разбором `completed` остановили до complete-plan (пауза, снятие
 *               процесса, сбой скрипта): стадии-скрипты событий журнала не пишут, и
 *               узнать, дошёл ли прогон до закрытия, гейту не из чего (ревью, третий раунд);
 *   unchanged — отчёт и разбор по этой доске есть, после последнего разбора с пробелами
 *               было разбиение → конец пайплайна.
 *
 * Время события журнала (`ts`) — время записи, то есть конец запуска.
 *
 * Разбиение после разбора с пробелами обязательно для unchanged: без него пробелы остаются
 * без тикетов. 2026-09-28 PulseProxy: второй разбор прогона нашёл пробел, счётчик
 * plan_iterations дошёл до max, и пайплайн завершился, не запустив decompose-gaps, — а
 * со «разбор есть» следующий запуск тоже завершился бы сразу. Разбор `completed` ведёт в
 * complete-plan, а не в разбиение, и ждать разбиения после него — платный разбор на
 * каждом запуске без работы (ревью 2026-09-28: complete-plan → no_plan, not_ready). У
 * события без `result_status` (раннер до 1.16.6) разбор считается разбором с пробелами.
 *
 * Файла состояния ещё нет (первый запуск версии) — отчёт считается сделанным по этой
 * доске, если он новее всех `updated_at`/`completed_at` открытых тикетов и `completed_at`
 * готовых.
 *
 * Вывод:
 *   ---RESULT---
 *   status: needed | analyze | close_plan | unchanged
 *   report_id: REPORT-NNN
 *   reason: <почему>
 *   ---RESULT---
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { findProjectRoot } from 'workflow-ai/lib/find-root.mjs';
import { normalizePlanId, parseFrontmatter, printResult } from 'workflow-ai/lib/utils.mjs';
import { readRunEvents } from 'workflow-ai/lib/agent-runs.mjs';

export const STATE_FILE = '.workflow/state/report-gate.json';
export const SIGNATURE_FORMAT = 2;

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

const FINAL_COLUMNS = new Set(['done', 'archive']);
// Статусы RESULT create-report, которые configs/pipeline.yaml ведёт мимо разбора.
const REPORT_FAILURES = new Set(['error', 'blocked']);

export function boardSignature(tickets) {
  const lines = tickets
    .map((t) => (FINAL_COLUMNS.has(t.column) ? `final/${t.id}:${t.completed_at}` : `${t.column}/${t.id}:${t.updated_at}:${t.completed_at}`))
    .sort();
  return crypto.createHash('sha1').update(lines.join('\n')).digest('hex');
}

/**
 * Отчёт `REPORT-NNN.md` с наибольшим номером: id, время файла и план из `related_plan`
 * (`planId`, null без поля) — или null.
 */
export function latestReport(reportsDir) {
  let files = [];
  try {
    files = fs.readdirSync(reportsDir).filter((f) => /^REPORT-\d+\.md$/.test(f));
  } catch {
    return null;
  }
  let latest = null;
  for (const file of files) {
    const number = Number(file.match(/^REPORT-(\d+)\.md$/)[1]);
    if (!latest || number > latest.number) latest = { id: path.basename(file, '.md'), number, file };
  }
  if (!latest) return null;
  const file = path.join(reportsDir, latest.file);
  let planId = null;
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
    const relatedPlan = parseFrontmatter(text).frontmatter?.related_plan;
    planId = relatedPlan ? normalizePlanId(String(relatedPlan)) : null;
  } catch {
    // YAML отчёта не разбирается (агент написал неэкранированный заголовок — PulseProxy
    // REPORT-012): поле берётся строкой; нет и её — без плана, закрывать нечего.
    const line = text.match(/^related_plan:[ \t]*["']?([^"'\r\n]+)/m);
    planId = line ? normalizePlanId(line[1].trim()) : null;
  }
  return { id: latest.id, mtimeMs: fs.statSync(file).mtimeMs, planId };
}

/**
 * Последний удачный запуск скила `skill`, записанный после `sinceMs`: `{ts, event}` или
 * null. Решает последний разбор отчёта, а не первый: разбор с пробелами, оставшийся без
 * разбиения (лимит plan_iterations), и следующий разбор `completed` по той же доске иначе
 * давали бы «разбиения нет» на каждом запуске (ревью 2026-09-28, второй раунд).
 */
export function lastOkRunAfter(events, skill, sinceMs, accept = () => true) {
  let last = null;
  for (const e of events) {
    if (e.type !== 'run' || (e.skill !== skill && e.stage !== skill) || e.status !== 'ok' || !accept(e)) continue;
    const ts = Date.parse(e.ts);
    if (ts > sinceMs && (!last || ts >= last.ts)) last = { ts, event: e };
  }
  return last;
}

/**
 * Решение по доске, отчёту, состоянию и журналу.
 * @returns {{status: 'needed'|'analyze'|'close_plan'|'unchanged', report_id?: string, reason: string}}
 */
export function decide({ tickets, report, state, events }) {
  if (!report) return { status: 'needed', reason: 'отчётов нет' };
  const signature = boardSignature(tickets);
  let sameBoard;
  // Время отчёта по этой доске. create-report мог закончиться удачно без нового файла
  // (ветка «данных за период нет» скила, ответ со старым report_id): тогда отчётом для
  // этой подписи считается сам запуск, иначе гейт заказывал бы create-report и разбор на
  // каждом запуске без работы (ревью 2026-09-28, четвёртый раунд). Запуск с RESULT
  // `error` или `blocked` — неудача (класс запуска у него тоже `ok`, код выхода 0): стадия
  // ушла в повтор или в конец, и отчёт по новой доске надо заказать снова (пятый раунд).
  let reportMs = report.mtimeMs;
  if (state && typeof state.signature === 'string') {
    const since = Date.parse(state.requested_at);
    const attempt = lastOkRunAfter(events, 'create-report', since, (e) => !REPORT_FAILURES.has(e.result_status));
    if (attempt) reportMs = Math.max(reportMs, attempt.ts);
    sameBoard = state.signature === signature && reportMs > since;
  } else {
    // Как в подписи: у готового тикета — только completed_at, updated_at переписывает архив.
    const moves = tickets.flatMap((t) => (FINAL_COLUMNS.has(t.column)
      ? [Date.parse(t.completed_at)]
      : [Date.parse(t.updated_at), Date.parse(t.completed_at)]));
    sameBoard = report.mtimeMs > Math.max(0, ...moves.filter(Number.isFinite));
  }
  if (!sameBoard) return { status: 'needed', reason: `доска изменилась после ${report.id}` };
  const analysis = lastOkRunAfter(events, 'analyze-report', reportMs);
  if (!analysis) {
    return { status: 'analyze', report_id: report.id, reason: `доска не менялась с ${report.id}, разбора по нему нет` };
  }
  if (analysis.event.result_status === 'completed') {
    // Закрывается план этого отчёта, а не первый активный: без plan_id complete-plan
    // берёт первый активный план, и повтор закрыл бы следующий план, которого разбор не
    // касался (ревью 2026-09-28, четвёртый раунд).
    if (!report.planId) {
      return { status: 'unchanged', report_id: report.id, reason: `доска не менялась с ${report.id}, разбор — completed, план отчёта не указан` };
    }
    return { status: 'close_plan', report_id: report.id, plan_id: report.planId, reason: `доска не менялась с ${report.id}, разбор по нему — completed` };
  }
  if (!lastOkRunAfter(events, 'decompose-gaps', analysis.ts)) {
    return { status: 'analyze', report_id: report.id, reason: `доска не менялась с ${report.id}, после разбора не было разбиения пробелов` };
  }
  return { status: 'unchanged', report_id: report.id, reason: `доска не менялась с ${report.id}, разбор и разбиение по нему есть` };
}

/**
 * Состояние гейта в формате подписи этой версии или null. Подпись 1.16.4–1.16.5 считала
 * колонку и updated_at готовых тикетов — с нынешней она не сравнима, и такое состояние
 * решается как отсутствующее (по времени тикетов), чтобы смена формата сама не
 * заказывала новый отчёт.
 */
function readState(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    return state && state.signature_format === SIGNATURE_FORMAT ? state : null;
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
      const next = { signature_format: SIGNATURE_FORMAT, signature: boardSignature(tickets), requested_at: requestedAt.toISOString() };
      fs.writeFileSync(stateFile, JSON.stringify(next, null, 2));
    } catch (err) {
      console.error(`[WARN] ${STATE_FILE} не записан: ${err.message}`);
    }
  }
  console.log(`[INFO] ${result.reason}`);
  printResult({ status: result.status, report_id: result.report_id || '', plan_id: result.plan_id || '', reason: result.reason });
}

// По имени файла, а не по import.meta.url: через junction .workflow/src/scripts пути
// argv[1] и модуля расходятся (как в check-plan-decomposed.js).
if (process.argv[1] && /check-report-needed(\.js)?$/.test(process.argv[1])) {
  main();
}
