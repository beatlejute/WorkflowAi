/**
 * Проверка полноты плана (src/skills/create-plan/scripts/validate-completeness.js) —
 * предупреждение «Пустая секция».
 *
 * Прежняя проверка смотрела только на строку сразу после заголовка, и обычный markdown
 * с пустой строкой после заголовка давал предупреждение на каждый заголовок: на
 * PLAN-002 — 59 штук (2026-09-25). Настоящие пустые секции тонули в этом шуме.
 *
 * Что охраняется:
 *  - пустая строка после заголовка не делает секцию пустой;
 *  - секция без содержания до следующего заголовка того же или старшего уровня — пустая;
 *  - подсекции — содержание родительской секции;
 *  - подсказка шаблона `<!-- … -->` — не содержание;
 *  - `# …` во frontmatter и в блоке кода — не заголовок.
 *
 * Фикстуры — во временном каталоге ОС, удаляются при выходе процесса.
 *
 * Запуск: node --test --import ./src/tests/_rails-home.mjs src/tests/validate-completeness.test.mjs
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'src', 'skills', 'create-plan', 'scripts', 'validate-completeness.js');
const DIR = mkdtempSync(join(tmpdir(), 'validate-completeness-'));
after(() => rmSync(DIR, { recursive: true, force: true }));

const FRONTMATTER = `---
# Шаблон плана
id: "PLAN-999"
title: "Фикстура"
status: draft
author: architect
created_at: "2026-09-25"
---
`;

// Все обязательные секции, с пустой строкой после каждого заголовка — как в реальных планах.
const FULL_BODY = `
# План: Фикстура

## Цель

Цель плана.

## Контекст

Контекст.

## Справочные данные

### Константы

\`\`\`bash
# комментарий в коде, а не заголовок
RULE = 3
\`\`\`

## Scope

Включено всё.

## Высокоуровневые задачи

### 1. Задача

Описание.

## Риски

| Риск | Митигация |
|------|-----------|
| r | m |

## Критерии успеха

- [ ] критерий
`;

function validate(name, content) {
  const file = join(DIR, name);
  writeFileSync(file, content);
  const out = execFileSync('node', [SCRIPT, file], { encoding: 'utf8', cwd: DIR });
  return JSON.parse(out.split('---RESULT---')[1]);
}

const emptyWarnings = (result) =>
  result.warnings.filter((w) => w.message.startsWith('Пустая секция')).map((w) => w.pattern);

test('пустая строка после заголовка, подсекции и `#` в коде и frontmatter — без предупреждений', () => {
  const result = validate('full.md', FRONTMATTER + FULL_BODY);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.deepEqual(emptyWarnings(result), []);
});

test('секция без содержания до следующего заголовка того же уровня — пустая', () => {
  const body = FULL_BODY.replace('Контекст.\n', '');
  assert.deepEqual(emptyWarnings(validate('empty-context.md', FRONTMATTER + body)), ['## Контекст']);
});

test('последняя секция файла без содержания — пустая', () => {
  const body = FULL_BODY + '\n## Метрики\n\n';
  assert.deepEqual(emptyWarnings(validate('empty-last.md', FRONTMATTER + body)), ['## Метрики']);
});

test('подсекция без содержания пуста, родитель с подсекциями — нет', () => {
  const body = FULL_BODY.replace('### 1. Задача\n\nОписание.\n', '### 1. Задача\n\n### 2. Задача\n\nОписание.\n');
  assert.deepEqual(emptyWarnings(validate('empty-sub.md', FRONTMATTER + body)), ['### 1. Задача']);
});

test('секция с одной подсказкой шаблона — пустая', () => {
  const body = FULL_BODY.replace('Цель плана.\n', '<!-- Чего хотим достичь.\nКонкретная цель. -->\n');
  assert.deepEqual(emptyWarnings(validate('comment-only.md', FRONTMATTER + body)), ['## Цель']);
});

test('CRLF в файле не ломает проверку', () => {
  const result = validate('crlf.md', (FRONTMATTER + FULL_BODY).replace(/\n/g, '\r\n'));
  assert.deepEqual(emptyWarnings(result), []);
});
