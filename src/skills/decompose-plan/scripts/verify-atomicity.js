#!/usr/bin/env node

/**
 * verify-atomicity.js — механическая проверка атомарности тикетов в backlog/.
 *
 * Проверяет тикеты на соответствие критериям атомарности:
 * - Title: количество глаголов-инфинитивов (>1 → WARNING)
 * - DoD: количество пунктов (>7 → FAIL, >5 → WARNING)
 * - Шаги: количество шагов в "Детали задачи" (>5 → FAIL, отсутствует → SKIP)
 * - Файлы: количество файлов в context.files (>3 → WARNING, отсутствует → SKIP)
 *
 * Использование:
 *   node verify-atomicity.js "<prompt>"
 *   Парсит ticket_id из Context-блока в промпте, извлекает plan_file.
 *
 * Вывод:
 *   ---RESULT---
 *   status: passed|failed
 *   tickets_checked: N
 *   tickets_failed: N
 *   failures: [...]
 *   warnings: [...]
 *   ---RESULT---
 */

import fs from 'fs';
import path from 'path';
import { findProjectRoot } from 'workflow-ai/lib/find-root.mjs';
import { parseFrontmatter } from 'workflow-ai/lib/utils.mjs';

const DOD_THRESHOLD_FAIL = 7;
const DOD_THRESHOLD_WARN = 5;
const STEPS_THRESHOLD_FAIL = 5;
const FILES_THRESHOLD_WARN = 3;
const TITLE_VERBS_FAIL_THRESHOLD = 1;

const INFINITIVE_VERBS = [
  'исправить',
  'реализовать',
  'добавить',
  'обновить',
  'удалить',
  'создать',
  'проверить',
  'перенести',
  'написать',
  'настроить',
  'изменить'
];

const VERBS_PATTERN = new RegExp(
  `\\b(${INFINITIVE_VERBS.join('|')})\\b`,
  'gi'
);

function extractPlanFileFromPrompt(prompt) {
  const planFileMatch = prompt.match(/plan_file:\s*([^\s\n]+)/i);
  if (planFileMatch) {
    return planFileMatch[1];
  }

  const planMatch = prompt.match(/parent_plan:\s*([^\s\n]+)/i);
  if (planMatch) {
    return planMatch[1];
  }

  return null;
}

function getPlanIdFromPath(planFilePath) {
  if (!planFilePath) return null;

  const filename = path.basename(planFilePath, '.md');
  const match = filename.match(/^PLAN-\d+$/i);
  if (match) {
    return match[0].toUpperCase();
  }

  return filename;
}

function getTicketsForPlan(backlogDir, planId) {
  if (!fs.existsSync(backlogDir)) {
    return [];
  }

  const files = fs.readdirSync(backlogDir).filter(f => f.endsWith('.md'));
  const tickets = [];

  for (const file of files) {
    const filePath = path.join(backlogDir, file);
    const content = fs.readFileSync(filePath, 'utf8');
    const { frontmatter } = parseFrontmatter(content);

    if (frontmatter.parent_plan) {
      const parentPlanId = getPlanIdFromPath(frontmatter.parent_plan);
      if (parentPlanId && parentPlanId.toUpperCase() === planId.toUpperCase()) {
        tickets.push({ id: frontmatter.id, path: filePath, content });
      }
    }
  }

  return tickets;
}

function extractSection(body, sectionName) {
  // Match heading that starts with sectionName, allowing optional suffix like "(Definition of Done)"
  const sectionRegex = new RegExp(`^##\\s*${sectionName}(?:\\s|\\s*\\(|$)`, 'm');
  const match = sectionRegex.exec(body);

  if (!match) return null;

  const startIdx = match.index + match[0].length;
  const nextH2 = body.indexOf('\n## ', startIdx);
  const sectionEnd = nextH2 === -1 ? body.length : nextH2;

  return body.substring(startIdx, sectionEnd).trim();
}

function extractDetailsTasks(body) {
  const detailsSection = extractSection(body, 'Детали задачи');
  if (!detailsSection) return [];

  const stepRegex = /###\s*(\d+)\.\s*/g;
  const steps = [];
  let match;

  while ((match = stepRegex.exec(detailsSection)) !== null) {
    steps.push(parseInt(match[1], 10));
  }

  return steps;
}

function countTitleVerbs(title) {
  const matches = title.match(VERBS_PATTERN);
  if (!matches) return { count: 0, uniqueVerbs: [] };

  const uniqueVerbs = [...new Set(matches.map(v => v.toLowerCase()))];
  return { count: matches.length, uniqueVerbs };
}

function countDoDItems(body) {
  const dodSection = extractSection(body, 'Критерии готовности');
  if (!dodSection) return 0;

  const itemsRegex = /-\s*\[\s*\]\s*/g;
  const matches = dodSection.match(itemsRegex);
  return matches ? matches.length : 0;
}

function countContextFiles(frontmatter) {
  if (!frontmatter.context || !frontmatter.context.files) {
    return 0;
  }

  if (Array.isArray(frontmatter.context.files)) {
    return frontmatter.context.files.length;
  }

  return 0;
}

function checkTicket(ticket) {
  const { id, path: ticketPath, content } = ticket;
  const { frontmatter, body } = parseFrontmatter(content);

  const checks = [];
  const title = frontmatter.title || '';

  const verbsResult = countTitleVerbs(title);
  if (verbsResult.uniqueVerbs.length > TITLE_VERBS_FAIL_THRESHOLD) {
    checks.push({
      check: 'title_verbs',
      result: 'WARNING',
      detail: `Title содержит ${verbsResult.uniqueVerbs.length} глаголов: ${verbsResult.uniqueVerbs.join(', ')}`
    });
  }

  const dodCount = countDoDItems(body);
  if (dodCount > DOD_THRESHOLD_FAIL) {
    checks.push({
      check: 'dod_items',
      result: 'FAIL',
      detail: `DoD содержит ${dodCount} пунктов (порог: ${DOD_THRESHOLD_FAIL})`
    });
  } else if (dodCount > DOD_THRESHOLD_WARN) {
    checks.push({
      check: 'dod_items',
      result: 'WARNING',
      detail: `DoD содержит ${dodCount} пунктов (порог: ${DOD_THRESHOLD_WARN})`
    });
  }

  const steps = extractDetailsTasks(body);
  if (steps.length > STEPS_THRESHOLD_FAIL) {
    checks.push({
      check: 'details_steps',
      result: 'FAIL',
      detail: `Детали задачи содержат ${steps.length} шагов (порог: ${STEPS_THRESHOLD_FAIL})`
    });
  } else if (steps.length === 0) {
    const hasDetailsSection = body.includes('## Детали задачи');
    if (!hasDetailsSection) {
      checks.push({
        check: 'details_steps',
        result: 'SKIP',
        detail: 'Секция "Детали задачи" отсутствует'
      });
    }
  }

  const filesCount = countContextFiles(frontmatter);
  if (filesCount > FILES_THRESHOLD_WARN) {
    checks.push({
      check: 'context_files',
      result: 'WARNING',
      detail: `context.files: ${filesCount} (порог: ${FILES_THRESHOLD_WARN})`
    });
  } else if (filesCount === 0) {
    const hasContextFiles = frontmatter.context && frontmatter.context.files;
    if (!hasContextFiles) {
      checks.push({
        check: 'context_files',
        result: 'SKIP',
        detail: 'context.files отсутствует или пуст'
      });
    }
  }

  return {
    id,
    checks,
    hasFailures: checks.some(c => c.result === 'FAIL'),
    hasWarnings: checks.some(c => c.result === 'WARNING')
  };
}

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage: node verify-atomicity.js "<prompt>"');
    process.exit(1);
  }

  const prompt = args.join(' ');
  const planFile = extractPlanFileFromPrompt(prompt);

  if (!planFile) {
    console.error('Error: could not extract plan_file from prompt');
    console.log('---RESULT---');
    console.log('status: failed');
    console.log('reason: plan_file_not_found_in_prompt');
    console.log('---RESULT---');
    process.exit(1);
  }

  const planId = getPlanIdFromPath(planFile);
  if (!planId) {
    console.error('Error: could not extract plan ID from plan_file');
    console.log('---RESULT---');
    console.log('status: failed');
    console.log('reason: plan_id_not_resolved');
    console.log('---RESULT---');
    process.exit(1);
  }

  const PROJECT_DIR = findProjectRoot();
  const backlogDir = path.join(PROJECT_DIR, '.workflow', 'tickets', 'backlog');

  const tickets = getTicketsForPlan(backlogDir, planId);

  if (tickets.length === 0) {
    console.log('---RESULT---');
    console.log('status: passed');
    console.log('tickets_checked: 0');
    console.log('tickets_failed: 0');
    console.log('reason: no_tickets_found_for_plan');
    console.log('---RESULT---');
    process.exit(0);
  }

  const results = tickets.map(checkTicket);

  const failures = [];
  const warnings = [];
  let ticketsFailed = 0;

  for (const result of results) {
    if (result.hasFailures) {
      ticketsFailed++;
      failures.push({
        ticket: result.id,
        checks: result.checks.filter(c => c.result === 'FAIL' || c.result === 'WARNING')
      });
    }

    const warningChecks = result.checks.filter(c => c.result === 'WARNING');
    for (const check of warningChecks) {
      warnings.push({
        ticket: result.id,
        check: check.check,
        detail: check.detail
      });
    }
  }

  const status = ticketsFailed > 0 ? 'failed' : 'passed';

  console.log('---RESULT---');
  console.log(`status: ${status}`);
  console.log(`tickets_checked: ${results.length}`);
  console.log(`tickets_failed: ${ticketsFailed}`);

  if (failures.length > 0) {
    console.log('atomicity_failures:');
    for (const failure of failures) {
      console.log(`  - ticket: "${failure.ticket}"`);
      console.log('    checks:');
      for (const check of failure.checks) {
        console.log(`      - check: "${check.check}"`);
        console.log(`        result: "${check.result}"`);
        console.log(`        detail: "${check.detail}"`);
      }
    }
  }

  if (warnings.length > 0) {
    console.log('warnings:');
    for (const warning of warnings) {
      console.log(`  - ticket: "${warning.ticket}"`);
      console.log(`    check: "${warning.check}"`);
      console.log(`    detail: "${warning.detail}"`);
    }
  }

  console.log('---RESULT---');
}

main();