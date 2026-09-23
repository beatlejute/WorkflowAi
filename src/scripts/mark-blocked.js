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

import path from "path";
import { findProjectRoot } from "workflow-ai/lib/find-root.mjs";
import { printResult } from "workflow-ai/lib/utils.mjs";
import { markBlockedTicket } from "./mark-blocked-core.js";

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

// Основная функция
function main() {
  try {
    const result = markBlockedTicket({
      ticketId,
      attempts,
      reason,
      ticketsDir: TICKETS_DIR,
      stateDir: STATE_DIR,
      alertsFile: ALERTS_FILE,
      project: path.basename(PROJECT_DIR),
    });

    console.log(`✅ Frontmatter тикета ${ticketId} обновлен`);

    if (result.stateDirCreated) {
      console.log(`✅ Директория ${STATE_DIR} создана`);
    }

    if (result.alertWritten) {
      console.log(`✅ Запись добавлена в ${ALERTS_FILE}`);
    } else {
      console.warn(`⚠️  Предупреждение: не удалось записать в alerts.jsonl: ${result.alertError}`);
      console.log(`ℹ️  Frontmatter обновлен, запись в alerts пропущена`);
    }

    // Вывод результата
    printResult({
      ticket_id: ticketId,
      reason: reason,
      attempts: attempts,
      blocked_at: result.blockedAt,
      alerts_file: ALERTS_FILE,
      status: "completed"
    });

  } catch (error) {
    if (error.code === 'TICKET_NOT_FOUND') {
      console.error(`Ошибка: тикет ${ticketId} не найден в ${TICKETS_DIR}`);
      process.exit(1);
    }
    console.error(`Ошибка: ${error.message}`);
    process.exit(1);
  }
}

// Запуск скрипта
main();