/**
 * Проверка полноты плана (src/skills/create-plan/scripts/validate-completeness.js) —
 * предупреждение «Пустая секция» и строка «Проверка:» у задач плана.
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
 * Строка «Проверка:» (PLAN-002, задачи 3–4): у каждой задачи `### N.` секции
 * «Высокоуровневые задачи» есть строка `**Проверка:**` с записями в формах check +
 * expect (regression только `true`), prose с причиной или visual с путём; иначе
 * `valid: false` и номер задачи в ошибке. Пустая строка между пунктами списка записей
 * его не закрывает; запись в строке вместе со списком под ней и задача из одних
 * регрессионных проверок — ошибки. Запись в подсказке шаблона или в блоке кода
 * не засчитывается. План без секции задач даёт только прежнюю ошибку секции.
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

// Все обязательные секции, с пустой строкой после каждого заголовка — как в реальных планах;
// у задачи — строка проверки.
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

**Проверка:** prose: \`фикстура без команды\`

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

// ---------------------------------------------------------------------------
// Строка «Проверка:» у задач плана
// ---------------------------------------------------------------------------

// План, в котором секция «Высокоуровневые задачи» состоит из tasks.
const withTasks = (tasks) =>
  FRONTMATTER + FULL_BODY.replace(/## Высокоуровневые задачи\n[\s\S]*?(?=\n## Риски)/, `## Высокоуровневые задачи\n\n${tasks}\n`);

const taskErrors = (result) => result.errors.filter((e) => e.task !== undefined);

const VALID_TASKS = `### 1. Команда

**Критерий приёмки:** тест зелёный
**Проверка:** check: \`node --test src/tests/x.test.mjs\`, expect: \`exit 0\`

### 2. Несколько записей

**Проверка:**
- check: \`rg -c "ключ: значение" docs/x.md\`, expect: \`stdout matches /^[1-9]/\`
- check: \`npm test\`, expect: \`exit 0\`, regression: \`true\`
- prose: \`понятность формулировки командой не проверить\`

### 3. Снимок

**Проверка:** visual: \`.workflow/evidence/screens/export-*.png\`
`;

test('три формы и regression: `true`, в строке и списком — план валиден', () => {
  const result = validate('checks-valid.md', withTasks(VALID_TASKS));
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.deepEqual(taskErrors(result), []);
});

test('задача без строки «Проверка:» — valid: false с номером задачи', () => {
  const tasks = VALID_TASKS + '\n### 4. Без проверки\n\n**Критерий приёмки:** что-то станет верно\n';
  const result = validate('checks-missing.md', withTasks(tasks));
  assert.equal(result.valid, false);
  assert.deepEqual(taskErrors(result), [{ task: 4, message: 'Задача 4: нет строки **Проверка:**' }]);
});

test('check: без expect: — ошибка записи с номером задачи', () => {
  const result = validate('checks-no-expect.md', withTasks('### 1. Задача\n\n**Проверка:** check: `npm test`\n'));
  assert.equal(result.valid, false);
  assert.deepEqual(taskErrors(result), [
    { task: 1, message: 'Задача 1: запись проверки 1 не по формату (check_without_expect)' }
  ]);
});

test('regression: не `true` или без check: — ошибка записи', () => {
  const tasks = `### 1. Значение false

**Проверка:** check: \`npm test\`, expect: \`exit 0\`, regression: \`false\`

### 2. Значение без обратных кавычек

**Проверка:** check: \`npm test\`, expect: \`exit 0\`, regression: true

### 3. Без check

**Проверка:**
- prose: \`причина\`, regression: \`true\`
- regression: \`true\`
`;
  assert.deepEqual(taskErrors(validate('checks-regression.md', withTasks(tasks))), [
    { task: 1, message: 'Задача 1: запись проверки 1 не по формату (bad_regression)' },
    { task: 2, message: 'Задача 2: запись проверки 1 не по формату (bad_regression)' },
    { task: 3, message: 'Задача 3: запись проверки 1 не по формату (keys_without_check)' },
    { task: 3, message: 'Задача 3: запись проверки 2 не по формату (no_form)' }
  ]);
});

test('prose: без причины и visual: без пути — ошибки записи', () => {
  const tasks = `### 1. Пустая причина

**Проверка:** prose: \`\`

### 2. Причина без обратных кавычек

**Проверка:** prose: командой не проверить

### 3. Без пути

**Проверка:** visual:
`;
  assert.deepEqual(taskErrors(validate('checks-empty-values.md', withTasks(tasks))), [
    { task: 1, message: 'Задача 1: запись проверки 1 не по формату (prose_without_reason)' },
    { task: 2, message: 'Задача 2: запись проверки 1 не по формату (prose_without_reason)' },
    { task: 3, message: 'Задача 3: запись проверки 1 не по формату (visual_without_path)' }
  ]);
});

test('пустая строка между пунктами списка не закрывает его — записи после неё разбираются', () => {
  const tasks = `### 1. Свободный список

**Проверка:**
- prose: \`причина\`

- check: \`npm test\`

### 2. Свободный список по формату

**Проверка:**

- check: \`npm test\`, expect: \`exit 0\`

- prose: \`причина\`

Описание после списка.
`;
  assert.deepEqual(taskErrors(validate('checks-loose-list.md', withTasks(tasks))), [
    { task: 1, message: 'Задача 1: запись проверки 2 не по формату (check_without_expect)' }
  ]);
});

test('запись в строке «Проверка:» и список под ней — ошибка, записи списка разбираются', () => {
  const tasks = '### 1. Две формы строки\n\n**Проверка:** prose: `причина`\n- check: `npm test`\n';
  assert.deepEqual(taskErrors(validate('checks-inline-and-list.md', withTasks(tasks))), [
    { task: 1, message: 'Задача 1: запись и в строке **Проверка:**, и списком под ней' },
    { task: 1, message: 'Задача 1: запись проверки 2 не по формату (check_without_expect)' }
  ]);
});

test('задача из одних регрессионных проверок — ошибка с номером задачи', () => {
  const tasks = `### 1. Одна регрессионная

**Проверка:** check: \`npm test\`, expect: \`exit 0\`, regression: \`true\`

### 2. Две регрессионные

**Проверка:**
- check: \`npm test\`, expect: \`exit 0\`, regression: \`true\`
- check: \`node --test src/tests/x.test.mjs\`, expect: \`exit 0\`, regression: \`true\`
`;
  const result = validate('checks-only-regression.md', withTasks(tasks));
  assert.equal(result.valid, false);
  assert.deepEqual(taskErrors(result), [
    { task: 1, message: 'Задача 1: только регрессионные проверки, нужна и запись другой формы' },
    { task: 2, message: 'Задача 2: только регрессионные проверки, нужна и запись другой формы' }
  ]);
});

test('пустая «Проверка:», запись в подсказке и в блоке кода не засчитываются', () => {
  const tasks = `### 1. Пустая строка проверки

**Проверка:**

Описание после пустой строки.

### 2. Пример в блоке кода

\`\`\`markdown
**Проверка:** prose: \`пример записи\`
\`\`\`

### 3. Пример в подсказке

<!--
**Проверка:** prose: \`пример записи\`
-->
Описание.
`;
  assert.deepEqual(taskErrors(validate('checks-hidden.md', withTasks(tasks))), [
    { task: 1, message: 'Задача 1: строка **Проверка:** без записи проверки' },
    { task: 2, message: 'Задача 2: нет строки **Проверка:**' },
    { task: 3, message: 'Задача 3: нет строки **Проверка:**' }
  ]);
});

test('план без «Высокоуровневых задач» — прежняя ошибка секции, без новых', () => {
  const body = FULL_BODY.replace('## Высокоуровневые задачи\n', '').replace(/\*\*Проверка:\*\*.*\n/, '');
  const result = validate('no-tasks-section.md', FRONTMATTER + body);
  assert.deepEqual(result.errors, [
    { section: '## Высокоуровневые задачи', message: 'Секция "## Высокоуровневые задачи" отсутствует' }
  ]);
});

test('CRLF в файле не ломает разбор строки «Проверка:»', () => {
  const crlf = (text) => text.replace(/\n/g, '\r\n');
  assert.deepEqual(taskErrors(validate('checks-crlf.md', crlf(withTasks(VALID_TASKS)))), []);
  const missing = withTasks(VALID_TASKS + '\n### 4. Без проверки\n\nОписание.\n');
  assert.deepEqual(taskErrors(validate('checks-crlf-missing.md', crlf(missing))), [
    { task: 4, message: 'Задача 4: нет строки **Проверка:**' }
  ]);
});
