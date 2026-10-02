/**
 * Шаблоны пакета (templates/ticket-template.md, templates/plan-template.md) — контракт с
 * их читателями. Шаблон копируется в проекты (`workflow update`, init.mjs syncTemplates),
 * по нему модели пишут тикеты и планы, а скрипты пайплайна читают написанное.
 *
 * Тикет. 2026-09-29…30: секция результата шаблона расходилась с шаблоном результата
 * исполнителя (src/skills/execute-task/templates/result-template.md) — «Заметки для
 * следующих задач» вместо «Заметок», без «Найденных дефектов», с «Временем выполнения»,
 * куда исполнитель вписывал время и агента сам (местное время с меткой Z); пример
 * `path/to/file1.ts` строкой списка в комментарии «Изменённых файлов» провалил RSH-002
 * как «файл не найден». Охраняется:
 *  - подразделы секции результата — ровно подразделы шаблона результата, по порядку;
 *  - незаполненный шаблон не даёт ни заполненного результата, ни файлов, ни дефекта:
 *    подсказки — HTML-комментарии, «нет» в «Найденных дефектах» не вписано, в
 *    «Изменённых файлах» нет ни одной строки списка, даже в комментарии;
 *  - шаблон, заполненный по шаблону результата, читают check-anomalies, verify-artifacts,
 *    закрытие плана (recordedDefects) и метрики отчёта и разбора;
 *  - поля времени пустые с пометкой «ставит скрипт пайплайна, не заполнять», started_at
 *    в шаблоне нет;
 *  - команда поиска по пути, который игнорирует git, из комментария DoD находит файл.
 *
 * План. Охраняется: шаблон проходит validate-completeness.js без ошибок (прежде в нём не
 * было секции «Справочные данные» из REQUIRED_SECTIONS); поле end_date — то, из которого
 * calc-metrics.js считает plan health; формы записи проверки — те же, что во фикстуре
 * TC-CREATE-PLAN-007; риски, внешние зависимости, критерии успеха и история изменений —
 * по узлам P10S9, P10S10 и knowledge/plan-lifecycle.md скила create-plan.
 *
 * Запуск: node --test --import ./src/tests/_rails-home.mjs src/tests/package-templates.test.mjs
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseFrontmatter, recordedDefects } from '../lib/utils.mjs';
import { parseDodChecks, runCheck } from '../lib/check-runner.mjs';
import { extractRecordedDefects as reportDefects, calcPlanHealth } from '../skills/create-report/scripts/calc-metrics.js';
import { extractRecordedDefects as analysisDefects } from '../skills/analyze-report/scripts/calc-plan-metrics.js';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TICKET_TEMPLATE = fs.readFileSync(path.join(REPO, 'templates', 'ticket-template.md'), 'utf8');
const PLAN_TEMPLATE_PATH = path.join(REPO, 'templates', 'plan-template.md');
const PLAN_TEMPLATE = fs.readFileSync(PLAN_TEMPLATE_PATH, 'utf8');
const RESULT_TEMPLATE = fs.readFileSync(
  path.join(REPO, 'src', 'skills', 'execute-task', 'templates', 'result-template.md'), 'utf8');
const PLAN_FIXTURE = fs.readFileSync(
  path.join(REPO, 'src', 'skills', 'create-plan', 'tests', 'fixtures', 'plan-template-check-forms', 'plan-template.md'), 'utf8');
const VERIFY_ARTIFACTS = path.join(REPO, 'src', 'skills', 'review-result', 'scripts', 'verify-artifacts.js');
const VALIDATE_COMPLETENESS = path.join(REPO, 'src', 'skills', 'create-plan', 'scripts', 'validate-completeness.js');

const ROOTS = [];
after(() => { for (const dir of ROOTS) fs.rmSync(dir, { recursive: true, force: true }); });

function tempDir(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  ROOTS.push(dir);
  return dir;
}

// check-anomalies.js вычисляет корень проекта при импорте — импорт из временного проекта,
// cwd возвращается назад (приём из check-anomalies.test.mjs).
const ANOMALIES_ROOT = tempDir('package-templates-anomalies-');
fs.mkdirSync(path.join(ANOMALIES_ROOT, '.workflow', 'tickets', 'in-progress'), { recursive: true });
const cwdBefore = process.cwd();
process.chdir(ANOMALIES_ROOT);
const { hasFilledResult } = await import('../scripts/check-anomalies.js');
process.chdir(cwdBefore);

const COMMENTS = /<!--[\s\S]*?-->/g;
const normalize = text => text.replace(/\s+/g, ' ').trim();

/** Текст секции уровня `level` с заголовком `title` до следующего заголовка того же или старшего уровня. */
function section(text, level, title) {
  const hashes = '#'.repeat(level);
  const heading = new RegExp(`^${hashes}\\s*${title}[ \\t]*$`, 'm').exec(text);
  assert.ok(heading, `нет заголовка «${hashes} ${title}»`);
  const rest = text.slice(heading.index + heading[0].length);
  const next = rest.search(new RegExp(`^#{1,${level}}\\s`, 'm'));
  return next === -1 ? rest : rest.slice(0, next);
}

function h3Headings(text) {
  return [...text.matchAll(/^###\s+(.+?)\s*$/gm)].map(m => m[1]);
}

// Подразделы шаблона результата — из его блока markdown.
function resultTemplateHeadings() {
  const block = /```markdown\r?\n([\s\S]*?)```/.exec(RESULT_TEMPLATE);
  assert.ok(block, 'в result-template.md нет блока ```markdown');
  return h3Headings(block[1]);
}

/**
 * Тикет по шаблону, заполненный исполнителем по шаблону результата: тело каждого
 * названного подраздела (подсказка-комментарий) заменено записью.
 */
function fillResult(text, entries) {
  let out = text;
  for (const [heading, value] of Object.entries(entries)) {
    const re = new RegExp(`(^### ${heading}[ \\t]*\\r?\\n)[\\s\\S]*?(?=^#{1,3} |(?![\\s\\S]))`, 'm');
    assert.match(out, re, `в шаблоне тикета нет подраздела «### ${heading}»`);
    out = out.replace(re, (_, h) => `${h}\n${value}\n\n`);
  }
  return out;
}

const FILLED = {
  'Что сделано': '- Добавлен модуль разбора конфига: `src/a.js:1`.',
  'Изменённые файлы': '- `src/a.js` — создан модуль',
  'Найденные дефекты': '- ожидалось «Итого: 10 ₽» → выводится «Итого: 0 ₽», вывод `node src/a.js`',
  'Заметки': '- shared нет',
};

const ticketBody = text => parseFrontmatter(text).body;

// ---------------------------------------------------------------------------
// Шаблон тикета
// ---------------------------------------------------------------------------

test('тикет: подразделы «Результата выполнения» — подразделы шаблона результата исполнителя, по порядку', () => {
  const expected = resultTemplateHeadings();
  assert.deepEqual(expected, ['Что сделано', 'Изменённые файлы', 'Найденные дефекты', 'Заметки'],
    'шаблон результата исполнителя изменился — сверь с ним шаблон тикета');
  const result = section(ticketBody(TICKET_TEMPLATE), 2, 'Результат выполнения');
  assert.deepEqual(h3Headings(result), expected);
  assert.doesNotMatch(TICKET_TEMPLATE, /Время выполнения|Started:|Completed:|Agent used/,
    'время и агента записывает пайплайн, подсекции для них в шаблоне нет');
});

test('тикет: незаполненный шаблон — ни результата, ни файлов, ни дефекта', () => {
  const body = ticketBody(TICKET_TEMPLATE);
  const result = section(body, 2, 'Результат выполнения');
  assert.equal(hasFilledResult(body), false, 'check-anomalies: пустой результат — не аномалия');
  assert.equal(recordedDefects(body), null, 'закрытие плана: дефекта нет');
  assert.deepEqual(reportDefects(body), { hasSection: false, text: null }, 'отчёт: подраздел не заполнен');
  assert.deepEqual(analysisDefects(body), { hasSection: false, text: null }, 'разбор: подраздел не заполнен');
  for (const heading of h3Headings(result)) {
    const raw = section(result, 3, heading);
    assert.equal(raw.replace(COMMENTS, '').trim(), '', `«${heading}»: подсказка только в комментарии`);
  }
  // Даже в комментарии: строку списка с путём исполнитель копирует как формат, а
  // парсер без снятия комментариев берёт её за файл (RSH-002).
  assert.doesNotMatch(section(result, 3, 'Изменённые файлы'), /^\s*[-*+][ \t]/m,
    'пример в «Изменённых файлах» — прозой, без строки списка');
});

test('тикет: заполненный по шаблону результата — результат, файлы и дефект читаются', () => {
  const filled = fillResult(TICKET_TEMPLATE, FILLED);
  const body = ticketBody(filled);
  assert.equal(hasFilledResult(body), true);
  assert.equal(recordedDefects(body), FILLED['Найденные дефекты']);
  assert.deepEqual(reportDefects(body), { hasSection: true, text: FILLED['Найденные дефекты'] });
  assert.deepEqual(analysisDefects(body).hasSection, true);

  const none = ticketBody(fillResult(TICKET_TEMPLATE, { ...FILLED, 'Найденные дефекты': 'нет' }));
  assert.equal(recordedDefects(none), null, 'запись «нет» — дефекта нет');
  assert.deepEqual(reportDefects(none), { hasSection: true, text: null });
});

test('тикет: verify-artifacts берёт файлы заполненного шаблона и не находит их в незаполненном', () => {
  const root = tempDir('package-templates-verify-');
  const review = path.join(root, '.workflow', 'tickets', 'review');
  fs.mkdirSync(review, { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'export const a = 1;\n');
  // Пункты DoD шаблона ссылаются на файлы, которых во временном проекте нет, — один
  // выполненный пункт, который проходит здесь.
  const withDod = TICKET_TEMPLATE
    .replace(/\{TYPE\}-\{NNN\}/g, 'IMPL-001')
    .replace(/(## Критерии готовности[^\n]*\n[\s\S]*?-->\r?\n)[\s\S]*?(?=\r?\n---\r?\n)/,
      (_, head) => `${head}\n- [x] Критерий 1\n  - check: \`node --version\`, expect: \`exit 0\`\n`);
  assert.match(withDod, /- \[x\] Критерий 1/, 'пункты DoD шаблона не заменены — форма секции изменилась');

  const run = (text) => {
    const ticket = path.join(review, 'IMPL-001.md');
    fs.writeFileSync(ticket, text, 'utf8');
    const out = execFileSync('node', [VERIFY_ARTIFACTS, ticket], { cwd: root, encoding: 'utf8' });
    const block = /---RESULT---([\s\S]*?)---RESULT---/.exec(out);
    assert.ok(block, out);
    const fields = Object.fromEntries([...block[1].matchAll(/^\s*([a-z_]+):[ \t]*(.*)$/gm)].map(m => [m[1], m[2].trim()]));
    const evidence = JSON.parse(fs.readFileSync(path.join(root, '.workflow', 'state', 'evidence', 'IMPL-001.json'), 'utf8'));
    return { fields, changed: evidence.changed_files };
  };

  const empty = run(withDod);
  assert.equal(empty.fields.result_filled, 'false');
  assert.equal(empty.fields.missing_files, '');
  assert.deepEqual(empty.changed, []);

  const filled = run(fillResult(withDod, FILLED));
  assert.equal(filled.fields.result_filled, 'true');
  assert.equal(filled.fields.missing_files, '');
  assert.deepEqual(filled.changed, ['src/a.js']);
});

test('тикет: поля времени пустые — их ставит скрипт пайплайна; started_at в шаблоне нет', () => {
  const { frontmatter } = parseFrontmatter(TICKET_TEMPLATE);
  for (const field of ['created_at', 'updated_at', 'completed_at']) {
    assert.equal(frontmatter[field], '', `${field} пустое`);
    assert.match(TICKET_TEMPLATE, new RegExp(`^${field}:\\s*""\\s*# ставит скрипт пайплайна, не заполнять\\s*$`, 'm'), field);
  }
  // Метку ставит перенос в in-progress (stampStartedAt); вписанное по примеру прошлое
  // время хелпер от машинного не отличит.
  assert.doesNotMatch(TICKET_TEMPLATE, /started_at/);
  assert.equal(frontmatter.dod_format, 2);
});

test('тикет: примеры DoD разбираются, комментарий называет тикеты-зависимости', () => {
  const items = parseDodChecks(ticketBody(TICKET_TEMPLATE));
  assert.deepEqual(items.map(i => i.kind), ['check', 'check', 'prose', 'visual']);
  assert.ok(items.every(i => i.error === null), JSON.stringify(items));
  const dodComment = normalize(section(ticketBody(TICKET_TEMPLATE), 2, 'Критерии готовности \\(Definition of Done\\)'));
  assert.match(dodComment, /check не зависит от чужой работы — файлов и коммитов других тикетов, кроме тикетов-зависимостей/);
});

// Поиск по пути, который игнорирует git: без --no-exclude-standard git grep файл не видит.
async function ignoredPathSearch(template) {
  const quoted = /`(git grep -q --untracked --no-exclude-standard "<текст>" -- <путь>)`/.exec(normalize(template));
  assert.ok(quoted, 'нет команды поиска по пути, который игнорирует git');
  const repo = tempDir('package-templates-git-');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  fs.writeFileSync(path.join(repo, '.gitignore'), '.workflow/\n');
  fs.mkdirSync(path.join(repo, '.workflow'));
  fs.writeFileSync(path.join(repo, '.workflow', 'x.md'), 'искомый-текст\n');
  assert.equal(spawnSync('git', ['check-ignore', '-q', '.workflow/x.md'], { cwd: repo }).status, 0);
  const check = quoted[1].replace('<текст>', 'искомый-текст').replace('<путь>', '.workflow/x.md');
  const withFlag = await runCheck({ check, expect: 'exit 0', projectRoot: repo });
  const withoutFlag = await runCheck({ check: check.replace(' --no-exclude-standard', ''), expect: 'exit 0', projectRoot: repo });
  return { withFlag: withFlag.status, withoutFlag: withoutFlag.status };
}

test('тикет: команда поиска по игнорируемому пути из комментария DoD находит файл', async () => {
  assert.deepEqual(await ignoredPathSearch(TICKET_TEMPLATE), { withFlag: 'passed', withoutFlag: 'failed' });
});

// ---------------------------------------------------------------------------
// Шаблон плана
// ---------------------------------------------------------------------------

test('план: шаблон проходит validate-completeness без ошибок, «Справочные данные» между «Контекст» и «Scope»', () => {
  const out = execFileSync('node', [VALIDATE_COMPLETENESS, PLAN_TEMPLATE_PATH], { cwd: REPO, encoding: 'utf8' });
  const block = /---RESULT---([\s\S]*?)---RESULT---/.exec(out);
  assert.ok(block, out);
  assert.deepEqual(JSON.parse(block[1]).errors, []);
  const at = heading => PLAN_TEMPLATE.search(new RegExp(`^## ${heading}`, 'm'));
  assert.ok(at('Контекст') < at('Справочные данные') && at('Справочные данные') < at('Scope'),
    'порядок секций — как в knowledge/plan-completeness.md');
});

test('план: end_date — срок, по которому отчёт считает plan health', () => {
  const { frontmatter } = parseFrontmatter(PLAN_TEMPLATE);
  assert.ok('end_date' in frontmatter, 'во frontmatter шаблона нет end_date');
  assert.equal(calcPlanHealth([], frontmatter).health_status, 'n/a', 'пустой срок — n/a');
  const planned = { ...frontmatter, created_at: '2026-10-01', end_date: '2026-10-11' };
  const health = calcPlanHealth([], planned, new Date('2026-10-06T00:00:00Z'));
  assert.equal(health.horizon_source, 'end_date');
  assert.equal(health.horizon_days, 10);
  for (const field of ['updated_at', 'completed_at']) {
    assert.match(PLAN_TEMPLATE, new RegExp(`^${field}:\\s*""\\s*# ставит скрипт пайплайна, не заполнять\\s*$`, 'm'), field);
  }
});

// Правки форм записи проверки во фикстуре TC-CREATE-PLAN-007 (фрагмент шаблона) — в шаблоне.
const CHECK_FORM_RULES = [
  'путь, который игнорирует git (`git check-ignore -q <путь>` даёт exit 0), — только с --no-exclude-standard: `git grep -q --untracked --no-exclude-standard "<текст>" -- <путь>`, без него поиск такой файл не видит',
  'Причина, которая отдаёт проверку другой задаче плана («проверяет задача N»), — не причина: утверждение, которое доказывает другая задача, — её критерий.',
  'Модель видит изображение, но не размер в пикселях, вес и формат файла — их доказывает check.',
];

test('план: формы записи проверки — как во фикстуре create-plan', () => {
  for (const rule of CHECK_FORM_RULES) {
    assert.ok(normalize(PLAN_FIXTURE).includes(rule), `во фикстуре нет: ${rule}`);
    assert.ok(normalize(PLAN_TEMPLATE).includes(rule), `в шаблоне нет: ${rule}`);
  }
});

test('план: команда поиска по игнорируемому пути находит файл', async () => {
  assert.deepEqual(await ignoredPathSearch(PLAN_TEMPLATE), { withFlag: 'passed', withoutFlag: 'failed' });
});

test('план: задачи-зависимости и задача тестирования — как в P10R1 и P10S12', () => {
  const tasks = normalize(section(PLAN_TEMPLATE, 2, 'Высокоуровневые задачи'));
  assert.match(tasks, /check не зависит от чужой работы — файлов и коммитов других задач, кроме задач-зависимостей: их работа завершена до старта/);
  assert.match(tasks, /отдельная строка \*\*Критерий приёмки:\*\* с prose/);
  assert.match(tasks, /счётчик всех исполненных тестов с порогом/);
});

test('план: риски, внешние зависимости, критерии успеха и история изменений', () => {
  const risks = section(PLAN_TEMPLATE, 2, 'Риски и зависимости');
  const rows = [...risks.replace(COMMENTS, '').matchAll(/^\|(?!\s*-)(.+)\|\s*$/gm)].map(m => m[1].split('|').map(c => c.trim()));
  const mitigation = rows[0].indexOf('Митигация');
  assert.ok(mitigation >= 0, 'нет колонки «Митигация»');
  for (const row of rows.slice(1)) assert.match(row[mitigation], /^Задача \d/, 'митигация — критерий задачи плана');

  assert.match(normalize(section(PLAN_TEMPLATE, 2, 'Внешние зависимости')), /Выкладка собственных артефактов проекта во внешнее место — задача плана/);

  const success = section(PLAN_TEMPLATE, 2, 'Критерии успеха');
  assert.doesNotMatch(success, /prose: `решение принимает человек`/, 'внешнее решение критерием успеха не бывает');
  assert.match(success, /^- \[ \] Критерий 3\. Проверка: задача 3$/m);
  assert.match(normalize(success), /внешнее событие — во «Внешних зависимостях»/i);

  const history = section(PLAN_TEMPLATE, 2, 'История изменений');
  assert.match(history, /^\| Дата \| Автор \| Изменение \| Затронутые тикеты \|$/m);
});
