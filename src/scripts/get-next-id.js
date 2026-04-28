#!/usr/bin/env node

/**
 * get-next-id.js - Универсальный генератор ID для тикетов, планов и других артефактов
 *
 * Режимы:
 *
 *   1) Одиночный префикс (legacy, для create-plan / create-report):
 *      node get-next-id.js --prefix TASK --dir tickets
 *      node get-next-id.js --prefix PLAN --dir plans
 *      Вывод: { status: "success", id: "TASK-007" }
 *
 *   2) Карта по всем префиксам из config.yaml (для decompose-plan):
 *      node get-next-id.js --all-from-config
 *      Читает .workflow/config/config.yaml → task_types.*.prefix,
 *      для каждого префикса возвращает следующий свободный номер по .workflow/tickets/.
 *      Вывод: { status: "success", id_ranges: { TASK: 8, QA: 26, HUMAN: 2, ... } }
 */

import fs from "fs";
import path from "path";
import { findProjectRoot } from "workflow-ai/lib/find-root.mjs";
import { printResult } from "workflow-ai/lib/utils.mjs";
import { getNextId } from "workflow-ai/lib/operations/tickets.mjs";

const PROJECT_DIR = findProjectRoot();

function parseArgs() {
  const args = process.argv.slice(2);
  let prefix = null;
  let dir = null;
  let allFromConfig = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--prefix" && i + 1 < args.length) {
      prefix = args[i + 1];
      i++;
    } else if (args[i] === "--dir" && i + 1 < args.length) {
      dir = args[i + 1];
      i++;
    } else if (args[i] === "--all-from-config") {
      allFromConfig = true;
    }
  }

  return { prefix, dir, allFromConfig };
}

function findMaxNumber(targetDir, prefix) {
  let maxNum = 0;
  const regex = new RegExp(`^${prefix}-(\\d+)\\.md$`, "i");

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

function readPrefixesFromConfig() {
  const configPath = path.join(PROJECT_DIR, ".workflow", "config", "config.yaml");

  if (!fs.existsSync(configPath)) {
    throw new Error(`config.yaml not found: ${configPath}`);
  }

  const text = fs.readFileSync(configPath, "utf8");
  const lines = text.split(/\r?\n/);

  const prefixes = [];
  let inTaskTypes = false;
  let taskTypesIndent = -1;

  for (const rawLine of lines) {
    // Убрать комментарии
    const line = rawLine.replace(/\s+#.*$/, "").replace(/^#.*$/, "");
    if (line.trim() === "") continue;

    const indent = line.length - line.trimStart().length;

    if (!inTaskTypes) {
      if (/^task_types\s*:\s*$/.test(line.trim())) {
        inTaskTypes = true;
        taskTypesIndent = indent;
      }
      continue;
    }

    // Вышли из секции task_types (вернулись на тот же или меньший отступ с новым ключом)
    if (indent <= taskTypesIndent && line.trim() !== "") {
      break;
    }

    const m = line.match(/^\s*prefix\s*:\s*["']?([A-Z][A-Z0-9_]*)["']?\s*$/);
    if (m) {
      const p = m[1];
      if (!prefixes.includes(p)) {
        prefixes.push(p);
      }
    }
  }

  if (prefixes.length === 0) {
    throw new Error("No prefixes found in config.yaml → task_types.*.prefix");
  }

  return prefixes;
}

async function runSinglePrefix(prefix, dir) {
  try {
    const nextId = await getNextId(PROJECT_DIR, prefix, { dir });
    printResult({ status: "success", id: nextId });
  } catch (err) {
    console.error(err.message);
    printResult({ status: "error", error: err.message });
    process.exit(1);
  }
}

async function runAllFromConfig() {
  const prefixes = readPrefixesFromConfig();
  const ticketsDir = path.join(PROJECT_DIR, ".workflow", "tickets");

  const idRanges = {};
  for (const prefix of prefixes) {
    const maxNum = fs.existsSync(ticketsDir) ? findMaxNumber(ticketsDir, prefix) : 0;
    idRanges[prefix] = maxNum + 1;
  }

  // Параллельно возвращаем JSON-строку, потому что runner workflow-ai
  // при подстановке $context.<key> в строку instructions применяет неявный
  // toString() — объекты превращаются в "[object Object]". Скалярная
  // JSON-строка подставляется корректно, декомпозитор распарсит её сам.
  printResult({
    status: "success",
    id_ranges: idRanges,
    id_ranges_json: JSON.stringify(idRanges),
  });
}

async function main() {
  const { prefix, dir, allFromConfig } = parseArgs();

  if (allFromConfig) {
    try {
      await runAllFromConfig();
    } catch (err) {
      console.error(err.message);
      printResult({ status: "error", error: err.message });
      process.exit(1);
    }
    return;
  }

  if (!prefix || !dir) {
    console.error("Usage:");
    console.error("  node get-next-id.js --prefix <PREFIX> --dir <DIRECTORY>");
    console.error("  node get-next-id.js --all-from-config");
    printResult({
      status: "error",
      error: "Missing required arguments: either --all-from-config, or both --prefix and --dir",
    });
    process.exit(1);
  }

  await runSinglePrefix(prefix, dir);
}

main();
