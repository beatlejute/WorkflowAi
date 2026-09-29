#!/usr/bin/env node

/**
 * check-ticket-dod.js — гейт dod_format: 2 для автора тикета, до того как тикет попадёт на доску.
 *
 * Тот же разбор, что у move-to-ready.js перед переносом в ready/ (dodStartProblems,
 * lib/check-runner.mjs): проверка check не должна быть отклонена исполнителем (операторы
 * оболочки, запрещённая команда), должна иметь исполняемый файл на машине и должна быть
 * красной до начала работы, если она не помечена `regression: true` и исполнитель тикет
 * ещё не брал (строки execute-task в «Истории работы» нет). Тикет, записанный
 * мимо этих правил, гейт отправляет в blocked/ — 2026-09-28 так встал тикет доработки
 * PulseProxy FIX-031: проверки через `|` и проверка, зелёная до начала. Скрипт даёт автору
 * (скилу, который пишет тикеты) увидеть это до записи на доску и исправить проверки.
 *
 * Использование (из корня проекта):
 *   node .workflow/src/scripts/check-ticket-dod.js <ticket_id|путь к файлу> [...]
 *
 * Тикет по id ищется во всех колонках .workflow/tickets/. Тикет не в формате
 * dod_format: 2 и тикет type: human гейт не проходят — для них «ok». Исключение —
 * тикет без dod_format: 2 (и не human) с записями проверок в DoD: это
 * `dod_format_missing`, проверки такого тикета не запустились бы (hasCheckRecords).
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
import { dodStartProblems, isDodFormat2, parseDodChecks, DOD_HEADING } from '../lib/check-runner.mjs';

const PROJECT_DIR = findProjectRoot();
const TICKETS_DIR = path.join(PROJECT_DIR, '.workflow', 'tickets');

// Строка записи проверки `  - check: …` в секции DoD. parseDodChecks видит только
// вложенную строку под пунктом и с одной формой; запись до первого пункта или вместе
// с prose/visual (multiple_forms) тоже значит, что автор писал проверки.
const CHECK_LINE = /^\s+[-*]\s+check\s*:/m;

/**
 * Автор записал проверки DoD — пункт формы check или строка `- check:` в секции.
 *
 * Без `dod_format: 2` проверки не запускаются ни гейтом move-to-ready, ни ревью:
 * тикет уходит модели (review-result-legacy). PulseProxy PLAN-017 2026-09-28: FIX-032
 * и QA-163 записаны с проверками, но без поля — шаблон тикета проекта был апрельской
 * копией без него, — и ни одна проверка не выполнилась.
 */
function hasCheckRecords(body) {
  if (parseDodChecks(body).some((item) => item.kind === 'check')) return true;
  const text = String(body ?? '');
  const heading = DOD_HEADING.exec(text);
  if (!heading) return false;
  const start = heading.index + heading[0].length;
  const nextH2 = text.indexOf('\n## ', start);
  return CHECK_LINE.test(text.slice(start, nextH2 === -1 ? text.length : nextH2));
}

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
    if (frontmatter.type !== 'human' && !isDodFormat2(frontmatter) && hasCheckRecords(body)) {
      withProblems++;
      console.log(`${id}: dod_format_missing: проверки DoD есть, а dod_format: 2 во frontmatter нет — проверки не запустятся, ревью уйдёт модели`);
      continue;
    }
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
