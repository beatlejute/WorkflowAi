#!/usr/bin/env node

/**
 * check-plan-templates.js — Проверяет шаблоны планов и создаёт планы по триггерам.
 *
 * Логика:
 *   1. Читает все .md из plans/templates/
 *   2. Для каждого с enabled: true — проверяет триггер
 *   3. Если триггер сработал — создаёт план в plans/current/ со статусом approved
 *   4. Обновляет last_triggered в шаблоне
 *
 * Типы триггеров:
 *   - daily          — раз в день
 *   - weekly         — в указанные дни недели (params.days_of_week: [0-6])
 *   - date_after     — однократно после указанной даты (params.date)
 *   - interval_days  — каждые N дней (params.days)
 *
 * Результат:
 *   - plan_created + plan_ids — созданы планы
 *   - no_triggers — ни один триггер не сработал
 *   - error — ошибка
 *
 * Использование:
 *   node check-plan-templates.js
 */

import fs from 'fs';
import path from 'path';
import { findProjectRoot } from 'workflow-ai/lib/find-root.mjs';
import { parseFrontmatter, serializeFrontmatter, printResult } from 'workflow-ai/lib/utils.mjs';

const PROJECT_DIR = findProjectRoot();
const WORKFLOW_DIR = path.join(PROJECT_DIR, '.workflow');
const TEMPLATES_DIR = path.join(WORKFLOW_DIR, 'plans', 'templates');
const PLANS_DIR = path.join(WORKFLOW_DIR, 'plans', 'current');
const TICKETS_DIR = path.join(WORKFLOW_DIR, 'tickets');
const DONE_DIR = 'done';

/**
 * Проверяет, сработал ли триггер шаблона.
 *
 * @param {{ type: string, params?: object }} trigger — конфигурация триггера
 * @param {string} lastTriggered — ISO-дата последнего срабатывания (или пустая строка)
 * @param {Date} [now] — текущая дата (для тестов)
 * @returns {boolean}
 */
export function evaluateTrigger(trigger, lastTriggered, now = new Date()) {
  if (!trigger || !trigger.type) return false;

  const todayStr = now.toISOString().slice(0, 10);
  const lastDate = lastTriggered ? String(lastTriggered).slice(0, 10) : null;

  switch (trigger.type) {
    case 'daily':
      return lastDate !== todayStr;

    case 'weekly': {
      const dayOfWeek = now.getDay();
      const targetDays = trigger.params?.days_of_week || [1];
      if (!targetDays.includes(dayOfWeek)) return false;
      return lastDate !== todayStr;
    }

    case 'date_after': {
      const targetDate = trigger.params?.date;
      if (!targetDate) return false;
      if (todayStr < targetDate) return false;
      return !lastDate || lastDate < targetDate;
    }

    case 'interval_days': {
      const intervalDays = trigger.params?.days || 1;
      if (!lastDate) return true;
      const lastTime = new Date(lastDate).getTime();
      const elapsed = (now.getTime() - lastTime) / (1000 * 60 * 60 * 24);
      return elapsed >= intervalDays;
    }

    default:
      console.error(`[WARN] Unknown trigger type: ${trigger.type}`);
      return false;
  }
}

/**
 * Генерирует следующий ID плана (PLAN-NNN), сканируя plans/current/.
 *
 * @param {string} plansDir — путь к директории plans/current/
 * @returns {string}
 */
export function generateNextPlanId(plansDir) {
  const archiveDir = path.join(path.dirname(plansDir), 'archive');
  let maxNum = 0;

  for (const dir of [plansDir, archiveDir]) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      const match = file.match(/^PLAN-(\d+)\.md$/i);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > maxNum) maxNum = num;
      }
    }
  }

  return `PLAN-${String(maxNum + 1).padStart(3, '0')}`;
}

/**
 * Создаёт план из шаблона.
 *
 * @param {string} templatePath — полный путь к файлу шаблона
 * @param {object} templateFm — frontmatter шаблона
 * @param {string} templateBody — тело шаблона
 * @param {string} planId — ID нового плана
 * @param {string} todayStr — сегодняшняя дата ISO
 * @returns {string} путь к созданному плану
 */
function createPlanFromTemplate(templatePath, templateFm, templateBody, planId, todayStr) {
  const planFm = {
    id: planId,
    title: `${templateFm.title} (${todayStr})`,
    status: 'approved',
    source_template: templateFm.id,
    author: templateFm.author || 'system',
    created_at: todayStr,
    updated_at: todayStr,
    completed_at: '',
    previous_plan: '',
    related_reports: []
  };

  const planContent = serializeFrontmatter(planFm) + '\n' + templateBody;
  const planFileName = `${planId}.md`;
  const planPath = path.join(PLANS_DIR, planFileName);

  if (!fs.existsSync(PLANS_DIR)) {
    fs.mkdirSync(PLANS_DIR, { recursive: true });
  }

  fs.writeFileSync(planPath, planContent, 'utf8');
  console.log(`[INFO] Created plan ${planId} from template ${templateFm.id}`);

  return planPath;
}

/**
 * Обновляет last_triggered в шаблоне.
 *
 * @param {string} templatePath — полный путь к файлу шаблона
 * @param {object} frontmatter — frontmatter шаблона
 * @param {string} body — тело шаблона
 * @param {string} todayStr — сегодняшняя дата ISO
 */
function updateTemplateLastTriggered(templatePath, frontmatter, body, todayStr) {
  frontmatter.last_triggered = todayStr;
  const content = serializeFrontmatter(frontmatter) + '\n' + body;
  fs.writeFileSync(templatePath, content, 'utf8');
  console.log(`[INFO] Updated last_triggered for ${frontmatter.id} to ${todayStr}`);
}

/**
 * Проверяет, есть ли незавершённые тикеты по планам, созданным из данного шаблона.
 * Тикет считается незавершённым, если он находится не в done/.
 *
 * @param {string} templateId — ID шаблона (например, "TMPL-001")
 * @returns {boolean} true если есть активные тикеты
 */
export function hasActiveTicketsForTemplate(templateId) {
  // 1. Найти все планы с source_template === templateId
  const planPaths = [];
  if (fs.existsSync(PLANS_DIR)) {
    for (const file of fs.readdirSync(PLANS_DIR).filter(f => f.endsWith('.md'))) {
      const content = fs.readFileSync(path.join(PLANS_DIR, file), 'utf8');
      const { frontmatter } = parseFrontmatter(content);
      if (frontmatter.source_template === templateId) {
        planPaths.push(`plans/current/${file}`);
      }
    }
  }

  if (planPaths.length === 0) return false;

  // 2. Проверить тикеты во всех папках кроме done/
  if (!fs.existsSync(TICKETS_DIR)) return false;

  const ticketDirs = fs.readdirSync(TICKETS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name !== DONE_DIR)
    .map(d => d.name);

  for (const dir of ticketDirs) {
    const dirPath = path.join(TICKETS_DIR, dir);
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.md'));

    for (const file of files) {
      const content = fs.readFileSync(path.join(dirPath, file), 'utf8');
      const { frontmatter } = parseFrontmatter(content);
      if (frontmatter.parent_plan && planPaths.includes(frontmatter.parent_plan)) {
        return true;
      }
    }
  }

  return false;
}

async function main() {
  if (!fs.existsSync(TEMPLATES_DIR)) {
    console.log('[INFO] Templates directory does not exist, nothing to check');
    printResult({ status: 'no_triggers' });
    return;
  }

  const templateFiles = fs.readdirSync(TEMPLATES_DIR)
    .filter(f => f.endsWith('.md'));

  if (templateFiles.length === 0) {
    console.log('[INFO] No template files found');
    printResult({ status: 'no_triggers' });
    return;
  }

  console.log(`[INFO] Found ${templateFiles.length} template(s) in plans/templates/`);

  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const createdPlanIds = [];

  for (const file of templateFiles) {
    const templatePath = path.join(TEMPLATES_DIR, file);

    try {
      const content = fs.readFileSync(templatePath, 'utf8');
      const { frontmatter, body } = parseFrontmatter(content);

      if (frontmatter.type !== 'template') {
        console.log(`[INFO] Skipping ${file} — type is not "template"`);
        continue;
      }

      if (!frontmatter.enabled) {
        console.log(`[INFO] Skipping ${file} — disabled`);
        continue;
      }

      if (!frontmatter.trigger) {
        console.log(`[WARN] Skipping ${file} — no trigger defined`);
        continue;
      }

      const shouldTrigger = evaluateTrigger(frontmatter.trigger, frontmatter.last_triggered, now);

      if (!shouldTrigger) {
        console.log(`[INFO] Template ${frontmatter.id}: trigger not fired`);
        continue;
      }

      console.log(`[INFO] Template ${frontmatter.id}: trigger fired!`);

      if (hasActiveTicketsForTemplate(frontmatter.id)) {
        console.log(`[INFO] Template ${frontmatter.id}: skipped — active tickets exist from previous plan`);
        continue;
      }

      const planId = generateNextPlanId(PLANS_DIR);
      createPlanFromTemplate(templatePath, frontmatter, body, planId, todayStr);
      updateTemplateLastTriggered(templatePath, frontmatter, body, todayStr);
      createdPlanIds.push(planId);

    } catch (e) {
      console.error(`[WARN] Failed to process template ${file}: ${e.message}`);
    }
  }

  if (createdPlanIds.length > 0) {
    console.log(`[INFO] Created ${createdPlanIds.length} plan(s): ${createdPlanIds.join(', ')}`);
    printResult({ status: 'plan_created', plan_ids: createdPlanIds.join(', ') });
  } else {
    console.log('[INFO] No triggers fired');
    printResult({ status: 'no_triggers' });
  }
}

// Запуск main() только при прямом вызове (не при импорте)
const isDirectRun = process.argv[1] && (
  process.argv[1].endsWith('check-plan-templates.js') ||
  process.argv[1].endsWith('check-plan-templates')
);

if (isDirectRun) {
  main().catch(e => {
    console.error(`[ERROR] ${e.message}`);
    printResult({ status: 'error', error: e.message });
    process.exit(1);
  });
}
