#!/usr/bin/env node

/**
 * check-duplicates.js — проверка потенциальных дубликатов тикетов.
 *
 * Алгоритм: word-level overlap для title + key phrase overlap для scope.
 * Скрипт только предоставляет данные — финальное решение (CREATE/SKIP/OVERRIDE)
 * остаётся за агентом.
 *
 * Использование:
 *   node check-duplicates.js --title "Заголовок" --scope "Описание scope"
 *   node check-duplicates.js --title "..." --scope "..." --type-prefix "IMPL"
 *
 * Результат: JSON через ---RESULT--- с списком потенциальных дубликатов.
 */

import fs from 'fs';
import path from 'path';
import { findProjectRoot } from 'workflow-ai/lib/find-root.mjs';

// ─── Конфигурация ────────────────────────────────────────────────

const TICKET_DIRS = [
  'backlog',
  'ready',
  'in-progress',
  'blocked',
  'review',
  'done',
  'archive',
];

const TITLE_OVERLAP_THRESHOLD = 70;   // процент
const SCOPE_OVERLAP_THRESHOLD = 50;   // процент

// ─── Утилиты ─────────────────────────────────────────────────────

/**
 * Нормализовать текст: lowercase, убрать спецсимволы, разбить на слова.
 */
function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .split(/\s+/)
    .filter(w => w.length > 0);
}

/**
 * Word-level overlap: процент совпадения слов между двумя текстами.
 * Использует мультимножество (учитывает повторы слов).
 */
function wordOverlap(text1, text2) {
  const tokens1 = tokenize(text1);
  const tokens2 = tokenize(text2);

  if (tokens1.length === 0 || tokens2.length === 0) return 0;

  // Строим мультимножество для tokens2
  const bag2 = new Map();
  for (const t of tokens2) {
    bag2.set(t, (bag2.get(t) || 0) + 1);
  }

  let overlap = 0;
  const bag1Counted = new Map();
  for (const t of tokens1) {
    const available = bag2.get(t) || 0;
    const alreadyCounted = bag1Counted.get(t) || 0;
    if (available > alreadyCounted) {
      overlap++;
      bag1Counted.set(t, alreadyCounted + 1);
    }
  }

  // Процент от меньшего набора слов (чтобы короткие title не давали ложных совпадений)
  const minLen = Math.min(tokens1.length, tokens2.length);
  return Math.round((overlap / minLen) * 100);
}

/**
 * Извлечь ключевые фразы из scope: биграммы + триграммы из значимых слов.
 * Значимые слова — существительные и глаголы (всё кроме стоп-слов).
 */
function extractKeyPhrases(text, ngramSize = 2) {
  const tokens = tokenize(text);
  // Простые стоп-слова для русского и английского
  const stopWords = new Set([
    'и', 'в', 'на', 'с', 'по', 'к', 'у', 'о', 'из', 'за', 'для', 'от', 'до',
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as',
    'that', 'this', 'these', 'those', 'it', 'its',
  ]);

  const significant = tokens.filter(t => !stopWords.has(t));

  if (significant.length < ngramSize) return significant;

  const phrases = new Set();
  for (let i = 0; i <= significant.length - ngramSize; i++) {
    phrases.add(significant.slice(i, i + ngramSize).join(' '));
  }
  return [...phrases];
}

/**
 * Key phrase overlap: процент совпадения ключевых фраз между двумя scope.
 */
function phraseOverlap(scope1, scope2) {
  const phrases1 = extractKeyPhrases(scope1);
  const phrases2 = extractKeyPhrases(scope2);

  if (phrases1.length === 0 || phrases2.length === 0) return 0;

  const set2 = new Set(phrases2);
  let overlap = 0;
  for (const p of phrases1) {
    if (set2.has(p)) overlap++;
  }

  const minLen = Math.min(phrases1.length, phrases2.length);
  return Math.round((overlap / minLen) * 100);
}

/**
 * Извлечь frontmatter из markdown-файла тикета.
 */
function parseFrontmatter(content) {
  // Нормализуем CRLF → LF для кроссплатформенной совместимости
  const normalized = content.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const yaml = match[1];
  const result = {};

  // Простой YAML-парсер для плоских ключей и notes
  for (const line of yaml.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    let value = trimmed.slice(colonIdx + 1).trim();

    // Убрать кавычки
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

/**
 * Извлечь описание и детали задачи из тела тикета.
 */
function extractTicketDescription(content) {
  // Нормализуем CRLF → LF
  const normalized = content.replace(/\r\n/g, '\n');
  const parts = [];

  // Секция "Описание"
  const descMatch = normalized.match(/^## Описание\s*\n([\s\S]*?)(?=^## |\Z)/m);
  if (descMatch) parts.push(descMatch[1]);

  // Секция "Детали задачи"
  const detailsMatch = normalized.match(/^## Детали задачи\s*\n([\s\S]*?)(?=^## |\Z)/m);
  if (detailsMatch) parts.push(detailsMatch[1]);

  return parts.join('\n');
}

/**
 * Сканировать все директории тикетов и найти тикеты с указанным префиксом.
 */
function scanTickets(prefix, projectRoot) {
  const ticketsDir = path.join(projectRoot, '.workflow', 'tickets');
  const results = [];

  for (const dir of TICKET_DIRS) {
    const dirPath = path.join(ticketsDir, dir);
    if (!fs.existsSync(dirPath)) continue;

    const files = fs.readdirSync(dirPath);
    for (const file of files) {
      // Пропускаем временные файлы и файлы не с тем префиксом
      if (!file.startsWith(prefix + '-') && !file.match(/^IMPL-/)) continue;
      if (!file.endsWith('.md')) continue;

      const filePath = path.join(dirPath, file);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const frontmatter = parseFrontmatter(content);
        const description = extractTicketDescription(content);

        results.push({
          id: frontmatter.id || file.replace('.md', ''),
          title: frontmatter.title || '',
          status: dir,
          filePath,
          content,
          description,
        });
      } catch (e) {
        // Пропускаем файлы с ошибками чтения
      }
    }
  }

  return results;
}

// ─── Парсинг аргументов ──────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = {
    title: null,
    scope: null,
    typePrefix: 'IMPL',
  };

  let i = 0;
  while (i < args.length) {
    if (args[i] === '--title' && i + 1 < args.length) {
      result.title = args[++i];
    } else if (args[i] === '--scope' && i + 1 < args.length) {
      result.scope = args[++i];
    } else if (args[i] === '--type-prefix' && i + 1 < args.length) {
      result.typePrefix = args[++i];
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Использование: node check-duplicates.js [опции]

Опции:
  --title <text>         Заголовок создаваемого тикета (обязательно)
  --scope <text>         Описание scope работы (обязательно)
  --type-prefix <prefix> Префикс типа тикета (по умолчанию: IMPL)
  -h, --help             Показать справку
`);
      process.exit(0);
    }
    i++;
  }

  return result;
}

// ─── Основная логика ─────────────────────────────────────────────

function findDuplicates(newTitle, newScope, typePrefix, projectRoot) {
  const tickets = scanTickets(typePrefix, projectRoot);
  const duplicates = [];

  for (const ticket of tickets) {
    // Шаг 2: Сравнение title (word-level overlap)
    const titleOverlap = wordOverlap(newTitle, ticket.title);

    // Фильтр: если title не проходит порог — пропускаем
    if (titleOverlap <= TITLE_OVERLAP_THRESHOLD) continue;

    // Шаг 3: Сравнение scope (key phrase overlap)
    const scopeText = ticket.description || ticket.title;
    const scopeOverlap = phraseOverlap(newScope, scopeText);

    duplicates.push({
      id: ticket.id,
      title: ticket.title,
      title_overlap_pct: titleOverlap,
      scope_overlap_pct: scopeOverlap,
      status: ticket.status,
      file_path: ticket.filePath,
    });
  }

  // Сортировка по убыванию title_overlap
  duplicates.sort((a, b) => b.title_overlap_pct - a.title_overlap_pct);

  return duplicates;
}

// ─── Вывод результата ────────────────────────────────────────────

function outputResult(duplicates, newTitle) {
  console.log('---RESULT---');
  console.log(JSON.stringify({
    query_title: newTitle,
    potential_duplicates: duplicates,
    count: duplicates.length,
    recommendation: duplicates.length === 0
      ? 'CREATE — дубликатов не найдено'
      : 'Проверить каждый дубликат и принять решение: SKIP / OVERRIDE / CREATE',
  }, null, 2));
  console.log('---RESULT---');
}

// ─── Запуск ──────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);

  if (!args.title || !args.scope) {
    console.error('Ошибка: необходимо указать --title и --scope');
    console.error('Использование: node check-duplicates.js --title "..." --scope "..."');
    process.exit(1);
  }

  const projectRoot = findProjectRoot();
  const duplicates = findDuplicates(args.title, args.scope, args.typePrefix, projectRoot);

  outputResult(duplicates, args.title);
}

main().catch((err) => {
  console.error(`Ошибка: ${err.message}`);
  process.exit(1);
});
