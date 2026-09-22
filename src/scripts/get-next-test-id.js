#!/usr/bin/env node

/**
 * get-next-test-id.js - Генератор ID для тест-кейсов
 *
 * Usage:
 *   node get-next-test-id.js --skill coach
 *   Output:
 *   ---RESULT---
 *   next_id: TC-COACH-002
 *   ---RESULT---
 */

import fs from "fs";
import path from "path";
import { findProjectRoot } from "workflow-ai/lib/find-root.mjs";
import { printResult } from "workflow-ai/lib/utils.mjs";

const PROJECT_DIR = findProjectRoot();

function parseArgs() {
  const args = process.argv.slice(2);
  let skill = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--skill" && i + 1 < args.length) {
      skill = args[i + 1];
      i++;
    }
  }

  return skill;
}

// Кейсы называются `TC-<SKILL>-NNN-<slug>.yaml`, артефакты прогонов лежат в каталоге
// `TC-<SKILL>-NNN/`. Прежний шаблон `^TC-<SKILL>-NNN\.yaml$` не видел ни того, ни другого:
// на скиле с кейсами 001–004 скрипт вернул TC-ANALYZE-REPORT-001 (2026-09-22) — занятый ID.
function findMaxNumber(skillLower, skillUpper) {
  let maxNum = 0;
  const fileRegex = new RegExp(`^TC-${skillUpper}-(\\d+)(?:-[^/\\\\]*)?\\.yaml$`, "i");
  const dirRegex = new RegExp(`^TC-${skillUpper}-(\\d+)$`, "i");

  const dirs = [
    // канон пакета (репозиторий workflow-ai)
    path.join(PROJECT_DIR, "src", "skills", skillLower, "tests", "cases"),
    // проект-потребитель: скилы подключены junction'ами в .workflow/src/skills
    path.join(PROJECT_DIR, ".workflow", "src", "skills", skillLower, "tests", "cases"),
    // прежнее расположение тестов проекта
    path.join(PROJECT_DIR, ".workflow", "tests", "skills", skillLower, "cases"),
  ];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      continue;
    }

    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const regex = entry.isFile() ? fileRegex : entry.isDirectory() ? dirRegex : null;
      const match = regex && entry.name.match(regex);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > maxNum) {
          maxNum = num;
        }
      }
    }
  }

  return maxNum;
}

function formatNumber(num) {
  return num.toString().padStart(3, "0");
}

function main() {
  const skill = parseArgs();

  if (!skill) {
    console.error("Usage:");
    console.error("  node get-next-test-id.js --skill <name>");
    printResult({
      status: "error",
      error: "Missing required argument: --skill <name>",
    });
    process.exit(1);
  }

  const skillLower = skill.toLowerCase();
  const skillUpper = skill.toUpperCase().replace(/-/g, "-");

  const maxNum = findMaxNumber(skillLower, skillUpper);
  const nextNum = maxNum + 1;
  const nextId = `TC-${skillUpper}-${formatNumber(nextNum)}`;

  printResult({ status: "success", next_id: nextId });
}

main();