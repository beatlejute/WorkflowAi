#!/usr/bin/env node
/**
 * check-atomicity-limit.js
 *
 * Проверяет счётчик atomicity_check_attempts без инкремента.
 * Возвращает status: "passed" если counter < max, "failed" если >= max.
 *
 * Используется как stage перед verify-atomicity для защиты от бесконечного цикла.
 * В отличие от update-counter, НЕ инкрементирует счётчик — только читает.
 *
 * Формат промпта от runner'а:
 *   Counters:
 *     atomicity_check_attempts: N
 *
 * Если counter = 0, секция Counters может отсутствовать (runner не выводит нули).
 *
 * Usage: node check-atomicity-limit.js <prompt>
 *   prompt — текст промпта (от runner'а)
 *   ИЛИ если первый аргумент --file, второй аргумент — путь к файлу с промптом
 */

let prompt = '';

if (process.argv[2] === '--file' && process.argv[3]) {
  // Чтение из файла (для тестирования)
  const fs = await import('fs');
  const filePath = process.argv[3];
  prompt = fs.readFileSync(filePath, 'utf-8');
} else {
  prompt = process.argv[2] || '';
}

// Ищем atomicity_check_attempts в промпте
// Формат: "atomicity_check_attempts: N" (с возможным отступом)
const match = prompt.match(/atomicity_check_attempts:\s*(\d+)/i);
const counterValue = match ? parseInt(match[1], 10) : 0;

const MAX_ATTEMPTS = 3;
const status = counterValue >= MAX_ATTEMPTS ? 'failed' : 'passed';

console.log(`---RESULT---
status: ${status}
atomicity_check_attempts: ${counterValue}
max_attempts: ${MAX_ATTEMPTS}
---RESULT---`);

process.exit(0);
