#!/usr/bin/env node

/**
 * check-plan-decomposed.js — Проверяет состояние декомпозиции планов.
 *
 * Логика:
 *   A) Если plan_id задан — проверяет только этот план
 *   B) Если plan_id НЕ задан — сканирует все планы в plans/current/
 *
 *   Для каждого плана в режиме B учитывается его status:
 *   - draft / completed / archived → skip
 *   - approved + нет тикетов → needs_decomposition (→ decompose-plan)
 *   - approved + есть тикеты   → awaiting_atomicity (→ verify-atomicity):
 *                                тикеты созданы, но атомарность не подтверждена
 *                                (status плана ещё не активирован).
 *   - active + есть тикеты    → decomposed (→ check-conditions)
 *   - active + нет тикетов    → аномалия, logs warn, skip
 *
 *   Результат:
 *   - needs_decomposition + plan_file — найден approved-план без тикетов
 *   - awaiting_atomicity + plan_file  — найден approved-план с тикетами (ждёт verify-atomicity)
 *   - decomposed                      — все активные планы имеют тикеты, штатный поток
 *   - no_plan                         — нет планов в plans/current/
 *
 * Использование:
 *   node check-plan-decomposed.js "plan_id: PLAN-007"
 *   node check-plan-decomposed.js
 */

import fs from 'fs';
import path from 'path';
import { findProjectRoot } from 'workflow-ai/lib/find-root.mjs';
import { parseFrontmatter, printResult, normalizePlanId, extractPlanId } from 'workflow-ai/lib/utils.mjs';

const PROJECT_DIR = findProjectRoot();
const WORKFLOW_DIR = path.join(PROJECT_DIR, '.workflow');
const TICKETS_DIR = path.join(WORKFLOW_DIR, 'tickets');
const PLANS_DIR = path.join(WORKFLOW_DIR, 'plans', 'current');

const TICKET_DIRS = ['backlog', 'ready', 'in-progress', 'review', 'done', 'blocked'];

/**
 * Читает статус плана из frontmatter.
 * Возвращает актуальный статус (draft / approved / active / completed / archived)
 * или null при ошибке. Pipeline различает approved (ожидает декомпозиции или
 * атомарности) и active (прошёл атомарность, в работе).
 */
export function getPlanStatus(planFile) {
  const fullPath = path.join(WORKFLOW_DIR, planFile);
  if (!fs.existsSync(fullPath)) return null;
  try {
    const content = fs.readFileSync(fullPath, 'utf8');
    const { frontmatter } = parseFrontmatter(content);
    return frontmatter.status || null;
  } catch (e) {
    console.error(`[WARN] Failed to read plan status from ${planFile}: ${e.message}`);
    return null;
  }
}

/**
 * Проверяет, есть ли тикеты, привязанные к данному плану
 */
export function hasTicketsForPlan(planId) {
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
export function findPlanFile(planId) {
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
export function getAllPlanFiles() {
  if (!fs.existsSync(PLANS_DIR)) return [];

  return fs.readdirSync(PLANS_DIR)
    .filter(f => f.endsWith('.md'))
    .map(f => ({
      planId: normalizePlanId(f),
      planFile: `plans/current/${f}`
    }))
    .filter(p => p.planId !== null);
}

/**
 * Решение по одному плану (режим A). Возвращает объект результата стадии, ничего не
 * печатая в блок результата — так решение можно проверить тестом.
 *
 * Исходы: no_plan (файла плана нет), decomposed (план активен и тикеты есть),
 * awaiting_atomicity (тикеты есть, но план ещё approved — атомарность не подтверждена),
 * needs_decomposition (тикетов нет).
 */
export function decidePlan(planId) {
  const planFile = findPlanFile(planId);
  if (!planFile) {
    console.log(`[INFO] Plan ${planId} not found in plans/current/`);
    return { status: 'no_plan' };
  }

  console.log(`[INFO] Found plan file: ${planFile}`);

  const planStatus = getPlanStatus(planFile);
  const hasTickets = hasTicketsForPlan(planId);

  if (hasTickets && planStatus === 'active') {
    console.log(`[INFO] Plan ${planId} is active and has tickets — decomposed`);
    return { status: 'decomposed' };
  }

  if (hasTickets && planStatus === 'approved') {
    console.log(`[INFO] Plan ${planId} is approved and has tickets — awaiting atomicity verification`);
    return { status: 'awaiting_atomicity', plan_file: planFile };
  }

  if (!hasTickets) {
    console.log(`[INFO] Plan ${planId} has no tickets — needs decomposition`);
    return { status: 'needs_decomposition', plan_file: planFile };
  }

  console.log(`[INFO] Plan ${planId} has tickets but status="${planStatus}" — treating as decomposed`);
  return { status: 'decomposed' };
}

/**
 * Решение по всем планам в plans/current/ (режим B): первый план, которому нужна работа,
 * и определяет маршрут стадии. План в статусе draft, completed или archived пропускается;
 * active без тикетов — аномалия, тоже пропуск (иначе стадия зациклилась бы на плане, для
 * которого декомпозиция уже прошла, а тикеты закрыты и заархивированы).
 */
export function decideAllPlans() {
  const allPlans = getAllPlanFiles();
  if (allPlans.length === 0) {
    console.log('[INFO] No plans found in plans/current/');
    return { status: 'no_plan' };
  }

  console.log(`[INFO] Found ${allPlans.length} plan(s) in plans/current/`);

  for (const { planId: pid, planFile } of allPlans) {
    const planStatus = getPlanStatus(planFile);

    if (planStatus !== 'approved' && planStatus !== 'active') {
      console.log(`[INFO] Plan ${pid} has status "${planStatus}" — skipping`);
      continue;
    }

    const hasTickets = hasTicketsForPlan(pid);

    if (planStatus === 'approved' && !hasTickets) {
      console.log(`[INFO] Plan ${pid} is approved with no tickets — needs decomposition`);
      return { status: 'needs_decomposition', plan_file: planFile };
    }

    if (planStatus === 'approved' && hasTickets) {
      console.log(`[INFO] Plan ${pid} is approved and has tickets — awaiting atomicity verification`);
      return { status: 'awaiting_atomicity', plan_file: planFile };
    }

    if (planStatus === 'active' && !hasTickets) {
      console.log(`[WARN] Plan ${pid} is active but has no tickets — anomaly, skipping`);
      continue;
    }

    console.log(`[INFO] Plan ${pid} is active and has tickets — decomposed`);
  }

  console.log('[INFO] All eligible plans are decomposed');
  return { status: 'decomposed' };
}

async function main() {
  const planId = extractPlanId();

  if (planId) {
    console.log(`[INFO] Checking decomposition for plan: ${planId}`);
    printResult(decidePlan(planId));
    return;
  }

  console.log('[INFO] No plan_id specified, scanning all plans in plans/current/');
  printResult(decideAllPlans());
}

// Запуск main() только при прямом вызове (не при импорте) — тот же приём, что в
// check-plan-templates.js, check-conditions.js и move-to-review.js.
const isDirectRun = process.argv[1] && (
  process.argv[1].endsWith('check-plan-decomposed.js') ||
  process.argv[1].endsWith('check-plan-decomposed')
);

if (isDirectRun) {
  main().catch(e => {
    console.error(`[ERROR] ${e.message}`);
    printResult({ status: 'error', error: e.message });
    process.exit(1);
  });
}
