#!/usr/bin/env node

/**
 * check-created-tickets.js — создала ли стадия decompose-gaps новые тикеты.
 *
 * Стадия-скрипт после decompose-gaps (configs/pipeline.yaml, check-decompose-result).
 * Без новых тикетов следующий круг check-conditions → create-report → analyze-report
 * ничего не меняет: отчёт и разбор повторяются на той же доске и находят те же пробелы.
 * 2026-09-28 PulseProxy: разбор нашёл пробел вне плана (дефект самого workflow-ai),
 * decompose-gaps его верно отклонил с `created_tickets: []`, и пайплайн ещё раз написал
 * отчёт и разбор — около 15 минут работы модели впустую.
 *
 * Список берётся из поля `created_tickets` блока RESULT стадии decompose-gaps, которое
 * раннер кладёт в контекст (`$result.created_tickets`). Созданным считается id, файл
 * которого есть в одной из колонок доски: id, упомянутый в тексте, но не записанный
 * (или номер плана), тикетом не считается.
 *
 * Использование:
 *   node check-created-tickets.js "<промпт стадии с секцией Context>"
 *   node check-created-tickets.js "created_tickets: FIX-032, FIX-033"
 *
 * Вывод:
 *   ---RESULT---
 *   status: created | none
 *   created_tickets: <id через запятую>
 *   ---RESULT---
 */

import fs from 'fs';
import path from 'path';
import { findProjectRoot } from 'workflow-ai/lib/find-root.mjs';
import { printResult } from 'workflow-ai/lib/utils.mjs';

const TICKET_ID = /\b[A-Z][A-Z0-9]*-\d+\b/g;

/**
 * Значение поля `created_tickets` из промпта стадии: одна строка (`FIX-1, FIX-2`, `[]`)
 * или многострочный список YAML — до следующего поля контекста или секции промпта.
 */
export function createdTicketsField(prompt) {
  const lines = String(prompt ?? '').split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*created_tickets:/.test(line));
  if (start === -1) return '';
  const value = [lines[start].replace(/^\s*created_tickets:/, '')];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line) || /^\s*[A-Za-z_]+:(\s|$)/.test(line)) break;
    value.push(line);
  }
  return value.join('\n').trim();
}

/** Id из значения, у которых есть файл тикета на доске, — без повторов, в порядке значения. */
export function ticketsOnBoard(value, ticketsDir) {
  let columns = [];
  try {
    columns = fs.readdirSync(ticketsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const ids = [...new Set(String(value).match(TICKET_ID) || [])];
  return ids.filter((id) => columns.some((column) => fs.existsSync(path.join(ticketsDir, column, `${id}.md`))));
}

function main() {
  const ticketsDir = path.join(findProjectRoot(), '.workflow', 'tickets');
  const created = ticketsOnBoard(createdTicketsField(process.argv.slice(2).join('\n')), ticketsDir);
  if (created.length === 0) console.log('[INFO] decompose-gaps не создал тикетов — повторный отчёт и разбор дали бы то же самое');
  printResult({ status: created.length > 0 ? 'created' : 'none', created_tickets: created.join(', ') });
}

// По имени файла, а не по import.meta.url: через junction .workflow/src/scripts пути
// argv[1] и модуля расходятся (как в check-plan-decomposed.js).
if (process.argv[1] && /check-created-tickets(\.js)?$/.test(process.argv[1])) {
  main();
}
