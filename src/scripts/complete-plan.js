#!/usr/bin/env node

/**
 * complete-plan.js — Завершает план (status: completed) и архивирует тикеты.
 *
 * Логика:
 *   1. Если plan_id задан в контексте — используем его
 *   2. Если plan_id пуст — ищем единственный активный план в plans/current/
 *   3. Вызываем checkAndClosePlan: проверяет, все ли тикеты в done/archive и нет ли
 *      записанного дефекта без исправления, обновляет status → completed, архивирует
 *      done-тикеты
 *
 * План закрывает только эта стадия — после разбора со статусом completed (configs/pipeline.yaml:
 * analyze-report.completed и check-report-needed.close_plan). pick-next-task план только
 * считает (2026-09-30 PulseProxy PLAN-020: закрыл до отчёта и разбора).
 *
 * Результаты:
 *   - status: completed  — план закрыт; повторный вызов на закрытом плане — тоже completed
 *                          с already_completed: true, без изменений
 *   - status: not_ready  — не все тикеты завершены (тикеты плана в blocked/ — в
 *                          blocked_tickets и строкой WARN с первой строкой blocked_reason
 *                          каждого: сами они не сдвинутся), или готовый тикет плана записал в
 *                          «### Найденные дефекты» дефект, который ничем не исправлен
 *                          (defects: перечень id и строка WARN с первой строкой записи;
 *                          критерий — unfixedDefects в lib/utils.mjs)
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

// Корень проекта ищется в вызываемых функциях, а не при импорте: тест импортирует
// скрипт из каталога без .workflow (чистый checkout CI), и вызов при импорте падал
// «Could not find .workflow/ directory» до выполнения самих проверок (CI 1.25.2/1.25.3).

/**
 * Находит активный план в plans/current/ (status: active).
 * Возвращает planId или null.
 *
 * Экспортируется для теста (src/tests/complete-plan.test.mjs).
 */
export function findActivePlan(projectRoot = null) {
  const PLANS_DIR = path.join(projectRoot ?? findProjectRoot(), '.workflow', 'plans', 'current');
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

/**
 * Достаёт plan_id из аргумента: пайплайн передаёт весь контекст стадии строкой
 * («plan_id: PLAN-009 …»), человек — сам ID или его номер.
 *
 * Экспортируется для теста.
 */
export function parsePlanArg(arg) {
  if (!arg) return null;
  const planMatch = arg.match(/plan_id:\s*(\S+)/i);
  return planMatch ? normalizePlanId(planMatch[1]) : normalizePlanId(arg);
}

// Строка-разделитель таблицы markdown: |---|:--:|
const TABLE_SEPARATOR_RE = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/;

/**
 * Строка записи дефекта для журнала: первая непустая, а у таблицы — первая строка данных.
 * 2026-10-01 ревью: PulseProxy QA-002, QA-007 и QA-010 записали дефекты таблицей, и в
 * журнал шла шапка «| ID | Severity | Описание | Статус |» без самого дефекта.
 *
 * Экспортируется для теста.
 */
export function defectHeadline(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    if (TABLE_SEPARATOR_RE.test(lines[i])) continue;
    if (lines[i].startsWith('|') && TABLE_SEPARATOR_RE.test(lines[i + 1] || '')) continue;
    return lines[i];
  }
  return '';
}

function main() {
  const rawArgs = process.argv.slice(2);
  let planId = rawArgs.length >= 1 ? parsePlanArg(rawArgs[0]) : null;

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

  const WORKFLOW_DIR = path.join(findProjectRoot(), '.workflow');
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
  } else if (result.already) {
    console.log(`[INFO] Plan ${planId} already completed: nothing to change`);
    printResult({
      status: 'completed',
      plan_id: planId,
      total: result.total,
      done: result.done,
      archived: 0,
      already_completed: true
    });
  } else if (result.defects?.length) {
    // Первая строка записи — в журнал: RESULT однострочный, а запись дефекта — список.
    for (const d of result.defects) {
      console.log(`[WARN] ${d.id}: записан дефект без исправления — ${defectHeadline(d.defects)}`);
    }
    console.log(`[WARN] Plan ${planId} not closed: ${result.reason}`);
    printResult({
      status: 'not_ready',
      plan_id: planId,
      reason: result.reason,
      total: result.total,
      done: result.done,
      defects: result.defects.map(d => d.id).join(', ')
    });
  } else {
    const blocked = result.blocked || [];
    for (const t of blocked) {
      console.log(`[WARN] ${t.id}: blocked — ${t.reason || 'причина не записана'}`);
    }
    console.log(`[${blocked.length > 0 ? 'WARN' : 'INFO'}] Plan ${planId} not closed: ${result.reason}`);
    printResult({
      status: 'not_ready',
      plan_id: planId,
      reason: result.reason,
      total: result.total,
      done: result.done,
      ...(blocked.length > 0 ? { blocked_tickets: blocked.map(t => t.id).join(', ') } : {})
    });
  }
}

// Запуск main() только при прямом вызове (не при импорте) — тот же приём, что в
// check-plan-templates.js, check-conditions.js и move-to-review.js.
const isDirectRun = process.argv[1] && (
  process.argv[1].endsWith('complete-plan.js') ||
  process.argv[1].endsWith('complete-plan')
);

if (isDirectRun) {
  main();
}
