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
import YAML from "../lib/js-yaml.mjs";
import { findProjectRoot } from "../lib/find-root.mjs";
import {
  parseFrontmatter,
  serializeFrontmatter,
  getLastReviewStatus,
} from "../lib/utils.mjs";

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

function getCurrentStatus(ticketPath) {
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

function extractPlanId(parentPlan) {
  if (!parentPlan) return null;
  const basename = path.basename(parentPlan, ".md");
  const match = basename.match(/^PLAN-(\d+)$/i);
  if (match) {
    return `PLAN-${String(parseInt(match[1], 10)).padStart(3, "0")}`;
  }
  return basename;
}

function getDodCompletion(content) {
  const dodSectionMatch = content.match(/## Критерии готовности.*?\n([\s\S]*?)(?=\n## |\n# |\z)/i);
  if (!dodSectionMatch) return { completed: false, total: 0, checked: 0 };

  const section = dodSectionMatch[1];
  const checkedMatches = section.match(/\[x\]/gi) || [];
  const uncheckedMatches = section.match(/\[ \]/gi) || [];

  const total = checkedMatches.length + uncheckedMatches.length;
  const completed = total > 0 && uncheckedMatches.length === 0;

  return { completed, total, checked: checkedMatches.length };
}

function hasResultSection(content) {
  const resultPatterns = [
    /##\s*Result/gi,
    /##\s*Результат/gi,
    /##\s*Результат выполнения/gi,
  ];
  return resultPatterns.some((pattern) => pattern.test(content));
}

function getBlockedSection(content) {
  const blockedMatch = content.match(/##\s*Блокировки\s*\n([\s\S]*?)(?=\n## |\n# |\z)/i);
  return blockedMatch ? blockedMatch[1].trim() : "";
}

function findTicketInColumns(ticketId) {
  for (const status of VALID_STATUSES) {
    const statusDir = path.join(TICKETS_DIR, status);
    const ticketPath = path.join(statusDir, `${ticketId}.md`);
    if (fs.existsSync(ticketPath)) {
      return status;
    }
  }
  return null;
}

async function checkRelevance(ticketPath) {
  if (!fs.existsSync(ticketPath)) {
    return {
      verdict: "relevant",
      reason: "file_not_found",
      error: `Ticket file not found: ${ticketPath}`,
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

function addSkippedReview(ticketPath, reason) {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);

  let content;
  try {
    content = fs.readFileSync(ticketPath, "utf8");
  } catch (e) {
    throw new Error(`Failed to read ticket: ${e.message}`);
  }

  let { frontmatter, body } = parseFrontmatter(content);

  const reviewSectionMatch = body.match(/##\s*Ревью\s*\n([\s\S]*)/i);
  let newBody;

  if (reviewSectionMatch) {
    const reviewContent = reviewSectionMatch[1];
    const lines = reviewContent.split("\n");
    let insertIndex = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith("|") && lines[i].includes("---")) {
        insertIndex = i + 1;
        break;
      }
    }

    const newRow = `| ${date} | ⏭️ skipped | ${reason} |`;
    lines.splice(insertIndex, 0, newRow);
    newBody = body.slice(0, reviewSectionMatch.index) + lines.join("\n");
  } else {
    const reviewTable = `\n## Ревью\n\n| Дата | Статус | Самари |\n|------|--------|--------|\n| ${date} | ⏭️ skipped | ${reason} |\n`;
    newBody = body.trimEnd() + reviewTable;
  }

  const newContent = serializeFrontmatter(frontmatter) + newBody;
  fs.writeFileSync(ticketPath, newContent, "utf8");
}

async function main() {
  const args = process.argv.slice(2);
  let ticketPath;

  if (args.length === 0) {
    console.error("Usage: node check-relevance.js <path-to-ticket>");
    console.error("Example: node check-relevance.js .workflow/tickets/in-progress/IMPL-001.md");
    process.exit(1);
  } else if (args.length === 1) {
    const prompt = args[0];
    const ticketMatch = prompt.match(/ticket_id:\s*(\S+)/);
    if (ticketMatch) {
      const ticketId = ticketMatch[1];
      ticketPath = path.join(TICKETS_DIR, "in-progress", `${ticketId}.md`);
    } else {
      ticketPath = args[0];
    }
  } else {
    ticketPath = args[0];
  }

  if (!path.isAbsolute(ticketPath)) {
    ticketPath = path.resolve(process.cwd(), ticketPath);
  }

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

main().catch((e) => {
  console.error("[FATAL]", e.message);
  process.exit(1);
});
