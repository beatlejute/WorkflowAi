#!/usr/bin/env node

/**
 * check-anomalies.js - Скрипт для проверки аномалий в тикетах
 *
 * Проверяет in-progress тикеты на наличие заполненных результатов.
 * Если тикет в in-progress, но имеет заполненный раздел "Результат выполнения" —
 * это аномалия (тикет, вероятно, выполнен, но не перемещён в done/review).
 *
 * Использование:
 *   node check-anomalies.js
 *
 * Выводит результат в формате:
 *   ---RESULT---
 *   status: ok|anomalies_found|error
 *   anomalies_count: N
 *   anomalies: [{"id": "IMPL-001", "title": "...", "recommendation": "..."}]
 *   ---RESULT---
 */

import fs from 'fs';
import path from 'path';
import YAML from '../lib/js-yaml.mjs';
import { findProjectRoot } from '../lib/find-root.mjs';
import { parseFrontmatter, printResult } from '../lib/utils.mjs';

// Корень проекта
const PROJECT_DIR = findProjectRoot();
const TICKETS_DIR = path.join(PROJECT_DIR, '.workflow', 'tickets');
const IN_PROGRESS_DIR = path.join(TICKETS_DIR, 'in-progress');

/**
 * Проверяет, заполнен ли раздел результатов
 * Возвращает true, если раздел содержит реальный контент (не только комментарии)
 */
function hasFilledResult(body) {
  // Ищем раздел "Результат выполнения" или "Result"
  // Используем более гибкий паттерн
  const resultSectionRegex = /^##\s*(Результат выполнения|Result)\s*$/m;
  const sectionStart = body.search(resultSectionRegex);

  if (sectionStart === -1) {
    return false;
  }

  // Находим начало следующей секции ## или конец файла
  const nextSectionRegex = /^##\s+/gm;
  nextSectionRegex.lastIndex = sectionStart + 1;
  const nextSectionMatch = nextSectionRegex.exec(body);
  const sectionEnd = nextSectionMatch ? nextSectionMatch.index : body.length;

  const sectionContent = body.substring(sectionStart, sectionEnd);

  // Ищем подраздел Summary или "Что сделано"
  const summaryRegex = /^###\s*(Summary|Что сделано)\s*$/m;
  const summaryStart = sectionContent.search(summaryRegex);

  if (summaryStart === -1) {
    return false;
  }

  // Находим начало следующего подраздела ### или конец секции
  const nextSubsectionRegex = /^###\s+/gm;
  nextSubsectionRegex.lastIndex = summaryStart + 1;
  const nextSubsectionMatch = nextSubsectionRegex.exec(sectionContent);
  const summaryEnd = nextSubsectionMatch ? nextSubsectionMatch.index : sectionContent.length;

  const summaryContent = sectionContent.substring(summaryStart, summaryEnd);

  // Проверяем, что контент не пустой и не состоит только из комментариев
  // Удаляем HTML комментарии и проверяем остаток
  const withoutComments = summaryContent.replace(/<!--[\s\S]*?-->/g, '').trim();

  // Если после удаления комментариев остался текст — раздел заполнен
  return withoutComments.length > 0;
}

/**
 * Основная функция проверки аномалий
 */
async function checkAnomalies() {
  const anomalies = [];

  // Проверяем существование директории in-progress
  if (!fs.existsSync(IN_PROGRESS_DIR)) {
    return {
      status: 'ok',
      anomalies_count: 0,
      anomalies: [],
      message: 'in-progress directory does not exist'
    };
  }

  // Читаем все файлы в in-progress
  let files;
  try {
    files = fs.readdirSync(IN_PROGRESS_DIR);
  } catch (e) {
    return {
      status: 'error',
      error: `Failed to read in-progress directory: ${e.message}`
    };
  }

  // Фильтруем .md файлы (исключаем .gitkeep)
  const ticketFiles = files.filter(f => f.endsWith('.md') && f !== '.gitkeep.md');

  for (const file of ticketFiles) {
    const filePath = path.join(IN_PROGRESS_DIR, file);
    let content;

    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      anomalies.push({
        id: file.replace('.md', ''),
        title: 'Unknown (read error)',
        recommendation: `Не удалось прочитать файл: ${e.message}`
      });
      continue;
    }

    // Парсим frontmatter для получения id и title
    const { frontmatter, body } = parseFrontmatter(content);
    const ticketId = frontmatter.id || file.replace('.md', '');
    const ticketTitle = frontmatter.title || 'Unknown';

    // Проверяем наличие заполненного результата
    if (hasFilledResult(body)) {
      anomalies.push({
        id: ticketId,
        title: ticketTitle,
        recommendation: 'Проверьте тикет и переместите в done/ или review/ если выполнен'
      });
    }
  }

  return {
    status: anomalies.length > 0 ? 'anomalies_found' : 'ok',
    anomalies_count: anomalies.length,
    anomalies: anomalies
  };
}

// Main entry point
checkAnomalies().then(result => {
  printResult(result);

  // Если найдены аномалии, выводим их в читаемом виде
  if (result.anomalies && result.anomalies.length > 0) {
    console.log('\n[ANOMALIES DETECTED]');
    for (const anomaly of result.anomalies) {
      console.log(`  - ${anomaly.id}: ${anomaly.title}`);
      console.log(`    Recommendation: ${anomaly.recommendation}`);
    }
  }

  if (result.status === 'error') {
    process.exit(1);
  }
});
