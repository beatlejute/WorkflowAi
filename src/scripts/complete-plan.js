#!/usr/bin/env node

/**
 * complete-plan.js — Завершает план (status: completed) и архивирует тикеты.
 *
 * Логика:
 *   1. Если plan_id задан в контексте — используем его
 *   2. Если plan_id пуст — ищем единственный активный план в plans/current/
 *   3. Вызываем checkAndClosePlan: проверяет, все ли тикеты в done/archive,
 *      обновляет status → completed, архивирует done-тикеты
 *
 * Результаты:
 *   - status: completed  — план успешно закрыт
 *   - status: not_ready  — не все тикеты завершены
 *   - status: no_plan    — план не найден
 *   - status: error      — ошибка
 *
 * Использование:
 *   node complete-plan.js "plan_id: PLAN-009"
 *   node complete-plan.js PLAN-009
 *   node complete-plan.js   (найдёт единственный активный план)
 */

import fs from 'fs';
import path from 'path';
import { findProjectRoot } from 'workflow-ai/lib/find-root.mjs';
import { parseFrontmatter, printResult, normalizePlanId, extractPlanId, checkAndClosePlan } from 'workflow-ai/lib/utils.mjs';

const PROJECT_DIR = findProjectRoot();
const WORKFLOW_DIR = path.join(PROJECT_DIR, '.workflow');
const PLANS_DIR = path.join(WORKFLOW_DIR, 'plans', 'current');

/**
 * Находит активный план в plans/current/ (status: active).
 * Возвращает planId или null.
 */
function findActivePlan() {
  if (!fs.existsSync(PLANS_DIR)) return null;

  const files = fs.readdirSync(PLANS_DIR).filter(f => f.endsWith('.md'));

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(PLANS_DIR, file), 'utf8');
      const { frontmatter } = parseFrontmatter(content);
      if (frontmatter.status === 'active') {
        const planId = normalizePlanId(file);
        if (planId) {
          console.log(`[INFO] Found active plan: ${planId} (${file})`);
          return planId;
        }
      }
    } catch (_) { /* skip malformed */ }
  }

  return null;
}

// Main entry point
const rawArgs = process.argv.slice(2);
let planId = null;

if (rawArgs.length >= 1) {
  const arg = rawArgs[0];
  const planMatch = arg.match(/plan_id:\s*(\S+)/i);
  planId = planMatch ? normalizePlanId(planMatch[1]) : normalizePlanId(arg);
}

if (!planId) {
  planId = extractPlanId();
}

if (!planId) {
  console.log('[INFO] No plan_id in context, searching for active plan...');
  planId = findActivePlan();
}

if (!planId) {
  console.log('[INFO] No active plan found');
  printResult({ status: 'no_plan' });
  process.exit(0);
}

console.log(`[INFO] Completing plan: ${planId}`);

const result = checkAndClosePlan(WORKFLOW_DIR, planId);

if (result.closed) {
  console.log(`[INFO] Plan ${planId} completed: ${result.done}/${result.total} tickets done, ${result.archived?.length || 0} archived`);
  printResult({
    status: 'completed',
    plan_id: planId,
    total: result.total,
    done: result.done,
    archived: result.archived?.length || 0
  });
} else {
  console.log(`[INFO] Plan ${planId} not closed: ${result.reason}`);
  printResult({
    status: 'not_ready',
    plan_id: planId,
    reason: result.reason,
    total: result.total,
    done: result.done
  });
}
