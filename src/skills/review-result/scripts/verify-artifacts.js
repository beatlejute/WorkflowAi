#!/usr/bin/env node

/**
 * verify-artifacts.js — механическая предпроверка тикета перед AI-ревью.
 *
 * Парсит тикет и проверяет:
 * - Существование файлов из секции "Изменённые файлы"
 * - DoD completion %
 * - Заполненность секции Result (Summary)
 *
 * Использование:
 *   node verify-artifacts.js <path-to-ticket>
 *
 * Вывод: JSON через ---RESULT---
 */

import fs from 'fs';
import path from 'path';
import { findProjectRoot } from 'workflow-ai/lib/find-root.mjs';
import { parseFrontmatter } from 'workflow-ai/lib/utils.mjs';

const PROJECT_DIR = findProjectRoot();

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

function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.error('Usage: node verify-artifacts.js <path-to-ticket>');
    process.exit(1);
  }
  
  const ticketPath = args[0];
  
  try {
    const result = verifyTicket(ticketPath);
    console.log('---RESULT---');
    console.log(JSON.stringify(result, null, 2));
    console.log('---RESULT---');
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();