#!/usr/bin/env node

/**
 * move-ticket.js - Скрипт для перемещения тикетов между директориями канбан-доски
 *
 * Использование:
 *   node move-ticket.js <ticket_id> <target>
 *
 * Пример:
 *   node move-ticket.js IMPL-001 in-progress
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import YAML from "workflow-ai/lib/js-yaml.mjs";
import { findProjectRoot } from "workflow-ai/lib/find-root.mjs";
import {
  parseFrontmatter,
  printResult,
  serializeFrontmatter,
  getLastReviewStatus,
  appendReviewEntry,
} from "workflow-ai/lib/utils.mjs";

const logger = {
  info: (msg) => console.error(`[INFO] ${msg}`),
  warn: (msg) => console.error(`[WARN] ${msg}`),
};

// Корень проекта
const PROJECT_DIR = findProjectRoot();
// Базовая директория workflow
const WORKFLOW_DIR = path.join(PROJECT_DIR, ".workflow");
const TICKETS_DIR = path.join(WORKFLOW_DIR, "tickets");

// Доступные статусы
const VALID_STATUSES = [
  "backlog",
  "ready",
  "in-progress",
  "blocked",
  "review",
  "done",
  "archive",
];

// Таблица допустимых переходов
const VALID_TRANSITIONS = {
  backlog: ["ready", "blocked", "done"],
  ready: ["in-progress", "review", "backlog"],
  "in-progress": ["done", "blocked", "review"],
  blocked: ["ready"],
  review: ["done", "ready", "in-progress", "blocked"],
  done: ["ready", "blocked", "archive"],
  archive: ["backlog"],
};

/**
 * Определяет текущий статус тикета по расположению файла
 */
function getStatusFromPath(filePath) {
  const fileName = path.basename(filePath);
  for (const status of VALID_STATUSES) {
    const statusDir = path.join(TICKETS_DIR, status);
    const expectedPath = path.join(statusDir, fileName);
    if (filePath === expectedPath) {
      return status;
    }
  }
  return null;
}

/**
 * Проверяет допустимость перехода
 */
function isValidTransition(from, to) {
  if (!VALID_STATUSES.includes(from)) {
    return { valid: false, error: `Неверный исходный статус: ${from}` };
  }
  if (!VALID_STATUSES.includes(to)) {
    return {
      valid: false,
      error: `Неверный целевой статус: ${to}. Доступные: ${VALID_STATUSES.join(", ")}`,
    };
  }

  const allowedTransitions = VALID_TRANSITIONS[from] || [];
  if (!allowedTransitions.includes(to)) {
    return {
      valid: false,
      error: `Переход из ${from} в ${to} недопустим. Доступные переходы: ${allowedTransitions.join(", ") || "нет"}`,
    };
  }

  return { valid: true };
}

/**
 * Hook для обновления approval-файлов при перемещении тикета
 * @param {string} ticketId - ID тикета
 * @param {string} target - целевой статус
 * @param {object} fsModule - модуль fs (для mock в тестах)
 * @param {string} workflowDir - директория .workflow
 */
function updateApprovalFilesHook(ticketId, target, fsModule = fs, workflowDir = WORKFLOW_DIR) {
  try {
    const approvalsDir = path.join(workflowDir, "approvals");
    if (fsModule.existsSync(approvalsDir)) {
      const files = fsModule.readdirSync(approvalsDir);
      const escapedTicketId = ticketId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`^${escapedTicketId}_manual-gate-.*_\\d+\\.json$`);
      for (const file of files) {
        if (!pattern.test(file)) continue;
        const filePath = path.join(approvalsDir, file);
        try {
          const data = JSON.parse(fsModule.readFileSync(filePath, "utf8"));
          if (data.status === "pending") {
            data.status = "approved";
            data.decided_by = "move-ticket";
            data.comment = `auto-approved on move to ${target}`;
            data.updated_at = new Date().toISOString();
            fsModule.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
            logger.info(`Approval file ${file} auto-approved on move to ${target}`);
          }
        } catch (err) {
          logger.warn(`Corrupt approval file ${file}: ${err.message}`);
          // продолжаем, не падаем
        }
      }
    }
  } catch (err) {
    // Ошибка hook'а не должна фейлить само перемещение
    logger.warn(`Approval hook error: ${err.message}`);
  }
}

/**
 * Основная функция перемещения тикета
 */
async function moveTicket(ticketId, target) {
  // Поиск файла тикета во всех директориях
  let sourceDir = null;
  let currentStatus = null;

  for (const status of VALID_STATUSES) {
    const statusDir = path.join(TICKETS_DIR, status);
    const ticketPath = path.join(statusDir, `${ticketId}.md`);
    if (fs.existsSync(ticketPath)) {
      sourceDir = statusDir;
      currentStatus = status;
      break;
    }
  }

  if (!sourceDir) {
    return {
      status: "error",
      ticket_id: ticketId,
      error: `Тикет ${ticketId} не найден ни в одной из директорий`,
    };
  }

  // Проверка допустимости перехода
  const transitionCheck = isValidTransition(currentStatus, target);
  if (!transitionCheck.valid) {
    return {
      status: "error",
      ticket_id: ticketId,
      from: currentStatus,
      to: target,
      error: transitionCheck.error,
    };
  }

  const sourcePath = path.join(sourceDir, `${ticketId}.md`);
  const targetDir = path.join(TICKETS_DIR, target);
  const targetPath = path.join(targetDir, `${ticketId}.md`);

  // Чтение файла тикета
  let content;
  try {
    content = fs.readFileSync(sourcePath, "utf8");
  } catch (e) {
    return {
      status: "error",
      ticket_id: ticketId,
      error: `Не удалось прочитать файл: ${e.message}`,
    };
  }

  // Парсинг frontmatter
  let frontmatter, body;
  try {
    ({ frontmatter, body } = parseFrontmatter(content));
  } catch (e) {
    return {
      status: "error",
      ticket_id: ticketId,
      error: e.message,
    };
  }

  // Обновление frontmatter
  const now = new Date().toISOString();
  frontmatter.updated_at = now;

  // Если переход в done, добавляем completed_at
  if (target === "done" && currentStatus !== "done") {
    frontmatter.completed_at = now;
  }

  // Fallback: если тикет идёт в done из review, но агент не записал секцию "## Ревью" — дописываем
  // IMPL-88: используем appendReviewEntry вместо ручного markdown-write.
  // ВАЖНО: пишем напрямую через body manipulation (а не file rewrite через appendReviewEntry),
  // потому что move-ticket в этой же транзакции serializeFrontmatter(...) + renameSync — иначе
  // запись в исходный файл потеряется при rename. Используем те же поля что и appendReviewEntry.
  if (
    target === "done" &&
    currentStatus === "review" &&
    getLastReviewStatus(content) === null
  ) {
    const date = now.slice(0, 16).replace("T", " ");
    const summary = "Pipeline fallback: агент не записал секцию ревью";
    const agent = "script-move-fallback";
    const reviewSection = `\n## Ревью\n\n| Дата | Статус | Самари | Агент |\n|------|--------|--------|-------|\n| ${date} | ✅ passed | ${summary} | ${agent} |\n`;
    body = body.trimEnd() + "\n" + reviewSection;
  }

  // Если переход из blocked, удаляем blocked_reason
  if (currentStatus === "blocked" && frontmatter.blocked_reason) {
    delete frontmatter.blocked_reason;
  }

  // Сериализация нового контента
  const newContent = serializeFrontmatter(frontmatter) + body;

  // Создание целевой директории если не существует
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // Перемещение файла
  try {
    fs.renameSync(sourcePath, targetPath);
  } catch (e) {
    return {
      status: "error",
      ticket_id: ticketId,
      error: `Не удалось переместить файл: ${e.message}`,
    };
  }

  // Запись обновлённого контента
  try {
    fs.writeFileSync(targetPath, newContent, "utf8");
  } catch (e) {
    return {
      status: "error",
      ticket_id: ticketId,
      error: `Не удалось записать файл: ${e.message}`,
    };
  }

  // Hook: обновление approval-файлов (если есть) — срабатывает на любой move
  updateApprovalFilesHook(ticketId, target);

  return {
    status: "moved",
    ticket_id: ticketId,
    from: currentStatus,
    to: target,
  };
}

// Export for testing
export { moveTicket, updateApprovalFilesHook };

// Main entry point — guard prevents execution when imported as module in tests.
// Используем fs.realpathSync чтобы корректно сравнивать пути на Windows когда .workflow/src/scripts/ — junction.
// Без realpathSync argv[1] = путь через junction, а import.meta.url = разрешённый target — строки не совпадают.
function __isMainModule() {
  try {
    const argvPath = fs.realpathSync(path.resolve(process.argv[1] || ""));
    const metaPath = fileURLToPath(import.meta.url);
    return argvPath === metaPath;
  } catch {
    return false;
  }
}

if (__isMainModule()) {
  const rawArgs = process.argv.slice(2);
  let ticketId, target;

  if (rawArgs.length >= 2) {
    // Прямой вызов: node move-ticket.js IMPL-001 in-progress
    ticketId = rawArgs[0];
    target = rawArgs[1];
  } else if (rawArgs.length === 1) {
    // Вызов через pipeline runner: один аргумент — промпт с контекстом
    // Формат: "skill-name\n\nContext:\n  ticket_id: X\n  target: Y\n..."
    const prompt = rawArgs[0];
    const ticketMatch = prompt.match(/ticket_id:\s*(\S+)/);
    const targetMatch = prompt.match(/target:\s*(\S+)/);
    ticketId = ticketMatch?.[1];
    target = targetMatch?.[1];
    if (!ticketId || !target) {
      console.error(
        "[ERROR] Cannot parse ticket_id or target from pipeline context",
      );
      printResult({
        status: "error",
        error: "Missing ticket_id or target in pipeline context",
      });
      process.exit(1);
    }
  } else {
    console.error("Usage: node move-ticket.js <ticket_id> <target>");
    console.error("Example: node move-ticket.js IMPL-001 in-progress");
    console.error("Available targets:", VALID_STATUSES.join(", "));
    printResult({ status: "error", error: "Missing arguments" });
    process.exit(1);
  }

  moveTicket(ticketId, target).then((result) => {
    printResult(result);
    if (result.status === "error") {
      process.exit(1);
    }
  });
}
