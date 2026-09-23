/**
 * pick-next-task-core.js — ядро выбора следующего тикета, пригодное для импорта.
 *
 * Зачем отдельный модуль: pick-next-task.js при импорте ищет корень проекта и сразу
 * запускает main() — он сканирует и ПЕРЕМЕЩАЕТ тикеты, пишет метрики, вызывает
 * process.exit. Импортировать его из замера нельзя, поэтому замер держал рукописную
 * копию выбора и метрик. Копия была легче боевой функции (без дедупликации, условий
 * и зависимостей), то есть охраняла не тот код: регресс в pick-next-task.js она не
 * видела, а расхождение с оригиналом дало бы ложную тревогу.
 *
 * Здесь логика одна. Все пути приходят в контексте (createTicketContext), fs и логгер
 * — тоже: это позволяет замеру считать число операций с диском, а не только время.
 * Модуль намеренно без побочных эффектов при импорте.
 */

import fs from 'fs';
import path from 'path';
import { parseFrontmatter, normalizePlanId } from 'workflow-ai/lib/utils.mjs';

// Одна пустая функция на все три ручки: отдельные стрелки на слот остаются
// непокрытыми и роняют файл ниже порога функций в гейте покрытия.
const noop = () => {};
const SILENT_LOGGER = { info: noop, warn: noop, error: noop };

// Колонки канбан-доски, по которым считаются метрики ревью (порядок сохранён).
export const METRICS_DIR_KEYS = [
  'backlogDir',
  'readyDir',
  'inProgressDir',
  'blockedDir',
  'reviewDir',
  'doneDir',
  'archiveDir',
];

// Колонки, в которых ищется дубль ready-тикета перед его выдачей.
// Список экспортирован, чтобы замер алгоритмической стоимости считал ожидаемое
// число existsSync из него, а не из выписанной руками цифры.
export const DUPLICATE_SCAN_DIR_KEYS = ['doneDir', 'inProgressDir', 'reviewDir', 'blockedDir'];

/**
 * Собирает контекст: пути колонок, логгер и модуль fs.
 *
 * @param {string} projectDir - корень проекта
 * @param {object} [options]
 * @param {object} [options.logger] - приёмник сообщений (info/warn/error)
 * @param {object} [options.fsModule] - модуль fs (подмена для подсчёта операций)
 */
export function createTicketContext(projectDir, { logger = SILENT_LOGGER, fsModule = fs } = {}) {
  const workflowDir = path.join(projectDir, '.workflow');
  const ticketsDir = path.join(workflowDir, 'tickets');

  return {
    projectDir,
    workflowDir,
    ticketsDir,
    backlogDir: path.join(ticketsDir, 'backlog'),
    readyDir: path.join(ticketsDir, 'ready'),
    inProgressDir: path.join(ticketsDir, 'in-progress'),
    blockedDir: path.join(ticketsDir, 'blocked'),
    reviewDir: path.join(ticketsDir, 'review'),
    doneDir: path.join(ticketsDir, 'done'),
    archiveDir: path.join(ticketsDir, 'archive'),
    logger,
    fs: fsModule,
  };
}

/**
 * Проверяет условие (condition) тикета
 */
export function checkCondition(ctx, condition) {
  const { type, value } = condition;

  switch (type) {
    case 'file_exists':
      const filePath = path.isAbsolute(value) ? value : path.join(ctx.projectDir, value);
      return ctx.fs.existsSync(filePath);

    case 'file_not_exists':
      const filePath2 = path.isAbsolute(value) ? value : path.join(ctx.projectDir, value);
      return !ctx.fs.existsSync(filePath2);

    case 'tasks_completed':
      // Проверяет, что указанные задачи выполнены (находятся в done/)
      if (!value || (Array.isArray(value) && value.length === 0)) return true;
      const ids = Array.isArray(value) ? value : [value];
      return ids.every(taskId => {
        const donePath = path.join(ctx.doneDir, `${taskId}.md`);
        const archivePath = path.join(ctx.archiveDir, `${taskId}.md`);
        return ctx.fs.existsSync(donePath) || ctx.fs.existsSync(archivePath);
      });

    case 'date_after':
      return new Date() > new Date(value);

    case 'date_before':
      return new Date() < new Date(value);

    case 'manual_approval':
      // Для ручного подтверждения всегда возвращаем false
      // Требуется явное одобрение
      return false;

    default:
      ctx.logger.warn(`Unknown condition type: ${type}`);
      return true;
  }
}

/**
 * Парсит секцию "## Ревью" тикета и возвращает все записи ревью.
 * @param {string} content - Содержимое тикета
 * @returns {Array<{date: string, status: string, comment: string}>}
 */
export function parseReviewSection(content) {
  if (!content) return [];

  const headerIdx = content.search(/^##\s*Ревью\s*$/m);
  if (headerIdx === -1) return [];

  const bodyStart = content.indexOf('\n', headerIdx);
  if (bodyStart === -1) return [];

  const nextH2 = content.indexOf('\n## ', bodyStart);
  const reviewSection = (nextH2 === -1
    ? content.slice(bodyStart + 1)
    : content.slice(bodyStart + 1, nextH2)).trim();

  const reviews = [];

  const tableRows = reviewSection.split('\n').filter(line => line.trim().startsWith('|'));
  if (tableRows.length >= 2) {
    const dataRows = tableRows.slice(2).filter(row => {
      const cells = row.split('|').map(c => c.trim()).filter(c => c);
      return cells.length >= 2;
    });

    for (const row of dataRows) {
      const cells = row.split('|').map(c => c.trim()).filter(c => c);
      const date = cells[0] || '';
      const statusRaw = cells[1]?.toLowerCase() || '';
      const comment = cells[2] || '';
      let status = null;
      if (statusRaw.includes('passed')) status = 'passed';
      else if (statusRaw.includes('failed')) status = 'failed';
      else if (statusRaw.includes('skipped')) status = 'skipped';

      if (status) {
        reviews.push({ date, status, comment });
      }
    }
  }

  const listItems = reviewSection.split('\n').filter(line => line.trim().match(/^[-*]\s/));
  for (const item of listItems) {
    const trimmed = item.trim();
    const dateMatch = trimmed.match(/^[-*]\s*(\d{4}-\d{2}-\d{2})/);
    const statusMatch = trimmed.match(/:\s*(passed|failed|skipped)\b/i);
    if (dateMatch && statusMatch) {
      reviews.push({
        date: dateMatch[1],
        status: statusMatch[1].toLowerCase(),
        comment: trimmed.replace(/^[-*]\s*\d{4}-\d{2}-\d{2}:\s*(passed|failed|skipped)\b/i, '').trim()
      });
    }
  }

  return reviews;
}

/**
 * Вычисляет метрики ревью-итераций для всех тикетов
 * @returns {object} Метрики: iterations, avgTimeToFirstPassed, failedVsPassed
 */
export function calculateReviewMetrics(ctx) {
  const allDirs = METRICS_DIR_KEYS.map(key => ctx[key]);
  const ticketMetrics = {};
  let totalFailed = 0;
  let totalPassed = 0;
  let firstPassedTimes = [];

  for (const dir of allDirs) {
    if (!ctx.fs.existsSync(dir)) continue;

    const files = ctx.fs.readdirSync(dir).filter(f => f.endsWith('.md') && f !== '.gitkeep.md');

    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const content = ctx.fs.readFileSync(filePath, 'utf8');
        const { frontmatter } = parseFrontmatter(content);
        const ticketId = frontmatter.id || file.replace('.md', '');

        const reviews = parseReviewSection(content);
        if (reviews.length === 0) continue;

        ticketMetrics[ticketId] = reviews.length;

        for (const review of reviews) {
          if (review.status === 'failed') totalFailed++;
          else if (review.status === 'passed') totalPassed++;
        }

        const firstPassed = reviews.find(r => r.status === 'passed');
        if (firstPassed && firstPassed.date) {
          const ticketCreated = new Date(frontmatter.created_at || '1970-01-01');
          const passedDate = new Date(firstPassed.date);
          const daysToPass = Math.floor((passedDate - ticketCreated) / (1000 * 60 * 60 * 24));
          if (daysToPass >= 0) {
            firstPassedTimes.push(daysToPass);
          }
        }
      } catch (e) {
        // Skip errors
      }
    }
  }

  const avgTimeToFirstPassed = firstPassedTimes.length > 0
    ? Math.round(firstPassedTimes.reduce((a, b) => a + b, 0) / firstPassedTimes.length)
    : null;

  return {
    iterations_per_ticket: ticketMetrics,
    total_failed: totalFailed,
    total_passed: totalPassed,
    avg_time_to_first_passed_days: avgTimeToFirstPassed,
    tickets_with_reviews: Object.keys(ticketMetrics).length
  };
}

/**
 * Проверяет зависимости тикета
 */
export function checkDependencies(ctx, dependencies) {
  if (!dependencies || dependencies.length === 0) {
    return true;
  }

  return dependencies.every(depId => {
    const donePath = path.join(ctx.doneDir, `${depId}.md`);
    const archivePath = path.join(ctx.archiveDir, `${depId}.md`);
    return ctx.fs.existsSync(donePath) || ctx.fs.existsSync(archivePath);
  });
}

/**
 * Считывает тикеты из одной колонки.
 * @param {object} ctx - контекст
 * @param {string} dir - директория колонки
 * @param {string} warnLabel - подпись в предупреждении о нечитаемом тикете
 */
export function readTicketsFromDir(ctx, dir, warnLabel = 'ticket') {
  if (!ctx.fs.existsSync(dir)) {
    return [];
  }

  const files = ctx.fs.readdirSync(dir)
    .filter(f => f.endsWith('.md') && f !== '.gitkeep.md');

  const tickets = [];

  for (const file of files) {
    const filePath = path.join(dir, file);
    try {
      const content = ctx.fs.readFileSync(filePath, 'utf8');
      const { frontmatter } = parseFrontmatter(content);

      tickets.push({
        id: frontmatter.id || file.replace('.md', ''),
        frontmatter,
        filePath
      });
    } catch (e) {
      console.error(`[WARN] Failed to read ${warnLabel} ${file}: ${e.message}`);
    }
  }

  return tickets;
}

/**
 * Считывает все тикеты из директории ready/
 */
export function readReadyTickets(ctx) {
  return readTicketsFromDir(ctx, ctx.readyDir, 'ticket');
}

/**
 * Считывает все тикеты из директории review/
 */
export function readReviewTickets(ctx) {
  return readTicketsFromDir(ctx, ctx.reviewDir, 'ticket');
}

/**
 * Считывает все тикеты из директории in-progress/
 */
export function readInProgressTickets(ctx) {
  return readTicketsFromDir(ctx, ctx.inProgressDir, 'in-progress ticket');
}

/**
 * Проверяет, заполнен ли раздел результатов (Summary) в тикете
 */
export function hasFilledResult(body) {
  const resultSectionRegex = /^##\s*(Результат выполнения|Result)\s*$/m;
  const sectionStart = body.search(resultSectionRegex);

  if (sectionStart === -1) {
    return false;
  }

  const nextSectionRegex = /^##\s+/gm;
  nextSectionRegex.lastIndex = sectionStart + 1;
  const nextSectionMatch = nextSectionRegex.exec(body);
  const sectionEnd = nextSectionMatch ? nextSectionMatch.index : body.length;

  const sectionContent = body.substring(sectionStart, sectionEnd);

  const summaryRegex = /^###\s*(Summary|Что сделано)\s*$/m;
  const summaryStart = sectionContent.search(summaryRegex);

  if (summaryStart === -1) {
    return false;
  }

  const nextSubsectionRegex = /^###\s+/gm;
  nextSubsectionRegex.lastIndex = summaryStart + 1;
  const nextSubsectionMatch = nextSubsectionRegex.exec(sectionContent);
  const summaryEnd = nextSubsectionMatch ? nextSubsectionMatch.index : sectionContent.length;

  const summaryContent = sectionContent.substring(summaryStart, summaryEnd);
  const withoutComments = summaryContent.replace(/<!--[\s\S]*?-->/g, '').trim();

  return withoutComments.length > 0;
}

/**
 * Находит завершённые тикеты в in-progress/ (с заполненным Summary)
 */
export function findCompletedInProgress(ctx) {
  if (!ctx.fs.existsSync(ctx.inProgressDir)) {
    return [];
  }

  const files = ctx.fs.readdirSync(ctx.inProgressDir)
    .filter(f => f.endsWith('.md') && f !== '.gitkeep.md');

  const completed = [];

  for (const file of files) {
    const filePath = path.join(ctx.inProgressDir, file);
    try {
      const content = ctx.fs.readFileSync(filePath, 'utf8');
      const { frontmatter, body } = parseFrontmatter(content);

      if (!hasFilledResult(body)) {
        continue;
      }

      completed.push({
        id: frontmatter.id || file.replace('.md', ''),
        frontmatter,
        filePath
      });
    } catch (e) {
      console.error(`[WARN] Failed to read in-progress ticket ${file}: ${e.message}`);
    }
  }

  return completed;
}

export function filterByPlan(tickets, planId) {
  if (!planId) return tickets;
  return tickets.filter(t => normalizePlanId(t.frontmatter.parent_plan) === planId);
}

/**
 * Выбирает следующий тикет для выполнения
 */
export function pickNextTicket(ctx, planId) {
  const { logger } = ctx;
  const tickets = filterByPlan(readReadyTickets(ctx), planId);

  if (tickets.length === 0) {
    // Если ready/ пуст, проверяем review/ — нужно завершить ревью
    let reviewTickets = filterByPlan(readReviewTickets(ctx), planId);

    if (reviewTickets.length === 0) {
      // Нет тикетов ни в ready/, ни в review/ — проверяем in-progress/
      // на завершённые тикеты (с заполненным Summary)
      const completedInProgress = filterByPlan(findCompletedInProgress(ctx), planId);
      if (completedInProgress.length > 0) {
        const first = completedInProgress[0];
        logger.info(`Found completed ticket in in-progress/: ${first.id}`);
        return {
          status: 'completed_in_progress',
          ticket_id: first.id
        };
      }

      // Нет завершённых — проверяем незавершённые тикеты в in-progress/
      const allInProgress = filterByPlan(readInProgressTickets(ctx), planId);
      if (allInProgress.length > 0) {
        const first = allInProgress[0];
        logger.info(`Found incomplete ticket in in-progress/: ${first.id}`);
        return {
          status: 'in_progress',
          ticket_id: first.id,
          priority: first.frontmatter.priority,
          title: first.frontmatter.title,
          type: first.frontmatter.type,
          required_capabilities: JSON.stringify(first.frontmatter.required_capabilities || [])
        };
      }
    }

    if (reviewTickets.length > 0) {
      return {
        status: 'in_review',
        ticket_id: reviewTickets[0].id,
        priority: reviewTickets[0].frontmatter.priority,
        title: reviewTickets[0].frontmatter.title,
        type: reviewTickets[0].frontmatter.type,
        required_capabilities: JSON.stringify(reviewTickets[0].frontmatter.required_capabilities || [])
      };
    }
    return { status: 'empty', reason: 'No tickets in ready/' };
  }

  // Фильтрация: разделяем на обычные и human с проверкой условий/зависимостей
  const eligibleNonHuman = [];
  const humanCandidates = [];

  for (const ticket of tickets) {
    const { frontmatter } = ticket;

    // Проверка условий
    const conditions = frontmatter.conditions || [];
    const conditionsMet = conditions.every(condition => checkCondition(ctx, condition));
    if (!conditionsMet) {
      continue;
    }

    // Проверка зависимостей
    const dependencies = frontmatter.dependencies || [];
    const depsMet = checkDependencies(ctx, dependencies);
    if (!depsMet) {
      continue;
    }

    // Обнаружение и удаление дубликатов: тикет не должен существовать в других колонках
    const ticketFileName = `${ticket.id}.md`;
    const otherDirs = DUPLICATE_SCAN_DIR_KEYS.map(key => ctx[key]);
    const duplicateDir = otherDirs.find(dir =>
      ctx.fs.existsSync(path.join(dir, ticketFileName))
    );
    if (duplicateDir) {
      const dirName = path.basename(duplicateDir);
      logger.warn(`Duplicate detected: ${ticket.id} exists in ready/ and ${dirName}/. Moving ready/ copy to archive/`);
      const archivePath = path.join(ctx.archiveDir, ticketFileName);
      try {
        ctx.fs.mkdirSync(ctx.archiveDir, { recursive: true });
        ctx.fs.renameSync(ticket.filePath, archivePath);
      } catch (err) {
        logger.error(`Failed to archive duplicate ${ticket.id}: ${err.message}`);
      }
      continue;
    }

    // Разделение по типу
    if (frontmatter.type === 'human') {
      humanCandidates.push(ticket);
    } else {
      eligibleNonHuman.push(ticket);
    }
  }

  // Имеются ли обычные (non-human) готовые тикеты — старший приоритет
  if (eligibleNonHuman.length > 0) {
    eligibleNonHuman.sort((a, b) => {
      const priorityA = a.frontmatter.priority || 999;
      const priorityB = b.frontmatter.priority || 999;

      if (priorityA !== priorityB) {
        return priorityA - priorityB;
      }

      const dateA = new Date(a.frontmatter.created_at || '9999-12-31');
      const dateB = new Date(b.frontmatter.created_at || '9999-12-31');
      return dateA - dateB;
    });

    const selected = eligibleNonHuman[0];
    return {
      status: 'found',
      ticket_id: selected.id,
      priority: selected.frontmatter.priority,
      title: selected.frontmatter.title,
      type: selected.frontmatter.type,
      required_capabilities: JSON.stringify(selected.frontmatter.required_capabilities || [])
    };
  }

  // Если есть созревшие human-тикеты — новый статус human_ready (для manual-gate)
  if (humanCandidates.length > 0) {
    humanCandidates.sort((a, b) => {
      const priorityA = a.frontmatter.priority || 999;
      const priorityB = b.frontmatter.priority || 999;

      if (priorityA !== priorityB) {
        return priorityA - priorityB;
      }

      const dateA = new Date(a.frontmatter.created_at || '9999-12-31');
      const dateB = new Date(b.frontmatter.created_at || '9999-12-31');
      return dateA - dateB;
    });

    const selected = humanCandidates[0];
    return {
      status: 'human_ready',
      ticket_id: selected.id,
      priority: selected.frontmatter.priority,
      title: selected.frontmatter.title,
      pending_count: humanCandidates.length
    };
  }

  return {
    status: 'empty',
    reason: 'No eligible non-human tickets (and no ready human tickets)'
  };
}
