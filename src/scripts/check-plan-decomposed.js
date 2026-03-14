#!/usr/bin/env node

/**
 * check-plan-decomposed.js — Проверяет, есть ли недекомпозированные планы.
 *
 * Логика:
 *   A) Если plan_id задан — проверяет только этот план
 *   B) Если plan_id НЕ задан — сканирует все планы в plans/current/
 *
 *   Для каждого плана:
 *   1. Если есть тикеты (backlog/, ready/, in-progress/, review/) с parent_plan == planId — decomposed
 *   2. Иначе — needs_decomposition
 *
 *   Результат:
 *   - needs_decomposition + plan_file — найден первый недекомпозированный план
 *   - decomposed — все планы декомпозированы
 *   - no_plan — нет планов в plans/current/
 *
 * Использование:
 *   node check-plan-decomposed.js "plan_id: PLAN-007"
 *   node check-plan-decomposed.js
 */

import fs from 'fs';
import path from 'path';
import { findProjectRoot } from '../lib/find-root.mjs';
import { parseFrontmatter, printResult, normalizePlanId, extractPlanId } from '../lib/utils.mjs';

const PROJECT_DIR = findProjectRoot();
const WORKFLOW_DIR = path.join(PROJECT_DIR, '.workflow');
const TICKETS_DIR = path.join(WORKFLOW_DIR, 'tickets');
const PLANS_DIR = path.join(WORKFLOW_DIR, 'plans', 'current');

const TICKET_DIRS = ['backlog', 'ready', 'in-progress', 'review'];

/**
 * Проверяет, есть ли тикеты, привязанные к данному плану
 */
function hasTicketsForPlan(planId) {
  for (const dir of TICKET_DIRS) {
    const dirPath = path.join(TICKETS_DIR, dir);
    if (!fs.existsSync(dirPath)) continue;

    const files = fs.readdirSync(dirPath)
      .filter(f => f.endsWith('.md') && f !== '.gitkeep.md');

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(dirPath, file), 'utf8');
        const { frontmatter } = parseFrontmatter(content);
        if (normalizePlanId(frontmatter.parent_plan) === planId) {
          return true;
        }
      } catch (e) {
        console.error(`[WARN] Failed to read ${dir}/${file}: ${e.message}`);
      }
    }
  }
  return false;
}

/**
 * Находит файл плана в plans/current/
 */
function findPlanFile(planId) {
  if (!fs.existsSync(PLANS_DIR)) return null;

  const expectedName = `${planId}.md`;
  const filePath = path.join(PLANS_DIR, expectedName);
  if (fs.existsSync(filePath)) {
    return `plans/current/${expectedName}`;
  }

  // Поиск по всем файлам на случай другого именования
  const files = fs.readdirSync(PLANS_DIR).filter(f => f.endsWith('.md'));
  for (const file of files) {
    if (normalizePlanId(file) === planId) {
      return `plans/current/${file}`;
    }
  }

  return null;
}

/**
 * Возвращает все файлы планов из plans/current/
 */
function getAllPlanFiles() {
  if (!fs.existsSync(PLANS_DIR)) return [];

  return fs.readdirSync(PLANS_DIR)
    .filter(f => f.endsWith('.md'))
    .map(f => ({
      planId: normalizePlanId(f),
      planFile: `plans/current/${f}`
    }))
    .filter(p => p.planId !== null);
}

async function main() {
  const planId = extractPlanId();

  if (planId) {
    // Режим A: конкретный план
    console.log(`[INFO] Checking decomposition for plan: ${planId}`);

    const planFile = findPlanFile(planId);
    if (!planFile) {
      console.log(`[INFO] Plan ${planId} not found in plans/current/`);
      printResult({ status: 'no_plan' });
      return;
    }

    console.log(`[INFO] Found plan file: ${planFile}`);

    if (hasTicketsForPlan(planId)) {
      console.log(`[INFO] Plan ${planId} already has tickets — decomposed`);
      printResult({ status: 'decomposed' });
      return;
    }

    console.log(`[INFO] Plan ${planId} has no tickets — needs decomposition`);
    printResult({ status: 'needs_decomposition', plan_file: planFile });
    return;
  }

  // Режим B: сканируем все планы в plans/current/
  console.log('[INFO] No plan_id specified, scanning all plans in plans/current/');

  const allPlans = getAllPlanFiles();
  if (allPlans.length === 0) {
    console.log('[INFO] No plans found in plans/current/');
    printResult({ status: 'no_plan' });
    return;
  }

  console.log(`[INFO] Found ${allPlans.length} plan(s) in plans/current/`);

  for (const { planId: pid, planFile } of allPlans) {
    if (!hasTicketsForPlan(pid)) {
      console.log(`[INFO] Plan ${pid} has no tickets — needs decomposition`);
      printResult({ status: 'needs_decomposition', plan_file: planFile });
      return;
    }
    console.log(`[INFO] Plan ${pid} already decomposed`);
  }

  console.log('[INFO] All plans are decomposed');
  printResult({ status: 'decomposed' });
}

main().catch(e => {
  console.error(`[ERROR] ${e.message}`);
  printResult({ status: 'error', error: e.message });
  process.exit(1);
});
