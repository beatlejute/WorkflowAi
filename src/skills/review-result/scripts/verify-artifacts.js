#!/usr/bin/env node

/**
 * verify-artifacts.js — механическая предпроверка тикета перед AI-ревью.
 *
 * Парсит тикет и проверяет:
 * - Существование файлов из секции "Изменённые файлы"
 * - DoD completion %
 * - Заполненность секции Result (Summary)
 *
 * Использование (как стейдж пайплайна):
 *   node verify-artifacts.js "<prompt>"
 *   Парсит ticket_id из Context-блока в промпте, резолвит в .workflow/tickets/review/{id}.md
 *
 * Использование (как standalone-скрипт):
 *   node verify-artifacts.js <path-to-ticket>
 *   node verify-artifacts.js <TICKET-ID>
 *
 * Вывод (для runner'а):
 *   ---RESULT---
 *   status: passed|failed
 *   dod_completion_pct: <int>
 *   result_filled: <bool>
 *   missing_files: <comma-separated list or empty>
 *   ---RESULT---
 */

import fs from 'fs';
import path from 'path';
import { findProjectRoot } from 'workflow-ai/lib/find-root.mjs';
import { parseFrontmatter } from 'workflow-ai/lib/utils.mjs';

const PROJECT_DIR = findProjectRoot();
const TICKETS_DIR = path.join(PROJECT_DIR, '.workflow', 'tickets');
const REVIEW_STATUSES = ['review', 'in-progress', 'done', 'ready', 'backlog'];

function parseChangedFiles(body) {
  const files = [];
  const changedFilesRegex = /^###\s*(?:Изменённые файлы|Changed files)\s*$/gm;
  const match = changedFilesRegex.exec(body);

  if (!match) return files;

  // Граница H3-секции — следующий H3 ИЛИ H2 (что встретится раньше),
  // иначе захватываем соседние подзаголовки вроде "### Время выполнения",
  // где в backticks лежат команды и цитаты, которые парсер принимает за пути.
  const startIdx = match.index + match[0].length;
  const nextH3 = body.indexOf('\n### ', startIdx);
  const nextH2 = body.indexOf('\n## ', startIdx);
  const candidates = [nextH3, nextH2].filter((i) => i !== -1);
  const sectionEnd = candidates.length > 0 ? Math.min(...candidates) : body.length;
  const sectionContent = body.substring(startIdx, sectionEnd);

  // Пути принимаем только из строк-буллетов ("- `path`" или "* `path`"):
  // это страхует от ложных срабатываний на цитатах/командах в инлайн-коде.
  const bulletFileRegex = /^[-*]\s+`([^`]+)`/gm;
  let fileMatch;
  while ((fileMatch = bulletFileRegex.exec(sectionContent)) !== null) {
    files.push(stripLineSuffix(fileMatch[1]));
  }

  return files;
}

// Поддержка отраслевой нотации ссылок на код: `path:line`, `path:start-end`.
// Суффикс указывает на строки в файле, но не является частью имени файла —
// отрезаем его перед проверкой существования на диске. Не трогаем `C:\...` на
// Windows (после двоеточия идёт не число, а разделитель пути).
function stripLineSuffix(filePath) {
  const match = filePath.match(/^(.*?):(\d+)(?:-\d+)?$/);
  return match ? match[1] : filePath;
}

function checkFilesExist(filePaths, workStartTime) {
  const ticketWorkStart = workStartTime ? new Date(workStartTime) : null;
  return filePaths.map(filePath => {
    const fullPath = path.isAbsolute(filePath) ? filePath : path.join(PROJECT_DIR, filePath);
    const exists = fs.existsSync(fullPath);

    if (!exists) {
      return { path: filePath, exists: false, unchanged: false };
    }

    if (!ticketWorkStart) {
      return { path: filePath, exists: true, unchanged: false };
    }

    const stats = fs.statSync(fullPath);
    const fileMtime = new Date(stats.mtime);
    const unchanged = fileMtime < ticketWorkStart;

    return { path: filePath, exists: true, unchanged };
  });
}

function parseDoDCompletion(body) {
  // Канонический формат в этом проекте — "## Критерии готовности (Definition of Done)",
  // но поддерживаем и чистые варианты (обе локали, с/без уточнения в скобках).
  const dodSectionRegex = /^##\s*(?:Критерии готовности|Definition of Done)(?:\s*\([^)]*\))?\s*$/gm;
  const match = dodSectionRegex.exec(body);
  
  if (!match) return { checked: 0, completed: 0, percentage: 0 };
  
  const startIdx = match.index + match[0].length;
  const nextH2 = body.indexOf('\n## ', startIdx);
  const sectionEnd = nextH2 === -1 ? body.length : nextH2;
  const sectionContent = body.substring(startIdx, sectionEnd);
  
  const checkedBoxes = (sectionContent.match(/\[x\]/gi) || []).length;
  const totalBoxes = (sectionContent.match(/\[ \]|\[x\]/gi) || []).length;
  
  const percentage = totalBoxes > 0 ? Math.round((checkedBoxes / totalBoxes) * 100) : 0;
  
  return {
    checked: totalBoxes,
    completed: checkedBoxes,
    percentage
  };
}

function checkResultSection(body) {
  // Порядок альтернатив важен: «Результат выполнения» перед «Результат»,
  // чтобы более длинный вариант матчился первым.
  const resultSectionRegex = /^##\s*(Результат выполнения|Результат|Result)\s*$/m;
  const sectionMatch = resultSectionRegex.exec(body);

  if (!sectionMatch) return { exists: false, summaryFilled: false };

  const startIdx = sectionMatch.index + sectionMatch[0].length;
  const nextH2 = body.indexOf('\n## ', startIdx);
  const sectionEnd = nextH2 === -1 ? body.length : nextH2;
  const sectionContent = body.substring(startIdx, sectionEnd);

  // Сначала пытаемся найти явную подсекцию Summary
  const summaryRegex = /^###\s*(Summary|Что сделано)\s*$/m;
  const summaryMatch = summaryRegex.exec(sectionContent);

  let summaryContent;
  if (summaryMatch) {
    // Есть явная подсекция — берём контент только из неё
    const summaryStartIdx = summaryMatch.index + summaryMatch[0].length;
    const nextSubsection = sectionContent.indexOf('\n### ', summaryStartIdx);
    const summaryEnd = nextSubsection === -1 ? sectionContent.length : nextSubsection;
    summaryContent = sectionContent.substring(summaryStartIdx, summaryEnd);
  } else {
    // Нет явной Summary — проверяем, есть ли вообще контент в секции Result
    // (любые подсекции, таблицы, текст считаются заполненной секцией)
    summaryContent = sectionContent;
  }

  const withoutComments = summaryContent.replace(/<!--[\s\S]*?-->/g, '').trim();
  const hasContent = withoutComments.length > 0;

  return {
    exists: true,
    summaryFilled: hasContent
  };
}

function verifyTicket(ticketPath) {
  if (!fs.existsSync(ticketPath)) {
    throw new Error(`Ticket file not found: ${ticketPath}`);
  }

  const content = fs.readFileSync(ticketPath, 'utf8');
  const { frontmatter, body } = parseFrontmatter(content);

  const filePaths = parseChangedFiles(body);
  // Используем updated_at как точку отсчёта для проверки mtime:
  // если файл не был изменён ПОСЛЕ того как агент начал работу, он считается неизменённым.
  const filesExist = checkFilesExist(filePaths, frontmatter.updated_at || frontmatter.created_at);

  const dodStats = parseDoDCompletion(body);

  const resultStats = checkResultSection(body);

  return {
    ticket_id: frontmatter.id,
    created_at: frontmatter.created_at,
    files_exist: filesExist,
    dod_completion_pct: dodStats.percentage,
    dod_checked: dodStats.checked,
    dod_completed: dodStats.completed,
    result_exists: resultStats.exists,
    result_filled: resultStats.summaryFilled
  };
}

function resolveTicketPath(arg) {
  // 1. Промпт от runner'а — ищем "ticket_id: XXX" в тексте.
  //    Проверяем первым, потому что промпт содержит пути (plans/current/...)
  //    и символы '/', '\', '.md', которые ложно срабатывают в проверке на путь.
  const promptMatch = arg.match(/ticket_id:\s*([A-Z]+-\d+)/i);
  if (promptMatch) {
    return resolveTicketPath(promptMatch[1]);
  }

  // 2. Явный путь — absolute или relative
  if (arg.includes('/') || arg.includes('\\') || arg.endsWith('.md')) {
    return path.isAbsolute(arg) ? arg : path.resolve(process.cwd(), arg);
  }

  // 3. Чистый ticket_id (QA-009) — резолвим по статусам
  if (/^[A-Z]+-\d+$/i.test(arg)) {
    for (const status of REVIEW_STATUSES) {
      const candidate = path.join(TICKETS_DIR, status, `${arg}.md`);
      if (fs.existsSync(candidate)) return candidate;
    }
    return path.join(TICKETS_DIR, 'review', `${arg}.md`);
  }

  return null;
}

function formatVerdict(result) {
  const missingFiles = result.files_exist
    .filter((f) => !f.exists)
    .map((f) => f.path);

  const unchangedFiles = result.files_exist
    .filter((f) => f.exists && f.unchanged)
    .map((f) => f.path);

  // Критерии failed:
  //   - result_filled == false (секция Result пуста)
  //   - dod_completion_pct == 0 (ни один пункт DoD не отмечен)
  //   - есть отсутствующие файлы из "Изменённые файлы"
  //   - есть неизменённые файлы (file_unchanged)
  const failReasons = [];
  const humanIssues = [];
  if (!result.result_filled) {
    failReasons.push('result_filled=false');
    humanIssues.push(result.result_exists
      ? 'секция Результата пуста (Summary не заполнен)'
      : 'секция Результата отсутствует');
  }
  if (result.dod_completion_pct === 0) {
    failReasons.push('dod_completion_pct=0');
    humanIssues.push(`ни один пункт DoD не отмечен (0/${result.dod_checked || 0})`);
  }
  if (missingFiles.length > 0) {
    failReasons.push(`missing_files=${missingFiles.join(',')}`);
    humanIssues.push(`не найдены заявленные файлы: ${missingFiles.join(', ')}`);
  }
  if (unchangedFiles.length > 0) {
    failReasons.push(`file_unchanged=${unchangedFiles.join(',')}`);
    humanIssues.push(
      `файлы не были изменены после начала выполнения тикета: ${unchangedFiles.join(', ')}`
    );
  }

  const status = failReasons.length === 0 ? 'passed' : 'failed';

  return { status, missingFiles, unchangedFiles, failReasons, humanIssues };
}

function buildReviewRow(humanIssues) {
  const date = new Date().toISOString().slice(0, 10);
  const summary = `verify-artifacts: ${humanIssues.join('; ')}`;
  return `| ${date} | ❌ failed | ${summary} |`;
}

function appendReviewNote(ticketPath, humanIssues) {
  const content = fs.readFileSync(ticketPath, 'utf8');
  const newRow = buildReviewRow(humanIssues);

  const reviewHeaderRegex = /^##\s*(Ревью|Review)\s*$/m;
  const headerMatch = reviewHeaderRegex.exec(content);

  if (headerMatch) {
    // Секция существует — добавить строку в конец таблицы.
    const startIdx = headerMatch.index + headerMatch[0].length;
    const nextH2 = content.indexOf('\n## ', startIdx);
    const sectionEnd = nextH2 === -1 ? content.length : nextH2;
    const sectionContent = content.substring(startIdx, sectionEnd);

    // Идемпотентность: не дублировать, если последняя непустая строка
    // таблицы уже совпадает с новой по самари (дата игнорируется).
    const lines = sectionContent.split('\n').map((l) => l.trimEnd()).filter(Boolean);
    const lastRow = [...lines].reverse().find((l) => l.startsWith('|'));
    if (lastRow) {
      const lastSummary = lastRow.split('|').slice(3, -1).join('|').trim();
      const newSummary = newRow.split('|').slice(3, -1).join('|').trim();
      if (lastSummary === newSummary) return false;
    }

    const trimmedSection = sectionContent.replace(/\s+$/, '');
    const hasTable = /\|\s*Дата\s*\|/i.test(trimmedSection);
    const tableHeader = hasTable
      ? ''
      : '\n\n| Дата | Статус | Самари |\n|------|--------|--------|';
    const updatedSection = `${trimmedSection}${tableHeader}\n${newRow}\n`;
    const suffix = nextH2 === -1 ? '' : content.substring(sectionEnd);
    const updated = content.substring(0, startIdx) + updatedSection + (suffix.startsWith('\n') ? suffix : `\n${suffix}`);
    fs.writeFileSync(ticketPath, updated, 'utf8');
    return true;
  }

  // Секции нет — создать перед "## Результат выполнения" / "## Result".
  const resultHeaderRegex = /^##\s*(Результат выполнения|Результат|Result)\s*$/m;
  const resultMatch = resultHeaderRegex.exec(content);

  const newSection = `## Ревью\n\n| Дата | Статус | Самари |\n|------|--------|--------|\n${newRow}\n\n`;

  let updated;
  if (resultMatch) {
    updated = content.substring(0, resultMatch.index) + newSection + content.substring(resultMatch.index);
  } else {
    // Fallback: в конец файла.
    const sep = content.endsWith('\n') ? '' : '\n';
    updated = `${content}${sep}\n${newSection}`;
  }
  fs.writeFileSync(ticketPath, updated, 'utf8');
  return true;
}

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage: node verify-artifacts.js <path-to-ticket|ticket_id|prompt>');
    process.exit(1);
  }

  const arg = args.join(' ');
  const ticketPath = resolveTicketPath(arg);

  if (!ticketPath) {
    console.error('Error: could not resolve ticket path from argument');
    console.log('---RESULT---');
    console.log('status: failed');
    console.log('reason: ticket_path_unresolved');
    console.log('---RESULT---');
    process.exit(1);
  }

  if (!fs.existsSync(ticketPath)) {
    console.error(`Error: ticket file not found: ${ticketPath}`);
    console.log('---RESULT---');
    console.log('status: failed');
    console.log(`reason: ticket_file_not_found`);
    console.log(`ticket_path: ${ticketPath}`);
    console.log('---RESULT---');
    process.exit(1);
  }

  try {
    const result = verifyTicket(ticketPath);
    const verdict = formatVerdict(result);

    let reviewNoteWritten = false;
    if (verdict.status === 'failed' && verdict.humanIssues.length > 0) {
      reviewNoteWritten = appendReviewNote(ticketPath, verdict.humanIssues);
    }

    console.log('---RESULT---');
    console.log(`status: ${verdict.status}`);
    console.log(`ticket_id: ${result.ticket_id || ''}`);
    console.log(`dod_completion_pct: ${result.dod_completion_pct}`);
    console.log(`dod_total: ${result.dod_checked}`);
    console.log(`dod_completed: ${result.dod_completed}`);
    console.log(`result_filled: ${result.result_filled}`);
    console.log(`missing_files: ${verdict.missingFiles.join(',')}`);
    console.log(`unchanged_files: ${verdict.unchangedFiles.join(',')}`);
    if (verdict.failReasons.length > 0) {
      console.log(`fail_reasons: ${verdict.failReasons.join('; ')}`);
      console.log(`issues: ${verdict.humanIssues.join('; ')}`);
      console.log(`review_note_written: ${reviewNoteWritten}`);
    }
    console.log('---RESULT---');
  } catch (err) {
    console.error(`Error: ${err.message}`);
    console.log('---RESULT---');
    console.log('status: failed');
    console.log(`reason: ${err.message.replace(/\n/g, ' ')}`);
    console.log('---RESULT---');
    process.exit(1);
  }
}

main();