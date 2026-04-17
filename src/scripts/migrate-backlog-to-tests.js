#!/usr/bin/env node

/**
 * migrate-backlog-to-tests.js - Триаж и миграция CHG-записей беклога в тест-кейсы
 *
 * Usage:
 *   node migrate-backlog-to-tests.js --backlog <path>                    # один беклог
 *   node migrate-backlog-to-tests.js --backlog <path> --category A       # только кат. A
 *   node migrate-backlog-to-tests.js --dry-run                           # не создавать файлы
 *
 * Output (---RESULT---):
 *   1. Триаж-таблица: CHG-ID | Категория | Обоснование
 *   2. Метаданные категории A (для копирования)
 *   3. Список уникальных принципов/тегов для дедупликации
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { findProjectRoot } from "workflow-ai/lib/find-root.mjs";
import { printResult } from "workflow-ai/lib/utils.mjs";

const PROJECT_DIR = findProjectRoot();

const CATEGORIES = {
  A: {
    name: "Durable behavior",
    description: "правка добавляет проверяемое правило",
    action: "→ метаданные для теста (high priority)",
  },
  B: {
    name: "Structural refactor",
    description: "одноразовая реструктуризация",
    action: "→ pointer в беклоге, без теста",
  },
  C: {
    name: "Config/data fix",
    description: "замена конкретного значения в файле",
    action: "→ L0 static-only, одна строка",
  },
  D: {
    name: "Obsolete",
    description: "секция с тех пор переписана",
    action: "skip",
  },
  E: {
    name: "Out-of-scope",
    description: "OOS-записи",
    action: "skip",
  },
};

function parseArgs() {
  const args = process.argv.slice(2);
  let backlogPath = null;
  let categoryFilter = null;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--backlog" && i + 1 < args.length) {
      backlogPath = args[i + 1];
      i++;
    } else if (args[i] === "--category" && i + 1 < args.length) {
      categoryFilter = args[i + 1].toUpperCase();
      i++;
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    }
  }

  return { backlogPath, categoryFilter, dryRun };
}

function parseBacklogYaml(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  
  const appliedChangesStart = content.indexOf("applied_changes:");
  if (appliedChangesStart === -1) {
    return [];
  }

  const afterSection = content.substring(appliedChangesStart);
  const lines = afterSection.split(/\r?\n/);
  
  const changes = [];
  let currentChange = null;
  let currentField = null;
  let currentValue = [];
  let inAppliedChanges = false;
  let baseIndent = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === "applied_changes:") {
      inAppliedChanges = true;
      baseIndent = line.indexOf("applied_changes");
      continue;
    }

    if (!inAppliedChanges) continue;

    const indent = line.length - line.trimStart().length;

    if (trimmed === "" || (indent <= baseIndent && !trimmed.startsWith("-"))) {
      if (currentChange && currentField) {
        currentChange[currentField] = currentValue.join("\n").trim();
      }
      if (currentChange && Object.keys(currentChange).length > 0) {
        changes.push(currentChange);
      }
      currentChange = null;
      currentField = null;
      currentValue = [];
      
      if (trimmed !== "" && !trimmed.startsWith("- change_id")) {
        inAppliedChanges = false;
        continue;
      }
    }

    if (trimmed.startsWith("- change_id:")) {
      if (currentChange && Object.keys(currentChange).length > 0) {
        changes.push(currentChange);
      }
      currentChange = {};
      const match = trimmed.match(/- change_id:\s*["']?([^"']+)["']?/);
      if (match) {
        currentChange.change_id = match[1];
      }
      continue;
    }

    if (currentChange === null) continue;

    const fieldMatch = trimmed.match(/^(\w+):\s*(.*)$/);
    if (fieldMatch) {
      if (currentField) {
        currentChange[currentField] = currentValue.join("\n").trim();
      }
      currentField = fieldMatch[1];
      const value = fieldMatch[2];
      if (value && !value.startsWith("|")) {
        currentChange[currentField] = value.replace(/^["']|["']$/g, "");
      }
      currentValue = [];
      continue;
    }

    if (trimmed.startsWith("- ") && !trimmed.startsWith("- change_id")) {
      if (currentField === "changed_files" || currentField === "based_on_tickets") {
        if (!currentChange[currentField]) {
          currentChange[currentField] = [];
        }
        const item = trimmed.substring(2).replace(/^["']|["']$/g, "");
        currentChange[currentField].push(item);
      }
      continue;
    }

    if (currentField && indent > baseIndent + 2) {
      currentValue.push(trimmed);
    }
  }

  if (currentChange && Object.keys(currentChange).length > 0) {
    changes.push(currentChange);
  }

  return changes;
}

function getGitHistory(backlogPath) {
  try {
    const absPath = path.isAbsolute(backlogPath) 
      ? backlogPath 
      : path.join(PROJECT_DIR, backlogPath);
    
    const gitLog = execSync(
      `git log --all -p -- "${absPath}"`,
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
    );
    return gitLog;
  } catch (err) {
    return null;
  }
}

function categorizeChange(change) {
  const changeId = change.change_id || "";
  const description = change.description || change.summary || "";
  const targetSkill = change.target_skill || change.target_skills?.[0] || "";
  const changeType = change.change_type || "";
  const changedFiles = change.changed_files || [];

  const hasStructuralKeywords = [
    "restructur", "реструктуризац", "переработк", "извлечён", "модульн",
    "refactor", "rename", "переимен", "удалён", "упрощен", "consolidat"
  ].some(kw => description.toLowerCase().includes(kw.toLowerCase()));

  const hasConfigKeywords = [
    "config", "конфиг", "settings", "настройк", "значение", "value",
    "replace", "замен", "фикс", "исправлен", "update path"
  ].some(kw => description.toLowerCase().includes(kw.toLowerCase()));

  const hasTestKeywords = [
    "test", "тест", "проверк", "assert", "case", "валидац", "верификац"
  ].some(kw => description.toLowerCase().includes(kw.toLowerCase()));

  const hasSkillKeywords = [
    "skill", "скил", "workflow", "воркфлоу", "knowledge", "алгоритм"
  ].some(kw => description.toLowerCase().includes(kw.toLowerCase()));

  const isObsolete = changeId.includes("CHG-001..") || changeId.includes("CHG-010..");
  const isOOS = description.toLowerCase().includes("out-of-scope") || 
                description.toLowerCase().includes("oos-");

  if (isObsolete) {
    return { category: "D", reason: "consolidated change, likely obsolete structure" };
  }

  if (isOOS) {
    return { category: "E", reason: "explicitly marked as out-of-scope" };
  }

  if (hasTestKeywords && hasSkillKeywords) {
    return { category: "A", reason: "adds verifiable rule to skill/workflow (testable)" };
  }

  if (hasStructuralKeywords && !hasTestKeywords) {
    return { category: "B", reason: "one-time structural refactor, no persistent rule" };
  }

  if (hasConfigKeywords && changedFiles.length <= 2) {
    return { category: "C", reason: "config/data fix, single value replacement" };
  }

  return { category: "A", reason: "default: skill modification = durable behavior" };
}

function extractMetadata(change) {
  const changeId = change.change_id || "";
  const targetSkill = change.target_skill || change.target_skills?.[0] || "";
  const changeType = change.change_type || "unknown";
  const description = change.description || change.summary || "";
  const basedOnTickets = change.based_on_tickets || [];
  const changedFiles = Array.isArray(change.changed_files) 
    ? change.changed_files 
    : [change.changed_files].filter(Boolean);
  const coachTicket = change.coach_ticket || "";

  const metadata = {
    change_id: changeId,
    target_skill: targetSkill,
    change_type: changeType,
    description: description.split("\n").slice(0, 3).join(" ").substring(0, 200),
    based_on_tickets: Array.isArray(basedOnTickets) ? basedOnTickets : [basedOnTickets].filter(Boolean),
    changed_files: changedFiles,
    log_ref: coachTicket.includes("log_file") ? coachTicket : null,
  };

  return metadata;
}

function extractPrinciples(changes) {
  const principles = new Set();
  const tags = new Set();

  const principleKeywords = [
    "principle", "принцип", "isolation", "изоляц", "root cause", "корневая",
    "self-correct", "самокоррект", "context budget", "контекст", "universal",
    "универсальн"
  ];

  const tagKeywords = [
    "skill", "workflow", "knowledge", "algorithm", "test", "template",
    "refactor", "fix", "improve", "add", "remove"
  ];

  for (const change of changes) {
    const text = (change.description || change.summary || "").toLowerCase();
    
    for (const kw of principleKeywords) {
      if (text.includes(kw)) {
        principles.add(kw);
      }
    }

    for (const kw of tagKeywords) {
      if (text.includes(kw)) {
        tags.add(kw);
      }
    }
  }

  return {
    principles: Array.from(principles),
    tags: Array.from(tags),
  };
}

function formatTriageTable(triageResults) {
  const header = "| CHG-ID | Категория | Обоснование |";
  const separator = "|--------|-----------|-------------|";
  
  const rows = triageResults.map(r => {
    const cat = CATEGORIES[r.category];
    const name = cat ? cat.name : r.category;
    return `| ${r.changeId} | ${r.category}. ${name} | ${r.reason.substring(0, 50)} |`;
  });

  return [header, separator, ...rows].join("\n");
}

function formatMetadataA(changes) {
  if (changes.length === 0) return "Нет записей категории A";

  const lines = [];
  
  for (const change of changes) {
    const meta = change.metadata;
    lines.push(`\n### ${meta.change_id}`);
    lines.push(`- **target_skill**: ${meta.target_skill}`);
    lines.push(`- **change_type**: ${meta.change_type}`);
    lines.push(`- **description**: ${meta.description}`);
    lines.push(`- **based_on_tickets**: ${meta.based_on_tickets.join(", ")}`);
    lines.push(`- **changed_files**: ${meta.changed_files.join(", ")}`);
    if (meta.log_ref) {
      lines.push(`- **log_ref**: ${meta.log_ref}`);
    }
  }

  return lines.join("\n");
}

function main() {
  const { backlogPath, categoryFilter, dryRun } = parseArgs();

  if (!backlogPath) {
    console.error("Usage:");
    console.error("  node migrate-backlog-to-tests.js --backlog <path>");
    console.error("  node migrate-backlog-to-tests.js --backlog <path> --category A");
    console.error("  node migrate-backlog-to-tests.js --dry-run");
    printResult({
      status: "error",
      error: "Missing required argument: --backlog <path>",
    });
    process.exit(1);
  }

  const resolvedPath = path.isAbsolute(backlogPath)
    ? backlogPath
    : path.join(PROJECT_DIR, backlogPath);

  if (!fs.existsSync(resolvedPath)) {
    printResult({
      status: "error",
      error: `Backlog file not found: ${resolvedPath}`,
    });
    process.exit(1);
  }

  const changes = parseBacklogYaml(resolvedPath);
  
  const gitHistory = getGitHistory(resolvedPath);

  const triageResults = changes.map(change => {
    const { category, reason } = categorizeChange(change);
    return {
      changeId: change.change_id,
      category,
      reason,
      metadata: extractMetadata(change),
    };
  });

  const filteredResults = categoryFilter
    ? triageResults.filter(r => r.category === categoryFilter)
    : triageResults;

  const categoryA = triageResults.filter(r => r.category === "A");
  const principles = extractPrinciples(changes);

  const output = {
    status: "success",
    triage_table: formatTriageTable(filteredResults),
    category_a_metadata: categoryA.length > 0 ? formatMetadataA(categoryA) : "Нет записей категории A",
    unique_principles: principles.principles,
    unique_tags: principles.tags,
    stats: {
      total_changes: changes.length,
      category_a: triageResults.filter(r => r.category === "A").length,
      category_b: triageResults.filter(r => r.category === "B").length,
      category_c: triageResults.filter(r => r.category === "C").length,
      category_d: triageResults.filter(r => r.category === "D").length,
      category_e: triageResults.filter(r => r.category === "E").length,
    },
    git_history_available: gitHistory !== null,
    dry_run: dryRun,
  };

  printResult(output);
}

main();
