#!/usr/bin/env node

/**
 * get-next-id.js - Универсальный генератор ID для тикетов, планов и других артефактов
 *
 * Использование:
 *   node get-next-id.js --prefix TASK --dir tickets
 *   node get-next-id.js --prefix PLAN --dir plans
 *
 * Вывод: следующий ID через ---RESULT---, например: TASK-007
 */

import fs from "fs";
import path from "path";
import { findProjectRoot } from "workflow-ai/lib/find-root.mjs";
import { printResult } from "workflow-ai/lib/utils.mjs";

const PROJECT_DIR = findProjectRoot();

function parseArgs() {
  const args = process.argv.slice(2);
  let prefix = null;
  let dir = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--prefix" && i + 1 < args.length) {
      prefix = args[i + 1];
      i++;
    } else if (args[i] === "--dir" && i + 1 < args.length) {
      dir = args[i + 1];
      i++;
    }
  }

  return { prefix, dir };
}

function findMaxNumber(targetDir, prefix) {
  let maxNum = 0;
  const regex = new RegExp(`^${prefix}-(\\d{3})\\.md$`, "i");

  function scanDirectory(dir) {
    if (!fs.existsSync(dir)) {
      return;
    }

    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        scanDirectory(fullPath);
      } else if (entry.isFile()) {
        const match = entry.name.match(regex);
        if (match) {
          const num = parseInt(match[1], 10);
          if (num > maxNum) {
            maxNum = num;
          }
        }
      }
    }
  }

  scanDirectory(targetDir);
  return maxNum;
}

function formatNumber(num) {
  return num.toString().padStart(3, "0");
}

async function main() {
  const { prefix, dir } = parseArgs();

  if (!prefix || !dir) {
    console.error("Usage: node get-next-id.js --prefix <PREFIX> --dir <DIRECTORY>");
    console.error("Example: node get-next-id.js --prefix TASK --dir tickets");
    printResult({
      status: "error",
      error: "Missing required arguments: --prefix and --dir",
    });
    process.exit(1);
  }

  let targetDir;

  if (dir === "tickets") {
    targetDir = path.join(PROJECT_DIR, ".workflow", "tickets");
  } else if (dir === "plans") {
    targetDir = path.join(PROJECT_DIR, ".workflow", "plans");
  } else {
    targetDir = path.join(PROJECT_DIR, dir);
  }

  if (!fs.existsSync(targetDir)) {
    const nextId = `${prefix}-001`;
    printResult({ status: "success", id: nextId });
    return;
  }

  const maxNum = findMaxNumber(targetDir, prefix);
  const nextNum = maxNum + 1;
  const nextId = `${prefix}-${formatNumber(nextNum)}`;

  printResult({ status: "success", id: nextId });
}

main();