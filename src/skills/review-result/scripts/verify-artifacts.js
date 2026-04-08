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
  const changedFilesRegex = /^###\s*(Изменённые файлы|Changed files)\s*$/gm;
  const match = changedFilesRegex.exec(body);
  
  if (!match) return files;
  
  const startIdx = match.index + match[0].length;
  const nextH2 = body.indexOf('\n## ', startIdx);
  const sectionEnd = nextH2 === -1 ? body.length : nextH2;
  const sectionContent = body.substring(startIdx, sectionEnd);
  
  const filePathRegex = /`([^`]+)`/g;
  let fileMatch;
  while ((fileMatch = filePathRegex.exec(sectionContent)) !== null) {
    files.push(fileMatch[1]);
  }
  
  return files;
}

function checkFilesExist(filePaths) {
  return filePaths.map(filePath => {
    const fullPath = path.isAbsolute(filePath) ? filePath : path.join(PROJECT_DIR, filePath);
    return {
      path: filePath,
      exists: fs.existsSync(fullPath)
    };
  });
}

function parseDoDCompletion(body) {
  const dodSectionRegex = /^##\s*(Критерии готовности|Definition of Done)\s*$/gm;
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
  const resultSectionRegex = /^##\s*(Результат выполнения|Result)\s*$/m;
  const sectionMatch = resultSectionRegex.exec(body);
  
  if (!sectionMatch) return { exists: false, summaryFilled: false };
  
  const startIdx = sectionMatch.index + sectionMatch[0].length;
  const nextH2 = body.indexOf('\n## ', startIdx);
  const sectionEnd = nextH2 === -1 ? body.length : nextH2;
  const sectionContent = body.substring(startIdx, sectionEnd);
  
  const summaryRegex = /^###\s*(Summary|Что сделано)\s*$/m;
  const summaryMatch = summaryRegex.exec(sectionContent);
  
  if (!summaryMatch) return { exists: true, summaryFilled: false };
  
  const summaryStartIdx = summaryMatch.index + summaryMatch[0].length;
  const nextSubsection = sectionContent.indexOf('\n### ', summaryStartIdx);
  const summaryEnd = nextSubsection === -1 ? sectionContent.length : nextSubsection;
  const summaryContent = sectionContent.substring(summaryStartIdx, summaryEnd);
  
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
  const filesExist = checkFilesExist(filePaths);
  
  const dodStats = parseDoDCompletion(body);
  
  const resultStats = checkResultSection(body);
  
  return {
    ticket_id: frontmatter.id,
    files_exist: filesExist,
    dod_completion_pct: dodStats.percentage,
    dod_checked: dodStats.checked,
    dod_completed: dodStats.completed,
    result_exists: resultStats.exists,
    result_filled: resultStats.summaryFilled
  };
}

function resolveTicketPath(arg) {
  // 1. Явный путь — absolute или relative
  if (arg.includes('/') || arg.includes('\\') || arg.endsWith('.md')) {
    return path.isAbsolute(arg) ? arg : path.resolve(process.cwd(), arg);
  }

  // 2. Чистый ticket_id (QA-009) — резолвим по статусам
  if (/^[A-Z]+-\d+$/i.test(arg)) {
    for (const status of REVIEW_STATUSES) {
      const candidate = path.join(TICKETS_DIR, status, `${arg}.md`);
      if (fs.existsSync(candidate)) return candidate;
    }
    return path.join(TICKETS_DIR, 'review', `${arg}.md`);
  }

  // 3. Промпт от runner'а — ищем "ticket_id: XXX" в тексте
  const match = arg.match(/ticket_id:\s*([A-Z]+-\d+)/i);
  if (match) {
    return resolveTicketPath(match[1]);
  }

  return null;
}

function formatVerdict(result) {
  const missingFiles = result.files_exist
    .filter((f) => !f.exists)
    .map((f) => f.path);

  // Критерии failed:
  //   - result_filled == false (секция Result пуста)
  //   - dod_completion_pct == 0 (ни один пункт DoD не отмечен)
  //   - есть отсутствующие файлы из "Изменённые файлы"
  const failReasons = [];
  if (!result.result_filled) {
    failReasons.push('result_filled=false');
  }
  if (result.dod_completion_pct === 0) {
    failReasons.push('dod_completion_pct=0');
  }
  if (missingFiles.length > 0) {
    failReasons.push(`missing_files=${missingFiles.join(',')}`);
  }

  const status = failReasons.length === 0 ? 'passed' : 'failed';

  return { status, missingFiles, failReasons };
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

    console.log('---RESULT---');
    console.log(`status: ${verdict.status}`);
    console.log(`ticket_id: ${result.ticket_id || ''}`);
    console.log(`dod_completion_pct: ${result.dod_completion_pct}`);
    console.log(`dod_total: ${result.dod_checked}`);
    console.log(`dod_completed: ${result.dod_completed}`);
    console.log(`result_filled: ${result.result_filled}`);
    console.log(`missing_files: ${verdict.missingFiles.join(',')}`);
    if (verdict.failReasons.length > 0) {
      console.log(`fail_reasons: ${verdict.failReasons.join('; ')}`);
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