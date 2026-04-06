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
 * - Красные флаги (отсылки вместо содержания, пустые секции)
 *
 * Вывод: JSON {errors, warnings, valid} через ---RESULT---
 */

import fs from 'fs';
import path from 'path';
import { findProjectRoot } from 'workflow-ai/lib/find-root.mjs';
import { printResult } from 'workflow-ai/lib/utils.mjs';

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
  { pattern: /^#\s*.+\n\n+$/gm, message: 'Пустая секция (только заголовок без содержания)', isEmptySection: true }
];

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

function checkRedFlags(content) {
  const warnings = [];
  const lines = content.split('\n');

  for (const { pattern, message, isEmptySection } of RED_FLAG_PATTERNS) {
    if (isEmptySection) {
      const matches = content.match(/^#+\s+.+$/gm);
      if (matches) {
        for (const heading of matches) {
          const headingLineNum = content.split('\n').findIndex(l => l.trim() === heading.trim());
          if (headingLineNum !== -1) {
            const nextLine = lines[headingLineNum + 1];
            if (!nextLine || !nextLine.trim()) {
              warnings.push({ pattern: heading, message: `Пустая секция: ${heading}` });
            }
          }
        }
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