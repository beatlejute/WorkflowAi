#!/usr/bin/env node

/**
 * check-ticket-dod.js — гейт dod_format: 2 для автора тикета, до того как тикет попадёт на доску.
 *
 * Тот же разбор, что у move-to-ready.js перед переносом в ready/ (dodStartProblems,
 * lib/check-runner.mjs): проверка check не должна быть отклонена исполнителем (операторы
 * оболочки, запрещённая команда), должна иметь исполняемый файл на машине и должна быть
 * красной до начала работы, если она не помечена `regression: true`. Тикет, записанный
 * мимо этих правил, гейт отправляет в blocked/ — 2026-09-28 так встал тикет доработки
 * PulseProxy FIX-031: проверки через `|` и проверка, зелёная до начала. Скрипт даёт автору
 * (скилу, который пишет тикеты) увидеть это до записи на доску и исправить проверки.
 *
 * Использование (из корня проекта):
 *   node .workflow/src/scripts/check-ticket-dod.js <ticket_id|путь к файлу> [...]
 *
 * Тикет по id ищется во всех колонках .workflow/tickets/. Тикет не в формате
 * dod_format: 2 и тикет type: human гейт не проходят — для них «ok».
 *
 * Вывод:
 *   <ticket_id>: ok | <причина>; <причина>
 *   ---RESULT---
 *   status: ok | problems
 *   checked: N
 *   with_problems: N
 *   ---RESULT---
 * Код выхода: 0 — у всех ok; 1 — есть проблемы или тикет не найден.
 */

import fs from 'fs';
import path from 'path';
import { findProjectRoot } from 'workflow-ai/lib/find-root.mjs';
import { parseFrontmatter, printResult } from 'workflow-ai/lib/utils.mjs';
import { dodStartProblems, isDodFormat2 } from '../lib/check-runner.mjs';

const PROJECT_DIR = findProjectRoot();
const TICKETS_DIR = path.join(PROJECT_DIR, '.workflow', 'tickets');

function findTicket(ref) {
  const asPath = path.resolve(PROJECT_DIR, ref);
  if (ref.endsWith('.md') && fs.existsSync(asPath)) return asPath;
  let columns = [];
  try {
    columns = fs.readdirSync(TICKETS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return null;
  }
  for (const column of columns) {
    const file = path.join(TICKETS_DIR, column.name, `${ref}.md`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

async function main() {
  const refs = process.argv.slice(2).filter(Boolean);
  if (refs.length === 0) {
    console.error('Использование: node check-ticket-dod.js <ticket_id|путь к файлу> [...]');
    printResult({ status: 'error', error: 'no tickets given' });
    process.exit(1);
  }

  let withProblems = 0;
  for (const ref of refs) {
    const file = findTicket(ref);
    if (!file) {
      console.log(`${ref}: тикет не найден в ${TICKETS_DIR}`);
      withProblems++;
      continue;
    }
    const { frontmatter, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    const id = frontmatter.id || path.basename(file, '.md');
    if (frontmatter.type === 'human' || !isDodFormat2(frontmatter)) {
      console.log(`${id}: ok (гейт не применяется: ${frontmatter.type === 'human' ? 'type human' : 'не dod_format 2'})`);
      continue;
    }
    const problems = await dodStartProblems({ body, projectRoot: PROJECT_DIR });
    if (problems.length > 0) withProblems++;
    console.log(`${id}: ${problems.length > 0 ? problems.join('; ') : 'ok'}`);
  }

  printResult({ status: withProblems > 0 ? 'problems' : 'ok', checked: refs.length, with_problems: withProblems });
  if (withProblems > 0) process.exit(1);
}

main().catch((error) => {
  console.error(`Ошибка: ${error.message}`);
  printResult({ status: 'error', error: error.message });
  process.exit(1);
});
