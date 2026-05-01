#!/usr/bin/env node

/**
 * mark-blocked.js - Скрипт для обновления frontmatter тикета и записи в alerts.jsonl
 *
 * Использование:
 *   node mark-blocked.js <ticket_id> --attempts=N --reason=<str>
 *
 * Примеры:
 *   node mark-blocked.js IMPL-59 --attempts=6 --reason=max_review_attempts
 *   node mark-blocked.js QA-40 --attempts=3 --reason=human_gate_rejected
 */

import fs from "fs";
import path from "path";
import YAML from "workflow-ai/lib/js-yaml.mjs";
import { findProjectRoot } from "workflow-ai/lib/find-root.mjs";
import {
  parseFrontmatter,
  printResult,
  serializeFrontmatter,
} from "workflow-ai/lib/utils.mjs";

// Корень проекта
const PROJECT_DIR = findProjectRoot();
// Базовая директория workflow
const WORKFLOW_DIR = path.join(PROJECT_DIR, ".workflow");
const TICKETS_DIR = path.join(WORKFLOW_DIR, "tickets");
// Директория state
const STATE_DIR = path.join(PROJECT_DIR, ".workflow", "state");
const ALERTS_FILE = path.join(STATE_DIR, "alerts.jsonl");

// Парсинг аргументов
const args = process.argv.slice(2);
if (args.length < 3) {
  console.error("Ошибка: недостаточно аргументов");
  console.error("Использование: node mark-blocked.js <ticket_id> --attempts=N --reason=<str>");
  process.exit(1);
}

const ticketId = args[0];
let attempts = null;
let reason = null;

// Парсинг флагов
for (let i = 1; i < args.length; i++) {
  const arg = args[i];
  if (arg.startsWith("--attempts=")) {
    attempts = parseInt(arg.substring("--attempts=".length), 10);
    if (isNaN(attempts)) {
      console.error("Ошибка: некорректный формат --attempts");
      process.exit(1);
    }
  } else if (arg.startsWith("--reason=")) {
    reason = arg.substring("--reason=".length);
  }
}

// Проверка обязательного параметра reason
if (!reason) {
  console.error("Ошибка: параметр --reason обязателен");
  process.exit(1);
}

// Поиск файла тикета рекурсивно
function findTicketFile(ticketId, searchDir) {
  try {
    const files = fs.readdirSync(searchDir, { withFileTypes: true });
    
    for (const file of files) {
      const fullPath = path.join(searchDir, file.name);
      
      if (file.isDirectory()) {
        // Рекурсивный поиск в поддиректориях
        const found = findTicketFile(ticketId, fullPath);
        if (found) return found;
      } else if (file.isFile() && file.name.endsWith('.md') && file.name.startsWith(ticketId)) {
        return fullPath;
      }
    }
  } catch (error) {
    console.error(`Ошибка при чтении директории ${searchDir}:`, error.message);
  }
  
  return null;
}

// Основная функция
function main() {
  try {
    // Поиск файла тикета
    const ticketFile = findTicketFile(ticketId, TICKETS_DIR);
    if (!ticketFile) {
      console.error(`Ошибка: тикет ${ticketId} не найден в ${TICKETS_DIR}`);
      process.exit(1);
    }

    // Чтение файла тикета
    const content = fs.readFileSync(ticketFile, 'utf8');
    const { frontmatter, body } = parseFrontmatter(content);

    // Обновление frontmatter
    const now = new Date().toISOString();
    frontmatter.auto_blocked_reason = reason;
    frontmatter.auto_blocked_attempts = attempts;
    frontmatter.auto_blocked_at = now;

    // Сериализация и запись обратно в файл
    const newContent = serializeFrontmatter(frontmatter) + body;
    fs.writeFileSync(ticketFile, newContent, 'utf8');

    console.log(`✅ Frontmatter тикета ${ticketId} обновлен`);

    // Попытка записи в alerts.jsonl
    try {
      // Создание директории state если не существует
      if (!fs.existsSync(STATE_DIR)) {
        fs.mkdirSync(STATE_DIR, { recursive: true });
        console.log(`✅ Директория ${STATE_DIR} создана`);
      }

      // Формирование JSONL записи
      const alertEntry = {
        timestamp: now,
        severity: "warning",
        kind: "ticket_auto_blocked",
        project: path.basename(PROJECT_DIR),
        ticket_id: ticketId,
        attempts: attempts,
        reason: reason,
        stage: "review-result"
      };

      // Append-only запись в alerts.jsonl
      fs.appendFileSync(ALERTS_FILE, JSON.stringify(alertEntry) + '\n', 'utf8');
      console.log(`✅ Запись добавлена в ${ALERTS_FILE}`);

    } catch (alertError) {
      console.warn(`⚠️  Предупреждение: не удалось записать в alerts.jsonl: ${alertError.message}`);
      console.log(`ℹ️  Frontmatter обновлен, запись в alerts пропущена`);
    }

    // Вывод результата
    printResult({
      ticket_id: ticketId,
      reason: reason,
      attempts: attempts,
      blocked_at: now,
      alerts_file: ALERTS_FILE,
      status: "completed"
    });

  } catch (error) {
    console.error(`Ошибка: ${error.message}`);
    process.exit(1);
  }
}

// Запуск скрипта
main();