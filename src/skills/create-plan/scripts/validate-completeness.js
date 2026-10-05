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
 * - Строку **Проверка:** у каждой задачи «Высокоуровневых задач» и формат её записей;
 *   команда записи check исполнима на этой машине: исполнитель проверок её не отклонит,
 *   исполняемый файл установлен
 * - Записи, которые не доказывают своё утверждение: причина prose, которая отдаёт проверку
 *   другой задаче плана, ожидание с альтернативой по упавшим тестам, снимающей порог числа
 *   тестов, критерий о наборе, который доказывают поиски, которым хватает одного элемента
 * - Красные флаги (отсылки вместо содержания, пустые секции)
 *
 * Вывод: JSON {errors, warnings, valid} через ---RESULT---
 */

import fs from 'fs';
import path from 'path';
import { findProjectRoot } from 'workflow-ai/lib/find-root.mjs';
import { printResult } from 'workflow-ai/lib/utils.mjs';
import { parseCheckRecord, checkStartProblem, availableCheckTools } from 'workflow-ai/lib/check-runner.mjs';

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
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
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
const CRITERION_LINE = /^\*\*Критерий приёмки:\*\*(.*)$/;

/**
 * Причина prose, которая отдаёт проверку другой задаче плана: «проверяет задача 3»,
 * «проверяют автотесты задачи 12», «выполняется задачей 17», «вид оценивается по
 * скриншотам ручной проверки задачи 34». Причина prose объясняет, почему утверждение не
 * проверить командой. Отсылка к другой задаче — перенос проверки: модель ревью получает
 * вопросом только текст пункта, и в тикете этой задачи пункт недоказуем; утверждение,
 * которое доказывает другая задача, — её критерий (узлы P10S7, P10S8). 2026-09-30:
 * тринадцать таких причин в одном плане, восемь из девяти отказов модели ревью по плану
 * пришлись на эти пункты, а валидатор план пропустил.
 *
 * Ошибка — глагол проверки в третьем лице и номер задачи в одном предложении, в любом
 * порядке, не дальше 60 знаков друг от друга. Номер задачи без такого глагола — момент
 * времени, а не перенос: «красноту до задачи 2 одной командой не проверить», «до
 * автотестов задачи 4 видно только в диффе». Это причина, правило её не трогает: на
 * планах проектов 2026-10-01 номер задачи без глагола проверки стоял в 46 причинах.
 * `\b` здесь не годится: в JS он видит границу слова только у латиницы.
 */
const TASK_NUMBER = String.raw`(?<!\p{L})задач(?:а|и|у|е|ей|ами|ам|ах)?\s+(?:№\s*)?\d+`;
const CHECK_VERB = String.raw`(?<!\p{L})(?:провер(?:яет|яют|яется|яются|ит|ят)|доказыва(?:ет|ют|ется|ются)|докаж(?:ет|ут)|покрыва(?:ет|ют|ется|ются)|покро(?:ет|ют)|закрыва(?:ет|ют|ется|ются)|закро(?:ет|ют)|выполня(?:ет|ют|ется|ются)|выполн(?:ит|ят)|оценива(?:ет|ют|ется|ются)|оцен(?:ит|ят))(?!\p{L})`;
const TASK_REFERENCE = new RegExp(
  `${CHECK_VERB}[^.;:—]{0,60}?${TASK_NUMBER}|${TASK_NUMBER}[^.;:—]{0,60}?${CHECK_VERB}`,
  'iu'
);

/**
 * Критерий о наборе — утверждение со словом «каждый», «все», «оба» и т. п. (узел
 * P10S11). Его не доказывает поиск, которому хватает одного элемента: запись поиска с
 * ожиданием `exit 0` зелёная, как только нашлась строка любого её шаблона (несколько
 * `-e` без `--all-match` — это «или»), а несколько таких записей под одной строкой
 * критерия — части набора без своих строк критерия (узел P10S7), и пункт DoD с полным
 * текстом критерия закрывает каждая из них. Ошибка — только при однозначной картине:
 * под строкой «Проверка:» нет prose и visual, и каждая запись, кроме регрессионных, —
 * такой поиск. Поиск с `--all-match`, `--and` или файлом шаблонов (`-f`), ожидание
 * отсутствия (`exit 1`), разбор вывода (`stdout …`) и скрипт набор доказывать могут —
 * их правило не трогает. 2026-09-29: критерии «по каждому сайту» доказывали поиски
 * отдельных адресов, тикеты с непроверенными сайтами закрылись без модели ревью, и
 * следующий план повторил это на каноне с правилом.
 */
const SET_QUANTIFIER = /(?<!\p{L})(кажд\p{L}*|все|всех|всем|оба|обоих|обе|обеих)(?!\p{L})/iu;
const SEARCH_TOOLS = new Set(['rg', 'grep']);
const ALL_PATTERNS_OPTIONS = new Set(['--all-match', '--and', '-f']);

// Слова команды записи check: пробелы вне кавычек разделяют, кавычки снимаются.
function commandWords(command) {
  const words = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(command))) words.push(m[1] ?? m[2] ?? m[3]);
  return words;
}

// Запись — поиск с ожиданием `exit 0`, которому хватает строки любого своего шаблона.
function anyMatchSearch(command, expect) {
  if (!/^exit\s+0$/.test(String(expect ?? '').trim())) return false;
  const words = commandWords(String(command ?? ''));
  let options;
  if (words[0] === 'git' && words[1] === 'grep') options = words.slice(2);
  else if (SEARCH_TOOLS.has(words[0])) options = words.slice(1);
  else return false;
  const end = options.indexOf('--');
  const head = end === -1 ? options : options.slice(0, end);
  return !head.some((w) => ALL_PATTERNS_OPTIONS.has(w) || w.startsWith('--file'));
}

// Слово-квантор критерия о наборе, который доказывают только такие поиски, иначе null.
function setCriterionProblem({ criterion, records }) {
  const word = SET_QUANTIFIER.exec(criterion ?? '');
  if (!word) return null;
  const parsed = records.map((record) => parseCheckRecord(record));
  if (parsed.some(({ kind, error }) => error || kind !== 'check')) return null;
  const proving = parsed.filter(({ regression }) => !regression);
  if (proving.length === 0) return null;
  return proving.every(({ command, expect }) => anyMatchSearch(command, expect)) ? word[1] : null;
}

/**
 * Альтернатива в ожидании `stdout matches /…/`, которая снимает порог числа тестов:
 * одна ветвь требует счётчик прошедших или всех тестов с порогом, другая — счётчик
 * упавших. Такая запись зелёная при одном упавшем тесте, сколько бы тестов ни было;
 * число тестов доказывает счётчик всех исполненных тестов с порогом, независимо от
 * исхода (узлы P10R1, P10S12). 2026-09-30: ожидание «прошло не меньше N или упал хотя
 * бы один» у задачи тестов закрыло бы критерий «не меньше N тестов» одним упавшим
 * тестом. Ветви ищутся на каждом уровне: верхнем и в каждой группе `( … )`; содержимое
 * вложенной группы входит в ветвь, где она стоит.
 */
const PASS_COUNTER = /pass|total/i;
const FAIL_COUNTER = /fail/i;

function alternations(source) {
  const frames = [{ branches: [''] }];
  const groups = [];
  let inClass = false;
  const append = (text) => {
    for (const frame of frames) frame.branches[frame.branches.length - 1] += text;
  };
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\') {
      append(source.slice(i, i + 2));
      i += 1;
    } else if (inClass) {
      if (ch === ']') inClass = false;
      append(ch);
    } else if (ch === '[') {
      inClass = true;
      append(ch);
    } else if (ch === '(') {
      append(ch);
      frames.push({ branches: [''] });
    } else if (ch === ')' && frames.length > 1) {
      groups.push(frames.pop().branches);
      append(ch);
    } else if (ch === '|') {
      frames[frames.length - 1].branches.push('');
    } else {
      append(ch);
    }
  }
  while (frames.length > 0) groups.push(frames.pop().branches);
  return groups;
}

// Порог — цифра 1–9 вне класса «любая цифра»: `[3-9]`, `16`, `[1-9]`; `[0-9]+` и `\d+` — не порог.
const hasThreshold = (branch) => /[1-9]/.test(branch.replace(/\[0-9\]|\\d/g, ''));

function thresholdBypass(expect) {
  const match = /^stdout\s+matches\s+\/(.+)\/$/.exec(String(expect ?? '').trim());
  if (!match) return false;
  return alternations(match[1]).some((branches) =>
    branches.length > 1 &&
    branches.some((b) => PASS_COUNTER.test(b) && !FAIL_COUNTER.test(b) && hasThreshold(b)) &&
    branches.some((b) => FAIL_COUNTER.test(b) && !PASS_COUNTER.test(b)));
}

/**
 * Строка `**Проверка:**` у каждой задачи «Высокоуровневых задач».
 *
 * Задача — подзаголовок `### N.` секции до следующего подзаголовка `###` или конца
 * секции. Записи проверки — остаток строки `**Проверка:**` или, если он пуст, пункты
 * списка сразу под ней; пустые строки между пунктами (свободный список markdown)
 * список не закрывают. Запись в строке и список под той же строкой вместе — ошибка:
 * шаблон плана разрешает одну из двух форм. Форма и пустота считаются по каждой строке
 * `**Проверка:**`: у задачи может быть несколько строк критерия приёмки, у каждой своя
 * строка проверки, и одна запись в строке рядом со списком под другой строкой — не
 * ошибка (2026-09-30: правило плана «утверждения, которые доказывают разные записи, —
 * своими строками», а признаки на всю задачу отклоняли такой план). При декомпозиции
 * каждая запись становится проверкой одного пункта DoD тикета, поэтому разбирается тем же разбором, что пункт тикета
 * (parseCheckRecord, check-runner.mjs): ровно одна форма — check с expect (regression
 * только со значением `true`), prose с причиной или visual с путём. Задача из одних
 * регрессионных проверок — ошибка: о результате они не говорят, а декомпозитор
 * переносит проверки без изменений, и verify-atomicity отклоняет такие тикеты
 * (`only_regression_checks`) на каждом проходе.
 *
 * Команда записи check, которую исполнитель проверок отклонит или которой нет
 * исполняемого файла на машине (checkStartProblem, check-runner.mjs), — ошибка:
 * такая проверка красная всегда, и пункт DoD не закроется. Ошибка отсутствующего
 * файла перечисляет доступные (availableCheckTools) — из них выбирается замена.
 *
 * Подсказки `<!-- … -->` и блоки кода пропускаются: пример записи в них — не проверка
 * задачи (в шаблоне плана подсказка секции перечисляет все формы). Секции нет — ошибок
 * здесь нет: её отсутствие называет checkSections.
 *
 * Запись, которая по форме верна, но своего утверждения не доказывает, — тоже ошибка:
 * причина prose, которая отдаёт проверку другой задаче плана (TASK_REFERENCE), ожидание
 * с альтернативой, снимающей порог числа тестов (thresholdBypass), и критерий о наборе,
 * который доказывают поиски, которым хватает одного элемента (setCriterionProblem). Для
 * последнего строка `**Проверка:**` получает текст строки `**Критерий приёмки:**`,
 * стоящей перед ней в той же задаче.
 */
function checkTaskVerifications(content) {
  const tasks = [];
  let inSection = false;
  let inFence = false;
  let task = null;
  let check = null;
  let collecting = false;
  let criterion = null;

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
      criterion = null;
      continue;
    }
    if (!inSection) continue;

    if (/^###\s/.test(line)) {
      const heading = TASK_HEADING.exec(line);
      task = heading ? { number: Number(heading[1]), checks: [], records: [] } : null;
      if (task) tasks.push(task);
      collecting = false;
      criterion = null;
      continue;
    }
    if (!task) continue;

    const criterionLine = CRITERION_LINE.exec(line);
    if (criterionLine) {
      criterion = criterionLine[1].trim();
      collecting = false;
      continue;
    }
    const verification = VERIFICATION_LINE.exec(line);
    if (verification) {
      check = { inline: false, listed: false, count: 0, criterion, records: [] };
      criterion = null;
      task.checks.push(check);
      const record = verification[1].trim();
      if (record) {
        task.records.push(record);
        check.records.push(record);
        check.inline = true;
        check.count += 1;
      }
      collecting = true;
      continue;
    }
    if (!collecting) continue;
    const item = LIST_ITEM.exec(line);
    if (item) {
      task.records.push(item[1]);
      check.records.push(item[1]);
      check.listed = true;
      check.count += 1;
    } else if (line.trim()) {
      // Пустые строки до списка и между его пунктами пропускаются, первая строка не
      // из списка его закрывает.
      collecting = false;
    }
  }

  const errors = [];
  for (const { number, checks, records } of tasks) {
    if (checks.length === 0) {
      errors.push({ task: number, message: `Задача ${number}: нет строки **Проверка:**` });
    } else if (checks.some(({ count }) => count === 0)) {
      errors.push({ task: number, message: `Задача ${number}: строка **Проверка:** без записи проверки` });
    }
    if (checks.some(({ inline, listed }) => inline && listed)) {
      errors.push({ task: number, message: `Задача ${number}: запись и в строке **Проверка:**, и списком под ней` });
    }
    const parsed = records.map((record) => parseCheckRecord(record));
    parsed.forEach(({ kind, command, expect, reason, error }, i) => {
      if (error) {
        errors.push({ task: number, message: `Задача ${number}: запись проверки ${i + 1} не по формату (${error})` });
        return;
      }
      if (kind === 'prose') {
        const reference = TASK_REFERENCE.exec(reason ?? '');
        if (reference) {
          errors.push({ task: number, message: `Задача ${number}: запись проверки ${i + 1} — причина prose отдаёт проверку другой задаче плана («${reference[0]}»): утверждение, которое доказывает другая задача, записывается критерием той задачи` });
        }
        return;
      }
      if (kind !== 'check') return;
      const problem = checkStartProblem({ check: command, expect });
      if (problem?.status === 'denied') {
        errors.push({ task: number, message: `Задача ${number}: запись проверки ${i + 1} отклонит исполнитель проверок (${problem.reason})` });
      } else if (problem?.status === 'tool_missing') {
        const available = availableCheckTools().join(', ') || 'ни одного';
        errors.push({ task: number, message: `Задача ${number}: запись проверки ${i + 1} — на машине нет «${problem.tool}» (установлены: ${available})` });
      }
      if (thresholdBypass(expect)) {
        errors.push({ task: number, message: `Задача ${number}: запись проверки ${i + 1} — альтернатива по упавшим тестам снимает порог числа тестов: число доказывает счётчик всех исполненных тестов` });
      }
    });
    if (parsed.length > 0 && parsed.every(({ kind, regression, error }) => kind === 'check' && regression && !error)) {
      errors.push({ task: number, message: `Задача ${number}: только регрессионные проверки, нужна и запись другой формы` });
    }
    for (const check of checks) {
      const word = setCriterionProblem(check);
      if (word) {
        errors.push({ task: number, message: `Задача ${number}: критерий о наборе («${word}») доказывают поиски, которым хватает одного элемента, — перечисли элементы в утверждении и найди все одной записью (--all-match и -e на каждый) или скриптом, либо дай каждому элементу свою строку критерия` });
      }
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