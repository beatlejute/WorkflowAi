#!/usr/bin/env node

/**
 * validate-completeness.js — валидация полноты плана по чеклисту из plan-completeness.md
 *
 * Использование:
 *   node validate-completeness.js <path-to-plan>
 *
 * Проверяет:
 * - Обязательные поля frontmatter (id, title, status, author, created_at)
 * - Обязательные секции (# Цель, ## Контекст, ## Справочные данные, ## Scope, ## Высокоуровневые задачи, ## Риски, ## Критерии успеха)
 * - Строку **Проверка:** у каждой задачи «Высокоуровневых задач» и формат её записей
 * - Красные флаги (отсылки вместо содержания, пустые секции)
 *
 * Вывод: JSON {errors, warnings, valid} через ---RESULT---
 */

import fs from 'fs';
import path from 'path';
import { findProjectRoot } from 'workflow-ai/lib/find-root.mjs';
import { printResult } from 'workflow-ai/lib/utils.mjs';
import { parseCheckRecord } from 'workflow-ai/lib/check-runner.mjs';

const REQUIRED_FRONTMATTER_FIELDS = ['id', 'title', 'status', 'author', 'created_at'];

const REQUIRED_SECTIONS = [
  '# Цель',
  '## Контекст',
  '## Справочные данные',
  '## Scope',
  '## Высокоуровневые задачи',
  '## Риски',
  '## Критерии успеха'
];

const RED_FLAG_PATTERNS = [
  { pattern: /см\.\s*ТЗ|по ссылке|см\.\s*документацию|описано в спецификации/gi, message: 'Отсылка к внешнему документу вместо содержания' },
  { pattern: /URL[а-яё]*\s*(уже создан|создан|получен)|credentials\s*(настроены|получены|готовы)/gi, message: 'Значение не указано (только упоминание)' },
  { message: 'Пустая секция (только заголовок без содержания)', isEmptySection: true }
];

/**
 * Заголовки секций без содержания.
 *
 * Секция пуста, если до следующего заголовка того же или старшего уровня в ней нет
 * ни одной содержательной строки. Подзаголовок — содержание: «Справочные данные»
 * состоит из подсекций. Подсказка шаблона `<!-- … -->` содержанием не считается —
 * секция с одной подсказкой не заполнена. Frontmatter и блоки кода пропускаются:
 * `# …` в них — комментарий (в шаблоне плана — `# Шаблон плана` во frontmatter), а
 * не заголовок.
 *
 * Прежняя проверка смотрела только на строку сразу после заголовка и считала пустой
 * любую секцию с пустой строкой после заголовка, то есть обычный markdown: на
 * PLAN-002 — 59 предупреждений, по одному на каждый заголовок (2026-09-25).
 */
function findEmptySections(content) {
  const body = content
    .replace(/\r\n/g, '\n')
    .replace(/^---\n[\s\S]*?\n---(\n|$)/, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const items = [];
  let inFence = false;
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      items.push({ heading: false });
      continue;
    }
    const heading = inFence ? null : line.match(/^(#{1,6})\s+\S/);
    if (heading) items.push({ heading: true, level: heading[1].length, text: line.trim() });
    else if (line.trim()) items.push({ heading: false });
  }
  return items
    .filter((item, i) => {
      if (!item.heading) return false;
      const next = items[i + 1];
      return !next || (next.heading && next.level <= item.level);
    })
    .map((item) => item.text);
}

function parseArgs() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Ошибка: не указан путь к файлу плана');
    console.error('Использование: node validate-completeness.js <path-to-plan>');
    process.exit(1);
  }
  return args[0];
}

function parseFrontmatter(content) {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) {
    return { raw: null, data: null };
  }

  const fmContent = fmMatch[1];
  const data = {};

  const lines = fmContent.split('\n');
  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();

    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }

    data[key] = value;
  }

  return { raw: fmMatch[0], data };
}

function checkFrontmatter(fm) {
  const errors = [];

  if (!fm || !fm.data) {
    errors.push({ field: 'frontmatter', message: 'Frontmatter отсутствует' });
    return errors;
  }

  for (const field of REQUIRED_FRONTMATTER_FIELDS) {
    if (!fm.data[field]) {
      errors.push({ field, message: `Обязательное поле "${field}" отсутствует` });
    }
  }

  return errors;
}

function checkSections(content) {
  const errors = [];
  const lines = content.split('\n');

  for (const section of REQUIRED_SECTIONS) {
    const sectionPattern = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(sectionPattern, 'i');

    if (!regex.test(content)) {
      errors.push({ section, message: `Секция "${section}" отсутствует` });
    }
  }

  return errors;
}

const TASKS_HEADING = /^##\s+Высокоуровневые задачи/i;
const TASK_HEADING = /^###\s+(\d+)\./;
const VERIFICATION_LINE = /^\*\*Проверка:\*\*(.*)$/;
const LIST_ITEM = /^\s*[-*]\s+(.*)$/;

/**
 * Строка `**Проверка:**` у каждой задачи «Высокоуровневых задач».
 *
 * Задача — подзаголовок `### N.` секции до следующего подзаголовка `###` или конца
 * секции. Записи проверки — остаток строки `**Проверка:**` или, если он пуст, пункты
 * списка сразу под ней; пустые строки между пунктами (свободный список markdown)
 * список не закрывают. Запись в строке и список под ней вместе — ошибка: шаблон плана
 * разрешает одну из двух форм. При декомпозиции каждая запись становится проверкой
 * одного пункта DoD тикета, поэтому разбирается тем же разбором, что пункт тикета
 * (parseCheckRecord, check-runner.mjs): ровно одна форма — check с expect (regression
 * только со значением `true`), prose с причиной или visual с путём. Задача из одних
 * регрессионных проверок — ошибка: о результате они не говорят, а декомпозитор
 * переносит проверки без изменений, и verify-atomicity отклоняет такие тикеты
 * (`only_regression_checks`) на каждом проходе.
 *
 * Подсказки `<!-- … -->` и блоки кода пропускаются: пример записи в них — не проверка
 * задачи (в шаблоне плана подсказка секции перечисляет все формы). Секции нет — ошибок
 * здесь нет: её отсутствие называет checkSections.
 */
function checkTaskVerifications(content) {
  const tasks = [];
  let inSection = false;
  let inFence = false;
  let task = null;
  let collecting = false;

  const lines = content.replace(/\r\n/g, '\n').replace(/<!--[\s\S]*?-->/g, '').split('\n');
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      collecting = false;
      continue;
    }
    if (inFence) continue;

    if (/^##\s/.test(line)) {
      inSection = TASKS_HEADING.test(line);
      task = null;
      collecting = false;
      continue;
    }
    if (!inSection) continue;

    if (/^###\s/.test(line)) {
      const heading = TASK_HEADING.exec(line);
      task = heading ? { number: Number(heading[1]), hasLine: false, inline: false, listed: false, records: [] } : null;
      if (task) tasks.push(task);
      collecting = false;
      continue;
    }
    if (!task) continue;

    const verification = VERIFICATION_LINE.exec(line);
    if (verification) {
      task.hasLine = true;
      const record = verification[1].trim();
      if (record) {
        task.records.push(record);
        task.inline = true;
      }
      collecting = true;
      continue;
    }
    if (!collecting) continue;
    const item = LIST_ITEM.exec(line);
    if (item) {
      task.records.push(item[1]);
      task.listed = true;
    } else if (line.trim()) {
      // Пустые строки до списка и между его пунктами пропускаются, первая строка не
      // из списка его закрывает.
      collecting = false;
    }
  }

  const errors = [];
  for (const { number, hasLine, inline, listed, records } of tasks) {
    if (!hasLine) {
      errors.push({ task: number, message: `Задача ${number}: нет строки **Проверка:**` });
    } else if (records.length === 0) {
      errors.push({ task: number, message: `Задача ${number}: строка **Проверка:** без записи проверки` });
    }
    if (inline && listed) {
      errors.push({ task: number, message: `Задача ${number}: запись и в строке **Проверка:**, и списком под ней` });
    }
    const parsed = records.map((record) => parseCheckRecord(record));
    parsed.forEach(({ error }, i) => {
      if (error) {
        errors.push({ task: number, message: `Задача ${number}: запись проверки ${i + 1} не по формату (${error})` });
      }
    });
    if (parsed.length > 0 && parsed.every(({ kind, regression, error }) => kind === 'check' && regression && !error)) {
      errors.push({ task: number, message: `Задача ${number}: только регрессионные проверки, нужна и запись другой формы` });
    }
  }
  return errors;
}

function checkRedFlags(content) {
  const warnings = [];

  for (const { pattern, message, isEmptySection } of RED_FLAG_PATTERNS) {
    if (isEmptySection) {
      for (const heading of findEmptySections(content)) {
        warnings.push({ pattern: heading, message: `Пустая секция: ${heading}` });
      }
    } else {
      const matches = content.match(pattern);
      if (matches) {
        for (const match of matches) {
          warnings.push({ pattern: match.slice(0, 50), message });
        }
      }
    }
  }

  return warnings;
}

function validatePlan(planPath) {
  const errors = [];
  const warnings = [];

  if (!fs.existsSync(planPath)) {
    errors.push({ file: planPath, message: 'Файл не существует' });
    return { errors, warnings, valid: false };
  }

  const content = fs.readFileSync(planPath, 'utf-8');

  const fmErrors = checkFrontmatter(parseFrontmatter(content));
  errors.push(...fmErrors);

  const sectionErrors = checkSections(content);
  errors.push(...sectionErrors);

  const verificationErrors = checkTaskVerifications(content);
  errors.push(...verificationErrors);

  const redFlagWarnings = checkRedFlags(content);
  warnings.push(...redFlagWarnings);

  const valid = errors.length === 0;

  return { errors, warnings, valid };
}

function main() {
  const planPath = parseArgs();

  const absolutePath = path.isAbsolute(planPath)
    ? planPath
    : path.resolve(process.cwd(), planPath);

  const result = validatePlan(absolutePath);

  console.log('---RESULT---');
  console.log(JSON.stringify(result, null, 2));
  console.log('---RESULT---');
}

main();