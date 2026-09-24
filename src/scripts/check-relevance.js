#!/usr/bin/env node

/**
 * check-relevance.js - Скрипт проверки актуальности тикета
 *
 * Использование:
 *   node check-relevance.js <path-to-ticket>
 *
 * Вывод:
 *   ---RESULT---
 *   verdict: relevant|irrelevant
 *   reason: ...
 *   ---RESULT---
 */

import fs from "fs";
import path from "path";
import { findProjectRoot } from "workflow-ai/lib/find-root.mjs";
import {
  parseFrontmatter,
  getLastReviewStatus,
  appendReviewEntry,
} from "workflow-ai/lib/utils.mjs";

const PROJECT_DIR = findProjectRoot();
const WORKFLOW_DIR = path.join(PROJECT_DIR, ".workflow");
const TICKETS_DIR = path.join(WORKFLOW_DIR, "tickets");

const VALID_STATUSES = [
  "backlog",
  "ready",
  "in-progress",
  "blocked",
  "review",
  "done",
  "archive",
];

export function getCurrentStatus(ticketPath) {
  const fileName = path.basename(ticketPath);
  for (const status of VALID_STATUSES) {
    const statusDir = path.join(TICKETS_DIR, status);
    const expectedPath = path.join(statusDir, fileName);
    if (ticketPath === expectedPath) {
      return status;
    }
  }
  return null;
}

export function extractPlanId(parentPlan) {
  if (!parentPlan) return null;
  const basename = path.basename(parentPlan, ".md");
  const match = basename.match(/^PLAN-(\d+)$/i);
  if (match) {
    return `PLAN-${String(parseInt(match[1], 10)).padStart(3, "0")}`;
  }
  return basename;
}

// Конец секции — следующий заголовок или конец текста. Прежде третьей альтернативой
// стоял `\z`, но в JS-регэкспах такого якоря нет: без флага u это просто буква «z».
// Проверено запуском 2026-09-24: секция критериев, стоящая последней, не находилась
// вовсе (completed: false при всех [x]), а секция с буквой z в тексте обрезалась на
// ней — «- [x] size ok» превращалось в «- [x] si», и пункты после этого места не
// считались. Невыполненный пункт после буквы z давал completed: true, и тикет с
// пройденным ревью уходил в irrelevant/dod_completed, хотя критерий не выполнен.
// Без флага m `$` — ровно конец текста.
export function getDodCompletion(content) {
  const dodSectionMatch = content.match(/## Критерии готовности.*?\n([\s\S]*?)(?=\n## |\n# |$)/i);
  if (!dodSectionMatch) return { completed: false, total: 0, checked: 0 };

  const section = dodSectionMatch[1];
  const checkedMatches = section.match(/\[x\]/gi) || [];
  const uncheckedMatches = section.match(/\[ \]/gi) || [];

  const total = checkedMatches.length + uncheckedMatches.length;
  const completed = total > 0 && uncheckedMatches.length === 0;

  return { completed, total, checked: checkedMatches.length };
}

export function hasResultSection(content) {
  const resultPatterns = [
    /##\s*Result/gi,
    /##\s*Результат/gi,
    /##\s*Результат выполнения/gi,
  ];
  return resultPatterns.some((pattern) => pattern.test(content));
}

// Тот же дефект `\z`, что в getDodCompletion: секция блокировок последней не
// находилась, а текст обрезался на первой букве z.
export function getBlockedSection(content) {
  const blockedMatch = content.match(/##\s*Блокировки\s*\n([\s\S]*?)(?=\n## |\n# |$)/i);
  return blockedMatch ? blockedMatch[1].trim() : "";
}

export function findTicketInColumns(ticketId) {
  for (const status of VALID_STATUSES) {
    const statusDir = path.join(TICKETS_DIR, status);
    const ticketPath = path.join(statusDir, `${ticketId}.md`);
    if (fs.existsSync(ticketPath)) {
      return status;
    }
  }
  return null;
}

export async function checkRelevance(ticketPath) {
  if (!fs.existsSync(ticketPath)) {
    // file_not_found — это не ошибка скрипта (verdict=relevant — fail-safe).
    // Не выходим с exit=1, чтобы pipeline продолжил выполнение следующего стейджа.
    return {
      verdict: "relevant",
      reason: "file_not_found",
      warning: `Ticket file not found: ${ticketPath}`,
    };
  }

  let content;
  try {
    content = fs.readFileSync(ticketPath, "utf8");
  } catch (e) {
    return {
      verdict: "relevant",
      reason: "read_error",
      error: `Failed to read ticket: ${e.message}`,
    };
  }

  let frontmatter, body;
  try {
    ({ frontmatter, body } = parseFrontmatter(content));
  } catch (e) {
    return {
      verdict: "relevant",
      reason: "invalid_frontmatter",
      warning: `Failed to parse frontmatter: ${e.message}. Treating as relevant (fail-safe).`,
    };
  }

  const currentStatus = getCurrentStatus(ticketPath);
  const fullContent = body;

  const lastReview = getLastReviewStatus(fullContent);
  if (lastReview === "skipped") {
    return { verdict: "irrelevant", reason: "already_skipped" };
  }
  if (lastReview === "failed") {
    return { verdict: "relevant", reason: "review_failed_needs_rework" };
  }

  if (frontmatter.blocked === true || frontmatter.blocked === "true") {
    return { verdict: "relevant", reason: "blocked" };
  }

  const blockedSection = getBlockedSection(fullContent);
  const hasActiveBlockers = blockedSection.length > 0 && !blockedSection.includes("нет");
  if (hasActiveBlockers) {
    return { verdict: "relevant", reason: "blocked" };
  }

  const parentPlan = frontmatter.parent_plan;
  if (parentPlan) {
    const planId = extractPlanId(parentPlan);
    if (planId) {
      const planPath = path.join(WORKFLOW_DIR, "plans", "current", `${planId}.md`);
      if (fs.existsSync(planPath)) {
        try {
          const planContent = fs.readFileSync(planPath, "utf8");
          const { frontmatter: planFm } = parseFrontmatter(planContent);
          const planStatus = planFm.status;
          if (["completed", "archived", "cancelled"].includes(planStatus)) {
            return { verdict: "irrelevant", reason: "plan_inactive" };
          }
        } catch (e) {
          // fail-safe: treat as relevant
        }
      } else {
        // fail-safe: treat as relevant
      }
    }
  } else {
    // fail-safe: parent_plan is empty
  }

  const dod = getDodCompletion(fullContent);
  const hasResult = hasResultSection(fullContent);

  if (dod.completed && hasResult) {
    if (lastReview === "passed") {
      return { verdict: "irrelevant", reason: "dod_completed" };
    } else if (lastReview === null) {
      return { verdict: "relevant", reason: "needs_review" };
    }
  }

  const dependencies = frontmatter.dependencies || [];
  if (dependencies.length > 0) {
    for (const dep of dependencies) {
      const depStatus = findTicketInColumns(dep);
      if (depStatus === null) {
        return { verdict: "irrelevant", reason: "dependencies_inactive" };
      }
      if (depStatus === "blocked") {
        try {
          const blockedDir = path.join(TICKETS_DIR, "blocked", `${dep}.md`);
          const blockedContent = fs.readFileSync(blockedDir, "utf8");
          const { body: blockedBody } = parseFrontmatter(blockedContent);
          if (blockedBody.toLowerCase().includes("неактуально")) {
            return { verdict: "irrelevant", reason: "dependencies_inactive" };
          }
        } catch (e) {
          // ignore
        }
      }
    }
  }

  return { verdict: "relevant", reason: "all_checks_passed" };
}

// IMPL-89: Replace manual markdown-write with appendReviewEntry from review-section.mjs.
export function addSkippedReview(ticketPath, reason) {
  const date = new Date().toISOString().slice(0, 10);
  const r = appendReviewEntry(ticketPath, {
    date,
    agent: 'script-check-relevance',
    status: 'skipped',
    summary: reason,
  });
  if (!r?.ok) {
    throw new Error(`addSkippedReview failed: ${r?.code || 'unknown'} ${r?.error || ''}`);
  }
}

/**
 * Путь к тикету из аргумента стадии: пайплайн передаёт контекст строкой
 * («ticket_id: IMPL-001 …»), человек — ID или путь. ID резолвится в in-progress/:
 * стадия проверки актуальности стоит перед выполнением.
 *
 * Экспортируется для теста (src/tests/check-relevance.test.mjs).
 */
export function resolveTicketArg(arg, cwd = process.cwd()) {
  let ticketPath;
  const ticketMatch = arg.match(/ticket_id:\s*(\S+)/);
  if (ticketMatch) {
    ticketPath = path.join(TICKETS_DIR, "in-progress", `${ticketMatch[1]}.md`);
  } else if (/^[A-Z]+-\d+$/i.test(arg)) {
    // Чистый ticket_id (например, IMPL-001) — резолвим в in-progress
    ticketPath = path.join(TICKETS_DIR, "in-progress", `${arg}.md`);
  } else {
    ticketPath = arg;
  }
  return path.isAbsolute(ticketPath) ? ticketPath : path.resolve(cwd, ticketPath);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error("Usage: node check-relevance.js <path-to-ticket>");
    console.error("Example: node check-relevance.js .workflow/tickets/in-progress/IMPL-001.md");
    process.exit(1);
  }

  const ticketPath = resolveTicketArg(args[0]);

  const result = await checkRelevance(ticketPath);

  if (result.warning && !result.error) {
    console.error(`[WARNING] ${result.warning}`);
  }

  if (result.error) {
    console.error(`[ERROR] ${result.error}`);
  }

  if (result.verdict === "irrelevant") {
    try {
      addSkippedReview(ticketPath, result.reason);
    } catch (e) {
      console.error(`[ERROR] Failed to add review entry: ${e.message}`);
    }
  }

  console.log("---RESULT---");
  console.log(`verdict: ${result.verdict}`);
  console.log(`reason: ${result.reason}`);
  console.log("---RESULT---");

  if (result.error) {
    process.exit(1);
  }
}

// Запуск main() только при прямом вызове (не при импорте) — тот же приём, что в
// check-plan-templates.js, check-conditions.js и move-to-review.js.
const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("check-relevance.js") ||
    process.argv[1].endsWith("check-relevance"));

if (isDirectRun) {
  main().catch((e) => {
    console.error("[FATAL]", e.message);
    process.exit(1);
  });
}
