#!/usr/bin/env node

/**
 * calc-plan-metrics.js — аналитические метрики плана для analyze-report.
 *
 * Рассчитывает:
 *   1. Distribution by status
 *   2. Completion %
 *   3. Avg time-to-done и time_anomalies — тикеты, у которых completed_at раньше
 *      created_at: в среднее они не входят и выдаются явно, а не отбрасываются молча
 *   4. Blocked rate
 *   5. Метрики ревью по таблице «## Ревью» тикета: reviewed, passed_first,
 *      first_pass_rate, rework_count, rework_rate, failed_reviews_total, reworked_tickets.
 *      Попытка — строка с вердиктом passed или failed (skipped попыткой не считается),
 *      первая попытка — первая такая строка, каждая строка failed — возврат, знаменатель
 *      долей — reviewed (algorithms/progress-assessment.md, шаг 3). Прежний подсчёт искал
 *      слово «повторная» в поле notes frontmatter, которого у тикетов нет, и всегда давал 0
 *      (аудит 2026-09-21, находка 8 (B-6); разборы 2026-09-29…30 — 0 при 23 строках
 *      failed у 12 тикетов плана).
 *   6. Записанные дефекты: подраздел «### Найденные дефекты» секции результата
 *      выполненного тикета (done, archive, review) — recorded_defects, кроме записи только
 *      об отсутствии дефектов (isAbsenceRecord); выполненные тикеты без этого подраздела —
 *      defects_section_missing (узел P10S13 разбора). Текст дефекта и Самари строк ❌
 *      обрезаются — полный текст в файле тикета.
 *
 * Массивы выводятся строкой на элемент; вывод больше OUTPUT_BUDGET_CHARS укорачивает
 * тексты (texts_shortened), ID и числа остаются полными.
 *
 * Использование:
 *   node calc-plan-metrics.js <PLAN-NNN>
 *
 * Вывод: JSON через маркеры ---RESULT---
 */

import fs from 'fs';
import path from 'path';
import { findProjectRoot } from 'workflow-ai/lib/find-root.mjs';
import { parseFrontmatter } from 'workflow-ai/lib/utils.mjs';
import { createLogger } from 'workflow-ai/lib/logger.mjs';

const logger = createLogger();

// Корень проекта ищется при запуске (main), а не при импорте: юнит-тест импортирует
// функции разбора из временного каталога без .workflow/.
// review/ — тикеты с записанным результатом на ревью: без каталога total плана занижен
// (аудит 2026-09-21, находка 9).
const TICKET_DIRS = ['done', 'review', 'in-progress', 'blocked', 'ready', 'backlog', 'archive'];
// Выполненные тикеты — результат записан, дефекты из него читает разбор.
const COMPLETED_DIRS = ['done', 'archive', 'review'];

function normalizePlanId(raw) {
  if (!raw) return null;
  const basename = path.basename(raw, '.md');
  const full = basename.match(/^plan-(\d+)$/i);
  if (full) return `PLAN-${String(parseInt(full[1], 10)).padStart(3, '0')}`;
  const num = raw.trim().match(/^(\d+)$/);
  if (num) return `PLAN-${String(parseInt(num[1], 10)).padStart(3, '0')}`;
  return null;
}

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

function findPlanFile(planId, plansDir) {
  if (!fs.existsSync(plansDir)) return null;
  const files = fs.readdirSync(plansDir).filter(f => f.endsWith('.md'));
  const normalized = normalizePlanId(planId);
  return files.find(f => normalizePlanId(f) === normalized) || null;
}

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

function calcDistributionByStatus(tickets) {
  const distribution = {};
  for (const dirName of TICKET_DIRS) {
    const count = tickets.filter(t => t.status === dirName).length;
    if (count > 0) {
      distribution[dirName] = count;
    }
  }
  return distribution;
}

function calcCompletionPct(tickets) {
  const total = tickets.length;
  const doneCount = tickets.filter(t => t.status === 'done' || t.status === 'archive').length;
  return total > 0 ? Math.round((doneCount / total) * 100 * 100) / 100 : 0;
}

function calcAvgTimeToDone(tickets) {
  const doneTickets = tickets.filter(t => t.status === 'done' || t.status === 'archive');
  const times = [];

  for (const ticket of doneTickets) {
    if (ticket.created_at && ticket.completed_at) {
      const created = new Date(ticket.created_at);
      const completed = new Date(ticket.completed_at);
      const diffMs = completed.getTime() - created.getTime();
      const diffDays = diffMs / (1000 * 60 * 60 * 24);
      if (diffDays >= 0) {
        times.push(diffDays);
      }
    }
  }

  if (times.length === 0) {
    return null;
  }

  const avg = times.reduce((sum, d) => sum + d, 0) / times.length;
  return Math.round(avg * 100) / 100;
}

function calcBlockedRate(tickets) {
  const total = tickets.length;
  const blockedCount = tickets.filter(t => t.status === 'blocked').length;
  return total > 0 ? Math.round((blockedCount / total) * 100 * 100) / 100 : 0;
}

/**
 * Тикеты done/archive, у которых completed_at раньше created_at: время выполнения у них
 * не считается (calcAvgTimeToDone), но и молча не пропадает — это дефект данных тикета.
 */
export function calcTimeAnomalies(tickets) {
  const anomalies = [];
  for (const ticket of tickets) {
    if (ticket.status !== 'done' && ticket.status !== 'archive') continue;
    if (!ticket.created_at || !ticket.completed_at) continue;
    const diffMs = new Date(ticket.completed_at).getTime() - new Date(ticket.created_at).getTime();
    if (diffMs < 0) {
      anomalies.push({ id: ticket.id, created_at: ticket.created_at, completed_at: ticket.completed_at });
    }
  }
  return anomalies;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function clip(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)} …` : s;
}

// Вывод команды у агента ограничен окном: Самари строк ❌ и текст записанного дефекта
// обрезаются, полный текст — в файле тикета (reworked_tickets плана из 70 тикетов с
// Самари по 300 символов занимал около 14 000 символов).
const REVIEW_SUMMARY_MAX = 160;
const DEFECT_TEXT_MAX = 600;

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

const REVIEW_STATUS_COLUMNS = ['статус', 'status', 'вердикт', 'verdict'];
const REVIEW_SUMMARY_COLUMNS = ['самари', 'summary', 'комментарий', 'comment'];

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim());
}

function isSeparatorRow(line) {
  return /^\|[\s:|-]+\|$/.test(line.trim());
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
 * Строки таблицы «## Ревью» тикета: [{date, status, summary}] в порядке записи.
 * Колонки ищутся по заголовку (Статус / Status / Вердикт / Verdict, Самари / Summary);
 * без колонки статуса — первая ячейка с вердиктом. Прежний формат списком
 * («- 2026-01-01: passed …») тоже читается.
 */
export function parseReviewRows(body) {
  const section = sectionText(body, 2, 'Ревью');
  if (section === null) return [];
  const rows = [];
  let header = null;
  for (const raw of section.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('|') && line.endsWith('|')) {
      if (isSeparatorRow(line)) continue;
      const cells = splitRow(line);
      if (header === null) {
        const names = cells.map((c) => c.toLowerCase());
        header = {
          status: names.findIndex((n) => REVIEW_STATUS_COLUMNS.includes(n)),
          summary: names.findIndex((n) => REVIEW_SUMMARY_COLUMNS.includes(n)),
        };
        continue;
      }
      const status = header.status >= 0
        ? normalizeReviewStatus(cells[header.status])
        : cells.map(normalizeReviewStatus).find(Boolean) || null;
      if (!status) continue;
      rows.push({ date: cells[0] || '', status, summary: header.summary >= 0 ? cells[header.summary] || '' : '' });
      continue;
    }
    const item = line.match(/^[-*]\s*(\d{4}-\d{2}-\d{2})\s*:\s*(passed|failed|skipped)\b\s*(.*)$/i);
    if (item) rows.push({ date: item[1], status: item[2].toLowerCase(), summary: item[3].trim() });
  }
  return rows;
}

/**
 * Метрики ревью тикетов плана (algorithms/progress-assessment.md, шаг 3): попытка —
 * строка passed или failed, первая попытка — первая такая строка, строка failed — возврат,
 * знаменатель first_pass_rate и rework_rate — reviewed.
 */
export function calcReviewMetrics(tickets) {
  let reviewed = 0;
  let passedFirst = 0;
  let failedTotal = 0;
  const reworked = [];
  for (const ticket of tickets) {
    const attempts = parseReviewRows(ticket.body).filter((r) => r.status === 'passed' || r.status === 'failed');
    if (attempts.length === 0) continue;
    reviewed += 1;
    if (attempts[0].status === 'passed') passedFirst += 1;
    const failed = attempts.filter((r) => r.status === 'failed');
    failedTotal += failed.length;
    if (failed.length > 0) {
      reworked.push({
        id: ticket.id,
        status: ticket.status,
        failed: failed.length,
        rows: failed.map((r) => ({ date: r.date, summary: clip(r.summary, REVIEW_SUMMARY_MAX) })),
      });
    }
  }
  return {
    reviewed,
    passed_first: passedFirst,
    first_pass_rate: reviewed > 0 ? round2((passedFirst / reviewed) * 100) : null,
    rework_count: reworked.length,
    rework_rate: reviewed > 0 ? round2((reworked.length / reviewed) * 100) : null,
    failed_reviews_total: failedTotal,
    reworked_tickets: reworked,
  };
}

// Запись только об отсутствии дефектов определяется критерием, а не перечнем фраз: после
// снятия выделения markdown, маркеров списка и пунктуации в ней есть слово отрицания и нет
// ни одного слова, кроме отрицаний и слов о самих дефектах и их поиске. «Дефектов не
// обнаружено.», «**Дефектов не обнаружено.**», «- нет» — отсутствие; запись с любым
// предметом («подсказка не совпадает», «не найдено поле X») — дефект, его разбирает узел.
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
    && words.some((w) => NEGATION_WORD.test(w))
    && words.every((w) => NEGATION_WORD.test(w) || ABSENCE_WORD.test(w));
}

// Секция результата тикета: подраздел дефектов ищется в ней, чтобы тот же заголовок в
// описании или контексте тикета не читался как записанный результат.
const RESULT_SECTION = 'Результат выполнения(?:\\s.*)?|Result(?:\\s.*)?';

/**
 * Подраздел «### Найденные дефекты» секции результата тикета (секции нет — всего тела).
 * hasSection: false — подраздела нет или он пуст (одни комментарии шаблона). text: null —
 * записано только отсутствие дефектов.
 */
export function extractRecordedDefects(body) {
  const result = sectionText(body, 2, RESULT_SECTION);
  const section = sectionText(result ?? body, 3, 'Найденные дефекты(?:\\s.*)?');
  if (section === null) return { hasSection: false, text: null };
  const text = section
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '')
    .trim();
  if (!text) return { hasSection: false, text: null };
  return { hasSection: true, text: isAbsenceRecord(text) ? null : text };
}

/**
 * Записанные дефекты выполненных тикетов плана (узел P10S13 разбора): recorded_defects —
 * тикеты с дефектами в подразделе (текст обрезан до DEFECT_TEXT_MAX, text_clipped),
 * defects_section_missing — выполненные тикеты без подраздела (разбор читает их секцию
 * результата целиком).
 */
export function calcRecordedDefects(tickets) {
  const recorded = [];
  const missing = [];
  for (const ticket of tickets) {
    if (!COMPLETED_DIRS.includes(ticket.status)) continue;
    const { hasSection, text } = extractRecordedDefects(ticket.body);
    if (!hasSection) {
      missing.push({ id: ticket.id, type: ticket.type, status: ticket.status });
    } else if (text) {
      recorded.push({
        id: ticket.id,
        type: ticket.type,
        status: ticket.status,
        completed_at: ticket.completed_at,
        text: clip(text, DEFECT_TEXT_MAX),
        ...(text.length > DEFECT_TEXT_MAX ? { text_clipped: true } : {}),
      });
    }
  }
  return { recorded_defects: recorded, defects_section_missing: missing };
}

// Массивы, которые выводятся строкой на элемент: с отступами JSON.stringify(null, 2)
// вложенные строки ❌ плана из 70 тикетов занимали 23 400 символов против 17 000.
const LINE_ARRAYS = ['time_anomalies', 'reworked_tickets', 'recorded_defects', 'defects_section_missing'];

/**
 * JSON результата: верхний уровень с отступами, массивы LINE_ARRAYS — по строке на элемент.
 */
export function formatResult(result) {
  const marks = {};
  for (const key of LINE_ARRAYS) {
    if (Array.isArray(result[key])) marks[key] = `__${key}__`;
  }
  let out = JSON.stringify({ ...result, ...marks }, null, 2);
  for (const [key, mark] of Object.entries(marks)) {
    const rows = result[key];
    const text = rows.length > 0 ? `[\n${rows.map((r) => `    ${JSON.stringify(r)}`).join(',\n')}\n  ]` : '[]';
    out = out.replace(`"${mark}"`, () => text);
  }
  return out;
}

// Бюджет вывода в символах: окно вывода команды у агента ограничено (Bash Claude Code
// режет после 30 000 символов). Вывод больше бюджета укорачивает Самари строк ❌ и тексты
// дефектов (texts_shortened), ID и числа остаются полными — полный текст в файле тикета.
export const OUTPUT_BUDGET_CHARS = 24000;
const SHORT_SUMMARY_MAX = 60;
const SHORT_DEFECT_MAX = 200;

export function fitResult(result, budget = OUTPUT_BUDGET_CHARS) {
  const full = formatResult(result);
  if (full.length <= budget) return full;
  return formatResult({
    ...result,
    texts_shortened: true,
    reworked_tickets: (result.reworked_tickets || []).map((t) => ({
      ...t,
      rows: t.rows.map((r) => ({ ...r, summary: clip(r.summary, SHORT_SUMMARY_MAX) })),
    })),
    recorded_defects: (result.recorded_defects || []).map((d) => ({
      ...d,
      text: clip(d.text, SHORT_DEFECT_MAX),
      ...(d.text_clipped || d.text.length > SHORT_DEFECT_MAX ? { text_clipped: true } : {}),
    })),
  });
}

async function main() {
  const planIdArg = process.argv[2];

  if (!planIdArg) {
    console.error('Ошибка: не указан ID плана');
    console.error('Использование: node calc-plan-metrics.js <PLAN-NNN>');
    process.exit(1);
  }

  const planId = normalizePlanId(planIdArg);
  if (!planId) {
    console.error(`Ошибка: невалидный ID плана "${planIdArg}". Ожидается формат PLAN-NNN или число.`);
    process.exit(1);
  }

  logger.info(`Calculating analytics for ${planId}`);

  const projectDir = findProjectRoot();
  const ticketsDir = path.join(projectDir, '.workflow', 'tickets');
  const plansDir = path.join(projectDir, '.workflow', 'plans', 'current');

  const { tickets, warnings } = collectPlanTickets(planId, ticketsDir);
  if (tickets.length === 0) {
    logger.warn(`No tickets found for plan ${planId}`);
  }

  const planFileName = findPlanFile(planId, plansDir);
  const planData = parsePlan(planFileName, plansDir);

  const distribution = calcDistributionByStatus(tickets);
  const completionPct = calcCompletionPct(tickets);
  const avgTimeToDone = calcAvgTimeToDone(tickets);
  const timeAnomalies = calcTimeAnomalies(tickets);
  const blockedRate = calcBlockedRate(tickets);
  const review = calcReviewMetrics(tickets);
  const defects = calcRecordedDefects(tickets);

  const result = {
    plan_id: planId,
    total_tickets: tickets.length,
    distribution,
    completion_pct: completionPct,
    avg_time_to_done: avgTimeToDone,
    avg_time_to_done_unit: 'days',
    time_anomalies: timeAnomalies,
    blocked_rate: blockedRate,
    blocked_rate_unit: 'pct',
    reviewed: review.reviewed,
    passed_first: review.passed_first,
    first_pass_rate: review.first_pass_rate,
    first_pass_rate_unit: 'pct',
    rework_count: review.rework_count,
    rework_rate: review.rework_rate,
    rework_rate_unit: 'pct',
    failed_reviews_total: review.failed_reviews_total,
    reworked_tickets: review.reworked_tickets,
    recorded_defects: defects.recorded_defects,
    defects_section_missing: defects.defects_section_missing,
    plan_data: planData ? {
      title: planData.title,
      status: planData.status
    } : null,
    warnings: warnings.length > 0 ? warnings : undefined
  };

  console.log('---RESULT---');
  console.log(fitResult(result));
  console.log('---RESULT---');

  logger.info(`Analytics calculated: ${tickets.length} tickets`);
}

// main — только при прямом вызове: юнит-тест импортирует функции разбора. Сравнение по
// имени файла, как в src/scripts/check-anomalies.js: при вызове через ссылку .workflow/src
// import.meta.url и argv[1] расходятся (src/scripts/check-rails-coverage.js).
const entry = process.argv[1] ? process.argv[1].replace(/\\/g, '/') : '';
if (/\/calc-plan-metrics(\.js)?$/.test(entry)) {
  main().catch(err => {
    console.error(`Ошибка: ${err.message}`);
    console.log('---RESULT---');
    console.log(JSON.stringify({ error: err.message }, null, 2));
    console.log('---RESULT---');
    process.exit(1);
  });
}