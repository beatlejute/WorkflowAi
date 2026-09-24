#!/usr/bin/env node

/**
 * move-to-review.js — Перемещает тикет из in-progress/ в review/
 *
 * Читает ticket_id из контекста pipeline runner'а.
 *
 * Выводит результат:
 *   ---RESULT---
 *   status: moved | error
 *   ticket_id: IMPL-001
 *   ---RESULT---
 */

import fs from "fs";
import path from "path";
import { findProjectRoot } from "workflow-ai/lib/find-root.mjs";
import {
  printResult,
  getLastReviewStatus,
  replaceFileAtomicSync,
} from "workflow-ai/lib/utils.mjs";

// Корень проекта
const PROJECT_DIR = findProjectRoot();
const TICKETS_DIR = path.join(PROJECT_DIR, ".workflow", "tickets");
const IN_PROGRESS_DIR = path.join(TICKETS_DIR, "in-progress");
const REVIEW_DIR = path.join(TICKETS_DIR, "review");
const ARCHIVE_DIR = path.join(TICKETS_DIR, "archive");

/**
 * Парсит ticket_id из промпта (контекста pipeline runner)
 */
export function parseTicketId(prompt) {
  const match = prompt.match(/ticket_id:\s*(\S+)/);
  return match ? match[1].trim() : null;
}

/**
 * Перемещает тикет из in-progress/ в review/
 *
 * Экспортируется для теста (src/tests/move-to-review.test.mjs): у функции пять
 * исходов, и каждый меняет состояние доски.
 */
export function moveToReview(ticketId) {
  const sourcePath = path.join(IN_PROGRESS_DIR, `${ticketId}.md`);
  const targetPath = path.join(REVIEW_DIR, `${ticketId}.md`);

  if (!fs.existsSync(sourcePath)) {
    // Ticket may have been moved by the agent — check other locations
    const reviewPath = path.join(REVIEW_DIR, `${ticketId}.md`);
    if (fs.existsSync(reviewPath)) {
      return {
        status: "skipped",
        ticket_id: ticketId,
        reason: `${ticketId} already in review/`,
      };
    }
    const donePath = path.join(TICKETS_DIR, "done", `${ticketId}.md`);
    const archivePath = path.join(ARCHIVE_DIR, `${ticketId}.md`);
    if (fs.existsSync(donePath)) {
      // Проверяем, есть ли у тикета ревью — если нет, перемещаем в review/
      const doneContent = fs.readFileSync(donePath, "utf8");
      const reviewStatus = getLastReviewStatus(doneContent);
      if (reviewStatus === null) {
        // Тикет в done/ без ревью — агент переместил его самовольно, возвращаем в review/
        if (!fs.existsSync(REVIEW_DIR)) {
          fs.mkdirSync(REVIEW_DIR, { recursive: true });
        }
        const reviewTarget = path.join(REVIEW_DIR, `${ticketId}.md`);
        fs.renameSync(donePath, reviewTarget);
        console.log(
          `[INFO] ${ticketId} was in done/ without review — moved to review/`,
        );
        return {
          status: "moved",
          ticket_id: ticketId,
          from: "done",
          to: "review",
        };
      }
      return {
        status: "skipped",
        ticket_id: ticketId,
        reason: `${ticketId} already in done/ with review`,
      };
    }
    if (fs.existsSync(archivePath)) {
      return {
        status: "skipped",
        ticket_id: ticketId,
        reason: `${ticketId} already in archive/`,
      };
    }
    return {
      status: "error",
      ticket_id: ticketId,
      error: `${ticketId} not found in in-progress/`,
    };
  }

  const content = fs.readFileSync(sourcePath, "utf8");

  // updated_at не обновляем: verify-artifacts сравнивает mtime файлов с updated_at,
  // чтобы убедиться, что они были изменены агентом. updated_at должен сохранять момент
  // перемещения тикета в in-progress (до начала работы агента) — иначе любой
  // легитимно изменённый файл будет ложно отклонён (mtime_edit < updated_at_review).

  if (!fs.existsSync(REVIEW_DIR)) {
    fs.mkdirSync(REVIEW_DIR, { recursive: true });
  }

  // Сначала переезд, потом содержимое: тикет всё время лежит ровно в одной
  // колонке. Содержимое здесь то же, что и было, но прямая запись всё равно
  // обрезала файл до нуля — и стадии, читающие review/, видели тикет с пустым
  // frontmatter. Запись оставлена (она поднимает mtime, на который смотрят
  // verify-artifacts и восстановление completed_at в sync-ticket-status).
  fs.renameSync(sourcePath, targetPath);
  replaceFileAtomicSync(targetPath, content);

  return {
    status: "moved",
    ticket_id: ticketId,
    from: "in-progress",
    to: "review",
  };
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const prompt = rawArgs[0] || "";

  const ticketId = parseTicketId(prompt);

  if (!ticketId) {
    console.error("[ERROR] No ticket_id in context");
    printResult({ status: "error", error: "Missing ticket_id" });
    process.exit(1);
  }

  console.log(`[INFO] Moving ${ticketId}: in-progress/ → review/`);
  const result = moveToReview(ticketId);
  printResult(result);

  if (result.status === "error") {
    process.exit(1);
  }

  if (result.status === "skipped") {
    console.log(`[INFO] Skipped: ${result.reason}`);
  }
}

// Запуск main() только при прямом вызове (не при импорте) — тот же приём, что в
// check-plan-templates.js и check-conditions.js. Пайплайн зовёт скрипт командой
// `node .workflow/src/scripts/move-to-review.js` (configs/pipeline.yaml).
const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("move-to-review.js") ||
    process.argv[1].endsWith("move-to-review"));

if (isDirectRun) {
  main().catch((e) => {
    console.error(`[ERROR] ${e.message}`);
    printResult({ status: "error", error: e.message });
    process.exit(1);
  });
}
