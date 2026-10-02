#!/usr/bin/env node

/**
 * calc-metrics.js — автоматизированный расчёт метрик для create-report.
 *
 * Реализует алгоритм из algorithms/metric-calculation.md:
 *   1. Velocity (done_count / days_elapsed) — от начала работы по плану: самой ранней
 *      записи «## История работы» тикетов плана (start_source)
 *   2. Plan health (completion_pct - expected_pct) — горизонт только из end_date или
 *      duration_days плана (horizon_source). Срока нет — expected_pct и delta null,
 *      health_status "n/a": прежний горизонт 14 дней по умолчанию выдавал выдуманное
 *      «ожидаемое выполнение» (отчёты 2026-09-29…30: 7,43% и 12,81% от 14 дней)
 *   3. Distribution by type
 *   4. Anomalies detection, включая долю тикетов с возвратами с ревью (review_rework)
 *   5. tickets — строка на каждый тикет плана: время, попытки, строки ❌ «## Ревью»,
 *      записанные дефекты, заметки и Summary результата — источник «Проблем» отчёта;
 *      problem_tickets — компактный список тикетов с возвратами с ревью, записанным
 *      дефектом или попытками со статусом error. Вывод одного вызова — не больше
 *      OUTPUT_BUDGET_CHARS символов: строки tickets, не вошедшие в него, выдаёт вызов
 *      с --from <tickets_next_from>
 *
 * Использование:
 *   node calc-metrics.js <PLAN-NNN> [--from N]
 *
 * Вывод: JSON через маркеры ---RESULT---
 */

import fs from 'fs';
import path from 'path';
import { findProjectRoot } from 'workflow-ai/lib/find-root.mjs';
import { parseFrontmatter, printResult } from 'workflow-ai/lib/utils.mjs';
import { createLogger } from 'workflow-ai/lib/logger.mjs';

const logger = createLogger();

// Корень проекта ищется при запуске (main), а не при импорте: юнит-тест импортирует
// функции разбора из временного каталога без .workflow/.
const TICKET_DIRS = ['done', 'in-progress', 'blocked', 'ready', 'backlog', 'archive'];
const DAY_MS = 1000 * 60 * 60 * 24;
// Доля тикетов плана хотя бы с одной строкой ❌ в «## Ревью», с которой начинается
// аномалия review_rework (algorithms/metric-calculation.md, раздел 4).
const REVIEW_REWORK_THRESHOLD_PCT = 25;
// Обрезка текста в строке тикета: полный текст — в файле тикета.
const DEFECT_TEXT_MAX = 600;
const NOTES_MAX = 200;
const SUMMARY_MAX = 150;
const REVIEW_SUMMARY_MAX = 120;

/**
 * Нормализует ID плана в формат PLAN-NNN
 */
function normalizePlanId(raw) {
  if (!raw) return null;
  const basename = path.basename(raw, '.md');
  const full = basename.match(/^plan-(\d+)$/i);
  if (full) return `PLAN-${String(parseInt(full[1], 10)).padStart(3, '0')}`;
  const num = raw.trim().match(/^(\d+)$/);
  if (num) return `PLAN-${String(parseInt(num[1], 10)).padStart(3, '0')}`;
  return null;
}

/**
 * Собирает все тикеты указанного плана из всех директорий tickets/
 */
function collectPlanTickets(planId, ticketsDir) {
  const tickets = [];
  const warnings = [];

  for (const dirName of TICKET_DIRS) {
    const dir = path.join(ticketsDir, dirName);
    if (!fs.existsSync(dir)) continue;

    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md') && f !== '.gitkeep.md');
    for (const file of files) {
      const filePath = path.join(dir, file);
      let content;
      try {
        content = fs.readFileSync(filePath, 'utf8');
      } catch (e) {
        warnings.push(`Failed to read ${file}: ${e.message}`);
        continue;
      }

      let parsed;
      try {
        parsed = parseFrontmatter(content);
      } catch (e) {
        warnings.push(`Failed to parse frontmatter in ${file}: ${e.message}`);
        continue;
      }

      const { frontmatter } = parsed;
      if (!frontmatter || typeof frontmatter !== 'object') {
        warnings.push(`Invalid frontmatter in ${file}`);
        continue;
      }

      const ticketPlanId = normalizePlanId(frontmatter.parent_plan);
      if (ticketPlanId === normalizePlanId(planId)) {
        tickets.push({
          id: frontmatter.id || file.replace('.md', ''),
          title: frontmatter.title || 'Unknown',
          type: frontmatter.type || 'unknown',
          status: dirName,
          created_at: frontmatter.created_at || null,
          updated_at: frontmatter.updated_at || null,
          completed_at: frontmatter.completed_at || null,
          raw: frontmatter,
          body: parsed.body || ''
        });
      }
    }
  }

  return { tickets, warnings };
}

/**
 * Находит файл плана по ID
 */
function findPlanFile(planId, plansDir) {
  if (!fs.existsSync(plansDir)) return null;
  const files = fs.readdirSync(plansDir).filter(f => f.endsWith('.md'));
  const normalized = normalizePlanId(planId);
  return files.find(f => normalizePlanId(f) === normalized) || null;
}

/**
 * Парсит план и возвращает его метаданные
 */
function parsePlan(planFileName, plansDir) {
  if (!planFileName) return null;
  const planPath = path.join(plansDir, planFileName);
  try {
    const content = fs.readFileSync(planPath, 'utf8');
    const { frontmatter } = parseFrontmatter(content);
    return frontmatter;
  } catch (e) {
    logger.warn(`Failed to parse plan ${planFileName}: ${e.message}`);
    return null;
  }
}

/**
 * 1. Расчёт velocity: done_count / days_elapsed
 */
/**
 * Начало работы по плану для velocity. Черновик плана создаётся раньше начала работы, а
 * created_at тикета бывает заглушкой полуночи, поэтому первым берётся самая ранняя запись
 * «## История работы» тикетов плана (раннер пишет её по завершении запуска агента на
 * тикете, местное время). Записей нет — дата создания плана, затем самая ранняя
 * created_at тикета.
 */
export function velocityStart(tickets, ticketRows, planData) {
  const firstRuns = ticketRows
    .map(r => parseHistoryTime(r.first_run_at))
    .filter(Number.isFinite);
  if (firstRuns.length > 0) return { start: Math.min(...firstRuns), source: 'first_run' };
  if (planData && planData.created_at) {
    const planStart = new Date(planData.created_at).getTime();
    if (Number.isFinite(planStart)) return { start: planStart, source: 'plan_created_at' };
  }
  const created = tickets
    .map(t => t.created_at)
    .filter(Boolean)
    .map(d => new Date(d).getTime())
    .filter(Number.isFinite);
  if (created.length > 0) return { start: Math.min(...created), source: 'ticket_created_at' };
  return { start: null, source: 'none' };
}

export function calcVelocity(tickets, planData, ticketRows = [], now = Date.now()) {
  const doneTickets = tickets.filter(t => t.status === 'done' || t.status === 'archive');
  const doneCount = doneTickets.length;

  const { start, source } = velocityStart(tickets, ticketRows, planData);
  const daysElapsed = start === null ? 0 : Math.max((now - start) / DAY_MS, 1); // минимум 1 день

  const velocityDay = daysElapsed > 0 ? doneCount / daysElapsed : 0;
  const velocityWeek = velocityDay * 7;

  return {
    done_count: doneCount,
    days_elapsed: Math.round(daysElapsed * 100) / 100,
    velocity_day: Math.round(velocityDay * 100) / 100,
    velocity_week: Math.round(velocityWeek * 100) / 100,
    started_at: start === null ? null : new Date(start).toISOString(),
    start_source: source
  };
}

/**
 * 2. Расчёт plan health: completion_pct - expected_pct
 */
export function calcPlanHealth(tickets, planData, now = new Date()) {
  const totalTickets = tickets.length;
  const doneTickets = tickets.filter(t => t.status === 'done' || t.status === 'archive').length;

  const completionPct = totalTickets > 0 ? (doneTickets / totalTickets) * 100 : 0;
  const base = {
    total_tickets: totalTickets,
    done_tickets: doneTickets,
    completion_pct: Math.round(completionPct * 100) / 100
  };

  // Горизонт — только срок плана: end_date или duration_days. Срока нет — plan health не
  // считается: подставленный горизонт даёт «ожидаемое выполнение», которого у плана нет.
  const startDate = planData && planData.created_at ? new Date(planData.created_at) : null;
  let totalDays = null;
  let horizonSource = 'none';
  if (startDate && Number.isFinite(startDate.getTime())) {
    const endDate = planData.end_date ? new Date(planData.end_date) : null;
    if (endDate && Number.isFinite(endDate.getTime())) {
      totalDays = Math.max((endDate - startDate) / DAY_MS, 1);
      horizonSource = 'end_date';
    } else if (Number(planData.duration_days) > 0) {
      totalDays = Number(planData.duration_days);
      horizonSource = 'duration_days';
    }
  }

  if (totalDays === null) {
    return { ...base, expected_pct: null, delta: null, health_status: 'n/a', horizon_source: 'none', horizon_days: null };
  }

  const daysSinceStart = Math.max((now - startDate) / DAY_MS, 0);
  const expectedPct = Math.min((daysSinceStart / totalDays) * 100, 100);
  const delta = completionPct - expectedPct;

  let status;
  if (delta >= 0) {
    status = 'ON_TRACK';
  } else if (delta > -25) {
    status = 'AT_RISK';
  } else {
    status = 'OFF_TRACK';
  }

  return {
    ...base,
    expected_pct: Math.round(expectedPct * 100) / 100,
    delta: Math.round(delta * 100) / 100,
    health_status: status,
    horizon_source: horizonSource,
    horizon_days: Math.round(totalDays * 100) / 100
  };
}

function clip(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)} …` : s;
}

// Текст без HTML-комментариев шаблона и горизонтальных линий; пустой — null.
function cleanText(text, max) {
  if (text === null || text === undefined) return null;
  const s = String(text)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '')
    .trim();
  return s ? clip(s, max) : null;
}

/**
 * Текст раздела уровня `level` (## — 2, ### — 3), заголовок которого совпадает с
 * `titlePattern` (регулярное выражение без якорей), до следующего заголовка того же
 * или старшего уровня. Разделов с таким заголовком несколько — тексты склеиваются.
 * Раздела нет — null.
 */
export function sectionText(body, level, titlePattern) {
  const lines = String(body ?? '').split(/\r?\n/);
  const start = new RegExp(`^#{${level}}\\s+(?:${titlePattern})\\s*$`, 'i');
  const stop = new RegExp(`^#{1,${level}}\\s`);
  const parts = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!start.test(lines[i].trim())) continue;
    const chunk = [];
    for (let j = i + 1; j < lines.length && !stop.test(lines[j]); j += 1) chunk.push(lines[j]);
    parts.push(chunk.join('\n'));
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(c => c.trim());
}

function isSeparatorRow(line) {
  return /^\|[\s:|-]+\|$/.test(line.trim());
}

// Строки таблицы раздела уровня 2: заголовок таблицы — имена колонок в нижнем регистре.
function tableRows(section) {
  const out = { header: null, rows: [] };
  for (const raw of String(section ?? '').split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('|') || !line.endsWith('|') || isSeparatorRow(line)) continue;
    const cells = splitRow(line);
    if (out.header === null) out.header = cells.map(c => c.toLowerCase());
    else out.rows.push(cells);
  }
  return out;
}

/**
 * Вердикт ячейки ревью: passed, failed, skipped или null. «не пройден» — failed. Отметка
 * без вердикта ревью («✅ выполнено человеком») попыткой не считается — как у раннера
 * (getLastReviewStatus, parseReviewSection).
 */
export function normalizeReviewStatus(cell) {
  const s = String(cell ?? '').toLowerCase();
  if (/❌|failed|не пройден/.test(s)) return 'failed';
  if (/passed|✅\s*(пройден|ok)/.test(s)) return 'passed';
  if (/⏭|skipped|пропущен/.test(s)) return 'skipped';
  return null;
}

/**
 * Строки таблицы «## Ревью»: [{date, status, summary}]. Колонки — по заголовку
 * (Статус / Status / Вердикт / Verdict, Самари / Summary), без колонки статуса — первая
 * ячейка с вердиктом.
 */
export function parseReviewRows(body) {
  const { header, rows } = tableRows(sectionText(body, 2, 'Ревью'));
  if (header === null) return [];
  const statusIdx = header.findIndex(n => ['статус', 'status', 'вердикт', 'verdict'].includes(n));
  const summaryIdx = header.findIndex(n => ['самари', 'summary', 'комментарий', 'comment'].includes(n));
  const out = [];
  for (const cells of rows) {
    const status = statusIdx >= 0
      ? normalizeReviewStatus(cells[statusIdx])
      : cells.map(normalizeReviewStatus).find(Boolean) || null;
    if (status) out.push({ date: cells[0] || '', status, summary: summaryIdx >= 0 ? cells[summaryIdx] || '' : '' });
  }
  return out;
}

/**
 * Строки таблицы «## История работы» (раннер пишет по строке на каждый запуск агента на
 * тикете): [{at, status}], at — «YYYY-MM-DD HH:MM:SS», местное время.
 */
export function parseHistoryRows(body) {
  const { header, rows } = tableRows(sectionText(body, 2, 'История работы'));
  if (header === null) return [];
  const timeIdx = header.findIndex(n => ['дата/время', 'дата', 'date', 'время'].includes(n));
  const statusIdx = header.findIndex(n => ['статус', 'status'].includes(n));
  return rows.map(cells => ({
    at: cells[timeIdx >= 0 ? timeIdx : 0] || '',
    status: String(cells[statusIdx >= 0 ? statusIdx : cells.length - 1] || 'unknown').toLowerCase()
  }));
}

// Время строки истории в мс: «YYYY-MM-DD HH:MM:SS» с буквой T и без зоны стандарт
// ECMAScript читает как местное время.
export function parseHistoryTime(value) {
  if (!value) return NaN;
  const s = String(value).trim();
  return new Date(/^\d{4}-\d{2}-\d{2} \d/.test(s) ? s.replace(' ', 'T') : s).getTime();
}

// Запись только об отсутствии дефектов определяется критерием, а не перечнем фраз: после
// снятия выделения markdown, маркеров списка и пунктуации в ней есть слово отрицания и нет
// ни одного слова, кроме отрицаний и слов о самих дефектах и их поиске. «Дефектов не
// обнаружено.», «**Дефектов не обнаружено.**», «- нет» — отсутствие; запись с любым
// предметом («подсказка не совпадает», «не найдено поле X») — дефект.
// Прецедент: закрытый перечень принимал «Дефектов не обнаружено.» за записанный дефект.
const NEGATION_WORD = /^(?:нет|не|ни|никаких|никакие|отсутству\p{L}*|none|no|not|nothing|n\/a)$/u;
const ABSENCE_WORD = /^(?:дефект\p{L}*|расхожден\p{L}*|ошиб\p{L}*|проблем\p{L}*|замечани\p{L}*|баг\p{L}*|нов\p{L}*|найден\p{L}*|обнаружен\p{L}*|выявлен\p{L}*|зафиксирован\p{L}*|был\p{L}*|defects?|issues?|bugs?|problems?|found|detected)$/u;

export function isAbsenceRecord(text) {
  const words = String(text ?? '')
    .toLowerCase()
    .replace(/[*_`~#>]/g, ' ')
    .replace(/[.,;:!?()«»"'—–-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  return words.length > 0
    && words.some(w => NEGATION_WORD.test(w))
    && words.every(w => NEGATION_WORD.test(w) || ABSENCE_WORD.test(w));
}

// Секция результата тикета: подраздел дефектов ищется в ней, чтобы тот же заголовок в
// описании или контексте тикета не читался как записанный результат.
const RESULT_SECTION = 'Результат выполнения(?:\\s.*)?|Result(?:\\s.*)?';

/**
 * Подраздел «### Найденные дефекты» секции результата тикета (секции нет — всего тела).
 * hasSection: false — подраздела нет или он пуст; text: null — записано только
 * отсутствие дефектов.
 */
export function extractRecordedDefects(body) {
  const result = sectionText(body, 2, RESULT_SECTION);
  const text = cleanText(sectionText(result ?? body, 3, 'Найденные дефекты(?:\\s.*)?'), Infinity);
  if (text === null) return { hasSection: false, text: null };
  return { hasSection: true, text: isAbsenceRecord(text) ? null : clip(text, DEFECT_TEXT_MAX) };
}

/**
 * Строка на каждый тикет плана — источник «Проблем» отчёта (узлы P10S4, P10S6, P10G2):
 * первая запись истории, попытки по статусам, возвраты с ревью, записанные дефекты,
 * заметки и Summary результата. Длинный текст обрезан — полный в файле тикета.
 */
export function buildTicketRows(tickets) {
  return tickets.map(t => {
    const history = parseHistoryRows(t.body);
    const attemptStatuses = {};
    for (const h of history) attemptStatuses[h.status] = (attemptStatuses[h.status] || 0) + 1;
    const timed = history.map(h => ({ at: h.at, ms: parseHistoryTime(h.at) })).filter(h => Number.isFinite(h.ms));
    const firstRun = timed.length > 0 ? timed.reduce((a, b) => (b.ms < a.ms ? b : a)).at : null;
    const failed = parseReviewRows(t.body).filter(r => r.status === 'failed');
    const defects = extractRecordedDefects(t.body);
    return {
      id: t.id,
      title: t.title,
      type: t.type,
      status: t.status,
      completed_at: t.completed_at,
      first_run_at: firstRun,
      attempts: history.length,
      attempt_statuses: attemptStatuses,
      review_failed: failed.length,
      review_failed_summaries: failed.map(r => clip(r.summary, REVIEW_SUMMARY_MAX)),
      defects: defects.text,
      defects_section: defects.hasSection,
      notes: cleanText(sectionText(t.body, 3, 'Заметки(?:\\s.*)?'), NOTES_MAX),
      summary: cleanText(sectionText(t.body, 3, 'Summary|Что сделано'), SUMMARY_MAX)
    };
  });
}

/**
 * Тикеты с признаком проблемы — вход полноты «Проблем» (узлы P10S6, P10G2): возвраты с
 * ревью, записанный дефект, попытки со статусом error. Запись компактная и без текста,
 * поэтому список выводится целиком в первом вызове при любом числе страниц tickets.
 */
export function buildProblemTickets(ticketRows) {
  return ticketRows
    .map(r => ({
      id: r.id,
      status: r.status,
      review_failed: r.review_failed,
      defects: Boolean(r.defects),
      error_attempts: (r.attempt_statuses && r.attempt_statuses.error) || 0,
      notes: Boolean(r.notes)
    }))
    .filter(p => p.review_failed > 0 || p.defects || p.error_attempts > 0);
}

/**
 * 3. Distribution by type
 */
function calcDistribution(tickets) {
  const total = tickets.length;
  if (total === 0) return {};

  const byType = {};
  for (const ticket of tickets) {
    const type = ticket.type || 'unknown';
    byType[type] = (byType[type] || 0) + 1;
  }

  const distribution = {};
  for (const [type, count] of Object.entries(byType)) {
    distribution[type] = {
      count,
      pct: Math.round((count / total) * 100 * 100) / 100
    };
  }

  return distribution;
}

/**
 * 4. Anomalies detection
 */
export function detectAnomalies(tickets, velocity, ticketRows = []) {
  const anomalies = [];
  const now = new Date();

  // Velocity drop — нужно сравнить с предыдущим отчётом
  // Пока только zero velocity detection
  if (velocity.velocity_day === 0 && velocity.done_count === 0) {
    anomalies.push({
      type: 'zero_velocity',
      severity: 'HIGH',
      message: 'No tickets completed in the period'
    });
  }

  // Blocked accumulation
  const blockedTickets = tickets.filter(t => t.status === 'blocked');
  const totalTickets = tickets.length;
  if (totalTickets > 0) {
    const blockedRate = (blockedTickets.length / totalTickets) * 100;
    if (blockedRate > 25) {
      anomalies.push({
        type: 'blocked_accumulation',
        severity: 'HIGH',
        message: `Blocked rate ${Math.round(blockedRate * 100) / 100}% > 25% threshold`,
        blocked_count: blockedTickets.length,
        blocked_rate: Math.round(blockedRate * 100) / 100
      });
    }
  }

  // Stale in-progress — tickets with updated_at > 3 days ago
  const staleTickets = tickets.filter(t => {
    if (t.status !== 'in-progress') return false;
    if (!t.updated_at) return true; // нет updated_at = потенциально stale
    const updatedAt = new Date(t.updated_at);
    const daysSinceUpdate = (now - updatedAt) / (1000 * 60 * 60 * 24);
    return daysSinceUpdate > 3;
  });

  for (const ticket of staleTickets) {
    const daysSince = Math.round(((now - new Date(ticket.updated_at)) / (1000 * 60 * 60 * 24)) * 100) / 100;
    anomalies.push({
      type: 'stale_in_progress',
      severity: 'MEDIUM',
      message: `Ticket ${ticket.id} in-progress, last updated ${daysSince} days ago`,
      ticket_id: ticket.id,
      days_stale: daysSince
    });
  }

  // Result without move — in-progress с непустым Result
  const resultWithoutMove = tickets.filter(t => {
    if (t.status !== 'in-progress') return false;
    // Проверяем наличие секции Result / Результат выполнения
    const hasResult = /^##\s*(Результат выполнения|Result)\s*$/m.test(t.body || '');
    if (!hasResult) return false;
    // Проверяем, что секция содержит реальный контент
    const resultMatch = (t.body || '').match(/^##\s*(Результат выполнения|Result)\s*$/m);
    if (!resultMatch) return false;
    const afterResult = (t.body || '').substring(resultMatch.index);
    const nextSection = afterResult.match(/^##\s+/gm);
    const sectionContent = nextSection
      ? afterResult.substring(0, afterResult.search(/^##\s+/gm))
      : afterResult;
    const withoutComments = sectionContent.replace(/<!--[\s\S]*?-->/g, '').trim();
    return withoutComments.length > 0;
  });

  for (const ticket of resultWithoutMove) {
    anomalies.push({
      type: 'result_without_move',
      severity: 'MEDIUM',
      message: `Ticket ${ticket.id} has result but still in-progress`,
      ticket_id: ticket.id
    });
  }

  // Review rework — доля тикетов плана хотя бы с одной строкой ❌ в «## Ревью». Отчёты
  // 2026-09-29…30 писали «аномалий нет» при 23 строках ❌ у 12 из 36 тикетов плана:
  // критерия переделок в разделе 4 не было.
  const reworked = ticketRows.filter(r => r.review_failed > 0);
  if (totalTickets > 0) {
    const reworkRate = (reworked.length / totalTickets) * 100;
    if (reworkRate >= REVIEW_REWORK_THRESHOLD_PCT) {
      anomalies.push({
        type: 'review_rework',
        severity: 'MEDIUM',
        message: `Review rework ${Math.round(reworkRate * 100) / 100}% >= ${REVIEW_REWORK_THRESHOLD_PCT}% threshold`,
        reworked_count: reworked.length,
        rework_rate: Math.round(reworkRate * 100) / 100,
        ticket_ids: reworked.map(r => r.id)
      });
    }
  }

  return anomalies;
}

/**
 * JSON результата: верхний уровень с отступами, массивы problem_tickets и tickets — по
 * строке на элемент.
 */
export function formatResult(result) {
  const marks = {};
  for (const key of ['problem_tickets', 'tickets']) {
    if (Array.isArray(result[key])) marks[key] = `__${key}__`;
  }
  let out = JSON.stringify({ ...result, ...marks }, null, 2);
  for (const [key, mark] of Object.entries(marks)) {
    const rows = result[key];
    const text = rows.length > 0 ? `[\n${rows.map(r => `    ${JSON.stringify(r)}`).join(',\n')}\n  ]` : '[]';
    out = out.replace(`"${mark}"`, () => text);
  }
  return out;
}

// Бюджет вывода одного вызова в символах. Окно вывода команды у агента ограничено (Bash
// Claude Code режет после 30 000 символов): строки плана из 70 тикетов одним блоком
// занимали около 56 000 символов, и хвост массива tickets терялся. Строки, не вошедшие в
// бюджет, выдаёт следующий вызов с --from <tickets_next_from>.
export const OUTPUT_BUDGET_CHARS = 24000;

/**
 * Страница строк от `from`, пока их JSON укладывается в `budget` символов, и хотя бы одна
 * строка. next — номер первой не вошедшей строки или null.
 */
export function pageRows(rows, from, budget) {
  const page = [];
  let used = 0;
  let i = from;
  for (; i < rows.length; i += 1) {
    const size = JSON.stringify(rows[i]).length + 6;
    if (page.length > 0 && used + size > budget) break;
    page.push(rows[i]);
    used += size;
  }
  return { page, next: i < rows.length ? i : null };
}

/**
 * Результат одного вызова: заголовок `head` и страница строк tickets от `from`; вместе —
 * не больше `budget` символов (страница — не меньше одной строки).
 */
export function buildOutput(head, ticketRows, from, budget = OUTPUT_BUDGET_CHARS) {
  const empty = { ...head, tickets_from: from, tickets_next_from: null, tickets: [] };
  const room = Math.max(budget - formatResult(empty).length, 2000);
  const { page, next } = pageRows(ticketRows, from, room);
  return { ...head, tickets_from: from, tickets_next_from: next, tickets: page };
}

/**
 * Номер первой строки tickets из аргументов: `--from N`. Флага нет — 0, N не целое
 * неотрицательное — null.
 */
export function parseFromArg(args) {
  const i = args.indexOf('--from');
  if (i === -1) return 0;
  const n = Number(args[i + 1]);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Основная функция
 */
async function main() {
  const planIdArg = process.argv[2];

  if (!planIdArg) {
    console.error('Ошибка: не указан ID плана');
    console.error('Использование: node calc-metrics.js <PLAN-NNN> [--from N]');
    process.exit(1);
  }

  const planId = normalizePlanId(planIdArg);
  if (!planId) {
    console.error(`Ошибка: невалидный ID плана "${planIdArg}". Ожидается формат PLAN-NNN или число.`);
    process.exit(1);
  }

  const from = parseFromArg(process.argv.slice(3));
  if (from === null) {
    console.error('Ошибка: --from ожидает целое число ≥ 0 — номер первой строки массива tickets');
    process.exit(1);
  }

  logger.info(`Calculating metrics for ${planId}`);

  const projectDir = findProjectRoot();
  const ticketsDir = path.join(projectDir, '.workflow', 'tickets');
  const plansDir = path.join(projectDir, '.workflow', 'plans', 'current');

  // Собираем тикеты
  const { tickets, warnings } = collectPlanTickets(planId, ticketsDir);
  if (tickets.length === 0) {
    logger.warn(`No tickets found for plan ${planId}`);
  }

  // Ищем план
  const planFileName = findPlanFile(planId, plansDir);
  const planData = parsePlan(planFileName, plansDir);

  // Считаем метрики
  const ticketRows = buildTicketRows(tickets);
  const velocity = calcVelocity(tickets, planData, ticketRows);
  const health = calcPlanHealth(tickets, planData);
  const distribution = calcDistribution(tickets);
  const anomalies = detectAnomalies(tickets, velocity, ticketRows);

  // Формируем результат: первый вызов — метрики, problem_tickets и первая страница строк
  // tickets, вызов с --from — только следующая страница.
  const head = from === 0
    ? {
      plan_id: planId,
      total_tickets: tickets.length,
      velocity,
      plan_health: health,
      distribution,
      anomalies,
      warnings: warnings.length > 0 ? warnings : undefined,
      problem_tickets: buildProblemTickets(ticketRows)
    }
    : { plan_id: planId, total_tickets: tickets.length };
  const result = buildOutput(head, ticketRows, from);

  // Вывод через ---RESULT---
  console.log('---RESULT---');
  console.log(formatResult(result));
  console.log('---RESULT---');

  // Дополнительная информация в stderr
  logger.info(`Metrics calculated: ${tickets.length} tickets, ${anomalies.length} anomalies`);
}

// main — только при прямом вызове: юнит-тест импортирует функции разбора. Сравнение по
// имени файла, как в src/scripts/check-anomalies.js: при вызове через ссылку .workflow/src
// import.meta.url и argv[1] расходятся (src/scripts/check-rails-coverage.js).
const entry = process.argv[1] ? process.argv[1].replace(/\\/g, '/') : '';
if (/\/calc-metrics(\.js)?$/.test(entry)) {
  main().catch(err => {
    console.error(`Ошибка: ${err.message}`);
    console.log('---RESULT---');
    console.log(JSON.stringify({ error: err.message }, null, 2));
    console.log('---RESULT---');
    process.exit(1);
  });
}
