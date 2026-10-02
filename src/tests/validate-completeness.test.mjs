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
 * Записи, которые своего утверждения не доказывают: причина prose, которая
 * отдаёт проверку другой задаче плана («проверяет задача 3», «выполняется задачей 17»), —
 * ошибка с номером задачи и записи, номер задачи как момент времени («до задачи 2») — нет;
 * альтернатива по упавшим тестам в `stdout matches` («…|"numFailedTests":[1-9]») снимает
 * порог числа тестов — ошибка; критерий о наборе («каждому», «оба», «все»), который
 * доказывают поиски, которым хватает одного элемента (один `git grep`, `-e` без
 * `--all-match`), — ошибка, а поиск всех, скрипт, prose рядом и ожидание отсутствия — нет.
 * Квантор относится к своей строке «Критерий приёмки:» и не переходит к строке
 * «Проверка:» без своего критерия; CRLF правил не ломает.
 *
 * Фикстуры — во временном каталоге ОС, удаляются при выходе процесса.
 *
 * Запуск: node --test --import ./src/tests/_rails-home.mjs src/tests/validate-completeness.test.mjs
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, chmodSync } from 'node:fs';
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

function validate(name, content, env = process.env) {
  const file = join(DIR, name);
  writeFileSync(file, content);
  const out = execFileSync(process.execPath, [SCRIPT, file], { encoding: 'utf8', cwd: DIR, env });
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
- check: \`git grep -q --untracked "ключ: значение" -- docs/x.md\`, expect: \`exit 0\`
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

test('команда check без исполняемого файла на машине — ошибка с перечнем установленных', () => {
  // PATH из одного каталога, где есть только git: validate запускает скрипт по полному
  // пути node, исполняемый файл проверки ищется по этому PATH. Содержимое git не запускается.
  const bin = mkdtempSync(join(tmpdir(), 'validate-completeness-bin-'));
  const git = join(bin, process.platform === 'win32' ? 'git.exe' : 'git');
  writeFileSync(git, '');
  chmodSync(git, 0o755);
  try {
    const tasks = [
      '### 1. Задача',
      '',
      '**Проверка:**',
      '- check: `rg -c "ключ" docs/x.md`, expect: `exit 0`',
      '- check: `git grep -q --untracked "ключ" -- docs/x.md`, expect: `exit 0`'
    ].join('\n');
    const result = validate('checks-no-tool.md', withTasks(tasks), { ...process.env, PATH: bin });
    assert.equal(result.valid, false);
    assert.deepEqual(taskErrors(result), [
      { task: 1, message: 'Задача 1: запись проверки 1 — на машине нет «rg» (установлены: git)' }
    ]);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test('команда check, которую отклонит исполнитель проверок, — ошибка с причиной', () => {
  const tasks = [
    '### 1. Задача',
    '',
    '**Проверка:**',
    '- check: `curl https://example.com`, expect: `exit 0`',
    '- check: `node a.js; rm x`, expect: `exit 0`, regression: `true`',
    '- prose: `текст`'
  ].join('\n');
  const result = validate('checks-denied.md', withTasks(tasks));
  assert.equal(result.valid, false);
  assert.deepEqual(taskErrors(result), [
    { task: 1, message: 'Задача 1: запись проверки 1 отклонит исполнитель проверок (executable_not_allowed: curl)' },
    { task: 1, message: 'Задача 1: запись проверки 2 отклонит исполнитель проверок (shell_operator: ;)' }
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

// 2026-09-30 (ListeningGlass PLAN-001 задача 5): утверждения критерия с разными записями
// план пишет своими строками критерия, у каждой своя «Проверка:». Форма записей
// считается по строке, а не по задаче: признаки на задачу отклоняли такой план.
test('несколько строк «Проверка:» в задаче: одна запись в строке и список под другой — план валиден', () => {
  const tasks = `### 1. Два утверждения

**Критерий приёмки:** CLI печатает номер версии
**Проверка:** check: \`node bin/cli.js --version\`, expect: \`stdout matches /\\d+\\.\\d+/\`
**Критерий приёмки:** справка понятна без чтения кода
**Проверка:**
- prose: \`понятность справки командой не проверить\`
- check: \`npm test\`, expect: \`exit 0\`, regression: \`true\`
`;
  const result = validate('checks-per-line-forms.md', withTasks(tasks));
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.deepEqual(taskErrors(result), []);
});

test('пустая строка «Проверка:» рядом с заполненной — ошибка с номером задачи', () => {
  const tasks = `### 1. Второе утверждение без записи

**Критерий приёмки:** CLI печатает номер версии
**Проверка:** check: \`node bin/cli.js --version\`, expect: \`exit 0\`
**Критерий приёмки:** справка понятна без чтения кода
**Проверка:**

Описание после пустой строки.
`;
  assert.deepEqual(taskErrors(validate('checks-per-line-empty.md', withTasks(tasks))), [
    { task: 1, message: 'Задача 1: строка **Проверка:** без записи проверки' }
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

// ---------------------------------------------------------------------------
// Записи, которые своего утверждения не доказывают (новые правила)
// ---------------------------------------------------------------------------

test('причина prose, которая отдаёт проверку другой задаче плана, — ошибка с номером задачи и записи; номер задачи как момент времени — нет', () => {
  const tasks = `### 1. Классификатор

**Критерий приёмки:** классификатор различает входы из таблицы
**Проверка:**
- check: \`npm run build\`, expect: \`exit 0\`
- prose: \`Поведение на входах проверяет задача 3 автотестами\`

### 2. Пересборка

**Критерий приёмки:** запись ключа пересобирает файл
**Проверка:** prose: \`проверяют задачи 27 и 28\`

### 3. Состав

**Критерий приёмки:** состав совпадает
**Проверка:** prose: \`выполняется задачей 17 плана\`

### 4. Понятность

**Критерий приёмки:** подпись понятна
**Проверка:** prose: \`понятность подписи командой не проверить; задача ревью — оценить стиль\`

### 5. Краснота до задачи

**Критерий приёмки:** новые случаи красные на прежних правилах
**Проверка:** prose: \`красноту до задачи 2 одной командой не проверить — исполнитель прикладывает вывод прогона\`

### 6. Вид

**Критерий приёмки:** бейдж виден на вкладке
**Проверка:** prose: \`вид оценивается по скриншотам ручной проверки задачи 4\`

### 7. Номер перед глаголом

**Критерий приёмки:** поведение на входах верно
**Проверка:** prose: \`задача 3 проверяет поведение на входах\`

### 8. Автотесты другой задачи до неё

**Критерий приёмки:** новая ошибка валидатора есть
**Проверка:** prose: \`новая ошибка валидатора до автотестов задачи 4 видна только в диффе скрипта\`
`;
  const result = validate('prose-task-ref.md', withTasks(tasks));
  assert.equal(result.valid, false);
  const refs = taskErrors(result).filter((e) => e.message.includes('причина prose отдаёт проверку другой задаче плана'));
  assert.deepEqual(refs.map((e) => [e.task, /«([^»]+)»/.exec(e.message)[1]]), [
    [1, 'проверяет задача 3'],
    [2, 'проверяют задачи 27'],
    [3, 'выполняется задачей 17'],
    [6, 'оценивается по скриншотам ручной проверки задачи 4'],
    [7, 'задача 3 проверяет'],
  ]);
  assert.ok(refs[0].message.startsWith('Задача 1: запись проверки 2 —'), refs[0].message);
});

test('альтернатива по упавшим тестам снимает порог — ошибка; счётчик всех тестов и группа без порога — нет', () => {
  const rec = (expect, extra = '') => `- check: \`npm test -- tests/x.test.ts --json\`, expect: \`${expect}\`${extra}`;
  const tasks = `### 1. Порог снят

**Проверка:**
${rec('stdout matches /"numPassedTests":([3-9]|[1-9][0-9])|"numFailedTests":[1-9]/')}

### 2. Порог снят внутри группы

**Проверка:**
${rec('stdout matches /("numPassedTests":[3-9]|"numFailedTests":[1-9])/')}

### 3. Вывод node --test

**Проверка:**
${rec('stdout matches /# pass [3-9]|# fail [1-9]/')}

### 4. Счётчик всех тестов

**Проверка:**
${rec('stdout matches /"numTotalTests":([4-9]|[1-9][0-9])/')}

### 5. Прогон без порога

**Проверка:**
${rec('stdout matches /[0-9]+ (passed|failed)/')}

### 6. Регрессия без упавших

**Проверка:**
${rec('stdout matches /"numFailedTests":0/', ', regression: `true`')}
- prose: \`понятность командой не проверить\`
`;
  const result = validate('threshold-bypass.md', withTasks(tasks));
  const bypass = taskErrors(result).filter((e) => e.message.includes('снимает порог числа тестов'));
  assert.deepEqual(bypass.map((e) => e.task), [1, 2, 3]);
});

test('критерий о наборе, который доказывают поиски, которым хватает одного элемента, — ошибка; поиск всех, скрипт, prose и отсутствие — нет', () => {
  const grep = (args, expect = 'exit 0') => `- check: \`git grep -q --untracked ${args} -- qa/sites.md\`, expect: \`${expect}\``;
  const tasks = `### 1. Один адрес

**Критерий приёмки:** по каждому сайту из списка записан результат
**Проверка:**
${grep('"www.tiktok.com"')}
- check: \`npm test\`, expect: \`exit 0\`, regression: \`true\`

### 2. Два шаблона через «или»

**Критерий приёмки:** оба сайта записаны
**Проверка:**
${grep('-e "a.com" -e "b.com"')}

### 3. Все шаблоны сразу

**Критерий приёмки:** оба сайта записаны
**Проверка:**
${grep('--all-match -e "a.com" -e "b.com"')}

### 4. Две записи

**Критерий приёмки:** все два сайта записаны
**Проверка:**
${grep('"a.com"')}
${grep('"b.com"')}

### 5. Рядом prose

**Критерий приёмки:** каждый сайт a.com, b.com проверен
**Проверка:**
${grep('"a.com"')}
- prose: \`результат сценария командой не проверить\`

### 6. Отсутствие

**Критерий приёмки:** все вхождения старого имени удалены
**Проверка:**
${grep('"oldName"', 'exit 1')}

### 7. Скрипт

**Критерий приёмки:** каждый сайт записан
**Проверка:** check: \`node scripts/check-sites.js\`, expect: \`exit 0\`

### 8. Без квантора

**Критерий приёмки:** прогон всего набора записан
**Проверка:**
${grep('"summary"')}
`;
  const result = validate('set-criterion.md', withTasks(tasks));
  const set = taskErrors(result).filter((e) => e.message.includes('критерий о наборе'));
  assert.deepEqual(set.map((e) => [e.task, /«([^»]+)»/.exec(e.message)[1]]), [[1, 'каждому'], [2, 'оба'], [4, 'все']]);
});

test('критерий предыдущей строки не переходит к строке «Проверка:» без своего критерия', () => {
  const tasks = `### 1. Два утверждения

**Критерий приёмки:** каждый ключ есть в файле
**Проверка:** check: \`git grep -q --untracked --all-match -e "k1" -e "k2" -- docs/x.md\`, expect: \`exit 0\`
**Проверка:** check: \`git grep -q --untracked "k3" -- docs/x.md\`, expect: \`exit 0\`

### 2. Критерий другой задачи

**Проверка:** check: \`git grep -q --untracked "k4" -- docs/x.md\`, expect: \`exit 0\`
`;
  const set = taskErrors(validate('set-criterion-scope.md', withTasks(tasks))).filter((e) => e.message.includes('критерий о наборе'));
  assert.deepEqual(set, []);
});

test('CRLF не ломает новые правила', () => {
  const tasks = `### 1. Один адрес

**Критерий приёмки:** по каждому сайту записан результат
**Проверка:** check: \`git grep -q --untracked "www.tiktok.com" -- qa/sites.md\`, expect: \`exit 0\`

### 2. Отсылка

**Критерий приёмки:** поведение верно
**Проверка:** prose: \`проверяет задача 3\`
`;
  const result = validate('new-rules-crlf.md', withTasks(tasks).replace(/\n/g, '\r\n'));
  const msgs = taskErrors(result).map((e) => e.task);
  assert.deepEqual(msgs, [1, 2]);
});
